/**
 * ProductDetail.saveNavigation.test.tsx — saving a NEW product.
 *
 * Bug (seen in the private test app, 2026-11-01): after a successful create the page called
 * setIsDirty(false) and navigate('/products') back-to-back. The router still held the block
 * check from the last committed render (dirty = true), so it showed a false "Unsaved Changes"
 * prompt over a product that was already saved, and Stay invited a second save.
 *
 * The other ProductDetail tests mock useUnsavedChanges away, so they cannot see this. This
 * file uses the REAL data router, the REAL hook and the REAL modal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, Outlet, RouterProvider, createMemoryRouter } from 'react-router';

// Same module copy for the page's useNavigate and the hook's useBlocker
// (see QuoteBuilder.saveNavigation.test.tsx).
// The Vendors section has its own tests; these page tests do not mock its reads.
vi.mock('../components/products/ProductVendorsSection', () => ({ default: () => null }));
vi.mock('react-router-dom', async () => vi.importActual('react-router'));

const { mockFrom, mockToast, mockInsert, mockCreate } = vi.hoisted(() => ({ mockFrom: vi.fn(), mockToast: vi.fn(), mockInsert: vi.fn(), mockCreate: vi.fn() }));

vi.mock('../lib/db', async () => {
  const { assertRpcResult, hasRpcCode, RpcErrorCodes } = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    supabase: { from: mockFrom, rpc: vi.fn(), functions: { invoke: vi.fn() } },
    supabaseUntyped: { from: mockFrom, rpc: vi.fn() },
    checkMutationResult: vi.fn(),
    assertRpcResult,
    sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    hasRpcCode,
    RpcErrorCodes,
  };
});
// PAR-1: a new product is created through the parent RPC, not a products insert.
vi.mock('../lib/productParents', async (orig) => ({
  ...(await orig<typeof import('../lib/productParents')>()),
  getParentOfProduct: vi.fn().mockResolvedValue(null),
  createProductWithParent: mockCreate,
  addProductSize: vi.fn(),
}));
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCost: async (_table: string, row: unknown) => row,
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn(), captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'key', resetKey: vi.fn(), getKeyFor: () => 'key', resetKeyFor: vi.fn() }),
}));
vi.mock('../components/products/ProductPriceHistory', () => ({ default: () => null }));
vi.mock('../components/products/ProductBrandsSection', () => ({ default: () => null }));

import ProductDetail from './ProductDetail';

/** A Supabase-like query chain: every filter returns itself, awaiting it answers `data`. */
function chain(data: unknown) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'range', 'ilike']) {
    self[m] = () => self;
  }
  self.insert = (value: unknown) => { mockInsert(value); return self; };
  self.maybeSingle = () => Promise.resolve({ data: null, error: null });
  const promise = Promise.resolve({ data, error: null });
  self.then = promise.then.bind(promise);
  return self;
}

function renderNewProduct(state?: unknown) {
  const router = createMemoryRouter(
    [{
      element: <><Link to="/elsewhere">Elsewhere</Link><Outlet /></>,
      children: [
        { path: '/products', element: <p>Products list page</p> },
        { path: '/products/product-1', element: <p>New product page</p> },
        { path: '/products/:id', element: <ProductDetail /> },
        { path: '/elsewhere', element: <p>Elsewhere page</p> },
      ],
    }],
    { initialEntries: [{ pathname: '/products/new', state }] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('ProductDetail — leaving a new product', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => chain([{ id: 'product-1' }]));
    mockCreate.mockResolvedValue({ parent_id: 'parent-1', parent_version: 1, product_id: 'product-1', event_id: 1 });
  });

  it('a successful create opens the new product for pricing with no Unsaved Changes prompt', async () => {
    const router = renderNewProduct();
    fireEvent.change(await screen.findByLabelText(/Product Name/), { target: { value: 'New Chem' } });
    fireEvent.change(screen.getByLabelText('Product Form'), { target: { value: 'liquid' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Product/ }));

    await screen.findByText('New product page');
    expect(router.state.location.pathname).toBe('/products/product-1');
    expect(router.state.location.state).toEqual({ justCreated: true });
    expect(mockToast).toHaveBeenCalledWith('success', 'Product created. Now set its prices.');
    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
  });

  it('falls back to the list when the new id does not come back', async () => {
    mockCreate.mockResolvedValue({ parent_id: 'parent-1', parent_version: 1, event_id: 1 });
    const router = renderNewProduct();
    fireEvent.change(await screen.findByLabelText(/Product Name/), { target: { value: 'New Chem' } });
    fireEvent.change(screen.getByLabelText('Product Form'), { target: { value: 'liquid' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Product/ }));

    await screen.findByText('Products list page');
    expect(router.state.location.pathname).toBe('/products');
    expect(mockToast).toHaveBeenCalledWith('success', 'Product created');
  });

  it('New product starts from the copied fields only and saves nothing else of the source', async () => {
    renderNewProduct({ duplicateFrom: {
      id: 'source-1', product_name: 'Atrazine 4L', category: 'Herbicide', vendor: 'Acme Ag',
      manufacturer: 'Maker Co', product_form: 'liquid', inventory_unit: 'Gal',
    } });
    expect(await screen.findByText('New product started from Atrazine 4L. Nothing is saved until you create it.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Product Name/)).toHaveValue('Atrazine 4L (copy)');
    expect(screen.getByLabelText('SKU')).toHaveValue('');
    expect(screen.getByLabelText('EPA Registration')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: /Create Product/ }));

    await screen.findByText('New product page');
    const [parentFields, row] = mockCreate.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(parentFields).toEqual(expect.objectContaining({ name: 'Atrazine 4L (copy)', category: 'Herbicide', product_form: 'liquid' }));
    expect(row).toEqual(expect.objectContaining({
      product_name: 'Atrazine 4L (copy)', vendor: 'Acme Ag', manufacturer: 'Maker Co',
      product_form: 'liquid', inventory_unit: 'Gal', size_role: 'package',
      sku: null, epa_registration: null, is_rup: false, signal_word: null, rei_hours: null, phi_days: null,
      container_unit: null, unit_size: null,
    }));
    for (const field of ['id', 'tier1_price', 'tier2_price', 'tier3_price', 'current_cost', 'category', 'use_timings', 'rate_per_acre']) expect(row).not.toHaveProperty(field);
  });

  it('a New product left unsaved still prompts', async () => {
    renderNewProduct({ duplicateFrom: { id: 'source-1', product_name: 'Atrazine 4L', category: null, vendor: null, manufacturer: null, product_form: null, inventory_unit: null } });
    await screen.findByText('New product started from Atrazine 4L. Nothing is saved until you create it.');
    fireEvent.click(screen.getByRole('link', { name: 'Elsewhere' }));
    expect(await screen.findByText('Unsaved Changes')).toBeInTheDocument();
  });

  it('locks the form while a new product saves', async () => {
    let finish: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => { finish = resolve; });
    mockCreate.mockReturnValue(pending);
    renderNewProduct();
    const name = await screen.findByLabelText(/Product Name/);
    fireEvent.change(name, { target: { value: 'New Chem' } });
    fireEvent.change(screen.getByLabelText('Product Form'), { target: { value: 'liquid' } });
    expect(name).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Create Product/ }));

    await waitFor(() => expect(name).toBeDisabled());
    finish({ parent_id: 'parent-1', parent_version: 1, product_id: 'product-1', event_id: 1 });
    await screen.findByText('New product page');
  });

  it('refuses a new product with no form before requesting a save', async () => {
    renderNewProduct();
    fireEvent.change(await screen.findByLabelText(/Product Name/), { target: { value: 'New Chem' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Product/ }));
    expect(mockToast).toHaveBeenCalledWith('error', 'Choose a product form (liquid, dry, seed or each) before saving.');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('leaving with an unsaved name still prompts', async () => {
    const router = renderNewProduct();
    fireEvent.change(await screen.findByLabelText(/Product Name/), { target: { value: 'New Chem' } });

    fireEvent.click(screen.getByRole('link', { name: 'Elsewhere' }));
    expect(await screen.findByText('Unsaved Changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Stay/ }));
    await waitFor(() => expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/products/new');
  });

  it.each([
    ['Product Name', '   ', 'Enter a product name.'],
    ['Rate Per Acre', '-1', 'Rate Per Acre must be zero or greater.'],
    ['REI (hours)', '12.5', 'REI (hours) must be a whole number of zero or greater.'],
    ['PHI (days)', '12.5', 'PHI (days) must be a whole number of zero or greater.'],
    ['EPA Registration', 'bad-epa', 'Enter an EPA number in a format like 524-475 or 100-1234-5905. This checks format only, not registration validity.'],
  ])('refuses invalid %s before requesting a save', async (label, value, message) => {
    renderNewProduct();
    if (label !== 'Product Name') {
      fireEvent.change(await screen.findByLabelText(/Product Name/), { target: { value: 'Valid Chem' } });
    }
    fireEvent.change(screen.getByLabelText(label === 'Product Name' ? /Product Name/ : label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: /Create Product/ }));
    expect(mockToast).toHaveBeenCalledWith('error', message);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('offers active categories including Seed without free typing and keeps a first form choice', async () => {
    mockFrom.mockImplementation((table: string) => chain(table === 'product_categories'
      ? [{ name: 'Herbicide', is_active: true, sort_order: 10 },
        { name: 'Seed', is_active: true, sort_order: 20 },
        { name: 'Old', is_active: false, sort_order: 30 }]
      : [{ id: 'product-1' }]));
    renderNewProduct();
    const category = await screen.findByLabelText('Category');
    await waitFor(() => expect(category.querySelectorAll('option').length).toBe(3));
    expect(category).toHaveTextContent('Seed');
    expect(category).not.toHaveTextContent('Old');
    fireEvent.change(await screen.findByLabelText(/Product Name/), { target: { value: '  Seed Chem  ' } });
    fireEvent.change(category, { target: { value: 'Seed' } });
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: '  SKU-1  ' } });
    fireEvent.change(screen.getByLabelText('EPA Registration'), { target: { value: '' } });
    const form = screen.getByText('Product Form').parentElement!.querySelector('select')!;
    fireEvent.change(form, { target: { value: 'dry' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Product/ }));
    await screen.findByText('New product page');
    const [parentFields, size] = mockCreate.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(parentFields).toEqual(expect.objectContaining({ name: 'Seed Chem', category: 'Seed', product_form: 'dry' }));
    expect(size).toEqual(expect.objectContaining({
      product_name: 'Seed Chem', sku: 'SKU-1', epa_registration: null, product_form: 'dry',
    }));
    expect(size).not.toHaveProperty('category');
  });

  it('clears only incompatible units when choosing a form for the first time', async () => {
    mockFrom.mockImplementation((table: string) => chain(table === 'unit_conversions'
      ? [
        { id: 'gal', unit: 'Gal', unit_type: 'liquid' },
        { id: 'lb', unit: 'Lb', unit_type: 'dry' },
      ] : [{ id: 'product-1' }]));
    renderNewProduct();
    const container = await screen.findByLabelText('Unit');
    await waitFor(() => expect(container.querySelectorAll('option').length).toBe(3));
    const inventory = screen.getByText('Inventory Unit').parentElement!.querySelector('select')!;
    const rate = screen.getByText('Rate Unit').parentElement!.querySelector('select')!;
    fireEvent.change(container, { target: { value: 'Gal' } });
    fireEvent.change(inventory, { target: { value: 'Lb' } });
    fireEvent.change(rate, { target: { value: 'Lb' } });
    fireEvent.change(screen.getByLabelText('Product Form'), { target: { value: 'dry' } });
    expect(container).toHaveValue('');
    expect(inventory).toHaveValue('Lb');
    expect(rate).toHaveValue('Lb');
    fireEvent.change(screen.getByLabelText('Product Form'), { target: { value: 'liquid' } });
    expect(inventory).toHaveValue('');
    expect(rate).toHaveValue('Lb');
  });
});
