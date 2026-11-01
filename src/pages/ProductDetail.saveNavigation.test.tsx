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
vi.mock('react-router-dom', async () => vi.importActual('react-router'));

const { mockFrom, mockToast } = vi.hoisted(() => ({ mockFrom: vi.fn(), mockToast: vi.fn() }));

vi.mock('../lib/db', async () => {
  const { assertRpcResult } = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    supabase: { from: mockFrom, rpc: vi.fn(), functions: { invoke: vi.fn() } },
    supabaseUntyped: { from: mockFrom, rpc: vi.fn() },
    checkMutationResult: vi.fn(),
    assertRpcResult,
    sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});
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
  useIdempotencyKey: () => ({ getKey: () => 'key', resetKey: vi.fn() }),
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
  self.maybeSingle = () => Promise.resolve({ data: null, error: null });
  const promise = Promise.resolve({ data, error: null });
  self.then = promise.then.bind(promise);
  return self;
}

function renderNewProduct() {
  const router = createMemoryRouter(
    [{
      element: <><Link to="/elsewhere">Elsewhere</Link><Outlet /></>,
      children: [
        { path: '/products', element: <p>Products list page</p> },
        { path: '/products/:id', element: <ProductDetail /> },
        { path: '/elsewhere', element: <p>Elsewhere page</p> },
      ],
    }],
    { initialEntries: ['/products/new'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('ProductDetail — leaving a new product', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => chain([{ id: 'product-1' }]));
  });

  it('a successful create moves to the list with no Unsaved Changes prompt', async () => {
    const router = renderNewProduct();
    fireEvent.change(await screen.findByLabelText(/Product Name/), { target: { value: 'New Chem' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Product/ }));

    await screen.findByText('Products list page');
    expect(router.state.location.pathname).toBe('/products');
    expect(mockToast).toHaveBeenCalledWith('success', 'Product created');
    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
  });

  it('locks the form while a new product saves', async () => {
    let finish: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => { finish = resolve; });
    const reads = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => {
      const query = reads(table) as Record<string, unknown>;
      query.insert = () => ({ select: () => pending });
      return query;
    });
    renderNewProduct();
    const name = await screen.findByLabelText(/Product Name/);
    fireEvent.change(name, { target: { value: 'New Chem' } });
    expect(name).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Create Product/ }));

    await waitFor(() => expect(name).toBeDisabled());
    finish({ data: [{ id: 'product-1' }], error: null });
    await screen.findByText('Products list page');
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
});
