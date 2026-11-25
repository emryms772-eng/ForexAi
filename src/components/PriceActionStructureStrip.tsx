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
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="rounded-lg border border-slate-800/90 bg-[#111722] px-4 py-3">
        <div className="text-xs text-slate-400">Market Structure &amp; Break</div>
        <div className={`mt-1 text-sm font-semibold ${structureColor}`}>
          {snapshot.trendStructure}
        </div>
        <div className="mt-1 text-[11px] text-slate-300">
          Latest: <span className="font-medium text-sky-400">{snapshot.latestStructureEvent}</span>
        </div>
      </div>

      <div className="rounded-lg border border-slate-800/90 bg-[#111722] px-4 py-3">
        <div className="text-xs text-slate-400">Dealing Range (50% EQ)</div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className={`text-sm font-semibold ${rangeZoneColor}`}>
            {snapshot.rangeZone}
          </span>
          <span className="font-mono tabular-nums text-xs text-slate-300">
            {snapshot.rangePositionPct.toFixed(1)}%
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

      <div className="rounded-lg border border-slate-800/90 bg-[#111722] px-4 py-3">
        <div className="text-xs text-slate-400">Candle Pressure &amp; Trigger</div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className={`font-mono tabular-nums text-sm font-semibold ${pressureColor}`}>
            {snapshot.buyerPressurePct}% Buyers
          </span>
          <span className="text-[11px] text-slate-400">
            {100 - snapshot.buyerPressurePct}% Sellers
          </span>
        </div>
        <div className="mt-1 truncate text-[11px] text-slate-300">
          {snapshot.latestPattern
            ? snapshot.latestPattern.name
            : snapshot.recentSweep !== 'None'
            ? snapshot.recentSweep
            : 'No recent pattern trigger'}
        </div>
      </div>

      <div className="rounded-lg border border-slate-800/90 bg-[#111722] px-4 py-3">
        <div className="text-xs text-slate-400">Imbalances &amp; Liquidity</div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className="font-mono tabular-nums text-sm font-semibold text-slate-100">
            {snapshot.unmitigatedFvgCount} FVG <span aria-hidden="true">·</span>{' '}
            {snapshot.activeOrderBlockCount} OB
          </span>
          <span className="font-mono tabular-nums text-[11px] text-slate-400">
            EQ {snapshot.equilibriumPrice.toFixed(decimals)}
          </span>
        </div>
        <div className="mt-1 truncate text-[11px] text-slate-400">
          Sweep: <span className="text-slate-200">{snapshot.recentSweep}</span>
        </div>
      </div>
    </div>
  );
}
