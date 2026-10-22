/**
 * Goal 5 completion evidence (migration 20261022010000). Every delivery completion tells the
 * server how the customer confirmed it (p_evidence) and exactly which artifact proves it
 * (p_evidence_ref), and the server refuses unless that artifact is saved:
 *   signature     the on-screen signature image, uploaded BEFORE the completion call to a path the
 *                 server recomputes from the call's own retry key (signatureImagePathFor), by the
 *                 caller. No storage rule lets that file be replaced or deleted afterwards.
 *   paper_ticket  the delivery_photos row of the signed ticket the screen shows as saved;
 *   left_at_site  the delivery_photos row of the drop-location photo (field stop, no one present).
 * A refused completion changes no delivery, stock or invoice.
 */
import { supabase, assertRpcResult, checkMutationResult } from './db';
import { compressImage } from './imageCompression';
import { Sentry } from './sentry';
import type { DeliveryEvidencePhoto, ReceiptRecipient } from '../types';

/**
 * The only signature path complete_delivery accepts for this retry key:
 * signatures/<delivery id>/<first 32 hex of sha256(key)>.png. The Deliveries list calls
 * start_and_complete_delivery, which completes under `<key>:complete`, so it hashes that string.
 */
export async function signatureImagePathFor(deliveryId: string, completionKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(completionKey));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `signatures/${deliveryId}/${hex.slice(0, 32)}.png`;
}

/** A short digest of the drawn signature, so a re-drawn signature makes a new retry key (and file). */
export async function signatureDigest(signatureDataUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signatureDataUrl));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function isAlreadyExists(error: { message?: string; statusCode?: string | number; status?: number }): boolean {
  return String(error.statusCode ?? error.status ?? '') === '409' || /already exists|duplicate/i.test(error.message ?? '');
}

/**
 * Uploads the on-screen signature (a PNG data URL) to its per-attempt path; throws when it is not
 * saved. The file is never overwritten: a retry of the same key finds it already there, which counts
 * as saved (it is the same attempt's image).
 */
export async function uploadSignatureImage(path: string, signatureDataUrl: string): Promise<void> {
  const base64Data = signatureDataUrl.split(',')[1] ?? '';
  const byteCharacters = atob(base64Data);
  const byteArray = new Uint8Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) byteArray[i] = byteCharacters.charCodeAt(i);
  const blob = new Blob([byteArray], { type: 'image/png' });
  // Storage reports failures through the returned error, not a throw.
  const { error } = await supabase.storage
    .from('delivery-signatures')
    .upload(path, blob, { upsert: false, contentType: 'image/png' });
  if (error && !isAlreadyExists(error as { message?: string; statusCode?: string | number; status?: number })) {
    throw new Error(`The signature could not be saved: ${error.message}`);
  }
}

/** The newest photo with this caption, as the screen shows it: the one sent as the evidence. */
export function latestEvidencePhoto<T extends { id: string; caption?: string | null; sort_order?: number | null; uploaded_at?: string | null }>(
  photos: ReadonlyArray<T>,
  caption: string,
): T | undefined {
  const matching = photos.filter((photo) => photo.caption === caption);
  return matching[matching.length - 1];
}

/** Saves one evidence photo (file + delivery_photos row) for the Deliveries list's dialog; throws on failure. */
export async function uploadEvidencePhoto(
  deliveryId: string,
  rawFile: File,
  uploadedBy: string,
  caption: string,
): Promise<DeliveryEvidencePhoto> {
  const file = await compressImage(rawFile);
  const ext = file.name.split('.').pop() || 'jpg';
  // The server accepts only a file in this delivery's own folder.
  const storagePath = `delivery-photos/${deliveryId}/${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from('delivery-photos')
    .upload(storagePath, file, { contentType: file.type, cacheControl: '0' });
  if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);
  const { data: urlData } = supabase.storage.from('delivery-photos').getPublicUrl(storagePath);
  const result = await supabase.from('delivery_photos').insert({
    delivery_id: deliveryId,
    storage_path: storagePath,
    image_url: urlData.publicUrl,
    uploaded_by: uploadedBy,
    file_size: file.size,
    sort_order: 0,
    caption,
  }).select('id, storage_path, image_url, caption');
  checkMutationResult(result, 'Insert delivery photo');
  const row = (result.data || [])[0] as DeliveryEvidencePhoto | undefined;
  if (!row) throw new Error('The photo was uploaded but not recorded. Please try again.');
  return row;
}

/**
 * The customer's receipt email, read through get_delivery_receipt_recipient while the delivery is
 * open: an assigned driver may not see the customer row itself (customers_select hides a stop
 * scheduled before yesterday), which used to skip the receipt. Returns null when it cannot be read.
 */
export async function fetchReceiptRecipient(deliveryId: string): Promise<ReceiptRecipient | null> {
  const { data, error } = await supabase.rpc('get_delivery_receipt_recipient', { p_delivery_id: deliveryId });
  if (error || !data) {
    if (error) Sentry.captureException(error, { level: 'warning', extra: { context: 'Receipt recipient lookup failed', deliveryId } });
    return null;
  }
  const row = assertRpcResult<{ email?: unknown; contact_name?: unknown; farm_name?: unknown }>(data, 'get_delivery_receipt_recipient');
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  return { email: text(row.email), contactName: text(row.contact_name), farmName: text(row.farm_name) };
}
