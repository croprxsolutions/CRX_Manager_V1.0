import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Product } from '../types';

const H = vi.hoisted(() => ({
  product: {} as Product | null,
  routeId: 'product-1',
  invoke: vi.fn(),
  rpc: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  logActivity: vi.fn(),
  resetDraftKey: vi.fn(),
  brandSection: vi.fn(),
  savedPayload: null as Record<string, unknown> | null,
}));

function baseProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-1',
    product_name: 'Test Herbicide',
    sku: 'TEST-1',
    category: 'Herbicide',
    use_timings: [],
    vendor: 'Test Vendor',
    manufacturer: 'Current Manufacturer',
    container_size: 2.5,
    unit_size: 'gal',
    epa_registration: null,
    is_rup: false,
    signal_word: null,
    rei_hours: null,
    phi_days: null,
    product_form: 'liquid',
    inventory_unit: 'gal',
    container_unit: 'jug',
    container_type: 'Jug',
    current_cost: 50,
    cost_updated_date: null,
    tier1_price: 65,
    tier1_margin: null,
    tier1_gross_margin: null,
    tier2_price: 60,
    tier2_margin: null,
    tier2_gross_margin: null,
    tier3_price: 55,
    tier3_margin: null,
    tier3_gross_margin: null,
    tier1_price_per_acre: null,
    tier2_price_per_acre: null,
    tier3_price_per_acre: null,
    suggested_rate: null,
    rate_per_acre: null,
    rate_unit: null,
    max_label_rate: null,
    max_label_rate_unit: null,
    notes: null,
    internal_notes: null,
    quoting_notes: null,
    is_active: true,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
    pricing_version: overrides.pricing_version ?? 1,
  };
}

vi.mock('../lib/db', () => {
  function chainable(resolveWith: unknown) {
    const builder: Record<string, unknown> = {};
    let resolved = resolveWith;
    const self = () => builder;
    const methods = [
      'select', 'insert', 'update', 'upsert', 'delete',
      'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'or', 'not', 'match',
      'order', 'limit', 'range', 'single', 'csv', 'explain',
    ];
    for (const method of methods) builder[method] = vi.fn(self);
    builder.maybeSingle = vi.fn(() => {
      resolved = { data: H.product, error: null };
      return builder;
    });
    builder.then = vi.fn((resolve: (value: unknown) => void) => {
      Promise.resolve(resolved).then(resolve);
      return builder;
    });
    return builder;
  }

  const from = vi.fn((table: string) => table === 'products'
    ? chainable({ data: H.product ? [H.product] : [], error: null })
    : chainable({ data: [], error: null }));

  const updateProduct = vi.fn((payload: Record<string, unknown>) => {
    H.savedPayload = payload;
    H.product = { ...H.product!, ...payload } as Product;
    return chainable({ data: [{ id: H.product.id }], error: null });
  });

  return {
    supabase: {
      from,
      functions: { invoke: H.invoke },
    },
    supabaseUntyped: { rpc: H.rpc, from: () => ({ update: updateProduct }) },
    assertRpcResult: (data: unknown) => {
      if (data == null) throw new Error('RPC returned no data');
      return data;
    },
    checkMutationResult: vi.fn(),
  };
});

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: H.toast }),
}));

// Admin cost comes from get_admin_cost_fields; the fixtures already carry it, so pass rows through.
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCost: async (_table: string, row: unknown) => row,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: 'admin',
    profile: { id: 'admin-1', full_name: 'Admin User' },
  }),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: H.routeId }),
  useNavigate: () => H.navigate,
  useLocation: () => ({ pathname: `/products/${H.routeId}` }),
}));

vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ state: 'unblocked', proceed: vi.fn(), reset: vi.fn() }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({
    getKey: () => 'epa-draft-key',
    resetKey: H.resetDraftKey,
  }),
}));

vi.mock('../lib/activityLogger', () => ({
  logActivity: H.logActivity,
}));

vi.mock('../lib/productSetup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/productSetup')>()),
  listProductCategories: async () => [
    { name: 'Herbicide', is_active: true, sort_order: 10 },
    { name: 'Foliar Fertilizer', is_active: true, sort_order: 20 },
    { name: 'Insecticide', is_active: true, sort_order: 30 },
  ],
}));

vi.mock('../lib/productUseTimings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/productUseTimings')>()),
  listProductUseTimingOptions: async () => [
    { code: 'pre_emerge_corn', label: 'Pre-Emerge Corn', category: 'Herbicide', is_active: true, sort_order: 20 },
    { code: 'post_emerge_soybeans', label: 'Post-Emerge Soybeans', category: 'Herbicide', is_active: true, sort_order: 60 },
    { code: 'foliar', label: 'Foliar', category: 'Foliar Fertilizer', is_active: true, sort_order: 90 },
  ],
}));

// Supplier evidence has its own focused tests. Keep this suite scoped to the
// EPA draft mutation so its assertions are not polluted by the history read.
vi.mock('../components/products/ProductPriceHistory', () => ({
  default: () => null,
}));

vi.mock('../components/products/ProductBrandsSection', () => ({
  default: (props: { productId: string; productName: string }) => {
    H.brandSection(props);
    return <div data-testid="brands-section">{props.productId}: {props.productName}</div>;
  },
}));

import ProductDetail from './ProductDetail';

describe('ProductDetail brands section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.routeId = 'product-1';
    H.product = baseProduct();
    H.savedPayload = null;
  });

  it('shows the brands section for the product that loaded, with its saved name', async () => {
    render(<ProductDetail />);
    expect(await screen.findByTestId('brands-section')).toHaveTextContent('product-1: Test Herbicide');
  });

  it('withholds the brands section when the requested product is missing', async () => {
    H.routeId = 'product-2';
    H.product = null;
    render(<ProductDetail />);
    expect(await screen.findByText('Product not found')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Test Herbicide')).not.toBeInTheDocument();
    expect(screen.queryByTestId('brands-section')).not.toBeInTheDocument();
    expect(H.brandSection).not.toHaveBeenCalled();
  });

  it('saves two timing codes and shows both after reload', async () => {
    const first = render(<ProductDetail />);
    const group = await screen.findByRole('group', { name: 'Use Timing' });
    expect(within(group).queryByRole('checkbox', { name: 'Foliar' })).toBeNull();
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Pre-Emerge Corn' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Post-Emerge Soybeans' }));
    fireEvent.click(screen.getAllByRole('button', { name: /^Save/ })[0]);
    await waitFor(() => expect(H.savedPayload?.use_timings).toEqual(['pre_emerge_corn', 'post_emerge_soybeans']));
    expect(H.savedPayload).not.toHaveProperty('use_timing');
    first.unmount();
    render(<ProductDetail />);
    const reloaded = await screen.findByRole('group', { name: 'Use Timing' });
    expect(within(reloaded).getByRole('checkbox', { name: 'Pre-Emerge Corn' })).toBeChecked();
    expect(within(reloaded).getByRole('checkbox', { name: 'Post-Emerge Soybeans' })).toBeChecked();
  });

  it('cancels or confirms clearing timings on a category change', async () => {
    H.product = baseProduct({ use_timings: ['pre_emerge_corn'] });
    render(<ProductDetail />);
    const category = await screen.findByRole('combobox', { name: 'Category' });
    fireEvent.change(category, { target: { value: 'Insecticide' } });
    expect(screen.getByText('This product has use timings. Changing the category clears them.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(category).toHaveValue('Herbicide');
    expect(within(screen.getByRole('group', { name: 'Use Timing' })).getByRole('checkbox', { name: 'Pre-Emerge Corn' })).toBeChecked();
    fireEvent.change(category, { target: { value: 'Insecticide' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Category' }));
    expect(category).toHaveValue('Insecticide');
    fireEvent.click(screen.getAllByRole('button', { name: /^Save/ })[0]);
    await waitFor(() => expect(H.savedPayload?.use_timings).toEqual([]));
    expect(H.savedPayload?.category).toBe('Insecticide');
  });
});
