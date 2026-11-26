import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Lock,
  RefreshCw,
  Send,
  ShieldAlert,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  evaluateSignalEntryTiming,
  formatCountdown,
  formatUtcTime,
} from '../analysis/entryTiming';
import { formatSmsSignalText } from '../analysis/mtfPrompt';
import { getCandleProgress } from '../analysis/priceAction';
import type {
  AIPriceActionSignal,
  OHLCVCandle,
  Timeframe,
} from '../types/market';

interface AIAnalysisCardProps {
  symbol: string;
  timeframe: Timeframe;
  decimals: number;
  livePrice?: number;
  formingCandle?: OHLCVCandle | null;
  signal: AIPriceActionSignal | null;
  isAnalyzing: boolean;
  error: string | null;
  smsConfigured?: boolean;
  smsSending?: boolean;
  ntfyReady?: boolean;
  ntfySending?: boolean;
  onGenerateSignal: () => void;
  onSelectTimeframe: (tf: Timeframe) => void;
  onExecuteOnDemo?: (signal: AIPriceActionSignal) => void;
  onSendSms?: (signal: AIPriceActionSignal) => void;
  onSendNtfy?: (signal: AIPriceActionSignal) => void;
}

export function AIAnalysisCard({
  symbol,
  timeframe,
  decimals,
  livePrice = 0,
  formingCandle = null,
  signal,
  isAnalyzing,
  error,
  smsConfigured = false,
  smsSending = false,
  ntfyReady = false,
  ntfySending = false,
  onGenerateSignal,
  onSelectTimeframe,
  onExecuteOnDemo,
  onSendSms,
  onSendNtfy,
}: AIAnalysisCardProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [copiedAlert, setCopiedAlert] = useState(false);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const timer = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const execProgress = useMemo(
    () => getCandleProgress('5M', nowSec),
    [nowSec]
  );

  const entryTiming = useMemo(() => {
    if (!signal) return null;
    return evaluateSignalEntryTiming({
      signal,
      livePrice: signal.symbol === symbol ? livePrice : signal.spotPriceAtSignal,
      formingCandle:
        signal.symbol === symbol && timeframe === '5M' ? formingCandle : null,
      activeChartTimeframe: timeframe,
      nowSec,
    });
  }, [signal, symbol, livePrice, timeframe, formingCandle, nowSec]);

  const handleCopySmsAlert = async () => {
    if (!signal) return;
    const text = formatSmsSignalText(signal);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAlert(true);
      setTimeout(() => setCopiedAlert(false), 2000);
    } catch {
      // Clipboard API unavailable in restricted frames
    }
  };

  const isDifferentSymbol = signal !== null && signal.symbol !== symbol;
  const recommendedTf = signal?.signalTimeframe ?? '5M';
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

  const timingStyle =
    entryTiming?.decision === 'ENTER_NOW'
      ? 'border-emerald-500/45 bg-emerald-500/12 text-emerald-100'
      : entryTiming?.decision === 'WAIT_CANDLE_CLOSE'
      ? 'border-amber-500/45 bg-amber-500/12 text-amber-100'
      : entryTiming?.decision === 'INVALIDATED' ||
        entryTiming?.decision === 'MISSED'
      ? 'border-rose-500/40 bg-rose-500/10 text-rose-100'
      : 'border-slate-700/90 bg-[#0B0F17] text-slate-200';

  return (
    <section
      id="setup"
      aria-label="5M AI price-action signal"
      className="flex flex-col rounded-lg border border-slate-800/90 bg-[#111722]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-800/80 px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-50">
            5M AI Signal
          </h2>
          <p className="mt-0.5 text-xs text-slate-400 font-mono tabular-nums truncate">
            {symbol} <span aria-hidden="true">·</span> Non-Repainting{' '}
            <span aria-hidden="true">·</span> 5M Close{' '}
            {formatCountdown(execProgress.secondsRemaining)}
          </p>
        </div>

        <button
          type="button"
          onClick={onGenerateSignal}
          disabled={isAnalyzing}
          className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${isAnalyzing ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span>{signal ? 'Refresh' : 'Scan 5M'}</span>
        </button>
      </div>

      <div className="p-4 sm:p-5 flex-1 flex flex-col gap-4">
        {isAnalyzing && (
          <div className="space-y-3">
            <div className="h-14 w-full rounded-md bg-slate-800/60 animate-pulse" />
            <div className="grid grid-cols-2 gap-2.5">
              <div className="h-14 rounded bg-slate-800/50 animate-pulse" />
              <div className="h-14 rounded bg-slate-800/50 animate-pulse" />
              <div className="h-14 rounded bg-slate-800/50 animate-pulse" />
              <div className="h-14 rounded bg-slate-800/50 animate-pulse" />
            </div>
            <p className="text-xs text-slate-400">
              Analyzing closed 4H–1M candles for {symbol} 5M setup...
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
                  Signal Unavailable
                </p>
                <p className="text-xs leading-relaxed text-rose-200/90 break-words">
                  {error}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onGenerateSignal}
              className="min-h-[38px] rounded-md bg-rose-600/80 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-rose-600 cursor-pointer"
            >
              Retry Scan
            </button>
          </div>
        )}

        {!isAnalyzing && !error && !signal && (
          <div className="my-auto py-6 text-center space-y-3.5">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-slate-800 bg-[#0B0F17] text-blue-400">
              <Zap className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-slate-100">
                Ready to Scan {symbol}
              </h3>
              <p className="mx-auto max-w-xs text-xs leading-relaxed text-slate-400">
                Locks strictly to closed 5M candles so signals never repaint mid-bar,
                and tells you whether to enter now or wait for candle close.
              </p>
            </div>
            <button
              type="button"
              onClick={onGenerateSignal}
              className="inline-flex min-h-[42px] items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 cursor-pointer"
            >
              <Zap className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Scan 5M Setup</span>
            </button>
          </div>
        )}

        {!isAnalyzing && signal && (
          <>
            {isDifferentSymbol && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <span>Showing prior signal for {signal.symbol}.</span>
                <button
                  type="button"
                  onClick={onGenerateSignal}
                  className="font-semibold text-amber-300 underline hover:text-amber-200 whitespace-nowrap cursor-pointer"
                >
                  Scan {symbol}
                </button>
              </div>
            )}

            {/* Primary Signal Action Header */}
            <div
              className={`flex flex-wrap items-center justify-between gap-2 rounded-md border p-3.5 ${signalBannerStyle}`}
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
                <div className="text-slate-400">{signal.model}</div>
              </div>
            </div>

            {/* Unambiguous Entry Timing Verdict: ENTER NOW vs WAIT FOR CANDLE CLOSE */}
            {entryTiming && (
              <div className={`rounded-md border p-3.5 space-y-2 ${timingStyle}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    {entryTiming.decision === 'ENTER_NOW' ? (
                      <CheckCircle2
                        className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400"
                        aria-hidden="true"
                      />
                    ) : entryTiming.decision === 'WAIT_CANDLE_CLOSE' ? (
                      <Clock
                        className="mt-0.5 h-4 w-4 shrink-0 text-amber-300"
                        aria-hidden="true"
                      />
                    ) : (
                      <ShieldAlert
                        className="mt-0.5 h-4 w-4 shrink-0 text-slate-300"
                        aria-hidden="true"
                      />
                    )}
                    <div className="text-xs font-bold tracking-tight">
                      {entryTiming.headline}
                    </div>
                  </div>
                  <span className="font-mono tabular-nums text-xs font-semibold shrink-0">
                    {formatCountdown(execProgress.secondsRemaining)}
                  </span>
                </div>

                <p className="text-xs leading-relaxed opacity-90">
                  {entryTiming.detail}
                </p>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2 text-[11px] opacity-85">
                  <span className="truncate">{entryTiming.closeCondition}</span>
                  <span className="inline-flex items-center gap-1 font-mono tabular-nums shrink-0 text-slate-300">
                    <Lock className="h-3 w-3" aria-hidden="true" />
                    <span>
                      {signal.confirmedBarTime > 0
                        ? `Locked ${formatUtcTime(signal.confirmedBarTime)} bar`
                        : 'Closed-bar locked'}
                    </span>
                  </span>
                </div>
              </div>
            )}

            {!isDifferentSymbol && !isViewingRecommendedTf && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-200">
                <span>Execution is on 5M (viewing {timeframe}).</span>
                <button
                  type="button"
                  onClick={() => onSelectTimeframe('5M')}
                  className="font-semibold text-blue-300 underline hover:text-blue-200 whitespace-nowrap cursor-pointer"
                >
                  Switch to 5M
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {onExecuteOnDemo && signal.plan.signal !== 'WAIT' && (
                <button
                  type="button"
                  onClick={() => onExecuteOnDemo(signal)}
                  className={`flex-1 min-h-[40px] rounded-md border px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    entryTiming?.decision === 'ENTER_NOW'
                      ? 'border-emerald-500/50 bg-emerald-600/20 text-emerald-200 hover:bg-emerald-600/30'
                      : 'border-blue-500/40 bg-blue-600/15 text-blue-200 hover:bg-blue-600/25'
                  }`}
                >
                  {entryTiming?.decision === 'ENTER_NOW'
                    ? `Enter ${signal.plan.signal} Now (Demo)`
                    : `Execute ${signal.plan.signal} (Demo)`}
                </button>
              )}

              <button
                type="button"
                onClick={handleCopySmsAlert}
                className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-md border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white whitespace-nowrap cursor-pointer"
              >
                {copiedAlert ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                )}
                <span>{copiedAlert ? 'Copied SMS' : 'Copy SMS'}</span>
              </button>

              {onSendNtfy && (
                <button
                  type="button"
                  onClick={() => onSendNtfy(signal)}
                  disabled={ntfySending || !ntfyReady}
                  title={
                    ntfyReady
                      ? 'Send instant free phone push via ntfy.sh'
                      : 'Enter or generate an ntfy topic in the Market Sniper Scanner first'
                  }
                  className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-md border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-45 whitespace-nowrap cursor-pointer"
                >
                  <Bell className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{ntfySending ? 'Pushing...' : 'Push ntfy'}</span>
                </button>
              )}

              {onSendSms && smsConfigured && (
                <button
                  type="button"
                  onClick={() => onSendSms(signal)}
                  disabled={smsSending}
                  title="Send this signal via SMS"
                  className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-md border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white disabled:opacity-45 whitespace-nowrap cursor-pointer"
                >
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{smsSending ? 'Sending...' : 'Send SMS'}</span>
                </button>
              )}
            </div>

            {/* Signal Execution Levels */}
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-md border border-slate-800/90 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">
                  {signalAction === 'WAIT' ? 'Watch Entry (5M)' : 'Entry (5M)'}
                </div>
                <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-blue-400">
                  {signal.plan.entryPrice > 0
                    ? signal.plan.entryPrice.toFixed(decimals)
                    : 'Wait for Trigger'}
                </div>
                <div className="mt-0.5 font-mono tabular-nums text-[11px] text-slate-400 truncate">
                  {signal.plan.entryZone}
                </div>
              </div>

              <div className="rounded-md border border-slate-800/90 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">
                  {signalAction === 'WAIT' ? 'Planned SL' : 'Stop Loss'}
                </div>
                <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-rose-400">
                  {signal.plan.stopLoss > 0
                    ? signal.plan.stopLoss.toFixed(decimals)
                    : '—'}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400 truncate">
                  {signal.plan.triggerPattern}
                </div>
              </div>

              <div className="rounded-md border border-slate-800/90 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">
                  {signalAction === 'WAIT' ? 'Target TP1' : 'Take Profit 1'}
                </div>
                <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-emerald-400">
                  {signal.plan.takeProfit1 > 0
                    ? signal.plan.takeProfit1.toFixed(decimals)
                    : '—'}
                </div>
              </div>

              <div className="rounded-md border border-slate-800/90 bg-[#0B0F17] p-3">
                <div className="text-[11px] text-slate-400">
                  {signalAction === 'WAIT' ? 'Target TP2' : 'Take Profit 2'}
                </div>
                <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-emerald-300">
                  {signal.plan.takeProfit2 > 0
                    ? signal.plan.takeProfit2.toFixed(decimals)
                    : '—'}
                </div>
              </div>
            </div>

            {/* Concise Top-Down Summary */}
            <div className="space-y-2 text-xs leading-relaxed">
              <p className="text-slate-300">{signal.priceActionNarrative}</p>
              <p className="text-slate-400">
                <span className="font-semibold text-slate-200">Invalidation: </span>
                {signal.plan.invalidationReason}
              </p>
            </div>

            {/* XAU/USD 3-Phase Gold Protocol Structured Output */}
            {signal.symbol === 'XAU/USD' && signal.goldProtocol && (
              <div className="rounded-md border border-amber-500/30 bg-[#0B0F17] p-3.5 space-y-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2">
                  <span className="font-semibold text-amber-300">
                    XAU/USD 3-Phase Protocol (H1 Anchor)
                  </span>
                  <span className="font-mono tabular-nums text-[11px] text-slate-300">
                    {signal.goldProtocol.psychologicalLevels.nearestBelow.price} (-
                    {signal.goldProtocol.psychologicalLevels.nearestBelow.distancePips}p) ·{' '}
                    {signal.goldProtocol.psychologicalLevels.nearestAbove.price} (+
                    {signal.goldProtocol.psychologicalLevels.nearestAbove.distancePips}p)
                  </span>
                </div>

                <div className="space-y-2 leading-relaxed">
                  <div>
                    <div className="font-semibold text-slate-200">
                      1. Current Bias &amp; Daily Scenario
                    </div>
                    <p className="text-slate-300 mt-0.5">
                      {signal.goldProtocol.sections.currentBiasAndScenario}
                    </p>
                  </div>

                  <div>
                    <div className="font-semibold text-slate-200">
                      2. Key Levels &amp; Confluence
                    </div>
                    <p className="text-slate-300 mt-0.5">
                      {signal.goldProtocol.sections.keyLevelsAndConfluence}
                    </p>
                  </div>

                  <div>
                    <div className="font-semibold text-slate-200">
                      3. Confirmation Status
                    </div>
                    <p className="text-slate-300 mt-0.5">
                      {signal.goldProtocol.sections.confirmationStatus}
                    </p>
                  </div>

                  <div>
                    <div
                      className={`font-semibold ${
                        signal.goldProtocol.volatilityFilter.status ===
                        'Elevated Fakeout Risk'
                          ? 'text-amber-300'
                          : 'text-slate-200'
                      }`}
                    >
                      4. Risk &amp; Volatility Warning
                    </div>
                    <p
                      className={`mt-0.5 ${
                        signal.goldProtocol.volatilityFilter.status ===
                        'Elevated Fakeout Risk'
                          ? 'text-amber-200/90'
                          : 'text-slate-300'
                      }`}
                    >
                      {signal.goldProtocol.sections.riskAndVolatilityWarning}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Collapsible Detailed MTF Breakdown */}
            <div className="border-t border-slate-800/80 pt-2">
              <button
                type="button"
                onClick={() => setShowBreakdown((v) => !v)}
                className="flex w-full min-h-[38px] items-center justify-between text-xs font-medium text-slate-300 hover:text-white cursor-pointer"
              >
                <span>
                  {showBreakdown
                    ? 'Hide MTF Breakdown & Zones'
                    : 'Show MTF Breakdown & Zones'}
                </span>
                {showBreakdown ? (
                  <ChevronUp className="h-4 w-4 text-slate-400" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden="true" />
                )}
              </button>

              {showBreakdown && (
                <div className="mt-3 space-y-4">
                  {signal.timeframeAlignment && signal.timeframeAlignment.length > 0 && (
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
                            className={`w-full min-h-[44px] px-3 py-2 text-left text-[11px] transition-colors hover:bg-slate-800/40 cursor-pointer ${
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
                                {isBest ? '5M Exec' : row.rangeZone}
                              </span>
                            </div>
                            <div className="mt-0.5 pl-9 text-slate-400 truncate">
                              {row.note}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className="space-y-2 text-xs leading-relaxed">
                    <div>
                      <h3 className="font-semibold text-slate-200 mb-1">
                        Order Blocks, FVGs &amp; Liquidity
                      </h3>
                      <p className="text-slate-300">{signal.keyZonesExplanation}</p>
                    </div>

                    {signal.plan.confluences.length > 0 && (
                      <ul className="space-y-1.5 pt-1">
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
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
