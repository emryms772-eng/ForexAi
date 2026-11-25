import { ArrowDownRight, ArrowUpRight, Radio } from 'lucide-react';
import type {
  FeedOrigin,
  MarketInstrument,
  Timeframe,
} from '../types/market';

interface LivePriceHeaderProps {
  instrument: MarketInstrument;
  timeframe: Timeframe;
  price: number;
  bid: number;
  ask: number;
  changePct: number;
  sessionHigh: number;
  sessionLow: number;
  avgCandleRange: number;
  isConnected: boolean;
  source: FeedOrigin;
  sourceLabel: string;
}

export function LivePriceHeader({
  instrument,
  timeframe,
  price,
  bid,
  ask,
  changePct,
  sessionHigh,
  sessionLow,
  avgCandleRange,
  isConnected,
  source,
  sourceLabel,
}: LivePriceHeaderProps) {
  const isPositive = changePct >= 0;

  return (
    <section
      aria-label="Live market quote"
      className="border-b border-slate-800/90 bg-[#0D121C] px-4 py-3.5 sm:px-6"
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-slate-50">
              {instrument.symbol}
            </h1>
            <span className="text-sm text-slate-400">
              {instrument.name} <span aria-hidden="true">·</span> {instrument.category}{' '}
              <span aria-hidden="true">·</span> {timeframe} Pure Price Action
            </span>
          </div>

          <div className="flex items-baseline gap-3">
            <span className="font-mono tabular-nums text-2xl font-semibold text-white">
              {price.toFixed(instrument.decimals)}
            </span>
            <span
              className={`inline-flex items-center gap-1 font-mono tabular-nums text-sm font-medium ${
                isPositive ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {isPositive ? (
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ArrowDownRight className="h-4 w-4" aria-hidden="true" />
              )}
              {isPositive ? '+' : ''}
              {changePct.toFixed(2)}%
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          <div>
            <span className="text-slate-500 mr-1.5">Bid / Ask</span>
            <span className="font-mono tabular-nums text-slate-200">
              {bid.toFixed(instrument.decimals)} / {ask.toFixed(instrument.decimals)}
            </span>
          </div>

          <div>
            <span className="text-slate-500 mr-1.5">Session High</span>
            <span className="font-mono tabular-nums text-slate-200">
              {sessionHigh.toFixed(instrument.decimals)}
            </span>
          </div>

          <div>
            <span className="text-slate-500 mr-1.5">Session Low</span>
            <span className="font-mono tabular-nums text-slate-200">
              {sessionLow.toFixed(instrument.decimals)}
            </span>
          </div>

          <div>
            <span className="text-slate-500 mr-1.5">Avg Bar Range</span>
            <span className="font-mono tabular-nums text-slate-200">
              {avgCandleRange.toFixed(instrument.decimals)}
            </span>
          </div>

          <div className="flex items-center gap-2 text-slate-300">
            <Radio
              className={`h-3.5 w-3.5 ${
                isConnected ? 'text-emerald-400' : 'text-amber-400'
              }`}
              aria-hidden="true"
            />
            <span>
              {isConnected ? 'Live Stream' : 'Reconnecting'}{' '}
              <span aria-hidden="true">·</span>{' '}
              <span className="text-slate-400">
                {source === 'live-api' ? sourceLabel : sourceLabel}
              </span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
