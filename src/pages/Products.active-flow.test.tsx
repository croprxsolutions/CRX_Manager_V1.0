import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'sales_rep',
  products: [] as Array<Record<string, unknown>>,
  rpc: vi.fn(),
  toast: vi.fn(),
}));
const active = {
  id: '11111111-1111-4111-8111-111111111111', product_name: 'Test Chemical',
  sku: 'TEST-1', category: 'Herbicide', vendor: 'Test Supplier',
  is_active: true, pricing_version: 1, created_at: '', updated_at: '',
};
const inactive = { ...active, id: '22222222-2222-4222-8222-222222222222',
  product_name: 'Retired Chemical', is_active: false };

function chainable(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'is', 'in', 'order', 'range', 'limit', 'update']) {
    builder[name] = vi.fn(() => builder);
  }
  builder.then = vi.fn((resolve: (value: unknown) => void) => Promise.resolve(result).then(resolve));
  return builder;
}
vi.mock('../lib/db', async (original) => ({
  ...(await original<typeof import('../lib/db')>()),
  supabase: { from: vi.fn(() => chainable({ data: mocks.products, error: null })) },
  supabaseUntyped: { rpc: (...args: unknown[]) => mocks.rpc(...args) },
  assertRpcResult: (data: unknown) => data,
  sanitizeError: (error: unknown) => (error as { message?: string } | null)?.message ?? String(error),
  checkMutationResult: vi.fn(),
}));
vi.mock('../lib/costFields', async (original) => ({
  ...(await original<typeof import('../lib/costFields')>()),
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));
vi.mock('../lib/marginFloors', async (original) => ({
  ...(await original<typeof import('../lib/marginFloors')>()), fetchMarginFloors: async () => new Map(),
}));
vi.mock('../lib/productPricing', async (original) => ({
  ...(await original<typeof import('../lib/productPricing')>()),
  previewProductPricingChanges: vi.fn(), applyProductPricingChangeSet: vi.fn(), createPricingWorkbookExport: vi.fn(),
}));
vi.mock('../components/products/BulkProductImport', () => ({ default: () => null }));
vi.mock('../components/products/ProductsMobileList', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: mocks.role, profile: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }),
}));
vi.mock('../lib/productParents', () => {
  const empty = { parents: [], byProduct: new Map(), index: new Map() };
  return { useProductParents: () => empty, searchProductParents: async () => [] };
});
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/csvExport', async (original) => ({
  ...(await original<typeof import('../lib/csvExport')>()), exportToCSV: vi.fn(),
}));

import Products from './Products';

function review(blockers: Array<{ message: string }> = [], warnings: Array<{ message: string }> = []) {
  return { products: [{ id: active.id, product_name: active.product_name, is_active: true }],
    blockers, warnings, review_token: 'review-hash' };
}
async function loaded() {
  render(<Products />);
  await screen.findByText('Test Chemical');
}

describe('product active review flow', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.role = 'admin';
    mocks.products.splice(0, mocks.products.length, active, inactive);
  });

  it('shows each blocker and offers no confirm action', async () => {
    mocks.rpc.mockResolvedValue({ data: review([{ message: 'Test Chemical: order PM3-OPEN' }]), error: null });
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText('Test Chemical: order PM3-OPEN')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('confirms a stock warning using the preview token and a retry key', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: review([], [{ message: 'Test Chemical: stock remains on hand' }]), error: null })
      .mockResolvedValueOnce({ data: { products: [] }, error: null });
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText(/Test Chemical: stock remains on hand/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('set_product_active', expect.objectContaining({
      p_product_ids: [active.id], p_active: false, p_review_token: 'review-hash',
      p_idempotency_key: expect.any(String),
    })));
  });

  it('gives a sales rep no deactivation control or inactive selection', async () => {
    mocks.role = 'sales_rep';
    await loaded();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'inactive' } });
    expect(screen.getByText('Retired Chemical')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('lets an admin select and reactivate an inactive product', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ...review(), products: [{ id: inactive.id, product_name: inactive.product_name, is_active: false }] }, error: null })
      .mockResolvedValueOnce({ data: { products: [] }, error: null });
    await loaded();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'inactive' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Reactivate' })[0]);
    await screen.findByRole('dialog');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('set_product_active', expect.objectContaining({
      p_product_ids: [inactive.id], p_active: true,
    })));
  });

  it('closes a stale review and asks for a fresh one', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: review(), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'PRODUCT_ACTIVE_REVIEW_STALE' } })
      .mockResolvedValueOnce({ data: review([{ message: 'Test Chemical: order PM3-NEW' }]), error: null });
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('warning',
      'Product details changed since this review. Review the selection again.'));
    expect(await screen.findByText('Test Chemical: order PM3-NEW')).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it('says how many turned-off products a selected export left out', async () => {
    await loaded();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'all' } });
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    fireEvent.click(screen.getAllByRole('button', { name: 'Export CSV' })[0]);
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Exported 1 product(s) to CSV (1 turned-off product(s) left out)');
  });

  it('reopens the review when an order becomes a blocker after preview', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: review(), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'PRODUCT_DEACTIVATION_BLOCKED: order PM3-NEW' } })
      .mockResolvedValueOnce({ data: review([{ message: 'Test Chemical: order PM3-NEW' }]), error: null });
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText('Test Chemical: order PM3-NEW')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).not.toHaveTextContent('Deactivate these products:');
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    expect(mocks.toast).toHaveBeenCalledWith('warning', expect.stringContaining('order PM3-NEW'));
  });

  it('bulk actions review only rows whose status will change', async () => {
    mocks.rpc.mockResolvedValue({ data: review(), error: null });
    await loaded();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }),
      { target: { value: 'all' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' })[0]);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('preview_product_active_change',
      { p_product_ids: [active.id], p_active: false }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Deactivate these products:Test Chemical');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Reactivate' })[0]);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('preview_product_active_change',
      { p_product_ids: [inactive.id], p_active: true }));
  });

  it('refuses a bulk change above the 500-product RPC limit without calling it', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ ...active,
      id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`, product_name: `Chem ${i}`, sku: `C-${i}` }));
    mocks.products.splice(0, mocks.products.length, ...many);
    render(<Products />);
    await screen.findByText('Chem 0', {}, { timeout: 30000 });
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' })[0]);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringContaining('at most 500 Products')));
    expect(mocks.rpc).not.toHaveBeenCalled();
  }, 60000); // 501 rendered rows take ~15s on CI runners
});
