// FP-1 field splits on Field Setup: shares are whole micro-percents (100,000,000 = 100%), so thirds are exact
// (33,333,334 / 33,333,333 / 33,333,333) and the screen never rounds a saved share.
import { generateIdempotencyKey } from './idempotency';

export const MICRO_100 = 100_000_000;

/** A typed percent ("33.33", "0", "40") as micro-percent; null when blank, not a number, or over 100. */
export function pctTextToMicro(text: string): number | null {
  const t = text.trim();
  if (!/^(\d+(\.\d{1,6})?|\.\d{1,6})$/.test(t)) return null;
  const micro = Math.round(Number(t) * 1_000_000);
  return micro > MICRO_100 ? null : micro;
}

/** Shown to two decimals: a third shows as 33.33. */
export function microToPctText(micro: number): string {
  return (micro / 1_000_000).toFixed(2);
}

/** Exact total for messages ("90", "99.99"), never rounded up to 100. */
/** Up to six decimals, so a total that is not exactly 100% never shows as 100.00. */
export function microToExactPct(micro: number): string {
  return String(Number((micro / 1_000_000).toFixed(6)));
}

/** n even shares totalling exactly 100%; the first payers take the leftover micro-percents. */
export function evenMicroShares(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(MICRO_100 / n);
  const left = MICRO_100 - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < left ? 1 : 0));
}

export interface SplitShareRow {
  customer_id: string;
  productMicro: number | null;
  appMicro: number | null;
}

/** The plain message the screen shows before sending, or null when the split can be saved. */
export function splitProblem(rows: SplitShareRow[]): string | null {
  if (rows.length === 0) return 'A split needs at least one payer. To bill the owner alone, add the owner at 100%.';
  if (rows.some((r) => r.productMicro == null || r.appMicro == null)) {
    return 'Enter a product share and an application share from 0 to 100 for every payer (0 is allowed).';
  }
  if (new Set(rows.map((r) => r.customer_id)).size !== rows.length) return 'A customer is listed twice in the split.';
  const product = rows.reduce((s, r) => s + (r.productMicro ?? 0), 0);
  const app = rows.reduce((s, r) => s + (r.appMicro ?? 0), 0);
  if (product !== MICRO_100) return `Product shares must total exactly 100% (now ${microToExactPct(product)}%). Try Split Evenly.`;
  if (app !== MICRO_100) return `Application shares must total exactly 100% (now ${microToExactPct(app)}%). Try Split Evenly.`;
  // shortcut: the database refuses different shares per payer until FP-4 moves job billing to split history
  // (FIELD_SPLIT_SHARES_MUST_MATCH_UNTIL_FP4); drop this check with that one.
  if (rows.some((r) => r.productMicro !== r.appMicro)) return SHARES_MUST_MATCH;
  return null;
}

/**
 * Payer-note edits to send: for payers in the split, plus anyone with a saved note on this field (the database keeps
 * those editable), so an edit to a payer removed before saving is not silently dropped.
 */
export function payerNoteChanges(
  payerIds: string[], notes: Record<string, string>, saved: Record<string, string>,
): Array<{ customer_id: string; notes: string | null }> {
  return [...new Set([...payerIds, ...Object.keys(saved)])]
    .filter((id) => (notes[id] ?? '').trim() !== (saved[id] ?? '').trim())
    .map((id) => ({ customer_id: id, notes: (notes[id] ?? '').trim() || null }));
}

const SHARES_MUST_MATCH = 'For now each payer\'s product and application shares must be the same; different shares come with the next billing update.';

const SERVER_MESSAGES: Array<[string, string]> = [
  ['FIELD_SPLIT_NOT_100', 'Product shares and application shares must each total exactly 100%.'],
  ['FIELD_SPLIT_DUPLICATE_PAYER', 'A customer is listed twice in the split.'],
  ['FIELD_SPLIT_INVALID_SHARE', 'Each share must be from 0% to 100%, with at most 6 decimals.'],
  ['FIELD_SPLIT_NO_PAYERS', 'A split needs at least one payer.'],
  ['PAGE_ACCESS_DENIED: fields', 'Your page access does not include Fields & Maps, so this field cannot be saved. Ask an admin.'],
  ['FIELD_SPLIT_CLEAR_REFUSED', 'Who pays for this field is already set and has history, so it cannot be left blank. Enter who pays.'],
  ['FIELD_SPLIT_PAYER_NOT_ACTIVE', 'A payer in this split is not an active customer.'],
  ['FIELD_SPLIT_SHARES_MUST_MATCH_UNTIL_FP4', SHARES_MUST_MATCH],
  ['FIELD_SPLIT_DATE_REQUIRED', 'Choose the date the split starts.'],
  ['FIELD_PAYER_NOTES_NOT_ON_FIELD', 'Notes can only be kept for customers on this field.'],
  ['IDEMPOTENCY_PAYLOAD_CONFLICT', 'An earlier save of this split is still being checked. Reload the page and try again.'],
];

export function splitSaveErrorMessage(message: string): string {
  return SERVER_MESSAGES.find(([code]) => message.includes(code))?.[1] ?? message;
}

// Contract rule 3: one retry key per save action, kept across retries and page reloads. Every unconfirmed
// request for a field keeps its own key until a save for that field is confirmed.
const KEY_PREFIX = 'crx:field-split-save:v1:';
const memoryKeys = new Map<string, string>();

function readKeys(slot: string): Record<string, string> {
  let text: string | null = null;
  try { text = window.sessionStorage.getItem(slot); } catch { /* storage blocked: use the in-memory copy */ }
  try {
    const parsed: unknown = JSON.parse(text ?? memoryKeys.get(slot) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

export function splitSaveKey(userId: string, fieldId: string, requestFingerprint: string): string {
  const slot = `${KEY_PREFIX}${userId}:${fieldId}`;
  const stored = readKeys(slot);
  if (typeof stored[requestFingerprint] === 'string') return stored[requestFingerprint];
  const key = generateIdempotencyKey('set_field_billing_split', userId);
  const record = JSON.stringify({ ...stored, [requestFingerprint]: key });
  memoryKeys.set(slot, record);
  try { window.sessionStorage.setItem(slot, record); } catch { /* the in-memory copy still covers retries */ }
  return key;
}

/**
 * After a confirmed save. The page reloads fresh, so every earlier unconfirmed request is superseded: sending it
 * again is a new change (e.g. going back to the old split) and must write a new version, not replay an old reply.
 */
export function clearSplitSaveKey(userId: string, fieldId: string): void {
  const slot = `${KEY_PREFIX}${userId}:${fieldId}`;
  memoryKeys.delete(slot);
  try { window.sessionStorage.removeItem(slot); } catch { /* nothing stored */ }
}
