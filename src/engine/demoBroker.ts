import { getInstrumentBySymbol } from '../config/instruments';
import type {
  AIPriceActionSignal,
  ClosedDemoTrade,
  DemoAccountState,
  DemoPosition,
  TradeCloseReason,
} from '../types/market';

const STORAGE_KEY = 'stratadesk_demo_account_v1';
export const DEFAULT_DEMO_BALANCE = 10000;

export function createInitialDemoState(): DemoAccountState {
  return {
    initialBalance: DEFAULT_DEMO_BALANCE,
    balance: DEFAULT_DEMO_BALANCE,
    openPositions: [],
    closedTrades: [],
    config: {
      autoTradeEnabled: false,
      autoScanIntervalSec: 0,
      scanScope: 'active',
      riskPercentPerTrade: 1,
    },
  };
}

export function loadDemoAccountState(): DemoAccountState {
  if (typeof window === 'undefined') return createInitialDemoState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialDemoState();
    const parsed = JSON.parse(raw) as Partial<DemoAccountState>;
    const base = createInitialDemoState();
    return {
      initialBalance: parsed.initialBalance ?? base.initialBalance,
      balance:
        typeof parsed.balance === 'number' && Number.isFinite(parsed.balance)
          ? parsed.balance
          : base.balance,
      openPositions: Array.isArray(parsed.openPositions)
        ? parsed.openPositions
        : [],
      closedTrades: Array.isArray(parsed.closedTrades)
        ? parsed.closedTrades
        : [],
      config: {
        ...base.config,
        ...(parsed.config ?? {}),
      },
    };
  } catch {
    return createInitialDemoState();
  }
}

export function saveDemoAccountState(state: DemoAccountState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota issues
  }
}

function roundCurrency(val: number): number {
  return Math.round(val * 100) / 100;
}

function roundPrice(val: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

function computePnl(
  side: 'BUY' | 'SELL',
  entryPrice: number,
  exitPrice: number,
  units: number
): number {
  const diff = side === 'BUY' ? exitPrice - entryPrice : entryPrice - exitPrice;
  return roundCurrency(diff * units);
}

function computePositionUnits(
  balance: number,
  riskPct: number,
  entryPrice: number,
  stopLoss: number
): number {
  const riskUsd = Math.max(balance * (riskPct / 100), 5);
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return Math.max(riskUsd / Math.max(entryPrice * 0.005, 1e-6), 0.01);
  }
  const units = riskUsd / stopDistance;
  // Cap notional exposure at 10x account equity for realistic demo leverage safety
  const maxUnits = (balance * 10) / Math.max(entryPrice, 1e-6);
  const capped = Math.min(units, maxUnits);
  return Math.round(capped * 1000) / 1000;
}

export function executeSignalInDemoAccount(
  state: DemoAccountState,
  signal: AIPriceActionSignal,
  liveSpotPrice: number
): { nextState: DemoAccountState; actionSummary: string } {
  const { plan } = signal;
  if (plan.signal === 'WAIT') {
    return {
      nextState: state,
      actionSummary: `${signal.symbol} signal is WAIT — no demo order placed.`,
    };
  }

  const instrument = getInstrumentBySymbol(signal.symbol);
  const side = plan.signal;
  const entryPrice = roundPrice(
    liveSpotPrice > 0 ? liveSpotPrice : plan.entryPrice,
    instrument.decimals
  );

  // Validate SL/TP orientation relative to actual live execution price
  let stopLoss = roundPrice(plan.stopLoss, instrument.decimals);
  let tp1 = roundPrice(plan.takeProfit1, instrument.decimals);
  let tp2 = roundPrice(plan.takeProfit2, instrument.decimals);

  const fallbackRiskDist = Math.max(
    Math.abs(plan.entryPrice - plan.stopLoss),
    entryPrice * 0.003
  );

  if (side === 'BUY') {
    if (stopLoss >= entryPrice) {
      stopLoss = roundPrice(entryPrice - fallbackRiskDist, instrument.decimals);
    }
    if (tp1 <= entryPrice) {
      tp1 = roundPrice(entryPrice + fallbackRiskDist * 1.5, instrument.decimals);
    }
    if (tp2 <= tp1) {
      tp2 = roundPrice(entryPrice + fallbackRiskDist * 2.5, instrument.decimals);
    }
  } else {
    if (stopLoss <= entryPrice) {
      stopLoss = roundPrice(entryPrice + fallbackRiskDist, instrument.decimals);
    }
    if (tp1 >= entryPrice) {
      tp1 = roundPrice(entryPrice - fallbackRiskDist * 1.5, instrument.decimals);
    }
    if (tp2 >= tp1) {
      tp2 = roundPrice(entryPrice - fallbackRiskDist * 2.5, instrument.decimals);
    }
  }

  // Check existing position on the same symbol
  const existing = state.openPositions.find((p) => p.symbol === signal.symbol);
  let workingBalance = state.balance;
  let workingOpen = [...state.openPositions];
  let workingClosed = [...state.closedTrades];

  if (existing) {
    if (existing.signalId === signal.id) {
      return {
        nextState: state,
        actionSummary: `Signal already executed for ${signal.symbol}.`,
      };
    }

    if (existing.side === side) {
      // Update existing open trade's trailing stop/targets from fresh AI price-action read
      const updatedPos: DemoPosition = {
        ...existing,
        signalId: signal.id,
        timeframe: signal.signalTimeframe,
        stopLoss:
          side === 'BUY'
            ? Math.max(existing.stopLoss, stopLoss)
            : Math.min(existing.stopLoss, stopLoss),
        takeProfit1: existing.tp1Hit ? existing.takeProfit1 : tp1,
        takeProfit2: tp2,
        setupType: plan.setupType,
      };
      workingOpen = workingOpen.map((p) =>
        p.id === existing.id ? updatedPos : p
      );
      return {
        nextState: {
          ...state,
          openPositions: workingOpen,
        },
        actionSummary: `Updated existing ${side} ${signal.symbol} SL/TP from new ${signal.signalTimeframe} signal.`,
      };
    }

    // Opposing signal: close existing position at market first (Signal Reversal)
    const remainingPnl = computePnl(
      existing.side,
      existing.entryPrice,
      entryPrice,
      existing.remainingUnits
    );
    const totalPnl = roundCurrency(existing.realizedPartialPnl + remainingPnl);
    workingBalance = roundCurrency(workingBalance + remainingPnl);
    workingOpen = workingOpen.filter((p) => p.id !== existing.id);
    workingClosed = [
      {
        id: existing.id,
        symbol: existing.symbol,
        timeframe: existing.timeframe,
        side: existing.side,
        entryPrice: existing.entryPrice,
        exitPrice: entryPrice,
        units: existing.initialUnits,
        realizedPnl: totalPnl,
        reason: 'Signal Reversal' as const,
        openedAt: existing.openedAt,
        closedAt: new Date().toISOString(),
      },
      ...workingClosed,
    ].slice(0, 50);
  }

  // Limit max simultaneous positions to 3 across pairs
  if (workingOpen.length >= 3) {
    return {
      nextState: {
        ...state,
        balance: workingBalance,
        openPositions: workingOpen,
        closedTrades: workingClosed,
      },
      actionSummary: `Max 3 concurrent demo positions active; close one before opening ${signal.symbol}.`,
    };
  }

  const units = computePositionUnits(
    workingBalance,
    state.config.riskPercentPerTrade,
    entryPrice,
    stopLoss
  );

  const newPosition: DemoPosition = {
    id: `pos-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    signalId: signal.id,
    symbol: signal.symbol,
    timeframe: signal.signalTimeframe,
    side,
    entryPrice,
    currentPrice: entryPrice,
    stopLoss,
    takeProfit1: tp1,
    takeProfit2: tp2,
    initialUnits: units,
    remainingUnits: units,
    tp1Hit: false,
    breakevenActive: false,
    realizedPartialPnl: 0,
    unrealizedPnl: 0,
    openedAt: new Date().toISOString(),
    setupType: plan.setupType,
  };

  return {
    nextState: {
      ...state,
      balance: workingBalance,
      openPositions: [newPosition, ...workingOpen],
      closedTrades: workingClosed,
    },
    actionSummary: `Opened Demo ${side} ${signal.symbol} @ ${entryPrice.toFixed(
      instrument.decimals
    )} (${signal.signalTimeframe}).`,
  };
}

export function evaluateLiveTickOnPositions(
  state: DemoAccountState,
  symbol: string,
  livePrice: number
): { nextState: DemoAccountState; eventMessage: string | null } {
  const hasMatch = state.openPositions.some((p) => p.symbol === symbol);
  if (!hasMatch || !Number.isFinite(livePrice) || livePrice <= 0) {
    return { nextState: state, eventMessage: null };
  }

  const instrument = getInstrumentBySymbol(symbol);
  let nextBalance = state.balance;
  const nextOpen: DemoPosition[] = [];
  const newlyClosed: ClosedDemoTrade[] = [];
  let eventMessage: string | null = null;

  for (const pos of state.openPositions) {
    if (pos.symbol !== symbol) {
      nextOpen.push(pos);
      continue;
    }

    const hitStop =
      pos.side === 'BUY' ? livePrice <= pos.stopLoss : livePrice >= pos.stopLoss;

    if (hitStop) {
      const remPnl = computePnl(
        pos.side,
        pos.entryPrice,
        pos.stopLoss,
        pos.remainingUnits
      );
      const totalPnl = roundCurrency(pos.realizedPartialPnl + remPnl);
      nextBalance = roundCurrency(nextBalance + remPnl);
      const reason: TradeCloseReason = pos.breakevenActive
        ? 'Breakeven Stop'
        : 'Stop Loss';

      newlyClosed.push({
        id: pos.id,
        symbol: pos.symbol,
        timeframe: pos.timeframe,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice: pos.stopLoss,
        units: pos.initialUnits,
        realizedPnl: totalPnl,
        reason,
        openedAt: pos.openedAt,
        closedAt: new Date().toISOString(),
      });
      eventMessage = `${pos.symbol} ${pos.side} closed (${reason}) at ${pos.stopLoss.toFixed(
        instrument.decimals
      )}.`;
      continue;
    }

    const hitTp2 =
      pos.side === 'BUY'
        ? livePrice >= pos.takeProfit2
        : livePrice <= pos.takeProfit2;

    if (hitTp2) {
      const remPnl = computePnl(
        pos.side,
        pos.entryPrice,
        pos.takeProfit2,
        pos.remainingUnits
      );
      const totalPnl = roundCurrency(pos.realizedPartialPnl + remPnl);
      nextBalance = roundCurrency(nextBalance + remPnl);
      newlyClosed.push({
        id: pos.id,
        symbol: pos.symbol,
        timeframe: pos.timeframe,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice: pos.takeProfit2,
        units: pos.initialUnits,
        realizedPnl: totalPnl,
        reason: 'TP2 Hit',
        openedAt: pos.openedAt,
        closedAt: new Date().toISOString(),
      });
      eventMessage = `${pos.symbol} ${pos.side} hit TP2 @ ${pos.takeProfit2.toFixed(
        instrument.decimals
      )} (+$${totalPnl.toFixed(2)}).`;
      continue;
    }

    let updatedPos = { ...pos, currentPrice: livePrice };

    // Partial close 50% at TP1 and move Stop Loss to Breakeven
    const hitTp1 =
      !pos.tp1Hit &&
      (pos.side === 'BUY'
        ? livePrice >= pos.takeProfit1
        : livePrice <= pos.takeProfit1);

    if (hitTp1) {
      const halfUnits = Math.round((pos.initialUnits / 2) * 1000) / 1000;
      const partialPnl = computePnl(
        pos.side,
        pos.entryPrice,
        pos.takeProfit1,
        halfUnits
      );
      nextBalance = roundCurrency(nextBalance + partialPnl);
      updatedPos = {
        ...updatedPos,
        tp1Hit: true,
        breakevenActive: true,
        stopLoss: pos.entryPrice,
        remainingUnits: Math.max(pos.initialUnits - halfUnits, 0.001),
        realizedPartialPnl: roundCurrency(pos.realizedPartialPnl + partialPnl),
      };
      eventMessage = `${pos.symbol} ${pos.side} hit TP1 (+$${partialPnl.toFixed(
        2
      )}) — SL moved to Breakeven.`;
    }

    updatedPos.unrealizedPnl = computePnl(
      updatedPos.side,
      updatedPos.entryPrice,
      livePrice,
      updatedPos.remainingUnits
    );
    nextOpen.push(updatedPos);
  }

  return {
    nextState: {
      ...state,
      balance: nextBalance,
      openPositions: nextOpen,
      closedTrades: [...newlyClosed, ...state.closedTrades].slice(0, 50),
    },
    eventMessage,
  };
}

export function closeDemoPositionManually(
  state: DemoAccountState,
  positionId: string
): DemoAccountState {
  const target = state.openPositions.find((p) => p.id === positionId);
  if (!target) return state;

  const remPnl = computePnl(
    target.side,
    target.entryPrice,
    target.currentPrice,
    target.remainingUnits
  );
  const totalPnl = roundCurrency(target.realizedPartialPnl + remPnl);

  return {
    ...state,
    balance: roundCurrency(state.balance + remPnl),
    openPositions: state.openPositions.filter((p) => p.id !== positionId),
    closedTrades: [
      {
        id: target.id,
        symbol: target.symbol,
        timeframe: target.timeframe,
        side: target.side,
        entryPrice: target.entryPrice,
        exitPrice: target.currentPrice,
        units: target.initialUnits,
        realizedPnl: totalPnl,
        reason: 'Manual Close' as const,
        openedAt: target.openedAt,
        closedAt: new Date().toISOString(),
      },
      ...state.closedTrades,
    ].slice(0, 50),
  };
}

export function moveStopToBreakeven(
  state: DemoAccountState,
  positionId: string
): DemoAccountState {
  return {
    ...state,
    openPositions: state.openPositions.map((p) =>
      p.id === positionId
        ? { ...p, stopLoss: p.entryPrice, breakevenActive: true }
        : p
    ),
  };
}
