import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  enforceSniperDiscipline,
  generateLocalBacktestReview,
  generateLocalMtfSignal,
} from '../analysis/localSignalEngine.ts';
import {
  BACKTEST_JSON_SCHEMA_HINT,
  type RawBacktestReviewJSON,
  type RawSignalJSON,
  SIGNAL_JSON_SCHEMA_HINT,
  type TimeframePriceActionInput,
  buildBacktestReviewPrompt,
  buildMtfSignalPrompt,
  normalizeBacktestReviewResult,
  normalizeSignalResult,
  parseJsonFromModelText,
} from '../analysis/mtfPrompt.ts';
import { analyzePriceAction, getCandleProgress } from '../analysis/priceAction.ts';
import { MARKET_INSTRUMENTS, getInstrumentBySymbol } from '../config/instruments.ts';
import { getMarketCandles } from './marketData.ts';
import type {
  AIBacktestReview,
  AIPriceActionSignal,
  BacktestResult,
  MarketScanResponse,
  Timeframe,
} from '../types/market.ts';

export type { TimeframePriceActionInput };

const PRIMARY_MODEL = 'gemini-4-hydrogen';
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const GROQ_PREFERRED_MODELS = [
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3-32b',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-20b',
  'gemma2-9b-it',
];
const GROQ_MODELS_CACHE_TTL_MS = 5 * 60_000;
const SIGNAL_CACHE_TTL_MS = 6 * 60_000; // Locked for full 5M candle duration until a new bar closes

interface CachedSignalEntry {
  createdAt: number;
  confirmedBarTime: number;
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

async function runGeminiModel(
  ai: GoogleGenAI,
  model: string,
  systemInstruction: string,
  payloadJson: string,
  seed?: number
): Promise<RawSignalJSON> {
  const response = await ai.models.generateContent({
    model,
    contents: `Analyze the full past-to-present historical progression AND recent OHLC price action across all 5 timeframes (4H, 1H, 15M, 5M, 1M) and output a 5M execution signal (BUY, SELL, or WAIT):\n${payloadJson}`,
    config: {
      systemInstruction,
      ...(typeof seed === 'number' && seed > 0 ? { seed } : {}),
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
            description: 'Always "5M" — all trade executions occur strictly on the 5M chart.',
          },
          priceActionNarrative: {
            type: Type.STRING,
            description:
              '2-3 sentences tracing how earlier historical swings/BOS/sweeps on 4H/1H/15M evolved into current price and whether 5M confirms entry now or requires WAIT.',
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

let cachedGroqModels: { fetchedAt: number; models: string[] } | null = null;

function isChatModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return !(
    lower.includes('whisper') ||
    lower.includes('guard') ||
    lower.includes('tts') ||
    lower.includes('orpheus') ||
    lower.includes('embed') ||
    lower.includes('safeguard')
  );
}

async function getCandidateGroqModels(groqApiKey: string): Promise<string[]> {
  if (
    cachedGroqModels &&
    Date.now() - cachedGroqModels.fetchedAt < GROQ_MODELS_CACHE_TTL_MS &&
    cachedGroqModels.models.length > 0
  ) {
    return cachedGroqModels.models;
  }

  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${groqApiKey}` },
    });
    if (res.ok) {
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      const available = (json.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => Boolean(id) && isChatModelId(id!));

      if (available.length > 0) {
        const preferred = GROQ_PREFERRED_MODELS.filter((m) =>
          available.includes(m)
        );
        const remaining = available.filter((m) => !preferred.includes(m));
        const ordered = [...preferred, ...remaining];
        cachedGroqModels = { fetchedAt: Date.now(), models: ordered };
        return ordered;
      }
    }
  } catch {
    // Fall back to static preference list below if /models lookup fails
  }

  return GROQ_PREFERRED_MODELS;
}

function parseJsonResponse<T>(raw: string): T {
  return parseJsonFromModelText<T>(raw);
}

async function callGroqJson<T>(
  groqApiKey: string,
  systemPrompt: string,
  userContent: string,
  label: string
): Promise<{ data: T; model: string }> {
  const candidates = await getCandidateGroqModels(groqApiKey);
  let lastErrorText = '';
  let lastStatus = 500;

  for (const model of candidates) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (res.ok) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content?.trim();
      if (!content) {
        lastErrorText = `Groq model ${model} returned an empty ${label} response.`;
        continue;
      }
      return { data: parseJsonResponse<T>(content), model };
    }

    lastStatus = res.status;
    lastErrorText = await res.text();

    // Retry next accessible model if model is missing/disabled/unsupported
    if (
      res.status === 404 ||
      res.status === 400 ||
      lastErrorText.includes('model_not_found') ||
      lastErrorText.includes('does not exist')
    ) {
      continue;
    }

    // Auth or rate-limit errors won't be fixed by switching models
    break;
  }

  if (lastStatus === 401 || lastStatus === 403) {
    throw new Error(
      'Groq API key is invalid or unauthorized. Verify GROQ_API_KEY in Settings > Secrets (or add a GEMINI_API_KEY).'
    );
  }
  throw new Error(
    `Groq ${label} failed (${lastStatus}) across available models: ${lastErrorText}`
  );
}

async function runGroqFallback(
  groqApiKey: string,
  systemInstruction: string,
  userPrompt: string
): Promise<{ data: RawSignalJSON; model: string }> {
  const schemaPrompt = `${systemInstruction}\n\n${SIGNAL_JSON_SCHEMA_HINT}`;

  return callGroqJson<RawSignalJSON>(
    groqApiKey,
    schemaPrompt,
    userPrompt,
    'price-action signal'
  );
}

export async function generatePriceActionSignal(params: {
  symbol: string;
  activeTimeframe: Timeframe;
  timeframesData: TimeframePriceActionInput[];
}): Promise<AIPriceActionSignal> {
  const { symbol, activeTimeframe, timeframesData } = params;
  const instrument = getInstrumentBySymbol(symbol);

  const geminiKey = getGeminiApiKey();
  const groqKey = getGroqApiKey();

  const {
    currentPrice,
    confirmedBarTime,
    payloadJson,
    systemInstruction,
    userPrompt,
  } = buildMtfSignalPrompt({
    symbol,
    activeTimeframe,
    timeframesData,
  });

  // Strict non-repainting lock: return the exact signal locked to this closed 5M candle
  const cacheKey = `${instrument.symbol}:${confirmedBarTime}`;
  const cached = signalCache.get(cacheKey);
  if (
    cached &&
    confirmedBarTime > 0 &&
    Date.now() - cached.createdAt < SIGNAL_CACHE_TTL_MS
  ) {
    return {
      ...cached.signal,
      timeframe: activeTimeframe,
    };
  }

  let parsed: RawSignalJSON | null = null;
  let usedModel = PRIMARY_MODEL;

  if (geminiKey) {
    const ai = createGeminiClient(geminiKey);
    try {
      parsed = await runGeminiModel(
        ai,
        PRIMARY_MODEL,
        systemInstruction,
        payloadJson,
        confirmedBarTime
      );
      usedModel = PRIMARY_MODEL;
    } catch {
      try {
        parsed = await runGeminiModel(
          ai,
          FALLBACK_MODEL,
          systemInstruction,
          payloadJson,
          confirmedBarTime
        );
        usedModel = FALLBACK_MODEL;
      } catch {
        // Fall through to Groq or Local MTF (Free Forever)
      }
    }
  }

  if (!parsed && groqKey) {
    try {
      const groqRes = await runGroqFallback(
        groqKey,
        systemInstruction,
        userPrompt
      );
      parsed = groqRes.data;
      usedModel = groqRes.model;
    } catch {
      // Fall through to Local MTF (Free Forever)
    }
  }

  // Unlimited, 100% Free Forever closed-bar MTF Sniper price-action fallback + strict Sniper gatekeeper
  const signal = parsed
    ? enforceSniperDiscipline({
        signal: normalizeSignalResult({
          parsed,
          symbol: instrument.symbol,
          activeTimeframe,
          currentPrice,
          confirmedBarTime,
          model: usedModel,
        }),
        timeframesData,
      })
    : generateLocalMtfSignal({
        symbol: instrument.symbol,
        activeTimeframe,
        timeframesData,
      });

  if (signalCache.size > 60) {
    const oldestKey = signalCache.keys().next().value;
    if (oldestKey) signalCache.delete(oldestKey);
  }

  signalCache.set(cacheKey, {
    createdAt: Date.now(),
    confirmedBarTime: signal.confirmedBarTime || confirmedBarTime,
    signal,
  });

  return signal;
}

let cachedMarketScan: {
  confirmedBarTime: number;
  createdAt: number;
  result: MarketScanResponse;
} | null = null;
let marketScanInflight: Promise<MarketScanResponse> | null = null;

function scoreWatchProximity(sig: AIPriceActionSignal): number {
  const spot = Math.max(sig.spotPriceAtSignal, 1e-9);
  const entry = sig.plan.entryPrice > 0 ? sig.plan.entryPrice : spot;
  const distPct = (Math.abs(spot - entry) / spot) * 100;
  const alignedBonus = sig.bias !== 'Neutral' ? 10 : 0;
  const conflictPenalty = sig.plan.setupType.includes('Conflict') ? -15 : 0;
  return alignedBonus + conflictPenalty - distPct * 4 + sig.plan.confluences.length;
}

/**
 * Scans all market instruments across 4H–1M strictly on closed bars for A+ Sniper Entries only.
 * Results are locked to the latest closed 5M candle timestamp so the scan never repaints mid-bar.
 */
export async function scanMarketSniperSetups(): Promise<MarketScanResponse> {
  const { bucketStartSec } = getCandleProgress('5M');
  const expectedClosed5m = bucketStartSec - 300;

  if (
    cachedMarketScan &&
    cachedMarketScan.confirmedBarTime >= expectedClosed5m &&
    Date.now() - cachedMarketScan.createdAt < SIGNAL_CACHE_TTL_MS
  ) {
    return cachedMarketScan.result;
  }

  if (marketScanInflight) {
    return marketScanInflight;
  }

  marketScanInflight = (async () => {
    try {
      const orderedTfs: Timeframe[] = ['4H', '1H', '15M', '5M', '1M'];
      const allSignals: AIPriceActionSignal[] = [];
      const batchSize = 7;

      for (let i = 0; i < MARKET_INSTRUMENTS.length; i += batchSize) {
        const batch = MARKET_INSTRUMENTS.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(async (instrument) => {
            const timeframesData: TimeframePriceActionInput[] = await Promise.all(
              orderedTfs.map(async (tf) => {
                const targetLimit = tf === '5M' ? 240 : 200;
                const data = await getMarketCandles(instrument.symbol, tf, targetLimit);
                return {
                  timeframe: tf,
                  candles: data.candles,
                  analysis: analyzePriceAction(data.candles, instrument.decimals, {
                    timeframe: tf,
                  }),
                };
              })
            );

            const m5Entry =
              timeframesData.find((t) => t.timeframe === '5M') ?? timeframesData[0];
            const m5Closed = m5Entry.candles.filter((c) => c.time < bucketStartSec);
            const barTime =
              m5Closed[m5Closed.length - 1]?.time ?? expectedClosed5m;
            const cacheKey = `${instrument.symbol}:${barTime}`;
            const existing = signalCache.get(cacheKey);
            if (
              existing &&
              Date.now() - existing.createdAt < SIGNAL_CACHE_TTL_MS
            ) {
              return existing.signal;
            }

            const sniperSig = generateLocalMtfSignal({
              symbol: instrument.symbol,
              activeTimeframe: '5M',
              timeframesData,
            });

            if (sniperSig.plan.signal !== 'WAIT') {
              if (signalCache.size > 60) {
                const oldestKey = signalCache.keys().next().value;
                if (oldestKey) signalCache.delete(oldestKey);
              }
              signalCache.set(cacheKey, {
                createdAt: Date.now(),
                confirmedBarTime: sniperSig.confirmedBarTime || barTime,
                signal: sniperSig,
              });
            }

            return sniperSig;
          })
        );
        allSignals.push(...batchResults);
      }

      const parseRr = (s: string): number => {
        const m = String(s).match(/:\s*(\d+(?:\.\d+)?)/);
        return m ? Number(m[1]) : 0;
      };

      const sniperSignals = allSignals
        .filter((s) => s.plan.signal === 'BUY' || s.plan.signal === 'SELL')
        .sort((a, b) => parseRr(b.plan.riskRewardRatio) - parseRr(a.plan.riskRewardRatio));

      const watchSignals = allSignals
        .filter((s) => s.plan.signal === 'WAIT')
        .sort((a, b) => scoreWatchProximity(b) - scoreWatchProximity(a));

      const confirmedBarTime =
        sniperSignals[0]?.confirmedBarTime ||
        watchSignals[0]?.confirmedBarTime ||
        expectedClosed5m;

      const result: MarketScanResponse = {
        scannedAt: new Date().toISOString(),
        confirmedBarTime,
        totalScanned: allSignals.length,
        sniperSignals,
        watchSignals,
      };

      cachedMarketScan = {
        confirmedBarTime,
        createdAt: Date.now(),
        result,
      };

      return result;
    } finally {
      marketScanInflight = null;
    }
  })();

  return marketScanInflight;
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
): Promise<{ data: RawBacktestReviewJSON; model: string }> {
  const schemaPrompt = `${systemInstruction}\n\n${BACKTEST_JSON_SCHEMA_HINT}`;

  return callGroqJson<RawBacktestReviewJSON>(
    groqApiKey,
    schemaPrompt,
    `Audit this causal pure price-action backtest:\n${payloadJson}`,
    'backtest audit'
  );
}

export async function generateBacktestReview(
  backtest: BacktestResult
): Promise<AIBacktestReview> {
  const geminiKey = getGeminiApiKey();
  const groqKey = getGroqApiKey();

  const { payloadJson, systemInstruction } = buildBacktestReviewPrompt(backtest);

  let parsed: RawBacktestReviewJSON | null = null;
  let usedModel = PRIMARY_MODEL;

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
    } catch {
      try {
        parsed = await runGeminiBacktestReview(
          ai,
          FALLBACK_MODEL,
          systemInstruction,
          payloadJson
        );
        usedModel = FALLBACK_MODEL;
      } catch {
        // Fall through to Groq or Local Audit (Free Forever)
      }
    }
  }

  if (!parsed && groqKey) {
    try {
      const groqRes = await runGroqBacktestReview(
        groqKey,
        systemInstruction,
        payloadJson
      );
      parsed = groqRes.data;
      usedModel = groqRes.model;
    } catch {
      // Fall through to Local Audit (Free Forever)
    }
  }

  if (!parsed) {
    return generateLocalBacktestReview(backtest);
  }

  return normalizeBacktestReviewResult({
    parsed,
    backtest,
    model: usedModel,
  });
}
