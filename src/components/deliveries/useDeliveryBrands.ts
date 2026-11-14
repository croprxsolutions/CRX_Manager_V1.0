import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hasRpcCode, RpcErrorCodes } from '../../lib/db';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { fingerprintIntentPayload, getIdempotencyBindingRejection } from '../../lib/idempotency';
import { hasSignal } from '../../lib/connectivity';
import { Sentry } from '../../lib/sentry';
import {
  BRANDS_NOT_CONFIRMED, changedLineIds, deliveryBrandErrorMessage, isBrandChoiceRefusal, draftFromPicks, getDeliveryBrands, picksPayload, setDeliveryBrands,
  type DeliveryBrands, type DraftLines, type DraftPick,
} from '../../lib/deliveryBrands';

const BRANDS_NEED_SIGNAL_MESSAGE = 'Brands save when you have signal.';
// Completion never waits longer than this for its brand save; after it, the delivery completes unconfirmed.
export const COMPLETION_BRAND_SAVE_TIMEOUT_MS = 10_000;

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
  // Which save owns `saving`: a stop change clears it, and an older save finishing never clears a newer one's.
  const saveTokenRef = useRef(0);
  // Lines changed on screen since the last reply landed; a reload keeps those choices (still unsaved).
  const touchedRef = useRef(new Set<string>());
  // Whether this delivery's picks are on screen (a later refresh failing must not hide them).
  const loadedRef = useRef(false);
  // The delivery on screen now. Every load, save and reply is tied to the delivery and request that sent it: a
  // function captured by an older render (a caller still awaiting something after the stop changed) is refused,
  // and a reply for another delivery or an overtaken request is dropped. Updated at commit, before any effect.
  const liveDeliveryRef = useRef(deliveryId);
  useLayoutEffect(() => { liveDeliveryRef.current = deliveryId; }, [deliveryId]);

  const load = useCallback(async () => {
    // A load captured for a delivery no longer on screen (a reload after an edit that finished late) does nothing.
    if (liveDeliveryRef.current !== deliveryId) return;
    const request = ++requestRef.current;
    if (!deliveryId || !enabled) return;
    try {
      const next = await getDeliveryBrands(deliveryId);
      if (request !== requestRef.current || liveDeliveryRef.current !== deliveryId) return;
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
      if (request !== requestRef.current || liveDeliveryRef.current !== deliveryId) return;
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
    saveTokenRef.current++; setSaving(false);
    void load();
  }, [load]);

  const setLineDraft = useCallback((lineId: string, draft: DraftPick[]) => {
    touchedRef.current.add(lineId);
    setDrafts((prev) => ({ ...prev, [lineId]: draft }));
  }, []);

  // Still waiting for the first reply. Completion does not wait for it: it completes unconfirmed.
  const loading = enabled && !!deliveryId && !brands && !loadFailed;
  const changed = changedLineIds(brands, drafts);
  const dirty = changed.length > 0;

  /** `startedAt` is the request number when the save began: a reload or a different delivery since then cancels it. */
  const send = async (
    lines: { delivery_item_id: string; picks: ReturnType<typeof picksPayload> }[], completing: boolean, startedAt: number,
  ): Promise<number | null> => {
    if (!brands || !deliveryId || requestRef.current !== startedAt || liveDeliveryRef.current !== deliveryId) return null;
    // One key per exact save (this delivery, these choices, this base): a retry of the same save reuses it.
    const scope = fingerprintIntentPayload([deliveryId, lines, brands.event_seq]);
    const request = ++requestRef.current;
    try {
      const result = await setDeliveryBrands(deliveryId, lines, brands.event_seq, idem.getKeyFor(scope));
      idem.resetKeyFor(scope);
      if (request !== requestRef.current || liveDeliveryRef.current !== deliveryId) return null;
      const next: DeliveryBrands = {
        ...brands,
        event_seq: result.event_seq,
        lines: brands.lines.map((l) => ({ ...l, picks: result.picks.filter((p) => p.delivery_item_id === l.delivery_item_id) })),
      };
      // Lines left out of this save (a choice completion could not save) keep their unsaved choices, still dirty.
      const sent = new Set(lines.map((l) => l.delivery_item_id));
      touchedRef.current = new Set([...touchedRef.current].filter((id) => !sent.has(id)));
      setBrands(next);
      setDrafts((prev) => {
        const fresh = draftsOf(next);
        for (const lineId of Object.keys(fresh)) if (!sent.has(lineId) && prev[lineId]) fresh[lineId] = prev[lineId];
        return fresh;
      });
      setSavedAt(new Date());
      return result.event_seq;
    } catch (error) {
      if (getIdempotencyBindingRejection(error) || isBrandChoiceRefusal(error)) idem.resetKeyFor(scope);
      // A reply for a delivery no longer on screen (or a superseded request) must not reload or touch this one.
      if (request !== requestRef.current || liveDeliveryRef.current !== deliveryId) return null;
      if (hasRpcCode(error, RpcErrorCodes.BRAND_PICKS_CHANGED)) {
        idem.resetKeyFor(scope);
        // The driver's choices stay on screen over the reloaded picks; saving again sends them on the new base.
        for (const line of lines) touchedRef.current.add(line.delivery_item_id);
        toast('warning', completing
          ? 'Someone else changed these brands. Completing without your brand choices; the office will check them.'
          : 'Someone else changed these brands. Your choices are still on screen; check them and save again.');
        await load();
        return null;
      }
      toast(completing ? 'warning' : 'error', completing
        ? `${deliveryBrandErrorMessage(error)} Completing without these brand choices; the office will check them.`
        : deliveryBrandErrorMessage(error));
      return null;
    }
  };

  /** Saves the changed lines. Returns the new brand event seq (unchanged when nothing needed saving), or null when it did not save (the reason is shown). */
  const save = async (): Promise<number | null> => {
    if (!brands || !deliveryId || saving) return null;
    const lines = [];
    for (const lineId of changed) {
      const line = brands.lines.find((l) => l.delivery_item_id === lineId)!;
      try {
        lines.push({ delivery_item_id: lineId, picks: picksPayload(line.product_name || 'This product', drafts[lineId], line.quantity) });
      } catch (error) {
        toast('error', error instanceof Error ? error.message : 'Check the brand choices');
        return null;
      }
    }
    if (lines.length === 0) return brands.event_seq;
    // Disabled from here, so no choice can change between building this save and its reply.
    const startedAt = requestRef.current;
    const token = ++saveTokenRef.current;
    setSaving(true);
    try {
      if (!(await hasSignal())) { toast('error', BRANDS_NEED_SIGNAL_MESSAGE); return null; }
      return await send(lines, false, startedAt);
    } finally {
      if (saveTokenRef.current === token) setSaving(false);
    }
  };

  /**
   * Completion's brand step (brands never block a completion, Mason 2026-11-09 and 2026-11-12): saves what it
   * can and returns the seq to complete against. That is the saved seq only when every choice on screen was
   * saved; otherwise BRANDS_NOT_CONFIRMED, so the completion still goes through and the office follows up.
   */
  const saveForCompletion = async (): Promise<number> => {
    if (!brands || !deliveryId) {
      // Not loaded yet, or the load failed: completion never waits for brands.
      if (loadFailed || loading) toast('warning', 'Brands could not be loaded. Completing anyway; the office will check this delivery’s brands.');
      return BRANDS_NOT_CONFIRMED;
    }
    // A Save brands still in flight: complete without waiting for it.
    if (saving) {
      toast('warning', 'Brands were still saving. Completing anyway; the office will check this delivery’s brands.');
      return BRANDS_NOT_CONFIRMED;
    }
    const lines = [];
    let leftOut = false;
    for (const lineId of changed) {
      const line = brands.lines.find((l) => l.delivery_item_id === lineId)!;
      // A choice that cannot be saved is left out (the confirm step already warned about it).
      try {
        lines.push({ delivery_item_id: lineId, picks: picksPayload(line.product_name || 'This product', drafts[lineId], line.quantity) });
      } catch { leftOut = true; }
    }
    if (lines.length === 0) return leftOut ? BRANDS_NOT_CONFIRMED : brands.event_seq;
    const startedAt = requestRef.current;
    const token = ++saveTokenRef.current;
    setSaving(true);
    try {
      // No signal: the completion's own signal check stops it next.
      if (!(await hasSignal())) return BRANDS_NOT_CONFIRMED;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), COMPLETION_BRAND_SAVE_TIMEOUT_MS); });
      const seq = await Promise.race([send(lines, true, startedAt), timedOut]);
      clearTimeout(timer);
      if (seq === 'timeout') {
        // Its late reply is dropped (the request number moves on); the completion goes ahead unconfirmed. Only
        // when this save is still the latest request: a newer load (another stop opened) must keep its reply.
        if (requestRef.current === startedAt + 1) requestRef.current++;
        toast('warning', 'Brands did not save in time. Completing anyway; the office will check this delivery’s brands.');
        return BRANDS_NOT_CONFIRMED;
      }
      return seq === null || leftOut ? BRANDS_NOT_CONFIRMED : seq;
    } finally {
      if (saveTokenRef.current === token) setSaving(false);
    }
  };


  /** Reloads the saved picks; `discard` names lines whose unsaved choices no longer apply (the line was edited). */
  const reload = useCallback(({ discard = [] }: { discard?: string[] } = {}) => {
    if (liveDeliveryRef.current !== deliveryId) return Promise.resolve();
    for (const lineId of discard) touchedRef.current.delete(lineId);
    return load();
  }, [load, deliveryId]);

  return { brands, drafts, setLineDraft, dirty, saving, loading, savedAt, loadFailed, save, saveForCompletion, reload };
}

export type DeliveryBrandsState = ReturnType<typeof useDeliveryBrands>;
