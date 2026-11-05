import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Sentry } from '../lib/sentry';
import ConfirmModal from './ui/ConfirmModal';
import { useToast } from './ui/Toast';

type ExpiredIntentLock = {
  isIntentLocked: boolean;
  isRetryExpired: boolean;
  clearExpiredIntent: () => Promise<void>;
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

  if (role !== 'admin' || !intent.isIntentLocked || !intent.isRetryExpired) return null;

  const handleClear = async () => {
    setClearing(true);
    try {
      await intent.clearExpiredIntent();
      Sentry.captureMessage('Admin cleared an expired uncertain mutation', {
        level: 'info',
        tags: { operation },
      });
      setConfirmOpen(false);
      toast('success', 'Saved request cleared. This form can be used again.');
    } catch {
      toast('error', 'Could not clear the saved request. Reload the page and try again.');
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
        message="First check the real record (the bill, payment, receipt or stock count) to see whether this request was saved. Clearing only removes the stuck request from this browser; it does not change any records. If it was not saved, you can enter it again afterwards."
        confirmLabel="Clear it"
        variant="warning"
        loading={clearing}
      />
    </>
  );
}
