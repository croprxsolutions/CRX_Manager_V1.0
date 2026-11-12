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

const BRANDS_NEED_SIGNAL_MESSAGE = 'Brands save when you have signal.';

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
  // Lines changed on screen since the last reply landed; a reload keeps those choices (still unsaved).
  const touchedRef = useRef(new Set<string>());
  // Whether this delivery's picks are on screen (a later refresh failing must not hide them).
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    if (!deliveryId || !enabled) return;
    try {
      const next = await getDeliveryBrands(deliveryId);
      if (request !== requestRef.current) return;
      const touched = touchedRef.current;
      touchedRef.current = new Set();
      loadedRef.current = true;
      setBrands(next);
      setDrafts((prev) => {
        const fresh = draftsOf(next);
        for (const lineId of touched) if (lineId in fresh && prev[lineId]) fresh[lineId] = prev[lineId];
        return fresh;
      });
      setLoadFailed(false);
    } catch (error) {
      if (request !== requestRef.current) return;
      // A failed refresh keeps the picks and unsaved choices on screen (a later save still checks the base
      // seq); only a failed first load shows the failure.
      if (!loadedRef.current) setLoadFailed(true);
      Sentry.captureException(error, { level: 'warning', extra: { context: 'Delivery brands could not be loaded' } });
    }
  }, [deliveryId, enabled]);

  useEffect(() => {
    touchedRef.current = new Set();
    loadedRef.current = false;
    setBrands(null); setDrafts({}); setSavedAt(null); setLoadFailed(false);
    void load();
  }, [load]);

  const setLineDraft = useCallback((lineId: string, draft: DraftPick[]) => {
    touchedRef.current.add(lineId);
    setDrafts((prev) => ({ ...prev, [lineId]: draft }));
  }, []);

  const changed = changedLineIds(brands, drafts);
  const dirty = changed.length > 0;

  const send = async (lines: { delivery_item_id: string; picks: ReturnType<typeof picksPayload> }[]): Promise<number | null> => {
    if (!brands || !deliveryId) return null;
    // One key per exact save (this delivery, these choices, this base): a retry of the same save reuses it.
    const scope = fingerprintIntentPayload([deliveryId, lines, brands.event_seq]);
    const request = ++requestRef.current;
    try {
      const result = await setDeliveryBrands(deliveryId, lines, brands.event_seq, idem.getKeyFor(scope));
      idem.resetKeyFor(scope);
      if (request !== requestRef.current) return null;
      const next: DeliveryBrands = {
        ...brands,
        event_seq: result.event_seq,
        lines: brands.lines.map((l) => ({ ...l, picks: result.picks.filter((p) => p.delivery_item_id === l.delivery_item_id) })),
      };
      touchedRef.current = new Set();
      setBrands(next);
      setDrafts(draftsOf(next));
      setSavedAt(new Date());
      return result.event_seq;
    } catch (error) {
      if (hasRpcCode(error, RpcErrorCodes.BRAND_PICKS_CHANGED)) {
        idem.resetKeyFor(scope);
        toast('warning', 'Someone else changed these brands. They have been reloaded; check them and try again.');
        touchedRef.current = new Set();
        await load();
        return null;
      }
      if (getIdempotencyBindingRejection(error)) idem.resetKeyFor(scope);
      toast('error', deliveryBrandErrorMessage(error));
      return null;
    }
  };

  /**
   * Saves the changed lines. Returns the delivery's brand event seq to complete against (unchanged when
   * nothing needed saving), or null when the save did not happen (the reason is already shown).
   * `skipIncomplete` (completion) leaves out lines whose choices cannot be saved instead of refusing:
   * the confirm step already warned about them, and brands never block a completion.
   */
  const save = async ({ skipIncomplete = false } = {}): Promise<number | null> => {
    if (!brands || !deliveryId || saving) return null;
    const lines = [];
    for (const lineId of changed) {
      const line = brands.lines.find((l) => l.delivery_item_id === lineId)!;
      try {
        lines.push({ delivery_item_id: lineId, picks: picksPayload(line.product_name || 'This product', drafts[lineId], line.quantity) });
      } catch (error) {
        if (skipIncomplete) continue;
        toast('error', error instanceof Error ? error.message : 'Check the brand choices');
        return null;
      }
    }
    if (lines.length === 0) return brands.event_seq;
    // Disabled from here, so no choice can change between building this save and its reply.
    setSaving(true);
    try {
      if (!(await hasSignal())) { toast('error', BRANDS_NEED_SIGNAL_MESSAGE); return null; }
      return await send(lines);
    } finally {
      setSaving(false);
    }
  };


  // Still waiting for the first reply: completion waits too, so it never skips picks it has not seen.
  const loading = enabled && !!deliveryId && !brands && !loadFailed;

  return { brands, drafts, setLineDraft, dirty, saving, loading, savedAt, loadFailed, save, reload: load };
}

export type DeliveryBrandsState = ReturnType<typeof useDeliveryBrands>;
