import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { UncertainClearNotYetError, type LockedRequestDetails } from '../hooks/useUncertainMutationIntent';
import { logActivity } from '../lib/activityLogger';
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
  const { role, profile } = useAuth();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const request = intent.clearableExpiredRequest;
  if (role !== 'admin' || !profile || !request) return null;

  const savedAt = new Date(request.createdAtMs).toLocaleString();
  const screen = request.surface.replace(/-/g, ' ');
  const record = request.scope ? ` for record ${request.scope}` : '';

  const handleClear = async () => {
    setClearing(true);
    // The approval is recorded first, so no clear can happen without an audit row;
    // the clear itself may still refuse (retryable or damaged saved data).
    const logged = await logActivity({
      event: 'uncertain_request_clear_approved',
      description: `Admin approved clearing an expired ${operation} request saved ${new Date(request.createdAtMs).toISOString()} `
        + `on ${request.surface}${request.scope ? ` (record ${request.scope})` : ''}; request key ${request.idempotencyKey}`,
      performedBy: profile.id,
    });
    if (!logged) {
      toast('error', 'Could not record this clear in the activity log, so nothing was cleared. Try again.');
      setClearing(false);
      return;
    }
    try {
      await intent.clearExpiredIntent(request.idempotencyKey);
    } catch (err) {
      if (err instanceof UncertainClearNotYetError) {
        toast('warning', err.reason === 'in_progress'
          ? 'This request is being saved right now, so nothing was cleared. Wait a minute, reload the page and check the record again.'
          : `The server cannot yet confirm this request is finished, so nothing was cleared. Try again after ${err.waitUntil ? new Date(err.waitUntil).toLocaleTimeString() : '15 minutes'}.`);
        setClearing(false);
        setConfirmOpen(false);
        return;
      }
      toast('error', 'Could not clear this saved request: it may still be retryable, or its saved data is damaged. Reload the page; if it stays locked, report it.');
      setClearing(false);
      return;
    }
    try {
      Sentry.captureMessage('Admin cleared an expired uncertain mutation', {
        level: 'info',
        tags: { operation, surface: request.surface },
        extra: {
          scope: request.scope,
          idempotencyKey: request.idempotencyKey,
          createdAt: new Date(request.createdAtMs).toISOString(),
        },
      });
      // Flush first so the log survives the reload.
      await Sentry.flush(2000);
    } catch {
      // The activity log already holds the audit row; Sentry must never stop the reload below.
    }
    // Reload so no screen keeps the recovered form values: resubmitting them would
    // send the same change again under a new key.
    window.location.reload();
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
        message={`This request was saved ${savedAt} on the ${screen} screen${record}. If that time looks wrong, this device's clock may be off: do not clear it. First check that real record (the bill, payment, receipt or stock count) to see whether this request was saved. The server checks first: if it has no record of this request, it asks you to try again 15 minutes later. Clearing only removes the stuck request from this browser and reloads the page with an empty form; it does not change any records. If it was not saved, enter it again afterwards.`}
        confirmLabel="Clear it"
        variant="warning"
        loading={clearing}
      />
    </>
  );
}
