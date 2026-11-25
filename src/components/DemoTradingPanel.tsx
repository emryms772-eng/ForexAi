import {
  ArrowDownRight,
  ArrowUpRight,
  Play,
  RotateCcw,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { getInstrumentBySymbol } from '../config/instruments';
import type {
  AIPriceActionSignal,
  AutoScanIntervalSec,
  AutoScanScope,
  AutoTradeConfig,
  DemoAccountState,
} from '../types/market';

interface DemoTradingPanelProps {
  demoAccount: DemoAccountState;
  activeSignal: AIPriceActionSignal | null;
  selectedSymbol: string;
  nextScanSecondsLeft: number | null;
  lastExecutionNote: string | null;
  onUpdateConfig: (patch: Partial<AutoTradeConfig>) => void;
  onExecuteSignal: (signal: AIPriceActionSignal) => void;
  onClosePosition: (positionId: string) => void;
  onMoveToBreakeven: (positionId: string) => void;
  onResetAccount: () => void;
  onSelectSymbol: (symbol: string) => void;
}

const SCAN_INTERVALS: Array<{ value: AutoScanIntervalSec; label: string }> = [
  { value: 0, label: 'Off' },
  { value: 60, label: '60s' },
  { value: 180, label: '3m' },
  { value: 300, label: '5m' },
];

const RISK_OPTIONS: Array<0.5 | 1 | 2> = [0.5, 1, 2];

export function DemoTradingPanel({
  demoAccount,
  activeSignal,
  selectedSymbol,
  nextScanSecondsLeft,
  lastExecutionNote,
  onUpdateConfig,
  onExecuteSignal,
  onClosePosition,
  onMoveToBreakeven,
  onResetAccount,
  onSelectSymbol,
}: DemoTradingPanelProps) {
  const [activeTab, setActiveTab] = useState<'open' | 'history'>('open');

  const stats = useMemo(() => {
    const unrealized = demoAccount.openPositions.reduce(
      (sum, p) => sum + p.unrealizedPnl,
      0
    );
    const equity = demoAccount.balance + unrealized;
    const totalReturn = equity - demoAccount.initialBalance;
    const totalReturnPct =
      (totalReturn / Math.max(demoAccount.initialBalance, 1)) * 100;

    const closedCount = demoAccount.closedTrades.length;
    const wins = demoAccount.closedTrades.filter(
      (t) => t.realizedPnl > 0
    ).length;
    const winRate = closedCount > 0 ? (wins / closedCount) * 100 : 0;

    return {
      unrealized,
      equity,
      totalReturn,
      totalReturnPct,
      closedCount,
      winRate,
    };
  }, [demoAccount]);

  const canExecuteCurrent =
    activeSignal !== null &&
    activeSignal.symbol === selectedSymbol &&
    activeSignal.plan.signal !== 'WAIT';

  return (
    <section
      id="demo"
      aria-label="Demo paper trading account and auto-execution desk"
      className="rounded-lg border border-slate-800/90 bg-[#111722] overflow-hidden"
    >
      {/* Account Summary Header */}
      <div className="flex flex-col gap-4 border-b border-slate-800/80 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex flex-wrap items-baseline gap-2.5">
            <h2 className="text-sm font-semibold text-slate-50">
              Demo Paper Account &amp; Auto-Trader
            </h2>
            <span className="text-xs text-slate-400">
              Simulated Virtual Balance · No Real Capital
            </span>
          </div>
          {lastExecutionNote && (
            <p className="mt-1 text-xs text-sky-300">{lastExecutionNote}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          <div>
            <div className="text-slate-400">Demo Balance</div>
            <div className="font-mono tabular-nums text-sm font-semibold text-slate-100">
              ${demoAccount.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          <div>
            <div className="text-slate-400">Live Equity</div>
            <div className="font-mono tabular-nums text-sm font-semibold text-white">
              ${stats.equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          <div>
            <div className="text-slate-400">Floating P&amp;L</div>
            <div
              className={`font-mono tabular-nums text-sm font-semibold ${
                stats.unrealized >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {stats.unrealized >= 0 ? '+' : '-'}$
              {Math.abs(stats.unrealized).toFixed(2)}
            </div>
          </div>

          <div>
            <div className="text-slate-400">Net Return</div>
            <div
              className={`font-mono tabular-nums text-sm font-semibold ${
                stats.totalReturn >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {stats.totalReturn >= 0 ? '+' : ''}
              {stats.totalReturnPct.toFixed(2)}%
            </div>
          </div>

          <div>
            <div className="text-slate-400">Win Rate</div>
            <div className="font-mono tabular-nums text-sm font-semibold text-slate-200">
              {stats.closedCount > 0 ? `${stats.winRate.toFixed(0)}%` : '—'}{' '}
              <span className="text-[11px] font-normal text-slate-400">
                ({stats.closedCount})
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={onResetAccount}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-600 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Reset $10k</span>
          </button>
        </div>
      </div>

      {/* Automation & Risk Controls Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 bg-[#0D121C] px-5 py-3 text-xs">
        <div className="flex flex-wrap items-center gap-4">
          {/* Auto-Trade Toggle */}
          <div className="flex items-center gap-2">
            <span className="text-slate-400">Auto-Trade Signals:</span>
            <button
              type="button"
              onClick={() =>
                onUpdateConfig({
                  autoTradeEnabled: !demoAccount.config.autoTradeEnabled,
                })
              }
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1 font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                demoAccount.config.autoTradeEnabled
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                  : 'border-slate-700 bg-[#0B0F17] text-slate-300 hover:text-white'
              }`}
            >
              {demoAccount.config.autoTradeEnabled ? (
                <Play className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Square className="h-3 w-3" aria-hidden="true" />
              )}
              <span>
                {demoAccount.config.autoTradeEnabled ? 'Enabled' : 'Manual Only'}
              </span>
            </button>
          </div>

          {/* Auto-Scan Timer */}
          <div className="flex items-center gap-2">
            <span className="text-slate-400">Auto-Scan:</span>
            <div
              role="group"
              aria-label="Auto-scan interval"
              className="flex items-center gap-1 rounded-md border border-slate-800 bg-[#0B0F17] p-0.5"
            >
              {SCAN_INTERVALS.map((opt) => {
                const active = demoAccount.config.autoScanIntervalSec === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      onUpdateConfig({ autoScanIntervalSec: opt.value })
                    }
                    className={`rounded px-2 py-1 font-mono text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                      active
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {nextScanSecondsLeft !== null &&
              demoAccount.config.autoScanIntervalSec > 0 && (
                <span className="font-mono tabular-nums text-[11px] text-sky-400">
                  Next in {nextScanSecondsLeft}s
                </span>
              )}
          </div>

          {/* Scan Scope */}
          <div className="flex items-center gap-2">
            <span className="text-slate-400">Target:</span>
            <div
              role="group"
              aria-label="Auto-scan market scope"
              className="flex items-center gap-1 rounded-md border border-slate-800 bg-[#0B0F17] p-0.5"
            >
              {(
                [
                  { id: 'active', label: 'Active Pair' },
                  { id: 'watchlist', label: 'Rotate Watchlist' },
                ] as Array<{ id: AutoScanScope; label: string }>
              ).map((scope) => {
                const active = demoAccount.config.scanScope === scope.id;
                return (
                  <button
                    key={scope.id}
                    type="button"
                    onClick={() => onUpdateConfig({ scanScope: scope.id })}
                    className={`rounded px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                      active
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {scope.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Risk Per Trade */}
          <div className="flex items-center gap-2">
            <span className="text-slate-400">Risk / Trade:</span>
            <div
              role="group"
              aria-label="Risk percentage per demo trade"
              className="flex items-center gap-1 rounded-md border border-slate-800 bg-[#0B0F17] p-0.5"
            >
              {RISK_OPTIONS.map((pct) => {
                const active = demoAccount.config.riskPercentPerTrade === pct;
                return (
                  <button
                    key={pct}
                    type="button"
                    onClick={() =>
                      onUpdateConfig({ riskPercentPerTrade: pct })
                    }
                    className={`rounded px-2 py-1 font-mono text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                      active
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {pct}%
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {canExecuteCurrent && activeSignal && (
            <button
              type="button"
              onClick={() => onExecuteSignal(activeSignal)}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <span>
                Execute {activeSignal.plan.signal} {activeSignal.symbol}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Positions & History Tabs */}
      <div className="flex items-center justify-between border-b border-slate-800/70 px-5 py-2.5">
        <div
          role="tablist"
          aria-label="Demo trade views"
          className="flex items-center gap-1 rounded-md bg-[#0B0F17] p-1 border border-slate-800/80"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'open'}
            onClick={() => setActiveTab('open')}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
              activeTab === 'open'
                ? 'bg-slate-800 text-slate-50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Open Positions ({demoAccount.openPositions.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'history'}
            onClick={() => setActiveTab('history')}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
              activeTab === 'history'
                ? 'bg-slate-800 text-slate-50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Closed History ({demoAccount.closedTrades.length})
          </button>
        </div>

        <span className="hidden sm:inline text-[11px] text-slate-400">
          Auto-manages 50% partial close at TP1 + Stop Loss to Breakeven on live ticks
        </span>
      </div>

      {/* Table Content */}
      {activeTab === 'open' ? (
        demoAccount.openPositions.length === 0 ? (
          <div className="p-6 text-xs text-slate-400">
            No open demo positions. Enable{' '}
            <strong className="font-semibold text-slate-200">
              Auto-Trade Signals
            </strong>{' '}
            or generate a BUY/SELL signal and click{' '}
            <strong className="font-semibold text-slate-200">
              Execute
            </strong>{' '}
            to open a simulated trade.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800/70 text-slate-400">
                  <th className="px-5 py-2.5 font-medium">Instrument</th>
                  <th className="px-4 py-2.5 font-medium">Side</th>
                  <th className="px-4 py-2.5 font-medium text-right">Units</th>
                  <th className="px-4 py-2.5 font-medium text-right">Entry</th>
                  <th className="px-4 py-2.5 font-medium text-right">Live</th>
                  <th className="px-4 py-2.5 font-medium text-right">Stop Loss</th>
                  <th className="px-4 py-2.5 font-medium text-right">TP1 / TP2</th>
                  <th className="px-4 py-2.5 font-medium text-right">
                    Unrealized P&amp;L
                  </th>
                  <th className="px-5 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {demoAccount.openPositions.map((pos) => {
                  const inst = getInstrumentBySymbol(pos.symbol);
                  const isBuy = pos.side === 'BUY';
                  const isProfit = pos.unrealizedPnl >= 0;

                  return (
                    <tr
                      key={pos.id}
                      className="transition-colors hover:bg-slate-800/30"
                    >
                      <td className="px-5 py-3">
                        <button
                          type="button"
                          onClick={() => onSelectSymbol(pos.symbol)}
                          className="font-semibold text-slate-100 hover:text-blue-400 cursor-pointer"
                        >
                          {pos.symbol}
                        </button>
                        <div className="text-[11px] text-slate-400">
                          {pos.timeframe} · {pos.setupType}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 font-semibold ${
                            isBuy ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {isBuy ? (
                            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          {pos.side}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-200">
                        {pos.remainingUnits.toFixed(2)}
                        {pos.tp1Hit && (
                          <div className="text-[10px] text-emerald-400">
                            50% TP1 banked
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-200">
                        {pos.entryPrice.toFixed(inst.decimals)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-white">
                        {pos.currentPrice.toFixed(inst.decimals)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-rose-300">
                        {pos.stopLoss.toFixed(inst.decimals)}
                        {pos.breakevenActive && (
                          <div className="text-[10px] text-sky-400">
                            Breakeven
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-emerald-300">
                        <div>{pos.takeProfit1.toFixed(inst.decimals)}</div>
                        <div className="text-[11px] text-emerald-400/80">
                          {pos.takeProfit2.toFixed(inst.decimals)}
                        </div>
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-mono tabular-nums font-semibold ${
                          isProfit ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {isProfit ? '+' : '-'}$
                        {Math.abs(pos.unrealizedPnl).toFixed(2)}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          {!pos.breakevenActive && (
                            <button
                              type="button"
                              onClick={() => onMoveToBreakeven(pos.id)}
                              title="Move Stop Loss to Entry (Breakeven)"
                              className="inline-flex items-center gap-1 rounded border border-slate-700 bg-[#0B0F17] px-2 py-1 text-[11px] text-slate-300 hover:border-sky-500/50 hover:text-sky-300 cursor-pointer"
                            >
                              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                              <span>BE</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onClosePosition(pos.id)}
                            title="Close demo trade at market"
                            className="inline-flex items-center gap-1 rounded border border-slate-700 bg-[#0B0F17] px-2 py-1 text-[11px] text-slate-300 hover:border-rose-500/50 hover:text-rose-300 cursor-pointer"
                          >
                            <X className="h-3 w-3" aria-hidden="true" />
                            <span>Close</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : demoAccount.closedTrades.length === 0 ? (
        <div className="p-6 text-xs text-slate-400">
          No closed demo trades yet. Closed trades from TP2 hits, Stop Loss,
          Signal Reversals, or manual closes will be recorded here.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800/70 text-slate-400">
                <th className="px-5 py-2.5 font-medium">Instrument</th>
                <th className="px-4 py-2.5 font-medium">Side</th>
                <th className="px-4 py-2.5 font-medium text-right">Entry</th>
                <th className="px-4 py-2.5 font-medium text-right">Exit</th>
                <th className="px-4 py-2.5 font-medium">Exit Reason</th>
                <th className="px-4 py-2.5 font-medium text-right">
                  Realized P&amp;L
                </th>
                <th className="px-5 py-2.5 font-medium text-right">Closed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {demoAccount.closedTrades.map((trade) => {
                const inst = getInstrumentBySymbol(trade.symbol);
                const isProfit = trade.realizedPnl >= 0;
                return (
                  <tr
                    key={trade.id}
                    className="transition-colors hover:bg-slate-800/30"
                  >
                    <td className="px-5 py-2.5 font-semibold text-slate-100">
                      {trade.symbol} · {trade.timeframe}
                    </td>
                    <td
                      className={`px-4 py-2.5 font-semibold ${
                        trade.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {trade.side}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-300">
                      {trade.entryPrice.toFixed(inst.decimals)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-200">
                      {trade.exitPrice.toFixed(inst.decimals)}
                    </td>
                    <td className="px-4 py-2.5 text-slate-300">{trade.reason}</td>
                    <td
                      className={`px-4 py-2.5 text-right font-mono tabular-nums font-semibold ${
                        isProfit ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {isProfit ? '+' : '-'}$
                      {Math.abs(trade.realizedPnl).toFixed(2)}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono tabular-nums text-slate-400">
                      {new Date(trade.closedAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
