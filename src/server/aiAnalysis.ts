import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { TIMEFRAMES, getInstrumentBySymbol } from '../config/instruments.ts';
import type {
  AIBacktestReview,
  AIPriceActionSignal,
  BacktestResult,
  OHLCVCandle,
  PriceActionAnalysisSummary,
  Timeframe,
  TimeframeAlignmentItem,
} from '../types/market.ts';

const PRIMARY_MODEL = 'gemini-4-hydrogen';
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const GROQ_FALLBACK_MODEL = 'llama-3.3-70b-versatile';
const SIGNAL_CACHE_TTL_MS = 20_000;

interface CachedSignalEntry {
  createdAt: number;
  signal: AIPriceActionSignal;
}

const signalCache = new Map<string, CachedSignalEntry>();

function getGeminiApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'MY_GEMINI_API_KEY') return null;
  return key;
}

function getGroqApiKey(): string | null {
  const key = process.env.GROQ_API_KEY;
  if (!key || key === 'MY_GROQ_API_KEY') return null;
  return key;
}

function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export interface TimeframePriceActionInput {
  timeframe: Timeframe;
  candles: OHLCVCandle[];
  analysis: PriceActionAnalysisSummary;
}

function normalizeTimeframe(raw: string, fallback: Timeframe): Timeframe {
  const upper = raw.trim().toUpperCase();
  if (TIMEFRAMES.includes(upper as Timeframe)) {
    return upper as Timeframe;
  }
  return fallback;
}

function isQuotaError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    raw.includes('429') ||
    raw.includes('RESOURCE_EXHAUSTED') ||
    raw.toLowerCase().includes('quota') ||
    raw.toLowerCase().includes('rate limit')
  );
}

function formatProviderError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);

  if (isQuotaError(error)) {
    const retryMatch =
      raw.match(/retry in (\d+(?:\.\d+)?)s/i) ??
      raw.match(/"retryDelay":"(\d+)s"/i);
    const waitSec = retryMatch ? Math.ceil(Number(retryMatch[1])) : 30;
    const err = new Error(
      `Free Tier rate limit reached across Gemini models. Wait about ${waitSec} seconds and retry, add a GROQ_API_KEY backup variable, or upgrade billing in Google AI Studio.`
    );
    (err as Error & { statusCode?: number }).statusCode = 429;
    return err;
  }

  if (
    raw.includes('API_KEY_INVALID') ||
    raw.includes('PERMISSION_DENIED') ||
    raw.includes('403')
  ) {
    const err = new Error(
      'Invalid or unauthorized Gemini API key. Check your GEMINI_API_KEY in Settings > Secrets (or Vercel Environment Variables).'
    );
    (err as Error & { statusCode?: number }).statusCode = 403;
    return err;
  }

  return error instanceof Error ? error : new Error(raw);
}

interface RawSignalJSON {
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  signalTimeframe: string;
  priceActionNarrative: string;
  keyZonesExplanation: string;
  timeframeAlignment: TimeframeAlignmentItem[];
  plan: AIPriceActionSignal['plan'];
}

async function runGeminiModel(
  ai: GoogleGenAI,
  model: string,
  systemInstruction: string,
  payloadJson: string
): Promise<RawSignalJSON> {
  const response = await ai.models.generateContent({
    model,
    contents: `Analyze all 5 timeframes (1M, 5M, 15M, 1H, 4H) of pure OHLC price action and output a multi-timeframe signal:\n${payloadJson}`,
    config: {
      systemInstruction,
      ...(model === PRIMARY_MODEL
        ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
        : {}),
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          bias: {
            type: Type.STRING,
            description: 'Overall multi-timeframe bias: Bullish, Bearish, or Neutral.',
          },
          signalTimeframe: {
            type: Type.STRING,
            description:
              'Best execution timeframe for this signal: 1M, 5M, 15M, 1H, or 4H.',
          },
          priceActionNarrative: {
            type: Type.STRING,
            description:
              '2-3 sentences explaining top-down alignment from 4H/1H structure down to the chosen execution timeframe trigger without lagging indicators.',
          },
          keyZonesExplanation: {
            type: Type.STRING,
            description:
              '2 sentences explaining the key HTF/LTF Order Blocks, Fair Value Gaps, liquidity pools, and S/R zones.',
          },
          timeframeAlignment: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                timeframe: {
                  type: Type.STRING,
                  description: 'Timeframe: 4H, 1H, 15M, 5M, or 1M.',
                },
                bias: {
                  type: Type.STRING,
                  description: 'Bullish, Bearish, or Neutral.',
                },
                structureEvent: {
                  type: Type.STRING,
                  description:
                    'Latest structure read, e.g. Bullish BOS, Bearish CHoCH, Range.',
                },
                rangeZone: {
                  type: Type.STRING,
                  description: 'Discount, Equilibrium, or Premium.',
                },
                note: {
                  type: Type.STRING,
                  description:
                    'Brief 4-8 word price-action takeaway for this timeframe.',
                },
              },
              required: ['timeframe', 'bias', 'structureEvent', 'rangeZone', 'note'],
            },
            description: 'All 5 timeframes ordered 4H, 1H, 15M, 5M, 1M.',
          },
          plan: {
            type: Type.OBJECT,
            properties: {
              signal: {
                type: Type.STRING,
                description: 'Actionable signal: BUY, SELL, or WAIT.',
              },
              signalStrength: {
                type: Type.STRING,
                description: 'A+ Setup, Standard, or Developing.',
              },
              setupType: {
                type: Type.STRING,
                description: 'Price action setup archetype.',
              },
              triggerPattern: {
                type: Type.STRING,
                description: 'Candlestick or structural trigger observed.',
              },
              entryPrice: {
                type: Type.NUMBER,
                description: 'Primary signal entry price.',
              },
              entryZone: {
                type: Type.STRING,
                description: 'Formatted entry zone string.',
              },
              stopLoss: {
                type: Type.NUMBER,
                description: 'Structural invalidation stop-loss price.',
              },
              takeProfit1: {
                type: Type.NUMBER,
                description: 'First liquidity/structure target price.',
              },
              takeProfit2: {
                type: Type.NUMBER,
                description: 'Extended swing target price.',
              },
              riskRewardRatio: {
                type: Type.STRING,
                description: 'Risk to reward ratio, e.g. 1 : 2.6',
              },
              invalidationReason: {
                type: Type.STRING,
                description:
                  'Exact candle close or structural break invalidating the setup.',
              },
              confluences: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description:
                  '3 to 4 pure price-action confluences across timeframes.',
              },
            },
            required: [
              'signal',
              'signalStrength',
              'setupType',
              'triggerPattern',
              'entryPrice',
              'entryZone',
              'stopLoss',
              'takeProfit1',
              'takeProfit2',
              'riskRewardRatio',
              'invalidationReason',
              'confluences',
            ],
          },
        },
        required: [
          'bias',
          'signalTimeframe',
          'priceActionNarrative',
          'keyZonesExplanation',
          'timeframeAlignment',
          'plan',
        ],
      },
    },
  });

  const rawText = (response.text ?? '').trim();
  if (!rawText) {
    throw new Error(`Model ${model} returned an empty response.`);
  }
  return JSON.parse(rawText) as RawSignalJSON;
}

async function runGroqFallback(
  groqApiKey: string,
  systemInstruction: string,
  payloadJson: string
): Promise<RawSignalJSON> {
  const schemaPrompt = `${systemInstruction}

Return ONLY valid JSON matching this exact shape:
{
  "bias": "Bullish" | "Bearish" | "Neutral",
  "signalTimeframe": "4H" | "1H" | "15M" | "5M" | "1M",
  "priceActionNarrative": "string",
  "keyZonesExplanation": "string",
  "timeframeAlignment": [
    { "timeframe": "4H"|"1H"|"15M"|"5M"|"1M", "bias": "Bullish"|"Bearish"|"Neutral", "structureEvent": "string", "rangeZone": "Discount"|"Equilibrium"|"Premium", "note": "string" }
  ],
  "plan": {
    "signal": "BUY" | "SELL" | "WAIT",
    "signalStrength": "A+ Setup" | "Standard" | "Developing",
    "setupType": "string",
    "triggerPattern": "string",
    "entryPrice": number,
    "entryZone": "string",
    "stopLoss": number,
    "takeProfit1": number,
    "takeProfit2": number,
    "riskRewardRatio": "string",
    "invalidationReason": "string",
    "confluences": ["string", "string", "string"]
  }
}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_FALLBACK_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: schemaPrompt },
        {
          role: 'user',
          content: `Analyze all 5 timeframes (1M, 5M, 15M, 1H, 4H) of pure OHLC price action:\n${payloadJson}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq fallback failed (${res.status}): ${errText}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('Groq returned an empty price-action signal response.');
  }
  return JSON.parse(content) as RawSignalJSON;
}

export async function generatePriceActionSignal(params: {
  symbol: string;
  activeTimeframe: Timeframe;
  timeframesData: TimeframePriceActionInput[];
}): Promise<AIPriceActionSignal> {
  const { symbol, activeTimeframe, timeframesData } = params;
  const instrument = getInstrumentBySymbol(symbol);

  const cached = signalCache.get(instrument.symbol);
  if (cached && Date.now() - cached.createdAt < SIGNAL_CACHE_TTL_MS) {
    return {
      ...cached.signal,
      timeframe: activeTimeframe,
    };
  }

  const geminiKey = getGeminiApiKey();
  const groqKey = getGroqApiKey();

  if (!geminiKey && !groqKey) {
    throw new Error(
      'No AI API key configured. Add GEMINI_API_KEY (or optional GROQ_API_KEY) in Settings > Secrets or Vercel Environment Variables.'
    );
  }

  const activeEntry =
    timeframesData.find((t) => t.timeframe === activeTimeframe) ??
    timeframesData[0];

  const currentPrice =
    activeEntry.candles[activeEntry.candles.length - 1]?.close ??
    instrument.basePrice;

  const multiTimeframeContext = timeframesData.map((tfItem) => ({
    timeframe: tfItem.timeframe,
    structure: tfItem.analysis.snapshot,
    supportResistanceLevels: tfItem.analysis.levels.slice(0, 4),
    imbalancesAndOrderBlocks: tfItem.analysis.zones.slice(0, 4),
    recentCandlestickPatterns: tfItem.analysis.recentPatterns.slice(0, 4),
    recentOHLC: tfItem.candles
      .slice(tfItem.timeframe === activeTimeframe ? -24 : -12)
      .map((c) => ({
        t: new Date(c.time * 1000).toISOString().slice(11, 16),
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
      })),
  }));

  const payloadJson = JSON.stringify({
    instrument: {
      symbol: instrument.symbol,
      name: instrument.name,
      category: instrument.category,
      decimals: instrument.decimals,
    },
    activeChartTimeframe: activeTimeframe,
    currentPrice,
    multiTimeframePriceAction: multiTimeframeContext,
  });

  const systemInstruction = [
    'You are an institutional top-down multi-timeframe pure price-action analyst.',
    'You are given pure OHLC price action across ALL 5 timeframes (1M, 5M, 15M, 1H, 4H) with zero lagging indicators.',
    'Perform a top-down analysis: evaluate higher-timeframe structure and liquidity (4H and 1H), mid-timeframe Order Blocks and FVGs (15M), and lower-timeframe execution triggers like CHoCH, BOS, liquidity sweeps, engulfings, and pin bars (5M and 1M).',
    'CRITICAL RULE: Do NOT use, mention, or rely on lagging indicators such as RSI, MACD, EMA, SMA, Stochastics, or Bollinger Bands.',
    'Select the single best signalTimeframe (one of: 1M, 5M, 15M, 1H, 4H) where the cleanest price-action entry trigger and risk-to-reward setup is currently aligned.',
    'Provide a concise timeframeAlignment array covering all 5 timeframes (4H, 1H, 15M, 5M, 1M).',
    `All price levels must be realistic relative to currentPrice (${currentPrice}) and rounded to ${instrument.decimals} decimal places.`,
    'For a BUY signal: stopLoss < entryPrice < takeProfit1 < takeProfit2.',
    'For a SELL signal: takeProfit2 < takeProfit1 < entryPrice < stopLoss.',
    'If multi-timeframe structure conflicts with no clean risk-reward edge, output signal "WAIT" and explain which timeframe level needs to break or sweep first.',
    'Never promise guaranteed profits.',
  ].join(' ');

  let parsed: RawSignalJSON | null = null;
  let usedModel = PRIMARY_MODEL;
  let lastError: unknown = null;

  if (geminiKey) {
    const ai = createGeminiClient(geminiKey);
    try {
      parsed = await runGeminiModel(
        ai,
        PRIMARY_MODEL,
        systemInstruction,
        payloadJson
      );
      usedModel = PRIMARY_MODEL;
    } catch (err) {
      lastError = err;
      if (isQuotaError(err)) {
        try {
          parsed = await runGeminiModel(
            ai,
            FALLBACK_MODEL,
            systemInstruction,
            payloadJson
          );
          usedModel = FALLBACK_MODEL;
        } catch (fallbackErr) {
          lastError = fallbackErr;
        }
      }
    }
  }

  if (!parsed && groqKey && (lastError === null || isQuotaError(lastError))) {
    try {
      parsed = await runGroqFallback(groqKey, systemInstruction, payloadJson);
      usedModel = GROQ_FALLBACK_MODEL;
    } catch (groqErr) {
      lastError = groqErr;
    }
  }

  if (!parsed) {
    throw formatProviderError(lastError);
  }

  const resolvedSignalTf = normalizeTimeframe(
    parsed.signalTimeframe || activeTimeframe,
    activeTimeframe
  );

  const signal: AIPriceActionSignal = {
    id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    symbol: instrument.symbol,
    timeframe: activeTimeframe,
    signalTimeframe: resolvedSignalTf,
    analyzedAt: new Date().toISOString(),
    model: usedModel,
    spotPriceAtSignal: currentPrice,
    bias: parsed.bias,
    priceActionNarrative: parsed.priceActionNarrative,
    keyZonesExplanation: parsed.keyZonesExplanation,
    timeframeAlignment: (parsed.timeframeAlignment ?? []).map((item) => ({
      ...item,
      timeframe: normalizeTimeframe(item.timeframe, activeTimeframe),
    })),
    plan: parsed.plan,
  };

  signalCache.set(instrument.symbol, {
    createdAt: Date.now(),
    signal,
  });

  return signal;
}

interface RawBacktestReviewJSON {
  verdict: 'Strong Edge' | 'Moderate Edge' | 'Needs Filtering';
  summary: string;
  bestPerformingPattern: string;
  keyWeakness: string;
  recommendations: string[];
}

async function runGeminiBacktestReview(
  ai: GoogleGenAI,
  model: string,
  systemInstruction: string,
  payloadJson: string
): Promise<RawBacktestReviewJSON> {
  const response = await ai.models.generateContent({
    model,
    contents: `Audit this strictly causal, non-repainting pure price-action backtest and return structured findings:\n${payloadJson}`,
    config: {
      systemInstruction,
      ...(model === PRIMARY_MODEL
        ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
        : {}),
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          verdict: {
            type: Type.STRING,
            description:
              'Edge verdict: Strong Edge, Moderate Edge, or Needs Filtering.',
          },
          summary: {
            type: Type.STRING,
            description:
              '2-3 concise sentences evaluating win rate, profit factor, expectancy R, and drawdown.',
          },
          bestPerformingPattern: {
            type: Type.STRING,
            description:
              'Which price-action setup or trigger showed the strongest net R performance.',
          },
          keyWeakness: {
            type: Type.STRING,
            description:
              'Primary structural weakness, loss clustering, or drawdown driver observed in the ledger.',
          },
          recommendations: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description:
              '3 actionable pure price-action refinements (e.g., HTF alignment, liquidity sweep filter, session timing). Never mention lagging indicators.',
          },
        },
        required: [
          'verdict',
          'summary',
          'bestPerformingPattern',
          'keyWeakness',
          'recommendations',
        ],
      },
    },
  });

  const rawText = (response.text ?? '').trim();
  if (!rawText) {
    throw new Error(`Model ${model} returned an empty backtest audit.`);
  }
  return JSON.parse(rawText) as RawBacktestReviewJSON;
}

async function runGroqBacktestReview(
  groqApiKey: string,
  systemInstruction: string,
  payloadJson: string
): Promise<RawBacktestReviewJSON> {
  const schemaPrompt = `${systemInstruction}

Return ONLY valid JSON matching this exact shape:
{
  "verdict": "Strong Edge" | "Moderate Edge" | "Needs Filtering",
  "summary": "string",
  "bestPerformingPattern": "string",
  "keyWeakness": "string",
  "recommendations": ["string", "string", "string"]
}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_FALLBACK_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: schemaPrompt },
        {
          role: 'user',
          content: `Audit this causal pure price-action backtest:\n${payloadJson}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq backtest audit failed (${res.status}): ${errText}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('Groq returned an empty backtest audit response.');
  }
  return JSON.parse(content) as RawBacktestReviewJSON;
}

export async function generateBacktestReview(
  backtest: BacktestResult
): Promise<AIBacktestReview> {
  const geminiKey = getGeminiApiKey();
  const groqKey = getGroqApiKey();

  if (!geminiKey && !groqKey) {
    throw new Error(
      'No AI API key configured. Add GEMINI_API_KEY (or optional GROQ_API_KEY) in Settings > Secrets or Vercel Environment Variables.'
    );
  }

  const payloadJson = JSON.stringify({
    symbol: backtest.symbol,
    timeframe: backtest.timeframe,
    barsTested: backtest.barsTested,
    nonRepaintingVerified: backtest.nonRepaintingVerified,
    initialCapital: backtest.initialCapital,
    finalEquity: backtest.finalEquity,
    netReturnUsd: backtest.netReturnUsd,
    netReturnPct: backtest.netReturnPct,
    totalTrades: backtest.totalTrades,
    wins: backtest.wins,
    losses: backtest.losses,
    breakevens: backtest.breakevens,
    winRatePct: backtest.winRatePct,
    profitFactor: backtest.profitFactor,
    expectancyR: backtest.expectancyR,
    maxDrawdownPct: backtest.maxDrawdownPct,
    setupBreakdown: backtest.setupBreakdown,
    recentTradesSample: backtest.trades.slice(0, 18).map((t) => ({
      side: t.side,
      setupType: t.setupType,
      trigger: t.trigger,
      exitReason: t.exitReason,
      tp1Hit: t.tp1Hit,
      rMultiple: t.rMultiple,
      pnlUsd: t.pnlUsd,
    })),
  });

  const systemInstruction = [
    'You are an institutional quantitative price-action auditor.',
    'Review the causal, non-repainting historical backtest results (closed-bar signals, next-bar Open execution, 50% TP1 partial + Breakeven stop, conservative SL-first intrabar simulation).',
    'CRITICAL RULE: Pure price action only — NEVER suggest or mention lagging indicators like RSI, MACD, EMA, SMA, Stochastics, or Bollinger Bands.',
    'Evaluate statistical quality objectively: profit factor, expectancy R, drawdown, and setup breakdown.',
    'Classify verdict strictly as one of: "Strong Edge", "Moderate Edge", or "Needs Filtering".',
    'Provide 3 specific, actionable pure price-action filtering recommendations (e.g., higher-timeframe bias alignment, liquidity sweep confirmation, discount/premium filtering).',
  ].join(' ');

  let parsed: RawBacktestReviewJSON | null = null;
  let usedModel = PRIMARY_MODEL;
  let lastError: unknown = null;

  if (geminiKey) {
    const ai = createGeminiClient(geminiKey);
    try {
      parsed = await runGeminiBacktestReview(
        ai,
        PRIMARY_MODEL,
        systemInstruction,
        payloadJson
      );
      usedModel = PRIMARY_MODEL;
    } catch (err) {
      lastError = err;
      if (isQuotaError(err)) {
        try {
          parsed = await runGeminiBacktestReview(
            ai,
            FALLBACK_MODEL,
            systemInstruction,
            payloadJson
          );
          usedModel = FALLBACK_MODEL;
        } catch (fallbackErr) {
          lastError = fallbackErr;
        }
      }
    }
  }

  if (!parsed && groqKey && (lastError === null || isQuotaError(lastError))) {
    try {
      parsed = await runGroqBacktestReview(
        groqKey,
        systemInstruction,
        payloadJson
      );
      usedModel = GROQ_FALLBACK_MODEL;
    } catch (groqErr) {
      lastError = groqErr;
    }
  }

  if (!parsed) {
    throw formatProviderError(lastError);
  }

  const normalizedVerdict: AIBacktestReview['verdict'] =
    parsed.verdict === 'Strong Edge' ||
    parsed.verdict === 'Moderate Edge' ||
    parsed.verdict === 'Needs Filtering'
      ? parsed.verdict
      : backtest.profitFactor >= 1.5 && backtest.expectancyR > 0.25
      ? 'Strong Edge'
      : backtest.profitFactor >= 1.1
      ? 'Moderate Edge'
      : 'Needs Filtering';

  return {
    model: usedModel,
    reviewedAt: new Date().toISOString(),
    verdict: normalizedVerdict,
    summary: parsed.summary,
    bestPerformingPattern: parsed.bestPerformingPattern,
    keyWeakness: parsed.keyWeakness,
    recommendations: (parsed.recommendations ?? []).slice(0, 4),
  };
}
