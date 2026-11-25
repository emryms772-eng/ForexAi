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
import { extractHistoricalPriceActionTimeline } from './priceAction.ts';

export interface TimeframePriceActionInput {
  timeframe: Timeframe;
  candles: OHLCVCandle[];
  analysis: PriceActionAnalysisSummary;
}

export interface RawSignalJSON {
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  signalTimeframe: string;
  priceActionNarrative: string;
  keyZonesExplanation: string;
  timeframeAlignment: TimeframeAlignmentItem[];
  plan: AIPriceActionSignal['plan'];
}

export interface RawBacktestReviewJSON {
  verdict: 'Strong Edge' | 'Moderate Edge' | 'Needs Filtering';
  summary: string;
  bestPerformingPattern: string;
  keyWeakness: string;
  recommendations: string[];
}

export function normalizeTimeframe(raw: string, fallback: Timeframe): Timeframe {
  const upper = String(raw ?? '').trim().toUpperCase();
  if (TIMEFRAMES.includes(upper as Timeframe)) {
    return upper as Timeframe;
  }
  return fallback;
}

export function parseJsonFromModelText<T>(raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as T;
    }
    throw new Error('Model response was not valid JSON.');
  }
}

export const SIGNAL_JSON_SCHEMA_HINT = `Return ONLY valid JSON matching this exact shape (no markdown, no extra text):
{
  "bias": "Bullish" | "Bearish" | "Neutral",
  "signalTimeframe": "5M",
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

export const BACKTEST_JSON_SCHEMA_HINT = `Return ONLY valid JSON matching this exact shape (no markdown, no extra text):
{
  "verdict": "Strong Edge" | "Moderate Edge" | "Needs Filtering",
  "summary": "string",
  "bestPerformingPattern": "string",
  "keyWeakness": "string",
  "recommendations": ["string", "string", "string"]
}`;

export function buildMtfSignalPrompt(params: {
  symbol: string;
  activeTimeframe: Timeframe;
  timeframesData: TimeframePriceActionInput[];
}) {
  const { symbol, activeTimeframe, timeframesData } = params;
  const instrument = getInstrumentBySymbol(symbol);

  const activeEntry =
    timeframesData.find((t) => t.timeframe === activeTimeframe) ??
    timeframesData[0];

  const activeClosedCandles =
    activeEntry.candles.length > 10
      ? activeEntry.candles.slice(0, -1)
      : activeEntry.candles;
  const currentPrice =
    activeClosedCandles[activeClosedCandles.length - 1]?.close ??
    activeEntry.candles[activeEntry.candles.length - 1]?.close ??
    instrument.basePrice;

  const multiTimeframeContext = timeframesData.map((tfItem) => {
    // Strictly exclude unclosed forming bar so AI signals never repaint mid-candle
    const closedCandles =
      tfItem.candles.length > 10
        ? tfItem.candles.slice(0, -1)
        : tfItem.candles;
    const timeline = extractHistoricalPriceActionTimeline(
      tfItem.candles,
      instrument.decimals
    );
    const recentBarCount =
      tfItem.timeframe === '5M' ? 32 : tfItem.timeframe === '1M' ? 12 : 14;
    const snap = tfItem.analysis.snapshot;

    return {
      tf: tfItem.timeframe,
      role:
        tfItem.timeframe === '5M'
          ? 'EXECUTION_5M'
          : tfItem.timeframe === '1M'
          ? 'MICRO_TIMING'
          : 'HTF_CONTEXT',
      closedBarsOnly: true,
      history: {
        bars: timeline.barsAnalyzed,
        window: `${timeline.windowStartIso} -> ${timeline.windowEndIso}`,
        highLow: [timeline.historicalLow, timeline.historicalHigh],
        macroPosPct: timeline.macroRangePositionPct,
        macroZone: timeline.macroZone,
        sessionShift: timeline.earlierSessionVsRecentShift,
        swings: timeline.swingSequence.map(
          (s) => `${s.time} ${s.label} ${s.price}`
        ),
        events: timeline.historicalStructureAndSweeps.map(
          (e) => `${e.time} ${e.event} @ ${e.price}`
        ),
        equalLiquidityPools: timeline.equalLiquidityPools,
        displacementEvents: timeline.displacementEvents,
      },
      snapshot: {
        trend: snap.trendStructure,
        event: snap.latestStructureEvent,
        sweep: snap.recentSweep,
        rangePct: snap.rangePositionPct,
        zone: snap.rangeZone,
        eq50: snap.equilibriumPrice,
        dealingRange: [snap.dealingRangeLow, snap.dealingRangeHigh],
        buyerPressurePct: snap.buyerPressurePct,
      },
      levels: tfItem.analysis.levels
        .slice(0, 5)
        .map((l) => `${l.type}(${l.strength}) @ ${l.price}`),
      zones: tfItem.analysis.zones
        .slice(0, 5)
        .map((z) => `${z.kind} [${z.low}-${z.high}]`),
      patterns: tfItem.analysis.recentPatterns
        .slice(0, 5)
        .map(
          (p) =>
            `${new Date(p.time * 1000).toISOString().slice(5, 16).replace('T', ' ')} ${p.name} (${p.bias})`
        ),
      ohlcvLegend: 't|o|h|l|c|v',
      recentClosedBars: closedCandles
        .slice(-recentBarCount)
        .map(
          (c) =>
            `${new Date(c.time * 1000).toISOString().slice(5, 16).replace('T', ' ')}|${c.open}|${c.high}|${c.low}|${c.close}|${c.volume}`
        ),
    };
  });

  const payloadJson = JSON.stringify({
    instrument: {
      symbol: instrument.symbol,
      name: instrument.name,
      category: instrument.category,
      decimals: instrument.decimals,
    },
    activeChartTimeframe: activeTimeframe,
    executionTimeframe: '5M',
    nonRepaintingClosedBarsOnly: true,
    lastClosedPrice: currentPrice,
    multiTimeframePriceAction: multiTimeframeContext,
  });

  const systemInstruction = [
    'You are an institutional top-down multi-timeframe pure price-action analyst operating strictly on CLOSED, NON-REPAINTING candles.',
    'All data provided uses closed bars only (no unclosed forming candles). Never guess or extrapolate unclosed candle movement.',
    'THOROUGH MARKET READ: Carefully synthesize ALL price-action evidence across ALL 5 timeframes (4H, 1H, 15M, 5M, 1M): chronological swing progression (HH/HL/LH/LL), BOS/CHoCH structural shifts, earlier-vs-recent session shifts, unswept Equal Highs/Lows (EQH/EQL liquidity magnets), liquidity sweeps, high-volume displacement bursts, unmitigated Order Blocks & Fair Value Gaps, S/R clusters, buyer/seller pressure, and candlestick rejection/engulfing triggers.',
    'EXECUTION RULE: Execution is ALWAYS strictly on the 5M timeframe. Set signalTimeframe to "5M". All entryPrice, entryZone, stopLoss, takeProfit1, and takeProfit2 levels MUST be calibrated for 5M execution.',
    'MANDATORY QUALITY FILTERS: (1) Only issue BUY or SELL if aligned with the dominant 1H/4H historical structure and liquidity sweep; (2) Restrict BUY entries to Discount/Deep Discount zones (<= 42% of dealing range) and SELL entries to Premium zones (>= 58% of dealing range); (3) After a liquidity sweep, require confirmed closed-bar 5M displacement (strong expansion body + volume/FVG follow-through) rather than entering on an unconfirmed initial reclaim.',
    'WHEN TO WAIT: If 4H/1H/15M conflict, if 5M is in mid-range equilibrium, or if 5M has not yet swept liquidity/printed closed-bar displacement or mitigated a 5M OB/FVG, you MUST output signal "WAIT". When outputting WAIT, clearly state why to wait, what exact 5M closed-bar trigger/price level confirms entry, and still populate realistic conditional watch levels (entryPrice at the key 5M zone to watch, stopLoss behind structure, takeProfit1/takeProfit2 at EQH/EQL or swing liquidity targets).',
    'CRITICAL RULE: Do NOT use, mention, or rely on lagging indicators such as RSI, MACD, EMA, SMA, Stochastics, or Bollinger Bands.',
    'Provide a concise timeframeAlignment array covering all 5 timeframes (4H, 1H, 15M, 5M, 1M).',
    `All price levels must be realistic relative to lastClosedPrice (${currentPrice}) and rounded to ${instrument.decimals} decimal places.`,
    'For a BUY (or bullish WAIT watch plan): stopLoss < entryPrice < takeProfit1 < takeProfit2.',
    'For a SELL (or bearish WAIT watch plan): takeProfit2 < takeProfit1 < entryPrice < stopLoss.',
    'Never promise guaranteed profits.',
  ].join(' ');

  const userPrompt = `Analyze the full past-to-present historical progression AND recent OHLCV across all 5 timeframes (4H, 1H, 15M, 5M, 1M), and output a 5M execution signal (BUY, SELL, or WAIT):\n${payloadJson}`;

  return {
    instrument,
    currentPrice,
    payloadJson,
    systemInstruction,
    userPrompt,
  };
}

export function normalizeSignalResult(params: {
  parsed: RawSignalJSON;
  symbol: string;
  activeTimeframe: Timeframe;
  currentPrice: number;
  model: string;
}): AIPriceActionSignal {
  const { parsed, symbol, activeTimeframe, currentPrice, model } = params;
  const instrument = getInstrumentBySymbol(symbol);
  const rawPlan = (parsed.plan ?? {}) as Partial<AIPriceActionSignal['plan']>;

  const rawAction = String(rawPlan.signal ?? 'WAIT').toUpperCase();
  const signalAction: 'BUY' | 'SELL' | 'WAIT' =
    rawAction === 'BUY' || rawAction === 'SELL' ? rawAction : 'WAIT';

  const rawBias = String(parsed.bias ?? 'Neutral');
  const bias: AIPriceActionSignal['bias'] =
    rawBias === 'Bullish' || rawBias === 'Bearish' ? rawBias : 'Neutral';

  const rawStrength = String(rawPlan.signalStrength ?? 'Developing');
  const signalStrength: AIPriceActionSignal['plan']['signalStrength'] =
    rawStrength === 'A+ Setup' || rawStrength === 'Standard'
      ? rawStrength
      : 'Developing';

  const toFinite = (val: unknown, fallback = 0): number => {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    symbol: instrument.symbol,
    timeframe: activeTimeframe,
    signalTimeframe: '5M',
    analyzedAt: new Date().toISOString(),
    model,
    spotPriceAtSignal: currentPrice,
    bias,
    priceActionNarrative:
      parsed.priceActionNarrative || 'Multi-timeframe price-action scan completed.',
    keyZonesExplanation:
      parsed.keyZonesExplanation || 'See active 5M Order Blocks, FVGs, and S/R zones.',
    timeframeAlignment: (Array.isArray(parsed.timeframeAlignment)
      ? parsed.timeframeAlignment
      : []
    ).map((item) => ({
      ...item,
      timeframe: normalizeTimeframe(item.timeframe, activeTimeframe),
    })),
    plan: {
      signal: signalAction,
      signalStrength,
      setupType: rawPlan.setupType || 'MTF Structure & Liquidity Setup',
      triggerPattern: rawPlan.triggerPattern || '5M Price Action Confirmation',
      entryPrice: toFinite(rawPlan.entryPrice, signalAction === 'WAIT' ? 0 : currentPrice),
      entryZone: rawPlan.entryZone || currentPrice.toFixed(instrument.decimals),
      stopLoss: toFinite(rawPlan.stopLoss, 0),
      takeProfit1: toFinite(rawPlan.takeProfit1, 0),
      takeProfit2: toFinite(rawPlan.takeProfit2, 0),
      riskRewardRatio: rawPlan.riskRewardRatio || '1 : 2.0',
      invalidationReason:
        rawPlan.invalidationReason || '5M candle close beyond structural invalidation.',
      confluences: Array.isArray(rawPlan.confluences)
        ? rawPlan.confluences.slice(0, 5)
        : [],
    },
  };
}

export function buildBacktestReviewPrompt(backtest: BacktestResult) {
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
    appliedFilters: backtest.appliedFilters ?? [],
    filterStats: backtest.filterStats ?? null,
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

  return { payloadJson, systemInstruction };
}

export function normalizeBacktestReviewResult(params: {
  parsed: RawBacktestReviewJSON;
  backtest: BacktestResult;
  model: string;
}): AIBacktestReview {
  const { parsed, backtest, model } = params;
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
    model,
    reviewedAt: new Date().toISOString(),
    verdict: normalizedVerdict,
    summary: parsed.summary || 'Backtest audit completed.',
    bestPerformingPattern: parsed.bestPerformingPattern || 'N/A',
    keyWeakness: parsed.keyWeakness || 'N/A',
    recommendations: Array.isArray(parsed.recommendations)
      ? parsed.recommendations.slice(0, 4)
      : [],
  };
}

export function formatSmsSignalText(signal: AIPriceActionSignal): string {
  const instrument = getInstrumentBySymbol(signal.symbol);
  const d = instrument.decimals;
  const fmt = (val: number) => (val > 0 ? val.toFixed(d) : 'Watch');
  const { plan } = signal;
  const timestamp = new Date(signal.analyzedAt || Date.now()).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const lines = [
    `StrataDesk 5M | ${signal.symbol}`,
    `${plan.signal} (${plan.signalStrength}) | ${plan.setupType}`,
    `Entry: ${fmt(plan.entryPrice)} | SL: ${fmt(plan.stopLoss)}`,
    `TP1: ${fmt(plan.takeProfit1)} | TP2: ${fmt(plan.takeProfit2)} (${plan.riskRewardRatio})`,
    `Trigger: ${plan.triggerPattern}`,
    `Invalidation: ${plan.invalidationReason}`,
    `Closed-Bar Non-Repainting (${timestamp})`,
  ];

  return lines.join('\n');
}
