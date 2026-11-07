/**
 * ProductDetail.parents.test.tsx — PAR-1: a size that belongs to a parent, and how new products reach one.
 *
 * Uses the REAL data router so "Add a size" / "New product" really carry route state to the new-product
 * page. The parent RPC wrappers are mocked; newSizeFields stays real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router';
import type { ProductParent } from '../lib/productParents';

vi.mock('../components/products/ProductVendorsSection', () => ({ default: () => null }));
vi.mock('react-router-dom', async () => vi.importActual('react-router'));

const H = vi.hoisted(() => ({
  mockFrom: vi.fn(), mockToast: vi.fn(), mockUpdate: vi.fn(),
  getParent: vi.fn(), createParent: vi.fn(), addSize: vi.fn(),
}));

vi.mock('../lib/db', async () => {
  const { assertRpcResult, hasRpcCode, RpcErrorCodes } = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    supabase: { from: H.mockFrom, rpc: vi.fn(), functions: { invoke: vi.fn() } },
    supabaseUntyped: { from: H.mockFrom, rpc: vi.fn() },
    checkMutationResult: vi.fn(),
    assertRpcResult,
    hasRpcCode,
    RpcErrorCodes,
    sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});
vi.mock('../lib/productParents', async (orig) => ({
  ...(await orig<typeof import('../lib/productParents')>()),
  getParentOfProduct: H.getParent,
  createProductWithParent: H.createParent,
  addProductSize: H.addSize,
}));
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCost: async (_table: string, row: unknown) => row,
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));
vi.mock('../lib/productUseTimings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/productUseTimings')>()),
  listProductUseTimingOptions: async () => [
    { code: 'pre_emerge_corn', label: 'Pre-Emerge Corn', timing_code: 'pre_emergence', crop: 'corn', category: 'Herbicide', is_active: true, sort_order: 20 },
  ],
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn(), captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'key', resetKey: vi.fn(), getKeyFor: () => 'key', resetKeyFor: vi.fn() }),
}));
vi.mock('../components/products/ProductPriceHistory', () => ({ default: () => null }));
vi.mock('../components/products/ProductBrandsSection', () => ({ default: () => null }));

import ProductDetailRoute from '../components/ProductDetailRoute';

const product = {
  id: 'product-1', product_name: 'Atrazine 4L 2.5 Gal', sku: 'ATZ-25', category: 'Herbicide', use_timings: ['pre_emerge_corn'],
  vendor: 'Acme Ag', manufacturer: 'Maker Co', container_size: 2.5, unit_size: 'gal', epa_registration: '100-1',
  is_rup: false, signal_word: null, rei_hours: null, phi_days: null, product_form: 'liquid', inventory_unit: 'gal',
  container_unit: 'jug', container_type: 'Jug', current_cost: 50, cost_updated_date: null,
  tier1_price: 65, tier2_price: 60, tier3_price: 55, tier1_margin: null, tier2_margin: null, tier3_margin: null,
  tier1_gross_margin: null, tier2_gross_margin: null, tier3_gross_margin: null,
  tier1_price_per_acre: null, tier2_price_per_acre: null, tier3_price_per_acre: null,
  suggested_rate: null, rate_per_acre: 1.5, rate_unit: 'gal', max_label_rate: null, max_label_rate_unit: null,
  notes: null, internal_notes: null, quoting_notes: null, is_active: true,
  created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z', pricing_version: 1,
};

const parent: ProductParent = {
  id: 'parent-1', name: 'Atrazine 4L', nickname: null, product_form: 'liquid', formulation_type: null, safener: null,
  generic_epa_registration: '100-1', category: 'Herbicide', use_timings: ['pre_emerge_corn'],
  rate_per_acre: '1.5', rate_unit: 'gal', suggested_rate: null, parent_version: 3, is_active: true,
  sizes: [{ product_id: 'product-1', product_name: product.product_name, sku: 'ATZ-25', size_role: 'package', fill_source_product_id: null, is_active: true }],
};

/** A Supabase-like query chain; `update` records its payload. */
function chain(data: unknown, single: unknown = null) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'range', 'ilike']) self[m] = () => self;
  self.update = (value: unknown) => { H.mockUpdate(value); return self; };
  self.maybeSingle = () => Promise.resolve({ data: single, error: null });
  const promise = Promise.resolve({ data, error: null });
  self.then = promise.then.bind(promise);
  return self;
}

function renderAt(path: string, state?: unknown) {
  const router = createMemoryRouter(
    [{
      element: <Outlet />,
      children: [
        { path: '/products', element: <p>Products list page</p> },
        { path: '/products/:id', element: <ProductDetailRoute /> },
      ],
    }],
    { initialEntries: [{ pathname: path, state }] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const parentLoaded = () => waitFor(() => expect(screen.getByTestId('product-parent-panel')).toBeInTheDocument());

describe('ProductDetail — parents (PAR-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.mockFrom.mockImplementation((table: string) => chain(
      table === 'product_categories' ? [{ name: 'Herbicide', is_active: true, sort_order: 10 }]
        : table === 'products' ? [product] : [],
      table === 'products' ? product : null,
    ));
    H.getParent.mockResolvedValue(parent);
    H.createParent.mockResolvedValue({ parent_id: 'parent-1', parent_version: 4, product_id: 'product-2', event_id: 1 });
    H.addSize.mockResolvedValue({ parent_id: 'parent-1', parent_version: 4, product_id: 'product-2', event_id: 1 });
  });

  it('a grouped size reads category, timings, EPA and rates from its parent, and never saves them', async () => {
    renderAt('/products/product-1');
    await parentLoaded();
    expect(screen.getByRole('button', { name: 'Edit parent' })).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toBeDisabled();
    const timings = within(await screen.findByRole('group', { name: 'Use Timing' }));
    expect(timings.getByRole('checkbox', { name: 'Pre-Emerge Corn' })).toBeDisabled();
    expect(screen.getByLabelText('EPA Registration')).toBeDisabled();
    for (const label of ['Suggested Rate', 'Rate Per Acre', 'Rate Unit']) expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getAllByText(/Set on parent Atrazine 4L/).length).toBeGreaterThanOrEqual(3);

    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'ATZ-25B' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^Save/ })[0]);
    await waitFor(() => expect(H.mockUpdate).toHaveBeenCalled());
    const payload = H.mockUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.sku).toBe('ATZ-25B');
    for (const key of ['category', 'use_timings', 'epa_registration', 'rate_per_acre', 'rate_unit', 'suggested_rate']) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it('a failed parent load shows Retry and keeps those fields read-only until it loads', async () => {
    H.getParent.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(null);
    renderAt('/products/product-1');
    const alert = (await screen.findByText(/Couldn.t load this product.s parent/)).closest('[role="alert"]') as HTMLElement;
    expect(alert).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toBeDisabled();
    expect(screen.getByLabelText('EPA Registration')).toBeDisabled();
    expect(screen.getByLabelText('Rate Per Acre')).toBeDisabled();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByLabelText('Category')).toBeEnabled());
    expect(screen.queryByText(/Couldn.t load this product.s parent/)).not.toBeInTheDocument();
    expect(H.getParent).toHaveBeenCalledTimes(2);
  });

  it('Add a size carries the parent, and saving calls addProductSize with a size that has no parent-owned fields', async () => {
    const router = renderAt('/products/product-1');
    await parentLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Add a size' }));

    expect(await screen.findByText('New size of Atrazine 4L, started from Atrazine 4L 2.5 Gal. Nothing is saved until you create it.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/products/new');
    expect((router.state.location.state as { addSizeTo: ProductParent }).addSizeTo.id).toBe('parent-1');

    fireEvent.change(screen.getByLabelText(/Product Name/), { target: { value: 'Atrazine 4L 30 Gal' } });
    fireEvent.change(screen.getByLabelText('Size role'), { target: { value: 'bulk' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Product/ }));

    await waitFor(() => expect(H.addSize).toHaveBeenCalled());
    const [parentId, version, size] = H.addSize.mock.calls[0] as [string, number, Record<string, unknown>];
    expect(parentId).toBe('parent-1');
    expect(version).toBe(3);
    expect(size).toEqual(expect.objectContaining({ product_name: 'Atrazine 4L 30 Gal', size_role: 'bulk', epa_registration: null }));
    for (const key of ['category', 'use_timings', 'rate_per_acre', 'rate_unit', 'suggested_rate']) expect(size).not.toHaveProperty(key);
    expect(H.createParent).not.toHaveBeenCalled();
    await waitFor(() => expect(router.state.location.pathname).toBe('/products/product-2'));
  });

  it('New product creates a parent with the typed name and nickname, the category, and the chosen size role', async () => {
    H.getParent.mockResolvedValue(null);
    renderAt('/products/product-1');
    fireEvent.click(await screen.findByRole('button', { name: 'New product' }));
    await screen.findByText('New product started from Atrazine 4L 2.5 Gal. Nothing is saved until you create it.');

    fireEvent.change(screen.getByLabelText(/Product Name/), { target: { value: 'Brand New Herbicide' } });
    fireEvent.change(screen.getByLabelText('Parent name'), { target: { value: 'Brand New' } });
    fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: 'BN' } });
    fireEvent.change(screen.getByLabelText('Size role'), { target: { value: 'fixed_tote' } });
    // Rates cannot be typed on a new product; they are set on the parent afterwards.
    expect(screen.getByLabelText('Rate Per Acre')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Create Product/ }));

    await waitFor(() => expect(H.createParent).toHaveBeenCalled());
    const [parentFields, size] = H.createParent.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(parentFields).toEqual(expect.objectContaining({ name: 'Brand New', nickname: 'BN', category: 'Herbicide' }));
    expect(size).toEqual(expect.objectContaining({ product_name: 'Brand New Herbicide', size_role: 'fixed_tote' }));
    // Blank notes are left out, not sent as empty text.
    expect(size).not.toHaveProperty('quoting_notes');
    expect(size).not.toHaveProperty('internal_notes');
    expect(H.addSize).not.toHaveBeenCalled();
  });

  it('a new size sends its notes in the same database call as the size, with no second write', async () => {
    const router = renderAt('/products/product-1');
    await parentLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Add a size' }));
    await screen.findByText(/New size of Atrazine 4L/);
    fireEvent.change(screen.getByLabelText(/Product Name/), { target: { value: 'Atrazine 4L 30 Gal' } });
    fireEvent.change(screen.getByLabelText('Internal Notes'), { target: { value: 'Keep in the cold room' } });
    fireEvent.change(screen.getByLabelText('Quoting Notes'), { target: { value: 'Quote by the gallon' } });
    H.mockUpdate.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Create Product/ }));

    await waitFor(() => expect(H.addSize).toHaveBeenCalled());
    const size = H.addSize.mock.calls[0][2] as Record<string, unknown>;
    expect(size).toEqual(expect.objectContaining({
      product_name: 'Atrazine 4L 30 Gal', internal_notes: 'Keep in the cold room', quoting_notes: 'Quote by the gallon',
    }));
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/products/new'));
    expect(H.mockUpdate).not.toHaveBeenCalled();
    expect(H.mockToast).toHaveBeenCalledWith('success', 'Product created. Now set its prices.');
    expect(H.mockToast).not.toHaveBeenCalledWith('error', expect.stringMatching(/notes/i));
  });

  it('Add a size is disabled for a product with no parent, and New product stays available', async () => {
    H.getParent.mockResolvedValue(null);
    renderAt('/products/product-1');
    const addSize = await screen.findByRole('button', { name: 'Add a size' });
    await waitFor(() => expect(screen.getByLabelText('Category')).toBeEnabled());
    expect(addSize).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New product' })).toBeEnabled();
    expect(screen.queryByTestId('product-parent-panel')).not.toBeInTheDocument();
  });
});
