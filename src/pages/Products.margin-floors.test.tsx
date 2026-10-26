import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  products: [] as Array<Record<string, unknown>>,
  toast: vi.fn(),
  fetchMarginFloors: vi.fn(),
  setMarginFloors: vi.fn(),
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
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'admin', profile: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', full_name: 'Test Admin' } }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
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

  it('keeps the catalog when floors fail to load, with the floor column read-only', async () => {
    mocks.fetchMarginFloors.mockRejectedValue(new Error('offline'));
    render(<Products />);
    expect(await screen.findByText('Floor Product')).toBeInTheDocument();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('warning', expect.stringMatching(/could not be loaded/)));
    fireEvent.click(screen.getByRole('button', { name: /margins/i }));
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.queryByLabelText('Margin floor percent for Floor Product')).not.toBeInTheDocument();
  });
});
