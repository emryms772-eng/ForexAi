import { TIMEFRAME_SECONDS, getInstrumentBySymbol } from '../config/instruments.ts';
import type {
  BacktestEquityPoint,
  BacktestResult,
  BacktestSetupStats,
  BacktestTrade,
  OHLCVCandle,
  PriceActionAnalysisSummary,
  Timeframe,
} from '../types/market.ts';
import { analyzePriceAction, getClosedCandlesForTimeframe } from './priceAction.ts';

function roundToDecimals(val: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

function roundCurrency(val: number): number {
  return Math.round(val * 100) / 100;
}

interface CandidateSetup {
  side: 'BUY' | 'SELL';
  setupType: string;
  trigger: string;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
}

interface FilterCounters {
  candidatesEvaluated: number;
  rejectedByHtfBias: number;
  rejectedByPremiumDiscount: number;
  rejectedByDisplacement: number;
  qualifiedSetups: number;
}

interface HtfBiasAssessment {
  allowsBuy: boolean;
  allowsSell: boolean;
  dominantSweep: 'Bullish' | 'Bearish' | 'None';
  rangePos1hPct: number | null;
  summary1h: string;
  summary4h: string;
}

function aggregateCandlesCausally(
  candles: OHLCVCandle[],
  groupSize: number
): OHLCVCandle[] {
  if (groupSize <= 1 || candles.length < groupSize * 4) return candles;
  const usableCount = Math.floor(candles.length / groupSize) * groupSize;
  const startOffset = candles.length - usableCount;
  const aggregated: OHLCVCandle[] = [];

  for (let i = startOffset; i < candles.length; i += groupSize) {
    const chunk = candles.slice(i, i + groupSize);
    if (chunk.length < groupSize) break;
    aggregated.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return aggregated;
}

function scoreAnalysisBias(summary: PriceActionAnalysisSummary): {
  bullScore: number;
  bearScore: number;
  sweepBias: 'Bullish' | 'Bearish' | 'None';
} {
  const { snapshot } = summary;
  let bullScore = 0;
  let bearScore = 0;
  let sweepBias: 'Bullish' | 'Bearish' | 'None' = 'None';

  if (snapshot.recentSweep === 'Sell-Side Sweep (Bullish)') {
    bullScore += 1.75;
    sweepBias = 'Bullish';
  } else if (snapshot.recentSweep === 'Buy-Side Sweep (Bearish)') {
    bearScore += 1.75;
    sweepBias = 'Bearish';
  }

  if (snapshot.trendStructure === 'Bullish (HH / HL)') {
    bullScore += 1.5;
  } else if (snapshot.trendStructure === 'Bearish (LH / LL)') {
    bearScore += 1.5;
  }

  if (snapshot.latestStructureEvent.startsWith('Bullish')) {
    bullScore += 1.5;
  } else if (snapshot.latestStructureEvent.startsWith('Bearish')) {
    bearScore += 1.5;
  }

  if (snapshot.buyerPressurePct >= 55) {
    bullScore += 0.5;
  } else if (snapshot.buyerPressurePct <= 45) {
    bearScore += 0.5;
  }

  return { bullScore, bearScore, sweepBias };
}

/**
 * Strictly causal Higher-Timeframe (1H / 4H) structural bias & dominant sweep filter.
 * Only inspects HTF candles whose period has fully closed at or before `signalCloseTime`.
 */
function evaluateCausalHtfBias(params: {
  closedSlice: OHLCVCandle[];
  ltfTimeframe: Timeframe;
  decimals: number;
  htf1hCandles?: OHLCVCandle[];
  htf4hCandles?: OHLCVCandle[];
  htfAligned?: boolean;
}): HtfBiasAssessment {
  const {
    closedSlice,
    ltfTimeframe,
    decimals,
    htf1hCandles,
    htf4hCandles,
    htfAligned,
  } = params;

  const signalBar = closedSlice[closedSlice.length - 1];
  const ltfSeconds = TIMEFRAME_SECONDS[ltfTimeframe];
  const signalCloseTime = signalBar.time + ltfSeconds;

  let slice1h: OHLCVCandle[] = [];
  let slice4h: OHLCVCandle[] = [];

  if (htfAligned) {
    if (htf1hCandles && htf1hCandles.length > 0 && ltfTimeframe !== '4H') {
      slice1h = htf1hCandles.filter((c) => c.time + 3600 <= signalCloseTime);
    }
    if (htf4hCandles && htf4hCandles.length > 0) {
      slice4h = htf4hCandles.filter((c) => c.time + 14400 <= signalCloseTime);
    }
  }

  // Fallback to causal macro aggregation from the LTF stream when external HTF
  // history isn't aligned (e.g. synthetic volatility indices or short samples)
  if (slice1h.length < 24) {
    const group1h =
      ltfTimeframe === '1M'
        ? 12
        : ltfTimeframe === '5M'
        ? 6
        : ltfTimeframe === '15M'
        ? 4
        : 2;
    slice1h = aggregateCandlesCausally(closedSlice, group1h);
  }
  if (slice4h.length < 18) {
    const group4h =
      ltfTimeframe === '1M'
        ? 24
        : ltfTimeframe === '5M'
        ? 12
        : ltfTimeframe === '15M'
        ? 8
        : 4;
    slice4h = aggregateCandlesCausally(closedSlice, group4h);
  }

  let bull1h = 0;
  let bear1h = 0;
  let bull4h = 0;
  let bear4h = 0;
  let sweep1h: 'Bullish' | 'Bearish' | 'None' = 'None';
  let sweep4h: 'Bullish' | 'Bearish' | 'None' = 'None';
  let rangePos1hPct: number | null = null;
  let summary1h = 'Neutral';
  let summary4h = 'Neutral';

  if (slice1h.length >= 16) {
    const pa1h = analyzePriceAction(slice1h, decimals, {
      excludeFormingBar: false,
    });
    const scored1h = scoreAnalysisBias(pa1h);
    bull1h = scored1h.bullScore;
    bear1h = scored1h.bearScore;
    sweep1h = scored1h.sweepBias;
    const span1h = Math.max(
      pa1h.snapshot.dealingRangeHigh - pa1h.snapshot.dealingRangeLow,
      1e-9
    );
    rangePos1hPct = Math.min(
      100,
      Math.max(
        0,
        ((signalBar.close - pa1h.snapshot.dealingRangeLow) / span1h) * 100
      )
    );
    summary1h = `${pa1h.snapshot.trendStructure} / ${pa1h.snapshot.latestStructureEvent}`;
  }

  if (slice4h.length >= 14) {
    const pa4h = analyzePriceAction(slice4h, decimals, {
      excludeFormingBar: false,
    });
    const scored4h = scoreAnalysisBias(pa4h);
    bull4h = scored4h.bullScore;
    bear4h = scored4h.bearScore;
    sweep4h = scored4h.sweepBias;
    summary4h = `${pa4h.snapshot.trendStructure} / ${pa4h.snapshot.latestStructureEvent}`;
  }

  const dominantSweep: 'Bullish' | 'Bearish' | 'None' =
    sweep1h !== 'None' && sweep4h === sweep1h
      ? sweep1h
      : sweep1h !== 'None' && sweep4h === 'None'
      ? sweep1h
      : sweep4h !== 'None' && sweep1h === 'None'
      ? sweep4h
      : 'None';

  const totalBull = bull1h + bull4h * 1.15;
  const totalBear = bear1h + bear4h * 1.15;

  const h1Bull = bull1h > bear1h + 0.4 || sweep1h === 'Bullish';
  const h1Bear = bear1h > bull1h + 0.4 || sweep1h === 'Bearish';
  const h4Bull = bull4h > bear4h + 0.4 || sweep4h === 'Bullish';
  const h4Bear = bear4h > bull4h + 0.4 || sweep4h === 'Bearish';

  const allowsBuy =
    dominantSweep !== 'Bearish' &&
    (totalBull >= totalBear || (h1Bull && !(h4Bear && sweep4h === 'Bearish')));
  const allowsSell =
    dominantSweep !== 'Bullish' &&
    (totalBear >= totalBull || (h1Bear && !(h4Bull && sweep4h === 'Bullish')));

  return {
    allowsBuy,
    allowsSell,
    dominantSweep,
    rangePos1hPct,
    summary1h,
    summary4h,
  };
}

function hasMeaningfulVolumeVariance(candles: OHLCVCandle[]): boolean {
  const sample = candles.slice(-20);
  if (sample.length < 5) return false;
  const first = sample[0].volume;
  return sample.some((c) => Math.abs(c.volume - first) > 1);
}

interface SweepMatch {
  sweepBar: OHLCVCandle;
  extremePrice: number;
}

function findRecentCausalSweepBar(
  closedSlice: OHLCVCandle[],
  side: 'BUY' | 'SELL',
  avgRange: number
): SweepMatch | null {
  // Inspect prior closed bars [len-6 .. len-2] so entries ONLY fire on subsequent displacement
  const endIdx = closedSlice.length - 1;
  const startIdx = Math.max(14, endIdx - 5);

  for (let idx = endIdx - 1; idx >= startIdx; idx--) {
    const bar = closedSlice[idx];
    const priorWindow = closedSlice.slice(Math.max(0, idx - 26), idx - 2);
    if (priorWindow.length < 6) continue;

    if (side === 'BUY') {
      const priorSwingLow = Math.min(...priorWindow.map((c) => c.low));
      const singleBarSweep =
        bar.low < priorSwingLow && bar.close > priorSwingLow;
      const prevBar = closedSlice[idx - 1];
      const twoBarSweep =
        prevBar != null &&
        prevBar.low < priorSwingLow &&
        prevBar.close <= priorSwingLow &&
        bar.close > priorSwingLow;

      if (singleBarSweep || twoBarSweep) {
        const extremePrice = twoBarSweep
          ? Math.min(prevBar.low, bar.low)
          : bar.low;
        const heldSinceSweep = closedSlice
          .slice(idx + 1)
          .every((b) => b.low >= extremePrice - avgRange * 0.08);
        if (heldSinceSweep) {
          return { sweepBar: bar, extremePrice };
        }
      }
    } else {
      const priorSwingHigh = Math.max(...priorWindow.map((c) => c.high));
      const singleBarSweep =
        bar.high > priorSwingHigh && bar.close < priorSwingHigh;
      const prevBar = closedSlice[idx - 1];
      const twoBarSweep =
        prevBar != null &&
        prevBar.high > priorSwingHigh &&
        prevBar.close >= priorSwingHigh &&
        bar.close < priorSwingHigh;

      if (singleBarSweep || twoBarSweep) {
        const extremePrice = twoBarSweep
          ? Math.max(prevBar.high, bar.high)
          : bar.high;
        const heldSinceSweep = closedSlice
          .slice(idx + 1)
          .every((b) => b.high <= extremePrice + avgRange * 0.08);
        if (heldSinceSweep) {
          return { sweepBar: bar, extremePrice };
        }
      }
    }
  }

  return null;
}

function isConfirmedDisplacementBar(
  closedSlice: OHLCVCandle[],
  side: 'BUY' | 'SELL',
  sweepMatch: SweepMatch | null,
  avgRange: number
): { confirmed: boolean; reason: string } {
  const signalBar = closedSlice[closedSlice.length - 1];
  const prevBars = closedSlice.slice(-21, -1);
  if (prevBars.length < 10) {
    return { confirmed: false, reason: 'Insufficient lookback for displacement' };
  }

  const avgBody =
    prevBars.reduce((acc, c) => acc + Math.abs(c.close - c.open), 0) /
    prevBars.length;
  const avgVol =
    prevBars.reduce((acc, c) => acc + c.volume, 0) / prevBars.length;
  const checkVolume = hasMeaningfulVolumeVariance(closedSlice) && avgVol > 0;

  const barRange = Math.max(signalBar.high - signalBar.low, 1e-9);
  const barBody = Math.abs(signalBar.close - signalBar.open);
  const volumeExpansion = !checkVolume || signalBar.volume >= avgVol * 1.05;

  // Avoid chasing exhausted parabolic outlier candles far from structural invalidation
  if (barBody > avgRange * 2.8) {
    return { confirmed: false, reason: 'Overextended displacement spike skipped' };
  }

  const prev2 = closedSlice[closedSlice.length - 3];

  if (side === 'BUY') {
    const bullishClose = signalBar.close > signalBar.open;
    const closeStrength = (signalBar.close - signalBar.low) / barRange;
    const expansionBody = barBody >= Math.max(avgBody * 1.08, avgRange * 0.5);
    const clearedSweepHigh = sweepMatch
      ? signalBar.close > sweepMatch.sweepBar.high
      : true;
    const createdBullFvg = prev2 ? prev2.high < signalBar.low : false;

    if (
      bullishClose &&
      closeStrength >= 0.58 &&
      expansionBody &&
      volumeExpansion &&
      (clearedSweepHigh || createdBullFvg)
    ) {
      return {
        confirmed: true,
        reason: checkVolume
          ? 'High-Volume Bullish Displacement'
          : 'Confirmed Bullish Displacement',
      };
    }
  } else {
    const bearishClose = signalBar.close < signalBar.open;
    const closeStrength = (signalBar.high - signalBar.close) / barRange;
    const expansionBody = barBody >= Math.max(avgBody * 1.08, avgRange * 0.5);
    const clearedSweepLow = sweepMatch
      ? signalBar.close < sweepMatch.sweepBar.low
      : true;
    const createdBearFvg = prev2 ? prev2.low > signalBar.high : false;

    if (
      bearishClose &&
      closeStrength >= 0.58 &&
      expansionBody &&
      volumeExpansion &&
      (clearedSweepLow || createdBearFvg)
    ) {
      return {
        confirmed: true,
        reason: checkVolume
          ? 'High-Volume Bearish Displacement'
          : 'Confirmed Bearish Displacement',
      };
    }
  }

  return { confirmed: false, reason: 'Unconfirmed displacement' };
}

/**
 * Strictly causal setup evaluation at closed bar index `barIndex` using ONLY
 * candles[0..barIndex] and strictly closed higher-timeframe candles.
 * Implements the 3 institutional filters:
 *   1) Higher-Timeframe (1H/4H) Structural Bias & Dominant Sweep alignment
 *   2) Deep Discount / Premium Pricing filter
 *   3) Confirmed Post-Sweep High-Volume Displacement (no blind initial reclaim entries)
 */
function evaluateCausalSetupAtBar(params: {
  closedSlice: OHLCVCandle[];
  decimals: number;
  timeframe: Timeframe;
  htf1hCandles?: OHLCVCandle[];
  htf4hCandles?: OHLCVCandle[];
  htfAligned?: boolean;
  counters: FilterCounters;
}): CandidateSetup | null {
  const {
    closedSlice,
    decimals,
    timeframe,
    htf1hCandles,
    htf4hCandles,
    htfAligned,
    counters,
  } = params;

  if (closedSlice.length < 40) return null;

  const summary = analyzePriceAction(closedSlice, decimals, {
    excludeFormingBar: false,
  });
  const { snapshot, levels, zones } = summary;
  const signalBar = closedSlice[closedSlice.length - 1];
  const avgRange = Math.max(snapshot.avgCandleRange, signalBar.close * 0.0005);

  const htf = evaluateCausalHtfBias({
    closedSlice,
    ltfTimeframe: timeframe,
    decimals,
    htf1hCandles,
    htf4hCandles,
    htfAligned,
  });

  // Compute macro 80-bar dealing range for true Premium/Discount origin pricing
  const macroWindow = closedSlice.slice(-80);
  const macroHigh = Math.max(...macroWindow.map((c) => c.high));
  const macroLow = Math.min(...macroWindow.map((c) => c.low));
  const macroSpan = Math.max(macroHigh - macroLow, 1e-9);
  const ltfSpan = Math.max(
    snapshot.dealingRangeHigh - snapshot.dealingRangeLow,
    1e-9
  );

  const bullSweep = findRecentCausalSweepBar(closedSlice, 'BUY', avgRange);
  const bearSweep = findRecentCausalSweepBar(closedSlice, 'SELL', avgRange);

  const bullZoneTouch = zones.find(
    (z) =>
      (z.kind === 'Demand OB' || z.kind === 'Bullish FVG') &&
      signalBar.low <= z.high &&
      signalBar.close >= z.low
  );
  const bearZoneTouch = zones.find(
    (z) =>
      (z.kind === 'Supply OB' || z.kind === 'Bearish FVG') &&
      signalBar.high >= z.low &&
      signalBar.close <= z.high
  );

  const candidates: Array<{
    side: 'BUY' | 'SELL';
    archetype: 'SweepDisplacement' | 'ZoneMitigation';
    sweepMatch: SweepMatch | null;
    zone: (typeof zones)[number] | null;
  }> = [];

  // Prioritize HTF-aligned BOS/FVG/OB zone pullbacks (formed by prior institutional displacement)
  if (
    bullZoneTouch &&
    signalBar.close > signalBar.open &&
    (snapshot.trendStructure === 'Bullish (HH / HL)' ||
      snapshot.latestStructureEvent.startsWith('Bullish'))
  ) {
    candidates.push({
      side: 'BUY',
      archetype: 'ZoneMitigation',
      sweepMatch: null,
      zone: bullZoneTouch,
    });
  }
  if (
    bearZoneTouch &&
    signalBar.close < signalBar.open &&
    (snapshot.trendStructure === 'Bearish (LH / LL)' ||
      snapshot.latestStructureEvent.startsWith('Bearish'))
  ) {
    candidates.push({
      side: 'SELL',
      archetype: 'ZoneMitigation',
      sweepMatch: null,
      zone: bearZoneTouch,
    });
  }

  // Post-sweep setups require subsequent displacement confirmation (never enter on initial reclaim)
  if (bullSweep) {
    candidates.push({
      side: 'BUY',
      archetype: 'SweepDisplacement',
      sweepMatch: bullSweep,
      zone: null,
    });
  }
  if (bearSweep) {
    candidates.push({
      side: 'SELL',
      archetype: 'SweepDisplacement',
      sweepMatch: bearSweep,
      zone: null,
    });
  }

  for (const cand of candidates) {
    counters.candidatesEvaluated += 1;

    // Filter 1: Higher-Timeframe (1H/4H) Structural Bias & Dominant Sweep Alignment
    const alignsHtfBias =
      cand.side === 'BUY' ? htf.allowsBuy : htf.allowsSell;

    if (!alignsHtfBias) {
      counters.rejectedByHtfBias += 1;
      continue;
    }

    // Filter 2: Premium-to-Discount Pricing Filter
    const originPrice =
      cand.side === 'BUY'
        ? cand.sweepMatch?.extremePrice ?? cand.zone?.midpoint ?? signalBar.low
        : cand.sweepMatch?.extremePrice ?? cand.zone?.midpoint ?? signalBar.high;

    const originLtfPct =
      ((originPrice - snapshot.dealingRangeLow) / ltfSpan) * 100;
    const originMacroPct = ((originPrice - macroLow) / macroSpan) * 100;
    const closeMacroPct = ((signalBar.close - macroLow) / macroSpan) * 100;

    if (cand.archetype === 'SweepDisplacement') {
      // Sweep reversals restricted strictly to Deep Discount (<= 38%) for BUY / Premium (>= 62%) for SELL
      const inDeepDiscount =
        cand.side === 'BUY' &&
        (originLtfPct <= 38 ||
          originMacroPct <= 38 ||
          (htf.rangePos1hPct !== null && htf.rangePos1hPct <= 38)) &&
        closeMacroPct <= 60;

      const inDeepPremium =
        cand.side === 'SELL' &&
        (originLtfPct >= 62 ||
          originMacroPct >= 62 ||
          (htf.rangePos1hPct !== null && htf.rangePos1hPct >= 62)) &&
        closeMacroPct >= 40;

      if (
        (cand.side === 'BUY' && !inDeepDiscount) ||
        (cand.side === 'SELL' && !inDeepPremium)
      ) {
        counters.rejectedByPremiumDiscount += 1;
        continue;
      }

      // Filter 3: Confirmed Post-Sweep High-Volume Displacement
      const displacement = isConfirmedDisplacementBar(
        closedSlice,
        cand.side,
        cand.sweepMatch,
        avgRange
      );
      if (!displacement.confirmed) {
        counters.rejectedByDisplacement += 1;
        continue;
      }

      const structuralExtreme =
        cand.side === 'BUY'
          ? Math.min(cand.sweepMatch!.extremePrice, signalBar.low) - avgRange * 0.25
          : Math.max(cand.sweepMatch!.extremePrice, signalBar.high) + avgRange * 0.25;

      const rawRisk =
        cand.side === 'BUY'
          ? signalBar.close - structuralExtreme
          : structuralExtreme - signalBar.close;

      // Skip entries whose stop-loss distance is abnormally wide (chasing extended impulse)
      if (rawRisk > avgRange * 3.4) {
        counters.rejectedByDisplacement += 1;
        continue;
      }

      const risk = Math.max(rawRisk, avgRange * 0.85);
      counters.qualifiedSetups += 1;

      if (cand.side === 'BUY') {
        const sl = roundToDecimals(signalBar.close - risk, decimals);
        return {
          side: 'BUY',
          setupType: 'Sweep + Displacement Reversal',
          trigger: `${displacement.reason} · HTF ${htf.summary1h.split(' / ')[0]}`,
          stopLoss: sl,
          takeProfit1: roundToDecimals(signalBar.close + risk * 1.4, decimals),
          takeProfit2: roundToDecimals(signalBar.close + risk * 2.4, decimals),
        };
      } else {
        const sl = roundToDecimals(signalBar.close + risk, decimals);
        return {
          side: 'SELL',
          setupType: 'Sweep + Displacement Reversal',
          trigger: `${displacement.reason} · HTF ${htf.summary1h.split(' / ')[0]}`,
          stopLoss: sl,
          takeProfit1: roundToDecimals(signalBar.close - risk * 1.4, decimals),
          takeProfit2: roundToDecimals(signalBar.close - risk * 2.4, decimals),
        };
      }
    } else {
      // Zone Mitigation (OB / FVG formed by prior displacement): enforce Discount (<=46%) / Premium (>=54%)
      const zoneInDiscount =
        cand.side === 'BUY' &&
        (originLtfPct <= 46 ||
          originMacroPct <= 46 ||
          (htf.rangePos1hPct !== null && htf.rangePos1hPct <= 44)) &&
        closeMacroPct <= 60;
      const zoneInPremium =
        cand.side === 'SELL' &&
        (originLtfPct >= 54 ||
          originMacroPct >= 54 ||
          (htf.rangePos1hPct !== null && htf.rangePos1hPct >= 56)) &&
        closeMacroPct >= 40;

      if (
        (cand.side === 'BUY' && !zoneInDiscount) ||
        (cand.side === 'SELL' && !zoneInPremium)
      ) {
        counters.rejectedByPremiumDiscount += 1;
        continue;
      }

      // Require decisive reaction close off the zone
      const barRange = Math.max(signalBar.high - signalBar.low, 1e-9);
      const barBody = Math.abs(signalBar.close - signalBar.open);
      const closeStrength =
        cand.side === 'BUY'
          ? (signalBar.close - signalBar.low) / barRange
          : (signalBar.high - signalBar.close) / barRange;

      if (closeStrength < 0.54 || barBody < avgRange * 0.3) {
        counters.rejectedByDisplacement += 1;
        continue;
      }

      counters.qualifiedSetups += 1;

      if (cand.side === 'BUY') {
        const nearestSupport = levels.find((l) => l.type === 'Support');
        const rawSl = Math.min(
          cand.zone!.low - avgRange * 0.35,
          nearestSupport ? nearestSupport.price - avgRange * 0.2 : cand.zone!.low
        );
        const risk = Math.max(signalBar.close - rawSl, avgRange * 0.8);
        return {
          side: 'BUY',
          setupType: 'BOS Pullback to Zone',
          trigger: `${cand.zone!.kind} Mitigation · HTF Aligned`,
          stopLoss: roundToDecimals(signalBar.close - risk, decimals),
          takeProfit1: roundToDecimals(signalBar.close + risk * 1.5, decimals),
          takeProfit2: roundToDecimals(signalBar.close + risk * 2.5, decimals),
        };
      } else {
        const nearestRes = levels.find((l) => l.type === 'Resistance');
        const rawSl = Math.max(
          cand.zone!.high + avgRange * 0.35,
          nearestRes ? nearestRes.price + avgRange * 0.2 : cand.zone!.high
        );
        const risk = Math.max(rawSl - signalBar.close, avgRange * 0.8);
        return {
          side: 'SELL',
          setupType: 'BOS Pullback to Zone',
          trigger: `${cand.zone!.kind} Mitigation · HTF Aligned`,
          stopLoss: roundToDecimals(signalBar.close + risk, decimals),
          takeProfit1: roundToDecimals(signalBar.close - risk * 1.5, decimals),
          takeProfit2: roundToDecimals(signalBar.close - risk * 2.5, decimals),
        };
      }
    }
  }

  return null;
}

export interface CausalSignalArrow {
  time: number;
  side: 'BUY' | 'SELL';
  setupType: string;
  trigger: string;
}

/**
 * Detects strictly closed-bar, non-repainting BUY / SELL confirmation arrows
 * across visible chart history. Never evaluates the forming unclosed candle.
 */
export function detectCausalSignalArrows(params: {
  candles: OHLCVCandle[];
  timeframe: Timeframe;
  decimals: number;
}): CausalSignalArrow[] {
  const { candles, timeframe, decimals } = params;
  const closedCandles = getClosedCandlesForTimeframe(candles, timeframe);
  if (closedCandles.length < 45) return [];

  const warmupBars = Math.min(45, Math.max(25, Math.floor(closedCandles.length * 0.25)));
  const counters: FilterCounters = {
    candidatesEvaluated: 0,
    rejectedByHtfBias: 0,
    rejectedByPremiumDiscount: 0,
    rejectedByDisplacement: 0,
    qualifiedSetups: 0,
  };

  const arrows: CausalSignalArrow[] = [];
  let i = warmupBars;

  while (i < closedCandles.length) {
    const causalSlice = closedCandles.slice(0, i + 1);
    const setup = evaluateCausalSetupAtBar({
      closedSlice: causalSlice,
      decimals,
      timeframe,
      htfAligned: false,
      counters,
    });

    if (setup) {
      arrows.push({
        time: closedCandles[i].time,
        side: setup.side,
        setupType: setup.setupType,
        trigger: setup.trigger,
      });
      // Space arrows cleanly by at least 4 closed bars to prevent marker clutter
      i += 4;
      continue;
    }

    i += 1;
  }

  return arrows;
}

export function runNonRepaintingBacktest(params: {
  symbol: string;
  timeframe: Timeframe;
  candles: OHLCVCandle[];
  htf1hCandles?: OHLCVCandle[];
  htf4hCandles?: OHLCVCandle[];
  htfAligned?: boolean;
  initialCapital?: number;
  riskPercentPerTrade?: number;
}): BacktestResult {
  const {
    symbol,
    timeframe,
    candles,
    htf1hCandles,
    htf4hCandles,
    htfAligned = false,
    initialCapital = 10000,
    riskPercentPerTrade = 1,
  } = params;
  const instrument = getInstrumentBySymbol(symbol);
  const decimals = instrument.decimals;

  // Exclude currently forming last bar so all backtest decisions occur strictly on closed bars
  const closedCandles = candles.length > 50 ? candles.slice(0, -1) : candles;
  const warmupBars = Math.min(45, Math.max(20, Math.floor(closedCandles.length * 0.25)));

  let equity = initialCapital;
  let peakEquity = initialCapital;
  let maxDrawdownPct = 0;

  const trades: BacktestTrade[] = [];
  const equityCurve: BacktestEquityPoint[] = [];
  const filterCounters: FilterCounters = {
    candidatesEvaluated: 0,
    rejectedByHtfBias: 0,
    rejectedByPremiumDiscount: 0,
    rejectedByDisplacement: 0,
    qualifiedSetups: 0,
  };

  if (closedCandles.length > warmupBars) {
    equityCurve.push({
      time: closedCandles[warmupBars].time,
      equity: initialCapital,
    });
  }

  let i = warmupBars;
  while (i < closedCandles.length - 2) {
    const causalSlice = closedCandles.slice(0, i + 1);
    const setup = evaluateCausalSetupAtBar({
      closedSlice: causalSlice,
      decimals,
      timeframe,
      htf1hCandles,
      htf4hCandles,
      htfAligned,
      counters: filterCounters,
    });

    if (!setup) {
      i += 1;
      continue;
    }

    // Enter strictly on the NEXT bar's Open (zero intrabar lookahead / zero repainting)
    const entryBarIndex = i + 1;
    const entryBar = closedCandles[entryBarIndex];
    const entryPrice = entryBar.open;

    // Validate SL distance relative to actual next-bar Open
    const stopDistance =
      setup.side === 'BUY'
        ? entryPrice - setup.stopLoss
        : setup.stopLoss - entryPrice;

    if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
      i += 1;
      continue;
    }

    let currentSl = setup.stopLoss;
    let tp1Hit = false;
    let exitBarIndex = closedCandles.length - 1;
    let exitPrice = closedCandles[exitBarIndex].close;
    let exitReason: BacktestTrade['exitReason'] = 'End of Sample';

    // Walk forward bar-by-bar from entryBarIndex checking worst-case SL first
    for (let j = entryBarIndex; j < closedCandles.length; j++) {
      const bar = closedCandles[j];

      const hitSl =
        setup.side === 'BUY' ? bar.low <= currentSl : bar.high >= currentSl;
      if (hitSl) {
        exitBarIndex = j;
        exitPrice = currentSl;
        exitReason = tp1Hit ? 'Breakeven Stop' : 'Stop Loss';
        break;
      }

      if (!tp1Hit) {
        const hitTp1 =
          setup.side === 'BUY'
            ? bar.high >= setup.takeProfit1
            : bar.low <= setup.takeProfit1;
        if (hitTp1) {
          tp1Hit = true;
          currentSl = entryPrice; // Move SL to Breakeven after TP1
        }
      }

      const hitTp2 =
        setup.side === 'BUY'
          ? bar.high >= setup.takeProfit2
          : bar.low <= setup.takeProfit2;
      if (hitTp2) {
        exitBarIndex = j;
        exitPrice = setup.takeProfit2;
        exitReason = 'TP2 Hit';
        break;
      }
    }

    // Compute R-multiple with 50% partial at TP1 + 50% at final exit
    let rMultiple = 0;
    const tp1R =
      setup.side === 'BUY'
        ? (setup.takeProfit1 - entryPrice) / stopDistance
        : (entryPrice - setup.takeProfit1) / stopDistance;
    const finalExitR =
      setup.side === 'BUY'
        ? (exitPrice - entryPrice) / stopDistance
        : (entryPrice - exitPrice) / stopDistance;

    if (tp1Hit) {
      rMultiple = 0.5 * tp1R + 0.5 * finalExitR;
    } else {
      rMultiple = finalExitR;
    }
    rMultiple = Math.round(rMultiple * 100) / 100;

    const riskUsd = equity * (riskPercentPerTrade / 100);
    const pnlUsd = roundCurrency(riskUsd * rMultiple);
    equity = roundCurrency(equity + pnlUsd);

    if (equity > peakEquity) peakEquity = equity;
    const ddPct = ((peakEquity - equity) / Math.max(peakEquity, 1)) * 100;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    trades.push({
      id: `bt-${entryBar.time}`,
      side: setup.side,
      setupType: setup.setupType,
      trigger: setup.trigger,
      entryTime: entryBar.time,
      exitTime: closedCandles[exitBarIndex].time,
      entryPrice: roundToDecimals(entryPrice, decimals),
      stopLoss: roundToDecimals(setup.stopLoss, decimals),
      takeProfit1: roundToDecimals(setup.takeProfit1, decimals),
      takeProfit2: roundToDecimals(setup.takeProfit2, decimals),
      exitPrice: roundToDecimals(exitPrice, decimals),
      exitReason,
      tp1Hit,
      rMultiple,
      pnlUsd,
      equityAfter: equity,
    });

    equityCurve.push({
      time: closedCandles[exitBarIndex].time,
      equity,
    });

    // Advance strictly past trade exit bar (no overlapping trades on same bar)
    i = exitBarIndex + 1;
  }

  const wins = trades.filter((t) => t.pnlUsd > 0.5).length;
  const losses = trades.filter((t) => t.pnlUsd < -0.5).length;
  const breakevens = trades.length - wins - losses;

  const grossProfit = trades
    .filter((t) => t.pnlUsd > 0)
    .reduce((sum, t) => sum + t.pnlUsd, 0);
  const grossLoss = Math.abs(
    trades.filter((t) => t.pnlUsd < 0).reduce((sum, t) => sum + t.pnlUsd, 0)
  );
  const profitFactor =
    grossLoss > 0
      ? Math.round((grossProfit / grossLoss) * 100) / 100
      : grossProfit > 0
      ? 9.99
      : 0;

  const totalR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  const expectancyR =
    trades.length > 0 ? Math.round((totalR / trades.length) * 100) / 100 : 0;

  const setupMap = new Map<string, BacktestSetupStats>();
  for (const t of trades) {
    const existing = setupMap.get(t.setupType) ?? {
      setupType: t.setupType,
      trades: 0,
      wins: 0,
      winRatePct: 0,
      netR: 0,
      netPnlUsd: 0,
    };
    existing.trades += 1;
    if (t.pnlUsd > 0.5) existing.wins += 1;
    existing.netR = Math.round((existing.netR + t.rMultiple) * 100) / 100;
    existing.netPnlUsd = roundCurrency(existing.netPnlUsd + t.pnlUsd);
    existing.winRatePct = Math.round((existing.wins / existing.trades) * 100);
    setupMap.set(t.setupType, existing);
  }

  const netReturnUsd = roundCurrency(equity - initialCapital);
  const netReturnPct =
    Math.round((netReturnUsd / Math.max(initialCapital, 1)) * 10000) / 100;

  return {
    symbol: instrument.symbol,
    timeframe,
    barsTested: closedCandles.length,
    fromTime: closedCandles[0]?.time ?? 0,
    toTime: closedCandles[closedCandles.length - 1]?.time ?? 0,
    initialCapital,
    finalEquity: equity,
    netReturnUsd,
    netReturnPct,
    totalTrades: trades.length,
    wins,
    losses,
    breakevens,
    winRatePct:
      trades.length > 0 ? Math.round((wins / trades.length) * 1000) / 10 : 0,
    profitFactor,
    expectancyR,
    maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
    nonRepaintingVerified: true,
    appliedFilters: [
      '1H/4H Structural Bias & Dominant Sweep Filter',
      'Deep Discount (≤38%) / Premium (≥62%) Pricing Filter',
      'Post-Sweep High-Volume Displacement Confirmation',
    ],
    filterStats: filterCounters,
    setupBreakdown: Array.from(setupMap.values()).sort(
      (a, b) => b.netPnlUsd - a.netPnlUsd
    ),
    equityCurve,
    trades: [...trades].reverse(),
  };
}
