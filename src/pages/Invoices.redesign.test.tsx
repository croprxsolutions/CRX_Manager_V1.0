/**
 * Invoices.redesign.test.tsx — the invoices list redesign (Billing UI, Nov 13).
 *
 * A visible "Ready to post" filter, one selection bar (Print, More, Post) and the
 * new column set. The role tests pin today's rules: Post and Print for admins and
 * sales reps, Email / Void / Delete for admins only, each counted as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../test-utils/inMemoryQuery';

const H = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), toast: vi.fn(), role: 'admin' as string }));

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return { ...actual, supabase: { from: (table: string) => H.from(table === 'invoices_postable' ? 'invoices' : table), rpc: H.rpc } };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: H.role }, role: H.role, deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import Invoices from './Invoices';

function invoice(overrides: Record<string, unknown>) {
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
    created_at: '2026-10-06T15:00:00+00:00',
    ...overrides,
  };
}

const ROWS = [
  invoice({ invoice_number: 'CS-DRAFT', status: 'draft' }),
  invoice({ invoice_number: 'CS-UNPOSTED', status: 'unposted' }),
  invoice({ invoice_number: 'CS-POSTED', status: 'posted' }),
  invoice({ invoice_number: 'CS-VOIDED', status: 'voided', balance_cents: 0 }),
  invoice({ invoice_number: 'CS-PAID', status: 'paid', balance_cents: 0 }),
  invoice({ invoice_number: 'CS-SPLIT-1', status: 'draft', invoice_group_id: 'grp-1' }),
  invoice({ invoice_number: 'CS-SPLIT-2', status: 'draft', invoice_group_id: 'grp-1', customer: { farm_name: 'Cedar Ridge Ag' } }),
];

const renderList = async () => {
  render(<MemoryRouter><Invoices /></MemoryRouter>);
  await waitFor(() => expect(screen.getAllByText('CS-DRAFT').length).toBeGreaterThan(0));
};
const rowOf = (number: string) => screen.getAllByText(number).map((el) => el.closest('tr')).find(Boolean)!;
const tick = (...numbers: string[]) => numbers.forEach((n) => fireEvent.click(within(rowOf(n)).getByRole('checkbox')));
const bar = () => screen.getByRole('toolbar');
const menuNames = () => screen.getAllByRole('menuitem').map((el) => el.textContent);

describe('Invoices list redesign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.role = 'admin';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00'));
    H.from.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? ROWS : []));
  });

  describe('the Ready to post tile is a visible, removable filter', () => {
    it('toggles the filter, says "Showing these" and shows a chip that clears it', async () => {
      await renderList();
      const tile = screen.getByRole('button', { name: 'Show invoices ready to post' });
      expect(tile).toHaveAttribute('aria-pressed', 'false');
      expect(within(tile).queryByText(/Showing these/)).not.toBeInTheDocument();
      expect(tile).toHaveTextContent('4');

      fireEvent.click(tile);
      expect(tile).toHaveAttribute('aria-pressed', 'true');
      expect(within(tile).getByText(/Showing these/)).toBeInTheDocument();
      expect(screen.queryByText('CS-POSTED')).not.toBeInTheDocument();
      expect(screen.getAllByText('CS-UNPOSTED').length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Ready to post' }));
      expect(tile).toHaveAttribute('aria-pressed', 'false');
      expect(screen.queryByRole('button', { name: 'Remove filter: Ready to post' })).not.toBeInTheDocument();
      expect(screen.getAllByText('CS-POSTED').length).toBeGreaterThan(0);
    });

    it('a second tap on the tile turns the filter off', async () => {
      await renderList();
      const tile = screen.getByRole('button', { name: 'Show invoices ready to post' });
      fireEvent.click(tile);
      fireEvent.click(tile);
      expect(tile).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getAllByText('CS-POSTED').length).toBeGreaterThan(0);
    });
  });

  describe('one selection bar, same actions, counts and people as today', () => {
    it('admin: n selected, Print n…, More (Email, Void, Delete in red) and Post n invoices… as the primary', async () => {
      await renderList();
      tick('CS-DRAFT', 'CS-POSTED', 'CS-VOIDED');
      expect(within(bar()).getByText('3 selected')).toBeInTheDocument();
      expect(within(bar()).getByRole('button', { name: 'Print 3…' })).toBeInTheDocument();
      const post = within(bar()).getByRole('button', { name: 'Post 1 invoice…' });
      expect(post.className).toContain('bg-crx-green');

      fireEvent.click(within(bar()).getByRole('button', { name: 'More' }));
      // Email: posted or overdue. Void: posted or overdue. Delete: draft or voided.
      expect(menuNames()).toEqual(['Email 1…', 'Void 1…', 'Delete 2…']);
      expect(screen.getByRole('menuitem', { name: 'Void 1…' }).className).toContain('text-red-700');
      expect(screen.getByRole('menuitem', { name: 'Delete 2…' }).className).toContain('text-red-700');
      expect(screen.getByRole('menuitem', { name: 'Email 1…' }).className).not.toContain('text-red-700');
    });

    it('admin: each More item opens the dialog it opened before', async () => {
      await renderList();
      tick('CS-DRAFT', 'CS-POSTED');
      fireEvent.click(within(bar()).getByRole('button', { name: 'More' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Void 1…' }));
      expect(await screen.findByPlaceholderText(/reason for voiding/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      fireEvent.click(within(bar()).getByRole('button', { name: 'More' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Email 1…' }));
      const email = await screen.findByRole('dialog');
      expect(within(email).getByText(/Email 1 posted or overdue invoice\(s\)/)).toBeInTheDocument();
      fireEvent.click(within(email).getByRole('button', { name: 'Cancel' }));

      fireEvent.click(within(bar()).getByRole('button', { name: 'More' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete 1…' }));
      const del = await screen.findByRole('dialog');
      expect(within(del).getByRole('button', { name: /Delete/ })).toBeInTheDocument();
      expect(H.rpc).not.toHaveBeenCalled();
    });

    it('sales rep: Print and Post only, no More (no Email, Void or Delete)', async () => {
      H.role = 'sales_rep';
      await renderList();
      tick('CS-DRAFT', 'CS-POSTED', 'CS-VOIDED');
      expect(within(bar()).getByText('3 selected')).toBeInTheDocument();
      expect(within(bar()).getByRole('button', { name: 'Print 3…' })).toBeInTheDocument();
      expect(within(bar()).getByRole('button', { name: 'Post 1 invoice…' })).toBeInTheDocument();
      expect(within(bar()).queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^(Email|Void|Delete) \d/ })).not.toBeInTheDocument();
    });

    it('a role that cannot post sees the count and Clear selection, and no action', async () => {
      H.role = 'driver';
      await renderList();
      tick('CS-DRAFT', 'CS-POSTED');
      expect(within(bar()).getByText('2 selected')).toBeInTheDocument();
      expect(within(bar()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Clear selection']);
    });

    it('Post shows only with a draft or unposted invoice ticked; More only with an item in it', async () => {
      await renderList();
      tick('CS-POSTED');
      expect(within(bar()).queryByRole('button', { name: /^Post/ })).not.toBeInTheDocument();
      tick('CS-POSTED');
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();

      tick('CS-UNPOSTED');
      expect(within(bar()).getByRole('button', { name: 'Post 1 invoice…' })).toBeInTheDocument();
      expect(within(bar()).queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    });

    it('Clear selection empties the bar', async () => {
      await renderList();
      tick('CS-DRAFT');
      fireEvent.click(within(bar()).getByRole('button', { name: 'Clear selection' }));
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
      expect(within(rowOf('CS-DRAFT')).getByRole('checkbox')).not.toBeChecked();
    });
  });

  describe('the post confirm', () => {
    it('asks "Post n invoices?" and keeps the plain message without a split', async () => {
      await renderList();
      tick('CS-DRAFT', 'CS-UNPOSTED');
      fireEvent.click(within(bar()).getByRole('button', { name: 'Post 2 invoices…' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Post 2 invoices?')).toBeInTheDocument();
      expect(within(dialog).getByText('Post 2 selected invoice(s)? Posting locks them into AR.')).toBeInTheDocument();
      // Cancel is the safe button and comes first; nothing posts.
      const buttons = within(dialog).getAllByRole('button').map((b) => b.textContent);
      expect(buttons.indexOf('Cancel')).toBeLessThan(buttons.indexOf('Post 2'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(H.rpc).not.toHaveBeenCalled();
    });

    it('with a split group, says the whole split posts together', async () => {
      await renderList();
      tick('CS-SPLIT-1', 'CS-SPLIT-2');
      fireEvent.click(within(bar()).getByRole('button', { name: 'Post 2 invoices…' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Post 2 invoices?')).toBeInTheDocument();
      expect(within(dialog).getByText(
        'These include a split sale, so every invoice in that split posts together. If one changed since you opened this list, none of its split posts and you will be told.',
      )).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Post selected + full split groups' })).toBeInTheDocument();
    });
  });

  describe('rows and columns', () => {
    it('marks split-group rows "Split invoice" under the number, and only those', async () => {
      await renderList();
      expect(within(rowOf('CS-SPLIT-1')).getByText('Split invoice')).toBeInTheDocument();
      expect(within(rowOf('CS-SPLIT-2')).getByText('Split invoice')).toBeInTheDocument();
      expect(within(rowOf('CS-DRAFT')).queryByText('Split invoice')).not.toBeInTheDocument();
    });

    it('has the new headers, and below xl keeps only Invoice, Date, Total, Balance and Status (bill-to under the number)', async () => {
      await renderList();
      const headers = screen.getAllByRole('columnheader');
      const names = headers.map((h) => h.textContent?.trim()).filter(Boolean);
      expect(names).toEqual(['Invoice', 'Bill to', 'Sale', 'Type', 'Date', 'Total', 'Balance', 'Status', 'Salesperson']);
      const xlOnly = headers.filter((h) => h.className.includes('hidden xl:table-cell')).map((h) => h.textContent?.trim());
      expect(xlOnly).toEqual(['Bill to', 'Sale', 'Type', 'Salesperson']);
      // Below xl the customer shows under the invoice number instead.
      const underNumber = within(rowOf('CS-SPLIT-2')).getAllByText('Cedar Ridge Ag').find((el) => el.closest('.xl\\:hidden'));
      expect(underNumber).toBeTruthy();
    });

    it('shows how many invoices are in view', async () => {
      await renderList();
      expect(screen.getByText('7 invoices')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Show invoices ready to post' }));
      expect(screen.getByText('4 invoices')).toBeInTheDocument();
    });
  });
});
