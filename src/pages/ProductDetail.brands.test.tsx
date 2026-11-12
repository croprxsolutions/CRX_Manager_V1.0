import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Product, ProductBrand } from '../types';

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
  optionLoadFailed: false,
  created: null as { parent: Record<string, unknown>; size: Record<string, unknown> } | null,
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

// The Vendors section has its own tests; these page tests do not mock its reads.
vi.mock('../components/products/ProductVendorsSection', () => ({ default: () => null }));
vi.mock('../lib/db', async () => {
  const { hasRpcCode, RpcErrorCodes } = await vi.importActual<typeof import('../lib/db')>('../lib/db');
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
  const insertProduct = vi.fn((rows: Record<string, unknown>[]) => {
    H.savedPayload = rows[0];
    H.product = baseProduct({ ...rows[0], id: 'product-1' } as Partial<Product>);
    return chainable({ data: [{ id: 'product-1' }], error: null });
  });

  return {
    supabase: {
      from,
      functions: { invoke: H.invoke },
    },
    supabaseUntyped: { rpc: H.rpc, from: () => ({ update: updateProduct, insert: insertProduct }) },
    assertRpcResult: (data: unknown) => {
      if (data == null) throw new Error('RPC returned no data');
      return data;
    },
    checkMutationResult: vi.fn(),
    hasRpcCode,
    RpcErrorCodes,
    sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});

// PAR-1: a new product is created through the parent RPC; these products have no parent.
vi.mock('../lib/productParents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/productParents')>()),
  getParentOfProduct: async () => null,
  addProductSize: vi.fn(),
  createProductWithParent: async (parent: Record<string, unknown>, size: Record<string, unknown>) => {
    H.created = { parent, size };
    H.product = baseProduct({ ...size, category: parent.category, use_timings: parent.use_timings, id: 'product-1' } as Partial<Product>);
    return { parent_id: 'parent-1', parent_version: 1, product_id: 'product-1', event_id: 1 };
  },
}));

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
    getKeyFor: () => 'create-key',
    resetKeyFor: vi.fn(),
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
  listProductUseTimingOptions: async () => {
    if (H.optionLoadFailed) throw new Error('options unavailable');
    return [
      { code: 'pre_emerge_corn', label: 'Pre-Emerge Corn', timing_code: 'pre_emergence', crop: 'corn', category: 'Herbicide', is_active: true, sort_order: 20 },
      { code: 'post_emerge_soybeans', label: 'Post-Emerge Soybeans', timing_code: 'post_emergence', crop: 'soybeans', category: 'Herbicide', is_active: true, sort_order: 60 },
      { code: 'foliar', label: 'Foliar', timing_code: 'foliar', crop: null, category: 'Foliar Fertilizer', is_active: true, sort_order: 90 },
    ];
  },
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

/** The category stays read-only until the page knows the product has no parent. */
const parentChecked = () => waitFor(() => expect(screen.getByLabelText('Category')).toBeEnabled());

describe('ProductDetail brands section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.routeId = 'product-1';
    H.product = baseProduct();
    H.savedPayload = null;
    H.created = null;
    H.optionLoadFailed = false;
  });

  it('names a brand on a cancelled registration in the page banner', async () => {
    H.rpc.mockImplementation(async (name: string) => (name === 'get_epa_registrations'
      ? { data: [{ epa_registration: '524-475', registration_status: 'cancelled', cancelled_on: null }], error: null }
      : { data: null, error: null }));
    render(<ProductDetail />);
    await screen.findByTestId('brands-section');
    const props = H.brandSection.mock.lastCall![0] as { onBrandsChange: (b: ProductBrand[] | null | undefined) => void };
    act(() => props.onBrandsChange([{ brand_name: 'Slam 5.4', epa_registration: '524-475' } as ProductBrand]));
    expect(await screen.findByTestId('cancelled-registration-banner')).toHaveTextContent('Brand Slam 5.4: EPA Reg. No. 524-475, cancelled (date not recorded).');
  });

  it('after switching products, the previous brands never show under the new one', async () => {
    H.rpc.mockImplementation(async (name: string) => (name === 'get_epa_registrations'
      ? { data: [{ epa_registration: '524-475', registration_status: 'cancelled', cancelled_on: null }], error: null }
      : { data: null, error: null }));
    const view = render(<ProductDetail />);
    await screen.findByTestId('brands-section');
    const first = H.brandSection.mock.lastCall![0] as { onBrandsChange: (b: ProductBrand[] | null | undefined) => void };
    act(() => first.onBrandsChange([{ brand_name: 'Slam 5.4', epa_registration: '524-475' } as ProductBrand]));
    expect(await screen.findByTestId('cancelled-registration-banner')).toHaveTextContent('Brand Slam 5.4');
    H.routeId = 'product-2';
    H.product = baseProduct({ id: 'product-2', product_name: 'Other Product' });
    view.rerender(<ProductDetail />);
    expect(await screen.findByTestId('brands-section')).toHaveTextContent('product-2: Other Product');
    expect(screen.queryByTestId('cancelled-registration-banner')).toBeNull();
    expect(screen.getByText('Checking EPA registration status…')).toBeInTheDocument();
  });

  it('a brand list still loading after the check timeout shows "could not check"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<ProductDetail />);
      await screen.findByTestId('brands-section');
      const props = H.brandSection.mock.lastCall![0] as { onBrandsChange: (b: ProductBrand[] | null | undefined) => void };
      act(() => props.onBrandsChange(undefined));
      expect(screen.queryByText(/Could not check/)).toBeNull();
      act(() => { vi.advanceTimersByTime(15_000); });
      expect(screen.getByText(/Could not check whether all of this product's EPA registrations are cancelled/)).toBeInTheDocument();
      act(() => props.onBrandsChange([]));
      expect(screen.queryByText(/Could not check/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    await parentChecked();
    expect(within(group).queryByRole('checkbox', { name: 'Foliar' })).toBeNull();
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Pre-Emerge Corn' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Post-Emerge Soybeans' }));
    fireEvent.click(screen.getAllByRole('button', { name: /^Save/ })[0]);
    await waitFor(() => expect(H.savedPayload?.use_timings).toEqual(['pre_emerge_corn', 'post_emerge_soybeans']));
    expect(H.savedPayload).not.toHaveProperty('use_timing');
    // An untouched vendor is not re-sent (WP-PM-15a), so an open page never overwrites a newer one.
    expect(H.savedPayload).not.toHaveProperty('vendor');
    first.unmount();
    render(<ProductDetail />);
    const reloaded = await screen.findByRole('group', { name: 'Use Timing' });
    expect(within(reloaded).getByRole('checkbox', { name: 'Pre-Emerge Corn' })).toBeChecked();
    expect(within(reloaded).getByRole('checkbox', { name: 'Post-Emerge Soybeans' })).toBeChecked();
  });

  it('locks the vendor of an existing product; it follows the preferred vendor', async () => {
    render(<ProductDetail />);
    expect(await screen.findByRole('combobox', { name: 'Vendor' })).toBeDisabled();
  });

  it('does not re-send untouched label fields, so an open page never overwrites a Label Review commit', async () => {
    H.product = baseProduct({
      epa_registration: '100-1', signal_word: 'Caution', rei_hours: 12, phi_days: 30,
      max_label_rate: 32, max_label_rate_unit: 'fl oz/acre',
    });
    render(<ProductDetail />);
    const group = await screen.findByRole('group', { name: 'Use Timing' });
    await parentChecked();
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Pre-Emerge Corn' }));
    fireEvent.click(screen.getAllByRole('button', { name: /^Save/ })[0]);
    await waitFor(() => expect(H.savedPayload?.use_timings).toEqual(['pre_emerge_corn']));
    for (const field of ['epa_registration', 'signal_word', 'rei_hours', 'phi_days', 'max_label_rate', 'max_label_rate_unit']) {
      expect(H.savedPayload).not.toHaveProperty(field);
    }
  });

  it('still saves a label field that was changed on the page', async () => {
    H.product = baseProduct({ epa_registration: '100-1', signal_word: 'Caution' });
    render(<ProductDetail />);
    fireEvent.change(await screen.findByDisplayValue('Caution'), { target: { value: 'Warning' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^Save/ })[0]);
    await waitFor(() => expect(H.savedPayload?.signal_word).toBe('Warning'));
    expect(H.savedPayload).not.toHaveProperty('epa_registration');
  });

  it('still saves a label field that was cleared on the page', async () => {
    H.product = baseProduct({ signal_word: 'Caution' });
    render(<ProductDetail />);
    fireEvent.change(await screen.findByDisplayValue('Caution'), { target: { value: '' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^Save/ })[0]);
    await waitFor(() => expect(H.savedPayload).toHaveProperty('signal_word', null));
  });

  it('names each label dropdown for screen readers', async () => {
    render(<ProductDetail />);
    for (const name of ['Signal Word', 'Type', 'Inventory Unit', 'Rate Unit']) {
      expect(await screen.findByRole('combobox', { name })).toBeInTheDocument();
    }
  });

  it('names the read-only Max Label Rate value for screen readers', async () => {
    H.product = baseProduct({ max_label_rate: 32, max_label_rate_unit: 'fl oz/acre' });
    render(<ProductDetail />);
    expect(await screen.findByRole('definition', { name: 'Max Label Rate' })).toHaveTextContent('32 fl oz/acre');
  });

  it('sends the vendor when creating a product', async () => {
    H.routeId = 'new';
    render(<ProductDetail />);
    fireEvent.change(screen.getByRole('textbox', { name: /Product Name/ }), { target: { value: 'New Herbicide' } });
    fireEvent.change(screen.getByLabelText('Product Form'), { target: { value: 'liquid' } });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Vendor' }), { target: { value: 'New Vendor' } });
    await screen.findByRole('option', { name: 'Herbicide' });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Herbicide' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^(Save|Create)/ })[0]);
    await waitFor(() => expect(H.created?.size.vendor).toBe('New Vendor'));
    expect(H.created?.parent.category).toBe('Herbicide');
  });

  it('creates a product with two timings and reloads both', async () => {
    H.routeId = 'new';
    const created = render(<ProductDetail />);
    fireEvent.change(screen.getByRole('textbox', { name: /Product Name/ }), { target: { value: 'New Herbicide' } });
    fireEvent.change(screen.getByLabelText('Product Form'), { target: { value: 'liquid' } });
    await screen.findByRole('option', { name: 'Herbicide' });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Herbicide' } });
    const group = await screen.findByRole('group', { name: 'Use Timing' });
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Pre-Emerge Corn' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Post-Emerge Soybeans' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Product' }));
    await waitFor(() => expect(H.created?.parent.use_timings).toEqual(['pre_emerge_corn', 'post_emerge_soybeans']));
    expect(H.created?.size).not.toHaveProperty('use_timings');
    expect(H.created?.parent).not.toHaveProperty('use_timing');
    created.unmount();
    H.routeId = 'product-1';
    render(<ProductDetail />);
    const saved = await screen.findByRole('group', { name: 'Use Timing' });
    expect(within(saved).getByRole('checkbox', { name: 'Pre-Emerge Corn' })).toBeChecked();
    expect(within(saved).getByRole('checkbox', { name: 'Post-Emerge Soybeans' })).toBeChecked();
  });

  it('shows saved timings read only when options fail to load', async () => {
    H.product = baseProduct({ use_timings: ['pre_emerge_corn', 'post_emerge_soybeans'], use_timing: 'Pre-Emerge Corn; Post-Emerge Soybeans' });
    H.optionLoadFailed = true;
    render(<ProductDetail />);
    expect(await screen.findByText('Use timings could not be loaded. Refresh before changing them.')).toBeInTheDocument();
    expect(screen.getByText('Pre-Emerge Corn; Post-Emerge Soybeans')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Use Timing' })).queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('cancels or confirms clearing timings on a category change', async () => {
    H.product = baseProduct({ use_timings: ['pre_emerge_corn'] });
    render(<ProductDetail />);
    const category = await screen.findByRole('combobox', { name: 'Category' });
    await parentChecked();
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
