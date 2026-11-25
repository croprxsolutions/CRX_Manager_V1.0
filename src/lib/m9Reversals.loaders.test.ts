/** M9 loaders against an in-memory PostgREST: which checks the returned-check picker lists, and how. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInMemoryQuery } from '../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));
vi.mock('./db', async () => {
  const actual = await vi.importActual<typeof import('./db')>('./db');
  return { ...actual, supabase: { from: (t: string) => buildInMemoryQuery(H.tables[t] ?? []) } };
});

import { loadReturnableCheck, loadReturnableChecks } from './m9Reversals';

const set = (id: string, method: string, date: string, cents: number, extra: Row = {}) => ({
  id, customer_id: 'c1', entity_type: 'payment', payment_method: method, is_active: true, payment_date: date,
  total_payment_cents: cents, check_number: id.replace('s-', ''), reference_number: null, ...extra,
});
const pm = (id: string, ref: string, orig: number, bal: number, label = 'General') => ({
  id, customer_id: 'c1', source_type: 'check', allocation_set_id: null, original_amount_cents: orig, balance_cents: bal,
  bucket_label: label, reference_number: ref, source_reference: ref, created_at: '2026-10-14T15:00:00Z',
});

beforeEach(() => {
  H.tables = {
    allocation_sets: [
      set('s-6107', 'check', '2026-09-15', 170000), set('s-ach', 'ach', '2026-11-12', 240000),
      set('s-old', 'check', '2025-10-01', 10000), set('s-6311', 'check', '2026-11-10', 90000),
    ],
    invoice_line_allocations: [{ id: 'a1', allocation_set_id: 's-6107', invoice_id: 'i1', amount_cents: 120000, invoices: { invoice_number: 'INV-20290' } }],
    prepay_credits: [
      { id: 'o1', customer_id: 'c1', source_type: 'overpayment', allocation_set_id: 's-6107', original_amount_cents: 50000, balance_cents: 30000, bucket_label: 'Fall 2026 prepay' },
      pm('b1', '5870', 60000, 60000, 'Summer'), pm('b2', '5870', 40000, 40000, 'Seed'),
      pm('d1', '6102', 0, 0), pm('r1', '6230', 40000, 0),
    ],
    financial_audit_log: [
      { id: 'f1', operation_type: 'prepay_credit_created', entity_id: 'c1', new_values: { credit_ids: ['b1', 'b2'], total_cents: 100000 } },
      { id: 'f2', operation_type: 'prepay_credit_created', entity_id: 'c1', new_values: { credit_ids: ['d1'], total_cents: 25000 } },
      { id: 'f3', operation_type: 'prepay_credit_created', entity_id: 'c1', new_values: { credit_ids: ['r1'], total_cents: 40000 } },
    ],
    accounting_periods: [{ id: 'p9', period_start: '2026-09-01', period_end: '2026-09-30', status: 'closed' }],
    money_reversals: [{ id: 'm1', customer_id: 'c1', kind: 'returned_check', entry_date: '2026-11-03', allocation_set_id: null, prepay_credit_id: 'r1' }],
    money_reversal_lines: [],
  };
});

describe('loadReturnableChecks', () => {
  it('lists checks of the last 12 months: payments, a bucket-split check as one row, a returned one disabled; a deleted one is not listed', async () => {
    const list = await loadReturnableChecks('c1', '2026-11-23');
    expect(list.map((c) => c.number)).toEqual(['6311', '6230', '5870', '6107']);
    const c6107 = list.find((c) => c.number === '6107')!;
    expect(c6107).toMatchObject({ amountCents: 170000, closedMonth: true, disabledReason: null, meta: 'Paid INV-20290 $1,200.00 · created Fall 2026 prepay $500.00' });
    expect(list.find((c) => c.number === '5870')).toMatchObject({ amountCents: 100000, prepayCheck: true, creditId: 'b1', disabledReason: null,
      meta: '2 prepay buckets: Summer $600.00 · Seed $400.00 (returns all)' });
    expect(list.find((c) => c.number === '6230')?.disabledReason).toBe('Already returned Nov 3');
  });

  it('a payment opened from its own line is found at any age', async () => {
    expect((await loadReturnableCheck('c1', 's-old'))?.number).toBe('old');
  });
});

describe('loadPrepayHistory', () => {
  it('shows a hand edit and a delete as their own rows, from what was first received (Sol r1 H4)', async () => {
    const { loadPrepayHistory } = await import('./m9Reversals');
    H.tables = {
      prepay_credits: [
        { id: 'k1', customer_id: 'c1', original_amount_cents: 8000, balance_cents: 8000, source_type: 'check', source_reference: 'A1', bucket_label: 'Spring', created_at: '2026-10-01T15:00:00Z', created_by: 'u1' },
        { id: 'k2', customer_id: 'c1', original_amount_cents: 0, balance_cents: 0, source_type: 'check', source_reference: 'B2', bucket_label: 'Fall', created_at: '2026-10-02T15:00:00Z', created_by: 'u1' },
      ],
      money_reversals: [], prepay_applications: [], money_reversal_lines: [],
      financial_audit_log: [
        { id: 'e1', operation_type: 'prepay_edited', entity_id: 'k1', actor_user_id: 'u1', created_at: '2026-10-05T15:00:00Z',
          old_values: { original_amount_cents: 10000 }, new_values: { original_amount_cents: 8000 } },
        { id: 'e2', operation_type: 'prepay_deleted', entity_id: 'k2', actor_user_id: 'u1', created_at: '2026-10-06T15:00:00Z',
          old_values: { total_cents: 5000, reference_number: 'B2', buckets: [{ id: 'k2', original_amount_cents: 5000 }] },
          new_values: { whole_check: true, credit_ids: ['k2'], original_amount_cents: 0, reason: 'typed twice' } },
      ],
      profiles: [{ id: 'u1', full_name: 'Test Admin' }],
    };
    const rows = await loadPrepayHistory('c1');
    expect(rows.map((r) => [r.what, r.cents, r.afterCents])).toEqual([
      ['Prepayment check deleted', -5000, 8000],
      ['Credit edited by hand', -2000, 13000],
      ['Prepay received', 5000, 15000],
      ['Prepay received', 10000, 10000],
    ]);
  });
});
