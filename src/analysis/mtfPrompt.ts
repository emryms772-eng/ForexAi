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
import { analyzeGoldProtocol } from './goldProtocol.ts';
import {
  extractHistoricalPriceActionTimeline,
  getClosedCandlesForTimeframe,
} from './priceAction.ts';

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

  const m5Entry =
    timeframesData.find((t) => t.timeframe === '5M') ??
    timeframesData.find((t) => t.timeframe === activeTimeframe) ??
    timeframesData[0];

  const m5ClosedCandles = getClosedCandlesForTimeframe(m5Entry.candles, '5M');
  const confirmedBarTime = m5ClosedCandles[m5ClosedCandles.length - 1]?.time ?? 0;
  const currentPrice =
    m5ClosedCandles[m5ClosedCandles.length - 1]?.close ??
    m5Entry.candles[m5Entry.candles.length - 1]?.close ??
    instrument.basePrice;

  const multiTimeframeContext = timeframesData.map((tfItem) => {
    // Strictly exclude unclosed forming bar so AI signals never repaint mid-candle
    const closedCandles = getClosedCandlesForTimeframe(
      tfItem.candles,
      tfItem.timeframe
    );
    const timeline = extractHistoricalPriceActionTimeline(
      tfItem.candles,
      instrument.decimals,
      { timeframe: tfItem.timeframe }
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

  const h1Entry =
    timeframesData.find((t) => t.timeframe === '1H') ?? m5Entry;
  const goldProtocol =
    instrument.symbol === 'XAU/USD'
      ? analyzeGoldProtocol({
          h1Candles: h1Entry.candles,
          ltfCandles: m5Entry.candles,
          ltfTimeframe: m5Entry.timeframe,
          h1Summary: h1Entry.timeframe === '1H' ? h1Entry.analysis : undefined,
        })
      : null;

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
    ...(goldProtocol ? { goldProtocol3Phase: goldProtocol } : {}),
    multiTimeframePriceAction: multiTimeframeContext,
  });

  const goldRules = goldProtocol
    ? 'XAU/USD 3-PHASE PROTOCOL: Anchor primary directional bias on H1; respect UTC Daily Session Breaks, open gaps, and 50-point (500-pip) psychological levels; classify the active daily scenario (Sideways consolidation, Clean uptrend/downtrend, Initial drop -> bullish reversal, Initial rally -> bearish reversal); prioritize 3rd-touch inception trendline + Fibonacci confluence; distinguish wick rejections vs solid candle body closures (never confirm breakouts on wicks alone); and respect macro/geopolitical volatility spike warnings.'
    : '';

  const systemInstruction = [
    'You are an institutional top-down multi-timeframe pure price-action analyst operating strictly on CLOSED, NON-REPAINTING candles. SNIPER ENTRIES ONLY — ZERO SECOND-GUESSING.',
    'All data provided uses closed bars only (no unclosed forming candles). Never guess or extrapolate unclosed candle movement.',
    'THOROUGH MARKET READ: Carefully synthesize ALL price-action evidence across ALL 5 timeframes (4H, 1H, 15M, 5M, 1M): chronological swing progression (HH/HL/LH/LL), BOS/CHoCH structural shifts, earlier-vs-recent session shifts, unswept Equal Highs/Lows (EQH/EQL liquidity magnets), liquidity sweeps, high-volume displacement bursts, unmitigated Order Blocks & Fair Value Gaps, S/R clusters, buyer/seller pressure, and candlestick rejection/engulfing triggers.',
    ...(goldRules ? [goldRules] : []),
    'EXECUTION RULE: Execution is ALWAYS strictly on the 5M timeframe. Set signalTimeframe to "5M". All entryPrice, entryZone, stopLoss, takeProfit1, and takeProfit2 levels MUST be calibrated for 5M execution.',
    'MANDATORY SNIPER QUALITY GATES: NEVER issue Standard/mediocre trades. Output BUY or SELL ONLY as an "A+ Setup" when ALL FOUR Sniper Gates pass on closed bars: (1) Zero conflict across 4H & 1H (and 15M must not oppose); (2) 5M price sits in OTE Deep Discount (<= 40%) for BUY or OTE Deep Premium (>= 60%) for SELL mitigating a 5M Order Block or Fair Value Gap; (3) Confirmed closed-bar liquidity sweep + strong 5M displacement expansion + >=3 confluences; (4) Minimum Risk-to-Reward >= 1:2.5.',
    'WHEN TO WAIT: If ANY of the 4 Sniper Gates fails, you MUST output signal "WAIT" with zero hesitation. Clearly state why to stay flat, what exact 5M closed-bar sniper trigger confirms entry, and populate conditional watch levels (entryPrice at the key 5M sniper OTE zone, stopLoss behind structure, takeProfit1/takeProfit2 at EQH/EQL liquidity targets).',
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
    confirmedBarTime,
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
  confirmedBarTime?: number;
  model: string;
}): AIPriceActionSignal {
  const {
    parsed,
    symbol,
    activeTimeframe,
    currentPrice,
    confirmedBarTime = 0,
    model,
  } = params;
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
    id: `sig-${instrument.symbol.replace('/', '')}-${confirmedBarTime || Date.now()}`,
    symbol: instrument.symbol,
    timeframe: activeTimeframe,
    signalTimeframe: '5M',
    analyzedAt: new Date().toISOString(),
    confirmedBarTime,
    confirmedBarCloseTime: confirmedBarTime > 0 ? confirmedBarTime + 300 : 0,
    isLockedToClosedBar: true,
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
  const barTime =
    signal.confirmedBarTime > 0
      ? new Date(signal.confirmedBarTime * 1000).toISOString().slice(11, 16) + ' UTC'
      : new Date(signal.analyzedAt || Date.now()).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });

  const actionLine =
    plan.signal === 'WAIT'
      ? 'Action: WAIT FOR 5M CANDLE CLOSE CONFIRMATION'
      : `Action: ENTER NOW (${plan.signal} Confirmed on Closed 5M Bar)`;

  const lines = [
    `StrataDesk 5M | ${signal.symbol}`,
    `${plan.signal} (${plan.signalStrength}) | ${plan.setupType}`,
    actionLine,
    `Entry: ${fmt(plan.entryPrice)} | SL: ${fmt(plan.stopLoss)}`,
    `TP1: ${fmt(plan.takeProfit1)} | TP2: ${fmt(plan.takeProfit2)} (${plan.riskRewardRatio})`,
    `Trigger: ${plan.triggerPattern}`,
    `Invalidation: ${plan.invalidationReason}`,
    `Locked Closed Bar: ${barTime} (Non-Repainting)`,
  ];

  return lines.join('\n');
}
