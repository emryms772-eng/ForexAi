import { ShieldAlert } from 'lucide-react';

export function RiskDisclaimerBanner() {
  return (
    <section
      id="risk"
      aria-label="Risk disclosure and demo testing notice"
      className="rounded-lg border border-amber-500/30 bg-[#14171F] p-4 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-400"
          aria-hidden="true"
        />
        <div className="space-y-1.5 text-xs leading-relaxed text-slate-300">
          <h2 className="text-sm font-semibold text-amber-300">
            Risk Disclosure &amp; Demo Testing Notice
          </h2>
          <p>
            StrataDesk provides automated technical indicator calculations and
            AI-generated market structure commentary strictly for educational and
            analytical research purposes. Nothing displayed constitutes
            financial, investment, or trading advice.
          </p>
          <p className="text-slate-400">
            Trading leveraged instruments including forex, spot metals, CFDs, and
            synthetic volatility indices carries substantial risk of capital loss.
            Past price structure and technical setups never guarantee future
            performance or profits. Always validate any strategy on a risk-free{' '}
            <strong className="font-semibold text-slate-200">
              demo account
            </strong>{' '}
            and apply strict position sizing before risking live capital.
          </p>
        </div>
      </div>
    </section>
  );
}
