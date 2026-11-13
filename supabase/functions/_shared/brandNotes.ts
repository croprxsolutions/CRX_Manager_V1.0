// Brand PR B-3: the printed brand notes under a product line, shared by the app (delivery PDF, invoice PDF, office
// resend) and the Edge Functions (send-delivery-receipts, send-email's invoice PDF), so every paper says the same thing.
// Plain text only: each caller escapes it for its own output (HTML escapes; jsPDF prints text as is).

/** A delivered brand as the receipt snapshot (20270109100000 _enqueue_delivery_receipt) saves it. */
export interface ReceiptBrand {
  name: string;
  epa_registration: string | null;
  /** Absent when the picks do not add up to delivered: amounts are never guessed. */
  quantity?: number | string | null;
}

/** The brand keys a receipt line may carry. A line with none of them prints exactly as before B-3. */
export interface ReceiptBrandInfo {
  brands?: ReceiptBrand[] | null;
  brand_recorded?: boolean | null;
  brand_picked_quantity?: number | string | null;
  /** Pre-delivery paper compares picks with the planned load, not an in-progress delivered amount. */
  brand_planned_quantity?: number | string | null;
}

/** Quantities are stored to 4 places; compare them as whole ten-thousandths, never as floats. */
function tenThousandths(v: unknown): number {
  return Math.round(Number(v) * 10000);
}

/** 4-place quantity text: 2.5000 -> "2.5". */
export function fmtBrandQty(v: unknown): string {
  return String(tenThousandths(v) / 10000);
}

function brandLabel(name: string | null | undefined, epa: string | null | undefined): string {
  return `${name || 'Unnamed brand'} (${epa ? `EPA ${epa}` : 'no EPA number'})`;
}

const ofText = (picked: unknown, delivered: unknown) => `${fmtBrandQty(picked)} of ${fmtBrandQty(delivered)}`;

function mismatchNote(amounts: string): string {
  return `Brand amounts do not match delivered: ${amounts} recorded`;
}

/** The notes under one delivery/receipt line. */
export function receiptBrandNotes(line: ReceiptBrandInfo & { qty: number | string }): string[] {
  if (line.brand_recorded === false) return ['Brand not recorded'];
  if (!Array.isArray(line.brands) || line.brands.length === 0) return [];
  const notes = line.brands.map((b) =>
    `Brand: ${brandLabel(b.name, b.epa_registration)}${b.quantity != null ? ` - ${fmtBrandQty(b.quantity)}` : ''}`);
  if (line.brand_picked_quantity != null) notes.push(line.brand_planned_quantity != null
    ? `Brand amounts do not match planned load: ${ofText(line.brand_picked_quantity, line.brand_planned_quantity)} picked`
    : mismatchNote(ofText(line.brand_picked_quantity, line.qty)));
  return notes;
}

/**
 * The receipt brand keys for one delivery line from its current picks, by the same rule the receipt snapshot uses
 * (_enqueue_delivery_receipt): picks that add up to delivered carry amounts; picks that do not carry names only and
 * what they add up to; no pick on a line with a brand list is "not recorded"; anything else carries no keys.
 */
export function receiptBrandInfoFromPicks(
  picks: ReadonlyArray<{ brand_name: string; epa_registration: string | null; quantity: number | string }>,
  delivered: number | string,
  hasBrandList: boolean,
): ReceiptBrandInfo {
  if (picks.length === 0) return hasBrandList ? { brand_recorded: false } : {};
  const sorted = [...picks].sort((a, b) =>
    a.brand_name.toLowerCase().localeCompare(b.brand_name.toLowerCase())
    || (a.epa_registration ?? '').localeCompare(b.epa_registration ?? ''));
  const picked = sorted.reduce((s, p) => s + tenThousandths(p.quantity), 0);
  if (picked === tenThousandths(delivered)) {
    return { brands: sorted.map((p) => ({ name: p.brand_name, epa_registration: p.epa_registration, quantity: p.quantity })) };
  }
  return {
    brands: sorted.map((p) => ({ name: p.brand_name, epa_registration: p.epa_registration })),
    brand_picked_quantity: picked / 10000,
  };
}

/** One entry of invoice_items.brand_lines (20270106110000): a pick, or brand_key 'n:' for a covered trip with none. */
export interface InvoiceBrandEntry {
  brand_key: string;
  brand_name: string | null;
  epa_registration: string | null;
  quantity: number | string;
  line_delivered: number | string;
  typed?: boolean;
  pick_id?: string | null;
  delivery_id?: string | null;
  delivery_item_id?: string | null;
}

/** null = no brand information on the line; [] = a brand list but no pick. */
export function parseBrandLines(v: unknown): InvoiceBrandEntry[] | null {
  return Array.isArray(v) ? (v as InvoiceBrandEntry[]) : null;
}

const isPick = (e: InvoiceBrandEntry) => e.brand_key !== 'n:';

/**
 * Per covered delivery line with picks whose picks do not add up to what it delivered (the database's 4-place rule):
 * "picked of delivered" for each such trip, so two wrong trips never cancel into a total that looks right.
 */
export function brandSplitMismatch(entries: InvoiceBrandEntry[]): string | null {
  const byTrip = new Map<string, { picked: number; delivered: number; picks: boolean }>();
  for (const e of entries) {
    const k = e.delivery_item_id ?? '';
    const t = byTrip.get(k) ?? { picked: 0, delivered: tenThousandths(e.line_delivered), picks: false };
    if (isPick(e)) { t.picked += tenThousandths(e.quantity); t.picks = true; }
    byTrip.set(k, t);
  }
  const bad = [...byTrip.values()].filter((t) => t.picks && t.picked !== t.delivered);
  if (bad.length === 0) return null;
  return bad.map((t) => ofText(t.picked / 10000, t.delivered / 10000)).join(', ');
}

/** What the covered trips delivered in total (each delivery line once), in ten-thousandths. */
export function brandLinesDelivered(entries: InvoiceBrandEntry[]): number {
  const seen = new Map<string, number>();
  for (const e of entries) seen.set(e.delivery_item_id ?? '', tenThousandths(e.line_delivered));
  return [...seen.values()].reduce((s, v) => s + v, 0);
}

/** The same delivered trip printed under two invoice rows must not show its whole-load brand amounts twice. */
export function hasRepeatedBrandTrip(lines: ReadonlyArray<{ brand_lines?: unknown }>, index: number): boolean {
  const entries = parseBrandLines(lines[index]?.brand_lines);
  if (!entries) return false;
  const ids = new Set(entries.map((e) => e.delivery_item_id).filter((id): id is string => !!id));
  return lines.some((line, i) => i !== index
    && (parseBrandLines(line.brand_lines) ?? []).some((e) => ids.has(e.delivery_item_id ?? '')));
}

/** The EPA column: a line covering several numbered brands prints them joined; otherwise the line's own number. */
export function invoiceLineEpaText(brandLines: unknown, lineEpa: string | null | undefined): string {
  // Each delivered brand's own number; a brand with none is recorded under the product's (the line's) number.
  const picks = (parseBrandLines(brandLines) ?? []).filter(isPick);
  const numbers = [...new Set(picks.map((e) => e.epa_registration || lineEpa || ''))].filter((n) => n !== '');
  return picks.length > 0 ? numbers.join(', ') : (lineEpa || '');
}

/** The notes under one invoice line. onTheLoad: a Bill Split payer's line, whose brand amounts are the whole load's. */
export function invoiceBrandNotes(brandLines: unknown, billedQuantity: number | string, onTheLoad = false, repeatedTrip = false): string[] {
  const entries = parseBrandLines(brandLines);
  if (entries === null) return [];
  if (entries.length === 0) return ['Brand not recorded'];
  const hideAmounts = repeatedTrip || (!onTheLoad && brandLinesDelivered(entries) !== tenThousandths(billedQuantity));
  const picks = entries.filter(isPick);
  const shown = hideAmounts ? picks.filter((e, i) => picks.findIndex((p) => p.brand_key === e.brand_key) === i) : picks;
  const notes = shown.map((e) =>
    `Brand: ${brandLabel(e.brand_name, e.epa_registration)}${hideAmounts ? '' : ` - ${fmtBrandQty(e.quantity)}${onTheLoad ? ' on the load' : ''}`}`);
  if (entries.some((e) => !isPick(e))) notes.push('Brand not recorded');
  const mismatch = brandSplitMismatch(entries);
  if (mismatch) notes.push(mismatchNote(mismatch));
  else if (hideAmounts) notes.push('Full-load brand amounts are on the delivery receipt.');
  return notes;
}
