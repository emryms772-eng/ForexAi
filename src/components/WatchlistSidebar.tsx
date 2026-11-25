import { ArrowDownRight, ArrowUpRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MarketCategory, WatchlistQuote } from '../types/market';

interface WatchlistSidebarProps {
  quotes: WatchlistQuote[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  isLoading: boolean;
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
  onSelectSymbol,
  isLoading,
}: WatchlistSidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'All' | MarketCategory>('All');

  const filteredQuotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return quotes.filter((item) => {
      const matchesCat =
        categoryFilter === 'All' || item.category === categoryFilter;
      const matchesSearch =
        !q ||
        item.symbol.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q);
      return matchesCat && matchesSearch;
    });
  }, [quotes, searchQuery, categoryFilter]);

  return (
    <aside className="w-full lg:w-64 xl:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800/90 bg-[#0D121C]">
      <div className="p-4 border-b border-slate-800/80 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Markets Watchlist</h2>
          <span className="text-xs font-mono tabular-nums text-slate-400">
            {quotes.length} pairs
          </span>
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
            placeholder="Filter symbol or asset..."
            aria-label="Filter instruments"
            className="w-full rounded-md border border-slate-800 bg-[#0B0F17] py-1.5 pl-8 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
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
                className={`rounded px-1 py-1 text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
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

      <div className="divide-y divide-slate-800/60 max-h-[320px] lg:max-h-[calc(100vh-11rem)] overflow-y-auto">
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
            return (
              <button
                key={quote.symbol}
                type="button"
                onClick={() => onSelectSymbol(quote.symbol)}
                className={`w-full px-4 py-3 text-left transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${
                  isSelected
                    ? 'bg-slate-800/60'
                    : 'hover:bg-slate-800/30'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={`text-sm font-semibold tracking-tight whitespace-nowrap ${
                      isSelected ? 'text-white' : 'text-slate-200'
                    }`}
                  >
                    {quote.symbol}
                  </span>
                  <span className="font-mono tabular-nums text-sm font-medium text-slate-100">
                    {quote.price.toFixed(quote.decimals)}
                  </span>
                </div>

                <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-slate-400">
                    {quote.category} <span aria-hidden="true">·</span>{' '}
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
    </aside>
  );
}
