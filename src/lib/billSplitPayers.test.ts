import { describe, it, expect } from 'vitest';
import { billSplitPayerShares, buildInvoicePdfDataFromRow } from '../../supabase/functions/_shared/pdf/invoicePdf.ts';

const row = (id: string, name: string | null, cents: number) => ({
  id, invoice_number: `CS-2026-0412-${id}`, total_amount_cents: cents, customer: name ? { farm_name: name } : null,
});

describe('billSplitPayerShares', () => {
  it('gives each payer their share of the whole sale', () => {
    const payers = billSplitPayerShares([row('1', 'Farmer', 6000), row('2', 'Landlord', 4000)]);
    expect(payers.map((p) => [p.customer_name, p.invoice_number, p.split_percentage, p.amount_cents])).toEqual([
      ['Farmer', 'CS-2026-0412-1', 60, 6000],
      ['Landlord', 'CS-2026-0412-2', 40, 4000],
    ]);
  });

  it('shows three-way shares to four places, adding back to the sale', () => {
    const payers = billSplitPayerShares([row('1', 'A', 3334), row('2', 'B', 3333), row('3', 'C', 3333)]);
    expect(payers.map((p) => p.split_percentage)).toEqual([33.34, 33.33, 33.33]);
    expect(payers.reduce((s, p) => s + p.amount_cents, 0)).toBe(10000);
  });

  it('does not divide by zero on an all-$0 sale, and names a missing customer', () => {
    expect(billSplitPayerShares([row('1', null, 0)])[0]).toMatchObject({ customer_name: 'Unknown', split_percentage: 0 });
  });
});

// A chainable read that resolves to `result` whatever filters are applied.
function read(result: unknown) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'not', 'order']) q[m] = () => q;
  q.maybeSingle = () => Promise.resolve(result);
  q.then = (done: (v: unknown) => unknown) => Promise.resolve(result).then(done);
  return q;
}

function db(tables: Record<string, unknown>) {
  return { from: (t: string) => read(tables[t] ?? { data: [], error: null }) };
}

const inv = { id: 'i1', invoice_number: 'CS-2026-0412-2', invoice_type: 'chemical_sale', customer_id: 'c2', farm_name: 'Landlord', total_amount_cents: 0 };
const base = (groupId: string | null, payers: unknown) => ({
  customers: { data: {}, error: null },
  invoice_shares: { data: [], error: null },
  // The billing re-fetch and the payers read share a table: the mock answers the row for both.
  invoices: { data: payers ?? { invoice_group_id: groupId }, error: null },
});

describe('buildInvoicePdfDataFromRow on a Bill Split invoice', () => {
  it('prints no payer table on an invoice with no split group', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await buildInvoicePdfDataFromRow(db(base(null, null)) as any, inv as any);
    expect(data.shares).toBeUndefined();
  });

  it('stops the print when the payers cannot be read, rather than leaving the table out', async () => {
    const client = {
      from: (t: string) => {
        if (t !== 'invoices') return read({ data: t === 'customers' ? {} : [], error: null });
        const q = read({ data: null, error: new Error('down') });
        q.maybeSingle = () => Promise.resolve({ data: { invoice_group_id: 'g1' }, error: null });
        return q;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(buildInvoicePdfDataFromRow(client as any, inv as any)).rejects.toThrow('Could not load the invoice details');
  });

  it('prints the whole sale\'s payers on each payer\'s invoice', async () => {
    const client = {
      from: (t: string) => {
        if (t !== 'invoices') return read({ data: t === 'customers' ? {} : [], error: null });
        const q = read({ data: [row('1', 'Farmer', 6000), row('2', 'Landlord', 4000)], error: null });
        q.maybeSingle = () => Promise.resolve({ data: { invoice_group_id: 'g1' }, error: null });
        return q;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await buildInvoicePdfDataFromRow(client as any, inv as any);
    expect(data.shares?.map((s) => [s.customer_name, s.split_percentage, s.amount_cents])).toEqual([
      ['Farmer', 60, 6000],
      ['Landlord', 40, 4000],
    ]);
  });
});
