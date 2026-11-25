import { Activity, Briefcase, CandlestickChart, Layers } from 'lucide-react';
import type { NavSectionId } from './TopNavBar';

interface MobileBottomNavProps {
  activeSection: NavSectionId;
  openPositionCount: number;
  onNavigate: (section: NavSectionId) => void;
}

export function MobileBottomNav({
  activeSection,
  openPositionCount,
  onNavigate,
}: MobileBottomNavProps) {
  const tabs: Array<{
    id: NavSectionId;
    label: string;
    icon: typeof CandlestickChart;
    badge?: number;
  }> = [
    { id: 'workspace', label: 'Chart', icon: CandlestickChart },
    {
      id: 'demo',
      label: 'Demo',
      icon: Briefcase,
      badge: openPositionCount > 0 ? openPositionCount : undefined,
    },
    { id: 'backtest', label: 'Backtest', icon: Activity },
    { id: 'levels', label: 'Zones', icon: Layers },
  ];

  return (
    <nav
      aria-label="Mobile navigation"
      className="md:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-slate-800/90 bg-[#0B0F17]/95 backdrop-blur-md"
    >
      <div className="grid h-14 grid-cols-4 items-center">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeSection === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onNavigate(tab.id)}
              className={`relative flex h-full min-h-[44px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
                active ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="h-4.5 w-4.5" aria-hidden="true" />
              <span className="whitespace-nowrap">
                {tab.label}
                {tab.badge ? ` (${tab.badge})` : ''}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
