/**
 * Product Master Wave 2, piece 2: each read on the Products list says when it failed, offers
 * Try again, and the actions that need it stay off until it loads. A failed read never shows
 * an empty list as if there were no products.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  products: [] as Array<Record<string, unknown>>,
  productsError: null as Error | null,
  toast: vi.fn(),
  fetchMarginFloors: vi.fn(),
  listProductCategories: vi.fn(),
  getProductParents: vi.fn(),
}));

const product = {
  id: '11111111-1111-4111-8111-111111111111',
  product_name: 'Loose Product',
  sku: 'LOOSE-001',
  category: 'Herbicide',
  vendor: 'Test Supplier',
  current_cost: 50,
  tier1_price: 62.5,
  tier2_price: 55.56,
  tier3_price: 66.67,
  pricing_version: 7,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const categories = [
  { name: 'Herbicide', is_active: true, sort_order: 10 },
  { name: 'Seed', is_active: true, sort_order: 20 },
];

// productsError fails product reads only; an update (a save) always succeeds.
function chainable(resolveWith: () => unknown) {
  const builder: Record<string, unknown> = {};
  let isUpdate = false;
  for (const method of ['select', 'eq', 'is', 'in', 'or', 'order', 'limit', 'range']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.update = vi.fn(() => { isUpdate = true; return builder; });
  builder.then = vi.fn((resolve: (value: unknown) => void) => {
    Promise.resolve(isUpdate ? { data: [{ id: product.id }], error: null } : resolveWith()).then(resolve);
  });
  return builder;
}

vi.mock('../components/products/TypedBrandReview', () => ({ default: () => null }));
vi.mock('../components/deliveries/DeliveriesMissingBrands', () => ({ default: () => null }));
vi.mock('../lib/db', () => ({
  supabase: {
    from: vi.fn(() => chainable(() => (mocks.productsError
      ? { data: null, error: mocks.productsError }
      : { data: mocks.products, error: null }))),
  },
  sanitizeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  checkMutationResult: vi.fn((result: { error: unknown }) => { if (result.error) throw result.error; }),
}));
vi.mock('../lib/marginFloors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/marginFloors')>()),
  fetchMarginFloors: mocks.fetchMarginFloors,
}));
vi.mock('../lib/productSetup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/productSetup')>()),
  listProductCategories: mocks.listProductCategories,
}));
vi.mock('../lib/productParents', () => ({ getProductParents: mocks.getProductParents }));
vi.mock('../lib/productRateLock', () => ({ loadProductRateLock: async () => null }));
vi.mock('../components/products/ProductRateLockControl', () => ({ default: () => null }));
vi.mock('../components/products/BulkProductImport', () => ({ default: () => null }));
vi.mock('../components/products/ProductSetupWorkbookModal', () => ({ default: () => null }));
vi.mock('../components/products/RateReviewWorkbookModal', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'admin', profile: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', full_name: 'Test Admin' } }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }),
}));
vi.mock('../components/products/ProductsMobileList', () => ({ default: () => null }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

import Products from './Products';

const banner = () => screen.queryByRole('alert');
const tryAgain = () => within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' });

describe('Products list reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.products.splice(0, mocks.products.length, product);
    mocks.productsError = null;
    mocks.fetchMarginFloors.mockResolvedValue(new Map());
    mocks.listProductCategories.mockResolvedValue(categories);
    mocks.getProductParents.mockResolvedValue([]);
  });

  it('says the product list could not be loaded instead of "No products yet", and Try again loads it', async () => {
    mocks.productsError = new Error('offline');
    render(<Products />);
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No products yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /full price sheet/i })).toBeDisabled();
    mocks.productsError = null;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Loose Product')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download/i })).toBeEnabled();
  });

  it('names failed categories, keeps the category editor off, and Try again turns it on', async () => {
    mocks.listProductCategories.mockRejectedValueOnce(new Error('offline'));
    render(<Products />);
    await screen.findByText('Loose Product');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load product categories.');
    // The filter still offers the categories the rows use.
    expect(within(screen.getByLabelText('Filter by category')).getByRole('option', { name: 'Herbicide' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeDisabled();
    fireEvent.click(tryAgain());
    await waitFor(() => expect(banner()).not.toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeEnabled();
    // The configured-only category comes back to the filter once the catalog loads.
    expect(within(screen.getByLabelText('Filter by category')).getByRole('option', { name: 'Seed' })).toBeInTheDocument();
  });

  it('names failed product groups, keeps category edits and the pricing workbook off, and Try again turns them on', async () => {
    mocks.getProductParents.mockRejectedValueOnce(new Error('offline'));
    render(<Products />);
    await screen.findByText('Loose Product');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load product groups.');
    expect(screen.getByRole('button', { name: /full price sheet/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /pricing \.xlsx/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /review pricing file/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeDisabled();
    fireEvent.click(tryAgain());
    await waitFor(() => expect(banner()).not.toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /full price sheet/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /review pricing file/i })).toBeEnabled();
  });

  it('keeps the rows when a refresh fails, turns row actions off, and Try again brings them back', async () => {
    render(<Products />);
    await screen.findByText('Loose Product');
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    // A category save re-reads the list; that refresh fails.
    mocks.productsError = new Error('offline');
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'Seed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save (1)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the latest product list.');
    expect(screen.getByText('Loose Product')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /full price sheet/i })).toBeDisabled();
    mocks.productsError = null;
    fireEvent.click(tryAgain());
    await waitFor(() => expect(banner()).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download/i })).toBeEnabled();
  });
});
