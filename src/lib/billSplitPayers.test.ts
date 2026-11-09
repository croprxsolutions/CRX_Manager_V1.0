import { describe, it, expect } from 'vitest';
import { billSplitCompletion } from './billSplitCompletion';
import { billSplitPayerShares, buildInvoicePdfDataFromRow, isBillSplitInvoice, loadBillSplitPayers } from '../../supabase/functions/_shared/pdf/invoicePdf.ts';

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

  it('gives the extra hundredths to the first payers when remainders tie exactly (whole-number maths)', () => {
    // 1c, 1c, 4c of 6c: each remainder is exactly 4/6 of a hundredth; float maths gave the third payer one.
    const payers = billSplitPayerShares([row('1', 'A', 1), row('2', 'B', 1), row('3', 'C', 4)]);
    expect(payers.map((p) => p.split_percentage)).toEqual([16.67, 16.67, 66.66]);
  });

  it('equal payers print to two places and still add up to 100%', () => {
    // 100 / 300 each is 33.3333...; printed at two places that was 99.99%.
    const payers = billSplitPayerShares([row('1', 'A', 100), row('2', 'B', 100), row('3', 'C', 100)]);
    expect(payers.map((p) => p.split_percentage)).toEqual([33.34, 33.33, 33.33]);
    expect(payers.reduce((s, p) => s + Math.round(p.split_percentage * 100), 0)).toBe(10000);
  });

  it('lists payers in number order, so -10 comes after -2', () => {
    const payers = billSplitPayerShares([row('10', 'J', 100), row('2', 'B', 100), row('1', 'A', 100)]);
    expect(payers.map((p) => p.invoice_number)).toEqual(['CS-2026-0412-1', 'CS-2026-0412-2', 'CS-2026-0412-10']);
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

  it('prints no payer table on a field split, whose invoices have a group but no delivery', async () => {
    const client = {
      from: (t: string) => {
        if (t !== 'invoices') return read({ data: t === 'customers' ? {} : [], error: null });
        const q = read({ data: [row('1', 'Farmer', 6000), row('2', 'Landlord', 4000)], error: null, count: 2 });
        q.maybeSingle = () => Promise.resolve({ data: { invoice_group_id: 'g1', delivery_id: null }, error: null });
        return q;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await buildInvoicePdfDataFromRow(client as any, inv as any);
    expect(data.shares).toBeUndefined();
  });

  it('stops the print when the payers cannot be read, rather than leaving the table out', async () => {
    const client = {
      from: (t: string) => {
        if (t !== 'invoices') return read({ data: t === 'customers' ? {} : [], error: null });
        const q = read({ data: [], error: null });
        q.maybeSingle = () => Promise.resolve({ data: { invoice_group_id: 'g1', delivery_id: 'd1' }, error: null });
        return q;
      },
      rpc: () => Promise.resolve({ data: null, error: new Error('down'), count: null }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(buildInvoicePdfDataFromRow(client as any, inv as any)).rejects.toThrow('Could not load the invoice details');
  });

  it('prints the whole sale\'s payers on each payer\'s invoice', async () => {
    const client = {
      from: (t: string) => {
        if (t !== 'invoices') return read({ data: t === 'customers' ? {} : [], error: null });
        const q = read({ data: [], error: null });
        q.maybeSingle = () => Promise.resolve({ data: { invoice_group_id: 'g1', delivery_id: 'd1' }, error: null });
        return q;
      },
      rpc: (fn: string) => Promise.resolve(fn === 'get_bill_split_payers'
        ? { data: [{ id: '1', invoice_number: 'CS-2026-0412-1', total_amount_cents: 6000, farm_name: 'Farmer' },
                   { id: '2', invoice_number: 'CS-2026-0412-2', total_amount_cents: 4000, farm_name: 'Landlord' }], error: null, count: 2 }
        : { data: null, error: new Error(`unexpected ${fn}`) }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await buildInvoicePdfDataFromRow(client as any, inv as any);
    expect(data.shares?.map((s) => [s.customer_name, s.split_percentage, s.amount_cents])).toEqual([
      ['Farmer', 60, 6000],
      ['Landlord', 40, 4000],
    ]);
  });
});

describe('isBillSplitInvoice', () => {
  it('is a chemical sale in a group, from a delivery', () => {
    expect(isBillSplitInvoice({ invoice_type: 'chemical_sale', invoice_group_id: 'g1', delivery_id: 'd1' })).toBe(true);
    expect(isBillSplitInvoice({ invoice_type: 'chemical_sale', invoice_group_id: 'g1', delivery_id: null })).toBe(false);
    expect(isBillSplitInvoice({ invoice_type: 'chemical_sale', invoice_group_id: null, delivery_id: 'd1' })).toBe(false);
    expect(isBillSplitInvoice({ invoice_type: 'field_application', invoice_group_id: 'g1', delivery_id: 'd1' })).toBe(false);
    // A payer's draft may switch to misc charge (guard_invoice_terminal_order); the payer table stays.
    expect(isBillSplitInvoice({ invoice_type: 'misc_charge', invoice_group_id: 'g1', delivery_id: 'd1' })).toBe(true);
    expect(isBillSplitInvoice({ invoice_type: 'misc_charge', invoice_group_id: 'g1', delivery_id: null })).toBe(false);
  });
});

describe('billSplitCompletion', () => {
  it('reads what the delivery completion says about its split', () => {
    expect(billSplitCompletion({ bill_split_failed: true, bill_split_invoices: null })).toEqual({ failed: true, numbers: [] });
    expect(billSplitCompletion({ bill_split_failed: false, bill_split_invoices: [{ invoice_id: 'a', invoice_number: 'CS-1-1' }, { invoice_id: 'b', invoice_number: 'CS-1-2' }] }))
      .toEqual({ failed: false, numbers: ['CS-1-1', 'CS-1-2'] });
    expect(billSplitCompletion(null)).toEqual({ failed: false, numbers: [] });
  });
});

describe('loadBillSplitPayers', () => {
  // The sale's payers come from get_bill_split_payers for the invoice the user opened, so a rep who can't
  // see another payer's invoice still gets the whole table (Sol HIGH on a6aaa21f2).
  const flat = (id: string, name: string, cents: number) => ({ id, invoice_number: `CS-2026-0412-${id}`, total_amount_cents: cents, farm_name: name });
  const db = (data: unknown[] | null, count: number | null, error: unknown = null) => {
    const calls: unknown[][] = [];
    return { calls, client: { rpc: (...a: unknown[]) => { calls.push(a); return Promise.resolve({ data, error, count }); } } as never };
  };
  it('reads every payer of the sale through get_bill_split_payers, for the invoice opened', async () => {
    const { calls, client } = db([flat('1', 'Farmer', 6000), flat('2', 'Landlord', 4000)], 2);
    const payers = await loadBillSplitPayers(client, 'inv-1');
    expect(calls[0].slice(0, 2)).toEqual(['get_bill_split_payers', { p_invoice_id: 'inv-1' }]);
    expect(payers.map((p) => [p.customer_name, p.split_percentage, p.amount_cents])).toEqual([['Farmer', 60, 6000], ['Landlord', 40, 4000]]);
  });
  it('refuses a read that came back short of the count, rather than print a partial payer table', async () => {
    await expect(loadBillSplitPayers(db([flat('1', 'Farmer', 6000)], 2).client, 'inv-1')).rejects.toThrow();
  });
  it('refuses when the read fails', async () => {
    await expect(loadBillSplitPayers(db(null, null, new Error('INVOICE_NOT_VISIBLE')).client, 'inv-1')).rejects.toThrow();
  });
});
