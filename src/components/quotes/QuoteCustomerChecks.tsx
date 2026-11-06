import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
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

