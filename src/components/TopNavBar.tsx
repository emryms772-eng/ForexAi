import { Loader2, Zap } from 'lucide-react';

export type NavSectionId = 'workspace' | 'demo' | 'backtest' | 'levels' | 'setup';

interface TopNavBarProps {
  activeSection: NavSectionId;
  onNavigate: (section: NavSectionId) => void;
  onGenerateSignal: () => void;
  isAnalyzing: boolean;
}

export function TopNavBar({
  activeSection,
  onNavigate,
  onGenerateSignal,
  isAnalyzing,
}: TopNavBarProps) {
  const navItems: Array<{ id: NavSectionId; label: string }> = [
    { id: 'workspace', label: 'Price Chart' },
    { id: 'demo', label: 'Demo Desk' },
    { id: 'backtest', label: 'Backtest' },
    { id: 'levels', label: 'Zones & Log' },
    { id: 'setup', label: 'AI Signal' },
  ];

  return (
    <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-[#0B0F17]/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-8 px-4 sm:px-6">
        <a
          href="#workspace"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('workspace');
          }}
          className="text-lg font-bold tracking-tight text-slate-50 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
        >
          StrataDesk
        </a>

        <nav
          aria-label="Primary navigation"
          className="hidden md:flex items-center gap-6 text-sm font-medium"
        >
          {navItems.map((item) => {
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`py-1 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded ${
                  isActive
                    ? 'text-slate-50 underline underline-offset-8 decoration-blue-500 decoration-2'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onGenerateSignal}
            disabled={isAnalyzing}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors duration-150 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            {isAnalyzing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Zap className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>{isAnalyzing ? 'Scanning PA...' : 'Generate Signal'}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
