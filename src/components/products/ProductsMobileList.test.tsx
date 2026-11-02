import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { MobileProduct, Product } from '../../types';
import ProductsMobileList from './ProductsMobileList';

const createProduct = (id: string, overrides: Partial<Product> = {}): Product => ({
  id,
  product_name: `Product ${id}`,
  sku: `SKU-${id}`,
  category: 'Herbicide',
  use_timing: null,
  vendor: `Vendor ${id}`,
  manufacturer: `Manufacturer ${id}`,
  container_size: null,
  unit_size: 'gal',
  epa_registration: `EPA-${id}`,
  is_rup: false,
  signal_word: null,
  rei_hours: null,
  phi_days: null,
  product_form: null,
  inventory_unit: null,
  container_unit: null,
  container_type: null,
  current_cost: 12345,
  cost_updated_date: null,
  tier1_price: 10,
  tier1_margin: 0.8,
  tier2_price: 12,
  tier2_margin: 0.7,
  tier3_price: 14,
  tier3_margin: 0.6,
  tier1_price_per_acre: null,
  tier2_price_per_acre: null,
  tier3_price_per_acre: null,
  pricing_version: 1,
  suggested_rate: null,
  rate_per_acre: null,
  rate_unit: null,
  max_label_rate: null,
  max_label_rate_unit: null,
  notes: null,
  internal_notes: null,
  quoting_notes: null,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

function renderList(
  products: readonly MobileProduct[],
  options: {
    categoryFilter?: string;
    vendorFilter?: string;
    onVendorFilterChange?: (value: string) => void;
    statusFilter?: 'active' | 'inactive' | 'all';
    loadError?: boolean;
    onRetry?: () => void;
    onOpenProduct?: (product: MobileProduct) => void;
  } = {},
) {
  return render(
    <ProductsMobileList
      products={products}
      categories={['Fungicide', 'Herbicide']}
      vendors={['Vendor 1', 'Vendor 2']}
      categoryFilter={options.categoryFilter ?? ''}
      vendorFilter={options.vendorFilter ?? ''}
      onVendorFilterChange={options.onVendorFilterChange ?? vi.fn()}
      statusFilter={options.statusFilter ?? 'all'}
      onCategoryFilterChange={vi.fn()}
      onStatusFilterChange={vi.fn()}
      onOpenProduct={options.onOpenProduct ?? vi.fn()}
      loadError={options.loadError}
      onRetry={options.onRetry}
    />
  );
}

describe('ProductsMobileList', () => {
  it('shows product identity, category, tier prices, and status, and opens on tap', () => {
    const product = createProduct('1', { is_active: false });
    const onOpenProduct = vi.fn();
    renderList([product], { onOpenProduct });

    const card = screen.getByRole('button', { name: /^Product 1\b/ });
    expect(card).not.toHaveAttribute('aria-label');
    expect(card).toHaveAccessibleName(/Product 1.*Inactive.*Tier 1.*\$10\.00/);
    expect(within(card).getByText('SKU: SKU-1')).toBeInTheDocument();
    expect(within(card).getByText('Herbicide')).toBeInTheDocument();
    expect(within(card).getByText('Tier 1')).toBeInTheDocument();
    expect(within(card).getByText('Tier 2')).toBeInTheDocument();
    expect(within(card).getByText('Tier 3')).toBeInTheDocument();
    expect(within(card).getByText('$10.00')).toBeInTheDocument();
    expect(within(card).getByText('$12.00')).toBeInTheDocument();
    expect(within(card).getByText('$14.00')).toBeInTheDocument();
    expect(within(card).getByText('Inactive')).toBeInTheDocument();
    expect(within(card).queryByText(/cost|margin/i)).not.toBeInTheDocument();
    expect(within(card).queryByText('$12,345.00')).not.toBeInTheDocument();

    fireEvent.click(card);
    expect(onOpenProduct).toHaveBeenCalledWith(product);
  });

  it('searches manufacturer and EPA registration, then applies category and status filters', () => {
    const products = [
      createProduct('1'),
      createProduct('2', { category: 'Fungicide', is_active: false }),
    ];
    const onCategoryFilterChange = vi.fn();
    const onStatusFilterChange = vi.fn();
    const props = {
      products,
      vendors: ['Vendor 1', 'Vendor 2'],
      vendorFilter: '',
      onVendorFilterChange: vi.fn(),
      categories: ['Fungicide', 'Herbicide'],
      categoryFilter: '',
      statusFilter: 'all' as const,
      onCategoryFilterChange,
      onStatusFilterChange,
      onOpenProduct: vi.fn(),
    };
    const view = render(<ProductsMobileList {...props} />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search products...' }), {
      target: { value: 'manufacturer 2' },
    });
    expect(screen.getByRole('button', { name: /^Product 2\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Product 1\b/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search products...' }), {
      target: { value: 'epa-2' },
    });
    expect(screen.getByRole('button', { name: /^Product 2\b/ })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search products...' }), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Filter by category'), { target: { value: 'Fungicide' } });
    expect(onCategoryFilterChange).toHaveBeenCalledWith('Fungicide');
    view.rerender(<ProductsMobileList {...props} categoryFilter="Fungicide" />);
    expect(screen.getByRole('button', { name: /^Product 2\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Product 1\b/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'active' } });
    expect(onStatusFilterChange).toHaveBeenCalledWith('active');
    view.rerender(<ProductsMobileList {...props} categoryFilter="Fungicide" statusFilter="active" />);
    expect(screen.getByText('No matching products')).toBeInTheDocument();
  });

  it('adds 50 more cards at a time', () => {
    const products = Array.from({ length: 120 }, (_, index) => createProduct(String(index + 1)));
    renderList(products);

    expect(screen.getAllByRole('button', { name: /^Product \d+\b/ })).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more products' }));
    expect(screen.getAllByRole('button', { name: /^Product \d+\b/ })).toHaveLength(100);
    expect(screen.getByRole('button', { name: 'Show 20 more products' })).toBeInTheDocument();
  });

  it('labels Show more with the exact number of remaining cards', () => {
    const products = Array.from({ length: 53 }, (_, index) => createProduct(String(index + 1)));
    renderList(products);

    expect(screen.getByRole('button', { name: 'Show 3 more products' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more products' }));
    expect(screen.getAllByRole('button', { name: /^Product \d+\b/ })).toHaveLength(53);
  });

  it('shows a load failure with retry and no empty-list message', () => {
    const onRetry = vi.fn();
    renderList([], { loadError: true, onRetry });

    expect(screen.getByRole('alert')).toHaveTextContent('This list could not be loaded');
    expect(screen.queryByText('No products yet')).not.toBeInTheDocument();
    expect(screen.queryByText('No matching products')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Try again'));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('ProductsMobileList vendor filter', () => {
  it('shows only the chosen vendor and lets the phone clear it', () => {
    const onVendorFilterChange = vi.fn();
    renderList([createProduct('1'), createProduct('2')], { vendorFilter: 'Vendor 1', onVendorFilterChange });

    expect(screen.getByText('Product 1')).toBeInTheDocument();
    expect(screen.queryByText('Product 2')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter by vendor'), { target: { value: '' } });
    expect(onVendorFilterChange).toHaveBeenCalledWith('');
  });
});
