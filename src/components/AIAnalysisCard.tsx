import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  RefreshCw,
  Zap,
} from 'lucide-react';
import type { AIPriceActionSignal, Timeframe } from '../types/market';

interface AIAnalysisCardProps {
  symbol: string;
  timeframe: Timeframe;
  decimals: number;
  signal: AIPriceActionSignal | null;
  isAnalyzing: boolean;
  error: string | null;
  onGenerateSignal: () => void;
  onSelectTimeframe: (tf: Timeframe) => void;
  onExecuteOnDemo?: (signal: AIPriceActionSignal) => void;
}

export function AIAnalysisCard({
  symbol,
  timeframe,
  decimals,
  signal,
  isAnalyzing,
  error,
  onGenerateSignal,
  onSelectTimeframe,
  onExecuteOnDemo,
}: AIAnalysisCardProps) {
  const isDifferentSymbol = signal !== null && signal.symbol !== symbol;
  const recommendedTf = signal?.signalTimeframe ?? timeframe;
  const isViewingRecommendedTf =
    signal !== null &&
    signal.symbol === symbol &&
    recommendedTf === timeframe;

  const signalAction = signal?.plan.signal;
  const signalColor =
    signalAction === 'BUY'
      ? 'text-emerald-400'
      : signalAction === 'SELL'
      ? 'text-rose-400'
      : 'text-amber-300';

  const signalBannerStyle =
    signalAction === 'BUY'
      ? 'border-emerald-500/35 bg-emerald-500/10'
      : signalAction === 'SELL'
      ? 'border-rose-500/35 bg-rose-500/10'
      : 'border-amber-500/35 bg-amber-500/10';

  return (
    <section
      id="setup"
      aria-label="AI multi-timeframe pure price-action signal engine"
      className="flex flex-col rounded-lg border border-slate-800/90 bg-[#111722]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-50">
            AI Multi-TF Price Action Signal
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            {symbol} <span aria-hidden="true">·</span> Scans 4H / 1H / 15M / 5M / 1M
          </p>
        </div>

        <button
          type="button"
          onClick={onGenerateSignal}
          disabled={isAnalyzing}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${isAnalyzing ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span>{signal ? 'Refresh Scan' : 'Generate Signal'}</span>
        </button>
      </div>

      <div className="p-5 flex-1 flex flex-col gap-5">
        {isAnalyzing && (
          <div className="space-y-4">
            <div className="h-16 w-full rounded-md bg-slate-800/60 animate-pulse" />
            <div className="grid grid-cols-2 gap-3">
              <div className="h-14 rounded bg-slate-800/50 animate-pulse" />
              <div className="h-14 rounded bg-slate-800/50 animate-pulse" />
              <div className="h-14 rounded bg-slate-800/50 animate-pulse" />
              <div className="h-14 rounded bg-slate-800/50 animate-pulse" />
            </div>
            <p className="text-xs text-slate-400">
              Scanning 4H, 1H, 15M, 5M, and 1M pure OHLC price action for {symbol}...
            </p>
          </div>
        )}

        {!isAnalyzing && error && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-4 space-y-3 overflow-hidden">
            <div className="flex items-start gap-2.5 min-w-0">
              <AlertCircle
                className="mt-0.5 h-4 w-4 shrink-0 text-rose-400"
                aria-hidden="true"
              />
              <div className="space-y-1 min-w-0 flex-1">
                <p className="text-xs font-semibold text-rose-300">
                  Signal Generation Failed
                </p>
                <p className="text-xs leading-relaxed text-rose-200/90 break-words">
                  {error}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onGenerateSignal}
              className="rounded-md bg-rose-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-600 cursor-pointer"
            >
              Retry Signal Scan
            </button>
          </div>
        )}

        {!isAnalyzing && !error && !signal && (
          <div className="my-auto py-8 text-center space-y-4">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-slate-800 bg-[#0B0F17] text-blue-400">
              <Zap className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-sm font-semibold text-slate-100">
                Top-Down Price-Action Scanner
              </h3>
              <p className="mx-auto max-w-xs text-xs leading-relaxed text-slate-400">
                Studies all 5 timeframes (4H, 1H, 15M, 5M, 1M) using pure candle
                structure, BOS/CHoCH, sweeps, Order Blocks, and FVGs—then pinpoints
                which timeframe offers the cleanest BUY, SELL, or WAIT setup.
              </p>
            </div>
            <button
              type="button"
              onClick={onGenerateSignal}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 cursor-pointer"
            >
              <Zap className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Scan All Timeframes</span>
            </button>
          </div>
        )}

        {!isAnalyzing && signal && (
          <>
            {isDifferentSymbol && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <span>
                  Showing prior signal for {signal.symbol} ({recommendedTf}).
                </span>
                <button
                  type="button"
                  onClick={onGenerateSignal}
                  className="font-semibold text-amber-300 underline hover:text-amber-200 whitespace-nowrap cursor-pointer"
                >
                  Scan {symbol}
                </button>
              </div>
            )}

            {/* Primary Signal Action Header + Recommended Execution Timeframe */}
            <div
              className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3.5 ${signalBannerStyle}`}
            >
              <div className="flex items-center gap-2.5">
                {signalAction === 'BUY' ? (
                  <ArrowUpRight
                    className="h-6 w-6 text-emerald-400 shrink-0"
                    aria-hidden="true"
                  />
                ) : signalAction === 'SELL' ? (
                  <ArrowDownRight
                    className="h-6 w-6 text-rose-400 shrink-0"
                    aria-hidden="true"
                  />
                ) : (
                  <Clock
                    className="h-6 w-6 text-amber-300 shrink-0"
                    aria-hidden="true"
                  />
                )}
                <div>
                  <div className={`text-base font-bold tracking-tight ${signalColor}`}>
                    {signalAction} on {recommendedTf} · {signal.plan.signalStrength}
                  </div>
                  <div className="text-xs text-slate-300">
                    {signal.plan.setupType}
                  </div>
                </div>
              </div>

              <div className="text-right font-mono tabular-nums text-[11px] text-slate-300">
                <div className="font-semibold text-slate-100">
                  R:R {signal.plan.riskRewardRatio}
                </div>
                <div className="text-slate-400">
                  {new Date(signal.analyzedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </div>
              </div>
            </div>

            {!isDifferentSymbol && !isViewingRecommendedTf && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-200">
                <span>
                  Optimal setup detected on{' '}
                  <strong className="font-mono text-blue-100">
                    {recommendedTf}
                  </strong>{' '}
                  (currently viewing {timeframe}).
                </span>
                <button
                  type="button"
                  onClick={() => onSelectTimeframe(recommendedTf)}
                  className="font-semibold text-blue-300 underline hover:text-blue-200 whitespace-nowrap cursor-pointer"
                >
                  Switch to {recommendedTf}
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
              <div>
                <span className="text-slate-400">Trigger ({recommendedTf}): </span>
                <span className="font-medium text-slate-100">
                  {signal.plan.triggerPattern}
                </span>
              </div>
              <span className="font-mono text-[11px] text-slate-400">
                {signal.model}
              </span>
            </div>

            {onExecuteOnDemo && signal.plan.signal !== 'WAIT' && (
              <button
                type="button"
                onClick={() => onExecuteOnDemo(signal)}
                className="w-full rounded-md border border-blue-500/40 bg-blue-600/15 py-2 text-xs font-semibold text-blue-200 transition-colors hover:bg-blue-600/25 cursor-pointer"
              >
                Place {signal.plan.signal} Order on Demo Account
              </button>
            )}

            {/* Signal Execution Levels */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border border-slate-800/90 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">Signal Entry</div>
                <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-blue-400">
                  {signal.plan.entryPrice.toFixed(decimals)}
                </div>
                <div className="mt-0.5 font-mono tabular-nums text-[11px] text-slate-400 truncate">
                  Zone: {signal.plan.entryZone}
                </div>
              </div>

              <div className="rounded-md border border-slate-800/90 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">Stop Loss</div>
                <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-rose-400">
                  {signal.plan.stopLoss.toFixed(decimals)}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  Structure invalidation
                </div>
              </div>

              <div className="rounded-md border border-slate-800/90 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">Take Profit 1</div>
                <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-emerald-400">
                  {signal.plan.takeProfit1.toFixed(decimals)}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  First liquidity target
                </div>
              </div>

              <div className="rounded-md border border-slate-800/90 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">Take Profit 2</div>
                <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-emerald-300">
                  {signal.plan.takeProfit2.toFixed(decimals)}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  Extended swing target
                </div>
              </div>
            </div>

            {/* Multi-Timeframe Alignment Matrix */}
            {signal.timeframeAlignment && signal.timeframeAlignment.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-slate-200">
                  Multi-Timeframe Price Action Alignment
                </h3>
                <div className="divide-y divide-slate-800/70 rounded-md border border-slate-800/90 bg-[#0B0F17]">
                  {signal.timeframeAlignment.map((row) => {
                    const isBest = row.timeframe === recommendedTf;
                    const rowBiasColor =
                      row.bias === 'Bullish'
                        ? 'text-emerald-400'
                        : row.bias === 'Bearish'
                        ? 'text-rose-400'
                        : 'text-amber-300';

                    return (
                      <button
                        key={row.timeframe}
                        type="button"
                        onClick={() => onSelectTimeframe(row.timeframe)}
                        className={`w-full px-3 py-2 text-left text-[11px] transition-colors hover:bg-slate-800/40 cursor-pointer ${
                          isBest ? 'bg-blue-500/10' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-semibold text-slate-100 w-7">
                              {row.timeframe}
                            </span>
                            <span className={`font-medium ${rowBiasColor}`}>
                              {row.bias}
                            </span>
                            <span className="text-slate-400">
                              · {row.structureEvent}
                            </span>
                          </div>
                          <span className="text-slate-400 shrink-0">
                            {isBest ? 'Signal TF' : row.rangeZone}
                          </span>
                        </div>
                        <div className="mt-0.5 pl-9 text-slate-400 truncate">
                          {row.note}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Pure Price Action Reasoning */}
            <div className="space-y-3 text-xs leading-relaxed">
              <div>
                <h3 className="font-semibold text-slate-200 mb-1">
                  Top-Down Price Action Read
                </h3>
                <p className="text-slate-300">{signal.priceActionNarrative}</p>
              </div>

              <div>
                <h3 className="font-semibold text-slate-200 mb-1">
                  Order Blocks, FVGs &amp; Liquidity Zones
                </h3>
                <p className="text-slate-300">{signal.keyZonesExplanation}</p>
              </div>

              <div>
                <h3 className="font-semibold text-slate-200 mb-1.5">
                  Pure Price-Action Confluences
                </h3>
                <ul className="space-y-1.5">
                  {signal.plan.confluences.map((item, idx) => (
                    <li
                      key={idx}
                      className="flex items-start gap-2 text-slate-300"
                    >
                      <CheckCircle2
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-400"
                        aria-hidden="true"
                      />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="border-t border-slate-800/70 pt-3">
                <span className="font-semibold text-slate-200">
                  Invalidation:{' '}
                </span>
                <span className="text-slate-400">
                  {signal.plan.invalidationReason}
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
