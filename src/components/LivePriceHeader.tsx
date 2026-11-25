import { ArrowDownRight, ArrowUpRight, ChevronDown, Radio } from 'lucide-react';
import type {
  MarketInstrument,
  Timeframe,
} from '../types/market';

interface LivePriceHeaderProps {
  instrument: MarketInstrument;
  timeframe: Timeframe;
  price: number;
  changePct: number;
  sessionHigh: number;
  sessionLow: number;
  isConnected: boolean;
  sourceLabel: string;
  onOpenMarkets: () => void;
}

export function LivePriceHeader({
  instrument,
  timeframe,
  price,
  changePct,
  sessionHigh,
  sessionLow,
  isConnected,
  sourceLabel,
  onOpenMarkets,
}: LivePriceHeaderProps) {
  const isPositive = changePct >= 0;

  return (
    <section
      aria-label="Live market quote"
      className="border-b border-slate-800/90 bg-[#0D121C] px-4 py-3 sm:px-6"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-start sm:gap-5">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onOpenMarkets}
              className="lg:hidden inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-700/90 bg-[#111722] px-3 py-1.5 text-base font-bold tracking-tight text-slate-50 hover:bg-slate-800 cursor-pointer"
            >
              <span>{instrument.symbol}</span>
              <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden="true" />
            </button>

            <h1 className="hidden lg:block text-xl font-bold tracking-tight text-slate-50">
              {instrument.symbol}
            </h1>

            <span className="hidden sm:inline text-xs text-slate-400">
              {instrument.name} <span aria-hidden="true">·</span> {timeframe}
            </span>
          </div>

          <div className="flex items-baseline gap-2.5">
            <span className="font-mono tabular-nums text-xl sm:text-2xl font-semibold text-white">
              {price.toFixed(instrument.decimals)}
            </span>
            <span
              className={`inline-flex items-center gap-0.5 font-mono tabular-nums text-xs sm:text-sm font-medium ${
                isPositive ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {isPositive ? (
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {isPositive ? '+' : ''}
              {changePct.toFixed(2)}%
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          <div className="text-slate-400">
            Range{' '}
            <span className="font-mono tabular-nums text-slate-200">
              {sessionLow.toFixed(instrument.decimals)} – {sessionHigh.toFixed(instrument.decimals)}
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-slate-300">
            <Radio
              className={`h-3.5 w-3.5 ${
                isConnected ? 'text-emerald-400' : 'text-amber-400'
              }`}
              aria-hidden="true"
            />
            <span className="truncate max-w-[180px] sm:max-w-none text-slate-400">
              {isConnected ? sourceLabel : 'Reconnecting...'}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
