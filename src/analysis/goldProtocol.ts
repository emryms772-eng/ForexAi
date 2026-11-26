import type {
  GoldDailyScenario,
  GoldFibConfluence,
  GoldProtocolAnalysis,
  GoldPsychologicalLevel,
  GoldTrendlineRead,
  OHLCVCandle,
  PriceActionAnalysisSummary,
  Timeframe,
} from '../types/market.ts';
import { analyzePriceAction, getClosedCandlesForTimeframe } from './priceAction.ts';

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

export function pointsToGoldPips(points: number): number {
  return Math.round(points * 10);
}

/**
 * Computes round-number 50-point (500-pip) Gold psychological levels around spot.
 */
export function getGoldPsychologicalLevels(spotPrice: number): {
  nearestBelow: GoldPsychologicalLevel;
  nearestAbove: GoldPsychologicalLevel;
  nearbyLevels: GoldPsychologicalLevel[];
} {
  const step = 50;
  const floorLevel = Math.floor(spotPrice / step) * step;
  const ceilLevel = Math.ceil(spotPrice / step) * step;
  const belowPrice = floorLevel === spotPrice ? floorLevel - step : floorLevel;
  const abovePrice = ceilLevel === spotPrice ? ceilLevel + step : ceilLevel;

  const toLevel = (level: number): GoldPsychologicalLevel => {
    const diff = level - spotPrice;
    const relation: GoldPsychologicalLevel['relation'] =
      Math.abs(diff) < 0.25 ? 'At Spot' : diff > 0 ? 'Above' : 'Below';
    return {
      price: level,
      relation,
      distancePoints: round2(Math.abs(diff)),
      distancePips: Math.abs(pointsToGoldPips(diff)),
    };
  };

  const candidates = [
    belowPrice - step,
    belowPrice,
    abovePrice,
    abovePrice + step,
  ].filter((v) => v > 0);

  return {
    nearestBelow: toLevel(belowPrice),
    nearestAbove: toLevel(abovePrice),
    nearbyLevels: candidates.map(toLevel),
  };
}

interface PivotPoint {
  index: number;
  confirmIndex: number;
  time: number;
  price: number;
  kind: 'high' | 'low';
}

function findCausalPivots(candles: OHLCVCandle[], lookback = 3): PivotPoint[] {
  const pivots: PivotPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= high) isHigh = false;
      if (candles[j].low <= low) isLow = false;
    }
    if (isHigh) {
      pivots.push({
        index: i,
        confirmIndex: i + lookback,
        time: candles[i].time,
        price: high,
        kind: 'high',
      });
    }
    if (isLow) {
      pivots.push({
        index: i,
        confirmIndex: i + lookback,
        time: candles[i].time,
        price: low,
        kind: 'low',
      });
    }
  }
  return pivots;
}

/**
 * Identifies trend inception points and valid support/resistance trendlines,
 * counting structural touches and checking 3rd-touch + candle body closure rules.
 */
export function detectGoldTrendlines(
  candles: OHLCVCandle[],
  avgRange: number
): GoldTrendlineRead[] {
  if (candles.length < 24) return [];
  const window = candles.slice(-110);
  const pivots = findCausalPivots(window, 3).filter(
    (p) => p.confirmIndex < window.length
  );
  const lastBar = window[window.length - 1];
  const prevBar = window[window.length - 2];
  const prev2Bar = window[window.length - 3];
  const tol = Math.max(avgRange * 0.42, 0.8);
  const breakTol = Math.max(avgRange * 0.22, 0.5);

  const results: GoldTrendlineRead[] = [];

  // 1. Bullish Support Trendline from Inception Swing Low
  const lows = pivots.filter((p) => p.kind === 'low');
  if (lows.length >= 2) {
    let inception = lows[0];
    for (const p of lows.slice(0, -1)) {
      if (p.price < inception.price) inception = p;
    }

    let bestSupport: GoldTrendlineRead | null = null;
    for (let k = lows.length - 1; k >= 0; k--) {
      const anchor = lows[k];
      if (anchor.index <= inception.index + 3) continue;
      if (anchor.price <= inception.price) continue;

      const dt = Math.max(anchor.time - inception.time, 1);
      const slope = (anchor.price - inception.price) / dt;

      let cleanLine = true;
      let touches = 0;
      let lastTouchIdx = -99;

      for (let i = inception.index; i < window.length - 1; i++) {
        const bar = window[i];
        const lineAtBar = inception.price + slope * (bar.time - inception.time);
        if (bar.close < lineAtBar - breakTol * 1.4 && i > anchor.index) {
          cleanLine = false;
          break;
        }
        if (Math.abs(bar.low - lineAtBar) <= tol && i - lastTouchIdx >= 4) {
          touches += 1;
          lastTouchIdx = i;
        }
      }

      if (!cleanLine || touches < 2) continue;

      const projected = round2(
        inception.price + slope * (lastBar.time - inception.time)
      );
      const recentBars = [prev2Bar, prevBar, lastBar].filter(Boolean);
      const touchedRecently = recentBars.some((b) => {
        const lineAtB = inception.price + slope * (b.time - inception.time);
        return b.low <= lineAtB + tol && b.close >= lineAtB - breakTol * 0.4;
      });

      const bodyBreakStatus: GoldTrendlineRead['bodyBreakStatus'] =
        lastBar.close < projected - breakTol
          ? 'Body Close Broken'
          : lastBar.low < projected && lastBar.close >= projected
          ? 'Wick Spike Rejected'
          : 'Intact';

      const candidate: GoldTrendlineRead = {
        direction: 'Support (Bullish)',
        inceptionTime: inception.time,
        inceptionPrice: round2(inception.price),
        anchorTime: anchor.time,
        anchorPrice: round2(anchor.price),
        projectedPriceAtSpot: projected,
        touches,
        thirdTouchActive:
          (touches >= 3 || (touches >= 2 && touchedRecently)) &&
          bodyBreakStatus !== 'Body Close Broken' &&
          touchedRecently,
        bodyBreakStatus,
      };

      if (!bestSupport || candidate.touches > bestSupport.touches) {
        bestSupport = candidate;
      }
    }

    if (bestSupport) results.push(bestSupport);
  }

  // 2. Bearish Resistance Trendline from Inception Swing High
  const highs = pivots.filter((p) => p.kind === 'high');
  if (highs.length >= 2) {
    let inception = highs[0];
    for (const p of highs.slice(0, -1)) {
      if (p.price > inception.price) inception = p;
    }

    let bestRes: GoldTrendlineRead | null = null;
    for (let k = highs.length - 1; k >= 0; k--) {
      const anchor = highs[k];
      if (anchor.index <= inception.index + 3) continue;
      if (anchor.price >= inception.price) continue;

      const dt = Math.max(anchor.time - inception.time, 1);
      const slope = (anchor.price - inception.price) / dt;

      let cleanLine = true;
      let touches = 0;
      let lastTouchIdx = -99;

      for (let i = inception.index; i < window.length - 1; i++) {
        const bar = window[i];
        const lineAtBar = inception.price + slope * (bar.time - inception.time);
        if (bar.close > lineAtBar + breakTol * 1.4 && i > anchor.index) {
          cleanLine = false;
          break;
        }
        if (Math.abs(bar.high - lineAtBar) <= tol && i - lastTouchIdx >= 4) {
          touches += 1;
          lastTouchIdx = i;
        }
      }

      if (!cleanLine || touches < 2) continue;

      const projected = round2(
        inception.price + slope * (lastBar.time - inception.time)
      );
      const recentBars = [prev2Bar, prevBar, lastBar].filter(Boolean);
      const touchedRecently = recentBars.some((b) => {
        const lineAtB = inception.price + slope * (b.time - inception.time);
        return b.high >= lineAtB - tol && b.close <= lineAtB + breakTol * 0.4;
      });

      const bodyBreakStatus: GoldTrendlineRead['bodyBreakStatus'] =
        lastBar.close > projected + breakTol
          ? 'Body Close Broken'
          : lastBar.high > projected && lastBar.close <= projected
          ? 'Wick Spike Rejected'
          : 'Intact';

      const candidate: GoldTrendlineRead = {
        direction: 'Resistance (Bearish)',
        inceptionTime: inception.time,
        inceptionPrice: round2(inception.price),
        anchorTime: anchor.time,
        anchorPrice: round2(anchor.price),
        projectedPriceAtSpot: projected,
        touches,
        thirdTouchActive:
          (touches >= 3 || (touches >= 2 && touchedRecently)) &&
          bodyBreakStatus !== 'Body Close Broken' &&
          touchedRecently,
        bodyBreakStatus,
      };

      if (!bestRes || candidate.touches > bestRes.touches) {
        bestRes = candidate;
      }
    }

    if (bestRes) results.push(bestRes);
  }

  return results;
}

function summarizeDailySessions(
  candles: OHLCVCandle[],
  lastBar: OHLCVCandle
): GoldProtocolAnalysis['dailySession'] {
  const byDay = new Map<
    string,
    { startSec: number; open: number; high: number; low: number; close: number }
  >();

  for (const bar of candles) {
    const dayKey = new Date(bar.time * 1000).toISOString().slice(0, 10);
    const dayStart = Math.floor(bar.time / 86400) * 86400;
    const existing = byDay.get(dayKey);
    if (!existing) {
      byDay.set(dayKey, {
        startSec: dayStart,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
    }
  }

  const days = Array.from(byDay.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  const currentDay = days[days.length - 1];
  const prevDay = days.length >= 2 ? days[days.length - 2] : null;
  const priorDays = days.slice(Math.max(0, days.length - 6), Math.max(0, days.length - 1));

  const avgDailyRangePoints =
    priorDays.length > 0
      ? round2(
          priorDays.reduce((sum, [, d]) => sum + (d.high - d.low), 0) /
            priorDays.length
        )
      : round2(Math.max(lastBar.high - lastBar.low, 15));

  const sessionOpen = currentDay ? round2(currentDay[1].open) : round2(lastBar.open);
  const sessionHigh = currentDay ? round2(currentDay[1].high) : round2(lastBar.high);
  const sessionLow = currentDay ? round2(currentDay[1].low) : round2(lastBar.low);
  const prevDayClose = prevDay ? round2(prevDay[1].close) : sessionOpen;
  const openGapPoints = round2(sessionOpen - prevDayClose);
  const dailyRangePoints = round2(sessionHigh - sessionLow);
  const rangeExpansionRatio = round2(
    dailyRangePoints / Math.max(avgDailyRangePoints, 1)
  );

  return {
    sessionDateUtc:
      currentDay?.[0] ?? new Date(lastBar.time * 1000).toISOString().slice(0, 10),
    sessionStartSec:
      currentDay?.[1].startSec ?? Math.floor(lastBar.time / 86400) * 86400,
    sessionOpen,
    sessionHigh,
    sessionLow,
    prevDayClose,
    openGapPoints,
    openGapPips: pointsToGoldPips(openGapPoints),
    dailyRangePoints,
    avgDailyRangePoints,
    rangeExpansionRatio,
  };
}

function classifyGoldDailyScenario(params: {
  sessionCandles: OHLCVCandle[];
  dailySession: GoldProtocolAnalysis['dailySession'];
  h1Bias: 'Bullish' | 'Bearish' | 'Neutral';
  h1StructureEvent: string;
}): GoldDailyScenario {
  const { sessionCandles, dailySession, h1Bias, h1StructureEvent } = params;
  if (sessionCandles.length < 3) {
    if (h1Bias === 'Bullish') return 'Clean uptrend';
    if (h1Bias === 'Bearish') return 'Clean downtrend';
    return 'Sideways consolidation';
  }

  const open = dailySession.sessionOpen;
  const lastClose = sessionCandles[sessionCandles.length - 1].close;
  const totalRange = Math.max(dailySession.sessionHigh - dailySession.sessionLow, 0.5);
  const dropFromOpen = open - dailySession.sessionLow;
  const rallyFromOpen = dailySession.sessionHigh - open;
  const netMove = lastClose - open;
  const posInDay = (lastClose - dailySession.sessionLow) / totalRange;

  // Low range expansion relative to average day signals consolidation
  if (
    dailySession.rangeExpansionRatio < 0.42 &&
    Math.abs(netMove) < Math.max(dailySession.avgDailyRangePoints * 0.18, 4)
  ) {
    return 'Sideways consolidation';
  }

  // Initial drop followed by a bullish reversal
  if (
    dropFromOpen >= totalRange * 0.35 &&
    posInDay >= 0.65 &&
    (lastClose >= open - totalRange * 0.1 || h1StructureEvent === 'Bullish CHoCH')
  ) {
    return 'Initial drop followed by a bullish reversal';
  }

  // Initial rally followed by a bearish reversal
  if (
    rallyFromOpen >= totalRange * 0.35 &&
    posInDay <= 0.35 &&
    (lastClose <= open + totalRange * 0.1 || h1StructureEvent === 'Bearish CHoCH')
  ) {
    return 'Initial rally followed by a bearish reversal';
  }

  if (netMove > 0 && (posInDay >= 0.55 || h1Bias === 'Bullish')) {
    return 'Clean uptrend';
  }
  if (netMove < 0 && (posInDay <= 0.45 || h1Bias === 'Bearish')) {
    return 'Clean downtrend';
  }

  return 'Sideways consolidation';
}

export function computeGoldFibConfluences(params: {
  h1Candles: OHLCVCandle[];
  trendlines: GoldTrendlineRead[];
  nearbyPsych: GoldPsychologicalLevel[];
  spotPrice: number;
  avgRange: number;
}): GoldFibConfluence[] {
  const { h1Candles, trendlines, nearbyPsych, spotPrice, avgRange } = params;
  const swingBars = h1Candles.slice(-72);
  if (swingBars.length < 10) return [];

  let maxHigh = -Infinity;
  let maxIdx = 0;
  let minLow = Infinity;
  let minIdx = 0;

  for (let i = 0; i < swingBars.length; i++) {
    if (swingBars[i].high > maxHigh) {
      maxHigh = swingBars[i].high;
      maxIdx = i;
    }
    if (swingBars[i].low < minLow) {
      minLow = swingBars[i].low;
      minIdx = i;
    }
  }

  const span = maxHigh - minLow;
  if (span <= 2) return [];

  const isBullImpulse = minIdx < maxIdx;
  const ratios: Array<'0.382' | '0.500' | '0.618' | '0.786'> = [
    '0.382',
    '0.500',
    '0.618',
    '0.786',
  ];
  const overlapTol = Math.max(avgRange * 0.85, 6.5);

  return ratios.map((ratioStr) => {
    const r = Number(ratioStr);
    const price = round2(
      isBullImpulse ? maxHigh - span * r : minLow + span * r
    );
    const overlapsWith: string[] = [];

    for (const psych of nearbyPsych) {
      if (Math.abs(price - psych.price) <= overlapTol) {
        overlapsWith.push(`${psych.price} Psych (50-pt)`);
      }
    }
    for (const tl of trendlines) {
      if (Math.abs(price - tl.projectedPriceAtSpot) <= overlapTol) {
        overlapsWith.push(
          `${tl.direction.split(' ')[0]} Trendline (${tl.projectedPriceAtSpot.toFixed(1)})`
        );
      }
    }

    return {
      ratio: ratioStr,
      price,
      distancePips: pointsToGoldPips(Math.abs(price - spotPrice)),
      overlapsWith,
    };
  });
}

/**
 * Full 3-Phase GOLD (XAU/USD) Technical Analysis Engine.
 * Strictly pure price action on closed candles (no lagging indicators).
 */
export function analyzeGoldProtocol(params: {
  h1Candles: OHLCVCandle[];
  ltfCandles: OHLCVCandle[];
  ltfTimeframe: Timeframe;
  h1Summary?: PriceActionAnalysisSummary;
}): GoldProtocolAnalysis {
  const { h1Candles: rawH1, ltfCandles: rawLtf, ltfTimeframe } = params;
  const h1Candles = getClosedCandlesForTimeframe(rawH1, '1H');
  const ltfCandles = getClosedCandlesForTimeframe(rawLtf, ltfTimeframe);

  const effectiveH1 = h1Candles.length >= 16 ? h1Candles : ltfCandles;
  const h1Summary =
    params.h1Summary ??
    analyzePriceAction(effectiveH1, 2, {
      excludeFormingBar: false,
    });

  const lastBar =
    ltfCandles[ltfCandles.length - 1] ??
    effectiveH1[effectiveH1.length - 1] ?? {
      time: Math.floor(Date.now() / 1000),
      open: 3550,
      high: 3555,
      low: 3545,
      close: 3550,
      volume: 100,
    };

  const spotPrice = round2(lastBar.close);
  const h1AvgRange = Math.max(h1Summary.snapshot.avgCandleRange, 4.0);

  // Phase 1: H1 Anchor + Daily Session Breaks + 50-Point (500-pip) Psych Levels
  const h1Snap = h1Summary.snapshot;
  const h1Bias: GoldProtocolAnalysis['h1Bias'] =
    h1Snap.trendStructure === 'Bullish (HH / HL)' ||
    h1Snap.latestStructureEvent === 'Bullish BOS' ||
    h1Snap.latestStructureEvent === 'Bullish CHoCH'
      ? 'Bullish'
      : h1Snap.trendStructure === 'Bearish (LH / LL)' ||
        h1Snap.latestStructureEvent === 'Bearish BOS' ||
        h1Snap.latestStructureEvent === 'Bearish CHoCH'
      ? 'Bearish'
      : h1Snap.buyerPressurePct >= 56
      ? 'Bullish'
      : h1Snap.buyerPressurePct <= 44
      ? 'Bearish'
      : 'Neutral';

  const sessionSource = effectiveH1.length >= 24 ? effectiveH1 : ltfCandles;
  const dailySession = summarizeDailySessions(sessionSource, lastBar);
  const sessionCandles = sessionSource.filter(
    (b) => b.time >= dailySession.sessionStartSec
  );
  const psychLevels = getGoldPsychologicalLevels(spotPrice);

  // Phase 2: Daily Scenario + Trendlines & Inception Points + CHoCH + Fib Confluence
  const dailyScenario = classifyGoldDailyScenario({
    sessionCandles: sessionCandles.length >= 3 ? sessionCandles : ltfCandles.slice(-16),
    dailySession,
    h1Bias,
    h1StructureEvent: h1Snap.latestStructureEvent,
  });

  const trendlines = detectGoldTrendlines(effectiveH1, h1AvgRange);
  const fibConfluences = computeGoldFibConfluences({
    h1Candles: effectiveH1,
    trendlines,
    nearbyPsych: psychLevels.nearbyLevels,
    spotPrice,
    avgRange: h1AvgRange,
  });

  const chochStatus = h1Snap.latestStructureEvent.includes('CHoCH')
    ? `${h1Snap.latestStructureEvent} confirmed by H1 body close`
    : `No active H1 CHoCH (${h1Snap.latestStructureEvent} intact)`;

  // Phase 3: Third-Touch & Body Closure Rule + Macro/Volatility Spike Filter
  const activeThirdTouch = trendlines.find((t) => t.thirdTouchActive);
  const wickRejectedTl = trendlines.find(
    (t) => t.bodyBreakStatus === 'Wick Spike Rejected'
  );
  const bodyBrokenTl = trendlines.find(
    (t) => t.bodyBreakStatus === 'Body Close Broken'
  );

  // Check closed-bar wick vs body behavior at nearest 50-pt psychological level
  const checkPsychWick = (lvlPrice: number) =>
    (lastBar.high >= lvlPrice && lastBar.close < lvlPrice) ||
    (lastBar.low <= lvlPrice && lastBar.close > lvlPrice);
  const psychWickReject =
    checkPsychWick(psychLevels.nearestAbove.price) ||
    checkPsychWick(psychLevels.nearestBelow.price);

  const ltfTail = ltfCandles.slice(-20);
  const ltfAvgRange =
    ltfTail.length > 0
      ? ltfTail.reduce((s, b) => s + Math.max(b.high - b.low, 0), 0) / ltfTail.length
      : 2.0;
  const lastBarRange = Math.max(lastBar.high - lastBar.low, 0);
  const lastH1Bar = effectiveH1[effectiveH1.length - 1] ?? lastBar;
  const h1SpikeRatio = round2(
    Math.max(lastH1Bar.high - lastH1Bar.low, 0) / Math.max(h1AvgRange, 0.5)
  );
  const ltfSpikeRatio = round2(lastBarRange / Math.max(ltfAvgRange, 0.5));
  const spikeRatio = Math.max(h1SpikeRatio, ltfSpikeRatio);

  const openGapAlert = Math.abs(dailySession.openGapPoints) >= 12;
  const counterSpike =
    spikeRatio >= 2.35 &&
    ((h1Bias === 'Bullish' && lastBar.close < lastBar.open) ||
      (h1Bias === 'Bearish' && lastBar.close > lastBar.open));
  const extremeVolatility = spikeRatio >= 2.55 || openGapAlert || counterSpike;

  let closureStatus: GoldProtocolAnalysis['closureConfirmation']['status'] =
    'Awaiting Close';
  let closureDetail = `Closed ${ltfTimeframe} bar settled at ${spotPrice.toFixed(
    2
  )} inside H1 structure without breaking 50-pt levels.`;

  if (wickRejectedTl || psychWickReject) {
    closureStatus = 'Wick Rejection Only';
    closureDetail = wickRejectedTl
      ? `Wick spike rejected ${wickRejectedTl.direction} (${wickRejectedTl.projectedPriceAtSpot.toFixed(
          2
        )}) — level intact; do NOT trade a wick breakout without solid body close.`
      : `Wick rejected near 50-pt psychological boundary (${psychLevels.nearestBelow.price}/${psychLevels.nearestAbove.price}) with body close still inside range.`;
  } else if (activeThirdTouch) {
    closureStatus = 'Body Close Confirmed';
    closureDetail = `3rd-touch reaction holding on ${activeThirdTouch.direction} (${activeThirdTouch.projectedPriceAtSpot.toFixed(
      2
    )}) with solid candle body confirmation.`;
  } else if (bodyBrokenTl) {
    closureStatus = 'Body Close Confirmed';
    closureDetail = `Clean candle body closure broke ${bodyBrokenTl.direction} (${bodyBrokenTl.projectedPriceAtSpot.toFixed(
      2
    )}), confirming structural shift.`;
  } else if (
    h1Snap.latestStructureEvent === 'Bullish CHoCH' ||
    h1Snap.latestStructureEvent === 'Bearish CHoCH'
  ) {
    closureStatus = 'Body Close Confirmed';
    closureDetail = `${h1Snap.latestStructureEvent} confirmed by H1 body closure; watch pullbacks to Fib/50-pt confluence.`;
  }

  const volatilityWarning = extremeVolatility
    ? `Elevated fakeout risk (${spikeRatio.toFixed(1)}x range expansion${
        openGapAlert
          ? `, ${dailySession.openGapPoints > 0 ? '+' : ''}${dailySession.openGapPoints}pt (${dailySession.openGapPips} pip) session open gap`
          : ''
      }). Require extra closed-bar body confirmation before entering.`
    : `Normal Gold volatility (${spikeRatio.toFixed(1)}x avg range, daily range ${dailySession.dailyRangePoints}pts vs ${dailySession.avgDailyRangePoints}pt ADR). Standard body-close confirmation active.`;

  const highConfluenceFibs = fibConfluences.filter((f) => f.overlapsWith.length > 0);
  const fibSummaryText =
    highConfluenceFibs.length > 0
      ? highConfluenceFibs
          .map(
            (f) => `${f.ratio} Fib @ ${f.price.toFixed(2)} [${f.overlapsWith.join(' + ')}]`
          )
          .join('; ')
      : fibConfluences.length > 0
      ? `H1 Fib pocket: 0.500 (${fibConfluences[1]?.price.toFixed(
          2
        )}) – 0.618 (${fibConfluences[2]?.price.toFixed(2)})`
      : 'Awaiting clearer H1 swing leg for Fib retracement';

  const trendlineSummary =
    trendlines.length > 0
      ? trendlines
          .map(
            (t) =>
              `${t.direction}: inception ${t.inceptionPrice.toFixed(
                2
              )} -> proj ${t.projectedPriceAtSpot.toFixed(2)} (${t.touches} touches${
                t.thirdTouchActive ? ', 3RD TOUCH ACTIVE' : ''
              })`
          )
          .join(' | ')
      : 'No clean multi-touch H1 trendline slope active';

  const currentBiasAndScenario = `H1 Bias: ${h1Bias} (${h1Snap.trendStructure} · ${h1Snap.latestStructureEvent}). UTC Session (${dailySession.sessionDateUtc}) opened at ${dailySession.sessionOpen.toFixed(
    2
  )} (prev close ${dailySession.prevDayClose.toFixed(
    2
  )}, gap ${dailySession.openGapPoints >= 0 ? '+' : ''}${dailySession.openGapPoints}pts / ${dailySession.openGapPips} pips). Daily Scenario: ${dailyScenario}.`;

  const keyLevelsAndConfluence = `50-pt Psych Levels: Support ${psychLevels.nearestBelow.price} (-${psychLevels.nearestBelow.distancePips} pips / -${psychLevels.nearestBelow.distancePoints}pts) & Resistance ${psychLevels.nearestAbove.price} (+${psychLevels.nearestAbove.distancePips} pips / +${psychLevels.nearestAbove.distancePoints}pts). Trendlines: ${trendlineSummary}. Fib Confluence: ${fibSummaryText}.`;

  const confirmationStatus = `${closureStatus}: ${closureDetail} CHoCH Status: ${chochStatus}.`;

  const riskAndVolatilityWarning = `${extremeVolatility ? 'ELEVATED FAKEOUT RISK' : 'NORMAL VOLATILITY'}: ${volatilityWarning}`;

  return {
    primaryTimeframe: '1H',
    h1Bias,
    h1Structure: h1Snap.trendStructure,
    h1StructureEvent: h1Snap.latestStructureEvent,
    chochStatus,
    dailyScenario,
    dailySession,
    psychologicalLevels: {
      incrementPoints: 50,
      incrementPips: 500,
      ...psychLevels,
    },
    trendlines,
    fibConfluences,
    closureConfirmation: {
      status: closureStatus,
      detail: closureDetail,
    },
    volatilityFilter: {
      status: extremeVolatility ? 'Elevated Fakeout Risk' : 'Normal',
      spikeRatio,
      openGapAlert,
      warning: volatilityWarning,
    },
    sections: {
      currentBiasAndScenario,
      keyLevelsAndConfluence,
      confirmationStatus,
      riskAndVolatilityWarning,
    },
  };
}
