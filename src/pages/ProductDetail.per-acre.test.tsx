/**
 * ProductDetail.per-acre.test.tsx — verifies the corrected per-acre price
 * (products.tierN_price_per_acre) is now displayed under each pricing tier.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mockSavedForm = vi.hoisted(() => ({ value: 'liquid' as 'liquid' | 'dry' | 'seed' | 'each' | null }));
const mockStockUnit = vi.hoisted(() => ({ value: 'gal' as string | null }));

// The Vendors section has its own tests; these page tests do not mock its reads.
vi.mock('../components/products/ProductVendorsSection', () => ({ default: () => null }));
vi.mock('../lib/db', async () => {
  const { hasRpcCode, RpcErrorCodes } = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  const mockProduct = {
    id: 'test-product-id',
    product_name: 'Test Product',
    sku: 'TP-001',
    category: 'Herbicide',
    vendor: 'TestVendor',
    manufacturer: 'TestMfr',
    container_size: 2.5,
    unit_size: '2.5 gal',
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
    tier1_price: 65, tier1_margin: null, tier1_gross_margin: 0.2,
    tier2_price: 60, tier2_margin: null, tier2_gross_margin: 0.18,
    tier3_price: 55, tier3_margin: null, tier3_gross_margin: 0.15,
    // The columns that were unit-fixed 2026-07-03 and previously shown nowhere.
    tier1_price_per_acre: 12.5, tier2_price_per_acre: 10.25, tier3_price_per_acre: 8,
    suggested_rate: '2 oz/acre',
    rate_per_acre: 2,
    rate_unit: 'oz',
    notes: 'Apply in early spring.',
    internal_notes: 'Vendor price locked through Q2.',
    is_active: true,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  };

  function chainable(resolveWith: unknown = { data: [], error: null }) {
    const builder: Record<string, unknown> = {};
    let _resolve = resolveWith;
    const self = () => builder;
    const methods = [
      'select', 'insert', 'update', 'upsert', 'delete',
      'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'or', 'not', 'match',
      'order', 'limit', 'range', 'single', 'csv', 'explain',
    ];
    for (const m of methods) builder[m] = vi.fn(self);
    builder.maybeSingle = vi.fn(() => {
      _resolve = { data: {
        ...mockProduct,
        product_form: mockSavedForm.value,
        inventory_unit: mockStockUnit.value,
        rate_unit: mockSavedForm.value === 'seed' ? 'Lb' : mockProduct.rate_unit,
      }, error: null };
      return builder;
    });
    builder.then = vi.fn((resolve: (v: unknown) => void) => {
      Promise.resolve(_resolve).then(resolve);
      return builder;
    });
    return builder;
  }

  return {
    supabase: {
      from: vi.fn((table: string) => {
        if (table === 'products') {
          return chainable({ data: [mockProduct], error: null });
        }
        if (table === 'unit_conversions') {
          return chainable({ data: [
            { id: '1', unit: 'Gal', factor_oz: 128, unit_type: 'liquid' },
            { id: '2', unit: 'Lb', factor_oz: 16, unit_type: 'dry' },
            { id: '3', unit: 'Ea', factor_oz: 1, unit_type: 'both' },
            { id: '4', unit: 'Unit', factor_oz: 1, unit_type: 'both' },
          ], error: null });
        }
        return chainable({ data: [], error: null });
      }),
      rpc: vi.fn(() => chainable()),
    },
    checkMutationResult: vi.fn(),
    hasRpcCode,
    RpcErrorCodes,
  };
});

// PAR-1: the page asks for the product's parent; this product has none.
vi.mock('../lib/productParents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/productParents')>()),
  getParentOfProduct: async () => null,
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Admin cost comes from get_admin_cost_fields; the fixtures already carry it, so pass rows through.
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCost: async (_table: string, row: unknown) => row,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: 'admin',
    profile: { id: 'user-id', full_name: 'Test User' },
  }),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'test-product-id' }),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/products/test-product-id' }),
}));

vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({
    hasUnsavedChanges: false,
    markDirty: vi.fn(),
    markClean: vi.fn(),
    showModal: false,
    handleClose: vi.fn(),
    confirmClose: vi.fn(),
    cancelClose: vi.fn(),
    setShowModal: vi.fn(),
  }),
}));

vi.mock('../lib/activityLogger', () => ({
  logActivity: vi.fn(),
}));

import ProductDetail from './ProductDetail';

describe('ProductDetail — per-acre price display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSavedForm.value = 'liquid';
    mockStockUnit.value = 'gal';
  });

  it('shows the corrected per-acre price under each tier', async () => {
    render(<ProductDetail />);
    await screen.findByText('Grower Description');
    // One "Per acre (label rate):" label per tier (3 total)
    expect(screen.getAllByText(/Per acre \(label rate\)/).length).toBe(3);
    expect(screen.getByText('$12.50 / acre')).toBeTruthy();
    expect(screen.getByText('$10.25 / acre')).toBeTruthy();
    expect(screen.getByText('$8.00 / acre')).toBeTruthy();
  });

  it('locks saved form and units while showing an existing container unit', async () => {
    render(<ProductDetail />);
    const form = await screen.findByLabelText('Product Form');
    expect(form).toBeDisabled();
    const container = screen.getByLabelText('Unit');
    expect(container).toBeDisabled();
    expect(container).toHaveTextContent('jug (existing)');
    const inventory = screen.getByText('Inventory Unit').parentElement!.querySelector('select');
    expect(inventory).toBeDisabled();
    expect(inventory).toHaveTextContent('gal (existing)');
  });

  it('keeps saved units and the rate unit when a first form is chosen', async () => {
    mockSavedForm.value = null;
    render(<ProductDetail />);
    const form = await screen.findByLabelText('Product Form');
    const container = screen.getByLabelText('Unit');
    const inventory = screen.getByText('Inventory Unit').parentElement!.querySelector('select');
    const rate = screen.getByText('Rate Unit').parentElement!.querySelector('select');
    fireEvent.change(form, { target: { value: 'dry' } });
    expect(container).toHaveValue('jug');
    expect(inventory).toHaveValue('gal');
    expect(rate).toHaveValue('oz');
  });

  it('offers four forms and only Lb and Unit for Seed', async () => {
    mockSavedForm.value = null;
    render(<ProductDetail />);
    const form = await screen.findByLabelText('Product Form');
    expect([...form.querySelectorAll('option')].map((option) => option.value)).toEqual(['', 'liquid', 'dry', 'seed', 'each']);
    fireEvent.change(form, { target: { value: 'seed' } });
    const inventory = screen.getByText('Inventory Unit').parentElement!.querySelector('select')!;
    expect([...inventory.querySelectorAll('option')].filter((option) => option.value && !option.textContent?.includes('(existing)')).map((option) => option.value)).toEqual(['Lb', 'Unit']);
  });

  it('offers only Lb as the rate unit for Seed stocked in Lb', async () => {
    mockSavedForm.value = 'seed';
    mockStockUnit.value = 'Lb';
    render(<ProductDetail />);
    const rate = await screen.findByText('Rate Unit');
    const picker = rate.parentElement!.querySelector('select')!;
    expect([...picker.querySelectorAll('option')].map((option) => option.value)).toEqual(['', 'Lb']);
  });

  it('clears a Seed rate unit when its stock unit changes', async () => {
    mockSavedForm.value = null;
    mockStockUnit.value = null;
    render(<ProductDetail />);
    await screen.findByText('Rate Unit');
    fireEvent.change(screen.getByLabelText('Product Form'), { target: { value: 'seed' } });
    const inventory = screen.getByText('Inventory Unit').parentElement!.querySelector('select')!;
    const rate = screen.getByText('Rate Unit').parentElement!.querySelector('select')!;
    fireEvent.change(inventory, { target: { value: 'Lb' } });
    fireEvent.change(rate, { target: { value: 'Lb' } });
    fireEvent.change(inventory, { target: { value: 'Unit' } });
    expect(rate).toHaveValue('');
    expect([...rate.querySelectorAll('option')].map((option) => option.value)).toEqual(['', 'Unit']);
  });
});
