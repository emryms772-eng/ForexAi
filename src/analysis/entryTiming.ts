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
        headline: 'ABORT — Sniper Stop Invalidated',
        detail: `Live price (${price.toFixed(d)}) broke past structural SL (${plan.stopLoss.toFixed(
          d
        )}). Stay out and wait ${countdown} for the ${execTf} close before rescanning.`,
        closeCondition: `Invalidated beyond ${plan.stopLoss.toFixed(
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
          headline: 'DO NOT CHASE — Sniper Entry Missed',
          detail: `Live price (${price.toFixed(
            d
          )}) already ran over 65% toward TP1 (${plan.takeProfit1.toFixed(
            d
          )}). Never chase—wait for a retest of ${zone.low.toFixed(
            d
          )}–${zone.high.toFixed(d)} or the next closed ${execTf} sniper setup.`,
          closeCondition: `R:R compromised · Next ${execTf} close in ${countdown}`,
          candleCloseTime: progress.nextCloseSec,
          candleTimeframe: execTf,
        };
      }
    }

    // 3. Check if price stretched outside entry window OR current forming bar is fighting direction
    const stretchedBeyondEntry = isBuy
      ? price > Math.max(zone.high, entryRef) + riskDist * 0.35
      : price < Math.min(zone.low, entryRef) - riskDist * 0.35;

    const pushingWrongSideOfEntry = isBuy
      ? price < entryRef - riskDist * (formingCandle ? 0.06 : 0.1) &&
        (!formingCandle || formingCandle.close <= formingCandle.open)
      : price > entryRef + riskDist * (formingCandle ? 0.06 : 0.1) &&
        (!formingCandle || formingCandle.close >= formingCandle.open);

    const strongCounterForming =
      formingCandle &&
      (isBuy
        ? formingCandle.close < formingCandle.open &&
          formingCandle.open - formingCandle.close >= riskDist * 0.25
        : formingCandle.close > formingCandle.open &&
          formingCandle.close - formingCandle.open >= riskDist * 0.25);

    if (stretchedBeyondEntry || pushingWrongSideOfEntry || strongCounterForming) {
      return {
        decision: 'WAIT_CANDLE_CLOSE',
        headline: `WAIT FOR ${execTf} CLOSE (${countdown}) — DO NOT FORCE`,
        detail: pushingWrongSideOfEntry
          ? `The ${closedLabel} bar flagged ${plan.signal}, but live price (${price.toFixed(
              d
            )}) is trading ${isBuy ? 'below' : 'above'} entry (${entryRef.toFixed(
              d
            )}). Wait ${countdown} for the ${execTf} candle to close ${
              isBuy ? 'bullish at/above' : 'bearish at/below'
            } ${entryRef.toFixed(d)} holding SL ${plan.stopLoss.toFixed(d)}.`
          : strongCounterForming
          ? `The ${closedLabel} sniper bar confirmed ${plan.signal}, but the forming ${execTf} bar is pulling back against it. Wait ${countdown} for candle close confirmation near ${entryRef.toFixed(
              d
            )}.`
          : `Live price (${price.toFixed(
              d
            )}) stretched outside the ${entryRef.toFixed(
              d
            )} sniper zone. Wait ${countdown} for ${execTf} close or pullback into ${zone.low.toFixed(
              d
            )}–${zone.high.toFixed(d)}.`,
        closeCondition: isBuy
          ? `Enter only if ${execTf} closes bullish at/above ${entryRef.toFixed(
              d
            )} holding SL ${plan.stopLoss.toFixed(d)}`
          : `Enter only if ${execTf} closes bearish at/below ${entryRef.toFixed(
              d
            )} holding SL ${plan.stopLoss.toFixed(d)}`,
        candleCloseTime: progress.nextCloseSec,
        candleTimeframe: execTf,
      };
    }

    // 4. Closed-bar confirmed AND live price is inside sniper entry window -> FIRE NOW
    return {
      decision: 'ENTER_NOW',
      headline: `FIRE ${plan.signal} NOW — Sniper Confirmed on Closed ${execTf} Bar`,
      detail: `Zero second thoughts: ${closedLabel} closed ${execTf} bar locked all A+ sniper confluences (non-repainting). Price (${price.toFixed(
        d
      )}) is inside the sniper entry window (${zone.low.toFixed(
        d
      )}–${zone.high.toFixed(d)}) with SL ${plan.stopLoss.toFixed(d)}.`,
      closeCondition: `Locked closed bar · Non-repainting · Next ${execTf} close in ${countdown}`,
      candleCloseTime: progress.nextCloseSec,
      candleTimeframe: execTf,
    };
  }

  // Signal is WAIT — determine whether setup is actively forming right now (WAIT FOR CANDLE CLOSE) or stay flat
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
      headline: `SNIPER FORMING — WAIT ${countdown} FOR ${execTf} CLOSE`,
      detail: `Price (${price.toFixed(
        d
      )}) is testing the ${execTf} sniper OTE zone (${zone.low.toFixed(
        d
      )}–${zone.high.toFixed(
        d
      )}), but the bar has NOT closed yet. Wait ${countdown} for the closed candle so you never enter on a wick fakeout.`,
      closeCondition: isBullWatch
        ? `Fires BUY only after ${execTf} closes bullish inside/above ${entryRef.toFixed(
            d
          )} holding ${plan.stopLoss.toFixed(d)}`
        : `Fires SELL only after ${execTf} closes bearish inside/below ${entryRef.toFixed(
            d
          )} holding ${plan.stopLoss.toFixed(d)}`,
      candleCloseTime: progress.nextCloseSec,
      candleTimeframe: execTf,
    };
  }

  return {
    decision: 'WAIT_FOR_SETUP',
    headline: 'NO SNIPER ENTRY — STAY FLAT',
    detail: `No A+ sniper confirmation on this closed ${execTf} bar (${price.toFixed(
      d
    )}). Stay completely flat until price reaches ${zone.low.toFixed(
      d
    )}–${zone.high.toFixed(d)} with aligned 4H/1H structure and closes a ${execTf} confirmation bar.`,
    closeCondition: `Next ${execTf} bar close in ${countdown} · Auto-rescans on close`,
    candleCloseTime: progress.nextCloseSec,
    candleTimeframe: execTf,
  };
}
