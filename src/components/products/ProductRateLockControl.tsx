import { useState } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { sanitizeError } from '../../lib/db';
import { loadProductRateLock, rateLockSummary, setProductRateLock } from '../../lib/productRateLock';
import type { ProductRateLock } from '../../types';

/** The "Lock rates" switch: any admin may flip it with a reason; everyone sees its state. */
export default function ProductRateLockControl({ lock, loadFailed, onRetry, isAdmin, profileId, onChanged }: {
  lock: ProductRateLock | null;
  loadFailed: boolean;
  onRetry: () => void;
  isAdmin: boolean;
  profileId: string;
  onChanged: (lock: ProductRateLock) => void;
}) {
  const { toast } = useToast();
  // The switch's direction is fixed when the window opens, so a reload after a failed save never flips it.
  const [target, setTarget] = useState<boolean | null>(null);
  const open = target !== null;
  // Closing forgets the reason, so every audited switch is given a fresh one.
  const setOpen = (next: boolean) => { setTarget(next && lock ? !lock.is_locked : null); if (!next) setReason(''); };
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const { getKey, resetKey } = useIdempotencyKey('set_product_rate_lock', profileId, `${target}:${reason.trim()}`);
  if (!lock) {
    if (!loadFailed) return null;
    return (
      <span className="inline-flex items-center gap-2 text-sm text-secondary">
        Couldn&apos;t check the rate lock.
        <Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button>
      </span>
    );
  }

  const save = async () => {
    setSaving(true);
    try {
      if (target === null) return;
      const next = await setProductRateLock({ locked: target, reason: reason.trim(), performedBy: profileId, idempotencyKey: getKey() });
      resetKey();
      onChanged(next);
      setOpen(false);
      setReason('');
      toast('success', next.is_locked ? 'Rates locked' : 'Rates unlocked');
    } catch (error) {
      toast('error', sanitizeError(error));
      // Another admin, or this save before its answer was lost, may have switched it already:
      // show the current state, and close the window once it is already where it was going.
      loadProductRateLock().then((current) => {
        onChanged(current);
        // Retire the key too, or a later switch with the same reason would replay this receipt.
        if (current.is_locked === target) { resetKey(); setOpen(false); setReason(''); }
      }).catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <span className="inline-flex items-center gap-1 text-sm text-secondary" title={rateLockSummary(lock)} data-testid="product-rate-lock-state">
        {lock.is_locked ? <Lock className="h-4 w-4" aria-hidden="true" /> : <LockOpen className="h-4 w-4" aria-hidden="true" />}
        {lock.is_locked ? 'Rates locked' : 'Rates open'}
      </span>
      {isAdmin && (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {lock.is_locked ? 'Unlock rates' : 'Lock rates'}
        </Button>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        closeDisabled={saving}
        title={target ? 'Lock rates' : 'Unlock rates'}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={() => void save()} loading={saving} disabled={!reason.trim()}>
              {target ? 'Lock rates' : 'Unlock rates'}
            </Button>
          </>
        )}
      >
        <p className="text-sm text-secondary">
          {target
            ? 'While locked, nobody can change a product\'s rate per acre, rate unit or suggested rate. An admin can still correct one product at a time from its product page, with a reason.'
            : 'Unlocking lets admins change rates on product pages again.'}
        </p>
        <p className="mt-2 text-sm text-secondary">{rateLockSummary(lock)}</p>
        <label htmlFor="product-rate-lock-reason" className="mt-3 block text-sm font-medium text-secondary">Reason (required)</label>
        <textarea
          id="product-rate-lock-reason"
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Modal>
    </>
  );
}
