/**
 * QuoteBuilder.acresPrefill.test.tsx — a new quote line starts with acres (Mason, 2026-11-24).
 *
 * Reps retyped the acres on every line. A new line now takes the acres of the line above it in
 * its section, or else the section field's acres, shows where they came from until the rep types
 * there, and never changes another line. Totals use whatever the box holds, as before.
 * Uses the real data router, as QuoteBuilder.saveNavigation.test.tsx does; only the database,
 * auth, toast and side-effect libraries are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';

vi.mock('react-router-dom', async () => vi.importActual('react-router'));

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock('../lib/db', async () => {
  const { assertRpcResult } = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    supabase: { from: mockFrom, rpc: mockRpc },
    supabaseUntyped: { from: mockFrom, rpc: mockRpc },
    checkMutationResult: vi.fn(),
    assertRpcResult,
    hasRpcCode: () => false,
    RpcErrorCodes: {},
    rpcAuthErrorMessage: () => null,
    sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});
// Fixtures already carry cost; the admin cost read passes rows through.
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCost: async (_table: string, row: unknown) => row,
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
  withAdminNestedCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn(), captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyLargeOrder: vi.fn(), notifyCreditLimitExceeded: vi.fn() }));
vi.mock('../lib/metrics', () => ({ trackBusinessEvent: vi.fn() }));
vi.mock('../lib/orderConfirmedEmail', () => ({ sendOrderConfirmedEmail: vi.fn() }));
vi.mock('../lib/quotePdf', () => ({ downloadQuotePdf: vi.fn(), generateQuotePdf: vi.fn() }));
vi.mock('../lib/emailService', () => ({ sendEmail: vi.fn(), pdfToBase64: vi.fn(), buildEmailHtml: vi.fn(() => '') }));
vi.mock('../lib/rupCompliance', () => ({
  checkRUPCompliance: vi.fn().mockResolvedValue({ compliant: true, warnings: [], rupProductNames: [] }),
}));
vi.mock('../components/quotes/QuoteCustomerChecks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../components/quotes/QuoteCustomerChecks')>()),
  QuoteCreditStatus: () => null,
}));
vi.mock('../lib/customerTier', () => ({ readAssignedTier: async () => 1 }));
vi.mock('../components/ui/CommissionSplitEditor', () => ({ default: () => null }));

import QuoteBuilder from './QuoteBuilder';

const customer = {
  id: 'customer-1', farm_name: 'North Farm', assigned_tier: 1, is_active: true,
  default_commission_split: { splits: [{ recipient: 'Test Admin', percentage: 100 }] },
};
const product = {
  id: 'product-1', product_name: 'Alpha Chem', is_active: true, current_cost: 6, tier1_price: 10,
  unit_size: 'gal', inventory_unit: 'gal', rate_per_acre: 2, rate_unit: 'gal',
};
const field = { id: 'field-1', field_name: 'Home Quarter', customer_id: 'customer-1', total_acres: 80, measured_acres: null, override_acres: null };

/** A Supabase-like query chain: every filter returns itself, awaiting it answers `data`. */
function chain(data: unknown) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'gte', 'lte', 'order', 'limit', 'range', 'ilike']) {
    self[m] = () => self;
  }
  self.single = () => Promise.resolve({ data: null, error: null });
  self.maybeSingle = () => Promise.resolve({ data: null, error: null });
  const promise = Promise.resolve({ data, error: null });
  self.then = promise.then.bind(promise);
  return self;
}

function renderNewQuote() {
  const router = createMemoryRouter(
    [{ path: '/quotes/new', element: <QuoteBuilder /> }, { path: '/quotes/:id', element: <p>Saved</p> }],
    { initialEntries: ['/quotes/new'] },
  );
  render(<RouterProvider router={router} />);
}

const acres = () => screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value);

async function pickCustomer() {
  const customerBox = await screen.findByRole('combobox', { name: 'Customer' });
  fireEvent.change(customerBox, { target: { value: 'North' } });
  fireEvent.click(await screen.findByRole('option', { name: /North Farm/ }));
}

async function pickProductOnLastLine() {
  const selects = await screen.findAllByRole('button', { name: /Select product/ });
  fireEvent.click(selects[selects.length - 1]);
  const picker = await screen.findByPlaceholderText('Search by name, SKU, category, or vendor...');
  fireEvent.click(within(picker.closest('[role="dialog"]') as HTMLElement).getByText('Alpha Chem'));
  await waitFor(() => expect(screen.queryByPlaceholderText('Search by name, SKU, category, or vendor...')).not.toBeInTheDocument());
}

describe('QuoteBuilder — acres on a new line', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => chain(
      table === 'customers' ? [customer] : table === 'products' ? [product] : table === 'fields' ? [field] : [],
    ));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { status: 'saved', quote_id: '5c1d9e2a-7b3f-4a6e-8d0c-1f2e3a4b5c6d', row_version: 1, item_ids: {} }, error: null }
      : name === 'generate_quote_number'
        ? { data: 'Q-2026-0001', error: null }
        : { data: null, error: null }));
  });

  it('copies the line above, says so until the rep types, and never changes the line above', { timeout: 20000 }, async () => {
    renderNewQuote();
    await pickCustomer();
    fireEvent.click(await screen.findByRole('button', { name: 'Add one' }));
    // No line above and no field: the first line starts empty, with no hint.
    expect(acres()).toEqual(['']);
    expect(screen.queryByText(/^Filled from/)).not.toBeInTheDocument();
    await pickProductOnLastLine();
    fireEvent.change(screen.getByLabelText('Acres'), { target: { value: '40' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add product' }));
    await waitFor(() => expect(acres()).toEqual(['40', '40']));
    const hint = screen.getByText('Filled from line above');
    expect(screen.getAllByLabelText('Acres')[1]).toHaveAttribute('aria-describedby', hint.id);
    expect(screen.getAllByLabelText('Acres')[0]).not.toHaveAttribute('aria-describedby');

    // The rep's own number replaces it; the hint goes, and the line above keeps its acres.
    fireEvent.change(screen.getAllByLabelText('Acres')[1], { target: { value: '55' } });
    expect(acres()).toEqual(['40', '55']);
    expect(screen.queryByText('Filled from line above')).not.toBeInTheDocument();

    // A later line copies the line just above it, not the first line.
    fireEvent.click(screen.getByRole('button', { name: 'Add product' }));
    await waitFor(() => expect(acres()).toEqual(['40', '55', '55']));
  });

  it("fills from the section's field when the line above has none", { timeout: 20000 }, async () => {
    renderNewQuote();
    await pickCustomer();
    const fieldBox = await screen.findByRole('combobox', { name: 'Field for Section 1' });
    fireEvent.change(fieldBox, { target: { value: 'Ho' } });
    fireEvent.click(await screen.findByRole('option', { name: /Home Quarter/ }));
    await waitFor(() => expect(fieldBox).toHaveValue('Home Quarter'));

    fireEvent.click(await screen.findByRole('button', { name: 'Add one' }));
    await waitFor(() => expect(acres()).toEqual(['80']));
    expect(screen.getByText('Filled from field')).toBeInTheDocument();

    // Cleared by hand, the next line has no acres above it and takes the field's again.
    fireEvent.change(screen.getByLabelText('Acres'), { target: { value: '' } });
    expect(screen.queryByText('Filled from field')).not.toBeInTheDocument();
    await pickProductOnLastLine();
    fireEvent.click(screen.getByRole('button', { name: 'Add product' }));
    await waitFor(() => expect(acres()).toEqual(['', '80']));
    expect(screen.getByText('Filled from field')).toBeInTheDocument();

    // Clearing the field drops the acres it filled in, hint and all.
    fireEvent.click(screen.getByRole('button', { name: /^Clear field/ }));
    await waitFor(() => expect(acres()).toEqual(['', '']));
    expect(screen.queryByText('Filled from field')).not.toBeInTheDocument();
  });

  it('saves and prices the filled acres exactly as typed acres', { timeout: 20000 }, async () => {
    renderNewQuote();
    await pickCustomer();
    fireEvent.click(await screen.findByRole('button', { name: 'Add one' }));
    await pickProductOnLastLine();
    fireEvent.change(screen.getByLabelText('Acres'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add product' }));
    await pickProductOnLastLine();

    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
    const args = mockRpc.mock.calls.find(([name]) => name === 'save_quote')?.[1] as {
      p_sections: { items: { acres: number | null; total_units_needed: number | null; total_price: number }[] }[];
    };
    const [typed, filled] = args.p_sections[0].items;
    expect(filled.acres).toBe(40);
    // Same product, rate and acres: the filled line is priced exactly like the typed one.
    expect(filled.total_units_needed).toBe(typed.total_units_needed);
    expect(filled.total_price).toBe(typed.total_price);
    expect(filled.total_price).toBeGreaterThan(0);
  });

  it('still drops a filled line the rep closes the product picker on, untouched', { timeout: 20000 }, async () => {
    renderNewQuote();
    await pickCustomer();
    fireEvent.click(await screen.findByRole('button', { name: 'Add one' }));
    await pickProductOnLastLine();
    fireEvent.change(screen.getByLabelText('Acres'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add product' }));
    await waitFor(() => expect(acres()).toEqual(['40', '40']));

    fireEvent.click(screen.getByRole('button', { name: /Select product/ }));
    const picker = await screen.findByPlaceholderText('Search by name, SKU, category, or vendor...');
    fireEvent.keyDown(picker, { key: 'Escape' });
    await waitFor(() => expect(acres()).toEqual(['40']));
  });
});
