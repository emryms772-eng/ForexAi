import { getInstrumentBySymbol } from '../config/instruments.ts';
import type {
  AIPriceActionSignal,
  OHLCVCandle,
  SignalEntryTiming,
  Timeframe,
} from '../types/market.ts';
import { getCandleProgress } from './priceAction.ts';

export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hrs > 0) {
    return `${hrs}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

export function formatUtcTime(unixSec: number): string {
  if (!Number.isFinite(unixSec) || unixSec <= 0) return 'Closed Bar';
  return new Date(unixSec * 1000).toISOString().slice(11, 16) + ' UTC';
}

function parseEntryZone(
  entryZone: string,
  fallbackPrice: number
): { low: number; high: number } {
  const matches = String(entryZone ?? '').match(/\d+(?:\.\d+)?/g);
  if (matches && matches.length >= 2) {
    const a = Number(matches[0]);
    const b = Number(matches[1]);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
      return { low: Math.min(a, b), high: Math.max(a, b) };
    }
  }
  return { low: fallbackPrice, high: fallbackPrice };
}

/**
 * Evaluates live price and the unclosed forming candle against a locked closed-bar signal
 * to tell the trader unambiguously: ENTER NOW vs WAIT FOR CANDLE CLOSE vs STAY OUT.
 * Never mutates or repaints the locked signal itself.
 */
export function evaluateSignalEntryTiming(params: {
  signal: AIPriceActionSignal;
  livePrice: number;
  formingCandle?: OHLCVCandle | null;
  activeChartTimeframe?: Timeframe;
  nowSec?: number;
}): SignalEntryTiming {
  const {
    signal,
    livePrice,
    formingCandle,
    nowSec = Math.floor(Date.now() / 1000),
  } = params;

  const instrument = getInstrumentBySymbol(signal.symbol);
  const d = instrument.decimals;
  const execTf: Timeframe = signal.signalTimeframe || '5M';
  const progress = getCandleProgress(execTf, nowSec);
  const countdown = formatCountdown(progress.secondsRemaining);

  const { plan } = signal;
  const price =
    Number.isFinite(livePrice) && livePrice > 0
      ? livePrice
      : signal.spotPriceAtSignal;
  const zone = parseEntryZone(plan.entryZone, plan.entryPrice || price);
  const entryRef = plan.entryPrice > 0 ? plan.entryPrice : price;
  const riskDist = Math.max(
    Math.abs(entryRef - plan.stopLoss),
    price * 0.0008
  );

  const closedLabel =
    signal.confirmedBarTime > 0
      ? formatUtcTime(signal.confirmedBarTime)
      : 'recent closed bar';

  // Active BUY or SELL already locked on a closed 5M candle
  if (plan.signal === 'BUY' || plan.signal === 'SELL') {
    const isBuy = plan.signal === 'BUY';

    // 1. Check SL invalidation on live price
    if (
      plan.stopLoss > 0 &&
      ((isBuy && price <= plan.stopLoss) || (!isBuy && price >= plan.stopLoss))
    ) {
      return {
        decision: 'INVALIDATED',
        headline: 'DO NOT ENTER — Stop Loss Invalidated',
        detail: `Live price (${price.toFixed(d)}) crossed past structural SL (${plan.stopLoss.toFixed(
          d
        )}). Wait ${countdown} for the current ${execTf} candle to close before rescanning.`,
        closeCondition: `Invalidated below/above ${plan.stopLoss.toFixed(
          d
        )} · Next ${execTf} close in ${countdown}`,
        candleCloseTime: progress.nextCloseSec,
        candleTimeframe: execTf,
      };
    }

    // 2. Check if move already ran >= 65% to TP1
    if (plan.takeProfit1 > 0) {
      const tp1Dist = Math.abs(plan.takeProfit1 - entryRef);
      const progressTowardTp1 = isBuy ? price - entryRef : entryRef - price;
      if (tp1Dist > 0 && progressTowardTp1 >= tp1Dist * 0.65) {
        return {
          decision: 'MISSED',
          headline: 'DO NOT CHASE — Price Already Near TP1',
          detail: `Live price (${price.toFixed(
            d
          )}) has already covered most of the move toward TP1 (${plan.takeProfit1.toFixed(
            d
          )}). Wait for a clean pullback into ${zone.low.toFixed(
            d
          )}–${zone.high.toFixed(d)} or the next closed ${execTf} setup.`,
          closeCondition: `Chasing here ruins R:R · Next ${execTf} bar closes in ${countdown}`,
          candleCloseTime: progress.nextCloseSec,
          candleTimeframe: execTf,
        };
      }
    }

    // 3. Check if price stretched outside entry window OR current forming bar is fighting direction
    const stretchedBeyondEntry = isBuy
      ? price > Math.max(zone.high, entryRef) + riskDist * 0.38
      : price < Math.min(zone.low, entryRef) - riskDist * 0.38;

    const strongCounterForming =
      formingCandle &&
      (isBuy
        ? formingCandle.close < formingCandle.open &&
          formingCandle.open - formingCandle.close >= riskDist * 0.42
        : formingCandle.close > formingCandle.open &&
          formingCandle.close - formingCandle.open >= riskDist * 0.42);

    if (stretchedBeyondEntry || strongCounterForming) {
      return {
        decision: 'WAIT_CANDLE_CLOSE',
        headline: `WAIT FOR ${execTf} CANDLE CLOSE (${countdown})`,
        detail: strongCounterForming
          ? `The ${closedLabel} bar confirmed ${plan.signal}, but the currently forming ${execTf} candle is pulling back strongly. Wait ${countdown} for it to close above/below ${entryRef.toFixed(
              d
            )} to verify momentum holds.`
          : `Live price (${price.toFixed(
              d
            )}) moved slightly past the ideal ${entryRef.toFixed(
              d
            )} entry. Wait ${countdown} for the ${execTf} candle close or a pullback into ${zone.low.toFixed(
              d
            )}–${zone.high.toFixed(d)}.`,
        closeCondition: isBuy
          ? `Confirm entry if ${execTf} bar closes bullish near ${zone.low.toFixed(
              d
            )}–${zone.high.toFixed(d)} above ${plan.stopLoss.toFixed(d)}`
          : `Confirm entry if ${execTf} bar closes bearish near ${zone.low.toFixed(
              d
            )}–${zone.high.toFixed(d)} below ${plan.stopLoss.toFixed(d)}`,
        candleCloseTime: progress.nextCloseSec,
        candleTimeframe: execTf,
      };
    }

    // 4. Closed-bar confirmed AND live price is inside/near entry window -> ENTER NOW
    return {
      decision: 'ENTER_NOW',
      headline: `ENTER NOW — ${plan.signal} Confirmed on Closed ${execTf} Bar`,
      detail: `Confirmed on the ${closedLabel} closed ${execTf} candle (non-repainting). Live price (${price.toFixed(
        d
      )}) is inside the valid entry window (${zone.low.toFixed(
        d
      )}–${zone.high.toFixed(d)}) with SL at ${plan.stopLoss.toFixed(d)}.`,
      closeCondition: `Closed-bar confirmation locked · Next ${execTf} bar closes in ${countdown}`,
      candleCloseTime: progress.nextCloseSec,
      candleTimeframe: execTf,
    };
  }

  // Signal is WAIT — determine whether setup is actively forming right now (WAIT FOR CANDLE CLOSE) or still away (STAY OUT)
  const isBullWatch = signal.bias !== 'Bearish';
  const watchDist = Math.abs(price - entryRef);
  const inOrTestingZone =
    (price >= zone.low - riskDist * 0.35 &&
      price <= zone.high + riskDist * 0.35) ||
    watchDist <= riskDist * 0.45 ||
    (formingCandle &&
      formingCandle.low <= zone.high + riskDist * 0.25 &&
      formingCandle.high >= zone.low - riskDist * 0.25);

  if (inOrTestingZone) {
    return {
      decision: 'WAIT_CANDLE_CLOSE',
      headline: `WAIT FOR ${execTf} CANDLE CLOSE (${countdown})`,
      detail: `Price (${price.toFixed(
        d
      )}) is testing the ${execTf} watch zone (${zone.low.toFixed(
        d
      )}–${zone.high.toFixed(
        d
      )}) right now, but the candle has NOT closed yet. Do not enter early—wait ${countdown} for the ${execTf} close to confirm so you avoid a wick fakeout.`,
      closeCondition: isBullWatch
        ? `Enter BUY only after ${execTf} candle closes bullish inside/above ${entryRef.toFixed(
            d
          )} holding ${plan.stopLoss.toFixed(d)}`
        : `Enter SELL only after ${execTf} candle closes bearish inside/below ${entryRef.toFixed(
            d
          )} holding ${plan.stopLoss.toFixed(d)}`,
      candleCloseTime: progress.nextCloseSec,
      candleTimeframe: execTf,
    };
  }

  return {
    decision: 'WAIT_FOR_SETUP',
    headline: 'STAY OUT — Wait for Zone & Candle Close',
    detail: `Live price (${price.toFixed(
      d
    )}) has not reached the confirmed ${execTf} trigger zone (${zone.low.toFixed(
      d
    )}–${zone.high.toFixed(
      d
    )}) or 4H/1H bias is conflicted. Stay patient until price reaches the zone and closes a ${execTf} confirmation candle.`,
    closeCondition: `Next ${execTf} candle close in ${countdown} · Re-evaluates automatically on candle close`,
    candleCloseTime: progress.nextCloseSec,
    candleTimeframe: execTf,
  };
}
