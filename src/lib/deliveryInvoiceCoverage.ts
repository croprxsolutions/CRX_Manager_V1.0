import { supabase, supabaseUntyped } from './db';
import { formatCents } from './money';
import { chunkIds } from './dispatchDisplay';
import { PAGE_RETURNED_NO_LIST } from './pagedRead';

export interface InvoiceBillingCoverage {
  order_id: string | null;
  invoice_type: string;
  status: string;
  deleted_at: string | null;
}

export interface DeliveryInvoiceCoverage extends InvoiceBillingCoverage {
  delivery_id: string | null;
}

export interface ActiveInvoiceCoverageRow extends DeliveryInvoiceCoverage {
  id: string;
  total_amount_cents: number;
}

const INVOICE_COVERAGE_PAGE_SIZE = 1000;
const INVOICE_COVERAGE_ID_CHUNK_SIZE = 200;

/**
 * Fetch every active invoice row for a set of orders without trusting the
 * gateway URL limit or PostgREST server row cap. Order ids are de-duplicated
 * and chunked before each paginated query. Advancing by the rows actually
 * returned also keeps the loop complete when a deployment uses a cap below
 * our requested size.
 */
export async function fetchActiveInvoiceCoveragePages(orderIds: string[]) {
  const rows: ActiveInvoiceCoverageRow[] = [];
  if (orderIds.length === 0) return { data: rows, error: null };

  const uniqueOrderIds = [...new Set(orderIds)];
  for (const orderIdChunk of chunkIds(uniqueOrderIds, INVOICE_COVERAGE_ID_CHUNK_SIZE)) {
    for (let from = 0; ;) {
      const { data, error } = await supabase
        .from('invoices')
        .select('id, order_id, delivery_id, total_amount_cents, invoice_type, status, deleted_at')
        .in('order_id', orderIdChunk)
        .not('status', 'in', '("voided","cancelled")')
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(from, from + INVOICE_COVERAGE_PAGE_SIZE - 1);

      if (error) return { data: null, error };
      // A page with no list is a failed read, not "no invoices": callers would show
      // every order as 0% invoiced or every delivery as unbilled (To-Do 10.5).
      if (!data) return { data: null, error: { message: PAGE_RETURNED_NO_LIST } };
      const page = data as ActiveInvoiceCoverageRow[];
      if (page.length === 0) break;
      rows.push(...page);
      from += page.length;
    }
  }

  return { data: rows, error: null };
}

const NON_COVERING_STATUSES = new Set(['voided', 'cancelled']);

export function activeInvoiceCountsTowardBilling(
  invoice: InvoiceBillingCoverage,
): boolean {
  return invoice.invoice_type !== 'credit_memo'
    && !NON_COVERING_STATUSES.has(invoice.status)
    && invoice.deleted_at === null;
}

/**
 * A return credit changes AR; it does not prove that the sale was billed.
 * Keep every order-level billing surface on the same active-sale predicate.
 */
export function activeInvoiceCoversOrder(
  invoice: InvoiceBillingCoverage,
  orderId: string,
): boolean {
  return invoice.order_id === orderId
    && activeInvoiceCountsTowardBilling(invoice);
}

/**
 * Mirrors the server-side delivery invoice guards. Credit memos reverse a sale;
 * they never prove that a delivery was billed.
 */
export function activeInvoiceCoversDelivery(
  invoice: DeliveryInvoiceCoverage,
  deliveryId: string,
  orderId: string,
): boolean {
  return activeInvoiceCoversOrder(invoice, orderId)
    && (invoice.delivery_id === deliveryId || invoice.delivery_id === null);
}

export interface DeliveryBillingRemainder {
  /** Units delivered on the lines that are not fully billed. */
  deliveredQty: number;
  unbilledQty: number;
  /** What Create Invoice would draft for those units. */
  unbilledCents: number;
}

/**
 * A4: completed deliveries an active invoice bills only in part (delivery_billing_remainders: delivered vs billed
 * units per order line; whole-order invoices count too). Returns only deliveries with units still unbilled, summed
 * over their short lines. Such a delivery stays on Unbilled even though an invoice covers it.
 */
export async function fetchDeliveryBillingRemainders(deliveryIds: string[]) {
  const remainders = new Map<string, DeliveryBillingRemainder>();
  for (const idChunk of chunkIds([...new Set(deliveryIds)], INVOICE_COVERAGE_ID_CHUNK_SIZE)) {
    // Paged by the rows returned, like the invoice read above: a server row cap must not drop short lines.
    for (let from = 0; ;) {
      const { data, error } = await supabaseUntyped
        .from('delivery_billing_remainders')
        .select('delivery_id, order_item_id, product_id, delivered_qty, unbilled_qty, unbilled_cents')
        .in('delivery_id', idChunk)
        .gt('unbilled_qty', 0)
        .order('delivery_id', { ascending: true })
        .order('order_item_id', { ascending: true })
        .order('product_id', { ascending: true })
        .range(from, from + INVOICE_COVERAGE_PAGE_SIZE - 1);
      if (error) return { data: null, error };
      if (!data) return { data: null, error: { message: PAGE_RETURNED_NO_LIST } };
      const page = data as Array<{ delivery_id: string; delivered_qty: number; unbilled_qty: number; unbilled_cents: number }>;
      if (page.length === 0) break;
      for (const row of page) {
        const sum = remainders.get(row.delivery_id) ?? { deliveredQty: 0, unbilledQty: 0, unbilledCents: 0 };
        sum.deliveredQty += Number(row.delivered_qty);
        sum.unbilledQty += Number(row.unbilled_qty);
        sum.unbilledCents += Number(row.unbilled_cents);
        remainders.set(row.delivery_id, sum);
      }
      from += page.length;
    }
  }
  return { data: remainders, error: null };
}

const qty = (n: number) => String(Number(n.toFixed(4)));

/** "4 of 10 not billed ($160.00)" */
export function unbilledRemainderLabel(r: DeliveryBillingRemainder): string {
  return `${qty(r.unbilledQty)} of ${qty(r.deliveredQty)} not billed (${formatCents(r.unbilledCents)})`;
}
