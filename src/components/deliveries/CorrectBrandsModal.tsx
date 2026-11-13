import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import ConfirmModal from '../ui/ConfirmModal';
import { hasSignal } from '../../lib/connectivity';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes } from '../../lib/db';
import { fingerprintIntentPayload, getIdempotencyBindingRejection } from '../../lib/idempotency';
import { Sentry } from '../../lib/sentry';
import {
  brandWarnings, changedLineIds, correctDeliveryBrands, deliveryBrandErrorMessage, draftFromPicks, getDeliveryBrands,
  picksPayload, type DeliveryBrandLine, type DeliveryBrands, type DraftLines,
} from '../../lib/deliveryBrands';
import DeliveryBrandPicker from './DeliveryBrandPicker';

const delivered = (line: DeliveryBrandLine) => line.quantity_delivered ?? line.quantity;

/**
 * Admin only, on a completed delivery (Brand PR B, B-2): fixes which brands went off the truck with
 * correct_delivery_brands. The old picks are kept as history; a posted invoice must be voided and reissued first.
 */
/** The server preserves office review for unchanged typed identities, including amount-only corrections. */
function linesToConfirm(lines: DeliveryBrandLine[]): string[] {
  return lines.filter((l) => l.picks.length > 0).map((l) => l.delivery_item_id);
}

/**
 * A correction must account for everything delivered on each line it changes (the database checks it too).
 * Clearing a line on purpose ("brand unknown") is allowed; only lines with brands must add up.
 */
function correctionMismatch(brands: DeliveryBrands, changed: string[], drafts: DraftLines): string | undefined {
  const changedLines = brands.lines.filter((l) => changed.includes(l.delivery_item_id) && (drafts[l.delivery_item_id] ?? []).length > 0);
  return brandWarnings({ ...brands, lines: changedLines }, drafts,
    Object.fromEntries(changedLines.map((l) => [l.delivery_item_id, delivered(l)])), true)[0];
}

export default function CorrectBrandsModal({ open, deliveryId, onClose, onDirtyChange }: {
  open: boolean; deliveryId: string; onClose: () => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const idem = useIdempotencyKey('correct_delivery_brands', profile?.id || '');
  const [brands, setBrands] = useState<DeliveryBrands | null>(null);
  const [drafts, setDrafts] = useState<DraftLines>({});
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const requestRef = useRef(0);

  /** `keep` holds edited lines whose choices stay on screen over the reloaded picks. */
  const load = useCallback(async (keep: DraftLines = {}) => {
    const request = ++requestRef.current;
    try {
      const next = await getDeliveryBrands(deliveryId);
      if (request !== requestRef.current) return;
      setBrands(next);
      setDrafts(Object.fromEntries(next.lines.map((l) => [l.delivery_item_id, keep[l.delivery_item_id] ?? draftFromPicks(l.picks)])));
      setLoadFailed(false);
    } catch (error) {
      if (request !== requestRef.current) return;
      setLoadFailed(true);
      Sentry.captureException(error, { level: 'warning', extra: { context: 'Correct brands could not load the delivery brands' } });
    }
  }, [deliveryId]);

  useEffect(() => {
    if (open) { setBrands(null); setReason(''); setLoadFailed(false); void load(); }
    else requestRef.current++;
  }, [open, load]);

  // Every delivered line, even when its product's brands were all retired since: an old gap stays fixable by typing it.
  const showLine = (line: DeliveryBrandLine) => delivered(line) > 0;

  const save = async () => {
    if (!brands || saving) return;
    const edited = changedLineIds(brands, drafts);
    // Nothing edited: saving confirms the picks as they stand, which clears an unconfirmed completion's flag.
    const confirming = edited.length === 0;
    const changed = confirming ? linesToConfirm(brands.lines.filter(showLine)) : edited;
    if (changed.length === 0) {
      toast('info', 'No brand changes to save.');
      return;
    }
    if (!reason.trim()) { toast('error', 'Say why the brands are being corrected.'); return; }
    const mismatch = correctionMismatch(brands, changed, drafts);
    if (mismatch) { toast('error', mismatch.replace(' Those choices will not be saved.', '')); return; }
    let lines;
    try {
      lines = changed.map((lineId) => {
        const line = brands.lines.find((l) => l.delivery_item_id === lineId)!;
        return { delivery_item_id: lineId, picks: picksPayload(line.product_name || 'This product', drafts[lineId], delivered(line)) };
      });
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Check the brand choices');
      return;
    }
    // Disabled from here, so nothing changes between building this correction and its reply. The request number is
    // taken before the signal check: closing the dialog or another delivery loading since then cancels it.
    setSaving(true);
    const request = ++requestRef.current;
    if (!(await hasSignal())) { setSaving(false); toast('error', 'Brands save when you have signal.'); return; }
    if (request !== requestRef.current) { setSaving(false); return; }
    // One key per exact correction: a retry of the same one reuses it.
    const scope = fingerprintIntentPayload([deliveryId, lines, reason.trim(), brands.event_seq]);
    try {
      const result = await correctDeliveryBrands(deliveryId, lines, reason.trim(), brands.event_seq, idem.getKeyFor(scope));
      idem.resetKeyFor(scope);
      if (request !== requestRef.current) return;
      // Unposted invoices are re-copied, but a split-billed draft keeps its brands (it lands on Sales to check).
      toast('success', result.invoice_ids.length > 0
        ? 'Brands corrected. Open draft invoices for this delivery were re-copied; a split-billed draft keeps its old brands.'
        : confirming ? 'Brands confirmed as they are.' : 'Brands corrected.');
      onClose();
    } catch (error) {
      if (getIdempotencyBindingRejection(error) || hasRpcCode(error, RpcErrorCodes.BRAND_PICKS_CHANGED)) idem.resetKeyFor(scope);
      // A reply after the dialog closed or moved to another delivery changes nothing on screen.
      if (request !== requestRef.current) return;
      if (hasRpcCode(error, RpcErrorCodes.BRAND_PICKS_CHANGED)) {
        toast('warning', 'Someone else changed these brands. Your corrections are still on screen; check them and save again.');
        await load(Object.fromEntries(changed.map((lineId) => [lineId, drafts[lineId]])));
        return;
      }
      toast('error', deliveryBrandErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  // Closing with an edited brand or a typed reason asks first, so a correction is never dropped silently.
  const requestClose = () => {
    if (saving) return;
    if ((brands && changedLineIds(brands, drafts).length > 0) || reason.trim()) setConfirmDiscard(true);
    else onClose();
  };
  const hasLines = !!brands && brands.lines.some(showLine);
  // The page's leave guard asks before navigating away from an edited correction.
  const dirty = open && ((!!brands && changedLineIds(brands, drafts).length > 0) || !!reason.trim());
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  return (
    <>
    <Modal
      open={open}
      onClose={requestClose}
      closeDisabled={saving || confirmDiscard}
      title="Correct brands"
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={requestClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void save()} loading={saving} disabled={!hasLines || saving}>Save correction</Button>
        </div>
      )}
    >
      {loadFailed && <p className="text-sm text-amber-800">The brands could not be loaded. Close this and try again.</p>}
      {!loadFailed && !brands && <p role="status" className="text-sm text-secondary">Loading brands…</p>}
      {brands && !hasLines && <p className="text-sm text-secondary">No delivered product on this delivery has a brand list.</p>}
      {brands && hasLines && (
        <div className="space-y-4">
          <p className="text-sm text-secondary">The brand amounts on each line must add up to what was delivered. The old brands stay in the history. Saving with no changes confirms the brands as they are.</p>
          <DeliveryBrandPicker
            brands={brands}
            drafts={drafts}
            onChange={(lineId, draft) => setDrafts((prev) => ({ ...prev, [lineId]: draft }))}
            disabled={saving}
            fullQuantity={delivered}
            showLine={showLine}
          />
          <label className="block text-sm font-medium text-nav-dark">
            Reason (required)
            <textarea
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green"
              rows={2}
              maxLength={1000}
              value={reason}
              disabled={saving}
              onChange={(e) => setReason(e.target.value)}
              placeholder="For example: driver picked the wrong brand; the jugs were Brand X"
            />
          </label>
        </div>
      )}
    </Modal>
    <ConfirmModal
      open={confirmDiscard}
      onClose={() => setConfirmDiscard(false)}
      onConfirm={() => { setConfirmDiscard(false); onClose(); }}
      title="Discard this correction?"
      message="Your brand changes and reason are not saved."
      confirmLabel="Discard"
      cancelLabel="Keep editing"
      variant="warning"
    />
    </>
  );
}
