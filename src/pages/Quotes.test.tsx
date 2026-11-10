/**
 * Quotes.test.tsx: the redesigned quotes list keeps today's filters, row actions
 * and bulk selection (Quotes UI redesign, Task 7). Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

// A query that ignores its filters and answers with the table's rows.
function fixedQuery(rows: unknown): Record<string, unknown> {
  const reply = { data: rows, error: null, count: Array.isArray(rows) ? rows.length : null };
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(reply);
      return () => q;
    },
  });
  return q;
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  const client = {
    from: (table: string) => fixedQuery(H.tables[table] ?? []),
    rpc: () => fixedQuery({ success: true, bookings: [] }),
  };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/notificationTriggers', () => ({ notifyLargeOrder: vi.fn(), notifyCreditLimitExceeded: vi.fn() }));
vi.mock('../lib/metrics', () => ({ trackBusinessEvent: vi.fn() }));
vi.mock('../lib/orderConfirmedEmail', () => ({ sendOrderConfirmedEmail: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../contexts/BelowCostApprovalContext', () => ({
  useBelowCostApproval: () => ({ runWithBelowCostApproval: (run: (reason: string | null) => unknown) => run(null) }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn(), getKeyFor: () => 'idem', resetKeyFor: vi.fn() }),
}));

import Quotes from './Quotes';

const quote = (n: number, status: string, over: Row = {}): Row => ({
  id: `q${n}`,
  quote_number: `Q-TEST-${n}`,
  status,
  tier: 1,
  is_planned: false,
  customer_id: 'c1',
  created_at: '2026-10-01T12:00:00Z',
  expires_at: null,
  deleted_at: null,
  total_price: 100 * n,
  customer: { farm_name: `Test Farm ${n}` },
  ...over,
});

const at = (path: string) => render(<MemoryRouter initialEntries={[path]}><Quotes /></MemoryRouter>);

beforeEach(() => { H.tables = {}; });
afterEach(cleanup);

describe('Quotes list', () => {
  it('Planned programs chip toggles the filter', async () => {
    H.tables.quotes = [quote(1, 'draft', { is_planned: true }), quote(2, 'sent')];
    at('/quotes');
    await screen.findByText('Q-TEST-2');
    const chip = screen.getByRole('button', { name: 'Planned programs' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Q-TEST-1')).toBeInTheDocument();
    expect(screen.queryByText('Q-TEST-2')).not.toBeInTheDocument();

    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Q-TEST-2')).toBeInTheDocument();
  });

  it('?filter=planned turns the chip on', async () => {
    H.tables.quotes = [quote(1, 'draft', { is_planned: true }), quote(2, 'sent')];
    at('/quotes?filter=planned');
    await screen.findByText('Q-TEST-1');
    expect(screen.getByRole('button', { name: 'Planned programs' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Q-TEST-2')).not.toBeInTheDocument();
  });

  it('row menu offers Convert to order only for sent and revised', async () => {
    H.tables.quotes = [quote(1, 'draft'), quote(2, 'sent'), quote(3, 'revised'), quote(4, 'accepted')];
    at('/quotes');
    await screen.findByText('Q-TEST-1');
    const itemsFor = (n: number) => {
      fireEvent.click(screen.getByRole('button', { name: `Actions for Q-TEST-${n}` }));
      const names = within(screen.getByRole('menu')).getAllByRole('menuitem').map((el) => el.textContent);
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      return names;
    };
    expect(itemsFor(1)).toEqual(['Duplicate']);
    expect(itemsFor(2)).toEqual(['Convert to order', 'Duplicate']);
    expect(itemsFor(3)).toEqual(['Convert to order', 'Duplicate']);
    expect(itemsFor(4)).toEqual(['Duplicate']);
  });

  it('header checkbox selects only draft, sent and revised rows', async () => {
    H.tables.quotes = [quote(1, 'draft'), quote(2, 'sent'), quote(3, 'revised'), quote(4, 'accepted'), quote(5, 'declined')];
    at('/quotes');
    await screen.findByText('Q-TEST-1');
    expect(screen.queryByRole('button', { name: /Select All/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select Q-TEST-4' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select Q-TEST-5' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all quotes' }));
    for (const n of [1, 2, 3]) expect(screen.getByRole('checkbox', { name: `Select Q-TEST-${n}` })).toBeChecked();
    expect(screen.getByText('3 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all quotes' }));
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it('Clear filters appears only when a filter is active', async () => {
    H.tables.quotes = [quote(1, 'draft', { is_planned: true }), quote(2, 'sent')];
    at('/quotes');
    await screen.findByText('Q-TEST-2');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Planned programs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Planned programs' })).toHaveAttribute('aria-pressed', 'false');

    // The status filter counts too.
    fireEvent.click(screen.getByRole('button', { name: 'All Status' }));
    fireEvent.click(screen.getByRole('option', { name: 'Sent' }));
    expect(screen.queryByText('Q-TEST-1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('the results strip is always there: count, then "N of M", then the selection bar with the same actions', async () => {
    H.tables.quotes = [quote(1, 'draft', { is_planned: true }), quote(2, 'sent'), quote(3, 'accepted')];
    at('/quotes');
    await screen.findByText('Q-TEST-1');
    const strip = () => screen.getByTestId('quote-results');
    expect(strip().textContent).toBe('3 quotesClear filters');
    // Clear filters keeps its space while no filter is on: in the strip, just hidden.
    const clear = within(strip()).getByText('Clear filters');
    expect(clear).not.toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Planned programs' }));
    expect(strip().textContent).toBe('1 of 3 quotesClear filters');
    expect(within(strip()).getByRole('button', { name: 'Clear filters' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    // Search narrows the count the same way (no rows found still keeps the strip).
    fireEvent.change(screen.getByRole('textbox', { name: 'Search by quote number, customer or product' }), { target: { value: 'nothing matches' } });
    expect(strip().textContent).toBe('0 of 3 quotesClear filters');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search by quote number, customer or product' }), { target: { value: '' } });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Q-TEST-2' }));
    const bar = within(strip()).getByRole('region', { name: 'Bulk actions' });
    expect(bar).toHaveTextContent('1 selected');
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Deselect', 'Export CSV', 'Download PDF', 'Delete quotes']);
    // The bar is the strip, so it sits after the search, never above it.
    expect(screen.getByRole('textbox', { name: 'Search by quote number, customer or product' }).compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Delete quotes' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(strip()).getByRole('button', { name: 'Deselect' }));
    expect(strip().textContent).toBe('3 quotesClear filters');
  });

  it('status filter options use the plain labels, and the row badge keeps their casing', async () => {
    H.tables.quotes = [quote(1, 'closed_short')];
    at('/quotes');
    // The status Dropdown also renders a hidden native <select>, so look for the badge span.
    expect(await screen.findByText('Closed short', { selector: 'span' })).not.toHaveClass('capitalize');
    fireEvent.click(screen.getByRole('button', { name: 'All Status' }));
    const options = screen.getAllByRole('option').map((el) => el.textContent);
    expect(options).toEqual(['All', 'Draft', 'Sent', 'Revised', 'Accepted', 'Declined', 'Expired', 'Cancelled', 'Fulfilled', 'Closed short']);
  });

  it('desktop search uses the long board placeholder, and Import quotes is reachable on phone too', async () => {
    H.tables.quotes = [quote(1, 'draft')];
    at('/quotes');
    await screen.findByText('Q-TEST-1');
    expect(screen.getByRole('textbox', { name: 'Search by quote number, customer or product' })).toHaveAttribute('placeholder', 'Search by quote number, customer or product');
    // Desktop button, plus a ⋯ next to New quote for phones (CSS picks one).
    expect(screen.getByRole('button', { name: 'Import quotes' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More quote actions' }));
    expect(screen.getByRole('menuitem', { name: 'Import quotes' })).toBeInTheDocument();
  });

  it('the status filter is green-tinted only while a status is picked', async () => {
    H.tables.quotes = [quote(1, 'draft'), quote(2, 'sent')];
    at('/quotes');
    await screen.findByText('Q-TEST-1');
    expect(screen.getByRole('button', { name: 'All Status' })).not.toHaveClass('bg-crx-green-light');
    fireEvent.click(screen.getByRole('button', { name: 'All Status' }));
    fireEvent.click(screen.getByRole('option', { name: 'Sent' }));
    expect(screen.getByRole('button', { name: 'Sent Status' })).toHaveClass('bg-crx-green-light');
  });

  it('row badges use the quote palette (Revised violet, Fulfilled teal, Closed short orange)', async () => {
    H.tables.quotes = [quote(1, 'revised'), quote(2, 'closed_by_application'), quote(3, 'closed_short')];
    at('/quotes');
    expect(await screen.findByText('Revised', { selector: 'span' })).toHaveClass('bg-violet-100');
    expect(screen.getByText('Fulfilled', { selector: 'span' })).toHaveClass('bg-teal-100');
    expect(screen.getByText('Closed short', { selector: 'span' })).toHaveClass('bg-orange-100');
  });
});

describe('Quotes list on a phone', () => {
  beforeEach(() => {
    // DataTable switches to mobileRow cards below 768px.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 767px)', media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const atWithQuotePage = (path: string) => render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/quotes" element={<Quotes />} />
        <Route path="/quotes/:id" element={<p>Quote page</p>} />
      </Routes>
    </MemoryRouter>,
  );

  it('a card checkbox tap selects without opening the quote, the menu opens, and the card opens the quote', async () => {
    H.tables.quotes = [quote(1, 'sent')];
    atWithQuotePage('/quotes');
    await screen.findByText('Q-TEST-1');
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument(); // the card layout, not the table

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Q-TEST-1' }));
    expect(screen.getByRole('checkbox', { name: 'Select Q-TEST-1' })).toBeChecked();
    expect(screen.queryByText('Quote page')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Q-TEST-1' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Convert to order', 'Duplicate']);
    expect(screen.queryByText('Quote page')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Q-TEST-1' }));
    expect(await screen.findByText('Quote page')).toBeInTheDocument();
  });

  it('the results line stays in every state, and Select all is disabled (not removed) when nothing is selectable', async () => {
    H.tables.quotes = [quote(1, 'accepted', { is_planned: true }), quote(2, 'sent'), quote(3, 'draft')];
    atWithQuotePage('/quotes');
    await screen.findByText('Q-TEST-1');
    const line = () => screen.getByTestId('quote-results');
    const selectAll = () => within(line()).getByRole('checkbox', { name: 'Select all quotes' });
    expect(line().textContent).toBe('3 quotesClear filters');
    expect(within(line()).getByText('Clear filters')).not.toBeVisible();
    expect(selectAll()).toBeEnabled();

    // Planned on leaves only an accepted quote: the box stays, disabled.
    fireEvent.click(screen.getByRole('button', { name: 'Planned programs' }));
    expect(line().textContent).toBe('1 of 3 quotesClear filters');
    expect(selectAll()).toBeDisabled();
    expect(within(line()).getByRole('button', { name: 'Clear filters' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    // Selects the same rows as before (draft, sent, revised) and says so in the same line.
    fireEvent.click(selectAll());
    expect(screen.getByRole('checkbox', { name: 'Select Q-TEST-2' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Q-TEST-3' })).toBeChecked();
    expect(line().textContent).toBe('2 of 2 selectedClear filters');
  });

  it('the bulk bar docks at the bottom, after the list, with Deselect and all three actions', async () => {
    H.tables.quotes = [quote(1, 'sent'), quote(2, 'draft')];
    atWithQuotePage('/quotes');
    await screen.findByText('Q-TEST-1');
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Q-TEST-1' }));

    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(bar).toHaveClass('fixed');
    expect(bar).toHaveTextContent('1 selected');
    // Not above the search: after the search and after the last card.
    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(screen.getByRole('textbox', { name: 'Search by quote number, customer or product' }), bar)).toBe(true);
    expect(follows(screen.getByRole('button', { name: 'Q-TEST-2' }), bar)).toBe(true);
    expect(within(bar).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Deselect', 'Export CSV', 'Download PDF', 'Delete quotes']);
    expect(within(bar).getByRole('button', { name: 'Export CSV' })).toHaveTextContent(/^CSV$/);

    fireEvent.click(within(bar).getByRole('button', { name: 'Delete quotes' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(bar).getByRole('button', { name: 'Deselect' }));
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).not.toBeInTheDocument();
  });

  it('the Sort chip replaces the native select and sorts like it did', async () => {
    H.tables.quotes = [quote(2, 'sent'), quote(5, 'draft'), quote(3, 'revised')];
    atWithQuotePage('/quotes');
    await screen.findByText('Q-TEST-2');
    expect(screen.queryByRole('combobox', { name: 'Sort by' })).not.toBeInTheDocument();
    const cards = () => screen.getAllByRole('button', { name: /^Q-TEST-/ }).map((el) => el.textContent);
    expect(cards()).toEqual(['Q-TEST-2', 'Q-TEST-5', 'Q-TEST-3']);

    const chip = screen.getByRole('button', { name: /^Sort/ });
    expect(chip).toHaveTextContent(/^Sort$/);
    expect(chip).not.toHaveClass('bg-crx-green-light');
    fireEvent.click(chip);
    expect(screen.getAllByRole('option').map((el) => el.textContent)).toEqual([
      'As listed',
      'Quote number, A to Z', 'Quote number, Z to A',
      'Status, A to Z', 'Status, Z to A',
      'Tier, 1 to 3', 'Tier, 3 to 1',
      'Total, low to high', 'Total, high to low',
      'Created, oldest first', 'Created, newest first',
      'Expires, soonest first', 'Expires, latest first',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Total, high to low' }));
    // total_price desc: the same order the native select's "Total ↓" gave.
    expect(cards()).toEqual(['Q-TEST-5', 'Q-TEST-3', 'Q-TEST-2']);
    expect(screen.getByRole('button', { name: /^Total, high to low/ })).toHaveClass('bg-crx-green-light');

    fireEvent.click(screen.getByRole('button', { name: /^Total, high to low/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Status, A to Z' }));
    expect(cards()).toEqual(['Q-TEST-5', 'Q-TEST-3', 'Q-TEST-2']); // draft, revised, sent

    fireEvent.click(screen.getByRole('button', { name: /^Status, A to Z/ }));
    fireEvent.click(screen.getByRole('option', { name: 'As listed' }));
    expect(cards()).toEqual(['Q-TEST-2', 'Q-TEST-5', 'Q-TEST-3']);
    expect(screen.getByRole('button', { name: /^Sort/ })).toHaveTextContent(/^Sort$/);
  });

  it('phone search has the short placeholder, long names wrap, and expiry shows a year only when it differs', async () => {
    const thisYear = new Date().getFullYear();
    const longName = 'Synthetic Extraordinarily Long Farm Name Partnership Holdings';
    H.tables.quotes = [
      quote(1, 'sent', { expires_at: `${thisYear}-12-31`, customer: { farm_name: longName } }),
      quote(2, 'sent', { expires_at: `${thisYear + 1}-09-30` }),
    ];
    atWithQuotePage('/quotes');
    await screen.findByText('Q-TEST-1');
    expect(screen.getByRole('textbox', { name: 'Search by quote number, customer or product' })).toHaveAttribute('placeholder', 'Quote, customer or product');
    const name = screen.getByText(longName);
    expect(name).not.toHaveClass('truncate');
    expect(name).toHaveClass('break-words');
    expect(screen.getByText('Expires Dec 31')).toBeInTheDocument();
    expect(screen.getByText(`Expires Sep 30, ${thisYear + 1}`)).toBeInTheDocument();
  });
});
