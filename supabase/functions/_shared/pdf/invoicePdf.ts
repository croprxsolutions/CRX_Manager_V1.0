/**
 * invoicePdf.ts — CRX-branded invoice PDFs with type-aware layouts, and the reads
 * that gather an invoice's data for them.
 *
 * Shared by the app (src/lib/invoicePdf.ts) and the send-email Edge Function, which
 * draws the emailed invoice itself from the saved records (KNOWN_ISSUES KI-98), so
 * a printed and an emailed invoice come from the same code. No Deno, browser or
 * app imports: the caller passes its Supabase client and the PDF libraries.
 *
 * Three layouts based on invoice_type:
 *   1. field_application — full product detail, EPA, rates, GL/LB, shares
 *   2. chemical_sale — simpler counter/pickup sale format
 *   3. misc_charge — minimal line items
 *
 * Sprint 12: Invoice & Statement PDF Redesign
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { computeTotalDiluentGallons, formatGallons } from "./fieldAppDiluent.ts";
import { dueDateFromTerms } from "../paymentTerms.ts";
import { invoiceBrandNotes, invoiceLineEpaText } from "../brandNotes.ts";
import type { CellDef, Styles } from "npm:jspdf-autotable@5.0.9";
import { type CompanyInfo, DEFAULT_COMPANY_INFO, loadCompanyInfo } from "./companyInfo.ts";
import { type InvoiceBreakdown, invoiceBreakdown } from "./invoiceBreakdown.ts";
import {
  drawCompanyBlock, drawLogo, drawPageFooters, Q_CONTENT_BOTTOM, Q_CONTINUED_TOP, Q_LOGO_RATIO, Q_LOGO_WIDTH, Q_MARGIN_TOP,
  Q_MARGIN_X, Q_MUTED, Q_NOTE_BG, Q_TABLE, Q_TEXT, Q_TOTALS_RULE, Q_TOTALS_WIDTH,
} from "./quoteStyle.ts";
import { CRX_GREEN, formatCents as fmt, type JsPDFWithAutoTable, type PdfLib } from "./theme.ts";

type AutoTable = PdfLib["autoTable"];

/** Print toggles for an invoice PDF (src/types re-exports this). */
export interface InvoicePrintOptions {
  show_shares: boolean;
  show_price_per_acre: boolean;
  show_epa_registration: boolean;
  /**
   * Which printed layout to render (field-app parity #30 — ChemMan "Print" vs
   * "Old Print"). 'current' (default/undefined) = the modern CRX-branded layout;
   * 'legacy' = the denser monochrome "Old Print" format some customers still
   * expect. Money is identical in both — the same InvoicePdfData feeds each, so
   * Total / Payments / Prepay / Balance Due reconcile regardless of format.
   */
  format?: 'current' | 'legacy';
}

/** The invoice_items columns the PDF reads (no cost columns: every role prints invoices). */
export const INVOICE_PDF_ITEM_COLUMNS =
  'order_item_id, product_id, return_credit_source_item_id, description, quantity, unit_size, unit_price_cents, ' +
  'extended_cents, rate_per_acre, rate_unit, acres, total_applied, total_applied_unit, total_applied_gl_lb, ' +
  'gl_lb_unit, epa_registration, is_application_fee, product_form, charge_type, brand_lines, product:products(product_name, epa_registration, product_form)';


// ── PDF Data Interfaces ─────────────────────────────────────────────────

export interface InvoicePdfItem {
  order_item_id?: string | null;
  product_id?: string | null;
  return_credit_cogs_cents?: number | null;
  return_credit_source_item_id?: string | null;
  description: string;
  product_name?: string;
  quantity: number;
  unit_size?: string;
  unit_price_cents: number;
  extended_cents: number;
  cost_cents?: number;
  rate_per_acre?: number | null;
  rate_unit?: string | null;
  acres?: number | null;
  total_applied?: number | null;
  total_applied_unit?: string | null;
  total_applied_gl_lb?: number | null;
  gl_lb_unit?: string | null;
  epa_registration?: string | null;
  is_application_fee?: boolean;
  product_form?: string | null;
  /** invoice_items.charge_type: 'standing_discount' and 'sales_tax' are the database's computed lines (M4b, M4a). */
  charge_type?: string | null;
  /** Brand PR B-3: invoice_items.brand_lines as stored (see brandNotes.ts). */
  brand_lines?: unknown;
}

/** The database's own lines: printed by name and amount only. */
const isComputedLine = (item: InvoicePdfItem) => item.charge_type === 'standing_discount' || item.charge_type === 'sales_tax';

/** Convert a database invoice-item row into the one PDF shape every caller uses. */
export function mapInvoicePdfItem(item: unknown): InvoicePdfItem {
  const row = item as Record<string, unknown> & {
    product?: { product_name?: string; epa_registration?: string | null; product_form?: string | null };
  };
  return {
    order_item_id: (row.order_item_id as string) || null,
    product_id: (row.product_id as string) || null,
    return_credit_cogs_cents: row.return_credit_cogs_cents != null ? Number(row.return_credit_cogs_cents) : null,
    return_credit_source_item_id: (row.return_credit_source_item_id as string) || null,
    description: String(row.description ?? ''),
    product_name: row.product?.product_name || String(row.description ?? ''),
    quantity: Number(row.quantity),
    unit_size: (row.unit_size as string) || undefined,
    unit_price_cents: Number(row.unit_price_cents) || 0,
    extended_cents: Number(row.extended_cents) || 0,
    cost_cents: Number(row.cost_cents) || 0,
    rate_per_acre: row.rate_per_acre != null ? Number(row.rate_per_acre) : null,
    rate_unit: (row.rate_unit as string) || null,
    acres: row.acres != null ? Number(row.acres) : null,
    total_applied: row.total_applied != null ? Number(row.total_applied) : null,
    total_applied_unit: (row.total_applied_unit as string) || null,
    total_applied_gl_lb: row.total_applied_gl_lb != null ? Number(row.total_applied_gl_lb) : null,
    gl_lb_unit: (row.gl_lb_unit as string) || null,
    epa_registration: (row.epa_registration as string) || row.product?.epa_registration || null,
    is_application_fee: Boolean(row.is_application_fee),
    product_form: (row.product_form as string) || row.product?.product_form || null,
    charge_type: (row.charge_type as string) || null,
    brand_lines: row.brand_lines ?? null,
  };
}

/**
 * Return-credit accounting keeps one internal line per consumed source-cost lot.
 * Customers should still see one simple product line. Collapse only the
 * unmistakable RPC-authored return-credit rows; ordinary/manual credit memos and
 * the stored ledger rows remain untouched.
 */
interface ReturnCreditDisplayItem {
  order_item_id?: string | null;
  product_id?: string | null;
  return_credit_cogs_cents?: number | null;
  return_credit_source_item_id?: string | null;
  description: string;
  quantity: number;
  unit_size?: string | null;
  unit_price_cents: number;
  extended_cents: number;
  cost_cents?: number;
}

export function groupReturnCreditDisplayItems<T extends ReturnCreditDisplayItem>(
  invoiceType: string | null | undefined,
  items: T[],
): T[] {
  if (invoiceType !== 'credit_memo') return items;

  const grouped: T[] = [];
  const indexByKey = new Map<string, number>();
  for (const item of items) {
    // return_credit_cogs_cents is a cost column only admins can read (Mason, 2026-10-15);
    // the source-line link marks the same RPC-authored rows for everyone else.
    if (!item.order_item_id || (item.return_credit_cogs_cents == null && item.return_credit_source_item_id == null)) {
      grouped.push(item);
      continue;
    }
    const key = [
      item.order_item_id,
      item.product_id ?? '',
      item.description,
      item.unit_size ?? '',
      item.unit_price_cents,
    ].join('\u001f');
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, grouped.length);
      grouped.push({ ...item });
      continue;
    }
    const existing = grouped[existingIndex];
    grouped[existingIndex] = {
      ...existing,
      quantity: existing.quantity + item.quantity,
      extended_cents: existing.extended_cents + item.extended_cents,
      // The merged quantity spans source-cost lots, so no single per-unit cost
      // remains meaningful or safe for a future consumer to multiply.
      cost_cents: undefined,
    };
  }
  return grouped;
}

/**
 * The Fuel Surcharge line (field-app parity #32) is stored is_application_fee=true
 * with quantity=1 and unit_price_cents = the FULL flat/percent amount (NOT a
 * per-acre rate): acres/rate_per_acre/total_applied are NULL. Without this the
 * generic is_application_fee branch would mislabel it as a per-acre charge —
 * printing "200.00/AC" and "1.00 AC" on the grower-facing invoice. Detect it so
 * both PDF layouts render Rate/Total-Applied BLANK and Unit Price/Amount as a
 * plain dollar amount (no "/AC"). The Amount + invoice total use extended_cents
 * and are unchanged — this is display only.
 */
/**
 * The product cell: the name, then the delivered brands under it (Brand PR B-3). On a Bill Split payer's invoice the
 * brand amounts are the whole load's, so they read "on the load".
 */
export function productCellText(item: InvoicePdfItem, data: Pick<InvoicePdfData, 'shares'>): string {
  const onTheLoad = (data.shares ?? []).some((s) => 'invoice_id' in s && !!(s as BillSplitPayer).invoice_id);
  return [item.product_name || item.description, ...invoiceBrandNotes(item.brand_lines, onTheLoad)].join('\n');
}

export function isFuelSurchargeLine(item: InvoicePdfItem): boolean {
  return Boolean(item.is_application_fee) && item.description === 'Fuel Surcharge';
}

export interface InvoicePdfShare {
  customer_name: string;
  split_percentage: number;
  acres: number | null;
  amount_cents: number;
  price_per_acre_cents?: number | null;
  pricing_note?: string | null;
  /** A Bill Split payer's own invoice, printed as its reference on Old Print. */
  invoice_number?: string | null;
}

/** One payer of a Bill Split sale (billing plan M2): their invoice and their share of the sale (the order's split when it bills the whole sale, else of the billed totals). */
export interface BillSplitPayer extends InvoicePdfShare {
  invoice_id: string;
}

/**
 * A Bill Split draws per delivery. A field split's chemical-sale invoices have a group but no delivery.
 * A payer's draft may be switched to misc charge (guard_invoice_terminal_order) and stays in the group.
 */
export function isBillSplitInvoice(row: { invoice_type?: string | null; invoice_group_id?: string | null; delivery_id?: string | null }): boolean {
  return (row.invoice_type === 'chemical_sale' || row.invoice_type === 'misc_charge') && !!row.invoice_group_id && !!row.delivery_id;
}

/**
 * Whether this invoice shows the sale's payer table: a live Bill Split payer invoice. get_bill_split_payers refuses a
 * voided, cancelled or deleted invoice as its key, so those show no table rather than failing to open.
 */
export function readsBillSplitPayers(row: {
  invoice_type?: string | null; invoice_group_id?: string | null; delivery_id?: string | null;
  status?: string | null; deleted_at?: string | null;
}): boolean {
  return isBillSplitInvoice(row) && !['voided', 'cancelled'].includes(row.status ?? '') && !row.deleted_at;
}

export function billSplitPayerShares(rows: Array<{
  id: string;
  invoice_number: string | null;
  total_amount_cents: number | null;
  customer?: { farm_name?: string | null } | null;
}>, weightOf: (name: string) => number = () => NaN): BillSplitPayer[] {
  // Numeric, so -10 follows -2. The database sorts the suffix as text.
  const ordered = [...rows].sort((a, b) => (a.invoice_number ?? '').localeCompare(b.invoice_number ?? '', undefined, { numeric: true }));
  // Each payer's weight: the order's split when the caller has it (whole millionths of a percent), else their
  // billed total (cents).
  const weights = ordered.map((r) => {
    const w = weightOf(r.customer?.farm_name || 'Unknown');
    return Number.isNaN(w) ? (r.total_amount_cents ?? 0) : w;
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  // Hundredths of a percent, largest remainder first, so the printed column adds up to exactly 100%.
  // Whole numbers throughout (cents or millionths x 10000 stay exact), so equal remainders tie exactly and go in order.
  const parts = weights.map((w) => (total > 0 ? w * 10000 : 0));
  const bp = parts.map((p) => (total > 0 ? Math.floor(p / total) : 0));
  const short = total > 0 ? 10000 - bp.reduce((s, v) => s + v, 0) : 0;
  parts.map((p, i) => [total > 0 ? p - bp[i] * total : 0, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .slice(0, short).forEach(([, i]) => { bp[i] += 1; });
  return ordered.map((r, i) => ({
    invoice_id: r.id,
    invoice_number: r.invoice_number,
    customer_name: r.customer?.farm_name || 'Unknown',
    split_percentage: bp[i] / 100,
    acres: null,
    amount_cents: r.total_amount_cents ?? 0,
  }));
}

/**
 * Every payer of the Bill Split sale this invoice belongs to, read through get_bill_split_payers (anyone who may
 * read the invoice gets the whole group, so a rep who can't see another payer's invoice still gets the full table).
 * Read from the group's invoices, not invoice_shares: those rows split one invoice, and a re-save rescales them to it.
 * Counted, so a read cut short by the row cap is refused rather than printed as a partial payer table.
 */
export async function loadBillSplitPayers(db: SupabaseClient, invoiceId: string): Promise<BillSplitPayer[]> {
  const { data, error, count } = await db.rpc('get_bill_split_payers', { p_invoice_id: invoiceId }, { count: 'exact' });
  if (error) throw new InvoiceDetailsUnavailableError();
  const rows = assertRpcResult<Array<{ id: string; invoice_number: string | null; total_amount_cents: number | null; farm_name: string | null }>>(data, 'get_bill_split_payers');
  if (!Array.isArray(rows) || count !== rows.length) throw new InvoiceDetailsUnavailableError();
  const split = await orderSplit(db, invoiceId);
  // Names are how get_bill_split_payers identifies payers. The card must name exactly these payers, as many per name,
  // and customers who share a name must share a weight, so it can't matter which payer is which.
  const perName = new Map<string, number>();
  for (const r of rows) perName.set(r.farm_name || 'Unknown', (perName.get(r.farm_name || 'Unknown') ?? 0) + 1);
  const matches = split !== null && split.size === perName.size
    && [...perName].every(([n, k]) => split.get(n)?.length === k && split.get(n)!.every((w) => w === split.get(n)![0]));
  return billSplitPayerShares(rows
    .map((r) => ({ id: r.id, invoice_number: r.invoice_number, total_amount_cents: r.total_amount_cents, customer: { farm_name: r.farm_name } })),
    matches ? (n) => split.get(n)![0] : undefined);
}

/**
 * The sale's split from its order (Mason, 2026-11-12: the % column shows "the 50/50 split from the order, with freight
 * as its own line for that payer", not the share of billed totals that freight, discount and tax move): each payer's
 * card share in whole millionths of a percent, the main customer taking whatever the card leaves (as the split bills),
 * keyed by farm name (one weight per customer of that name). Null, so the billed share shows, when the invoice has no
 * order or a line has its own payers (the card doesn't bill those lines). A failed read refuses, as a failed payer read does.
 */
async function orderSplit(db: SupabaseClient, invoiceId: string): Promise<Map<string, number[]> | null> {
  const inv = await db.from('invoices').select('order_id').eq('id', invoiceId).maybeSingle();
  // get_bill_split_payers has already shown this invoice to this reader, so an empty read is a failure, not "no order".
  if (inv.error || !inv.data) throw new InvoiceDetailsUnavailableError();
  const orderId = (inv.data as { order_id?: string | null }).order_id;
  if (!orderId) return null;
  const [order, shares, lineShares] = await Promise.all([
    db.from('orders').select('customer_id, customer:customers(farm_name)').eq('id', orderId).maybeSingle(),
    db.from('order_shares').select('customer_id, split_percentage, customer:customers(farm_name)').eq('order_id', orderId),
    db.from('order_item_shares').select('id, order_items!inner(order_id)', { count: 'exact', head: true }).eq('order_items.order_id', orderId),
  ]);
  type Row = { customer_id: string; split_percentage?: number | string; customer?: { farm_name?: string | null } | null };
  const main = order.data as Row | null;
  if (order.error || shares.error || lineShares.error || typeof lineShares.count !== 'number' || !main || !Array.isArray(shares.data)) {
    throw new InvoiceDetailsUnavailableError();
  }
  // Only an active admin or sales rep, or the service role, gets past get_bill_split_payers. The read policies on
  // order_items (oitems_select: admin or rep), order_shares and order_item_shares (admin or rep, order not deleted;
  // 20261215110000) admit all of them, so the count covers every line share on the order.
  if (lineShares.count > 0) return null;
  // numeric(9,6): whole millionths are exact.
  const byCustomer = new Map<string, { name: string; weight: number }>();
  let left = 100_000_000;
  for (const s of shares.data as Row[]) {
    const w = Math.round(Number(s.split_percentage) * 1_000_000);
    if (!Number.isFinite(w) || w <= 0) return null;
    const seen = byCustomer.get(s.customer_id);
    if (seen) seen.weight += w;
    else byCustomer.set(s.customer_id, { name: s.customer?.farm_name || 'Unknown', weight: w });
    left -= w;
  }
  if (left < 0) return null;
  const own = byCustomer.get(main.customer_id);
  if (own) own.weight += left;
  else if (left > 0) byCustomer.set(main.customer_id, { name: main.customer?.farm_name || 'Unknown', weight: left });
  const byName = new Map<string, number[]>();
  for (const { name, weight } of byCustomer.values()) byName.set(name, [...(byName.get(name) ?? []), weight]);
  return byName;
}

// Supabase returns null data, not an error, when a call is denied; this shared file runs in Deno too,
// so it keeps its own copy (as create-user and send-delivery-receipts do).
function assertRpcResult<T>(data: unknown, _rpcName: string): T {
  if (data === null || data === undefined) throw new InvoiceDetailsUnavailableError();
  return data as T;
}

export interface InvoicePdfData {
  invoice_number: string;
  invoice_date: string;
  due_date?: string;
  invoice_type: string;
  status: string;
  customer_name: string;
  customer_email?: string;
  customer_phone?: string;
  customer_address?: string;
  customer_city?: string;
  customer_state?: string;
  customer_zip?: string;
  account_number?: string;
  salesman_name?: string;
  purchase_order_ref?: string;
  payment_terms?: string;
  header_notes?: string;
  footer_notes?: string;
  items: InvoicePdfItem[];
  total_amount_cents: number;
  total_cost_cents: number;
  paid_amount_cents: number;
  prepay_applied_cents: number;
  write_off_cents?: number;
  balance_cents: number;
  // #33: owner-entered early-pay "Discount Earned" (bigint cents). INFORMATIONAL —
  // printed as a labeled line but NEVER subtracted from total/balance (no double-count;
  // the real reduction flows through payments/write-off). Absent/0 = no line printed.
  discount_earned_cents?: number;

  // Field application context
  crop_type?: string;
  field_names?: string[];
  total_acres?: number;
  applicator_name?: string;
  vehicle_name?: string;
  application_date?: string;
  // ChemMan Gap-Closeout #2: diluent / carrier-water RATE per acre (gallons/acre).
  // The TOTAL is derived in the renderer (rate x total_acres) — never persisted —
  // because invoices.total_acres is not reliably written on save. Absent/null = the
  // diluent line is omitted entirely (no spurious 0). A QUANTITY, never money/cents.
  diluent_gpa?: number | null;

  // Shares/Splits
  shares?: InvoicePdfShare[];

  // Finance charges on this invoice
  finance_charge_cents?: number;

  // Source reference
  job_number?: string;
  order_number?: string;

  // Print options
  options?: InvoicePrintOptions;

  // Letterhead details from Settings; absent = the companyInfo.ts defaults.
  company?: CompanyInfo;
}

// ── Shared row → InvoicePdfData builder ───────────────────────────────────
// Used by every list that prints invoices (Chemical Sales batch print, the
// Field-app Unposted list per-row Print + Print All). Fetches the invoice's
// line items (with product detail), shares, and customer billing fields, then
// maps to InvoicePdfData. Centralized here so the ~50-line mapping lives once.

export interface InvoiceRowForPdf {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date?: string | null;
  invoice_type?: string | null;
  status?: string | null;
  customer_id: string;
  customer_name: string;
  salesman_name?: string | null;
  // #33: invoice-level billing fields (PO ref / terms / due date / header+footer
  // notes / early-pay Discount Earned). These are OPTIONAL on the row: a caller
  // that already has the live value (the in-editor print) passes it and it WINS;
  // a list caller OMITS them (leaves undefined) and the builder re-fetches them
  // by invoice id below, so the discount line + Terms print from the lists too.
  // (Field-app parity #33 list-print fix: list rows never carried these, so the
  // PDF skipped the discount block and the Terms line.)
  purchase_order_ref?: string | null;
  payment_terms?: string | null;
  discount_earned_cents?: number | null;
  header_notes?: string | null;
  footer_notes?: string | null;
  crop_type?: string | null;
  field_names?: string[] | null;
  total_acres?: number | null;
  applicator_name?: string | null;
  vehicle_name?: string | null;
  application_date?: string | null;
  // #2: diluent rate (gal/acre). OPTIONAL on the row, mirroring total_acres: the
  // in-editor caller passes the live value (wins); a list caller omits it and the
  // builder re-fetches it (with total_acres) from the invoices row below.
  diluent_gpa?: number | null;
  total_amount_cents: number;
  total_cost_cents?: number | null;
  paid_amount_cents?: number | null;
  prepay_applied_cents?: number | null;
  write_off_cents?: number | null;
  balance_cents: number;
}

/**
 * #2: Derive the applied-acres aggregate for a field-application invoice from
 * field_app_locations, group-aware. invoices.total_acres is NOT reliably written
 * by save_field_app_invoice (engine-built invoices leave it NULL), so a PDF that
 * needs the diluent TOTAL (rate x acres) must fall back to summing the locations:
 *   - a SPLIT invoice's locations link by invoice_group_id (invoice_id is NULL)
 *   - an UN-SPLIT invoice's locations link by invoice_id
 * This mirrors the editor's `totalAppliedAcres` so every print path shows the same
 * total. Returns null when no positive acres are found (caller keeps its prior value).
 * Shared by buildInvoicePdfDataFromRow (list/email) and InvoiceDetail's print path
 * so the derivation lives in exactly one place.
 */
export async function deriveFieldAppAppliedAcres(
  db: SupabaseClient,
  invoiceId: string,
  invoiceGroupId: string | null | undefined,
): Promise<number | null> {
  const locQuery = db.from('field_app_locations').select('applied_acres');
  const { data: locRows, error: locError } = await (invoiceGroupId
    ? locQuery.eq('invoice_group_id', invoiceGroupId)
    : locQuery.eq('invoice_id', invoiceId)
  ).then((r) => r, () => { throw new InvoiceDetailsUnavailableError(); });
  // A failed read would print the diluent rate with no total, as if no acres were recorded.
  if (locError || !Array.isArray(locRows)) throw new InvoiceDetailsUnavailableError();
  const summed = (locRows as Array<{ applied_acres: number | null }>)
    .reduce((s, r) => s + (Number(r.applied_acres) || 0), 0);
  return summed > 0 ? summed : null;
}

/**
 * Thrown when the customer, shares, billing fields or applied acres of an invoice could
 * not be read: a PDF made anyway would print with those parts silently blank.
 */
export class InvoiceDetailsUnavailableError extends Error {
  constructor() {
    super('Could not load the invoice details (customer, shares, billing or field acres), so no PDF was made. Please try again.');
    this.name = 'InvoiceDetailsUnavailableError';
  }
}

/** Thrown when an invoice's lines could not be read, so no PDF may be made from it. */
export class InvoiceLinesUnavailableError extends Error {
  constructor() {
    super('Could not load the invoice lines, so no PDF was made. Please try again.');
    this.name = 'InvoiceLinesUnavailableError';
  }
}

/**
 * Refuse a PDF whose invoice_items read failed, or returned no lines under a non-zero
 * printed total: either way the customer would get a PDF with no lines under the total.
 */
export function assertInvoiceLinesLoaded<T>(
  itemsError: unknown,
  items: T[] | null | undefined,
  printedTotalCents: number,
): asserts items is T[] {
  if (itemsError || !items || (items.length === 0 && printedTotalCents !== 0)) {
    throw new InvoiceLinesUnavailableError();
  }
}

/**
 * Build a complete InvoicePdfData from a list row by fetching the line items,
 * shares, and customer billing fields. The caller supplies the lightweight row
 * (already loaded in the list); this only touches the DB for the per-invoice
 * detail it doesn't have.
 */
export async function buildInvoicePdfDataFromRow(
  db: SupabaseClient,
  inv: InvoiceRowForPdf,
  options?: InvoicePrintOptions
): Promise<InvoicePdfData> {
  const [
    { data: cust, error: custError },
    { data: items, error: itemsError },
    { data: shares, error: sharesError },
    { data: billing, error: billingError },
  ] = await Promise.all([
    // A dropped request is a failed read too: the same refusal, not a raw network error.
    db
      .from('customers')
      .select('billing_address, city, state, zip, account_number, payment_terms')
      .eq('id', inv.customer_id)
      .maybeSingle(),
    db
      .from('invoice_items')
      .select(INVOICE_PDF_ITEM_COLUMNS)
      .eq('invoice_id', inv.id)
      .order('sort_order'),
    db
      .from('invoice_shares')
      .select('*, customer:customers!invoice_shares_customer_id_fkey(farm_name)')
      .eq('invoice_id', inv.id),
    // #33: the invoice's OWN billing fields. A list caller omits these on the row,
    // so without this re-fetch the early-pay Discount Earned line + the Terms / PO /
    // due-date / header+footer notes silently dropped to undefined → 0 → not printed.
    // Re-fetching here covers every caller (lists, email, editor) in one place; the
    // caller-supplied value still WINS (see the `?? ` fallbacks below) so the in-editor
    // print of unsaved live form edits is unchanged.
    db
      .from('invoices')
      .select('discount_earned_cents, discount_date, payment_terms, purchase_order_ref, header_notes, footer_notes, due_date, diluent_rate_gpa, total_acres, invoice_group_id, delivery_id')
      .eq('id', inv.id)
      .maybeSingle(),
  ]).catch(() => { throw new InvoiceDetailsUnavailableError(); });
  // Checked against the same total the PDF prints (total_amount_cents below).
  assertInvoiceLinesLoaded(itemsError, items, inv.total_amount_cents || 0);
  // The customer and the invoice itself must both exist (no row is a failed read here),
  // and the shares must come back as a list: otherwise the PDF would print with the
  // address, split shares, terms or notes silently missing.
  if (custError || !cust || sharesError || !Array.isArray(shares) || billingError || !billing) {
    throw new InvoiceDetailsUnavailableError();
  }

  const custRow = cust as {
    billing_address?: string | null; city?: string | null; state?: string | null;
    zip?: string | null; account_number?: string | null; payment_terms?: string | null;
  } | null;

  // #33: the invoice's persisted billing fields, used ONLY when the caller did not
  // supply the field on `inv` (undefined). A caller that DID supply it — even as
  // null to intentionally clear it — keeps full control (live form wins).
  const billingRow = billing as {
    discount_earned_cents?: number | null; discount_date?: string | null;
    payment_terms?: string | null; purchase_order_ref?: string | null;
    header_notes?: string | null; footer_notes?: string | null; due_date?: string | null;
    diluent_rate_gpa?: number | null; total_acres?: number | null; invoice_group_id?: string | null; delivery_id?: string | null;
  } | null;
  const billSplitPayers = billingRow?.invoice_group_id && shares.length === 0
      && readsBillSplitPayers({ invoice_type: inv.invoice_type, invoice_group_id: billingRow.invoice_group_id, delivery_id: billingRow.delivery_id, status: inv.status })
    ? await loadBillSplitPayers(db, inv.id)
    : [];
  const pickPo = inv.purchase_order_ref !== undefined ? inv.purchase_order_ref : billingRow?.purchase_order_ref;
  const pickTerms = inv.payment_terms !== undefined ? inv.payment_terms : billingRow?.payment_terms;
  const pickDue = inv.due_date !== undefined ? inv.due_date : billingRow?.due_date;
  const pickHeader = inv.header_notes !== undefined ? inv.header_notes : billingRow?.header_notes;
  const pickFooter = inv.footer_notes !== undefined ? inv.footer_notes : billingRow?.footer_notes;
  const pickDiscount = inv.discount_earned_cents !== undefined ? inv.discount_earned_cents : billingRow?.discount_earned_cents;
  // #2: diluent rate. Caller-supplied (in-editor live form) wins; a list caller omits
  // it and we fall back to the persisted column.
  const pickDiluent = inv.diluent_gpa !== undefined ? inv.diluent_gpa : billingRow?.diluent_rate_gpa;

  // #2: acres for the diluent TOTAL. The in-editor Print passes the live applied-acres
  // aggregate (wins). A LIST / email caller omits it, and invoices.total_acres is NOT
  // reliably written by save_field_app_invoice (engine-built invoices leave it NULL),
  // so falling back to that column alone would print the diluent rate with NO total on
  // a saved list-print (Codex r2 P2). When we have a diluent rate but still no acres,
  // DERIVE the applied-acres aggregate from field_app_locations the same way the editor
  // does — group-aware: a split invoice's locations link by invoice_group_id (invoice_id
  // NULL); an un-split invoice's locations link by invoice_id. This mirrors the editor's
  // totalAppliedAcres so the list-print total matches the in-editor total.
  let pickAcres = inv.total_acres != null ? inv.total_acres : billingRow?.total_acres;
  if (pickDiluent != null && (pickAcres == null || pickAcres <= 0)) {
    const derived = await deriveFieldAppAppliedAcres(db, inv.id, billingRow?.invoice_group_id ?? null);
    if (derived != null) pickAcres = derived;
  }

  const pdfItems = groupReturnCreditDisplayItems(
    inv.invoice_type,
    (items || []).map(mapInvoicePdfItem),
  );

  // KI-14: an editable field-application invoice with no stored due date prints the one its terms give (the
  // database fills it on save); other types and closed invoices keep "On receipt" (CodeRabbit, PR #1556).
  // Blank terms print as the 'Net 30' the database saves, so the date never shows without its terms (Sol).
  const termsDue = !pickDue && inv.invoice_date && (inv.invoice_type || 'field_application') === 'field_application'
    && ['draft', 'unposted'].includes(inv.status || 'draft');
  const printTerms = pickTerms || custRow?.payment_terms || (termsDue ? 'Net 30' : undefined);

  return {
    invoice_number: inv.invoice_number,
    invoice_date: inv.invoice_date,
    due_date: pickDue || (termsDue && inv.invoice_date ? dueDateFromTerms(inv.invoice_date, printTerms) : undefined),
    invoice_type: inv.invoice_type || 'field_application',
    status: inv.status || 'draft',
    customer_name: inv.customer_name,
    customer_address: custRow?.billing_address || undefined,
    customer_city: custRow?.city || undefined,
    customer_state: custRow?.state || undefined,
    customer_zip: custRow?.zip || undefined,
    account_number: custRow?.account_number || undefined,
    // #33: invoice-level payment terms override the customer default when present.
    payment_terms: printTerms || undefined,
    salesman_name: inv.salesman_name || undefined,
    purchase_order_ref: pickPo || undefined,
    header_notes: pickHeader || undefined,
    footer_notes: pickFooter || undefined,
    crop_type: inv.crop_type || undefined,
    field_names: inv.field_names || undefined,
    total_acres: pickAcres || undefined,
    applicator_name: inv.applicator_name || undefined,
    vehicle_name: inv.vehicle_name || undefined,
    application_date: inv.application_date || undefined,
    // #2: diluent rate (gal/acre); the renderer derives the total from total_acres.
    diluent_gpa: pickDiluent ?? undefined,
    shares: ((shares || []) as Array<{ customer?: { farm_name?: string } | null; split_percentage: number; acres: number | null; amount_cents: number; price_per_acre_cents?: number | null; pricing_note?: string | null }>).length > 0
      ? (shares as Array<{ customer?: { farm_name?: string } | null; split_percentage: number; acres: number | null; amount_cents: number; price_per_acre_cents?: number | null; pricing_note?: string | null }>).map((s) => ({
          customer_name: s.customer?.farm_name || 'Unknown',
          split_percentage: s.split_percentage,
          acres: s.acres,
          amount_cents: s.amount_cents,
          price_per_acre_cents: s.price_per_acre_cents ?? null,
          pricing_note: s.pricing_note ?? null,
        }))
      : billSplitPayers.length > 0 ? billSplitPayers : undefined,
    items: pdfItems,
    total_amount_cents: inv.total_amount_cents || 0,
    total_cost_cents: inv.total_cost_cents || 0,
    paid_amount_cents: inv.paid_amount_cents || 0,
    prepay_applied_cents: inv.prepay_applied_cents || 0,
    write_off_cents: inv.write_off_cents || 0,
    balance_cents: inv.balance_cents || 0,
    // #33: informational Discount Earned line (does NOT change total/balance).
    discount_earned_cents: pickDiscount || 0,
    options,
  };
}

function uniqNonEmpty(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((v) => (v ?? '').trim()).filter(Boolean))];
}

/**
 * The emailed invoice's PDF data, read from the saved invoice alone (send-email, KI-98).
 * The invoice row, its customer's name, its salesman and (for a field application) its
 * field locations become the row buildInvoicePdfDataFromRow prints from, so the email
 * uses the same reads and layout as the app's Print. Fields, crop and acres come from
 * the locations when there are any, as the field-invoice lists show them
 * (mapFieldInvoiceRow in src/lib/fieldInvoiceList.ts). Any failed read throws: an
 * invoice is never emailed with parts silently blank.
 */
export async function loadInvoicePdfData(db: SupabaseClient, invoiceId: string): Promise<InvoicePdfData> {
  const { data: inv, error: invError } = await db
    .from('invoices')
    .select(
      'id, invoice_number, invoice_date, invoice_type, status, customer_id, salesman_id, invoice_group_id, ' +
        'crop_type, field_names, total_acres, applicator_name, vehicle_name, application_date, ' +
        'total_amount_cents, paid_amount_cents, prepay_applied_cents, write_off_cents, balance_cents, ' +
        'customer:customers!invoices_customer_id_fkey(farm_name)',
    )
    .eq('id', invoiceId)
    .maybeSingle();
  if (invError || !inv) throw new InvoiceDetailsUnavailableError();
  const row = inv as unknown as {
    id: string; invoice_number: string | null; invoice_date: string; invoice_type: string | null;
    status: string | null; customer_id: string; salesman_id: string | null; invoice_group_id: string | null;
    crop_type: string | null; field_names: string[] | null; total_acres: number | null;
    applicator_name: string | null; vehicle_name: string | null; application_date: string | null;
    total_amount_cents: number; paid_amount_cents: number | null; prepay_applied_cents: number | null;
    write_off_cents: number | null; balance_cents: number; customer: { farm_name: string | null } | null;
  };

  let salesmanName: string | null = null;
  if (row.salesman_id) {
    const { data: salesman, error: salesmanError } = await db
      .from('profiles')
      .select('full_name')
      .eq('id', row.salesman_id)
      .maybeSingle();
    if (salesmanError) throw new InvoiceDetailsUnavailableError();
    salesmanName = (salesman as { full_name: string | null } | null)?.full_name ?? null;
  }

  let cropType = row.crop_type;
  let fieldNames = row.field_names;
  let totalAcres = row.total_acres;
  if (row.invoice_type === 'field_application') {
    const locQuery = db
      .from('field_app_locations')
      .select('applied_acres, crop_type, field:fields!field_app_locations_field_id_fkey(field_name, crop_type)');
    const { data: locs, error: locError } = await (row.invoice_group_id
      ? locQuery.eq('invoice_group_id', row.invoice_group_id)
      : locQuery.eq('invoice_id', row.id)
    ).order('id');
    if (locError || !Array.isArray(locs)) throw new InvoiceDetailsUnavailableError();
    const locRows = locs as unknown as Array<{
      applied_acres: number | null; crop_type: string | null;
      field: { field_name: string | null; crop_type: string | null } | null;
    }>;
    if (locRows.length > 0) {
      const crops = uniqNonEmpty(locRows.map((l) => l.crop_type ?? l.field?.crop_type));
      const names = uniqNonEmpty(locRows.map((l) => l.field?.field_name));
      cropType = crops[0] ?? null;
      fieldNames = names.length > 0 ? names : null;
      totalAcres = locRows.reduce((sum, l) => sum + (Number(l.applied_acres) || 0), 0) || null;
    } else {
      cropType = uniqNonEmpty([row.crop_type])[0] ?? null;
      const names = uniqNonEmpty(row.field_names ?? []);
      fieldNames = names.length > 0 ? names : null;
    }
  }

  let company: CompanyInfo;
  try {
    company = await loadCompanyInfo(db);
  } catch {
    throw new InvoiceDetailsUnavailableError();
  }

  const pdfData = await buildInvoicePdfDataFromRow(db, {
    id: row.id,
    invoice_number: row.invoice_number || 'DRAFT',
    invoice_date: row.invoice_date,
    invoice_type: row.invoice_type,
    status: row.status,
    customer_id: row.customer_id,
    customer_name: row.customer?.farm_name?.trim() || 'Unknown',
    salesman_name: salesmanName,
    crop_type: cropType,
    field_names: fieldNames,
    total_acres: totalAcres,
    applicator_name: row.applicator_name,
    vehicle_name: row.vehicle_name,
    application_date: row.application_date,
    total_amount_cents: row.total_amount_cents,
    paid_amount_cents: row.paid_amount_cents,
    prepay_applied_cents: row.prepay_applied_cents,
    write_off_cents: row.write_off_cents,
    balance_cents: row.balance_cents,
  });
  return { ...pdfData, company };
}

// ── Helpers ──────────────────────────────────────────────────────────────

export const fmtNum = (n: number, decimals = 4) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);

export const fmtDate = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

// #2: one-line "Diluent / Carrier Water" string for the field-app PDF — the rate
// per acre plus the derived total (rate x applied acres) when acres are known.
// Returns '' to signal "render nothing" (caller skips the line) when there is no
// recorded rate, so the printout never shows a phantom 0 / a rate with no total.
//   "Diluent / Carrier Water: 15 gal/ac · 1,500 gal total (91.90 ac)"
//   "Diluent / Carrier Water: 15 gal/ac"   (acres unknown — rate only)
export function buildDiluentLine(
  rateGpa: number | null | undefined,
  acres: number | null | undefined,
): string {
  if (rateGpa == null || !Number.isFinite(rateGpa) || rateGpa < 0) return '';
  const rateStr = formatGallons(rateGpa);
  const total = computeTotalDiluentGallons(rateGpa, acres);
  if (total == null) {
    return `Diluent / Carrier Water: ${rateStr} gal/ac`;
  }
  const totalStr = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(total);
  return `Diluent / Carrier Water: ${rateStr} gal/ac · ${totalStr} gal total (${fmtNum(acres as number, 2)} ac)`;
}

// ── Main Generator ──────────────────────────────────────────────────────
// The current ("Print") layout in the quote PDF's style (quoteStyle.ts): letterhead with the logo, bill-to,
// one table per layout, totals line by line, who pays on a Bill Split, a pay note and "Page X of Y".

type Row = Array<string | CellDef>;

/** What each drawing step needs; y is the running position, moved by every step. */
interface Page {
  doc: JsPDFWithAutoTable;
  data: InvoicePdfData;
  opts: InvoicePrintOptions;
  autoTable: AutoTable;
  pageW: number;
  /** Content stops here; the footer sits below. */
  bottom: number;
  /** The totals rows, only when the lines add up to the invoice total; null keeps every line in the table. */
  breakdown: InvoiceBreakdown | null;
  y: number;
}

/** Draws the current ("Print") layout. The app's generateInvoicePdf routes "Old Print" itself. */
export function drawInvoicePdf({ jsPDF, autoTable }: PdfLib, data: InvoicePdfData): JsPDFWithAutoTable {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as JsPDFWithAutoTable;
  const company = data.company ?? DEFAULT_COMPANY_INFO;
  const breakdown = invoiceBreakdown(data.items);
  const p: Page = {
    doc, data, autoTable,
    opts: data.options ?? { show_shares: true, show_price_per_acre: true, show_epa_registration: true },
    pageW: doc.internal.pageSize.getWidth(),
    bottom: doc.internal.pageSize.getHeight() - Q_CONTENT_BOTTOM,
    breakdown: breakdown.totalCents === data.total_amount_cents ? breakdown : null,
    y: Q_MARGIN_TOP,
  };

  drawHeader(p, company);
  drawBillTo(p);
  if (data.invoice_type === 'field_application') drawFieldApplicationLayout(p);
  else if (data.invoice_type === 'chemical_sale') drawChemicalSaleLayout(p);
  else drawMiscChargeLayout(p);
  drawTotals(p);
  drawPayNote(p, company);
  if (data.footer_notes) {
    p.y += 10;
    drawBoxedNote(p, data.footer_notes);
  }
  drawPageFooters(doc, [company.name, company.email, company.phone && `Questions? Call ${company.phone}.`].filter(Boolean).join(' · '));
  return doc;
}

function newPage(p: Page): void {
  p.doc.addPage();
  p.y = Q_CONTINUED_TOP;
}

const contentWidth = (p: Page) => p.pageW - Q_MARGIN_X * 2;
const fmtShare = (pct: number) => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(pct)}%`;

/** A Bill Split's payers (each share is another invoice), when the print shows shares. */
function billSplitPayers(p: Page): InvoicePdfShare[] | null {
  const shares = p.data.shares ?? [];
  return p.opts.show_shares && shares.length > 1 && shares.every((s) => s.invoice_number) ? shares : null;
}

const thisPayer = (p: Page) => billSplitPayers(p)?.find((s) => s.invoice_number === p.data.invoice_number);

// ── Letterhead and bill-to ───────────────────────────────────────────────

/** Company block | logo, "Invoice" and status | the invoice details, as the quote PDF's header. */
function drawHeader(p: Page, company: CompanyInfo): void {
  const { doc, data, pageW } = p;
  const top = p.y;
  const colW = (contentWidth(p) - 32) / 3;
  const companyY = drawCompanyBlock(doc, company, top, colW);
  drawLogo(doc, pageW / 2 - Q_LOGO_WIDTH / 2, top, Q_LOGO_WIDTH);
  let titleY = top + Q_LOGO_WIDTH * Q_LOGO_RATIO + 15;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13.5);
  doc.setTextColor(...Q_TEXT);
  doc.text('Invoice', pageW / 2, titleY, { align: 'center' });
  if (data.status) {
    titleY += 12;
    doc.setFontSize(7.5);
    doc.setTextColor(...Q_MUTED);
    doc.text(data.status.toUpperCase(), pageW / 2, titleY, { align: 'center' });
  }
  p.y = Math.max(companyY, titleY, drawInvoiceDetails(p, top, colW));
}

function invoiceDetails(data: InvoicePdfData): Array<[string, string]> {
  const rows: Array<[string, string | undefined]> = [
    ['Invoice #', data.invoice_number],
    ['Invoice date', fmtDate(data.invoice_date)],
    ['Due date', data.due_date ? fmtDate(data.due_date) : 'On receipt'],
    ['Terms', data.payment_terms],
    ['Account #', data.account_number],
    ['Salesperson', data.salesman_name],
    ['Customer PO #', data.purchase_order_ref],
  ];
  return rows.filter((row): row is [string, string] => !!row[1]);
}

/** Bold label and value per row, right edge on the margin; values wrap in the column. Returns the last baseline. */
function drawInvoiceDetails(p: Page, top: number, colW: number): number {
  const { doc } = p;
  const details = invoiceDetails(p.data);
  doc.setFontSize(8.25);
  doc.setTextColor(...Q_TEXT);
  doc.setFont('helvetica', 'bold');
  const labelW = Math.max(...details.map(([label]) => doc.getTextWidth(label))) + 9;
  doc.setFont('helvetica', 'normal');
  const valueLines = details.map(([, value]) => doc.splitTextToSize(value, colW - labelW) as string[]);
  const x = p.pageW - Q_MARGIN_X - labelW - Math.max(...valueLines.flat().map((line) => doc.getTextWidth(line)));
  let y = top + 9;
  details.forEach(([label], i) => {
    doc.setFont('helvetica', 'bold');
    doc.text(label, x, y);
    doc.setFont('helvetica', 'normal');
    for (const line of valueLines[i]) {
      doc.text(line, x + labelW, y);
      y += 12;
    }
  });
  return y - 12;
}

function drawLabel(doc: JsPDFWithAutoTable, label: string, x: number, y: number): void {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...Q_MUTED);
  doc.text(label, x, y);
  doc.setTextColor(...Q_TEXT);
  doc.setFontSize(9);
}

/** BILL TO where a window envelope shows it, and FOR (this payer's part of the delivery) beside it. */
function drawBillTo(p: Page): void {
  const { doc, data } = p;
  const x = Q_MARGIN_X + 27;
  p.y += 30;
  const top = p.y;
  drawLabel(doc, 'BILL TO', x, top);
  let y = top;
  for (const line of doc.splitTextToSize(data.customer_name.toUpperCase(), contentWidth(p) / 2 - 27) as string[]) {
    y += 13;
    doc.text(line, x, y);
  }
  doc.setFont('helvetica', 'normal');
  const city = data.customer_city || data.customer_state
    ? [data.customer_city, [data.customer_state, data.customer_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
  for (const line of [data.customer_address, city, data.customer_phone]) {
    if (!line) continue;
    y += 13;
    doc.text(line, x, y);
  }
  const payer = thisPayer(p);
  if (payer) {
    const forX = Q_MARGIN_X + contentWidth(p) / 2 + 12;
    drawLabel(doc, 'FOR', forX, top);
    doc.setFont('helvetica', 'normal');
    doc.text(`This invoice bills ${fmtShare(payer.split_percentage)} of the delivery.`, forX, top + 13);
    y = Math.max(y, top + 13);
  }
  p.y = y + 8;
}

/** A note in a light grey box, the lead sentence bold; split across pages when long. */
function drawBoxedNote(p: Page, text: string, lead = ''): void {
  const { doc } = p;
  const padX = 7.5;
  const padY = 6;
  const lineH = 12;
  const w = contentWidth(p) - padX * 2;
  doc.setFontSize(8.25);
  doc.setFont('helvetica', 'bold');
  const leadW = lead ? doc.getTextWidth(`${lead} `) : 0;
  doc.setFont('helvetica', 'normal');
  const inline = !!lead && (doc.splitTextToSize(text, w - leadW) as string[]).length === 1;
  const lines: Array<[string, string]> = inline ? [[lead, text]] : [
    ...(lead ? [[lead, ''] as [string, string]] : []),
    ...(doc.splitTextToSize(text, w) as string[]).map((line): [string, string] => ['', line]),
  ];
  while (lines.length) {
    const fits = Math.floor((p.bottom - p.y - padY * 2) / lineH);
    if (fits < 1) {
      newPage(p);
      continue;
    }
    const chunk = lines.splice(0, fits);
    doc.setFillColor(...Q_NOTE_BG);
    doc.rect(Q_MARGIN_X, p.y, contentWidth(p), chunk.length * lineH + padY * 2, 'F');
    doc.setTextColor(...Q_TEXT);
    chunk.forEach(([bold, normal], i) => drawNoteLine(doc, bold, normal, p.y + padY + (i + 1) * lineH - 3, leadW));
    p.y += chunk.length * lineH + padY * 2;
    if (lines.length) newPage(p);
  }
}

function drawNoteLine(doc: JsPDFWithAutoTable, bold: string, normal: string, y: number, leadW: number): void {
  const x = Q_MARGIN_X + 7.5;
  if (bold) {
    doc.setFont('helvetica', 'bold');
    doc.text(bold, x, y);
  }
  if (normal) {
    doc.setFont('helvetica', 'normal');
    doc.text(normal, bold ? x + leadW : x, y);
  }
}

// ── Tables ───────────────────────────────────────────────────────────────

/** Bold section title over the green rule, with an optional muted note at its right end. */
function drawSectionTitle(p: Page, title: string, note = '', width = contentWidth(p)): void {
  const { doc } = p;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...Q_TEXT);
  doc.text(title, Q_MARGIN_X, p.y + 9);
  if (note) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...Q_MUTED);
    doc.text(note, Q_MARGIN_X + width, p.y + 9, { align: 'right' });
  }
  doc.setDrawColor(...CRX_GREEN);
  doc.setLineWidth(1.125);
  doc.line(Q_MARGIN_X, p.y + 13, Q_MARGIN_X + width, p.y + 13);
  p.y += 17;
}

/** Right-aligns the last `count` of `n` columns (numbers and money) and bolds the last (the amount). */
function numberColumns(n: number, count: number): Record<number, Partial<Styles>> {
  const styles: Record<number, Partial<Styles>> = { 0: { cellWidth: 'auto' } };
  for (let i = n - count; i < n; i++) styles[i] = { halign: 'right' };
  styles[n - 1] = { halign: 'right', fontStyle: 'bold' };
  return styles;
}

function drawTable(
  p: Page, head: string[], body: Row[], columnStyles: Record<number, Partial<Styles>>,
  sides: { left: number; right: number } = { left: Q_MARGIN_X, right: Q_MARGIN_X },
): void {
  p.autoTable(p.doc, {
    ...Q_TABLE,
    startY: p.y,
    margin: { ...Q_TABLE.margin, ...sides },
    head: [head],
    body,
    columnStyles,
    // A heading sits over its column: right-aligned over numbers.
    didParseCell: (hook) => {
      if (hook.section === 'head') hook.cell.styles.halign = columnStyles[hook.column.index]?.halign ?? 'left';
    },
  });
  p.y = p.doc.lastAutoTable.finalY;
}

/** The lines the table lists: all of them, less the discount and tax when the totals show those. */
const tableItems = (p: Page) => (p.breakdown ? p.data.items.filter((item) => !isComputedLine(item)) : p.data.items);

function drawProductsTitle(p: Page): void {
  p.y += 16;
  if (p.y + 70 > p.bottom) newPage(p);
  const payer = thisPayer(p);
  drawSectionTitle(p, 'PRODUCTS AND CHARGES', payer ? `Quantities are this payer's ${fmtShare(payer.split_percentage)}` : '');
}

function drawHeaderNotes(p: Page): void {
  if (!p.data.header_notes) return;
  p.y += 10;
  drawBoxedNote(p, p.data.header_notes);
}

// ── Layout 1: Field Application ──────────────────────────────────────────

/** "Corn - 91.90 - Pole Field", the diluent line and the growers, above the table. */
function drawFieldContext(p: Page): void {
  const { doc, data } = p;
  const desc = [data.crop_type, data.total_acres ? fmtNum(data.total_acres, 2) : null, data.field_names?.join(', ')]
    .filter(Boolean).join(' - ');
  const diluent = data.diluent_gpa != null ? buildDiluentLine(data.diluent_gpa, data.total_acres) : '';
  const growers = data.shares && data.shares.length > 1 ? data.shares.map((s) => `Grower: ${s.customer_name}`).join('  ') : '';
  const lines: Array<[string, 'bold' | 'normal']> = [[desc, 'bold'], [diluent, 'normal'], [growers, 'normal']];
  doc.setFontSize(8.25);
  doc.setTextColor(...Q_TEXT);
  for (const [line, weight] of lines) {
    if (!line) continue;
    doc.setFont('helvetica', weight);
    p.y += 13;
    doc.text(line, Q_MARGIN_X, p.y);
  }
}

function fieldApplicationRow(item: InvoicePdfItem, data: InvoicePdfData, showEpa: boolean): string[] {
  const isFuel = isFuelSurchargeLine(item);
  const rateStr = !isFuel && item.rate_per_acre != null ? `${fmtNum(item.rate_per_acre, 4)} ${item.rate_unit || item.unit_size || ''}` : '';
  const totalApplied = isFuel
    ? ''
    : item.total_applied != null
      ? `${fmtNum(item.total_applied, item.total_applied === Math.round(item.total_applied) ? 2 : 4)} ${item.total_applied_unit || ''}`
      : item.is_application_fee ? `${fmtNum(item.quantity, 2)} AC` : '';
  const glLb = item.total_applied_gl_lb != null ? `${fmtNum(item.total_applied_gl_lb, 4)} ${item.gl_lb_unit || ''}` : '';
  const unitPrice = isFuel
    ? `${fmtNum(item.unit_price_cents / 100, 2)}`
    : item.is_application_fee
      ? `${fmtNum(item.unit_price_cents / 100, 2)} AC`
      : `${fmtNum(item.unit_price_cents / 100, 2)} ${item.gl_lb_unit || item.unit_size || ''}`;
  return [
    productCellText(item, data),
    ...(showEpa ? [invoiceLineEpaText(item.brand_lines, item.epa_registration)] : []),
    rateStr, totalApplied, glLb, unitPrice, fmt(item.extended_cents),
  ];
}

function drawFieldApplicationLayout(p: Page): void {
  const { doc, data, opts } = p;
  drawFieldContext(p);
  drawHeaderNotes(p);
  drawProductsTitle(p);
  const showEpa = opts.show_epa_registration;
  const head = ['Product', ...(showEpa ? ['EPA Reg'] : []), 'Rate / Acre', 'Total Applied', 'Total Applied GL/LB', 'Unit Price', 'Total Cost'];
  drawTable(p, head, tableItems(p).map((item) => fieldApplicationRow(item, data, showEpa)), numberColumns(head.length, 5));

  if (opts.show_price_per_acre && data.total_acres && data.total_acres > 0) {
    const pricePerAcre = data.total_amount_cents / 100 / data.total_acres;
    p.y += 14;
    doc.setFontSize(8.25);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...Q_MUTED);
    doc.text(`Price per acre: ${fmtNum(pricePerAcre, 2)}`, Q_MARGIN_X + 4.5, p.y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...Q_TEXT);
    doc.text(`Total ${fmt(data.total_amount_cents)}`, p.pageW - Q_MARGIN_X - 4.5, p.y, { align: 'right' });
    p.y += 4;
  }
  drawSharesTable(p, true);
  drawFinanceStrip(p);
}

// ── Layout 2: Chemical Sale ──────────────────────────────────────────────

function chemicalSaleRow(item: InvoicePdfItem, data: InvoicePdfData, showEpa: boolean): string[] {
  const epa = showEpa ? [isComputedLine(item) ? '' : invoiceLineEpaText(item.brand_lines, item.epa_registration)] : [];
  if (isComputedLine(item)) return [item.product_name || item.description, ...epa, '', '', fmt(item.extended_cents)];
  const qtyStr = `${fmtNum(item.quantity, 2)} ${item.unit_size || item.rate_unit || ''}`;
  const costStr = `${fmt(item.unit_price_cents)} ${item.gl_lb_unit || item.unit_size || ''}`;
  return [productCellText(item, data), ...epa, qtyStr, costStr, fmt(item.extended_cents)];
}

function drawChemicalSaleLayout(p: Page): void {
  drawHeaderNotes(p);
  drawProductsTitle(p);
  const showEpa = p.opts.show_epa_registration;
  const head = ['Product', ...(showEpa ? ['EPA reg. #'] : []), 'Quantity', 'Unit price', 'Amount'];
  drawTable(p, head, tableItems(p).map((item) => chemicalSaleRow(item, p.data, showEpa)), numberColumns(head.length, 3));
  drawSharesTable(p, false);
  drawFinanceStrip(p);
}

// ── Layout 3: Misc Charge ────────────────────────────────────────────────

function drawMiscChargeLayout(p: Page): void {
  drawHeaderNotes(p);
  drawProductsTitle(p);
  const rows = tableItems(p).map((item) => [item.product_name || item.description, fmt(item.extended_cents)]);
  drawTable(p, ['Description', 'Amount'], rows, numberColumns(2, 1));
  // Every Bill Split payer's invoice shows every payer (Mason, 9 Nov), a payer's misc charge draft too.
  drawSharesTable(p, false);
}

// ── Shares, finance charges ──────────────────────────────────────────────

/**
 * The split of this one invoice (invoice_shares): growers with acres on a field application, customers on a sale.
 * A Bill Split's payers print beside the totals instead (drawWhoPays).
 */
function drawSharesTable(p: Page, field: boolean): void {
  const shares = p.data.shares;
  if (!p.opts.show_shares || !shares || shares.length < 2 || billSplitPayers(p)) return;
  const perAcre = shares.some((s) => s.price_per_acre_cents != null);
  const head = [field ? '' : 'Customer', ...(perAcre ? ['$/Acre'] : []), 'Shares', ...(field ? ['Acres'] : []), 'Total'];
  const body = shares.map((s) => [
    s.pricing_note ? `${s.customer_name}\n${s.pricing_note}` : s.customer_name,
    ...(perAcre ? [s.price_per_acre_cents != null ? fmt(s.price_per_acre_cents) : ''] : []),
    `${fmtNum(s.split_percentage, field ? 2 : 4)}%`,
    ...(field ? [s.acres != null ? fmtNum(s.acres, 2) : ''] : []),
    fmt(s.amount_cents),
  ]);
  p.y += 10;
  drawTable(p, head, body, numberColumns(head.length, head.length - 1), { left: Q_MARGIN_X + (perAcre ? 140 : 200), right: Q_MARGIN_X });
}

function drawFinanceStrip(p: Page): void {
  const { doc, data } = p;
  const finance = data.finance_charge_cents ?? 0;
  if (finance <= 0) return;
  const right = p.pageW - Q_MARGIN_X;
  if (p.y + 40 > p.bottom) newPage(p);
  p.y += 8;
  doc.setDrawColor(...Q_TOTALS_RULE);
  doc.setLineWidth(0.75);
  doc.line(Q_MARGIN_X, p.y, right, p.y);
  p.y += 12;
  doc.setFontSize(8.25);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...Q_TEXT);
  doc.text('FIN', Q_MARGIN_X, p.y);
  doc.text('Finance Charges', Q_MARGIN_X + 60, p.y);
  doc.text(fmt(finance), right, p.y, { align: 'right' });
  p.y += 14;
  doc.setFont('helvetica', 'bold');
  doc.text(`Net Due (${data.invoice_number}):`, Q_MARGIN_X + 60, p.y);
  doc.text(fmt(data.balance_cents + finance), right, p.y, { align: 'right' });
}

// ── Totals and who pays ──────────────────────────────────────────────────

/** Products, each charge type, the discount and the tax: rows that add up to the invoice total. */
function breakdownRows(p: Page): Array<[string, string]> {
  const b = p.breakdown;
  if (!b) return [];
  const others = [...b.charges, ...(b.discount ? [b.discount] : []), ...(b.tax ? [b.tax] : [])];
  const products = b.productsCents !== 0 || others.length === 0 ? [{ label: 'Products', cents: b.productsCents }] : [];
  return [...products, ...others].map(({ label, cents }) => [label || 'Other charges', fmt(cents)]);
}

/** What came off or went on after the invoice total, as the old totals box printed it. */
function paymentRows(data: InvoicePdfData): Array<[string, string]> {
  const rows: Array<[string, string, number]> = [
    ['Payments', `-${fmt(data.paid_amount_cents)}`, data.paid_amount_cents],
    ['Prepay applied', `-${fmt(data.prepay_applied_cents)}`, data.prepay_applied_cents],
    ['Write-off', `-${fmt(data.write_off_cents ?? 0)}`, data.write_off_cents ?? 0],
    ['Finance charges', fmt(data.finance_charge_cents ?? 0), data.finance_charge_cents ?? 0],
  ];
  return rows.filter(([, , cents]) => cents > 0).map(([label, value]) => [label, value]);
}

function drawTotals(p: Page): void {
  const rows = breakdownRows(p);
  const after = paymentRows(p.data);
  const payers = billSplitPayers(p);
  const height = Math.max((rows.length + after.length) * 12 + 76, payers ? 30 + (payers.length + 2) * 17 : 0);
  p.y += 18;
  if (p.y + height > p.bottom) newPage(p);
  const top = p.y;
  let payersEnd = top;
  if (payers) {
    drawWhoPays(p, payers);
    payersEnd = p.y;
    p.y = top;
  }
  drawTotalsBlock(p, rows, after);
  p.y = Math.max(p.y, payersEnd);
}

function drawTotalsRows(p: Page, rows: Array<[string, string]>, x: number): void {
  const { doc } = p;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.25);
  doc.setTextColor(...Q_TEXT);
  for (const [label, value] of rows) {
    doc.text(label, x, p.y + 10);
    doc.text(value, p.pageW - Q_MARGIN_X, p.y + 10, { align: 'right' });
    p.y += 12;
  }
}

function drawTotalLine(p: Page, label: string, value: string, x: number, valueSize: number): void {
  const { doc } = p;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.75);
  doc.text(label, x, p.y + 14);
  doc.setFontSize(valueSize);
  doc.text(value, p.pageW - Q_MARGIN_X, p.y + 14, { align: 'right' });
  p.y += 20;
}

/** The right-hand totals: rows, Invoice total, payments, Balance due (green), and the early-pay discount note. */
function drawTotalsBlock(p: Page, rows: Array<[string, string]>, after: Array<[string, string]>): void {
  const { doc, data } = p;
  const x = p.pageW - Q_MARGIN_X - Q_TOTALS_WIDTH;
  const right = p.pageW - Q_MARGIN_X;
  doc.setDrawColor(...Q_TEXT);
  doc.setLineWidth(1.5);
  doc.line(x, p.y, right, p.y);
  p.y += 4;
  drawTotalsRows(p, rows, x);
  if (rows.length) {
    p.y += 5;
    doc.setDrawColor(...Q_TOTALS_RULE);
    doc.setLineWidth(0.75);
    doc.line(x, p.y, right, p.y);
  }
  doc.setTextColor(...Q_TEXT);
  drawTotalLine(p, 'Invoice total', fmt(data.total_amount_cents), x, 12);
  drawTotalsRows(p, after, x);
  drawBalanceDue(p, x);
}

function drawBalanceDue(p: Page, x: number): void {
  const { doc, data } = p;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.75);
  doc.setTextColor(...Q_TEXT);
  doc.text('Balance due', x, p.y + 16);
  doc.setFontSize(13.5);
  doc.setTextColor(...CRX_GREEN);
  doc.text(fmt(data.balance_cents), p.pageW - Q_MARGIN_X, p.y + 16, { align: 'right' });
  p.y += 22;
  // #33: the early-pay Discount Earned is shown but never taken off the balance, so Balance due still
  // reconciles to total - payments - prepay - write-off.
  if ((data.discount_earned_cents ?? 0) > 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...Q_MUTED);
    doc.text('Discount earned (if paid early)', x, p.y + 8);
    doc.text(fmt(data.discount_earned_cents ?? 0), p.pageW - Q_MARGIN_X, p.y + 8, { align: 'right' });
    p.y += 12;
  }
}

/** Every payer of the Bill Split, this invoice's row bold, and the delivery's total. Left of the totals. */
function drawWhoPays(p: Page, payers: InvoicePdfShare[]): void {
  const width = contentWidth(p) - Q_TOTALS_WIDTH - 24;
  drawSectionTitle(p, 'WHO PAYS FOR THIS DELIVERY', '', width);
  const bold = (row: string[], extra: Partial<Styles> = {}): Row => row.map((content) => ({ content, styles: { fontStyle: 'bold', ...extra } }));
  const body: Row[] = payers.map((s) => {
    const mine = s.invoice_number === p.data.invoice_number;
    const row = [mine ? `${s.customer_name} (this invoice)` : s.customer_name, s.invoice_number ?? '', fmtShare(s.split_percentage), fmt(s.amount_cents)];
    return mine ? bold(row) : row;
  });
  const pct = Math.round(payers.reduce((sum, s) => sum + s.split_percentage, 0) * 10000) / 10000;
  const cents = payers.reduce((sum, s) => sum + s.amount_cents, 0);
  body.push(bold(['Delivery total', '', fmtShare(pct), fmt(cents)], { lineWidth: 0 }));
  drawTable(p, ['Payer', 'Invoice', 'Share', 'Amount'], body, { 0: { cellWidth: 'auto' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
    { left: Q_MARGIN_X, right: p.pageW - Q_MARGIN_X - width });
}

/** "Please pay by <due date>." and how to pay, while anything is owed. */
function drawPayNote(p: Page, company: CompanyInfo): void {
  if (p.data.balance_cents <= 0) return;
  const lead = p.data.due_date ? `Please pay by ${fmtDate(p.data.due_date)}.` : 'Payment is due on receipt.';
  p.y += 16;
  drawBoxedNote(p, `Make checks payable to ${company.name} and write the invoice number on the check.`, lead);
}

// ── Download ─────────────────────────────────────────────────────────────
