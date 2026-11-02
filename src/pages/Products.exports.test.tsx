import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  products: [] as Array<Record<string, unknown>>,
  role: 'admin' as 'admin' | 'sales_rep',
  toast: vi.fn(),
  exportToCSV: vi.fn(),
  downloadReportPdf: vi.fn(),
}));

const activeProduct = {
  id: '11111111-1111-4111-8111-111111111111',
  product_name: 'Active Product',
  sku: 'ACTIVE-001',
  category: 'Herbicide',
  vendor: 'Test Supplier',
  manufacturer: 'Acme Chemical',
  container_size: 2.5,
  unit_size: 'gal',
  epa_registration: '12345-678',
  is_rup: true,
  signal_word: 'Caution',
  rei_hours: 12,
  phi_days: 7,
  product_form: 'liquid',
  inventory_unit: 'jug',
  container_unit: 'gal',
  current_cost: 50,
  tier1_margin: 0.2,
  tier2_margin: 0.1,
  tier3_margin: 0.25,
  tier1_price: 62.5,
  tier2_price: 55.56,
  tier3_price: 66.67,
  is_active: true,
  pricing_version: 7,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const inactiveProduct = {
  ...activeProduct,
  id: '22222222-2222-4222-8222-222222222222',
  product_name: 'Inactive Product',
  sku: 'INACTIVE-002',
  manufacturer: 'Other Manufacturer',
  epa_registration: '98765-432',
  is_rup: null,
  is_active: false,
};

function chainable(resolveWith: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'in', 'or', 'order', 'limit', 'range', 'update']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = vi.fn((resolve: (value: unknown) => void) => {
    Promise.resolve(resolveWith).then(resolve);
  });
  return builder;
}

vi.mock('../lib/db', () => ({
  supabase: { from: vi.fn(() => chainable({ data: mocks.products, error: null })) },
  sanitizeError: (error: unknown) => error instanceof Error ? error.message : String(error),
  checkMutationResult: vi.fn(),
}));
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));
vi.mock('../lib/marginFloors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/marginFloors')>()),
  fetchMarginFloors: async () => new Map(),
}));
vi.mock('../lib/productPricing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/productPricing')>()),
  previewProductPricingChanges: vi.fn(),
  applyProductPricingChangeSet: vi.fn(),
  createPricingWorkbookExport: vi.fn(),
}));
vi.mock('../components/products/BulkProductImport', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: mocks.role, profile: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/csvExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/csvExport')>()),
  exportToCSV: mocks.exportToCSV,
}));
vi.mock('../lib/reportPdf', () => ({ downloadReportPdf: mocks.downloadReportPdf }));

import Products from './Products';
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';

async function loadProducts() {
  render(<Products />);
  await screen.findByText('Active Product');
}

function openDownload() {
  fireEvent.click(screen.getByRole('button', { name: /^Download$/ }));
}

function salesOption(format: 'PDF' | 'CSV') {
  const options = screen.getAllByRole('button', { name: 'Sales Sheet (prices only)' });
  fireEvent.click(options[format === 'PDF' ? 0 : 1]);
}

function internalOption(format: 'PDF' | 'CSV') {
  const options = screen.getAllByRole('button', { name: 'Internal (cost + margin)' });
  fireEvent.click(options[format === 'PDF' ? 0 : 1]);
}

describe('Products list and exports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = 'admin';
    mocks.products.splice(0, mocks.products.length, activeProduct, inactiveProduct);
    mocks.downloadReportPdf.mockResolvedValue(undefined);
  });

  it('shows active products by default and switches between inactive and all', async () => {
    await loadProducts();
    const status = screen.getByRole('combobox', { name: 'Filter by status' });
    expect(status).toHaveValue('active');
    expect(screen.getByText('Active Product')).toBeInTheDocument();
    expect(screen.queryByText('Inactive Product')).not.toBeInTheDocument();

    fireEvent.change(status, { target: { value: 'inactive' } });
    expect(screen.queryByText('Active Product')).not.toBeInTheDocument();
    expect(screen.getByText('Inactive Product')).toBeInTheDocument();

    fireEvent.change(status, { target: { value: 'all' } });
    expect(screen.getByText('Active Product')).toBeInTheDocument();
    expect(screen.getByText('Inactive Product')).toBeInTheDocument();
  });

  it('exports only active rows to customer CSV and PDF even when All is selected', async () => {
    await loadProducts();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'all' } });
    openDownload();
    salesOption('CSV');
    const [csvRows, csvColumns, filename] = vi.mocked(exportToCSV).mock.calls[0];
    expect(csvRows.map((row) => row.id)).toEqual([activeProduct.id]);
    expect(filename).toBe('product-sales-sheet');
    expect(csvColumns.map((column) => column.key)).toEqual([
      'product_name', 'sku', 'category', 'vendor', 'container_size', 'unit_size',
      'tier1_price', 'tier2_price', 'tier3_price',
    ]);
    expect(csvColumns.map((column) => column.key).join(' ')).not.toMatch(/cost|margin|notes|is_rup|signal_word|rei_hours|phi_days|product_form|is_active/);
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Exported 1 product(s) to CSV');

    openDownload();
    salesOption('PDF');
    await waitFor(() => expect(downloadReportPdf).toHaveBeenCalledTimes(1));
    const [pdf] = vi.mocked(downloadReportPdf).mock.calls[0];
    expect(pdf.data.map((row) => row.id)).toEqual([activeProduct.id]);
    expect(pdf.subtitle).toMatch(/^1 active product\(s\) — /);
    expect(pdf.columns.map((column) => column.key)).toEqual([
      'product_name', 'sku', 'category', 'container_size', 'unit_size',
      'tier1_price', 'tier2_price', 'tier3_price',
    ]);
    expect(pdf.columns.map((column) => column.key).join(' ')).not.toMatch(/cost|margin|notes|is_rup|signal_word|rei_hours|phi_days|product_form|is_active/);
  });

  it('adds Status to the end of the internal PDF columns but not the sales sheet PDF', async () => {
    await loadProducts();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'all' } });

    openDownload();
    internalOption('PDF');
    await waitFor(() => expect(downloadReportPdf).toHaveBeenCalledTimes(1));
    const [internal] = vi.mocked(downloadReportPdf).mock.calls[0];
    const lastInternalColumn = internal.columns[internal.columns.length - 1];
    expect(lastInternalColumn).toMatchObject({ header: 'Status', key: 'is_active' });
    expect(lastInternalColumn.format?.(false)).toBe('Inactive');

    openDownload();
    salesOption('PDF');
    await waitFor(() => expect(downloadReportPdf).toHaveBeenCalledTimes(2));
    const [salesSheet] = vi.mocked(downloadReportPdf).mock.calls[1];
    expect(salesSheet.columns.map((column) => column.key)).not.toContain('is_active');
  });

  it('warns and downloads nothing when Inactive is selected for the sales sheet', async () => {
    await loadProducts();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'inactive' } });
    openDownload();
    salesOption('CSV');
    expect(mocks.toast).toHaveBeenCalledWith('warning', 'No active products to include on the sales sheet.');
    expect(exportToCSV).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Sales Sheet (prices only)' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Download$/ })).toBeEnabled();

    openDownload();
    salesOption('PDF');
    expect(downloadReportPdf).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /^Download$/ })).toBeEnabled();
  });

  it('uses the shared identity and status columns for internal CSV and the selected CSV', async () => {
    await loadProducts();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'all' } });
    openDownload();
    internalOption('CSV');
    const [allRows, allColumns] = vi.mocked(exportToCSV).mock.calls[0];
    expect(allRows.map((row) => row.id)).toEqual([activeProduct.id, inactiveProduct.id]);
    const identityKeys = [
      'product_name', 'sku', 'category', 'vendor', 'manufacturer', 'container_size',
      'unit_size', 'epa_registration', 'is_rup', 'signal_word', 'rei_hours', 'phi_days',
      'product_form', 'inventory_unit', 'container_unit',
    ];
    expect(allColumns.slice(0, identityKeys.length).map((column) => column.key)).toEqual(identityKeys);
    expect(allColumns[allColumns.length - 1]?.key).toBe('is_active');
    expect(allColumns[allColumns.length - 1]?.format?.(false, inactiveProduct)).toBe('Inactive');
    expect(allColumns.find((column) => column.key === 'is_rup')?.format?.(null, inactiveProduct)).toBe('');
    expect(allColumns.find((column) => column.key === 'is_rup')?.format?.(false, inactiveProduct)).toBe('No');

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const [selectedRows, selectedColumns] = vi.mocked(exportToCSV).mock.calls[1];
    expect(selectedRows.map((row) => row.id)).toEqual([activeProduct.id]);
    expect(selectedColumns.slice(0, identityKeys.length).map((column) => column.key)).toEqual(identityKeys);
    expect(selectedColumns[selectedColumns.length - 1]?.key).toBe('is_active');
  });

  it('leaves missing customer prices blank while preserving a real zero', async () => {
    mocks.products.splice(0, mocks.products.length, { ...activeProduct, tier1_price: null, tier2_price: 0 });
    await loadProducts();
    openDownload();
    salesOption('CSV');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(exportToCSV).toHaveBeenCalledTimes(2);
    for (const [rows, columns] of vi.mocked(exportToCSV).mock.calls) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tier1_price: null, tier2_price: 0 });
      expect(columns.find((column) => column.key === 'tier1_price')?.format?.(rows[0].tier1_price, rows[0])).toBe('');
      expect(columns.find((column) => column.key === 'tier2_price')?.format?.(rows[0].tier2_price, rows[0])).toBe('$0.00');
    }
  });

  it('leaves missing internal cost blank on both CSV paths', async () => {
    mocks.products.splice(0, mocks.products.length, { ...activeProduct, current_cost: null });
    await loadProducts();
    openDownload();
    internalOption('CSV');
    fireEvent.click(screen.getByRole('button', { name: 'Margins' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(exportToCSV).toHaveBeenCalledTimes(2);
    for (const [rows, columns] of vi.mocked(exportToCSV).mock.calls) {
      expect(rows).toHaveLength(1);
      expect(rows[0].current_cost).toBeNull();
      expect(columns.find((column) => column.key === 'current_cost')?.format?.(rows[0].current_cost, rows[0])).toBe('');
    }
  });

  it('excludes a selected product switched inactive from selected CSV and PDF', async () => {
    mocks.products.splice(0, mocks.products.length, activeProduct, { ...inactiveProduct, is_active: true });
    const view = render(<Products />);
    await screen.findByText('Active Product');
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'all' } });
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);

    mocks.products.splice(0, 1, { ...activeProduct, is_active: false });
    mocks.role = 'sales_rep';
    view.rerender(<Products />);
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(vi.mocked(exportToCSV).mock.calls[0][0].map((row) => row.id)).toEqual([inactiveProduct.id]);
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Exported 1 product(s) to CSV');

    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(downloadReportPdf).toHaveBeenCalledTimes(1));
    const [pdf] = vi.mocked(downloadReportPdf).mock.calls[0];
    expect(pdf.data.map((row) => row.id)).toEqual([inactiveProduct.id]);
    expect(pdf.subtitle).toBe('1 product(s) selected');
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Downloaded PDF with 1 product(s)');
  });

  it('warns and skips both selected exports when the only selected product became inactive', async () => {
    const view = render(<Products />);
    await screen.findByText('Active Product');
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('checkbox'));

    mocks.products.splice(0, 1, { ...activeProduct, is_active: false });
    mocks.role = 'sales_rep';
    view.rerender(<Products />);
    await waitFor(() => expect(screen.queryAllByRole('checkbox')).toHaveLength(0));

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(exportToCSV).not.toHaveBeenCalled();
    expect(downloadReportPdf).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenNthCalledWith(1, 'warning', 'No active products selected.');
    expect(mocks.toast).toHaveBeenNthCalledWith(2, 'warning', 'No active products selected.');
  });

  it('labels selected exports internal when Margins are shown', async () => {
    await loadProducts();
    fireEvent.click(screen.getByRole('button', { name: 'Margins' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(vi.mocked(exportToCSV).mock.calls[0][2]).toBe('products-internal');

    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(downloadReportPdf).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadReportPdf).mock.calls[0][0].title).toBe('Products — Internal');

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(vi.mocked(exportToCSV).mock.calls[1][2]).toBe('products');
  });

  it('uses filtered row counts for the internal PDF and adds Size and Unit to selected PDF', async () => {
    await loadProducts();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'inactive' } });
    openDownload();
    internalOption('PDF');
    await waitFor(() => expect(downloadReportPdf).toHaveBeenCalledTimes(1));
    const [internal] = vi.mocked(downloadReportPdf).mock.calls[0];
    expect(internal.data.map((row) => row.id)).toEqual([inactiveProduct.id]);
    expect(internal.subtitle).toMatch(/^1 product\(s\) — /);

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'active' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(downloadReportPdf).toHaveBeenCalledTimes(2));
    const [selected] = vi.mocked(downloadReportPdf).mock.calls[1];
    expect(selected.columns.map((column) => column.key)).toContain('container_size');
    expect(selected.columns.map((column) => column.key)).toContain('unit_size');
  });

  it('shows only customer downloads to a sales rep', async () => {
    mocks.role = 'sales_rep';
    await loadProducts();
    openDownload();
    expect(screen.queryByRole('button', { name: 'Internal (cost + margin)' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Sales Sheet (prices only)' })).toHaveLength(2);
    salesOption('CSV');
    expect(vi.mocked(exportToCSV).mock.calls[0][2]).toBe('product-sales-sheet');
    expect(downloadReportPdf).not.toHaveBeenCalled();
  });

  it('keeps cost and margin columns out of a rep selected CSV', async () => {
    mocks.role = 'sales_rep';
    await loadProducts();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const [rows, columns, filename] = vi.mocked(exportToCSV).mock.calls[0];
    expect(rows.map((row) => row.id)).toEqual([activeProduct.id]);
    expect(columns.map((column) => column.key).join(' ')).not.toMatch(/cost|margin/);
    expect(filename).toBe('products');
  });

  it('shows a matching-products message without an add action when filters hide the catalog', async () => {
    mocks.products.splice(0, mocks.products.length, activeProduct);
    await loadProducts();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'inactive' } });
    const title = screen.getByText('No matching products');
    expect(screen.getByText('Try a different search or filter')).toBeInTheDocument();
    expect(title.parentElement?.querySelector('button')).toBeNull();
    expect(screen.queryByText('No products yet')).not.toBeInTheDocument();
  });

  it('hides Select All when the Inactive filter has no selectable products', async () => {
    await loadProducts();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'inactive' } });
    expect(screen.getByText('Inactive Product')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select All' })).not.toBeInTheDocument();
  });

  it('finds a product by EPA registration number and manufacturer', async () => {
    await loadProducts();
    const search = screen.getByRole('textbox', { name: 'Search products...' });
    fireEvent.change(search, { target: { value: '12345-678' } });
    expect(screen.getByText('Active Product')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'unmatched' } });
    expect(screen.queryByText('Active Product')).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'Acme Chemical' } });
    expect(screen.getByText('Active Product')).toBeInTheDocument();
  });

  it('shows read-only compliance details to every role when requested', async () => {
    mocks.role = 'sales_rep';
    await loadProducts();
    expect(screen.queryByRole('columnheader', { name: 'RUP' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    for (const header of ['RUP', 'Signal Word', 'Form', 'Inventory Unit']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('Caution')).toBeInTheDocument();
    expect(screen.getByText('liquid')).toBeInTheDocument();
    expect(screen.getByText('jug')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    expect(screen.queryByRole('columnheader', { name: 'RUP' })).not.toBeInTheDocument();
  });
});
