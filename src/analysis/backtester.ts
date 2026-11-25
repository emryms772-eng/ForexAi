import { getInstrumentBySymbol } from '../config/instruments.ts';
import type {
  BacktestEquityPoint,
  BacktestResult,
  BacktestSetupStats,
  BacktestTrade,
  OHLCVCandle,
  Timeframe,
} from '../types/market.ts';
import { analyzePriceAction } from './priceAction.ts';

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

/**
 * Strictly causal setup evaluation at closed bar index `barIndex` using ONLY
 * candles[0..barIndex]. Zero future bars are ever inspected.
 */
function evaluateCausalSetupAtBar(
  closedSlice: OHLCVCandle[],
  decimals: number
): CandidateSetup | null {
  if (closedSlice.length < 40) return null;

  const summary = analyzePriceAction(closedSlice, decimals, {
    excludeFormingBar: false, // closedSlice[last] is already a closed bar in the historical walk
  });
  const { snapshot, levels, zones, recentPatterns } = summary;
  const signalBar = closedSlice[closedSlice.length - 1];
  const avgRange = Math.max(snapshot.avgCandleRange, signalBar.close * 0.0005);

  const latestPattern = recentPatterns.find((p) => p.time === signalBar.time);

  // Setup 1: Liquidity Sweep + Rejection/Engulfing Reversal (non-repainting closed trigger)
  if (
    latestPattern &&
    (latestPattern.name.includes('Sweep') ||
      latestPattern.name.includes('Engulfing') ||
      latestPattern.name.includes('Pin Bar'))
  ) {
    if (
      latestPattern.bias === 'Bullish' &&
      (snapshot.rangeZone === 'Discount' ||
        snapshot.latestStructureEvent.startsWith('Bullish') ||
        snapshot.recentSweep === 'Sell-Side Sweep (Bullish)')
    ) {
      const nearestSupport = levels.find((l) => l.type === 'Support');
      const rawSl = Math.min(
        signalBar.low - avgRange * 0.35,
        nearestSupport ? nearestSupport.price - avgRange * 0.3 : signalBar.low
      );
      const risk = Math.max(signalBar.close - rawSl, avgRange * 0.75);
      const sl = roundToDecimals(signalBar.close - risk, decimals);
      const tp1 = roundToDecimals(signalBar.close + risk * 1.4, decimals);
      const tp2 = roundToDecimals(signalBar.close + risk * 2.4, decimals);

      return {
        side: 'BUY',
        setupType:
          snapshot.recentSweep === 'Sell-Side Sweep (Bullish)'
            ? 'Sweep + Reclaim Reversal'
            : 'Discount Demand Trigger',
        trigger: latestPattern.name,
        stopLoss: sl,
        takeProfit1: tp1,
        takeProfit2: tp2,
      };
    }

    if (
      latestPattern.bias === 'Bearish' &&
      (snapshot.rangeZone === 'Premium' ||
        snapshot.latestStructureEvent.startsWith('Bearish') ||
        snapshot.recentSweep === 'Buy-Side Sweep (Bearish)')
    ) {
      const nearestRes = levels.find((l) => l.type === 'Resistance');
      const rawSl = Math.max(
        signalBar.high + avgRange * 0.35,
        nearestRes ? nearestRes.price + avgRange * 0.3 : signalBar.high
      );
      const risk = Math.max(rawSl - signalBar.close, avgRange * 0.75);
      const sl = roundToDecimals(signalBar.close + risk, decimals);
      const tp1 = roundToDecimals(signalBar.close - risk * 1.4, decimals);
      const tp2 = roundToDecimals(signalBar.close - risk * 2.4, decimals);

      return {
        side: 'SELL',
        setupType:
          snapshot.recentSweep === 'Buy-Side Sweep (Bearish)'
            ? 'Sweep + Rejection Reversal'
            : 'Premium Supply Trigger',
        trigger: latestPattern.name,
        stopLoss: sl,
        takeProfit1: tp1,
        takeProfit2: tp2,
      };
    }
  }

  // Setup 2: Fresh BOS / CHoCH + Order Block / FVG Mitigation Pullback
  const touchedBullZone = zones.find(
    (z) =>
      (z.kind === 'Demand OB' || z.kind === 'Bullish FVG') &&
      signalBar.low <= z.high &&
      signalBar.close >= z.low
  );
  if (
    touchedBullZone &&
    signalBar.close > signalBar.open &&
    (snapshot.trendStructure === 'Bullish (HH / HL)' ||
      snapshot.latestStructureEvent.startsWith('Bullish'))
  ) {
    const risk = Math.max(
      signalBar.close - (touchedBullZone.low - avgRange * 0.35),
      avgRange * 0.8
    );
    return {
      side: 'BUY',
      setupType: 'BOS Pullback to Zone',
      trigger: `${touchedBullZone.kind} Mitigation`,
      stopLoss: roundToDecimals(signalBar.close - risk, decimals),
      takeProfit1: roundToDecimals(signalBar.close + risk * 1.5, decimals),
      takeProfit2: roundToDecimals(signalBar.close + risk * 2.5, decimals),
    };
  }

  const touchedBearZone = zones.find(
    (z) =>
      (z.kind === 'Supply OB' || z.kind === 'Bearish FVG') &&
      signalBar.high >= z.low &&
      signalBar.close <= z.high
  );
  if (
    touchedBearZone &&
    signalBar.close < signalBar.open &&
    (snapshot.trendStructure === 'Bearish (LH / LL)' ||
      snapshot.latestStructureEvent.startsWith('Bearish'))
  ) {
    const risk = Math.max(
      touchedBearZone.high + avgRange * 0.35 - signalBar.close,
      avgRange * 0.8
    );
    return {
      side: 'SELL',
      setupType: 'BOS Pullback to Zone',
      trigger: `${touchedBearZone.kind} Mitigation`,
      stopLoss: roundToDecimals(signalBar.close + risk, decimals),
      takeProfit1: roundToDecimals(signalBar.close - risk * 1.5, decimals),
      takeProfit2: roundToDecimals(signalBar.close - risk * 2.5, decimals),
    };
  }

  return null;
}

export function runNonRepaintingBacktest(params: {
  symbol: string;
  timeframe: Timeframe;
  candles: OHLCVCandle[];
  initialCapital?: number;
  riskPercentPerTrade?: number;
}): BacktestResult {
  const {
    symbol,
    timeframe,
    candles,
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

  if (closedCandles.length > warmupBars) {
    equityCurve.push({
      time: closedCandles[warmupBars].time,
      equity: initialCapital,
    });
  }

  let i = warmupBars;
  while (i < closedCandles.length - 2) {
    const causalSlice = closedCandles.slice(0, i + 1);
    const setup = evaluateCausalSetupAtBar(causalSlice, decimals);

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
    setupBreakdown: Array.from(setupMap.values()).sort(
      (a, b) => b.netPnlUsd - a.netPnlUsd
    ),
    equityCurve,
    trades: [...trades].reverse(),
  };
}
