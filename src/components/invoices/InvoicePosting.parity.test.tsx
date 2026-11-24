/**
 * InvoicePosting.parity.test.tsx — the one-invoice-list project must not change what gets posted.
 *
 * The chemical list and the field Drafts tab now share one tick-and-post bar. These tests pin
 * the exact RPC calls (name, arguments, order) each screen sends for the same rows, so the
 * presentation change is proven not to touch the posting rules:
 *   - chemical: stand-alone rows post through post_invoice with their loaded version; a ticked
 *     split member posts its whole group once through post_invoice_group with every loaded
 *     member's version.
 *   - field Drafts: only this season's stand-alone invoices can post here, one post_invoice each,
 *     in list order, with the version loaded with the row. Split groups and other-season invoices
 *     are never posted from this tab (post_invoice_group is never called).
 * Idempotency keys carry a random suffix; the stable part (operation:user:scope) is compared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../../test-utils/inMemoryQuery';

const H = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), toast: vi.fn() }));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return { ...actual, supabase: { from: (table: string) => H.from(table === 'invoices_postable' ? 'invoices' : table), rpc: H.rpc } };
});
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import Invoices from '../../pages/Invoices';
import FieldInvoicesUnpostedPanel from '../field-invoices/FieldInvoicesUnpostedPanel';

const rpcSucceeds = () => {
  const result = Promise.resolve({ data: 1, error: null });
  return Object.assign(result, { throwOnError: () => result });
};

/** Every RPC call, with the random tail of each idempotency key dropped. */
const rpcCalls = () => H.rpc.mock.calls.map(([name, args]) => {
  const { p_idempotency_key: key, ...rest } = args as Record<string, unknown>;
  return [name, { ...rest, p_idempotency_key: String(key).split(':').slice(0, -1).join(':') }];
});

const rowOf = (number: string) => screen.getAllByText(number).map((el) => el.closest('tr')).find(Boolean)!;

describe('chemical invoices: the same rows post with the same RPC arguments', () => {
  function chem(overrides: Record<string, unknown>) {
    return {
      id: overrides.invoice_number,
      invoice_post_version: `v1:${String(overrides.invoice_number)}`,
      invoice_type: 'chemical_sale',
      customer_id: 'cust-1',
      customer: { farm_name: 'Maple Hollow Farms' },
      salesman_id: null,
      order_id: null,
      invoice_group_id: null,
      deleted_at: null,
      total_amount_cents: 10000,
      balance_cents: 10000,
      is_quick_delivery: false,
      season: 2027,
      invoice_date: '2026-10-06',
      due_date: '2026-11-05',
      ...overrides,
    };
  }
  const ROWS = [
    chem({ invoice_number: 'CS-A', status: 'draft', created_at: '2026-10-06T15:00:05+00:00' }),
    chem({ invoice_number: 'CS-B', status: 'unposted', created_at: '2026-10-06T15:00:04+00:00' }),
    chem({ invoice_number: 'CS-POSTED', status: 'posted', created_at: '2026-10-06T15:00:03+00:00' }),
    chem({ invoice_number: 'CS-SPLIT-1', status: 'draft', invoice_group_id: 'grp-1', created_at: '2026-10-06T15:00:02+00:00' }),
    chem({ invoice_number: 'CS-SPLIT-2', status: 'draft', invoice_group_id: 'grp-1', created_at: '2026-10-06T15:00:01+00:00' }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00'));
    H.from.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? ROWS : []));
    H.rpc.mockImplementation(rpcSucceeds);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('ticked drafts and one split member post exactly as before', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('CS-A').length).toBeGreaterThan(0));

    for (const n of ['CS-A', 'CS-B', 'CS-SPLIT-1']) fireEvent.click(within(rowOf(n)).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Post 4 invoices…' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Post 4 invoices' }));

    await waitFor(() => expect(H.rpc).toHaveBeenCalledTimes(3));
    expect(rpcCalls()).toEqual([
      ['post_invoice', { p_invoice_id: 'CS-A', p_expected_version: 'v1:CS-A', p_idempotency_key: 'post_invoice:user-1:CS-A' }],
      ['post_invoice', { p_invoice_id: 'CS-B', p_expected_version: 'v1:CS-B', p_idempotency_key: 'post_invoice:user-1:CS-B' }],
      ['post_invoice_group', {
        p_invoice_group_id: 'grp-1',
        p_performed_by: 'user-1',
        p_expected_versions: { 'CS-SPLIT-1': 'v1:CS-SPLIT-1', 'CS-SPLIT-2': 'v1:CS-SPLIT-2' },
        p_idempotency_key: 'post_invoice_group:user-1:grp-1',
      }],
    ]);
  });
});

describe('field Drafts: the same rows post with the same RPC arguments', () => {
  function field(overrides: Record<string, unknown>) {
    return {
      id: overrides.invoice_number,
      invoice_post_version: `v1:${String(overrides.invoice_number)}`,
      invoice_type: 'field_application',
      customer_id: 'cust-1',
      customer: { farm_name: 'Test Farm' },
      job: null,
      job_id: null,
      blend_ticket_id: null,
      invoice_group_id: null,
      deleted_at: null,
      field_app_locations: [],
      invoice_items: [],
      total_acres: 10,
      total_amount_cents: 10000,
      paid_amount_cents: 0,
      prepay_applied_cents: 0,
      balance_cents: 10000,
      season: 2027,
      due_date: null,
      ...overrides,
    };
  }
  const ROWS = [
    field({ invoice_number: 'FA-1', status: 'draft', invoice_date: '2026-10-08' }),
    field({ invoice_number: 'FA-2', status: 'unposted', invoice_date: '2026-10-07' }),
    field({ invoice_number: 'FA-GRP-A', status: 'draft', invoice_group_id: 'grp-f', invoice_date: '2026-10-06' }),
    field({ invoice_number: 'FA-GRP-B', status: 'draft', invoice_group_id: 'grp-f', invoice_date: '2026-10-05' }),
    field({ invoice_number: 'FA-3', status: 'draft', invoice_date: '2026-10-04' }),
    field({ invoice_number: 'FA-OLD', status: 'draft', season: 2026, invoice_date: '2026-08-01' }),
  ];
  /** What the old Post All sent for these rows: every this-season stand-alone invoice, in list order. */
  const POST_ALL_CALLS = [
    ['post_invoice', { p_invoice_id: 'FA-1', p_expected_version: 'v1:FA-1', p_idempotency_key: 'post_invoice:user-1:FA-1' }],
    ['post_invoice', { p_invoice_id: 'FA-2', p_expected_version: 'v1:FA-2', p_idempotency_key: 'post_invoice:user-1:FA-2' }],
    ['post_invoice', { p_invoice_id: 'FA-3', p_expected_version: 'v1:FA-3', p_idempotency_key: 'post_invoice:user-1:FA-3' }],
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00'));
    H.from.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? ROWS : []));
    H.rpc.mockImplementation(rpcSucceeds);
  });
  afterEach(() => { vi.useRealTimers(); });

  const renderDrafts = async () => {
    render(<MemoryRouter><FieldInvoicesUnpostedPanel /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('FA-1').length).toBeGreaterThan(0));
  };
  const confirmPost = async (label: string) => {
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: `${label}…` }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: label }));
  };

  // Before the shared bar this was "Post All" -> "Post 3 invoice(s)"; the calls are the same.
  it('Select All + Post sends exactly what Post All sent', async () => {
    await renderDrafts();
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    await confirmPost('Post 3 invoices');

    await waitFor(() => expect(H.rpc).toHaveBeenCalledTimes(3));
    expect(rpcCalls()).toEqual(POST_ALL_CALLS);
  });

  it('ticking some drafts posts just those, with the same arguments and in list order', async () => {
    await renderDrafts();
    fireEvent.click(within(rowOf('FA-3')).getByRole('checkbox'));
    fireEvent.click(within(rowOf('FA-1')).getByRole('checkbox'));
    await confirmPost('Post 2 invoices');

    await waitFor(() => expect(H.rpc).toHaveBeenCalledTimes(2));
    expect(rpcCalls()).toEqual([POST_ALL_CALLS[0], POST_ALL_CALLS[2]]);
  });

  it('split-group and other-season rows have no tick box, and no group post is ever sent from here', async () => {
    await renderDrafts();
    for (const n of ['FA-GRP-A', 'FA-GRP-B', 'FA-OLD']) {
      expect(within(rowOf(n)).queryByRole('checkbox')).not.toBeInTheDocument();
    }
    expect(within(rowOf('FA-GRP-A')).getByText('Split invoice · post from its page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    await confirmPost('Post 3 invoices');
    await waitFor(() => expect(H.rpc).toHaveBeenCalledTimes(3));
    expect(H.rpc.mock.calls.map(([name]) => name)).not.toContain('post_invoice_group');
    expect(H.rpc.mock.calls.map(([, args]) => (args as { p_invoice_id?: string }).p_invoice_id)).not.toContain('FA-OLD');
  });

  it('a ticked draft that a filter hides is dropped, so it is never posted', async () => {
    await renderDrafts();
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    fireEvent.change(screen.getByLabelText('Inv. Nbr'), { target: { value: 'FA-1' } });
    fireEvent.change(screen.getByLabelText('Inv. Nbr'), { target: { value: '' } });
    expect(within(rowOf('FA-2')).getByRole('checkbox')).not.toBeChecked();
    expect(within(screen.getByRole('toolbar')).getByText('1 selected')).toBeInTheDocument();
    await confirmPost('Post 1 invoice');
    await waitFor(() => expect(H.rpc).toHaveBeenCalledTimes(1));
    expect(rpcCalls()).toEqual([POST_ALL_CALLS[0]]);
  });

  it('a draft that fails stays ticked, and its retry reuses the same idempotency key', async () => {
    let failFa2 = true;
    H.rpc.mockImplementation((_name: string, args: { p_invoice_id: string }) => {
      if (args.p_invoice_id === 'FA-2' && failFa2) {
        failFa2 = false;
        const failed = Promise.resolve({ data: null, error: { message: 'network' } });
        return Object.assign(failed, { throwOnError: () => Promise.reject(new Error('network')) });
      }
      return rpcSucceeds();
    });
    await renderDrafts();
    fireEvent.click(within(rowOf('FA-2')).getByRole('checkbox'));
    await confirmPost('Post 1 invoice');
    await waitFor(() => expect(H.rpc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('toolbar')).toBeInTheDocument());
    expect(within(rowOf('FA-2')).getByRole('checkbox')).toBeChecked();

    await confirmPost('Post 1 invoice');
    await waitFor(() => expect(H.rpc).toHaveBeenCalledTimes(2));
    const [first, second] = H.rpc.mock.calls.map(([, args]) => (args as { p_idempotency_key: string }).p_idempotency_key);
    expect(second).toBe(first);
  });
});
