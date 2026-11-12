/**
 * Field Mode — per-stop runner ("/my-route/:id").
 *
 * The guided, one-thing-per-screen flow for a single delivery stop. ADDITIVE:
 * reuses the existing delivery RPCs/components; never edits DeliveryDetail.tsx.
 *
 * Flow: status-driven entry (scheduled → Arrive; in_progress → Verify) →
 * Verify items (full/short) → Signature → Review & Complete (optional photo)
 * → Done. Completion mirrors DeliveryDetail.handleComplete exactly (same
 * rpcParams, signature upload, notifications, customer email, invoice surfacing).
 * Completing needs a signal (Goal 5, Mason 2026-10-15): nothing is queued offline,
 * and a signed paper ticket photo can stand in for the on-screen signature. See
 * docs/roadmap/field-mode-build-plan.md.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  MapPin, PlayCircle, WifiOff, Minus, Plus, AlertTriangle, ChevronRight,
  Camera, CheckCircle2, ClipboardCheck, FileText,
} from 'lucide-react';
import PhoneHeader from '../components/ui/PhoneHeader';
import SignatureCanvas from '../components/ui/SignatureCanvas';
import { billSplitCompletion, billSplitFailedMessage } from '../lib/billSplitCompletion';
import { supabase, assertRpcResult, sanitizeError, checkMutationResult } from '../lib/db';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/ui/Toast';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useLatestRef } from '../hooks/useLatestRef';
import { digestIntentPayload, getIdempotencyBindingRejection } from '../lib/idempotency';
import { hasSignal, NO_SIGNAL_MESSAGE } from '../lib/connectivity';
import { countOrdinaryPhotos, countPaperTicketPhotos, countLeftAtSitePhotos, hasPaperTicketPhoto, hasLeftAtSitePhoto, MAX_ORDINARY_DELIVERY_PHOTOS, MAX_PAPER_TICKET_PHOTOS, MAX_LEFT_AT_SITE_PHOTOS, PAPER_TICKET_PHOTO_CAPTION, LEFT_AT_SITE_PHOTO_CAPTION, isValidPaperDeliveredOn, paperDeliveredAt, completedAtForKey } from '../lib/paperTicket';
import { fetchReceiptRecipient, INVALID_SIGNATURE_MESSAGE, isNetworkFailure, isSignatureDataUrl, isSignatureImageMissing, latestEvidencePhoto, reconcileFailedCompletion, signatureDigest, signatureImagePathFor, uploadSignatureImage } from '../lib/deliveryEvidence';
import type { DeliveryCompletionEvidence, ReceiptRecipient } from '../types';
import { compressImage } from '../lib/imageCompression';
import { todayInBusinessTz } from '../lib/dateUtils';
import { logActivity } from '../lib/activityLogger';
import { notifyDeliveryCompleted, notifyDeliveryRemainder } from '../lib/notificationTriggers';
import { RECEIPT_COMPLETED_BY_EARLIER_ATTEMPT_MESSAGE, RECEIPT_NO_EMAIL_ON_FILE_MESSAGE } from '../lib/deliveryCompletionEmail';
import { Sentry } from '../lib/sentry';
import PrivatePhoto from '../components/ui/PrivatePhoto';
import { deliveryPhotoPath } from '../lib/privatePhotos';
import { toSentryError } from '../lib/sentryError';
import ConfirmModal from '../components/ui/ConfirmModal';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useDeliveryBrands } from '../components/deliveries/useDeliveryBrands';
import { DeliveryBrandsPanel } from '../components/deliveries/DeliveryBrandPicker';
import { brandWarnings } from '../lib/deliveryBrands';

interface StopItem {
  id: string;
  quantity: number;
  product_id: string | null;
  product: { product_name: string | null } | null;
}

interface StopPhoto {
  id: string;
  storage_path: string | null;
  image_url: string;
  caption: string | null;
  uploaded_at?: string | null;
}

interface StopDelivery {
  id: string;
  delivery_number: string | null;
  status: string;
  updated_at: string | null;
  customer_id: string;
  order_id: string | null;
  created_by: string | null;
  delivery_address_id: string | null;
  delivery_notes: string | null;
  assigned_driver: string | null;
  customer: { farm_name: string | null; email: string | null; contact_name: string | null } | null;
}

type Step = 'arrive' | 'verify' | 'sign' | 'review' | 'done';
const STEP_ORDER: Step[] = ['arrive', 'verify', 'sign', 'review', 'done'];

export default function FieldStop() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();
  const isOnline = useOnlineStatus();
  const confirmIdem = useIdempotencyKey('confirm_delivery', profile?.id || '');
  const completeIdem = useIdempotencyKey('complete_delivery', profile?.id || '');
  // Retry key -> the p_completed_at its first send carried (see completedAtForKey).
  const sentCompletedAt = useRef(new Map<string, string | undefined>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const paperTicketInputRef = useRef<HTMLInputElement>(null);
  const leftAtSiteInputRef = useRef<HTMLInputElement>(null);
  // Latest stop id the route is showing — older in-flight fetches bail (H3 stale guard).
  const activeStopIdRef = useRef<string | undefined>(undefined);

  const [delivery, setDelivery] = useState<StopDelivery | null>(null);
  const [items, setItems] = useState<StopItem[]>([]);
  const [itemsError, setItemsError] = useState(false);
  const [photos, setPhotos] = useState<StopPhoto[]>([]);
  const [deliveryQtys, setDeliveryQtys] = useState<Record<string, number>>({});
  const [addressLine, setAddressLine] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [step, setStep] = useState<Step>('arrive');
  const [signedBy, setSignedBy] = useState('');
  const [noOnePresent, setNoOnePresent] = useState(false);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  // Goal 5 paper fallback: a photo of the signed paper ticket replaces the on-screen signature.
  const [usePaperTicket, setUsePaperTicket] = useState(false);
  const [paperDeliveredOn, setPaperDeliveredOn] = useState(todayInBusinessTz());
  // Stop-to-stop navigation reuses this page; never carry paper mode onto the next stop.
  // Also drop the previous stop's photos, so a failed load for this stop shows none
  // (fails closed) instead of letting the last stop's ticket photo pass the check.
  useEffect(() => {
    setUsePaperTicket(false); setNoOnePresent(false); setSignedBy(''); setSignatureDataUrl(null);
    setPaperDeliveredOn(todayInBusinessTz()); setPhotos([]);
  }, [id]);
  const [emailOnComplete, setEmailOnComplete] = useState(true);
  // The receipt address when the customer row is hidden from this driver (see fetchReceiptRecipient).
  const [receiptRecipient, setReceiptRecipient] = useState<ReceiptRecipient | null>(null);
  const [autoInvoiceNumber, setAutoInvoiceNumber] = useState<string | null>(null);
  // Brand PR B (B-2): which brand went off the truck, saved before completion. Never blocks a completion.
  const brandState = useDeliveryBrands(id, !!delivery && delivery.id === id && (delivery.status === 'scheduled' || delivery.status === 'in_progress'));
  // Tied to the stop that raised it: on another stop it never shows, so its Complete anyway cannot act there.
  const [brandWarning, setBrandWarning] = useState<{ stopId: string; list: string[] } | null>(null);
  const brandWarningList = brandWarning && brandWarning.stopId === id ? brandWarning.list : [];
  const brandLeaveBlocker = useUnsavedChanges(brandState.dirty && step !== 'done');

  // Every photo-list read and local add takes a number; only the newest read may replace the list,
  // so a slow older read can never drop a photo added (or keep one removed) after it started.
  const photoSeqRef = useRef(0);
  const fetchPhotos = useCallback(async () => {
    if (!id) return;
    const seq = ++photoSeqRef.current;
    const { data, error } = await supabase
      .from('delivery_photos')
      .select('id, storage_path, image_url, caption, uploaded_at')
      .eq('delivery_id', id)
      .order('sort_order');
    if (activeStopIdRef.current !== id) return; // stale guard (H3)
    if (seq !== photoSeqRef.current) return; // a newer read or local add superseded this one
    if (error) {
      // Keep what is on screen. Clearing it would hide a paper-ticket photo that is
      // already saved and block completion until the stop is reopened.
      Sentry.captureException(error, { extra: { context: 'Field Mode photo list refresh failed' } });
      return;
    }
    setPhotos((data || []) as StopPhoto[]);
  }, [id]);

  const fetchStop = useCallback(async () => {
    if (!id) return;
    // Stale-route guard (H3): on rapid stop-to-stop navigation an older in-flight
    // fetch must not overwrite the current stop's delivery/items/address/photos —
    // handleComplete submits against the live route id plus this component state.
    const isStale = () => activeStopIdRef.current !== id;
    setLoading(true);
    const { data, error } = await supabase
      .from('deliveries')
      .select('id, delivery_number, status, updated_at, customer_id, order_id, created_by, delivery_address_id, delivery_notes, assigned_driver, customer:customers(farm_name, email, contact_name)')
      .eq('id', id)
      .maybeSingle();

    if (isStale()) return;
    if (error || !data) {
      if (error) Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-stop' } });
      toast('error', 'Could not load this stop');
      navigate('/my-route');
      return;
    }

    const del = data as unknown as StopDelivery;
    setDelivery(del);
    setReceiptRecipient(null);
    // Only an open stop sends a receipt on completion.
    if (!del.customer?.email && (del.status === 'scheduled' || del.status === 'in_progress')) {
      void fetchReceiptRecipient(del.id).then((recipient) => { if (!isStale()) setReceiptRecipient(recipient); });
    }
    if (del.status === 'scheduled') setStep('arrive');
    else if (del.status === 'in_progress') setStep('verify');
    else {
      toast('info', `This stop is ${del.status} — opening full detail`);
      navigate(`/deliveries/${del.id}`);
      return;
    }

    const { data: itemData, error: itemErr } = await supabase
      .from('delivery_items')
      .select('id, quantity, product_id, product:products(product_name)')
      .eq('delivery_id', id);
    if (isStale()) return;
    // Don't let a failed items query masquerade as "No items on this delivery".
    setItemsError(!!itemErr);
    if (itemErr) {
      Sentry.captureException(itemErr, { tags: { source: 'fetch', page: 'field-stop-items' } });
      toast('error', 'Could not load delivery items — refresh before completing');
    }
    const loaded = ((itemData || []) as unknown as StopItem[]);
    setItems(loaded);
    const initQtys: Record<string, number> = {};
    loaded.forEach((it) => { initQtys[it.id] = it.quantity; });
    setDeliveryQtys(initQtys);

    if (del.delivery_address_id) {
      const { data: addr } = await supabase
        .from('customer_addresses')
        .select('address_line, city, state, zip')
        .eq('id', del.delivery_address_id)
        .maybeSingle();
      if (isStale()) return;
      if (addr) {
        const a = addr as { address_line?: string | null; city?: string | null; state?: string | null; zip?: string | null };
        setAddressLine([a.address_line, a.city, a.state, a.zip].filter(Boolean).join(', '));
      }
    }
    await fetchPhotos();
    setLoading(false);
  }, [id, navigate, toast, fetchPhotos]);

  useEffect(() => { activeStopIdRef.current = id; fetchStop(); }, [id, fetchStop]);

  // After a successful Arrive, re-read deliveries.updated_at so an offline
  // completion snapshots the POST-arrive value. confirm_delivery bumps
  // updated_at; without this refresh, offlineSync would flag the driver's OWN
  // Arrive as a conflicting external edit and silently drop the queued
  // completion on reconnect.
  const syncAfterArrive = async () => {
    const { data: refreshed, error } = await supabase
      .from('deliveries').select('updated_at').eq('id', id!).maybeSingle();
    const ua = (refreshed as { updated_at?: string | null } | null)?.updated_at ?? null;
    if (error || !ua) {
      // Couldn't confirm the post-Arrive updated_at. Don't leave a STALE
      // (pre-Arrive) timestamp on the row — an offline completion would then
      // snapshot it and self-conflict on replay. Reload fully instead.
      if (error) Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-stop-arrive-resync' } });
      await fetchStop();
      return;
    }
    setDelivery((prev) => (prev ? { ...prev, status: 'in_progress', updated_at: ua } : prev));
    setStep('verify');
  };

  // ── Arrive (confirm_delivery: scheduled → in_progress) ──────────────────
  const handleArrive = async () => {
    if (!delivery || !profile || !id) return;
    // Stale-route guard (H3): never act on a delivery from a different stop than
    // the route currently shows (rapid stop-to-stop switch mid-load).
    if (delivery.id !== id) { toast('error', 'This stop just changed — please retry'); return; }
    // confirm_delivery is never queued offline (complete_delivery needs an
    // in_progress stop and a queued confirm has no replay caller).
    if (!isOnline) {
      toast('error', 'Connect to the internet to start this stop');
      return;
    }
    setConfirming(true);
    try {
      const { data, error } = await supabase.rpc('confirm_delivery', {
        p_delivery_id: id,
        p_idempotency_key: confirmIdem.getKeyFor(id),
      });
      if (error) throw error;
      assertRpcResult(data, 'confirm_delivery');
      confirmIdem.resetKeyFor(id);
      toast('success', 'Delivery started');
      await syncAfterArrive();
    } catch (err: unknown) {
      const msg = sanitizeError(err);
      // Stale screen: stop was already started elsewhere — re-read + resume at Verify.
      if (/in_progress|already/i.test(msg)) await syncAfterArrive();
      else toast('error', msg);
    }
    setConfirming(false);
  };

  const updateQty = (itemId: string, qty: number, max: number) => {
    setDeliveryQtys((prev) => ({ ...prev, [itemId]: Math.max(0, Math.min(qty, max)) }));
  };

  const isPartial = items.some((it) => (deliveryQtys[it.id] ?? it.quantity) < it.quantity);
  // What complete_delivery checks before it completes (migration 20261022075000).
  const completionEvidence: DeliveryCompletionEvidence = noOnePresent ? 'left_at_site' : usePaperTicket ? 'paper_ticket' : 'signature';
  const receiptEmail = delivery?.customer?.email || receiptRecipient?.email || null;
  // The proof the chosen path needs is in place (the server checks it again).
  const evidenceReady = completionEvidence === 'left_at_site'
    ? hasLeftAtSitePhoto(photos)
    : completionEvidence === 'paper_ticket'
      ? hasPaperTicketPhoto(photos) && isValidPaperDeliveredOn(paperDeliveredOn)
      : !!signatureDataUrl;
  // What the driver can still edit while the signal check runs; compared after the check.
  const completionInputs = JSON.stringify([signedBy, deliveryQtys, usePaperTicket, noOnePresent, paperDeliveredOn, signatureDataUrl, emailOnComplete]);
  const completionInputsRef = useLatestRef(completionInputs);
  const hasAnyQty = items.some((it) => (deliveryQtys[it.id] ?? it.quantity) > 0);

  // ── Photo upload (copied/adapted from DeliveryDetail.handlePhotoUpload) ──
  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>, caption?: string) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !profile || !id) return;
    if (!caption && countOrdinaryPhotos(photos) + files.length > MAX_ORDINARY_DELIVERY_PHOTOS) {
      toast('error', 'Maximum 10 photos per delivery');
      return;
    }
    if (caption === PAPER_TICKET_PHOTO_CAPTION && countPaperTicketPhotos(photos) + files.length > MAX_PAPER_TICKET_PHOTOS) {
      toast('error', 'Maximum 2 ticket photos per delivery');
      return;
    }
    if (caption === LEFT_AT_SITE_PHOTO_CAPTION && countLeftAtSitePhotos(photos) + files.length > MAX_LEFT_AT_SITE_PHOTOS) {
      toast('error', 'Maximum 2 drop-location photos per delivery');
      return;
    }
    setUploadingPhoto(true);
    let uploadCount = 0;
    for (const rawFile of Array.from(files)) {
      try {
        const file = await compressImage(rawFile);
        const ext = file.name.split('.').pop() || 'jpg';
        const storagePath = `delivery-photos/${id}/${Date.now()}_${uploadCount}.${ext}`;
        const { error: uploadErr } = await supabase.storage
          .from('delivery-photos')
          .upload(storagePath, file, { contentType: file.type, cacheControl: '0' });
        if (uploadErr) {
          toast('error', `Upload failed: ${uploadErr.message}`);
          continue;
        }
        const { data: urlData } = supabase.storage.from('delivery-photos').getPublicUrl(storagePath);
        const photoResult = await supabase.from('delivery_photos').insert({
          delivery_id: id,
          storage_path: storagePath,
          image_url: urlData.publicUrl,
          uploaded_by: profile.id,
          file_size: file.size,
          sort_order: photos.length + uploadCount,
          ...(caption ? { caption } : {}),
        }).select();
        if (photoResult.error) {
          toast('error', `Photo saved to storage but DB record failed: ${photoResult.error.message}`);
          continue;
        }
        checkMutationResult(photoResult, 'Insert delivery photo');
        // Show the saved row now, so the list does not depend on the refresh read below.
        const inserted = (photoResult.data || []) as StopPhoto[];
        if (activeStopIdRef.current === id) {
          photoSeqRef.current++; // an older in-flight read must not replace the list without this photo
          setPhotos((prev) => [...prev, ...inserted.filter((row) => !prev.some((p) => p.id === row.id))]);
        }
        uploadCount++;
      } catch (err) {
        Sentry.captureException(err, { tags: { source: 'critical_action', action: 'upload_delivery_photo' } });
        toast('error', 'Photo upload failed. Please try again.');
      }
    }
    if (uploadCount > 0) {
      toast('success', `${uploadCount} photo${uploadCount > 1 ? 's' : ''} uploaded`);
      await fetchPhotos();
    }
    setUploadingPhoto(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (paperTicketInputRef.current) paperTicketInputRef.current.value = '';
    if (leftAtSiteInputRef.current) leftAtSiteInputRef.current.value = '';
  };

  // ── Complete (mirrors DeliveryDetail.handleComplete) ────────────────────
  const requestComplete = () => {
    if (!signedBy.trim()) { toast('error', 'Enter who signed for the delivery'); return; }
    if (!hasAnyQty) { toast('error', 'At least one item must have a quantity above zero'); return; }
    if (usePaperTicket && !hasPaperTicketPhoto(photos)) { toast('error', 'Take a photo of the signed paper ticket before completing'); return; }
    if (usePaperTicket && !isValidPaperDeliveredOn(paperDeliveredOn)) { toast('error', 'Enter the delivery date from the paper ticket (today or earlier)'); return; }
    if (completionEvidence === 'left_at_site' && !hasLeftAtSitePhoto(photos)) { toast('error', 'Take a photo of where the delivery was left before completing'); return; }
    if (completionEvidence === 'signature' && !signatureDataUrl) { toast('error', 'Have the customer sign on screen, or use a paper ticket'); return; }
    if (completionEvidence === 'signature' && !isSignatureDataUrl(signatureDataUrl)) { toast('error', INVALID_SIGNATURE_MESSAGE); return; }
    if (brandState.loading) { toast('info', 'Brands are still loading. Try again in a moment.'); return; }
    // A missing or mismatched brand only warns (Mason, 2026-11-09).
    const warnings = brandWarnings(brandState.brands, brandState.drafts, deliveryQtys);
    if (warnings.length > 0) { setBrandWarning({ stopId: id!, list: warnings }); return; }
    void handleComplete();
  };

  // Claimed synchronously before the first await, so a second tap can never start a second attempt.
  const submitClaimRef = useRef(false);
  const handleComplete = async () => {
    if (submitClaimRef.current) return;
    submitClaimRef.current = true;
    try {
      await runComplete();
    } catch (error: unknown) {
      // Only a follow-up after a confirmed completion can land here (the call itself is handled).
      Sentry.captureException(error, { level: 'warning', extra: { context: 'Field Mode completion follow-up failed after the delivery completed' } });
    } finally {
      submitClaimRef.current = false;
      setCompleting(false);
    }
  };

  const runComplete = async () => {
    if (!delivery || !profile || !id) return;
    // Stale-route guard (H3): a fast stop-to-stop switch must never complete the
    // WRONG stop — the route id is fresh but component state could still lag.
    if (delivery.id !== id) { toast('error', 'This stop just changed — please retry'); return; }
    if (completionEvidence === 'signature' && !isSignatureDataUrl(signatureDataUrl)) { toast('error', INVALID_SIGNATURE_MESSAGE); return; }
    setCompleting(true);

    const quantitiesJson = isPartial
      ? Object.fromEntries(items.map((it) => [it.id, deliveryQtys[it.id] ?? it.quantity]))
      : null;
    const evidencePhoto = completionEvidence === 'paper_ticket'
      ? latestEvidencePhoto(photos, PAPER_TICKET_PHOTO_CAPTION)
      : completionEvidence === 'left_at_site' ? latestEvidencePhoto(photos, LEFT_AT_SITE_PHOTO_CAPTION) : undefined;
    const intentParams = {
      p_delivery_id: id,
      p_signed_by: signedBy,
      p_performed_by: profile.id,
      ...(quantitiesJson ? { p_quantities: quantitiesJson } : {}),
      ...(usePaperTicket && paperDeliveredAt(paperDeliveredOn) ? { p_completed_at: paperDeliveredAt(paperDeliveredOn) } : {}),
      p_evidence: completionEvidence,
      // KI-25: the receipt is recorded in the same save and emailed by the server (send-delivery-receipts),
      // so a dropped signal can no longer lose it.
      ...(emailOnComplete ? { p_email_receipt: true } : {}),
      // The exact photo the screen shows as saved (the signature's reference comes from the key).
      ...(evidencePhoto ? { p_evidence_ref: evidencePhoto.id } : {}),
    };
    // check_idempotency replays by key and operation only: bind the key to this exact
    // payload (stop, signer, quantities, ticket date) so an edited retry, or another
    // stop, mints a fresh key. complete_delivery refuses an already-completed delivery.
    // Fingerprint the date the driver chose, not the completion time derived from it:
    // "today" sends no p_completed_at but becomes a past date after midnight, and an
    // exact retry across midnight must keep its key to replay the saved result.
    // complete_delivery replays on the key alone, so the scope uses the collision-resistant
    // SHA-256 digest (digestIntentPayload), never the 64-bit FNV fingerprint (see idempotency.ts).
    const completeScope = `complete:${await digestIntentPayload({
      ...intentParams,
      p_completed_at: undefined,
      delivered_on: usePaperTicket ? paperDeliveredOn : null,
      // A re-drawn signature is a new attempt: new key, new signature file.
      signature_digest: completionEvidence === 'signature' && signatureDataUrl ? await signatureDigest(signatureDataUrl) : null,
    })}`;
    const idemKey = completeIdem.getKeyFor(completeScope);
    // The server accepts only the image at the path it derives from this key; a retry of the key reuses it.
    const signaturePath = completionEvidence === 'signature' ? await signatureImagePathFor(id, idemKey) : undefined;
    const rpcParams = { ...intentParams, ...(signaturePath ? { p_evidence_ref: signaturePath } : {}), p_idempotency_key: idemKey };

    // Goal 5: completing a delivery needs a signal. Nothing is queued to sync later;
    // without a reachable server the stop stays exactly as it was.
    if (!(await hasSignal())) {
      toast('error', NO_SIGNAL_MESSAGE);
      return;
    }
    // Unsaved brand choices are saved first, so completion uses the picks on screen; choices that cannot be
    // saved were warned about and are left out. A failed save completes nothing (its reason is shown). The seq is not part of the completion's key: a retry replays on the key.
    const brandBaseSeq = brandState.brands ? await brandState.save({ skipIncomplete: true }) : null;
    if (brandState.brands && brandBaseSeq === null) return;
    // The checks above can take a few seconds; re-check the stop did not change meanwhile.
    // These checks gate only the DISPATCH: once the call is sent, its result is always reconciled.
    const stillSameAttempt = () => {
      if (activeStopIdRef.current !== id) { toast('error', 'This stop just changed — please retry'); return false; }
      if (completionInputsRef.current !== completionInputs) {
        toast('error', 'Details changed while checking for signal. The delivery was not completed; check them and tap Complete Delivery again.');
        return false;
      }
      return true;
    };
    if (!stillSameAttempt()) return;
    // The server completes only once this attempt's signature image is saved, so it goes up first.
    // A failed upload does not stop the call: after a lost reply the earlier attempt may already have
    // completed the stop (storage then refuses the re-upload). The same key replays that completion,
    // or the server refuses SIGNATURE_IMAGE_MISSING and nothing changes.
    let signatureUploadError: unknown = null;
    if (signaturePath && signatureDataUrl) {
      try {
        await uploadSignatureImage(signaturePath, signatureDataUrl);
      } catch (sigErr) {
        signatureUploadError = sigErr;
        Sentry.captureException(toSentryError(sigErr), { level: 'warning', extra: { context: 'Field Mode signature upload before completion failed; sending the completion anyway' } });
      }
      if (!stillSameAttempt()) return;
    }

    // Sends this attempt exactly: the same inputs and key every time (a lost-reply replay included).
    // Retires the key on a confirmed result, a binding refusal, or SIGNATURE_IMAGE_MISSING (this key's
    // image is not saved and never will be under it, so the next tap is a fresh attempt).
    const sendCompletion = async (): Promise<unknown> => {
      // Work out the completion time on the first send, after the signal and route checks: if midnight
      // passed during them, a ticket dated "today" is now a past date and must carry its own timestamp.
      const { data, error: rpcError } = await supabase.rpc('complete_delivery', {
        ...rpcParams,
        ...(brandBaseSeq !== null ? { p_brand_base_seq: brandBaseSeq } : {}),
        // A retry of this key resends the first send's value (completedAtForKey).
        p_completed_at: completedAtForKey(sentCompletedAt.current, rpcParams.p_idempotency_key, () => (
          usePaperTicket ? paperDeliveredAt(paperDeliveredOn) : undefined)),
      });
      try {
        if (rpcError) throw rpcError;
        assertRpcResult(data, 'complete_delivery');
      } catch (error: unknown) {
        if (getIdempotencyBindingRejection(error) || isSignatureImageMissing(error)) {
          completeIdem.resetKeyFor(completeScope);
        }
        throw error;
      }
      completeIdem.resetKeyFor(completeScope);
      return data;
    };
    // An error toast for a stop the driver has already left names it.
    const forThisStop = (message: string) => (activeStopIdRef.current === id ? message : `Delivery ${delivery.delivery_number}: ${message}`);

    // The success path: toasts, activity, notifications and the receipt. Also run after a lost reply
    // whose identical replay returned the saved result.
    const finishCompleted = async (result: unknown) => {
      // The signature image went up before the call; the server recorded signature_url itself.
      const autoInvoice = result as { auto_invoice?: { invoice_number?: string } } | null;
      // A Bill Split drafts one invoice per payer and no auto_invoice; name them all.
      const billSplit = billSplitCompletion(result);
      const invoiceNum = autoInvoice?.auto_invoice?.invoice_number || billSplit.numbers.join(', ') || null;
      const plural = billSplit.numbers.length > 1;
      // Only the stop still on screen shows the Done step; the follow-ups below run regardless.
      const stillOnStop = activeStopIdRef.current === id;
      if (invoiceNum && stillOnStop) setAutoInvoiceNumber(invoiceNum);
      if (billSplit.failed) {
        toast('warning', forThisStop(billSplitFailedMessage(profile.role)));
      } else toast('success', invoiceNum
        ? `Delivery completed${isPartial ? ' (partial)' : ''}. Draft invoice${plural ? 's' : ''} ${invoiceNum} created.`
        : `Delivery completed${isPartial ? ' (partial)' : ''}`);

      logActivity({
        event: 'delivery_completed',
        description: `Delivery ${delivery.delivery_number} completed${isPartial ? ' (partial)' : ''}${completionEvidence === 'paper_ticket' ? ' (signed paper ticket photo)' : completionEvidence === 'left_at_site' ? ' (no one present; drop-location photo)' : ' (on-screen signature)'}${invoiceNum ? ` — draft invoice ${invoiceNum}` : ''} via Field Mode`,
        performedBy: profile.id,
        entityType: 'delivery',
        entityId: delivery.id,
        customerId: delivery.customer_id,
      });

      if (isPartial) {
        const remainderItems = items
          .map((it) => ({ product: it.product?.product_name || 'Unknown', ordered: it.quantity, delivered: deliveryQtys[it.id] ?? it.quantity }))
          .filter((r) => r.delivered < r.ordered);
        if (remainderItems.length > 0) {
          await notifyDeliveryRemainder(delivery.id, delivery.delivery_number || '', delivery.order_id || '', remainderItems, delivery.created_by || '');
        }
      }

      await notifyDeliveryCompleted(delivery.id, delivery.delivery_number || '', delivery.customer?.farm_name || receiptRecipient?.farmName || 'Unknown', delivery.assigned_driver, delivery.order_id, isPartial);

      // KI-25: the receipt was recorded with the completion; the server emails it (or lists it for the office).
      if (emailOnComplete && !receiptEmail) toast('warning', RECEIPT_NO_EMAIL_ON_FILE_MESSAGE);

      if (stillOnStop) setStep('done');
    };

    let result: unknown;
    try {
      result = await sendCompletion();
    } catch (error: unknown) {
      // Any replay-binding refusal (another request's or person's key, or a receipt that can never be
      // used) or SIGNATURE_IMAGE_MISSING retired the key in sendCompletion; nothing ran for THIS
      // request. Otherwise the key is still held: the reply may have been lost after a commit.
      const keyHeld = !getIdempotencyBindingRejection(error) && !isSignatureImageMissing(error);
      Sentry.captureException(error, { tags: { source: 'critical_action', action: 'complete_delivery' } });
      // Reconcile with the server for THIS stop. Completed with the key still held: resend the
      // identical call, which replays the saved result, and run the normal success path.
      const outcome = await reconcileFailedCompletion({ deliveryId: id, keyHeld, resend: sendCompletion, context: 'Field Mode' });
      if (outcome.kind === 'replayed') {
        await finishCompleted(outcome.result);
        return;
      }
      if (outcome.kind === 'completed_not_replayed') {
        toast('error', forThisStop(RECEIPT_COMPLETED_BY_EARLIER_ATTEMPT_MESSAGE));
      } else {
        toast('error', forThisStop(sanitizeError(error)));
        // The upload had already failed for a reason other than the signal: say what it was.
        if (isSignatureImageMissing(error) && signatureUploadError && !isNetworkFailure(signatureUploadError)) {
          toast('error', forThisStop(sanitizeError(signatureUploadError)));
        }
      }
      if (activeStopIdRef.current !== id) return;
      // A completion that already committed must show as completed, not as a stale form. Only the
      // status was read: a full reload would reset the driver's edited quantities, which a retry would
      // then send as full. Still open: refresh the photos (a refused photo may be gone).
      if (outcome.kind === 'completed_not_replayed' || outcome.kind === 'closed') await fetchStop(); // opens the completed delivery
      else if (outcome.kind === 'open') await fetchPhotos();
      return;
    }
    await finishCompleted(result);
  };

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="-mx-4 -mt-4 h-36 bg-nav-dark md:mx-0 md:mt-0 md:rounded-xl" />
        <div className="mt-4 h-40 bg-gray-100 rounded-xl animate-pulse" />
      </div>
    );
  }
  if (!delivery) return null;

  const farmName = delivery.customer?.farm_name || 'Unknown customer';
  const shortCount = items.filter((it) => (deliveryQtys[it.id] ?? it.quantity) < it.quantity).length;

  return (
    <div className="phone-touch max-w-2xl mx-auto">
      <PhoneHeader
        title={farmName}
        eyebrow={delivery.delivery_number}
        back={{ label: 'My Route', onClick: () => navigate('/my-route') }}
        steps={{ labels: STEP_LABELS, current: STEP_ORDER.indexOf(step) }}
        className="-mx-4 -mt-4 mb-4 md:mx-0 md:mt-0 md:rounded-xl"
      />

      {step === 'arrive' && (
        <>
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
            {addressLine && (
              <p className="flex items-start gap-2 px-4 py-3 text-base text-nav-dark">
                <MapPin className="w-5 h-5 mt-0.5 text-crx-green shrink-0" aria-hidden="true" /> {addressLine}
              </p>
            )}
            {delivery.delivery_notes && (
              <p className="bg-amber-50 border-l-4 border-amber-500 px-4 py-3 text-sm text-amber-800">{delivery.delivery_notes}</p>
            )}
            {!isOnline && (
              <p className="flex items-center gap-2 px-4 py-3 text-sm text-amber-800">
                <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" /> You're offline — connect to start this stop.
              </p>
            )}
            {!addressLine && !delivery.delivery_notes && isOnline && (
              <p className="px-4 py-3 text-sm text-secondary">Tap Start Delivery when you arrive.</p>
            )}
          </div>
          <MainAction onClick={handleArrive} disabled={confirming || !isOnline}>
            <PlayCircle className="w-6 h-6" aria-hidden="true" />
            {confirming ? 'Starting…' : "I'm Here — Start Delivery"}
          </MainAction>
        </>
      )}

      {step === 'verify' && (
        <>
          <h2 className="font-heading text-lg font-semibold text-nav-dark mb-2">Confirm what's being delivered</h2>
          <ul className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
            {items.map((it) => {
              const delivered = deliveryQtys[it.id] ?? it.quantity;
              const short = delivered < it.quantity;
              const name = it.product?.product_name || 'Product';
              return (
                <li key={it.id} className={`px-4 py-3 ${short ? 'bg-amber-50 border-l-4 border-amber-500' : ''}`}>
                  <p className="font-semibold text-nav-dark break-words">{name}</p>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="min-w-0 text-sm">
                      <p className="text-secondary">Ordered {it.quantity}</p>
                      {short && (
                        <p className="flex items-center gap-1 font-medium text-amber-800">
                          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" /> {it.quantity - delivered} short → remainder
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button type="button" aria-label="Decrease quantity" onClick={() => updateQty(it.id, delivered - 1, it.quantity)} className={STEPPER_BUTTON}><Minus className="w-6 h-6" aria-hidden="true" /></button>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        min={0}
                        max={it.quantity}
                        value={delivered}
                        onChange={(e) => updateQty(it.id, parseFloat(e.target.value) || 0, it.quantity)}
                        aria-label={`Delivered quantity for ${it.product?.product_name || 'item'}`}
                        className="h-12 w-20 rounded-xl border border-gray-300 bg-white text-center font-heading text-[1.75rem] font-bold tabular-nums text-nav-dark"
                      />
                      <button type="button" aria-label="Increase quantity" onClick={() => updateQty(it.id, delivered + 1, it.quantity)} className={STEPPER_BUTTON}><Plus className="w-6 h-6" aria-hidden="true" /></button>
                    </div>
                  </div>
                </li>
              );
            })}
            {items.length === 0 && (
              <li className="text-sm text-center px-4 py-6">
                {itemsError
                  ? <span className="text-amber-800">Could not load items — refresh before completing.</span>
                  : <span className="text-secondary">No items on this delivery.</span>}
              </li>
            )}
          </ul>
          <div className="mt-4"><DeliveryBrandsPanel state={brandState} busy={completing} /></div>
          {!hasAnyQty && <p className="text-sm text-amber-800 mt-3 text-center">At least one item needs a quantity above zero.</p>}
          <MainAction disabled={!hasAnyQty} onClick={() => setStep('sign')}>
            {isPartial ? 'Continue with Partial' : 'All Full — Continue'}
            <ChevronRight className="w-6 h-6" aria-hidden="true" />
          </MainAction>
        </>
      )}

      {step === 'sign' && (
        <>
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <label className="flex items-center gap-3 text-base text-nav-dark mb-2">
              <input
                type="checkbox"
                checked={noOnePresent}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setNoOnePresent(checked);
                  setSignedBy(checked ? 'No one present — left at site' : '');
                  if (checked) { setSignatureDataUrl(null); setUsePaperTicket(false); }
                }}
                className={CHECKBOX}
              />
              No one present — left at site
            </label>
            {!noOnePresent && (
              <label className="flex items-center gap-3 text-base text-nav-dark mb-2">
                <input
                  type="checkbox"
                  checked={usePaperTicket}
                  onChange={(e) => {
                    setUsePaperTicket(e.target.checked);
                    if (e.target.checked) setSignatureDataUrl(null);
                  }}
                  className={CHECKBOX}
                />
                Customer signed a paper ticket (no signal at the site)
              </label>
            )}
            <label htmlFor="signed-by" className="block text-sm font-semibold text-nav-dark mt-2 mb-1">Signed by (name)</label>
            <input
              id="signed-by"
              type="text"
              value={signedBy}
              onChange={(e) => setSignedBy(e.target.value)}
              placeholder="Who received the delivery?"
              disabled={noOnePresent}
              className={`${TEXT_INPUT} mb-4 ${noOnePresent ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''}`}
              autoComplete="off"
            />
            {usePaperTicket && !noOnePresent ? (
              <div className="border border-gray-200 rounded-xl p-3 space-y-3">
                <input ref={paperTicketInputRef} type="file" accept="image/*" capture="environment" onChange={(e) => handlePhotoUpload(e, PAPER_TICKET_PHOTO_CAPTION)} className="hidden" />
                {hasPaperTicketPhoto(photos) ? (
                  <p className="flex items-center gap-2 text-sm text-green-700"><CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" /> Photo of the signed ticket saved</p>
                ) : (
                  <p className="text-sm text-amber-800">Take a photo of the signed paper ticket. It replaces the on-screen signature.</p>
                )}
                <div>
                  <label htmlFor="paper-delivered-on" className="block text-sm font-semibold text-nav-dark mb-1">Delivered on (date on the ticket)</label>
                  <input
                    id="paper-delivered-on"
                    type="date"
                    value={paperDeliveredOn}
                    max={todayInBusinessTz()}
                    onChange={(e) => setPaperDeliveredOn(e.target.value)}
                    className={TEXT_INPUT}
                  />
                </div>
                <button type="button" disabled={uploadingPhoto || !isOnline || countPaperTicketPhotos(photos) >= MAX_PAPER_TICKET_PHOTOS} onClick={() => paperTicketInputRef.current?.click()} className={SECONDARY_BUTTON}>
                  <Camera className="w-5 h-5" aria-hidden="true" /> {uploadingPhoto ? 'Uploading…' : 'Take Photo of Signed Ticket'}
                </button>
              </div>
            ) : (
              <div className={noOnePresent ? 'pointer-events-none opacity-50' : ''} aria-disabled={noOnePresent}>
                <SignatureCanvas key={noOnePresent ? 'signature-skipped' : 'signature-capture'} onSignatureChange={setSignatureDataUrl} label="Customer signs with their finger" height={160} disabled={noOnePresent} />
              </div>
            )}
            {noOnePresent && (
              <div className="border border-gray-200 rounded-xl p-3 space-y-3 mt-3">
                <input ref={leftAtSiteInputRef} type="file" accept="image/*" capture="environment" onChange={(e) => handlePhotoUpload(e, LEFT_AT_SITE_PHOTO_CAPTION)} className="hidden" />
                {hasLeftAtSitePhoto(photos) ? (
                  <p className="flex items-center gap-2 text-sm text-green-700"><CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" /> Photo of the drop location saved</p>
                ) : (
                  <p className="text-sm text-amber-800">Signature skipped because no one was present. Take a photo of where you left the delivery.</p>
                )}
                <button type="button" disabled={uploadingPhoto || !isOnline || countLeftAtSitePhotos(photos) >= MAX_LEFT_AT_SITE_PHOTOS} onClick={() => leftAtSiteInputRef.current?.click()} className={SECONDARY_BUTTON}>
                  <Camera className="w-5 h-5" aria-hidden="true" /> {uploadingPhoto ? 'Uploading…' : 'Take Photo of Drop Location'}
                </button>
              </div>
            )}
          </div>
          <div className="mt-3 space-y-1 text-center text-sm text-amber-800 empty:hidden">
            {!signedBy.trim() && <p>Enter who signed or choose no one present to continue.</p>}
            {signedBy.trim() && usePaperTicket && !hasPaperTicketPhoto(photos) && <p>Take the photo of the signed ticket to continue.</p>}
            {signedBy.trim() && usePaperTicket && !isValidPaperDeliveredOn(paperDeliveredOn) && <p>Enter the delivery date from the paper ticket (today or earlier) to continue.</p>}
            {signedBy.trim() && completionEvidence === 'signature' && !signatureDataUrl && <p>Have the customer sign above to continue.</p>}
            {noOnePresent && !hasLeftAtSitePhoto(photos) && <p>Take the drop-location photo to continue.</p>}
          </div>
          <MainAction disabled={!signedBy.trim() || !evidenceReady} onClick={() => setStep('review')}>
            Continue to Review <ChevronRight className="w-6 h-6" aria-hidden="true" />
          </MainAction>
        </>
      )}

      {step === 'review' && (
        <>
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <section className="px-4 py-3">
              <h2 className="font-heading text-lg font-semibold text-nav-dark mb-2">Add photo (optional)</h2>
              <input ref={fileInputRef} type="file" accept="image/*" capture="environment" multiple onChange={handlePhotoUpload} className="hidden" />
              {photos.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {photos.map((p) => (
                    <PrivatePhoto key={p.id} bucket="delivery-photos" path={deliveryPhotoPath(p)} alt={p.caption || 'Delivery photo'} className="w-20 h-20 object-cover rounded-lg border border-gray-200" />
                  ))}
                </div>
              )}
              {isOnline ? (
                <button type="button" disabled={uploadingPhoto || countOrdinaryPhotos(photos) >= MAX_ORDINARY_DELIVERY_PHOTOS} onClick={() => fileInputRef.current?.click()} className={SECONDARY_BUTTON}>
                  <Camera className="w-5 h-5" aria-hidden="true" /> {uploadingPhoto ? 'Uploading…' : 'Take Photo'}
                </button>
              ) : (
                <p className="flex items-center gap-2 text-sm text-amber-800"><WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" /> Photos can only be uploaded while online — reconnect to add photos.</p>
              )}
            </section>
            <dl className="border-t border-gray-200 divide-y divide-gray-100 text-base">
              <div className="flex justify-between gap-4 px-4 py-2.5"><dt className="font-semibold text-nav-dark">Delivery</dt><dd className={isPartial ? 'font-semibold text-amber-800' : 'text-nav-dark'}>{isPartial ? `Partial — ${shortCount} short` : 'Full delivery'}</dd></div>
              <div className="flex justify-between gap-4 px-4 py-2.5"><dt className="font-semibold text-nav-dark">Signed by</dt><dd className="text-nav-dark text-right break-words">{signedBy || '—'}</dd></div>
              <div className="flex justify-between gap-4 px-4 py-2.5"><dt className="font-semibold text-nav-dark">Photos</dt><dd className="text-nav-dark">{photos.length}</dd></div>
            </dl>
            {/* Always shown: a receipt is asked for unless unticked, even when this screen cannot see the email. */}
            <label className="flex items-center gap-3 border-t border-gray-100 px-4 py-2.5 text-base text-nav-dark">
              <input type="checkbox" checked={emailOnComplete} onChange={(e) => setEmailOnComplete(e.target.checked)} className={CHECKBOX} />
              Email a receipt to the customer
            </label>
          </div>

          {!isOnline && (
            <div className="bg-amber-50 border-l-4 border-amber-500 text-amber-800 text-sm rounded-lg px-3 py-2 mt-3">
              No signal. A delivery can only be completed with signal; <strong>nothing is saved offline</strong>. If the customer is signing now, go back and use a paper ticket, then complete here once you have signal.
            </div>
          )}

          <p className="text-sm text-secondary mt-3 text-center">Inventory will be deducted and a draft invoice created.</p>

          <MainAction disabled={completing || brandState.saving} onClick={requestComplete}>
            <ClipboardCheck className="w-6 h-6" aria-hidden="true" /> {completing ? 'Completing…' : 'Complete Delivery'}
          </MainAction>
        </>
      )}

      {step === 'done' && (
        <>
          <div className="bg-white border border-gray-200 rounded-xl p-6 text-center">
            <CheckCircle2 className="w-14 h-14 text-crx-green mx-auto mb-3" aria-hidden="true" />
            <p className="font-heading text-2xl font-bold text-nav-dark">Delivery complete</p>
            <p className="text-sm text-secondary mt-1">Signed by {signedBy}</p>
            {autoInvoiceNumber && (
              <p className="inline-flex items-center gap-1 text-sm text-nav-dark mt-3">
                <FileText className="w-4 h-4 text-secondary" aria-hidden="true" /> Draft invoice{autoInvoiceNumber.includes(',') ? 's' : ''} {autoInvoiceNumber} created
              </p>
            )}
          </div>
          <MainAction onClick={() => navigate('/my-route')}>
            Next Stop <ChevronRight className="w-6 h-6" aria-hidden="true" />
          </MainAction>
        </>
      )}

      <ConfirmModal
        open={brandWarningList.length > 0}
        onClose={() => { setBrandWarning(null); setStep('verify'); }}
        onConfirm={() => {
          const raisedHere = brandWarning?.stopId === id;
          setBrandWarning(null);
          if (raisedHere) void handleComplete();
        }}
        title="Brands not complete"
        message={`${brandWarningList.join(' ')} You can still complete; the office will follow up.`}
        confirmLabel="Complete anyway"
        cancelLabel="Pick brand"
        variant="warning"
      />
      <ConfirmModal
        open={brandLeaveBlocker.state === 'blocked'}
        onClose={() => brandLeaveBlocker.reset?.()}
        onConfirm={() => brandLeaveBlocker.proceed?.()}
        title="Leave this stop?"
        message="Brand choices not saved. Leave anyway?"
        confirmLabel="Leave"
        cancelLabel="Stay"
        variant="warning"
      />
    </div>
  );
}

const STEP_LABELS = ['Arrive', 'Items', 'Sign', 'Review', 'Done'];
const STEPPER_BUTTON = 'flex h-12 w-12 items-center justify-center rounded-xl bg-crx-green-light text-crx-green active:scale-95';
const CHECKBOX = 'h-5 w-5 shrink-0 rounded border-gray-300 text-crx-green';
const TEXT_INPUT = 'h-12 w-full rounded-xl border border-gray-300 px-3 text-base text-nav-dark placeholder:text-gray-500';
const SECONDARY_BUTTON = 'flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white font-semibold text-nav-dark active:scale-[0.99] disabled:opacity-50';

/** The one main button of a step: full width, 56px, pinned above the phone's bottom navigation. */
function MainAction({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 -mx-4 mt-4 bg-cream/95 px-4 py-2 backdrop-blur md:static md:mx-0 md:bg-transparent md:px-0 md:backdrop-blur-none">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-crx-green font-heading text-xl font-bold text-white hover:bg-crx-green-hover active:scale-[0.99] disabled:opacity-50"
      >
        {children}
      </button>
    </div>
  );
}
