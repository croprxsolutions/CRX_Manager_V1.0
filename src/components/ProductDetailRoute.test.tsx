import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

const { mockProductRead, mockProductUpdate, mockToast } = vi.hoisted(() => ({
  mockProductRead: vi.fn(),
  mockProductUpdate: vi.fn(),
  mockToast: vi.fn(),
}));

const productX = {
  id: '11111111-1111-4111-8111-111111111111',
  product_name: 'Product X',
  sku: 'X-001',
  category: 'Herbicide',
  vendor: 'Test Supplier',
  manufacturer: 'Test Manufacturer',
  container_size: 2.5,
  unit_size: 'gal',
  inventory_unit: 'gal',
  container_unit: 'jug',
  container_type: 'Jug',
  epa_registration: null,
  is_rup: false,
  signal_word: null,
  rei_hours: null,
  phi_days: null,
  product_form: 'liquid',
  current_cost: 50,
  cost_updated_date: null,
  tier1_price: 62.5,
  tier1_margin: 0.2,
  tier1_gross_margin: 0.25,
  tier2_price: 58.82,
  tier2_margin: 0.15,
  tier2_gross_margin: 0.1765,
  tier3_price: 55.56,
  tier3_margin: 0.1,
  tier3_gross_margin: 0.1111,
  tier1_price_per_acre: null,
  tier2_price_per_acre: null,
  tier3_price_per_acre: null,
  rate_per_acre: null,
  rate_unit: null,
  suggested_rate: null,
  notes: null,
  internal_notes: null,
  quoting_notes: 'X quote guidance',
  is_active: true,
  pricing_version: 7,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};
const productY = {
  ...productX,
  id: '22222222-2222-4222-8222-222222222222',
  product_name: 'Product Y',
  tier1_margin: 0.3,
  quoting_notes: 'Y quote guidance',
};

vi.mock('../lib/db', () => {
  const from = (_table: string) => {
    let selectedId = '';
    const query = {
      select: () => query,
      eq: (column: string, value: string) => {
        if (column === 'id') selectedId = value;
        return query;
      },
      neq: () => query,
      order: () => query,
      limit: () => query,
      update: (...args: unknown[]) => {
        mockProductUpdate(...args);
        return query;
      },
      maybeSingle: () => mockProductRead(selectedId),
      then: (resolve: (value: { data: unknown[]; error: null }) => void) => {
        Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return query;
  };
  return {
    supabase: { from, rpc: vi.fn(), functions: { invoke: vi.fn() } },
    supabaseUntyped: { from },
    sanitizeError: (error: unknown) => error instanceof Error ? error.message : String(error),
    assertRpcResult: (value: unknown) => value,
    checkMutationResult: vi.fn(),
  };
});
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCost: async (_table: string, product: unknown) => product,
}));
vi.mock('../lib/productCostBasis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/productCostBasis')>()),
  getProductCostBasisWorkspace: async (id: string) => ({
    enabled: false,
    product: { id, pricing_version: 7 },
    current_basis: null,
    supplier_candidates: [],
    purchase_candidates: [],
  }),
}));
vi.mock('../components/products/ProductPriceHistory', () => ({ default: () => null }));
vi.mock('../components/products/ProductSellPriceHistory', () => ({ default: () => null }));
vi.mock('../components/products/ProductBrandsSection', () => ({ default: () => null }));
vi.mock('../components/products/ProductMarginFloorCard', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: 'admin',
    profile: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', full_name: 'Test Admin' },
  }),
}));
vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ state: 'unblocked' }),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

import ProductDetailRoute from './ProductDetailRoute';

function mountAt(id: string) {
  const router = createMemoryRouter([
    { path: '/products/:id', element: <ProductDetailRoute /> },
    { path: '/products', element: <div>Products list</div> },
  ], { initialEntries: [`/products/${id}`] });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProductRead.mockImplementation(async (id: string) => ({
    data: id === productX.id ? productX : id === productY.id ? productY : null,
    error: null,
  }));
});

describe('ProductDetailRoute', () => {
  it('replaces X with Y data and drops X margin draft', async () => {
    const router = mountAt(productX.id);
    await screen.findByRole('heading', { name: 'Product X' });
    fireEvent.change(screen.getByLabelText('Pricing mode'), { target: { value: 'margin_driven' } });
    fireEvent.change(screen.getByLabelText('Tier 1 net margin percent'), { target: { value: '37' } });
    expect(screen.getByLabelText('Tier 1 net margin percent')).toHaveValue(37);

    await act(async () => { await router.navigate(`/products/${productY.id}`); });
    await screen.findByRole('heading', { name: 'Product Y' });
    expect(screen.getByLabelText('Tier 1 net margin percent')).toHaveValue(30);
    expect(screen.getByLabelText('Quoting Notes')).toHaveValue('Y quote guidance');
    expect(screen.queryByDisplayValue('X quote guidance')).not.toBeInTheDocument();
  });

  it('finishes loading Y even when an abandoned X load fails later', async () => {
    let finishX!: (result: { data: null; error: Error }) => void;
    const pendingX = new Promise<{ data: null; error: Error }>((resolve) => { finishX = resolve; });
    mockProductRead.mockImplementation((id: string) => id === productX.id
      ? pendingX
      : Promise.resolve({ data: productY, error: null }));

    const router = mountAt(productX.id);
    await act(async () => { await router.navigate(`/products/${productY.id}`); });
    expect(await screen.findByRole('heading', { name: 'Product Y' })).toBeInTheDocument();

    await act(async () => { finishX({ data: null, error: new Error('old load failed') }); });
    expect(screen.getByRole('heading', { name: 'Product Y' })).toBeInTheDocument();
    expect(screen.getByLabelText('Quoting Notes')).toHaveValue('Y quote guidance');
  });

  it('shows not found without X details or Save when Y fails, and Back navigates', async () => {
    const router = mountAt(productX.id);
    fireEvent.change(await screen.findByLabelText('Quoting Notes'), { target: { value: 'X-only edit' } });
    mockProductRead.mockImplementation(async (id: string) => id === productY.id
      ? { data: null, error: new Error('load failed') }
      : { data: productX, error: null });

    await act(async () => { await router.navigate(`/products/${productY.id}`); });
    expect(await screen.findByText('Product not found')).toBeInTheDocument();
    expect(screen.queryByLabelText('Quoting Notes')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
    expect(mockProductUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Products' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/products'));
    expect(screen.getByText('Products list')).toBeInTheDocument();
  });

  it('opens a blank New Product form after X', async () => {
    const router = mountAt(productX.id);
    await screen.findByRole('heading', { name: 'Product X' });
    fireEvent.change(screen.getByLabelText(/Product Name/), { target: { value: 'X-only edit' } });

    await act(async () => { await router.navigate('/products/new'); });
    expect(await screen.findByRole('heading', { name: 'New Product' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Product Name/)).toHaveValue('');
    expect(screen.getByLabelText('Quoting Notes')).toHaveValue('');
    expect(screen.queryByDisplayValue('X-only edit')).not.toBeInTheDocument();
  });

  it('is the element the page list routes products/:id through', () => {
    const source = readFileSync('src/appPages.tsx', 'utf8');
    expect(source).toMatch(/\{ path: 'products\/:id', element: <ProductDetailRoute \/> \}/);
  });
});
