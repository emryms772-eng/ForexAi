import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Loader2,
  Play,
  ShieldCheck,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { getInstrumentBySymbol } from '../config/instruments';
import type {
  AIBacktestReview,
  BacktestEquityPoint,
  BacktestResult,
  Timeframe,
} from '../types/market';

interface BacktestPanelProps {
  symbol: string;
  timeframe: Timeframe;
  riskPercentPerTrade: 0.5 | 1 | 2;
  backtest: BacktestResult | null;
  aiReview: AIBacktestReview | null;
  aiError: string | null;
  backtestError: string | null;
  isRunning: boolean;
  onRunBacktest: (includeAiReview: boolean) => void;
}

function formatTimestamp(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function EquityCurveChart({
  points,
  initialCapital,
}: {
  points: BacktestEquityPoint[];
  initialCapital: number;
}) {
  const chartData = useMemo(() => {
    if (points.length === 0) return null;
    const width = 720;
    const height = 160;
    const padX = 12;
    const padY = 14;

    const equities = points.map((p) => p.equity);
    const minEq = Math.min(initialCapital, ...equities);
    const maxEq = Math.max(initialCapital, ...equities);
    const span = Math.max(maxEq - minEq, initialCapital * 0.01);

    const toX = (idx: number) =>
      points.length === 1
        ? width / 2
        : padX + (idx / (points.length - 1)) * (width - padX * 2);

    const toY = (val: number) =>
      height - padY - ((val - minEq) / span) * (height - padY * 2);

    const coords = points.map((p, idx) => ({
      x: toX(idx),
      y: toY(p.equity),
      equity: p.equity,
    }));

    const linePath = coords
      .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
      .join(' ');

    const baselineY = toY(initialCapital);
    const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(
      1
    )} ${(height - padY).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(
      height - padY
    ).toFixed(1)} Z`;

    const lastEquity = points[points.length - 1].equity;
    const isPositive = lastEquity >= initialCapital;

    return {
      width,
      height,
      linePath,
      areaPath,
      baselineY,
      minEq,
      maxEq,
      isPositive,
      lastPoint: coords[coords.length - 1],
    };
  }, [points, initialCapital]);

  if (!chartData) {
    return (
      <div className="flex h-40 items-center justify-center rounded border border-slate-800/80 bg-[#0B0F17] text-xs text-slate-400">
        Not enough closed trades to plot an equity curve on this sample.
      </div>
    );
  }

  const strokeColor = chartData.isPositive ? '#10B981' : '#EF4444';
  const fillId = chartData.isPositive
    ? 'equityFillBull'
    : 'equityFillBear';

  return (
    <div className="rounded border border-slate-800/80 bg-[#0B0F17] p-3">
      <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400">
        <span>Historical Equity Curve (Closed-Bar Causal Simulation)</span>
        <span className="font-mono tabular-nums text-slate-300">
          Low ${chartData.minEq.toLocaleString(undefined, { maximumFractionDigits: 0 })} · High $
          {chartData.maxEq.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${chartData.width} ${chartData.height}`}
        className="h-36 w-full overflow-visible"
        role="img"
        aria-label="Backtest equity curve"
      >
        <defs>
          <linearGradient id="equityFillBull" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10B981" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#10B981" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="equityFillBear" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#EF4444" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#EF4444" stopOpacity="0" />
          </linearGradient>
        </defs>

        <line
          x1={12}
          y1={chartData.baselineY}
          x2={chartData.width - 12}
          y2={chartData.baselineY}
          stroke="#334155"
          strokeWidth="1"
          strokeDasharray="4 4"
        />

        <path d={chartData.areaPath} fill={`url(#${fillId})`} />
        <path
          d={chartData.linePath}
          fill="none"
          stroke={strokeColor}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx={chartData.lastPoint.x}
          cy={chartData.lastPoint.y}
          r="3.5"
          fill={strokeColor}
        />
      </svg>
    </div>
  );
}

export function BacktestPanel({
  symbol,
  timeframe,
  riskPercentPerTrade,
  backtest,
  aiReview,
  aiError,
  backtestError,
  isRunning,
  onRunBacktest,
}: BacktestPanelProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'trades'>('overview');
  const instrument = getInstrumentBySymbol(backtest?.symbol ?? symbol);

  return (
    <section
      id="backtest"
      aria-label="Non-repainting price-action backtester and AI audit"
      className="rounded-lg border border-slate-800/90 bg-[#111722] overflow-hidden"
    >
      {/* Header & Execution Controls */}
      <div className="flex flex-col gap-4 border-b border-slate-800/80 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <h2 className="text-sm font-semibold text-slate-50">
              Price-Action Backtester &amp; AI Edge Audit
            </h2>
            <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Closed-Bar Causal · Next-Bar Open · Zero Repainting</span>
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Tests {symbol} ({timeframe}) at{' '}
            <span className="font-mono tabular-nums text-slate-300">
              {riskPercentPerTrade}%
            </span>{' '}
            risk per trade using confirmed swing pivots, liquidity sweeps, OB/FVG mitigations, and SL-first intrabar checks.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => onRunBacktest(false)}
            disabled={isRunning}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-[#0B0F17] px-3.5 py-2 text-xs font-semibold text-slate-100 transition-colors hover:border-slate-500 hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap cursor-pointer"
          >
            {isRunning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
            )}
            <span>Run Backtest</span>
          </button>

          <button
            type="button"
            onClick={() => onRunBacktest(true)}
            disabled={isRunning}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap cursor-pointer"
          >
            {isRunning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Bot className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>Backtest + AI Audit</span>
          </button>
        </div>
      </div>

      {backtestError && (
        <div className="border-b border-rose-500/30 bg-rose-500/10 px-5 py-3 text-xs text-rose-200 break-words">
          {backtestError}
        </div>
      )}

      {!backtest ? (
        <div className="flex flex-col items-start justify-between gap-4 px-5 py-7 sm:flex-row sm:items-center">
          <div className="space-y-1 max-w-2xl">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-200">
              <Activity className="h-4 w-4 text-sky-400" aria-hidden="true" />
              <span>No backtest run yet for {symbol} ({timeframe})</span>
            </div>
            <p className="text-xs leading-relaxed text-slate-400">
              Click <span className="text-slate-200 font-medium">Run Backtest</span> for an instant local causal simulation (uses zero API quota), or{' '}
              <span className="text-slate-200 font-medium">Backtest + AI Audit</span> to have the AI evaluate win rate, profit factor, and pure price-action filtering rules.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4 p-5">
          {/* KPI Strip */}
          <div className="grid grid-cols-2 gap-4 border-b border-slate-800/80 pb-4 sm:grid-cols-3 lg:grid-cols-6">
            <div>
              <div className="text-xs text-slate-400">Net Return</div>
              <div
                className={`mt-0.5 font-mono tabular-nums text-sm font-semibold ${
                  backtest.netReturnUsd >= 0
                    ? 'text-emerald-400'
                    : 'text-rose-400'
                }`}
              >
                {backtest.netReturnUsd >= 0 ? '+' : ''}$
                {backtest.netReturnUsd.toFixed(2)} ({backtest.netReturnPct >= 0 ? '+' : ''}
                {backtest.netReturnPct.toFixed(2)}%)
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-400">Win Rate</div>
              <div className="mt-0.5 font-mono tabular-nums text-sm font-semibold text-slate-100">
                {backtest.winRatePct.toFixed(1)}%{' '}
                <span className="text-xs font-normal text-slate-400">
                  ({backtest.wins}W/{backtest.losses}L/{backtest.breakevens}BE)
                </span>
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-400">Profit Factor</div>
              <div
                className={`mt-0.5 font-mono tabular-nums text-sm font-semibold ${
                  backtest.profitFactor >= 1.3
                    ? 'text-emerald-400'
                    : backtest.profitFactor >= 1
                    ? 'text-amber-300'
                    : 'text-rose-400'
                }`}
              >
                {backtest.profitFactor.toFixed(2)}
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-400">Expectancy (R)</div>
              <div
                className={`mt-0.5 font-mono tabular-nums text-sm font-semibold ${
                  backtest.expectancyR >= 0
                    ? 'text-emerald-400'
                    : 'text-rose-400'
                }`}
              >
                {backtest.expectancyR >= 0 ? '+' : ''}
                {backtest.expectancyR.toFixed(2)}R
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-400">Max Drawdown</div>
              <div className="mt-0.5 font-mono tabular-nums text-sm font-semibold text-rose-300">
                -{backtest.maxDrawdownPct.toFixed(2)}%
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-400">Sample Tested</div>
              <div className="mt-0.5 font-mono tabular-nums text-sm font-semibold text-slate-100">
                {backtest.totalTrades} trades{' '}
                <span className="text-xs font-normal text-slate-400">
                  · {backtest.barsTested} bars
                </span>
              </div>
            </div>
          </div>

          {/* View Switcher */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-4 text-xs">
              <button
                type="button"
                onClick={() => setActiveTab('overview')}
                className={`pb-1 font-medium transition-colors cursor-pointer ${
                  activeTab === 'overview'
                    ? 'text-slate-50 border-b-2 border-blue-500'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Equity Curve &amp; AI Edge Audit
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('trades')}
                className={`pb-1 font-medium transition-colors cursor-pointer ${
                  activeTab === 'trades'
                    ? 'text-slate-50 border-b-2 border-blue-500'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Historical Trade Ledger ({backtest.totalTrades})
              </button>
            </div>

            <span className="text-[11px] font-mono tabular-nums text-slate-400">
              {backtest.symbol} · {backtest.timeframe} · {formatTimestamp(backtest.fromTime)} to{' '}
              {formatTimestamp(backtest.toTime)}
            </span>
          </div>

          {activeTab === 'overview' ? (
            <div className="space-y-4">
              <EquityCurveChart
                points={backtest.equityCurve}
                initialCapital={backtest.initialCapital}
              />

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                {/* Setup Performance Breakdown */}
                <div className="xl:col-span-6 rounded border border-slate-800/80 bg-[#0B0F17] overflow-hidden">
                  <div className="border-b border-slate-800/80 px-4 py-2.5 text-xs font-semibold text-slate-200">
                    Setup Breakdown (Non-Repainting Signals)
                  </div>
                  {backtest.setupBreakdown.length === 0 ? (
                    <div className="p-4 text-xs text-slate-400">
                      No qualifying setups triggered across this closed-bar window.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-800/70 text-slate-400">
                            <th className="px-4 py-2 font-medium">Setup Archetype</th>
                            <th className="px-4 py-2 font-medium text-right">Trades</th>
                            <th className="px-4 py-2 font-medium text-right">Win %</th>
                            <th className="px-4 py-2 font-medium text-right">Net R</th>
                            <th className="px-4 py-2 font-medium text-right">Net P&amp;L</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/50">
                          {backtest.setupBreakdown.map((row) => (
                            <tr key={row.setupType}>
                              <td className="px-4 py-2 font-medium text-slate-200">
                                {row.setupType}
                              </td>
                              <td className="px-4 py-2 text-right font-mono tabular-nums text-slate-300">
                                {row.trades}
                              </td>
                              <td className="px-4 py-2 text-right font-mono tabular-nums text-slate-300">
                                {row.winRatePct}%
                              </td>
                              <td
                                className={`px-4 py-2 text-right font-mono tabular-nums font-medium ${
                                  row.netR >= 0
                                    ? 'text-emerald-400'
                                    : 'text-rose-400'
                                }`}
                              >
                                {row.netR >= 0 ? '+' : ''}
                                {row.netR.toFixed(2)}R
                              </td>
                              <td
                                className={`px-4 py-2 text-right font-mono tabular-nums font-semibold ${
                                  row.netPnlUsd >= 0
                                    ? 'text-emerald-400'
                                    : 'text-rose-400'
                                }`}
                              >
                                {row.netPnlUsd >= 0 ? '+' : ''}$
                                {row.netPnlUsd.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* AI Backtest Edge Audit */}
                <div className="xl:col-span-6 rounded border border-slate-800/80 bg-[#0B0F17] p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-200">
                      AI Quantitative Price-Action Audit
                    </span>
                    {aiReview && (
                      <span
                        className={`text-xs font-semibold ${
                          aiReview.verdict === 'Strong Edge'
                            ? 'text-emerald-400'
                            : aiReview.verdict === 'Moderate Edge'
                            ? 'text-amber-300'
                            : 'text-rose-400'
                        }`}
                      >
                        {aiReview.verdict} · {aiReview.model}
                      </span>
                    )}
                  </div>

                  {aiError && (
                    <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 break-words">
                      <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>AI Audit Unavailable</span>
                      </div>
                      <p className="mt-1">{aiError}</p>
                    </div>
                  )}

                  {aiReview ? (
                    <div className="space-y-2.5 text-xs">
                      <p className="leading-relaxed text-slate-200">
                        {aiReview.summary}
                      </p>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 border-t border-slate-800/80 pt-2.5">
                        <div>
                          <div className="text-slate-400">Best Setup</div>
                          <div className="mt-0.5 text-emerald-300">
                            {aiReview.bestPerformingPattern}
                          </div>
                        </div>
                        <div>
                          <div className="text-slate-400">Key Weakness</div>
                          <div className="mt-0.5 text-rose-300">
                            {aiReview.keyWeakness}
                          </div>
                        </div>
                      </div>
                      <div className="border-t border-slate-800/80 pt-2.5 space-y-1">
                        <div className="text-slate-400 font-medium">
                          Price-Action Refinements
                        </div>
                        {aiReview.recommendations.map((rec, idx) => (
                          <div
                            key={idx}
                            className="flex items-start gap-2 text-slate-300"
                          >
                            <CheckCircle2
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-400"
                              aria-hidden="true"
                            />
                            <span>{rec}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-slate-400 leading-relaxed">
                      Click <span className="text-slate-200 font-medium">Backtest + AI Audit</span> above to generate an AI critique of this causal equity curve, setup breakdown, and pure price-action filtering rules.
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Historical Trade Ledger */
            <div className="overflow-x-auto max-h-[340px] overflow-y-auto rounded border border-slate-800/80 bg-[#0B0F17]">
              {backtest.trades.length === 0 ? (
                <div className="p-6 text-xs text-slate-400">
                  No qualifying price-action setups fired during this closed-bar window.
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-[#111722]">
                    <tr className="border-b border-slate-800/80 text-slate-400">
                      <th className="px-4 py-2.5 font-medium">Side</th>
                      <th className="px-4 py-2.5 font-medium">Setup &amp; Trigger</th>
                      <th className="px-4 py-2.5 font-medium">Entry → Exit</th>
                      <th className="px-4 py-2.5 font-medium">Reason</th>
                      <th className="px-4 py-2.5 font-medium text-right">R-Mult</th>
                      <th className="px-4 py-2.5 font-medium text-right">P&amp;L</th>
                      <th className="px-4 py-2.5 font-medium text-right">Equity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {backtest.trades.map((trade) => {
                      const isWin = trade.pnlUsd > 0;
                      const isBe = Math.abs(trade.pnlUsd) < 0.5;
                      return (
                        <tr
                          key={trade.id}
                          className="transition-colors hover:bg-slate-800/30"
                        >
                          <td
                            className={`px-4 py-2.5 font-semibold whitespace-nowrap ${
                              trade.side === 'BUY'
                                ? 'text-emerald-400'
                                : 'text-rose-400'
                            }`}
                          >
                            {trade.side}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="text-slate-200 font-medium">
                              {trade.setupType}
                            </div>
                            <div className="text-[11px] text-slate-400">
                              {trade.trigger}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 font-mono tabular-nums text-slate-300 whitespace-nowrap">
                            <div>
                              {trade.entryPrice.toFixed(instrument.decimals)} →{' '}
                              {trade.exitPrice.toFixed(instrument.decimals)}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {formatTimestamp(trade.entryTime)}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">
                            {trade.exitReason}
                            {trade.tp1Hit && trade.exitReason !== 'TP2 Hit'
                              ? ' (TP1 Hit)'
                              : ''}
                          </td>
                          <td
                            className={`px-4 py-2.5 text-right font-mono tabular-nums font-medium whitespace-nowrap ${
                              isBe
                                ? 'text-slate-300'
                                : isWin
                                ? 'text-emerald-400'
                                : 'text-rose-400'
                            }`}
                          >
                            {trade.rMultiple >= 0 ? '+' : ''}
                            {trade.rMultiple.toFixed(2)}R
                          </td>
                          <td
                            className={`px-4 py-2.5 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                              isBe
                                ? 'text-slate-300'
                                : isWin
                                ? 'text-emerald-400'
                                : 'text-rose-400'
                            }`}
                          >
                            {trade.pnlUsd >= 0 ? '+' : ''}$
                            {trade.pnlUsd.toFixed(2)}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-200 whitespace-nowrap">
                            $
                            {trade.equityAfter.toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
