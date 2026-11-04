/**
 * BulkProductImport.test.tsx — Basic render + behavior tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Fully chainable Supabase query-builder mock
function chainable(resolveWith: unknown = { data: [], error: null }) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  const methods = [
    'select','insert','update','upsert','delete',
    'eq','neq','gt','gte','lt','lte','like','ilike','is','in','or','not','match',
    'order','limit','range','single','maybeSingle',
    'csv','explain',
  ];
  for (const m of methods) builder[m] = vi.fn(self);
  builder.then = vi.fn((resolve: (v: unknown) => void) => {
    Promise.resolve(resolveWith).then(resolve);
    return builder;
  });
  return builder;
}

vi.mock('../../lib/db', () => ({
  supabase: { from: vi.fn(() => chainable()), rpc: vi.fn(() => chainable()) },
  supabaseUntyped: { from: vi.fn(() => chainable({
    data: [{ name: 'Herbicide', is_active: true, sort_order: 1 },
      { name: 'Retired', is_active: false, sort_order: 2 }], error: null,
  })) },
}));

vi.mock('../../lib/documentOCR', () => ({
  isCSVFile: vi.fn(() => true),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

const { mockToast } = vi.hoisted(() => ({ mockToast: vi.fn() }));

import BulkProductImport from './BulkProductImport';
import { supabase } from '../../lib/db';
import {
  buildProductInsert,
  isProductImportStringField,
  isRetiredPricingColumn,
  type ParsedProduct,
} from './bulkProductImportSafety';

describe('BulkProductImport', () => {
  const defaultProps = { open: true, onClose: vi.fn(), onSuccess: vi.fn() };
  beforeEach(() => vi.clearAllMocks());

  it('renders when open', () => {
    render(<BulkProductImport {...defaultProps} />);
    expect(screen.getByText(/bulk product/i)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<BulkProductImport {...defaultProps} open={false} />);
    expect(screen.queryByText(/bulk product/i)).not.toBeInTheDocument();
  });

  it('shows file upload area', () => {
    render(<BulkProductImport {...defaultProps} />);
    expect(screen.getAllByText(/csv/i).length).toBeGreaterThan(0);
  });

  it('accepts CSV files only and makes the pricing boundary explicit', () => {
    render(<BulkProductImport {...defaultProps} />);

    expect(screen.getByLabelText('Select File')).toHaveAttribute('accept', '.csv,text/csv');
    expect(screen.getByText(/pricing columns are rejected/i)).toBeInTheDocument();
    expect(screen.queryByText(/vision ocr/i)).not.toBeInTheDocument();
  });

  it.each([
    'cost',
    'current_cost',
    'unit-cost-cents',
    'supplier_cost',
    'supplier-cost-cents',
    'price',
    'price_cents',
    'retail_price',
    'selling-price',
    'list price cents',
    'margin',
    'margin_percent',
    'gross_profit',
    'markup',
    'markup_pct',
    'tier1_price',
    'tier_2_margin',
    't3_gross_margin',
    'tier3_price_per_acre',
    'pricing_version',
  ])('rejects retired pricing header %s', (header) => {
    expect(isRetiredPricingColumn(header)).toBe(true);
  });

  it('does not mistake application-rate details for pricing', () => {
    expect(isRetiredPricingColumn('rate_per_acre')).toBe(false);
    expect(isRetiredPricingColumn('suggested_rate')).toBe(false);
  });

  it('blocks a supplier-cost CSV before preview or database insertion', async () => {
    render(<BulkProductImport {...defaultProps} />);
    const file = new File(['product_name,supplier_cost\nAtrazine,12.34'], 'supplier-prices.csv', {
      type: 'text/csv',
    });
    Object.defineProperty(file, 'text', {
      value: vi.fn().mockResolvedValue('product_name,supplier_cost\nAtrazine,12.34'),
    });

    fireEvent.change(screen.getByLabelText('Select File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        'error',
        expect.stringMatching(/pricing columns are not allowed.*supplier_cost/i),
      );
    });
    expect(screen.queryByText('Valid Products')).not.toBeInTheDocument();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it.each(['product_form', 'inventory_unit', 'container_unit', 'container_type'])(
    'preserves catalog metadata field %s during CSV parsing',
    (field) => {
      expect(isProductImportStringField(field)).toBe(true);
    },
  );

  it('builds the database insert from an explicit non-pricing allowlist', () => {
    const unsafeInput = {
      product_name: 'Safe Product',
      sku: 'SAFE-1',
      category: 'Herbicide',
      rate_per_acre: 2,
      current_cost: 10,
      tier1_price: 20,
      tier1_margin: 0.5,
      tier1_gross_margin: 1,
      tier1_price_per_acre: 40,
      pricing_version: 99,
    } as unknown as ParsedProduct;

    const insert = buildProductInsert(unsafeInput);

    expect(insert).toMatchObject({
      product_name: 'Safe Product',
      sku: 'SAFE-1',
      category: 'Herbicide',
      rate_per_acre: 2,
      is_active: true,
    });
    expect(insert).not.toHaveProperty('current_cost');
    expect(insert).not.toHaveProperty('tier1_price');
    expect(insert).not.toHaveProperty('tier1_margin');
    expect(insert).not.toHaveProperty('tier1_gross_margin');
    expect(insert).not.toHaveProperty('tier1_price_per_acre');
    expect(insert).not.toHaveProperty('pricing_version');
  });

  it('trims identity fields and sends blank optional text as NULL', () => {
    expect(buildProductInsert({
      product_name: '  Chem  ', sku: '  ', category: '  Herbicide  ', epa_registration: '', vendor: ' ', manufacturer: '  Acme  ',
    })).toMatchObject({
      product_name: 'Chem', sku: null, category: 'Herbicide', epa_registration: null, vendor: null, manufacturer: 'Acme',
    });
  });

  it('passes several use timing labels to the database as semicolon-separated text', () => {
    expect(buildProductInsert({
      product_name: 'Chem', category: 'Herbicide', use_timing: '  Pre-Emerge; Post-Emergence  ',
    }).use_timing).toBe('Pre-Emerge; Post-Emergence');
  });

  it('shows a plain database refusal for an imported row', async () => {
    vi.mocked(supabase.from).mockImplementation(() => chainable({
      data: null,
      error: { message: 'insert or update on table "products" violates foreign key constraint "product_setup_category_fk"' },
    }) as unknown as ReturnType<typeof supabase.from>);
    render(<BulkProductImport {...defaultProps} />);
    const csv = 'product_name,category\nChem,Herbicide';
    const file = new File([csv], 'products.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(csv) });
    fireEvent.change(screen.getByLabelText('Select File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText('Valid Products');
    fireEvent.click(screen.getByRole('button', { name: /Import 1 Product/ }));
    expect(await screen.findByText(/Chem: Choose a category from the product category list/)).toBeInTheDocument();
  });

  it.each(['-1', 'not-a-number', '0.1234567', '1e21', '123456789012.123456'])('refuses invalid imported Rate Per Acre %s', async (rate) => {
    render(<BulkProductImport {...defaultProps} />);
    const csv = `product_name,rate_per_acre\nChem,${rate}`;
    const file = new File([csv], 'products.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(csv) });
    fireEvent.change(screen.getByLabelText('Select File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    expect(await screen.findByText(/Row 2: Rate Per Acre must be/)).toBeInTheDocument();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it.each([
    ['container_size', '0', /Container size must be/],
    ['container_size', '-1', /Container size must be/],
    ['container_size', '0x1A', /Container size must be/],
    ['rate_per_acre', '0x1A', /Rate Per Acre must be/],
    ['category', 'Unknown', /Choose an active category/],
    ['category', 'Retired', /Choose an active category/],
  ])('marks %s=%s invalid before import', async (field, value, message) => {
    render(<BulkProductImport {...defaultProps} />);
    const csv = `product_name,${field}\nChem,${value}`;
    const file = new File([csv], 'products.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(csv) });
    fireEvent.change(screen.getByLabelText('Select File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it.each([
    ['product_name,rate_per_acre\nChem,13', true],
    ['product_name,rate_per_acre,product_form\nChem,13,liquid', true],
    ['product_name,rate_per_acre,product_form\nCorn,1,seed', false],
    ['product_name,rate_per_acre,product_form\nTote,1,Each', false],
  ])('needs a rate unit for a rate except on seed and each: %s', async (csv, refused) => {
    render(<BulkProductImport {...defaultProps} />);
    const file = new File([csv], 'products.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(csv) });
    fireEvent.change(screen.getByLabelText('Select File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    if (refused) expect(await screen.findByText(/Row 2: A rate per acre needs a rate unit/)).toBeInTheDocument();
    else expect(await screen.findByText('Valid Products')).toBeInTheDocument();
  });

  it('imports nothing while rates are locked when a row sets a rate', async () => {
    vi.mocked(supabase.from).mockImplementation(((table: string) => chainable(table === 'product_rate_lock'
      ? { data: { is_locked: true }, error: null } : { data: [], error: null })) as unknown as typeof supabase.from);
    render(<BulkProductImport {...defaultProps} />);
    const csv = 'product_name,rate_per_acre,rate_unit\nChem,13,oz';
    const file = new File([csv], 'products.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(csv) });
    fireEvent.change(screen.getByLabelText('Select File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText('Valid Products');
    fireEvent.click(screen.getByRole('button', { name: /Import 1 Product/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/^Nothing was imported: 1 row sets a rate/)));
    expect(supabase.from).not.toHaveBeenCalledWith('products');
  });

  it('saves a rate-setting file in one insert, so a refusal imports nothing', async () => {
    vi.mocked(supabase.from).mockImplementation(((table: string) => chainable(table === 'product_rate_lock'
      ? { data: { is_locked: false }, error: null }
      : { data: null, error: { message: 'PRODUCT_RATES_LOCKED: rates are locked' } })) as unknown as typeof supabase.from);
    render(<BulkProductImport {...defaultProps} />);
    const csv = 'product_name,rate_per_acre,rate_unit\nChem,13,oz\nPlain,,';
    const file = new File([csv], 'products.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(csv) });
    fireEvent.change(screen.getByLabelText('Select File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText('Valid Products');
    fireEvent.click(screen.getByRole('button', { name: /Import 2 Product/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/^Nothing was imported/)));
    const inserts = vi.mocked(supabase.from).mock.calls.filter(([t]) => String(t) === 'products');
    expect(inserts).toHaveLength(1);
    const builder = vi.mocked(supabase.from).mock.results.find((_, i) => String(vi.mocked(supabase.from).mock.calls[i][0]) === 'products')?.value;
    expect(builder.insert).toHaveBeenCalledWith(
      [expect.objectContaining({ product_name: 'Chem', rate_per_acre: 13 }), expect.objectContaining({ product_name: 'Plain' })],
      { defaultToNull: false });
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.anything());
  });

  it('treats a whitespace-only number cell as blank', async () => {
    render(<BulkProductImport {...defaultProps} />);
    const csv = 'product_name,container_size,rate_per_acre\nChem,   ,   ';
    const file = new File([csv], 'products.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(csv) });
    fireEvent.change(screen.getByLabelText('Select File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText('Valid Products');
    fireEvent.click(screen.getByRole('button', { name: /Import 1 Product/ }));
    await waitFor(() => expect(supabase.from).toHaveBeenCalledWith('products'));
    const builder = vi.mocked(supabase.from).mock.results[0]?.value;
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({
      container_size: undefined, rate_per_acre: undefined,
    }));
  });

  it('treats whitespace-only category and EPA cells as blank', async () => {
    render(<BulkProductImport {...defaultProps} />);
    const csv = 'product_name,category,epa_registration\nChem,   ,   ';
    const file = new File([csv], 'products.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(csv) });
    fireEvent.change(screen.getByLabelText('Select File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText('Valid Products');
    fireEvent.click(screen.getByRole('button', { name: /Import 1 Product/ }));
    await waitFor(() => expect(supabase.from).toHaveBeenCalledWith('products'));
    const builder = vi.mocked(supabase.from).mock.results[0]?.value;
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({
      category: null, epa_registration: null,
    }));
  });
});
