import { ArrowDownRight, ArrowUpRight, Clock } from 'lucide-react';
import { getInstrumentBySymbol } from '../config/instruments';
import type {
  AIPriceActionSignal,
  KeyLevel,
  PriceActionZone,
  Timeframe,
} from '../types/market';

interface PriceActionZonesPanelProps {
  symbol: string;
  decimals: number;
  levels: KeyLevel[];
  zones: PriceActionZone[];
  signalHistory: AIPriceActionSignal[];
  onSelectSignal: (signal: AIPriceActionSignal) => void;
  onSelectSymbolTimeframe: (symbol: string, timeframe: Timeframe) => void;
}

export function PriceActionZonesPanel({
  symbol,
  decimals,
  levels,
  zones,
  signalHistory,
  onSelectSignal,
  onSelectSymbolTimeframe,
}: PriceActionZonesPanelProps) {
  return (
    <section
      id="levels"
      aria-label="Active price action zones and signal log"
      className="grid grid-cols-1 gap-4 lg:grid-cols-12"
    >
      {/* Active Price Action Zones & S/R Matrix */}
      <div className="lg:col-span-7 rounded-lg border border-slate-800/90 bg-[#111722] overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-100">
            Active Price Action Zones &amp; Key Levels
          </h2>
          <span className="text-xs text-slate-400">
            {symbol} <span aria-hidden="true">·</span> OB, FVG &amp; Swing S/R
          </span>
        </div>

        {zones.length === 0 && levels.length === 0 ? (
          <div className="p-6 text-xs text-slate-400">
            Scanning candlesticks for swing pivots, order blocks, and imbalances...
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800/70 text-slate-400">
                  <th className="px-5 py-2.5 font-medium">Zone / Structure</th>
                  <th className="px-5 py-2.5 font-medium">Classification</th>
                  <th className="px-5 py-2.5 font-medium text-right">
                    Price / Range
                  </th>
                  <th className="px-5 py-2.5 font-medium text-right">
                    Distance
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {zones.map((z) => {
                  const isBull =
                    z.kind === 'Demand OB' || z.kind === 'Bullish FVG';
                  return (
                    <tr
                      key={z.id}
                      className="transition-colors hover:bg-slate-800/30"
                    >
                      <td
                        className={`px-5 py-2.5 font-medium ${
                          isBull ? 'text-sky-400' : 'text-rose-400'
                        }`}
                      >
                        {z.kind}
                      </td>
                      <td className="px-5 py-2.5 text-slate-300">Unmitigated</td>
                      <td className="px-5 py-2.5 text-right font-mono tabular-nums font-semibold text-slate-100">
                        {z.low.toFixed(decimals)} – {z.high.toFixed(decimals)}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono tabular-nums text-slate-300">
                        {z.distancePct >= 0 ? '+' : ''}
                        {z.distancePct.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
                {levels.map((lvl) => {
                  const isSupport = lvl.type === 'Support';
                  return (
                    <tr
                      key={lvl.id}
                      className="transition-colors hover:bg-slate-800/30"
                    >
                      <td
                        className={`px-5 py-2.5 font-medium ${
                          isSupport ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      >
                        {lvl.type}
                      </td>
                      <td className="px-5 py-2.5 text-slate-300">
                        {lvl.strength} ({lvl.touches} touches)
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono tabular-nums font-semibold text-slate-100">
                        {lvl.price.toFixed(decimals)}
                      </td>
                      <td className="px-5 py-2.5 text-right font-mono tabular-nums text-slate-300">
                        {lvl.distancePct >= 0 ? '+' : ''}
                        {lvl.distancePct.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Generated AI Signal Log */}
      <div className="lg:col-span-5 rounded-lg border border-slate-800/90 bg-[#111722] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-100">
            AI Signal Log
          </h2>
          <span className="font-mono tabular-nums text-xs text-slate-400">
            {signalHistory.length} generated
          </span>
        </div>

        {signalHistory.length === 0 ? (
          <div className="p-6 text-xs leading-relaxed text-slate-400 my-auto">
            No price-action signals generated yet this session. Click{' '}
            <strong className="font-semibold text-slate-200">
              Generate Signal
            </strong>{' '}
            to study any pair and log its entry, stop-loss, and target levels here.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/60 max-h-[340px] overflow-y-auto">
            {signalHistory.map((sig) => {
              const inst = getInstrumentBySymbol(sig.symbol);
              const dirColor =
                sig.plan.signal === 'BUY'
                  ? 'text-emerald-400'
                  : sig.plan.signal === 'SELL'
                  ? 'text-rose-400'
                  : 'text-amber-300';

              return (
                <button
                  key={sig.id}
                  type="button"
                  onClick={() => {
                    onSelectSignal(sig);
                    onSelectSymbolTimeframe(sig.symbol, sig.signalTimeframe);
                  }}
                  className="w-full px-5 py-3 text-left transition-colors hover:bg-slate-800/35 cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      {sig.plan.signal === 'BUY' ? (
                        <ArrowUpRight
                          className="h-3.5 w-3.5 text-emerald-400"
                          aria-hidden="true"
                        />
                      ) : sig.plan.signal === 'SELL' ? (
                        <ArrowDownRight
                          className="h-3.5 w-3.5 text-rose-400"
                          aria-hidden="true"
                        />
                      ) : (
                        <Clock
                          className="h-3.5 w-3.5 text-amber-300"
                          aria-hidden="true"
                        />
                      )}
                      <span className={`text-xs font-bold ${dirColor}`}>
                        {sig.plan.signal}
                      </span>
                      <span className="text-xs font-semibold text-slate-100">
                        {sig.symbol} · {sig.signalTimeframe}
                      </span>
                    </div>

                    <span className="font-mono tabular-nums text-[11px] text-slate-400">
                      R:R {sig.plan.riskRewardRatio}
                    </span>
                  </div>

                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <span className="truncate text-slate-400 max-w-[210px]">
                      {sig.plan.setupType}
                    </span>
                    <span className="font-mono tabular-nums text-slate-300">
                      E {sig.plan.entryPrice.toFixed(inst.decimals)}{' '}
                      <span aria-hidden="true">·</span> SL{' '}
                      {sig.plan.stopLoss.toFixed(inst.decimals)}{' '}
                      <span aria-hidden="true">·</span> TP1{' '}
                      {sig.plan.takeProfit1.toFixed(inst.decimals)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
