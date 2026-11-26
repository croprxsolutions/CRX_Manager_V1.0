import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase, supabaseUntyped } from './db';
import {
  activeInvoiceCoversDelivery,
  activeInvoiceCoversOrder,
  activeInvoiceCountsTowardBilling,
  fetchActiveInvoiceCoveragePages,
  fetchDeliveryBillingRemainders,
  unbilledRemainderLabel,
  type ActiveInvoiceCoverageRow,
  type DeliveryInvoiceCoverage,
} from './deliveryInvoiceCoverage';

vi.mock('./db', () => ({
  supabase: { from: vi.fn() },
  supabaseUntyped: { from: vi.fn() },
}));

const root = process.cwd();

function invoice(overrides: Partial<DeliveryInvoiceCoverage> = {}): DeliveryInvoiceCoverage {
  return {
    order_id: 'order-1',
    delivery_id: null,
    invoice_type: 'chemical_sale',
    status: 'posted',
    deleted_at: null,
    ...overrides,
  };
}

function coverageRow(id: string, orderId: string): ActiveInvoiceCoverageRow {
  return {
    id,
    order_id: orderId,
    delivery_id: null,
    total_amount_cents: 100,
    invoice_type: 'chemical_sale',
    status: 'posted',
    deleted_at: null,
  };
}

function queryReturning(data: ActiveInvoiceCoverageRow[]) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'in', 'not', 'is', 'order']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.range = vi.fn(() => Promise.resolve({ data, error: null }));
  return chain;
}

describe('activeInvoiceCoversDelivery', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
  });

  it('chunks large order filters and paginates each chunk without duplicate ids', async () => {
    const orderIds = Array.from({ length: 201 }, (_, index) => `order-${index}`);
    const queryResults = [
      [coverageRow('invoice-1', 'order-0')],
      [],
      [coverageRow('invoice-2', 'order-200')],
      [],
    ];
    const queries = queryResults.map(queryReturning);
    const pendingQueries = [...queries];
    vi.mocked(supabase.from).mockImplementation(() => pendingQueries.shift() as never);

    const result = await fetchActiveInvoiceCoveragePages([...orderIds, 'order-0']);

    expect(result).toEqual({
      data: [coverageRow('invoice-1', 'order-0'), coverageRow('invoice-2', 'order-200')],
      error: null,
    });
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(4);
    expect(pendingQueries).toHaveLength(0);
    expect(queries[0].in).toHaveBeenCalledWith('order_id', orderIds.slice(0, 200));
    expect(queries[2].in).toHaveBeenCalledWith('order_id', orderIds.slice(200));
    expect(queries[0].range).toHaveBeenCalledWith(0, 999);
    expect(queries[1].range).toHaveBeenCalledWith(1, 1000);
    expect(queries[2].range).toHaveBeenCalledWith(0, 999);
    expect(queries[3].range).toHaveBeenCalledWith(1, 1000);
  });

  it('fails a page that answers with no list instead of reading it as "no invoices" (To-Do 10.5)', async () => {
    const query = queryReturning([]);
    query.range = vi.fn(() => Promise.resolve({ data: null, error: null }));
    vi.mocked(supabase.from).mockImplementation(() => query as never);

    const result = await fetchActiveInvoiceCoveragePages(['order-1']);

    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
  });

  it('keeps order billing coverage limited to active sale invoices', () => {
    expect(activeInvoiceCountsTowardBilling(invoice())).toBe(true);
    expect(activeInvoiceCountsTowardBilling(invoice({ invoice_type: 'credit_memo' }))).toBe(false);
    expect(activeInvoiceCoversOrder(invoice(), 'order-1')).toBe(true);
    expect(activeInvoiceCoversOrder(invoice({ invoice_type: 'credit_memo' }), 'order-1')).toBe(false);
    expect(activeInvoiceCoversOrder(invoice({ status: 'voided' }), 'order-1')).toBe(false);
    expect(activeInvoiceCoversOrder(invoice({ status: 'cancelled' }), 'order-1')).toBe(false);
    expect(activeInvoiceCoversOrder(
      invoice({ deleted_at: '2026-08-26T12:00:00Z' }),
      'order-1',
    )).toBe(false);
    expect(activeInvoiceCoversOrder(invoice(), 'order-2')).toBe(false);
  });

  it('does not let an active order-level return credit hide an unbilled delivery', () => {
    expect(activeInvoiceCoversDelivery(
      invoice({ invoice_type: 'credit_memo' }),
      'delivery-2',
      'order-1',
    )).toBe(false);
  });

  it('accepts active sale coverage for the same delivery or its whole order', () => {
    expect(activeInvoiceCoversDelivery(invoice(), 'delivery-2', 'order-1')).toBe(true);
    expect(activeInvoiceCoversDelivery(
      invoice({ delivery_id: 'delivery-2' }),
      'delivery-2',
      'order-1',
    )).toBe(true);
  });

  it('rejects sibling-delivery, other-order, voided, cancelled, and soft-deleted invoices', () => {
    expect(activeInvoiceCoversDelivery(
      invoice({ delivery_id: 'delivery-1' }),
      'delivery-2',
      'order-1',
    )).toBe(false);
    expect(activeInvoiceCoversDelivery(invoice(), 'delivery-2', 'order-2')).toBe(false);
    expect(activeInvoiceCoversDelivery(invoice({ status: 'voided' }), 'delivery-2', 'order-1')).toBe(false);
    expect(activeInvoiceCoversDelivery(invoice({ status: 'cancelled' }), 'delivery-2', 'order-1')).toBe(false);
    expect(activeInvoiceCoversDelivery(
      invoice({ deleted_at: '2026-08-26T12:00:00Z' }),
      'delivery-2',
      'order-1',
    )).toBe(false);
  });

  it('is used by every UI that reports or recovers unbilled deliveries', () => {
    // Deliberate wiring guard: behavior tests above prove the predicate itself;
    // this check prevents any consumer from silently copying an older local
    // predicate that lets credit memos hide unbilled deliveries.
    for (const relativePath of [
      'src/components/integrity/IntegrityCleanupPanel.tsx',
      'src/pages/DeliveryDetail.tsx',
      'src/pages/OfficeCockpit.tsx',
    ]) {
      const source = readFileSync(resolve(root, relativePath), 'utf8');
      expect(source).toContain('activeInvoiceCoversDelivery');
    }
    const sharedSource = readFileSync(resolve(root, 'src/lib/deliveryInvoiceCoverage.ts'), 'utf8');
    expect(sharedSource).toContain('invoice_type');
    expect(sharedSource).toContain('fetchActiveInvoiceCoveragePages');
  });

  it('is used by every order UI that reports or recovers billing coverage', () => {
    const orderDetail = readFileSync(resolve(root, 'src/pages/OrderDetail.tsx'), 'utf8');
    expect(orderDetail).toContain("activeInvoiceCoversOrder(inv, order?.id ?? '')");

    // The Orders list computes invoiced % in get_orders_page, with the same active-invoice rule.
    const orders = readFileSync(resolve(root, 'src/pages/Orders.tsx'), 'utf8');
    expect(orders).toContain('fetchOrdersPage(query, ORDERS_PAGE_SIZE, 0, after)');
    const ordersPageSql = readFileSync(resolve(root, 'supabase/migrations/20261116120000_orders_list_page.sql'), 'utf8');
    expect(ordersPageSql).toContain("i.status NOT IN ('voided', 'cancelled')");
    expect(ordersPageSql).toContain('i.deleted_at IS NULL');
    expect(ordersPageSql).toContain("i.invoice_type IS DISTINCT FROM 'credit_memo'");

    const integrityCleanup = readFileSync(resolve(root, 'src/components/integrity/IntegrityCleanupPanel.tsx'), 'utf8');
    expect(integrityCleanup).toContain('fetchActiveInvoiceCoveragePages(orderIds)');
    expect(integrityCleanup).toContain('Failed to verify invoice coverage. Unbilled delivery results are hidden');
    expect(integrityCleanup).toContain('setInvoiceCoverageFailed(true)');
    expect(integrityCleanup).toContain('Could not verify invoice coverage — refresh to try again.');

    const sharedSource = readFileSync(resolve(root, 'src/lib/deliveryInvoiceCoverage.ts'), 'utf8');
    expect(sharedSource).toContain(".select('id, order_id, delivery_id, total_amount_cents, invoice_type, status, deleted_at')");
    expect(sharedSource).toContain('chunkIds(uniqueOrderIds, INVOICE_COVERAGE_ID_CHUNK_SIZE)');
    expect(sharedSource).toContain(".not('status', 'in', '(\"voided\",\"cancelled\")')");
    expect(sharedSource).toContain(".is('deleted_at', null)");
    expect(sharedSource).toContain('.range(from, from + INVOICE_COVERAGE_PAGE_SIZE - 1)');
    expect(sharedSource).toContain('if (page.length === 0)');
    expect(sharedSource).toContain('from += page.length');
  });

  describe('fetchDeliveryBillingRemainders (A4)', () => {
    function remainderQuery(result: { data: unknown[] | null; error: unknown }) {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'in', 'gt', 'order']) q[m] = vi.fn(() => q);
      q.range = vi.fn(async (from: number) => (from > 0 && result.data ? { data: [], error: null } : result));
      return q;
    }

    it('sums the short lines per delivery and labels the rest', async () => {
      const q = remainderQuery({
        data: [
          { delivery_id: 'd1', delivered_qty: 10, unbilled_qty: 4, unbilled_cents: 16000 },
          { delivery_id: 'd2', delivered_qty: 3, unbilled_qty: 1.5, unbilled_cents: 501 },
          { delivery_id: 'd2', delivered_qty: 2, unbilled_qty: 2, unbilled_cents: 1000 },
        ],
        error: null,
      });
      vi.mocked(supabaseUntyped.from).mockReturnValue(q as never);
      const { data, error } = await fetchDeliveryBillingRemainders(['d1', 'd2', 'd1']);
      expect(error).toBeNull();
      expect(supabaseUntyped.from).toHaveBeenCalledWith('delivery_billing_remainders');
      expect(q.in).toHaveBeenCalledWith('delivery_id', ['d1', 'd2']);
      expect(q.gt).toHaveBeenCalledWith('unbilled_qty', 0);
      expect(data?.get('d1')).toEqual({ deliveredQty: 10, unbilledQty: 4, unbilledCents: 16000 });
      expect(unbilledRemainderLabel(data!.get('d1')!)).toBe('4 of 10 not billed ($160.00)');
      expect(unbilledRemainderLabel(data!.get('d2')!)).toBe('3.5 of 5 not billed ($15.01)');
    });

    it('fails the read instead of reporting nothing unbilled', async () => {
      vi.mocked(supabaseUntyped.from).mockReturnValue(remainderQuery({ data: null, error: null }) as never);
      const { data, error } = await fetchDeliveryBillingRemainders(['d1']);
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });
});
