import { useCallback, useEffect, useRef, useState } from 'react';
import { hasRpcCode, RpcErrorCodes } from '../../lib/db';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { fingerprintIntentPayload, getIdempotencyBindingRejection } from '../../lib/idempotency';
import { hasSignal } from '../../lib/connectivity';
import { Sentry } from '../../lib/sentry';
import {
  changedLineIds, deliveryBrandErrorMessage, draftFromPicks, getDeliveryBrands, picksPayload, setDeliveryBrands,
  type DeliveryBrands, type DraftLines, type DraftPick,
} from '../../lib/deliveryBrands';

export const BRANDS_NEED_SIGNAL_MESSAGE = 'Brands save when you have signal.';

function draftsOf(brands: DeliveryBrands): DraftLines {
  return Object.fromEntries(brands.lines.map((l) => [l.delivery_item_id, draftFromPicks(l.picks)]));
}

/**
 * One open delivery's brand picks (Brand PR B, B-2): loaded from get_delivery_brands, edited on screen, saved with
 * set_delivery_brands. Online only (Goal 5): nothing is queued. `enabled` is false while the delivery is not loaded
 * or not open; the picks then reset, so a different delivery never shows another's choices.
 */
export function useDeliveryBrands(deliveryId: string | undefined, enabled: boolean) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const idem = useIdempotencyKey('set_delivery_brands', profile?.id || '');
  const [brands, setBrands] = useState<DeliveryBrands | null>(null);
  const [drafts, setDrafts] = useState<DraftLines>({});
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  // Only the latest request's reply is used.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    if (!deliveryId || !enabled) return;
    try {
      const next = await getDeliveryBrands(deliveryId);
      if (request !== requestRef.current) return;
      setBrands(next);
      setDrafts(draftsOf(next));
      setLoadFailed(false);
    } catch (error) {
      if (request !== requestRef.current) return;
      setBrands(null);
      setLoadFailed(true);
      Sentry.captureException(error, { level: 'warning', extra: { context: 'Delivery brands could not be loaded' } });
    }
  }, [deliveryId, enabled]);

  useEffect(() => {
    setBrands(null); setDrafts({}); setSavedAt(null); setLoadFailed(false);
    void load();
  }, [load]);

  const setLineDraft = useCallback((lineId: string, draft: DraftPick[]) => {
    setDrafts((prev) => ({ ...prev, [lineId]: draft }));
  }, []);

  const changed = changedLineIds(brands, drafts);
  const dirty = changed.length > 0;

  /**
   * Saves the changed lines. Returns the delivery's brand event seq to complete against (unchanged when
   * nothing needed saving), or null when the save did not happen (the reason is already shown).
   */
  const save = useCallback(async (): Promise<number | null> => {
    if (!brands || !deliveryId) return null;
    if (changed.length === 0) return brands.event_seq;
    let lines;
    try {
      lines = changed.map((lineId) => {
        const line = brands.lines.find((l) => l.delivery_item_id === lineId)!;
        return { delivery_item_id: lineId, picks: picksPayload(line.product_name || 'This product', drafts[lineId], line.quantity) };
      });
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Check the brand choices');
      return null;
    }
    if (!(await hasSignal())) { toast('error', BRANDS_NEED_SIGNAL_MESSAGE); return null; }
    // One key per exact save (this delivery, these choices, this base): a retry of the same save reuses it.
    const scope = fingerprintIntentPayload([deliveryId, lines, brands.event_seq]);
    const request = ++requestRef.current;
    setSaving(true);
    try {
      const result = await setDeliveryBrands(deliveryId, lines, brands.event_seq, idem.getKeyFor(scope));
      idem.resetKeyFor(scope);
      if (request !== requestRef.current) return null;
      const next: DeliveryBrands = {
        ...brands,
        event_seq: result.event_seq,
        lines: brands.lines.map((l) => ({ ...l, picks: result.picks.filter((p) => p.delivery_item_id === l.delivery_item_id) })),
      };
      setBrands(next);
      setDrafts(draftsOf(next));
      setSavedAt(new Date());
      return result.event_seq;
    } catch (error) {
      if (hasRpcCode(error, RpcErrorCodes.BRAND_PICKS_CHANGED)) {
        idem.resetKeyFor(scope);
        toast('warning', 'Someone else changed these brands. They have been reloaded; check them and try again.');
        await load();
        return null;
      }
      if (getIdempotencyBindingRejection(error)) idem.resetKeyFor(scope);
      toast('error', deliveryBrandErrorMessage(error));
      return null;
    } finally {
      setSaving(false);
    }
  }, [brands, changed, deliveryId, drafts, idem, load, toast]);

  return { brands, drafts, setLineDraft, dirty, saving, savedAt, loadFailed, save, reload: load };
}

export type DeliveryBrandsState = ReturnType<typeof useDeliveryBrands>;
