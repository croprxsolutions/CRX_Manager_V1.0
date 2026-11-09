import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Button from '../ui/Button';
import { creditExposure, describeCreditStatus } from '../../lib/creditLimitGuard';
import { Sentry } from '../../lib/sentry';

/**
 * The customer's credit status under the quote's customer picker (To-Do 1.8): open balance against
 * the credit limit, from customer_credit_exposure (the same figure the credit-limit warning uses).
 * Money owed only: never cost or margin. Callers hide it in Customer View.
 */
export function QuoteCreditStatus({ customerId }: { customerId: string }) {
  // Tagged with its customer so a switch never shows the previous customer's status, even for one render.
  const [result, setResult] = useState<{ customerId: string; status: { over: boolean; text: string } | 'error' } | null>(null);
  // Re-read when the app comes back into view and once a minute while it stays open, so an invoice
  // posted meanwhile shows before Convert.
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') setRefresh((n) => n + 1); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const timer = window.setInterval(onVisible, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!customerId) return;
    let current = true;
    creditExposure(customerId)
      .then((exposure) => { if (current) setResult({ customerId, status: describeCreditStatus(exposure) }); })
      .catch((err: unknown) => {
        Sentry.captureException(err, { tags: { action: 'quote_credit_status' } });
        if (current) setResult({ customerId, status: 'error' });
      });
    return () => { current = false; };
  }, [customerId, refresh]);

  const status = result?.customerId === customerId ? result.status : null;
  if (!status) return null;
  if (status === 'error') return <p className="mt-1 text-xs text-gray-500">Credit status unavailable</p>;
  return (
    <p className={`mt-1 text-xs ${status.over ? 'text-red-600 font-medium' : 'text-gray-600'}`}>
      {status.over && <AlertTriangle className="inline w-3.5 h-3.5 mr-1 -mt-0.5" aria-hidden="true" />}
      {status.text}
    </p>
  );
}


interface TierMismatchNoteProps {
  tier: number;
  assignedTier: number;
  acknowledged: boolean;
  onUseAssigned: () => void;
  onAcknowledge: (checked: boolean) => void;
}

/**
 * Shown when the quote's price tier differs from the customer's assigned tier (To-Do 1.6, KI-105). Saving
 * needs either switching back or ticking the box, so a different tier is always a deliberate choice.
 * Anyone may override (Mason, 2026-11-05); the check is on the screen only.
 */
export function TierMismatchNote({ tier, assignedTier, acknowledged, onUseAssigned, onAcknowledge }: TierMismatchNoteProps) {
  return (
    <div role="alert" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
      <p className="font-medium">This customer is assigned Tier {assignedTier}; this quote uses Tier {tier}.</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" variant="secondary" onClick={onUseAssigned}>Use Tier {assignedTier}</Button>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} />
          Quote at Tier {tier} anyway
        </label>
      </div>
    </div>
  );
}
