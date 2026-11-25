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

  // Strict 4H / 1H / 15M higher-timeframe consensus (zero conflict allowed for Sniper entries)
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

  const htfConflict =
    (a4h &&
      a1h &&
      ((a4h.bias === 'Bullish' && a1h.bias === 'Bearish') ||
        (a4h.bias === 'Bearish' && a1h.bias === 'Bullish'))) ||
    (a1h &&
      a15m &&
      ((a1h.bias === 'Bullish' && a15m.bias === 'Bearish') ||
        (a1h.bias === 'Bearish' && a15m.bias === 'Bullish')));

  const dominantBias: AIPriceActionSignal['bias'] =
    htfBull >= htfBear + 3
      ? 'Bullish'
      : htfBear >= htfBull + 3
      ? 'Bearish'
      : 'Neutral';

  // Inspect 5M triggers & zones on closed bars
  const m5BullZones = m5Entry.analysis.zones.filter(
    (z) => z.kind === 'Demand OB' || z.kind === 'Bullish FVG'
  );
  const m5BearZones = m5Entry.analysis.zones.filter(
    (z) => z.kind === 'Supply OB' || z.kind === 'Bearish FVG'
  );

  const nearBullZone = m5BullZones.find(
    (z) =>
      spotPrice >= z.low - avgRange * 0.45 && spotPrice <= z.high + avgRange * 1.05
  );
  const nearBearZone = m5BearZones.find(
    (z) =>
      spotPrice <= z.high + avgRange * 0.45 && spotPrice >= z.low - avgRange * 1.05
  );

  const latestPattern = m5Snap.latestPattern;
  const hasBullPattern = latestPattern?.bias === 'Bullish';
  const hasBearPattern = latestPattern?.bias === 'Bearish';

  const bullSweepConfirmed =
    m5Snap.recentSweep === 'Sell-Side Sweep (Bullish)' ||
    Boolean(a15m?.note.includes('Sell-Side Sweep'));
  const bearSweepConfirmed =
    m5Snap.recentSweep === 'Buy-Side Sweep (Bearish)' ||
    Boolean(a15m?.note.includes('Buy-Side Sweep'));

  const bullDisplacement = a5m?.lastDisplacementDir === 'Bullish';
  const bearDisplacement = a5m?.lastDisplacementDir === 'Bearish';

  const bullConfirmations: string[] = [];
  if (bullSweepConfirmed) {
    bullConfirmations.push('Closed-bar sell-side liquidity sweep reclaimed');
  }
  if (bullDisplacement) {
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
  if (bearSweepConfirmed) {
    bearConfirmations.push('Closed-bar buy-side liquidity sweep rejected');
  }
  if (bearDisplacement) {
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

  const closedBarRange = lastClosed
    ? Math.max(lastClosed.high - lastClosed.low, 1e-9)
    : 1;
  const bullClosedBar = Boolean(
    lastClosed &&
      lastClosed.close > lastClosed.open &&
      (lastClosed.close - lastClosed.low) / closedBarRange >= 0.45
  );
  const bearClosedBar = Boolean(
    lastClosed &&
      lastClosed.close < lastClosed.open &&
      (lastClosed.high - lastClosed.close) / closedBarRange >= 0.45
  );

  // Strict OTE Discount / Premium Zones for Sniper Entries Only
  const inSniperDiscount =
    m5Snap.rangePositionPct <= 40 ||
    Boolean(nearBullZone && m5Snap.rangePositionPct <= 44);
  const inSniperPremium =
    m5Snap.rangePositionPct >= 60 ||
    Boolean(nearBearZone && m5Snap.rangePositionPct >= 56);

  const bullSniperTrigger =
    bullClosedBar &&
    (bullSweepConfirmed || Boolean(nearBullZone)) &&
    (bullDisplacement || hasBullPattern) &&
    bullConfirmations.length >= 3;

  const bearSniperTrigger =
    bearClosedBar &&
    (bearSweepConfirmed || Boolean(nearBearZone)) &&
    (bearDisplacement || hasBearPattern) &&
    bearConfirmations.length >= 3;

  let signalAction: 'BUY' | 'SELL' | 'WAIT' = 'WAIT';
  let signalStrength: 'A+ Setup' | 'Standard' | 'Developing' = 'Developing';
  let setupType = 'WAIT — No Sniper Setup (Stay Flat)';
  let triggerPattern = latestPattern?.name ?? 'Awaiting closed 5M sniper trigger';
  let confluences: string[] = [];

  if (
    !htfConflict &&
    dominantBias === 'Bullish' &&
    inSniperDiscount &&
    bullSniperTrigger
  ) {
    signalAction = 'BUY';
    signalStrength = 'A+ Setup';
    setupType = nearBullZone
      ? `Sniper HTF Bullish + 5M ${nearBullZone.kind} Mitigation`
      : 'Sniper HTF Bullish + 5M Sell-Side Sweep Displacement';
    triggerPattern = hasBullPattern && latestPattern
      ? latestPattern.name
      : '5M Sweep + Bullish Displacement BOS';
    confluences = [
      `4H/1H/15M HTF consensus (${a4h?.bias ?? 'Neutral'} / ${a1h?.bias ?? 'Neutral'} / ${a15m?.bias ?? 'Neutral'})`,
      `5M OTE Discount (${m5Snap.rangePositionPct}% of dealing range)`,
      ...bullConfirmations.slice(0, 2),
    ];
  } else if (
    !htfConflict &&
    dominantBias === 'Bearish' &&
    inSniperPremium &&
    bearSniperTrigger
  ) {
    signalAction = 'SELL';
    signalStrength = 'A+ Setup';
    setupType = nearBearZone
      ? `Sniper HTF Bearish + 5M ${nearBearZone.kind} Mitigation`
      : 'Sniper HTF Bearish + 5M Buy-Side Sweep Displacement';
    triggerPattern = hasBearPattern && latestPattern
      ? latestPattern.name
      : '5M Sweep + Bearish Displacement BOS';
    confluences = [
      `4H/1H/15M HTF consensus (${a4h?.bias ?? 'Neutral'} / ${a1h?.bias ?? 'Neutral'} / ${a15m?.bias ?? 'Neutral'})`,
      `5M OTE Premium (${m5Snap.rangePositionPct}% of dealing range)`,
      ...bearConfirmations.slice(0, 2),
    ];
  } else {
    const isBullWatch = dominantBias !== 'Bearish';
    setupType = htfConflict
      ? 'WAIT — HTF Conflict (No Sniper)'
      : dominantBias === 'Neutral'
      ? 'WAIT — Neutral HTF (Stay Flat)'
      : isBullWatch
      ? 'WAIT — Watch 5M Deep Discount Sniper Zone'
      : 'WAIT — Watch 5M Deep Premium Sniper Zone';
    triggerPattern = isBullWatch
      ? 'Need closed 5M sell-side sweep + displacement in Discount (<=40%)'
      : 'Need closed 5M buy-side sweep + displacement in Premium (>=60%)';
    confluences = [
      `4H: ${a4h?.bias ?? 'Neutral'} (${a4h?.structureEvent ?? 'Range'}) · 1H: ${a1h?.bias ?? 'Neutral'}`,
      `5M range ${m5Snap.rangePositionPct}% (${m5Snap.rangeZone}) · Need >=3 sniper confluences`,
      ...(isBullWatch ? bullConfirmations : bearConfirmations).slice(0, 2),
    ];
  }

  // Calibrate tight institutional 5M Sniper Entry / SL / TP1 / TP2
  const planBullish =
    signalAction === 'BUY' ||
    (signalAction === 'WAIT' && dominantBias !== 'Bearish');

  let entryPrice = spotPrice;
  let entryZone = `${roundToDecimals(spotPrice - avgRange * 0.25, d).toFixed(d)}-${roundToDecimals(spotPrice + avgRange * 0.25, d).toFixed(d)}`;
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
      stopLoss = roundToDecimals(targetZone.low - avgRange * 0.65, d);
    } else {
      const recentLow = Math.min(
        ...m5Closed.slice(-6).map((c) => c.low),
        nearBullZone?.low ?? spotPrice
      );
      const rawRisk = Math.max(
        avgRange * 1.15,
        Math.min(avgRange * 3.0, spotPrice - recentLow + avgRange * 0.35)
      );
      stopLoss = roundToDecimals(entryPrice - rawRisk, d);
    }

    const risk = Math.max(entryPrice - stopLoss, avgRange * 1.05);
    stopLoss = roundToDecimals(entryPrice - risk, d);
    const structuralHighTarget = Math.max(
      m5Snap.dealingRangeHigh,
      entryPrice + risk * 2.6
    );
    takeProfit1 = roundToDecimals(
      Math.max(entryPrice + risk * 1.6, m5Snap.equilibriumPrice + avgRange * 0.4),
      d
    );
    if (takeProfit1 <= entryPrice) {
      takeProfit1 = roundToDecimals(entryPrice + risk * 1.6, d);
    }
    takeProfit2 = roundToDecimals(
      Math.max(takeProfit1 + risk * 1.0, structuralHighTarget),
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
      stopLoss = roundToDecimals(targetZone.high + avgRange * 0.65, d);
    } else {
      const recentHigh = Math.max(
        ...m5Closed.slice(-6).map((c) => c.high),
        nearBearZone?.high ?? spotPrice
      );
      const rawRisk = Math.max(
        avgRange * 1.15,
        Math.min(avgRange * 3.0, recentHigh - spotPrice + avgRange * 0.35)
      );
      stopLoss = roundToDecimals(entryPrice + rawRisk, d);
    }

    const risk = Math.max(stopLoss - entryPrice, avgRange * 1.05);
    stopLoss = roundToDecimals(entryPrice + risk, d);
    const structuralLowTarget = Math.min(
      m5Snap.dealingRangeLow,
      entryPrice - risk * 2.6
    );
    takeProfit1 = roundToDecimals(
      Math.min(entryPrice - risk * 1.6, m5Snap.equilibriumPrice - avgRange * 0.4),
      d
    );
    if (takeProfit1 >= entryPrice) {
      takeProfit1 = roundToDecimals(entryPrice - risk * 1.6, d);
    }
    takeProfit2 = roundToDecimals(
      Math.min(takeProfit1 - risk * 1.0, structuralLowTarget),
      d
    );
  }

  const riskDist = Math.max(Math.abs(entryPrice - stopLoss), 1e-9);
  const rrVal = Math.abs(takeProfit2 - entryPrice) / riskDist;

  // Enforce >= 1:2.4 Sniper R:R threshold (never accept low-R:R trades)
  if (signalAction !== 'WAIT' && rrVal < 2.4) {
    signalAction = 'WAIT';
    signalStrength = 'Developing';
    setupType = 'WAIT — R:R Below 1:2.4 Sniper Minimum';
    triggerPattern = 'Insufficient opposing liquidity room for sniper entry';
  }

  const riskRewardRatio = `1 : ${rrVal.toFixed(1)}`;

  const invalidationReason = planBullish
    ? `5M candle close below ${stopLoss.toFixed(d)} invalidates demand structure.`
    : `5M candle close above ${stopLoss.toFixed(d)} invalidates supply structure.`;

  const priceActionNarrative =
    signalAction === 'WAIT'
      ? `Closed-bar 4H (${a4h?.bias ?? 'Neutral'}) and 1H (${a1h?.bias ?? 'Neutral'}) scan puts 5M at ${m5Snap.rangePositionPct}% (${m5Snap.rangeZone}) near ${spotPrice.toFixed(d)}. No A+ sniper entry yet—stay flat until price reaches ${entryPrice.toFixed(d)} and closes a confirmed ${planBullish ? 'sell-side sweep + bullish displacement' : 'buy-side sweep + bearish displacement'}.`
      : `A+ Sniper confirmed strictly on closed bars: 4H/1H/15M align ${dominantBias} while 5M sits in ${m5Snap.rangeZone} (${m5Snap.rangePositionPct}%). ${bullConfirmations[0] || bearConfirmations[0] || 'Closed-bar 5M displacement'} locks ${signalAction} execution at ${entryPrice.toFixed(d)} targeting ${takeProfit1.toFixed(d)} and ${takeProfit2.toFixed(d)} (${riskRewardRatio}).`;

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
    model: 'Local Sniper MTF (Free Forever)',
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
 * Deterministic post-gatekeeper applied to LLM outputs (Gemini/Groq) so weak,
 * Standard, low-R:R, or HTF-conflicting calls are blocked cleanly into WAIT.
 */
export function enforceSniperDiscipline(params: {
  signal: AIPriceActionSignal;
  timeframesData: TimeframePriceActionInput[];
}): AIPriceActionSignal {
  const { signal, timeframesData } = params;
  if (signal.plan.signal === 'WAIT') {
    return signal;
  }

  const { plan } = signal;
  const isBuy = plan.signal === 'BUY';
  const entry = plan.entryPrice > 0 ? plan.entryPrice : signal.spotPriceAtSignal;
  const sl = plan.stopLoss;
  const tp1 = plan.takeProfit1;
  const tp2 = plan.takeProfit2;

  const validGeometry = isBuy
    ? sl > 0 && sl < entry && tp1 > entry && tp2 > tp1
    : sl > 0 && sl > entry && tp1 < entry && tp2 < tp1;

  const risk = Math.abs(entry - sl);
  const reward2 = Math.abs(tp2 - entry);
  const rr = risk > 0 ? reward2 / risk : 0;

  const byTf = new Map(timeframesData.map((t) => [t.timeframe, t]));
  const d = getInstrumentBySymbol(signal.symbol).decimals;
  const a4h = byTf.get('4H') ? assessTimeframe(byTf.get('4H')!, d) : null;
  const a1h = byTf.get('1H') ? assessTimeframe(byTf.get('1H')!, d) : null;
  const m5Entry = byTf.get('5M');
  const m5Closed = m5Entry
    ? getClosedCandlesForTimeframe(m5Entry.candles, '5M')
    : [];
  const lastClosedM5 = m5Closed[m5Closed.length - 1];
  const m5Snap = m5Entry?.analysis.snapshot;

  const htfOpposes =
    (isBuy && (a4h?.bias === 'Bearish' || a1h?.bias === 'Bearish')) ||
    (!isBuy && (a4h?.bias === 'Bullish' || a1h?.bias === 'Bullish'));

  const wrongSideOfRange =
    m5Snap &&
    ((isBuy && m5Snap.rangePositionPct > 50) ||
      (!isBuy && m5Snap.rangePositionPct < 50));

  const wrongCandleDirection =
    lastClosedM5 &&
    ((isBuy && lastClosedM5.close <= lastClosedM5.open) ||
      (!isBuy && lastClosedM5.close >= lastClosedM5.open));

  const weakQuality =
    plan.signalStrength !== 'A+ Setup' || plan.confluences.length < 3;

  if (
    !validGeometry ||
    rr < 2.2 ||
    htfOpposes ||
    wrongSideOfRange ||
    wrongCandleDirection ||
    weakQuality
  ) {
    const localStrict = generateLocalMtfSignal({
      symbol: signal.symbol,
      activeTimeframe: signal.timeframe,
      timeframesData,
    });
    if (localStrict.plan.signal === 'WAIT') {
      return {
        ...localStrict,
        model: `${signal.model} · Sniper Filtered`,
      };
    }
    return {
      ...localStrict,
      model: `${signal.model} · Sniper Calibrated`,
    };
  }

  return signal;
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
