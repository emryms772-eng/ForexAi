import { ArrowDownRight, ArrowUpRight, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MarketCategory, WatchlistQuote } from '../types/market';

interface WatchlistSidebarProps {
  quotes: WatchlistQuote[];
  selectedSymbol: string;
  sniperBySymbol?: Record<string, 'BUY' | 'SELL'>;
  onSelectSymbol: (symbol: string) => void;
  isLoading: boolean;
  isMobileOpen: boolean;
  onCloseMobile: () => void;
}

const CATEGORY_FILTERS: Array<'All' | MarketCategory> = [
  'All',
  'Forex',
  'Metals',
  'Synthetic',
  'Digital',
];

export function WatchlistSidebar({
  quotes,
  selectedSymbol,
  sniperBySymbol = {},
  onSelectSymbol,
  isLoading,
  isMobileOpen,
  onCloseMobile,
}: WatchlistSidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'All' | MarketCategory>('All');
  const [sniperOnly, setSniperOnly] = useState(false);

  const sniperTotal = useMemo(
    () => Object.keys(sniperBySymbol).length,
    [sniperBySymbol]
  );

  const filteredQuotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return quotes.filter((item) => {
      const matchesCat =
        categoryFilter === 'All' || item.category === categoryFilter;
      const matchesSniper = !sniperOnly || Boolean(sniperBySymbol[item.symbol]);
      const matchesSearch =
        !q ||
        item.symbol.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q);
      return matchesCat && matchesSniper && matchesSearch;
    });
  }, [quotes, searchQuery, categoryFilter, sniperOnly, sniperBySymbol]);

  const handleSelect = (symbol: string) => {
    onSelectSymbol(symbol);
    onCloseMobile();
  };

  const panelBody = (
    <>
      <div className="p-4 border-b border-slate-800/80 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-slate-100">Markets</h2>
            <span className="text-xs font-mono tabular-nums text-slate-400">
              {quotes.length} pairs
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {sniperTotal > 0 && (
              <button
                type="button"
                onClick={() => setSniperOnly((v) => !v)}
                className={`rounded px-2 py-1 text-[11px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  sniperOnly
                    ? 'bg-emerald-600/25 text-emerald-300 border border-emerald-500/40'
                    : 'bg-slate-800/80 text-emerald-300 hover:bg-slate-800'
                }`}
              >
                {sniperTotal} Sniper
              </button>
            )}
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Close markets list"
              className="lg:hidden flex h-9 w-9 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search pair..."
            aria-label="Filter instruments"
            className="w-full min-h-[38px] rounded-md border border-slate-800 bg-[#0B0F17] py-1.5 pl-8 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div
          role="group"
          aria-label="Filter by asset class"
          className="grid grid-cols-5 gap-1 rounded-md bg-[#0B0F17] p-1 border border-slate-800/80"
        >
          {CATEGORY_FILTERS.map((cat) => {
            const active = categoryFilter === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                className={`min-h-[30px] rounded px-1 py-1 text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-slate-800 text-slate-50'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>
      </div>

      <div className="divide-y divide-slate-800/60 overflow-y-auto flex-1 lg:max-h-[calc(100vh-11.5rem)]">
        {isLoading && quotes.length === 0 ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="h-14 rounded-md bg-slate-800/40 animate-pulse"
              />
            ))}
          </div>
        ) : filteredQuotes.length === 0 ? (
          <div className="p-6 text-center space-y-2">
            <p className="text-xs text-slate-400">No instruments match your filter.</p>
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setCategoryFilter('All');
              }}
              className="text-xs font-medium text-blue-400 hover:text-blue-300 cursor-pointer"
            >
              Reset filters
            </button>
          </div>
        ) : (
          filteredQuotes.map((quote) => {
            const isSelected = quote.symbol === selectedSymbol;
            const isPositive = quote.changePct >= 0;
            const sniperSide = sniperBySymbol[quote.symbol];
            return (
              <button
                key={quote.symbol}
                type="button"
                onClick={() => handleSelect(quote.symbol)}
                className={`w-full min-h-[56px] px-4 py-3 text-left transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${
                  isSelected
                    ? 'bg-slate-800/70'
                    : 'hover:bg-slate-800/30'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span
                      className={`text-sm font-semibold tracking-tight whitespace-nowrap ${
                        isSelected ? 'text-white' : 'text-slate-200'
                      }`}
                    >
                      {quote.symbol}
                    </span>
                    {sniperSide && (
                      <span
                        className={`text-[11px] font-bold font-mono whitespace-nowrap ${
                          sniperSide === 'BUY'
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }`}
                      >
                        · {sniperSide}
                      </span>
                    )}
                  </div>
                  <span className="font-mono tabular-nums text-sm font-medium text-slate-100">
                    {quote.price.toFixed(quote.decimals)}
                  </span>
                </div>

                <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-slate-400">
                    {quote.structureHint || quote.name}
                  </span>
                  <span
                    className={`inline-flex items-center gap-0.5 font-mono tabular-nums shrink-0 ${
                      isPositive ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {isPositive ? (
                      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <ArrowDownRight className="h-3 w-3" aria-hidden="true" />
                    )}
                    {isPositive ? '+' : ''}
                    {quote.changePct.toFixed(2)}%
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>
    </>
  );

  return (
    <>
      {/* Desktop persistent left sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-64 xl:w-72 shrink-0 border-r border-slate-800/90 bg-[#0D121C]">
        {panelBody}
      </aside>

      {/* Mobile/Tablet bottom-sheet market switcher */}
      {isMobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 flex items-end bg-black/60 backdrop-blur-xs"
          onClick={onCloseMobile}
        >
          <aside
            aria-label="Select trading pair"
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[82vh] w-full flex-col rounded-t-2xl border-t border-slate-700/80 bg-[#0D121C]"
          >
            <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-slate-700" />
            {panelBody}
          </aside>
        </div>
      )}
    </>
  );
}
