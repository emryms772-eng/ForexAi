import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  Crosshair,
  Lock,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  evaluateSignalEntryTiming,
  formatCountdown,
  formatUtcTime,
} from '../analysis/entryTiming';
import { getCandleProgress } from '../analysis/priceAction';
import { getInstrumentBySymbol } from '../config/instruments';
import type {
  AIPriceActionSignal,
  MarketScanResponse,
  WatchlistQuote,
} from '../types/market';

interface MarketSniperScannerProps {
  scan: MarketScanResponse | null;
  isScanning: boolean;
  error: string | null;
  selectedSymbol: string;
  watchlist: WatchlistQuote[];
  smsConfigured: boolean;
  smsSending: boolean;
  ntfyTopic: string;
  ntfyAlertsEnabled: boolean;
  ntfyNotifyWait: boolean;
  ntfyReady: boolean;
  ntfySending: boolean;
  ntfyFeedback: string | null;
  onUpdateNtfyTopic: (topic: string) => void;
  onGenerateNtfyTopic: () => void;
  onToggleNtfyAlerts: () => void;
  onToggleNtfyNotifyWait: () => void;
  onTestNtfy: () => void;
  onSendNtfy: (signal: AIPriceActionSignal) => void;
  onScanMarket: () => void;
  onSelectSignal: (signal: AIPriceActionSignal) => void;
  onExecuteOnDemo: (signal: AIPriceActionSignal, spotOverride?: number) => void;
  onSendSms: (signal: AIPriceActionSignal) => void;
}

export function MarketSniperScanner({
  scan,
  isScanning,
  error,
  selectedSymbol,
  watchlist,
  smsConfigured,
  smsSending,
  ntfyTopic,
  ntfyAlertsEnabled,
  ntfyNotifyWait,
  ntfyReady,
  ntfySending,
  ntfyFeedback,
  onUpdateNtfyTopic,
  onGenerateNtfyTopic,
  onToggleNtfyAlerts,
  onToggleNtfyNotifyWait,
  onTestNtfy,
  onSendNtfy,
  onScanMarket,
  onSelectSignal,
  onExecuteOnDemo,
  onSendSms,
}: MarketSniperScannerProps) {
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

  const quotePriceMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const q of watchlist) {
      map.set(q.symbol, q.price);
    }
    return map;
  }, [watchlist]);

  const sniperCount = scan?.sniperSignals.length ?? 0;
  const closestWatch = useMemo(
    () => (scan?.watchSignals ?? []).slice(0, 3),
    [scan]
  );

  return (
    <section
      aria-label="AI Market Sniper Scanner"
      className="rounded-lg border border-slate-800/90 bg-[#111722]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2.5 min-w-0">
          <Crosshair
            className="h-4 w-4 text-blue-400 shrink-0"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <h2 className="text-sm font-semibold text-slate-50 whitespace-nowrap">
                AI Market Sniper Scanner
              </h2>
              <span className="text-xs font-mono tabular-nums text-slate-400 truncate">
                {scan
                  ? `${scan.totalScanned} markets · ${sniperCount} sniper ${
                      sniperCount === 1 ? 'entry' : 'entries'
                    } · Locked ${formatUtcTime(scan.confirmedBarTime)}`
                  : 'Sniper entries only · Closed 5M bar · Non-repainting'}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-mono tabular-nums text-slate-400">
            <Lock className="h-3 w-3 text-slate-500" aria-hidden="true" />
            <span>Next close {formatCountdown(execProgress.secondsRemaining)}</span>
          </span>

          <button
            type="button"
            onClick={onScanMarket}
            disabled={isScanning}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isScanning ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>{isScanning ? 'Scanning Markets...' : 'Scan All Markets'}</span>
          </button>
        </div>
      </div>

      {/* Zero-cost ntfy Phone Push Alert Setup Bar */}
      <div className="flex flex-col gap-2.5 border-b border-slate-800/70 bg-[#0D121C] px-4 py-2.5 sm:px-5 lg:flex-row lg:items-center lg:justify-between text-xs">
        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
          <div className="inline-flex items-center gap-1.5 text-slate-200 font-medium shrink-0">
            <Bell className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
            <span>ntfy Free Push Alerts</span>
          </div>

          <button
            type="button"
            onClick={onToggleNtfyAlerts}
            className={`min-h-[30px] rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              ntfyAlertsEnabled
                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                : 'border-slate-700 bg-[#0B0F17] text-slate-400 hover:text-slate-200'
            }`}
          >
            {ntfyAlertsEnabled ? 'Auto-Push On' : 'Auto-Push Off'}
          </button>

          <button
            type="button"
            onClick={onToggleNtfyNotifyWait}
            title="Switch between receiving every 5M scan + Closest Watch alert or BUY/SELL sniper entries only"
            className={`min-h-[30px] rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
              ntfyNotifyWait
                ? 'border-blue-500/40 bg-blue-500/15 text-blue-200'
                : 'border-slate-700 bg-[#0B0F17] text-slate-300 hover:text-white'
            }`}
          >
            {ntfyNotifyWait ? 'All Scans (incl. Watch)' : 'BUY / SELL Only'}
          </button>

          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={ntfyTopic}
              onChange={(e) => onUpdateNtfyTopic(e.target.value)}
              placeholder="Topic e.g. stratadesk-yourname-7294"
              aria-label="ntfy topic name"
              className="w-52 sm:w-60 min-h-[30px] rounded-md border border-slate-700 bg-[#0B0F17] px-2.5 py-1 font-mono text-[11px] text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={onGenerateNtfyTopic}
              title="Generate a private random ntfy topic name"
              className="inline-flex min-h-[30px] items-center gap-1 rounded-md border border-slate-700 bg-[#0B0F17] px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:border-slate-500 hover:text-white whitespace-nowrap cursor-pointer"
            >
              <Sparkles className="h-3 w-3 text-blue-400" aria-hidden="true" />
              <span>Generate</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[11px] text-slate-400">
            {ntfyFeedback
              ? ntfyFeedback
              : ntfyReady
              ? 'Subscribe to this exact topic in the free ntfy app.'
              : 'Enter or generate a topic, then subscribe in the ntfy app.'}
          </span>
          <button
            type="button"
            onClick={onTestNtfy}
            disabled={ntfySending || !ntfyReady}
            title={
              ntfyReady
                ? 'Send a test push notification via ntfy.sh'
                : 'Enter or generate a topic name (min 4 chars) first'
            }
            className="inline-flex min-h-[30px] items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-45 whitespace-nowrap cursor-pointer"
          >
            <Bell className="h-3 w-3" aria-hidden="true" />
            <span>{ntfySending ? 'Sending...' : 'Test Push'}</span>
          </button>
        </div>
      </div>

      {isScanning && !scan && (
        <div className="p-4 sm:px-5 space-y-2.5">
          <div className="h-11 w-full rounded bg-slate-800/50 animate-pulse" />
          <div className="h-11 w-full rounded bg-slate-800/40 animate-pulse" />
          <p className="text-xs text-slate-400">
            Scanning all 14 markets across 4H–1M closed bars for A+ sniper setups...
          </p>
        </div>
      )}

      {!isScanning && error && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5 text-xs text-rose-200">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle
              className="h-4 w-4 text-rose-400 shrink-0"
              aria-hidden="true"
            />
            <span className="truncate">{error}</span>
          </div>
          <button
            type="button"
            onClick={onScanMarket}
            className="rounded-md bg-rose-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-600 cursor-pointer shrink-0"
          >
            Retry Scan
          </button>
        </div>
      )}

      {scan && sniperCount > 0 && (
        <div className="divide-y divide-slate-800/70">
          {scan.sniperSignals.map((sig) => {
            const inst = getInstrumentBySymbol(sig.symbol);
            const d = inst.decimals;
            const liveSpot = quotePriceMap.get(sig.symbol) ?? sig.spotPriceAtSignal;
            const timing = evaluateSignalEntryTiming({
              signal: sig,
              livePrice: liveSpot,
              nowSec,
            });
            const isBuy = sig.plan.signal === 'BUY';
            const isSelected = sig.symbol === selectedSymbol;

            const verdictLabel =
              timing.decision === 'ENTER_NOW'
                ? `FIRE ${sig.plan.signal} NOW`
                : timing.decision === 'WAIT_CANDLE_CLOSE'
                ? 'WAIT 5M CLOSE'
                : timing.decision === 'MISSED'
                ? 'DO NOT CHASE'
                : 'INVALIDATED';

            const verdictColor =
              timing.decision === 'ENTER_NOW'
                ? 'text-emerald-300'
                : timing.decision === 'WAIT_CANDLE_CLOSE'
                ? 'text-amber-300'
                : 'text-rose-300';

            return (
              <div
                key={sig.id}
                className={`flex flex-col gap-3 px-4 py-3.5 sm:px-5 lg:flex-row lg:items-center lg:justify-between transition-colors ${
                  isSelected ? 'bg-slate-800/35' : 'hover:bg-slate-800/20'
                }`}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span
                      className={`inline-flex items-center gap-1 text-xs font-bold ${
                        isBuy ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {isBuy ? (
                        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {sig.plan.signal}
                    </span>

                    <button
                      type="button"
                      onClick={() => onSelectSignal(sig)}
                      className="text-sm font-semibold text-slate-50 hover:text-blue-300 transition-colors cursor-pointer"
                    >
                      {sig.symbol}
                    </button>

                    <span className="text-xs text-slate-400">
                      {sig.plan.setupType}
                    </span>

                    <span
                      className={`text-xs font-semibold font-mono tabular-nums ${verdictColor}`}
                    >
                      · {verdictLabel}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono tabular-nums text-slate-300">
                    <span>
                      Entry{' '}
                      <strong className="text-blue-300 font-semibold">
                        {sig.plan.entryPrice.toFixed(d)}
                      </strong>
                    </span>
                    <span>
                      SL{' '}
                      <strong className="text-rose-300 font-semibold">
                        {sig.plan.stopLoss.toFixed(d)}
                      </strong>
                    </span>
                    <span>
                      TP1{' '}
                      <strong className="text-emerald-300 font-semibold">
                        {sig.plan.takeProfit1.toFixed(d)}
                      </strong>
                    </span>
                    <span>
                      TP2{' '}
                      <strong className="text-emerald-400 font-semibold">
                        {sig.plan.takeProfit2.toFixed(d)}
                      </strong>
                    </span>
                    <span className="text-slate-400">
                      R:R {sig.plan.riskRewardRatio}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => onSelectSignal(sig)}
                    className="min-h-[36px] rounded-md border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 hover:text-white whitespace-nowrap cursor-pointer"
                  >
                    {isSelected ? 'On Chart (5M)' : 'Load Chart'}
                  </button>

                  {timing.decision !== 'INVALIDATED' && (
                    <button
                      type="button"
                      onClick={() => onExecuteOnDemo(sig, liveSpot)}
                      className={`min-h-[36px] rounded-md border px-3 py-1.5 text-xs font-semibold whitespace-nowrap cursor-pointer ${
                        isBuy
                          ? 'border-emerald-500/45 bg-emerald-600/20 text-emerald-200 hover:bg-emerald-600/30'
                          : 'border-rose-500/45 bg-rose-600/20 text-rose-200 hover:bg-rose-600/30'
                      }`}
                    >
                      Take {sig.plan.signal} (Demo)
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onSendNtfy(sig)}
                    disabled={ntfySending || !ntfyReady}
                    title={
                      ntfyReady
                        ? 'Push this sniper entry to your phone via ntfy'
                        : 'Set an ntfy topic above first'
                    }
                    className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-45 whitespace-nowrap cursor-pointer"
                  >
                    <Bell className="h-3 w-3" aria-hidden="true" />
                    <span>ntfy</span>
                  </button>

                  {smsConfigured && (
                    <button
                      type="button"
                      onClick={() => onSendSms(sig)}
                      disabled={smsSending}
                      className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-slate-700 bg-[#0B0F17] px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-45 whitespace-nowrap cursor-pointer"
                    >
                      <Send className="h-3 w-3" aria-hidden="true" />
                      <span>SMS</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {scan && sniperCount === 0 && (
        <div className="px-4 py-3.5 sm:px-5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-start gap-2.5 min-w-0">
              <ShieldCheck
                className="mt-0.5 h-4 w-4 text-slate-400 shrink-0"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-100">
                  No A+ Sniper Entries on This 5M Close — Stay Flat
                </p>
                <p className="mt-0.5 text-xs text-slate-400">
                  All {scan.totalScanned} markets were filtered strictly on closed bars
                  (4H/1H consensus + OTE zone + ≥1:2.4 R:R). Next re-scan runs
                  automatically on candle close in{' '}
                  <span className="font-mono tabular-nums text-slate-200">
                    {formatCountdown(execProgress.secondsRemaining)}
                  </span>
                  .
                </p>
              </div>
            </div>
          </div>

          {closestWatch.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-slate-800/70 pt-2.5 text-xs">
              <span className="text-slate-400 font-medium">Closest Watch:</span>
              {closestWatch.map((w) => {
                const inst = getInstrumentBySymbol(w.symbol);
                return (
                  <button
                    key={w.symbol}
                    type="button"
                    onClick={() => onSelectSignal(w)}
                    className="inline-flex items-center gap-1.5 font-mono tabular-nums text-slate-300 hover:text-blue-300 transition-colors cursor-pointer"
                  >
                    <span className="font-sans font-semibold text-slate-100">
                      {w.symbol}
                    </span>
                    <span
                      className={
                        w.bias === 'Bullish'
                          ? 'text-emerald-400'
                          : w.bias === 'Bearish'
                          ? 'text-rose-400'
                          : 'text-slate-400'
                      }
                    >
                      {w.bias}
                    </span>
                    <span className="text-slate-400">
                      @ {w.plan.entryPrice.toFixed(inst.decimals)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
