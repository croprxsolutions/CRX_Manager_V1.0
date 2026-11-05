import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import type { LockedRequestDetails } from '../hooks/useUncertainMutationIntent';
import { Sentry } from '../lib/sentry';
import ConfirmModal from './ui/ConfirmModal';
import { useToast } from './ui/Toast';

type ExpiredIntentLock = {
  clearableExpiredRequest: LockedRequestDetails | null;
  clearExpiredIntent: (expectedIdempotencyKey: string) => Promise<void>;
};

// KI-27: the only way out of an expired uncertain-mutation lock in this browser.
export default function ClearExpiredIntentButton({ intent, operation }: {
  intent: ExpiredIntentLock;
  operation: string;
}) {
  const { role } = useAuth();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const request = intent.clearableExpiredRequest;
  if (role !== 'admin' || !request) return null;

  const savedAt = new Date(request.createdAtMs).toLocaleString();
  const screen = request.surface.replace(/-/g, ' ');
  const record = request.scope ? ` for record ${request.scope}` : '';

  const handleClear = async () => {
    setClearing(true);
    try {
      await intent.clearExpiredIntent(request.idempotencyKey);
      Sentry.captureMessage('Admin cleared an expired uncertain mutation', {
        level: 'info',
        tags: { operation, surface: request.surface },
        extra: {
          scope: request.scope,
          idempotencyKey: request.idempotencyKey,
          createdAt: new Date(request.createdAtMs).toISOString(),
        },
      });
      setConfirmOpen(false);
      toast('success', 'Saved request cleared. This form can be used again.');
    } catch {
      toast('error', 'Could not clear this saved request: it may still be retryable, or its saved data is damaged. Reload the page; if it stays locked, report it.');
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        className="mt-2 block min-h-11 font-medium underline"
      >
        I checked the records — clear this
      </button>
      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void handleClear()}
        title="Clear the expired saved request?"
        message={`This request was saved ${savedAt} on the ${screen} screen${record}. If that time looks wrong, this device's clock may be off: do not clear it. First check that real record (the bill, payment, receipt or stock count) to see whether this request was saved. Clearing only removes the stuck request from this browser; it does not change any records. If it was not saved, you can enter it again afterwards.`}
        confirmLabel="Clear it"
        variant="warning"
        loading={clearing}
      />
    </>
  );
}
