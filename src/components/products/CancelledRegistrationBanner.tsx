import { AlertTriangle } from 'lucide-react';
import {
  cancelledOnText, normalizeEpaRegistration, type CancelledRegistrations, type RegistrationCheck, type RegistrationSource,
} from '../../lib/epaRegistrationStatus';

/** Grand plan §8 (D-T, D-W): warn loudly, never block a sale. */
export default function CancelledRegistrationBanner({ sources, cancelled, check }: {
  sources: RegistrationSource[];
  cancelled: CancelledRegistrations;
  check: RegistrationCheck;
}) {
  const hits = sources.flatMap((source) => {
    const key = normalizeEpaRegistration(source.epaRegistration);
    return key && cancelled.has(key) ? [{ ...source, key, cancelledOn: cancelled.get(key) }] : [];
  });
  // A found cancellation always shows; an incomplete or unfinished check says so beside it.
  const notice = check === 'incomplete' ? (
    <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      Could not check whether all of this product's EPA registrations are cancelled. Reload the page to try again.
    </p>
  ) : check === 'checking' ? (
    <p className="text-xs text-secondary" role="status">Checking EPA registration status…</p>
  ) : null;
  if (hits.length === 0) return notice;
  return (
    <>
    <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900" role="alert" data-testid="cancelled-registration-banner">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
      <div>
        <p className="font-semibold">Cancelled EPA registration</p>
        <ul className="mt-1 list-disc pl-5">
          {hits.map((hit) => (
            <li key={`${hit.label}|${hit.key}`}>{hit.label}: EPA Reg. No. {hit.key}, {cancelledOnText(hit.cancelledOn)}.</li>
          ))}
        </ul>
        <p className="mt-1">Selling is not blocked. Check the registration with EPA before selling or applying it.</p>
      </div>
    </div>
    {notice}
    </>
  );
}
