import type {
  CandlePatternEvent,
  KeyLevel,
  OHLCVCandle,
  PriceActionAnalysisSummary,
  PriceActionMarker,
  PriceActionSnapshot,
  PriceActionZone,
} from '../types/market.ts';

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

interface SwingPivot {
  index: number;
  confirmIndex: number; // Strictly causal: bar index when pivot is confirmed without lookahead
  time: number;
  price: number;
  kind: 'high' | 'low';
}

const PIVOT_LOOKBACK = 3;

function detectSwingPivots(
  candles: OHLCVCandle[],
  lookback = PIVOT_LOOKBACK
): SwingPivot[] {
  const pivots: SwingPivot[] = [];
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

function computeAverageCandleRange(candles: OHLCVCandle[], lookback = 20): number {
  if (candles.length === 0) return 0;
  const slice = candles.slice(-Math.min(lookback, candles.length));
  const sum = slice.reduce((acc, c) => acc + Math.max(c.high - c.low, 0), 0);
  return sum / slice.length;
}

function clusterSupportResistance(
  candles: OHLCVCandle[],
  pivots: SwingPivot[],
  spotPrice: number,
  avgRange: number,
  decimals: number
): KeyLevel[] {
  const tolerance = Math.max(avgRange * 0.55, spotPrice * 0.0008);
  const clusters: Array<{ prices: number[]; touches: number }> = [];

  for (const pivot of pivots) {
    let matched = false;
    for (const cluster of clusters) {
      const avg =
        cluster.prices.reduce((acc, p) => acc + p, 0) / cluster.prices.length;
      if (Math.abs(pivot.price - avg) <= tolerance) {
        cluster.prices.push(pivot.price);
        cluster.touches += 1;
        matched = true;
        break;
      }
    }
    if (!matched) {
      clusters.push({ prices: [pivot.price], touches: 1 });
    }
  }

  const levels: KeyLevel[] = clusters
    .map((cluster, idx) => {
      const avgPrice =
        cluster.prices.reduce((acc, p) => acc + p, 0) / cluster.prices.length;
      let wickReactions = 0;
      for (const c of candles.slice(-90)) {
        if (
          c.low - tolerance * 0.25 <= avgPrice &&
          c.high + tolerance * 0.25 >= avgPrice
        ) {
          wickReactions += 1;
        }
      }
      const touches = Math.max(cluster.touches, Math.min(wickReactions, 7));
      const price = roundToDecimals(avgPrice, decimals);
      const distancePct = ((price - spotPrice) / Math.max(spotPrice, 1e-9)) * 100;
      return {
        id: `sr-${idx}-${price}`,
        price,
        type: price >= spotPrice ? ('Resistance' as const) : ('Support' as const),
        strength: touches >= 3 ? ('Major' as const) : ('Minor' as const),
        touches,
        distancePct: Math.round(distancePct * 100) / 100,
      };
    })
    .filter((lvl) => Math.abs(lvl.distancePct) > 0.015);

  const supports = levels
    .filter((l) => l.type === 'Support')
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);

  const resistances = levels
    .filter((l) => l.type === 'Resistance')
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);

  return [...resistances.reverse(), ...supports];
}

function detectFairValueGapsAndOrderBlocks(
  candles: OHLCVCandle[],
  avgRange: number,
  spotPrice: number,
  decimals: number
): PriceActionZone[] {
  const zones: PriceActionZone[] = [];
  const startIdx = Math.max(2, candles.length - 70);

  for (let i = startIdx; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];
    const currBody = Math.abs(curr.close - curr.open);

    // Bullish Fair Value Gap (confirmed only after candle i+1 has closed)
    if (prev.high < next.low && next.low - prev.high > avgRange * 0.15) {
      const fvgLow = roundToDecimals(prev.high, decimals);
      const fvgHigh = roundToDecimals(next.low, decimals);
      const subsequent = candles.slice(i + 2);
      const mitigated = subsequent.some((b) => b.low <= fvgLow);
      if (!mitigated) {
        const midpoint = roundToDecimals((fvgLow + fvgHigh) / 2, decimals);
        zones.push({
          id: `bfvg-${curr.time}`,
          kind: 'Bullish FVG',
          low: fvgLow,
          high: fvgHigh,
          midpoint,
          time: curr.time,
          mitigated: false,
          distancePct:
            Math.round(((midpoint - spotPrice) / Math.max(spotPrice, 1e-9)) * 10000) /
            100,
        });
      }
    }

    // Bearish Fair Value Gap (confirmed only after candle i+1 has closed)
    if (prev.low > next.high && prev.low - next.high > avgRange * 0.15) {
      const fvgLow = roundToDecimals(next.high, decimals);
      const fvgHigh = roundToDecimals(prev.low, decimals);
      const subsequent = candles.slice(i + 2);
      const mitigated = subsequent.some((b) => b.high >= fvgHigh);
      if (!mitigated) {
        const midpoint = roundToDecimals((fvgLow + fvgHigh) / 2, decimals);
        zones.push({
          id: `sfvg-${curr.time}`,
          kind: 'Bearish FVG',
          low: fvgLow,
          high: fvgHigh,
          midpoint,
          time: curr.time,
          mitigated: false,
          distancePct:
            Math.round(((midpoint - spotPrice) / Math.max(spotPrice, 1e-9)) * 10000) /
            100,
        });
      }
    }

    // Bullish Demand Order Block (displacement candle curr is closed)
    if (
      prev.close < prev.open &&
      curr.close > curr.open &&
      currBody >= avgRange * 1.15 &&
      curr.close > prev.high
    ) {
      const obLow = roundToDecimals(prev.low, decimals);
      const obHigh = roundToDecimals(prev.high, decimals);
      const subsequent = candles.slice(i + 1);
      const invalidated = subsequent.some((b) => b.close < obLow);
      if (!invalidated && spotPrice >= obLow) {
        const midpoint = roundToDecimals((obLow + obHigh) / 2, decimals);
        zones.push({
          id: `dob-${prev.time}`,
          kind: 'Demand OB',
          low: obLow,
          high: obHigh,
          midpoint,
          time: prev.time,
          mitigated: false,
          distancePct:
            Math.round(((midpoint - spotPrice) / Math.max(spotPrice, 1e-9)) * 10000) /
            100,
        });
      }
    }

    // Bearish Supply Order Block (displacement candle curr is closed)
    if (
      prev.close > prev.open &&
      curr.close < curr.open &&
      currBody >= avgRange * 1.15 &&
      curr.close < prev.low
    ) {
      const obLow = roundToDecimals(prev.low, decimals);
      const obHigh = roundToDecimals(prev.high, decimals);
      const subsequent = candles.slice(i + 1);
      const invalidated = subsequent.some((b) => b.close > obHigh);
      if (!invalidated && spotPrice <= obHigh) {
        const midpoint = roundToDecimals((obLow + obHigh) / 2, decimals);
        zones.push({
          id: `sob-${prev.time}`,
          kind: 'Supply OB',
          low: obLow,
          high: obHigh,
          midpoint,
          time: prev.time,
          mitigated: false,
          distancePct:
            Math.round(((midpoint - spotPrice) / Math.max(spotPrice, 1e-9)) * 10000) /
            100,
        });
      }
    }
  }

  return zones
    .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
    .slice(0, 6);
}

function detectCandlestickPatternsAndSweeps(
  candles: OHLCVCandle[],
  pivots: SwingPivot[],
  avgRange: number
): {
  patterns: CandlePatternEvent[];
  markers: PriceActionMarker[];
  recentSweep: PriceActionSnapshot['recentSweep'];
} {
  const patterns: CandlePatternEvent[] = [];
  const markers: PriceActionMarker[] = [];
  let recentSweep: PriceActionSnapshot['recentSweep'] = 'None';

  const start = Math.max(2, candles.length - 18);
  const swingHighs = pivots.filter((p) => p.kind === 'high');
  const swingLows = pivots.filter((p) => p.kind === 'low');

  for (let i = start; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const range = Math.max(curr.high - curr.low, 1e-9);
    const body = Math.abs(curr.close - curr.open);
    const upperWick = curr.high - Math.max(curr.open, curr.close);
    const lowerWick = Math.min(curr.open, curr.close) - curr.low;

    // Strictly causal: only compare against pivots whose confirmation bar already closed BEFORE bar i
    const sweptHigh = swingHighs.find(
      (sh) =>
        sh.confirmIndex < i &&
        curr.high > sh.price &&
        curr.close < sh.price &&
        upperWick > body * 0.6
    );
    if (sweptHigh) {
      recentSweep = 'Buy-Side Sweep (Bearish)';
      patterns.push({
        time: curr.time,
        name: 'Buy-Side Liquidity Sweep',
        bias: 'Bearish',
        description: `Closed bar wicked above confirmed swing high (${sweptHigh.price}) and rejected back below.`,
      });
      markers.push({
        time: curr.time,
        position: 'aboveBar',
        color: '#F59E0B',
        shape: 'arrowDown',
        text: 'SWEEP',
        kind: 'Sweep',
      });
    }

    const sweptLow = swingLows.find(
      (sl) =>
        sl.confirmIndex < i &&
        curr.low < sl.price &&
        curr.close > sl.price &&
        lowerWick > body * 0.6
    );
    if (sweptLow) {
      recentSweep = 'Sell-Side Sweep (Bullish)';
      patterns.push({
        time: curr.time,
        name: 'Sell-Side Liquidity Sweep',
        bias: 'Bullish',
        description: `Closed bar swept below confirmed swing low (${sweptLow.price}) and reclaimed inside.`,
      });
      markers.push({
        time: curr.time,
        position: 'belowBar',
        color: '#38BDF8',
        shape: 'arrowUp',
        text: 'SWEEP',
        kind: 'Sweep',
      });
    }

    // Bullish Engulfing (closed bar)
    if (
      prev.close < prev.open &&
      curr.close > curr.open &&
      curr.open <= prev.close &&
      curr.close >= prev.open &&
      body > avgRange * 0.45
    ) {
      patterns.push({
        time: curr.time,
        name: 'Bullish Engulfing',
        bias: 'Bullish',
        description: 'Confirmed demand candle engulfed prior bearish body.',
      });
      markers.push({
        time: curr.time,
        position: 'belowBar',
        color: '#10B981',
        shape: 'arrowUp',
        text: 'ENG',
        kind: 'Engulfing',
      });
    }

    // Bearish Engulfing (closed bar)
    if (
      prev.close > prev.open &&
      curr.close < curr.open &&
      curr.open >= prev.close &&
      curr.close <= prev.open &&
      body > avgRange * 0.45
    ) {
      patterns.push({
        time: curr.time,
        name: 'Bearish Engulfing',
        bias: 'Bearish',
        description: 'Confirmed supply candle engulfed prior bullish body.',
      });
      markers.push({
        time: curr.time,
        position: 'aboveBar',
        color: '#EF4444',
        shape: 'arrowDown',
        text: 'ENG',
        kind: 'Engulfing',
      });
    }

    // Bullish Rejection Pin Bar (closed bar)
    if (
      lowerWick >= Math.max(body * 2.0, range * 0.58) &&
      upperWick <= range * 0.2
    ) {
      patterns.push({
        time: curr.time,
        name: 'Bullish Rejection Pin Bar',
        bias: 'Bullish',
        description: 'Confirmed lower rejection wick showing demand absorption.',
      });
      markers.push({
        time: curr.time,
        position: 'belowBar',
        color: '#10B981',
        shape: 'circle',
        text: 'PIN',
        kind: 'PinBar',
      });
    }

    // Bearish Rejection Pin Bar (closed bar)
    if (
      upperWick >= Math.max(body * 2.0, range * 0.58) &&
      lowerWick <= range * 0.2
    ) {
      patterns.push({
        time: curr.time,
        name: 'Bearish Rejection Pin Bar',
        bias: 'Bearish',
        description: 'Confirmed upper rejection wick showing supply absorption.',
      });
      markers.push({
        time: curr.time,
        position: 'aboveBar',
        color: '#EF4444',
        shape: 'circle',
        text: 'PIN',
        kind: 'PinBar',
      });
    }

    // Inside Bar Compression (closed bar)
    if (curr.high < prev.high && curr.low > prev.low) {
      patterns.push({
        time: curr.time,
        name: 'Inside Bar Compression',
        bias: 'Neutral',
        description: 'Range contraction inside prior closed bar.',
      });
    }
  }

  return {
    patterns: patterns.slice(-8).reverse(),
    markers,
    recentSweep,
  };
}

export interface AnalyzePriceActionOptions {
  /**
   * Non-repainting guard: when true (default for live charts & signals),
   * excludes the currently forming candle from marker/BOS/pattern detection
   * so confirmed signals never appear and disappear mid-candle.
   */
  excludeFormingBar?: boolean;
}

export function analyzePriceAction(
  candles: OHLCVCandle[],
  decimals: number,
  options: AnalyzePriceActionOptions = {}
): PriceActionAnalysisSummary {
  const excludeFormingBar = options.excludeFormingBar ?? true;
  const evalCandles =
    excludeFormingBar && candles.length > 10 ? candles.slice(0, -1) : candles;

  if (evalCandles.length === 0) {
    return {
      levels: [],
      zones: [],
      markers: [],
      recentPatterns: [],
      snapshot: {
        trendStructure: 'Ranging / Choppy',
        latestStructureEvent: 'Inside Range',
        dealingRangeHigh: 0,
        dealingRangeLow: 0,
        equilibriumPrice: 0,
        rangePositionPct: 50,
        rangeZone: 'Equilibrium',
        avgCandleRange: 0,
        avgRangePct: 0,
        recentSweep: 'None',
        latestPattern: null,
        buyerPressurePct: 50,
        unmitigatedFvgCount: 0,
        activeOrderBlockCount: 0,
      },
    };
  }

  const lastSpotClose = candles[candles.length - 1].close;
  const avgRangeRaw = computeAverageCandleRange(evalCandles, 20);
  const avgCandleRange = roundToDecimals(avgRangeRaw, decimals);
  const avgRangePct =
    Math.round((avgRangeRaw / Math.max(lastSpotClose, 1e-9)) * 10000) / 100;

  const pivots = detectSwingPivots(evalCandles, PIVOT_LOOKBACK);
  const swingHighs = pivots.filter((p) => p.kind === 'high');
  const swingLows = pivots.filter((p) => p.kind === 'low');

  const lookbackHigh =
    swingHighs.length > 0
      ? Math.max(...swingHighs.slice(-3).map((s) => s.price))
      : Math.max(...evalCandles.slice(-40).map((c) => c.high));
  const lookbackLow =
    swingLows.length > 0
      ? Math.min(...swingLows.slice(-3).map((s) => s.price))
      : Math.min(...evalCandles.slice(-40).map((c) => c.low));

  const dealingRangeHigh = roundToDecimals(lookbackHigh, decimals);
  const dealingRangeLow = roundToDecimals(lookbackLow, decimals);
  const equilibriumPrice = roundToDecimals(
    (dealingRangeHigh + dealingRangeLow) / 2,
    decimals
  );

  const rangeSpan = Math.max(dealingRangeHigh - dealingRangeLow, 1e-9);
  const rawPosPct = ((lastSpotClose - dealingRangeLow) / rangeSpan) * 100;
  const rangePositionPct =
    Math.round(Math.min(100, Math.max(0, rawPosPct)) * 10) / 10;

  let rangeZone: PriceActionSnapshot['rangeZone'] = 'Equilibrium';
  if (rangePositionPct <= 42) rangeZone = 'Discount';
  else if (rangePositionPct >= 58) rangeZone = 'Premium';

  // Causal HH/HL vs LH/LL classification and BOS/CHoCH on closed bars only
  let trendStructure: PriceActionSnapshot['trendStructure'] = 'Ranging / Choppy';
  let latestStructureEvent: PriceActionSnapshot['latestStructureEvent'] =
    'Inside Range';
  const structureMarkers: PriceActionMarker[] = [];

  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const prevHigh = swingHighs[swingHighs.length - 2];
    const lastHigh = swingHighs[swingHighs.length - 1];
    const prevLow = swingLows[swingLows.length - 2];
    const lastLow = swingLows[swingLows.length - 1];

    if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price) {
      trendStructure = 'Bullish (HH / HL)';
    } else if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price) {
      trendStructure = 'Bearish (LH / LL)';
    }

    const tailStart = Math.max(0, evalCandles.length - 12);
    let bosUpBar: OHLCVCandle | undefined;
    let bosDownBar: OHLCVCandle | undefined;

    for (let idx = tailStart; idx < evalCandles.length; idx++) {
      const bar = evalCandles[idx];
      if (idx > lastHigh.confirmIndex && bar.close > lastHigh.price && !bosUpBar) {
        bosUpBar = bar;
      }
      if (idx > lastLow.confirmIndex && bar.close < lastLow.price && !bosDownBar) {
        bosDownBar = bar;
      }
    }

    if (bosUpBar && (!bosDownBar || bosUpBar.time >= bosDownBar.time)) {
      const isReversal = trendStructure === 'Bearish (LH / LL)';
      latestStructureEvent = isReversal ? 'Bullish CHoCH' : 'Bullish BOS';
      structureMarkers.push({
        time: bosUpBar.time,
        position: 'belowBar',
        color: '#10B981',
        shape: 'arrowUp',
        text: isReversal ? 'CHoCH' : 'BOS',
        kind: isReversal ? 'CHoCH' : 'BOS',
      });
    } else if (bosDownBar) {
      const isReversal = trendStructure === 'Bullish (HH / HL)';
      latestStructureEvent = isReversal ? 'Bearish CHoCH' : 'Bearish BOS';
      structureMarkers.push({
        time: bosDownBar.time,
        position: 'aboveBar',
        color: '#EF4444',
        shape: 'arrowDown',
        text: isReversal ? 'CHoCH' : 'BOS',
        kind: isReversal ? 'CHoCH' : 'BOS',
      });
    }
  }

  // Buyer vs Seller candle close pressure over last 12 closed bars
  const pressureSlice = evalCandles.slice(-12);
  let bullBodySum = 0;
  let totalBodySum = 0;
  for (const c of pressureSlice) {
    const body = Math.abs(c.close - c.open);
    totalBodySum += body;
    if (c.close >= c.open) bullBodySum += body;
  }
  const buyerPressurePct =
    totalBodySum > 0 ? Math.round((bullBodySum / totalBodySum) * 100) : 50;

  const levels = clusterSupportResistance(
    evalCandles,
    pivots,
    lastSpotClose,
    avgRangeRaw,
    decimals
  );
  const zones = detectFairValueGapsAndOrderBlocks(
    evalCandles,
    avgRangeRaw,
    lastSpotClose,
    decimals
  );
  const patternResult = detectCandlestickPatternsAndSweeps(
    evalCandles,
    pivots,
    avgRangeRaw
  );

  const allMarkers = [...structureMarkers, ...patternResult.markers].sort(
    (a, b) => a.time - b.time
  );

  return {
    snapshot: {
      trendStructure,
      latestStructureEvent,
      dealingRangeHigh,
      dealingRangeLow,
      equilibriumPrice,
      rangePositionPct,
      rangeZone,
      avgCandleRange,
      avgRangePct,
      recentSweep: patternResult.recentSweep,
      latestPattern: patternResult.patterns[0] ?? null,
      buyerPressurePct,
      unmitigatedFvgCount: zones.filter((z) => z.kind.includes('FVG')).length,
      activeOrderBlockCount: zones.filter((z) => z.kind.includes('OB')).length,
    },
    levels,
    zones,
    markers: allMarkers,
    recentPatterns: patternResult.patterns,
  };
}
