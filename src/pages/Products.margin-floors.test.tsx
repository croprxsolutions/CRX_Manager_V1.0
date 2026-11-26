import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  products: [] as Array<Record<string, unknown>>,
  productsError: null as Error | null,
  toast: vi.fn(),
  fetchMarginFloors: vi.fn(),
  setMarginFloors: vi.fn(),
  setupWorkbookSaved: null as null | (() => void),
}));

const product = {
  id: '11111111-1111-4111-8111-111111111111',
  product_name: 'Floor Product',
  sku: 'FLOOR-001',
  category: 'Herbicide',
  vendor: 'Test Supplier',
  current_cost: 50,
  tier1_margin: 0.2,
  tier2_margin: 0.1,
  tier3_margin: 0.25,
  tier1_price: 62.5,
  tier2_price: 55.56,
  tier3_price: 66.67,
  pricing_version: 7,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const otherProduct = {
  ...product,
  id: '22222222-2222-4222-8222-222222222222',
  product_name: 'Other Product',
  sku: 'FLOOR-002',
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

vi.mock('../components/products/TypedBrandReview', () => ({ default: () => null }));
vi.mock('../components/deliveries/DeliveriesMissingBrands', () => ({ default: () => null }));
vi.mock('../lib/db', () => ({
  supabase: {
    from: vi.fn(() => chainable(mocks.productsError
      ? { data: null, error: mocks.productsError }
      : { data: mocks.products, error: null })),
  },
  sanitizeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  checkMutationResult: vi.fn(),
}));
vi.mock('../lib/marginFloors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/marginFloors')>()),
  fetchMarginFloors: mocks.fetchMarginFloors,
  setMarginFloors: mocks.setMarginFloors,
}));
vi.mock('../lib/productPricing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/productPricing')>()),
  previewProductPricingChanges: vi.fn(),
  applyProductPricingChangeSet: vi.fn(),
  createPricingWorkbookExport: vi.fn(),
}));
vi.mock('../components/products/BulkProductImport', () => ({ default: () => null }));
vi.mock('../components/products/ProductSetupWorkbookModal', () => ({
  default: ({ onSaved }: { onSaved: () => void }) => { mocks.setupWorkbookSaved = onSaved; return null; },
}));
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
vi.mock('../components/products/ProductsMobileList', async () => {
  const actual = await vi.importActual<typeof import('../components/products/ProductsMobileList')>(
    '../components/products/ProductsMobileList',
  );
  return { ...actual, default: () => null };
});
vi.mock('../lib/productParents', () => ({ getProductParents: async () => [], searchProductParents: async () => [] }));
vi.mock('../lib/epaBatchFill', () => ({ fetchBrandEpaOwners: async () => ({ parentIds: new Set(), productIds: new Set() }) }));
vi.mock('../lib/productSetup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/productSetup')>()),
  listProductCategories: async () => [
    { name: 'Herbicide', is_active: true, sort_order: 10 },
    { name: 'Seed', is_active: true, sort_order: 20 },
  ],
}));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

import Products from './Products';

async function openFloorEditor() {
  render(<Products />);
  await screen.findByText('Floor Product');
  fireEvent.click(screen.getByRole('button', { name: /margins/i }));
  fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
  return screen.getByLabelText('Margin floor percent for Floor Product') as HTMLInputElement;
}

describe('Products list margin floors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.products.splice(0, mocks.products.length, product);
    mocks.productsError = null;
    mocks.fetchMarginFloors.mockResolvedValue(new Map([[product.id, 0.15]]));
    mocks.setMarginFloors.mockResolvedValue({ success: true, status: 'saved', changed_count: 1, unchanged_count: 0 });
  });

  it('shows the floor and flags only the tier under it', async () => {
    render(<Products />);
    await screen.findByText('Floor Product');
    fireEvent.click(screen.getByRole('button', { name: /margins/i }));
    expect(screen.getByText('15%')).toBeInTheDocument();
    expect(screen.getByText('10.00% net · under 15% floor')).toBeInTheDocument();
    expect(screen.getByText('20.0% net')).toBeInTheDocument();
    expect(screen.getByText('25.0% net')).toBeInTheDocument();
  });

  it('never shows a margin just under its floor rounded up to the floor', async () => {
    mocks.products.splice(0, mocks.products.length, { ...product, tier2_margin: 0.14996 });
    render(<Products />);
    await screen.findByText('Floor Product');
    fireEvent.click(screen.getByRole('button', { name: /margins/i }));
    expect(screen.getByText('14.99% net · under 15% floor')).toBeInTheDocument();
    expect(screen.queryByText(/15\.00% net/)).not.toBeInTheDocument();
  });

  it('clears a floor by emptying the box, and saves the clear', async () => {
    const input = await openFloorEditor();
    expect(input.value).toBe('15');
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Save (1)' }));
    await waitFor(() => expect(mocks.setMarginFloors).toHaveBeenCalledTimes(1));
    expect(mocks.setMarginFloors.mock.calls[0][0].changes).toEqual([{ productId: product.id, marginFloorPercent: null }]);
  });

  it('typing back the stored floor leaves nothing to save', async () => {
    const input = await openFloorEditor();
    fireEvent.change(input, { target: { value: '16' } });
    expect(screen.getByRole('button', { name: 'Save (1)' })).toBeEnabled();
    fireEvent.change(input, { target: { value: '15' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('refuses text that is not a percent instead of clearing the floor', async () => {
    const input = await openFloorEditor();
    fireEvent.change(input, { target: { value: '15,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save (1)' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringMatching(/0 to 99\.99/)));
    expect(mocks.setMarginFloors).not.toHaveBeenCalled();
  });

  it('says the list could not be reloaded when the floors fail to reload after a save', async () => {
    const input = await openFloorEditor();
    mocks.fetchMarginFloors.mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(input, { target: { value: '16' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save (1)' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      'warning', 'Margin floors were saved, but the list could not be reloaded. Refresh this page.'));
    expect(mocks.toast).not.toHaveBeenCalledWith('success', expect.stringMatching(/Updated/));
  });

  it('shows the floor it just saved when the floors fail to reload, others as unknown and read-only', async () => {
    mocks.products.push(otherProduct);
    mocks.fetchMarginFloors.mockResolvedValue(new Map([[product.id, 0.15], [otherProduct.id, 0.2]]));
    const input = await openFloorEditor();
    mocks.fetchMarginFloors.mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(input, { target: { value: '16' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save (1)' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      'warning', 'Margin floors were saved, but the list could not be reloaded. Refresh this page.'));
    expect(await screen.findByText('16%')).toBeInTheDocument();
    expect(screen.queryByText('20%')).not.toBeInTheDocument();
    expect(screen.getAllByTitle('Margin floors could not be loaded')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.queryByLabelText('Margin floor percent for Floor Product')).not.toBeInTheDocument();
  });

  it('keeps the other floors and the editor when the products fail to reload after a save', async () => {
    mocks.products.push(otherProduct);
    mocks.fetchMarginFloors.mockResolvedValue(new Map([[product.id, 0.15], [otherProduct.id, 0.2]]));
    const input = await openFloorEditor();
    mocks.productsError = new Error('offline');
    // The floors read after the save returns the saved floor.
    mocks.fetchMarginFloors.mockResolvedValue(new Map([[product.id, 0.16], [otherProduct.id, 0.2]]));
    fireEvent.change(input, { target: { value: '16' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save (1)' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      'warning', 'Margin floors were saved, but the list could not be reloaded. Refresh this page.'));
    expect(await screen.findByText('16%')).toBeInTheDocument();
    expect(screen.getByText('20%')).toBeInTheDocument();
    expect(screen.queryByTitle('Margin floors could not be loaded')).not.toBeInTheDocument();
    // The old rows stay on screen, but editing waits for a fresh list.
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the latest product list.');
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    mocks.productsError = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect((screen.getByLabelText('Margin floor percent for Floor Product') as HTMLInputElement).value).toBe('16');
    expect((screen.getByLabelText('Margin floor percent for Other Product') as HTMLInputElement).value).toBe('20');
  });

  it('refuses a floor draft typed before a floors re-read failed (#2160)', async () => {
    const input = await openFloorEditor();
    fireEvent.change(input, { target: { value: '16' } });
    // A setup-workbook save re-reads the list and floors while the draft is open; the floors read fails.
    mocks.fetchMarginFloors.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { mocks.setupWorkbookSaved?.(); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load margin floors.');
    fireEvent.click(screen.getByRole('button', { name: 'Save (1)' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      'error', 'Margin floors have not loaded. Use Try again, then enter the floor changes again.'));
    expect(mocks.setMarginFloors).not.toHaveBeenCalled();
  });

  it('refuses a floor draft typed before a floors failure even after Try again recovers (#2308)', async () => {
    const input = await openFloorEditor();
    fireEvent.change(input, { target: { value: '16' } });
    mocks.fetchMarginFloors.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { mocks.setupWorkbookSaved?.(); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load margin floors.');
    // Try again reads the floors (another admin may have changed one meanwhile); the old draft must not save.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save (1)' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      'error', 'Margin floors were read again after a failure. Cancel, then enter the floor changes again.'));
    expect(mocks.setMarginFloors).not.toHaveBeenCalled();
    // After Cancel, a new edit saves normally.
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard edits' }));
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const again = screen.getByLabelText('Margin floor percent for Floor Product') as HTMLInputElement;
    fireEvent.change(again, { target: { value: '17' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save (1)' }));
    await waitFor(() => expect(mocks.setMarginFloors).toHaveBeenCalled());
  });

  it('keeps the catalog when floors fail to load, with the floor column read-only', async () => {
    mocks.fetchMarginFloors.mockRejectedValue(new Error('offline'));
    render(<Products />);
    expect(await screen.findByText('Floor Product')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load margin floors.');
    fireEvent.click(screen.getByRole('button', { name: /margins/i }));
    expect(screen.getByTitle('Margin floors could not be loaded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.queryByLabelText('Margin floor percent for Floor Product')).not.toBeInTheDocument();
  });

  it('loads the floors on Try again after they failed, and the floor becomes editable', async () => {
    mocks.fetchMarginFloors.mockRejectedValueOnce(new Error('offline'));
    render(<Products />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /margins/i }));
    expect(screen.getByText('15%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect((screen.getByLabelText('Margin floor percent for Floor Product') as HTMLInputElement).value).toBe('15');
  });
});
