import { getInstrumentBySymbol } from '../config/instruments.ts';
import type {
  AIBacktestReview,
  AIPriceActionSignal,
  BacktestResult,
  Timeframe,
  TimeframeAlignmentItem,
} from '../types/market.ts';
import type { TimeframePriceActionInput } from './mtfPrompt.ts';
import {
  extractHistoricalPriceActionTimeline,
  getClosedCandlesForTimeframe,
} from './priceAction.ts';

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

interface TimeframeAssessment {
  timeframe: Timeframe;
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  bullScore: number;
  bearScore: number;
  structureEvent: string;
  rangeZone: 'Discount' | 'Equilibrium' | 'Premium';
  note: string;
  eqhCount: number;
  eqlCount: number;
  lastDisplacementDir: 'Bullish' | 'Bearish' | 'None';
  lastClosedClose: number;
}

function assessTimeframe(
  input: TimeframePriceActionInput,
  decimals: number
): TimeframeAssessment {
  const closed = getClosedCandlesForTimeframe(input.candles, input.timeframe);
  const lastClosedClose = closed[closed.length - 1]?.close ?? 0;
  const snap = input.analysis.snapshot;
  const timeline = extractHistoricalPriceActionTimeline(input.candles, decimals, {
    timeframe: input.timeframe,
  });

  let bullScore = 0;
  let bearScore = 0;

  if (snap.trendStructure === 'Bullish (HH / HL)') bullScore += 2;
  else if (snap.trendStructure === 'Bearish (LH / LL)') bearScore += 2;

  if (snap.latestStructureEvent.startsWith('Bullish')) bullScore += 2;
  else if (snap.latestStructureEvent.startsWith('Bearish')) bearScore += 2;

  if (snap.recentSweep === 'Sell-Side Sweep (Bullish)') bullScore += 2;
  else if (snap.recentSweep === 'Buy-Side Sweep (Bearish)') bearScore += 2;

  if (snap.buyerPressurePct >= 57) bullScore += 1;
  else if (snap.buyerPressurePct <= 43) bearScore += 1;

  const lastDisp =
    timeline.displacementEvents[timeline.displacementEvents.length - 1] ?? '';
  const lastDisplacementDir: TimeframeAssessment['lastDisplacementDir'] =
    lastDisp.includes('Bullish Displacement')
      ? 'Bullish'
      : lastDisp.includes('Bearish Displacement')
      ? 'Bearish'
      : 'None';

  if (lastDisplacementDir === 'Bullish') bullScore += 1;
  else if (lastDisplacementDir === 'Bearish') bearScore += 1;

  const bias: TimeframeAssessment['bias'] =
    bullScore >= bearScore + 2
      ? 'Bullish'
      : bearScore >= bullScore + 2
      ? 'Bearish'
      : 'Neutral';

  const eqhCount = timeline.equalLiquidityPools.filter((p) =>
    p.startsWith('EQH')
  ).length;
  const eqlCount = timeline.equalLiquidityPools.filter((p) =>
    p.startsWith('EQL')
  ).length;

  const parts: string[] = [];
  if (snap.recentSweep !== 'None') {
    parts.push(snap.recentSweep.replace(' (Bullish)', '').replace(' (Bearish)', ''));
  }
  if (lastDisplacementDir !== 'None') {
    parts.push(`${lastDisplacementDir} disp`);
  }
  if (snap.activeOrderBlockCount > 0 || snap.unmitigatedFvgCount > 0) {
    parts.push(`${snap.activeOrderBlockCount} OB/${snap.unmitigatedFvgCount} FVG`);
  }
  if (eqhCount > 0 || eqlCount > 0) {
    parts.push(`${eqhCount} EQH/${eqlCount} EQL`);
  }
  if (parts.length === 0) {
    parts.push(`${snap.rangePositionPct}% of range`);
  }

  return {
    timeframe: input.timeframe,
    bias,
    bullScore,
    bearScore,
    structureEvent: snap.latestStructureEvent,
    rangeZone: snap.rangeZone,
    note: parts.slice(0, 3).join(' · '),
    eqhCount,
    eqlCount,
    lastDisplacementDir,
    lastClosedClose,
  };
}

/**
 * 100% Free Forever, zero-API-key, strictly non-repainting closed-bar
 * multi-timeframe pure price-action signal synthesizer.
 */
export function generateLocalMtfSignal(params: {
  symbol: string;
  activeTimeframe: Timeframe;
  timeframesData: TimeframePriceActionInput[];
}): AIPriceActionSignal {
  const { symbol, activeTimeframe, timeframesData } = params;
  const instrument = getInstrumentBySymbol(symbol);
  const d = instrument.decimals;

  const order: Timeframe[] = ['4H', '1H', '15M', '5M', '1M'];
  const byTf = new Map<Timeframe, TimeframePriceActionInput>();
  for (const item of timeframesData) {
    byTf.set(item.timeframe, item);
  }

  const assessments: TimeframeAssessment[] = [];
  for (const tf of order) {
    const item = byTf.get(tf);
    if (item) assessments.push(assessTimeframe(item, d));
  }

  const getAssess = (tf: Timeframe) => assessments.find((a) => a.timeframe === tf);
  const a4h = getAssess('4H');
  const a1h = getAssess('1H');
  const a15m = getAssess('15M');
  const a5m = getAssess('5M');

  const m5Entry = byTf.get('5M') ?? byTf.get(activeTimeframe) ?? timeframesData[0];
  const m5Closed = getClosedCandlesForTimeframe(m5Entry.candles, '5M');
  const lastClosed = m5Closed[m5Closed.length - 1];
  const confirmedBarTime = lastClosed?.time ?? 0;
  const spotPrice = roundToDecimals(
    lastClosed?.close ?? instrument.basePrice,
    d
  );

  const m5Snap = m5Entry.analysis.snapshot;
  const avgRange = Math.max(m5Snap.avgCandleRange, spotPrice * 0.0005);

  // Higher-timeframe bias weights (4H=3, 1H=3, 15M=2)
  let htfBull = 0;
  let htfBear = 0;
  for (const [assess, weight] of [
    [a4h, 3],
    [a1h, 3],
    [a15m, 2],
  ] as const) {
    if (!assess) continue;
    if (assess.bias === 'Bullish') htfBull += weight;
    else if (assess.bias === 'Bearish') htfBear += weight;
  }

  const dominantBias: AIPriceActionSignal['bias'] =
    htfBull >= htfBear + 2
      ? 'Bullish'
      : htfBear >= htfBull + 2
      ? 'Bearish'
      : a5m?.bias ?? 'Neutral';

  const htfConflict =
    a4h &&
    a1h &&
    ((a4h.bias === 'Bullish' && a1h.bias === 'Bearish') ||
      (a4h.bias === 'Bearish' && a1h.bias === 'Bullish'));

  // Inspect 5M triggers & zones on closed bars
  const m5BullZones = m5Entry.analysis.zones.filter(
    (z) => z.kind === 'Demand OB' || z.kind === 'Bullish FVG'
  );
  const m5BearZones = m5Entry.analysis.zones.filter(
    (z) => z.kind === 'Supply OB' || z.kind === 'Bearish FVG'
  );

  const nearBullZone = m5BullZones.find(
    (z) =>
      spotPrice >= z.low - avgRange * 0.6 && spotPrice <= z.high + avgRange * 1.4
  );
  const nearBearZone = m5BearZones.find(
    (z) =>
      spotPrice <= z.high + avgRange * 0.6 && spotPrice >= z.low - avgRange * 1.4
  );

  const latestPattern = m5Snap.latestPattern;
  const hasBullPattern = latestPattern?.bias === 'Bullish';
  const hasBearPattern = latestPattern?.bias === 'Bearish';

  const bullConfirmations: string[] = [];
  if (m5Snap.recentSweep === 'Sell-Side Sweep (Bullish)' || a15m?.note.includes('Sell-Side Sweep')) {
    bullConfirmations.push('Closed-bar sell-side liquidity sweep reclaimed');
  }
  if (a5m?.lastDisplacementDir === 'Bullish') {
    bullConfirmations.push('5M closed-bar bullish displacement & momentum expansion');
  }
  if (hasBullPattern && latestPattern) {
    bullConfirmations.push(`5M ${latestPattern.name} trigger`);
  }
  if (nearBullZone) {
    bullConfirmations.push(
      `Price mitigating 5M ${nearBullZone.kind} (${nearBullZone.low.toFixed(d)}-${nearBullZone.high.toFixed(d)})`
    );
  }
  if (m5Snap.latestStructureEvent.startsWith('Bullish')) {
    bullConfirmations.push(`5M ${m5Snap.latestStructureEvent} confirmed`);
  }

  const bearConfirmations: string[] = [];
  if (m5Snap.recentSweep === 'Buy-Side Sweep (Bearish)' || a15m?.note.includes('Buy-Side Sweep')) {
    bearConfirmations.push('Closed-bar buy-side liquidity sweep rejected');
  }
  if (a5m?.lastDisplacementDir === 'Bearish') {
    bearConfirmations.push('5M closed-bar bearish displacement & momentum expansion');
  }
  if (hasBearPattern && latestPattern) {
    bearConfirmations.push(`5M ${latestPattern.name} trigger`);
  }
  if (nearBearZone) {
    bearConfirmations.push(
      `Price mitigating 5M ${nearBearZone.kind} (${nearBearZone.low.toFixed(d)}-${nearBearZone.high.toFixed(d)})`
    );
  }
  if (m5Snap.latestStructureEvent.startsWith('Bearish')) {
    bearConfirmations.push(`5M ${m5Snap.latestStructureEvent} confirmed`);
  }

  let signalAction: 'BUY' | 'SELL' | 'WAIT' = 'WAIT';
  let signalStrength: 'A+ Setup' | 'Standard' | 'Developing' = 'Developing';
  let setupType = '5M HTF Alignment Watch';
  let triggerPattern = latestPattern?.name ?? 'Awaiting 5M closed-bar confirmation';
  let confluences: string[] = [];

  const inDiscount = m5Snap.rangePositionPct <= 45 || Boolean(nearBullZone && m5Snap.rangePositionPct <= 52);
  const inPremium = m5Snap.rangePositionPct >= 55 || Boolean(nearBearZone && m5Snap.rangePositionPct >= 48);

  if (
    !htfConflict &&
    dominantBias === 'Bullish' &&
    inDiscount &&
    bullConfirmations.length >= 2
  ) {
    signalAction = 'BUY';
    signalStrength = bullConfirmations.length >= 3 ? 'A+ Setup' : 'Standard';
    setupType = nearBullZone
      ? `HTF Bullish + 5M ${nearBullZone.kind} Mitigation`
      : 'HTF Bullish + 5M Sell-Side Sweep Reclaim';
    triggerPattern = hasBullPattern && latestPattern
      ? latestPattern.name
      : '5M Bullish Displacement + Structure Shift';
    confluences = [
      `4H/1H/15M HTF alignment (${a4h?.bias ?? 'Neutral'} / ${a1h?.bias ?? 'Neutral'} / ${a15m?.bias ?? 'Neutral'})`,
      `5M in ${m5Snap.rangeZone} (${m5Snap.rangePositionPct}% of dealing range)`,
      ...bullConfirmations.slice(0, 2),
    ];
  } else if (
    !htfConflict &&
    dominantBias === 'Bearish' &&
    inPremium &&
    bearConfirmations.length >= 2
  ) {
    signalAction = 'SELL';
    signalStrength = bearConfirmations.length >= 3 ? 'A+ Setup' : 'Standard';
    setupType = nearBearZone
      ? `HTF Bearish + 5M ${nearBearZone.kind} Mitigation`
      : 'HTF Bearish + 5M Buy-Side Sweep Rejection';
    triggerPattern = hasBearPattern && latestPattern
      ? latestPattern.name
      : '5M Bearish Displacement + Structure Shift';
    confluences = [
      `4H/1H/15M HTF alignment (${a4h?.bias ?? 'Neutral'} / ${a1h?.bias ?? 'Neutral'} / ${a15m?.bias ?? 'Neutral'})`,
      `5M in ${m5Snap.rangeZone} (${m5Snap.rangePositionPct}% of dealing range)`,
      ...bearConfirmations.slice(0, 2),
    ];
  } else {
    // WAIT with clear conditional watch plan
    const isBullWatch = dominantBias !== 'Bearish';
    setupType = htfConflict
      ? 'WAIT — HTF 4H/1H Structure Conflict'
      : isBullWatch
      ? 'WAIT — Watch 5M Discount / Demand OB Entry'
      : 'WAIT — Watch 5M Premium / Supply OB Entry';
    triggerPattern = isBullWatch
      ? 'Wait for closed 5M sweep + Bullish Engulfing / Displacement in Discount'
      : 'Wait for closed 5M sweep + Bearish Engulfing / Displacement in Premium';
    confluences = [
      `4H: ${a4h?.bias ?? 'Neutral'} (${a4h?.structureEvent ?? 'Range'}) · 1H: ${a1h?.bias ?? 'Neutral'}`,
      `5M currently at ${m5Snap.rangePositionPct}% (${m5Snap.rangeZone}) · Buyer pressure ${m5Snap.buyerPressurePct}%`,
      ...(isBullWatch ? bullConfirmations : bearConfirmations).slice(0, 2),
    ];
  }

  // Calibrate realistic 5M Entry / SL / TP1 / TP2
  const planBullish =
    signalAction === 'BUY' ||
    (signalAction === 'WAIT' && dominantBias !== 'Bearish');

  let entryPrice = spotPrice;
  let entryZone = `${roundToDecimals(spotPrice - avgRange * 0.3, d).toFixed(d)}-${roundToDecimals(spotPrice + avgRange * 0.3, d).toFixed(d)}`;
  let stopLoss: number;
  let takeProfit1: number;
  let takeProfit2: number;

  if (planBullish) {
    if (signalAction === 'WAIT' && m5BullZones.length > 0) {
      const targetZone = nearBullZone ?? m5BullZones[0];
      entryPrice = roundToDecimals(
        Math.min(spotPrice, targetZone.midpoint),
        d
      );
      entryZone = `${targetZone.low.toFixed(d)}-${targetZone.high.toFixed(d)}`;
      stopLoss = roundToDecimals(targetZone.low - avgRange * 0.85, d);
    } else {
      const recentLow = Math.min(
        ...m5Closed.slice(-8).map((c) => c.low),
        nearBullZone?.low ?? spotPrice
      );
      const rawRisk = Math.max(
        avgRange * 1.4,
        Math.min(avgRange * 3.8, spotPrice - recentLow + avgRange * 0.5)
      );
      stopLoss = roundToDecimals(entryPrice - rawRisk, d);
    }

    const risk = Math.max(entryPrice - stopLoss, avgRange * 1.2);
    stopLoss = roundToDecimals(entryPrice - risk, d);
    const structuralHighTarget = Math.max(
      m5Snap.dealingRangeHigh,
      entryPrice + risk * 2.5
    );
    takeProfit1 = roundToDecimals(
      Math.max(entryPrice + risk * 1.6, m5Snap.equilibriumPrice + avgRange * 0.5),
      d
    );
    if (takeProfit1 <= entryPrice) {
      takeProfit1 = roundToDecimals(entryPrice + risk * 1.6, d);
    }
    takeProfit2 = roundToDecimals(
      Math.max(takeProfit1 + risk * 0.9, structuralHighTarget),
      d
    );
  } else {
    if (signalAction === 'WAIT' && m5BearZones.length > 0) {
      const targetZone = nearBearZone ?? m5BearZones[0];
      entryPrice = roundToDecimals(
        Math.max(spotPrice, targetZone.midpoint),
        d
      );
      entryZone = `${targetZone.low.toFixed(d)}-${targetZone.high.toFixed(d)}`;
      stopLoss = roundToDecimals(targetZone.high + avgRange * 0.85, d);
    } else {
      const recentHigh = Math.max(
        ...m5Closed.slice(-8).map((c) => c.high),
        nearBearZone?.high ?? spotPrice
      );
      const rawRisk = Math.max(
        avgRange * 1.4,
        Math.min(avgRange * 3.8, recentHigh - spotPrice + avgRange * 0.5)
      );
      stopLoss = roundToDecimals(entryPrice + rawRisk, d);
    }

    const risk = Math.max(stopLoss - entryPrice, avgRange * 1.2);
    stopLoss = roundToDecimals(entryPrice + risk, d);
    const structuralLowTarget = Math.min(
      m5Snap.dealingRangeLow,
      entryPrice - risk * 2.5
    );
    takeProfit1 = roundToDecimals(
      Math.min(entryPrice - risk * 1.6, m5Snap.equilibriumPrice - avgRange * 0.5),
      d
    );
    if (takeProfit1 >= entryPrice) {
      takeProfit1 = roundToDecimals(entryPrice - risk * 1.6, d);
    }
    takeProfit2 = roundToDecimals(
      Math.min(takeProfit1 - risk * 0.9, structuralLowTarget),
      d
    );
  }

  const riskDist = Math.max(Math.abs(entryPrice - stopLoss), 1e-9);
  const rrVal = Math.abs(takeProfit2 - entryPrice) / riskDist;
  const riskRewardRatio = `1 : ${rrVal.toFixed(1)}`;

  const invalidationReason = planBullish
    ? `5M candle close below ${stopLoss.toFixed(d)} invalidates demand structure.`
    : `5M candle close above ${stopLoss.toFixed(d)} invalidates supply structure.`;

  const priceActionNarrative =
    signalAction === 'WAIT'
      ? `Closed-bar 4H (${a4h?.bias ?? 'Neutral'}) and 1H (${a1h?.bias ?? 'Neutral'}) context puts 5M at ${m5Snap.rangePositionPct}% (${m5Snap.rangeZone}) near ${spotPrice.toFixed(d)}. Waiting for a closed-bar 5M ${planBullish ? 'sell-side sweep & bullish displacement into discount' : 'buy-side sweep & bearish displacement into premium'} near ${entryPrice.toFixed(d)} before entry.`
      : `Top-down closed-bar structure aligns ${dominantBias} across HTF (4H ${a4h?.structureEvent ?? 'Range'} / 1H ${a1h?.structureEvent ?? 'Range'}) while 5M sits in ${m5Snap.rangeZone} (${m5Snap.rangePositionPct}%). ${bullConfirmations[0] || bearConfirmations[0] || 'Closed-bar 5M displacement'} confirms ${signalAction} execution toward ${takeProfit1.toFixed(d)} and ${takeProfit2.toFixed(d)}.`;

  const topLevels = m5Entry.analysis.levels
    .slice(0, 3)
    .map((l) => `${l.type} @ ${l.price.toFixed(d)}`)
    .join(', ');
  const topZones = m5Entry.analysis.zones
    .slice(0, 3)
    .map((z) => `${z.kind} [${z.low.toFixed(d)}-${z.high.toFixed(d)}]`)
    .join(', ');
  const keyZonesExplanation = `${topZones ? `Active 5M zones: ${topZones}. ` : ''}${topLevels ? `Key S/R liquidity levels: ${topLevels}.` : 'Monitor 5M dealing range extremes for liquidity sweeps.'}`;

  const timeframeAlignment: TimeframeAlignmentItem[] = assessments.map((a) => ({
    timeframe: a.timeframe,
    bias: a.bias,
    structureEvent: a.structureEvent,
    rangeZone: a.rangeZone,
    note: a.note,
  }));

  return {
    id: `sig-${instrument.symbol.replace('/', '')}-${confirmedBarTime || Date.now()}`,
    symbol: instrument.symbol,
    timeframe: activeTimeframe,
    signalTimeframe: '5M',
    analyzedAt: new Date().toISOString(),
    confirmedBarTime,
    confirmedBarCloseTime: confirmedBarTime > 0 ? confirmedBarTime + 300 : 0,
    isLockedToClosedBar: true,
    model: 'Local MTF (Free Forever)',
    spotPriceAtSignal: spotPrice,
    bias: dominantBias,
    priceActionNarrative,
    keyZonesExplanation,
    timeframeAlignment,
    plan: {
      signal: signalAction,
      signalStrength,
      setupType,
      triggerPattern,
      entryPrice,
      entryZone,
      stopLoss,
      takeProfit1,
      takeProfit2,
      riskRewardRatio,
      invalidationReason,
      confluences: confluences.slice(0, 4),
    },
  };
}

/**
 * 100% Free Forever pure price-action backtest audit when cloud LLM quotas are unavailable.
 */
export function generateLocalBacktestReview(
  backtest: BacktestResult
): AIBacktestReview {
  const verdict: AIBacktestReview['verdict'] =
    backtest.profitFactor >= 1.5 && backtest.expectancyR > 0.25
      ? 'Strong Edge'
      : backtest.profitFactor >= 1.1 && backtest.expectancyR > 0
      ? 'Moderate Edge'
      : 'Needs Filtering';

  const sortedSetups = [...backtest.setupBreakdown].sort(
    (a, b) => b.netR - a.netR
  );
  const bestSetup = sortedSetups[0];
  const worstSetup = sortedSetups[sortedSetups.length - 1];

  const bestPerformingPattern = bestSetup
    ? `${bestSetup.setupType} (${bestSetup.netR >= 0 ? '+' : ''}${bestSetup.netR.toFixed(2)}R across ${bestSetup.trades} trades, ${bestSetup.winRatePct.toFixed(0)}% WR)`
    : 'Insufficient closed trades';

  const keyWeakness =
    backtest.maxDrawdownPct > 10
      ? `Peak drawdown reached ${backtest.maxDrawdownPct.toFixed(1)}% with ${backtest.losses} stop-outs${worstSetup && worstSetup.netR < 0 ? `, led by ${worstSetup.setupType} (${worstSetup.netR.toFixed(2)}R)` : ''}.`
      : worstSetup && worstSetup.netR < 0
      ? `${worstSetup.setupType} dragged expectancy (${worstSetup.netR.toFixed(2)}R net across ${worstSetup.trades} trades).`
      : 'Low trade sample size or breakeven clustering after TP1.';

  const summary = `Across ${backtest.barsTested} causal non-repainting ${backtest.timeframe} bars on ${backtest.symbol}, ${backtest.totalTrades} trades yielded a ${backtest.winRatePct.toFixed(1)}% win rate, ${backtest.profitFactor.toFixed(2)} profit factor, and ${backtest.expectancyR >= 0 ? '+' : ''}${backtest.expectancyR.toFixed(2)}R expectancy (${backtest.netReturnPct >= 0 ? '+' : ''}${backtest.netReturnPct.toFixed(2)}% net return).`;

  const recommendations = [
    'Restrict executions strictly to setups aligned with confirmed 4H/1H swing structure and opposing EQH/EQL liquidity targets.',
    'Require a closed-bar 5M displacement candle following any liquidity sweep before placing next-bar Open entries.',
    'Skip mid-range equilibrium entries (42%–58% of dealing range) and prioritize fresh unmitigated Demand/Supply Order Blocks.',
  ];

  return {
    model: 'Local Audit (Free Forever)',
    reviewedAt: new Date().toISOString(),
    verdict,
    summary,
    bestPerformingPattern,
    keyWeakness,
    recommendations,
  };
}
