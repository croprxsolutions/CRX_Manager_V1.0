/**
 * Invoices.tabs.test.tsx — Chemical Invoices has the same tabs as Field Invoices.
 *
 * Drafts / Posted / By Customer / All Invoices sit on the list's existing status filters. The
 * tab is one more address value (?tab=), and links from before the tabs (?status=…) still open
 * the right tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { buildInMemoryQuery } from '../test-utils/inMemoryQuery';

const H = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), toast: vi.fn() }));

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return { ...actual, supabase: { from: (table: string) => H.from(table === 'invoices_postable' ? 'invoices' : table), rpc: H.rpc } };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin', deniedPages: [] }),
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
    due_date: '2026-11-05',
    created_at: '2026-10-06T15:00:00+00:00',
    ...overrides,
  };
}

const ROWS = [
  invoice({ invoice_number: 'CS-DRAFT', status: 'draft', total_amount_cents: 12500 }),
  invoice({ invoice_number: 'CS-UNPOSTED', status: 'unposted', total_amount_cents: 7500 }),
  invoice({ invoice_number: 'CS-POSTED', status: 'posted' }),
  invoice({ invoice_number: 'CS-OVERDUE', status: 'overdue' }),
  invoice({ invoice_number: 'CS-PAID', status: 'paid', balance_cents: 0 }),
  invoice({ invoice_number: 'CS-VOIDED', status: 'voided', balance_cents: 0 }),
];

function Address() {
  const location = useLocation();
  return <p data-testid="address">{location.search}</p>;
}

const renderAt = async (url: string) => {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Invoices />
      <Address />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole('tab', { name: /Drafts/ })).toBeInTheDocument());
};
const selectedTab = () => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;
const shown = (n: string) => screen.queryAllByText(n).length > 0;
const rowOf = (number: string) => screen.getAllByText(number).map((el) => el.closest('tr')).find(Boolean)!;

describe('Chemical Invoices tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00'));
    H.from.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? ROWS : []));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('has the Field Invoices tabs, less Unbilled, and opens on All Invoices as the list always did', async () => {
    await renderAt('/invoices');
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['Drafts', 'Posted', 'By Customer', 'All Invoices']);
    expect(selectedTab()).toBe('All Invoices');
    await waitFor(() => expect(shown('CS-VOIDED')).toBe(true));
    // Badges: Drafts = draft + unposted; Posted = posted + overdue + paid.
    expect(within(screen.getByRole('tab', { name: /Drafts/ })).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /Posted/ })).getByText('3')).toBeInTheDocument();
  });

  it('Drafts shows draft and unposted; Posted shows posted, overdue and paid; the tab goes in the address', async () => {
    await renderAt('/invoices');
    await waitFor(() => expect(shown('CS-DRAFT')).toBe(true));

    fireEvent.click(screen.getByRole('tab', { name: /Drafts/ }));
    expect(screen.getByTestId('address')).toHaveTextContent('?tab=drafts');
    expect(shown('CS-DRAFT') && shown('CS-UNPOSTED')).toBe(true);
    expect(shown('CS-POSTED') || shown('CS-PAID') || shown('CS-VOIDED')).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: /Posted/ }));
    expect(screen.getByTestId('address')).toHaveTextContent('?tab=posted');
    expect(shown('CS-POSTED') && shown('CS-OVERDUE') && shown('CS-PAID')).toBe(true);
    expect(shown('CS-DRAFT') || shown('CS-VOIDED')).toBe(false);
  });

  describe('links from before the tabs open the right tab', () => {
    it('?status=ready_to_post opens Drafts with every draft', async () => {
      await renderAt('/invoices?status=ready_to_post');
      expect(selectedTab()).toMatch(/^Drafts/);
      await waitFor(() => expect(shown('CS-DRAFT') && shown('CS-UNPOSTED')).toBe(true));
      expect(shown('CS-POSTED')).toBe(false);
      expect(screen.getByRole('combobox', { name: 'Filter by status' })).toHaveValue('');
    });

    it('?status=unposted opens Drafts narrowed to unposted', async () => {
      await renderAt('/invoices?status=unposted');
      expect(selectedTab()).toMatch(/^Drafts/);
      await waitFor(() => expect(shown('CS-UNPOSTED')).toBe(true));
      expect(shown('CS-DRAFT')).toBe(false);
    });

    it('?status=overdue opens Posted narrowed to overdue', async () => {
      await renderAt('/invoices?status=overdue');
      expect(selectedTab()).toMatch(/^Posted/);
      await waitFor(() => expect(shown('CS-OVERDUE')).toBe(true));
      expect(shown('CS-POSTED')).toBe(false);
    });

    it('?status=voided stays on All Invoices', async () => {
      await renderAt('/invoices?status=voided');
      expect(selectedTab()).toBe('All Invoices');
      await waitFor(() => expect(shown('CS-VOIDED')).toBe(true));
      expect(shown('CS-DRAFT')).toBe(false);
    });

    it('?tab=summary and ?tab=unposted use the Field Invoices aliases', async () => {
      await renderAt('/invoices?tab=summary');
      expect(selectedTab()).toBe('By Customer');
      expect(screen.getByText('Customer Invoice Summary')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Back to invoices' })).toBeInTheDocument();
    });

    it('?tab=unposted opens Drafts', async () => {
      await renderAt('/invoices?tab=unposted');
      expect(selectedTab()).toMatch(/^Drafts/);
    });
  });

  it('a status picked on All Invoices keeps the All Invoices tab', async () => {
    await renderAt('/invoices');
    await waitFor(() => expect(shown('CS-DRAFT')).toBe(true));
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'draft' } });
    expect(selectedTab()).toBe('All Invoices');
    expect(screen.getByTestId('address')).toHaveTextContent('?status=draft&tab=all');
    expect(shown('CS-UNPOSTED')).toBe(false);
  });

  it('the shared selection bar shows the count and total, and a tab that hides a ticked row drops it', async () => {
    await renderAt('/invoices');
    await waitFor(() => expect(shown('CS-DRAFT')).toBe(true));
    fireEvent.click(within(rowOf('CS-DRAFT')).getByRole('checkbox'));
    fireEvent.click(within(rowOf('CS-UNPOSTED')).getByRole('checkbox'));
    const bar = screen.getByRole('toolbar');
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();
    expect(within(bar).getByText('$200.00')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Post 2 invoices…' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Posted/ }));
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Drafts/ }));
    expect(within(rowOf('CS-DRAFT')).getByRole('checkbox')).not.toBeChecked();
    expect(H.rpc).not.toHaveBeenCalled();
  });
});
