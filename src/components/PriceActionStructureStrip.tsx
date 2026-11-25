import type { PriceActionSnapshot } from '../types/market';

interface PriceActionStructureStripProps {
  snapshot: PriceActionSnapshot;
  decimals: number;
}

export function PriceActionStructureStrip({
  snapshot,
  decimals,
}: PriceActionStructureStripProps) {
  const structureColor = snapshot.trendStructure.startsWith('Bullish')
    ? 'text-emerald-400'
    : snapshot.trendStructure.startsWith('Bearish')
    ? 'text-rose-400'
    : 'text-amber-300';

  const rangeZoneColor =
    snapshot.rangeZone === 'Discount'
      ? 'text-emerald-400'
      : snapshot.rangeZone === 'Premium'
      ? 'text-rose-400'
      : 'text-slate-200';

  const pressureColor =
    snapshot.buyerPressurePct >= 56
      ? 'text-emerald-400'
      : snapshot.buyerPressurePct <= 44
      ? 'text-rose-400'
      : 'text-slate-200';

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
      <div className="rounded-lg border border-slate-800/90 bg-[#111722] px-3.5 py-2.5 sm:px-4 sm:py-3">
        <div className="text-[11px] text-slate-400">Structure</div>
        <div className={`mt-1 text-xs sm:text-sm font-semibold truncate ${structureColor}`}>
          {snapshot.trendStructure}
        </div>
        <div className="mt-0.5 text-[11px] text-sky-400 truncate">
          {snapshot.latestStructureEvent}
        </div>
      </div>

      <div className="rounded-lg border border-slate-800/90 bg-[#111722] px-3.5 py-2.5 sm:px-4 sm:py-3">
        <div className="text-[11px] text-slate-400">Dealing Range</div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className={`text-xs sm:text-sm font-semibold ${rangeZoneColor}`}>
            {snapshot.rangeZone}
          </span>
          <span className="font-mono tabular-nums text-[11px] text-slate-300">
            {snapshot.rangePositionPct.toFixed(0)}%
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            className={`h-full transition-all duration-200 ${
              snapshot.rangeZone === 'Discount'
                ? 'bg-emerald-500'
                : snapshot.rangeZone === 'Premium'
                ? 'bg-rose-500'
                : 'bg-sky-400'
            }`}
            style={{ width: `${snapshot.rangePositionPct}%` }}
          />
        </div>
      </div>

      <div className="rounded-lg border border-slate-800/90 bg-[#111722] px-3.5 py-2.5 sm:px-4 sm:py-3">
        <div className="text-[11px] text-slate-400">Candle Pressure</div>
        <div className={`mt-1 font-mono tabular-nums text-xs sm:text-sm font-semibold ${pressureColor}`}>
          {snapshot.buyerPressurePct}% Buyers
        </div>
        <div className="mt-0.5 truncate text-[11px] text-slate-400">
          {snapshot.latestPattern
            ? snapshot.latestPattern.name
            : snapshot.recentSweep !== 'None'
            ? snapshot.recentSweep
            : 'No recent trigger'}
        </div>
      </div>

      <div className="rounded-lg border border-slate-800/90 bg-[#111722] px-3.5 py-2.5 sm:px-4 sm:py-3">
        <div className="text-[11px] text-slate-400">Zones &amp; 50% EQ</div>
        <div className="mt-1 font-mono tabular-nums text-xs sm:text-sm font-semibold text-slate-100">
          {snapshot.unmitigatedFvgCount} FVG · {snapshot.activeOrderBlockCount} OB
        </div>
        <div className="mt-0.5 font-mono tabular-nums text-[11px] text-slate-400 truncate">
          EQ {snapshot.equilibriumPrice.toFixed(decimals)}
        </div>
      </div>
    </div>
  );
}
