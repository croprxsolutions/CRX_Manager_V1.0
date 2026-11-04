/**
 * NewPurchaseOrder.unsavedChanges.test.tsx: loading the catalog, a Reorder
 * pre-fill and a vendor cost suggestion are not unsaved work; a user edit is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockNavigate, mockRpc, mockToast, mockGenerateIdempotencyKey, mockAuth, mockCatalog } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockGenerateIdempotencyKey: vi.fn(),
  mockAuth: { role: 'sales_rep' },
  // How many upcoming catalog reads fail.
  mockCatalog: { failuresLeft: 0 },
}));

const product = {
  id: 'product-1',
  product_name: 'Test Herbicide',
  sku: 'TEST-1',
  vendor: 'Test Vendor',
  current_cost: 12.5,
  unit_size: 'Gallon',
};

function buildProductsQuery() {
  const failed = mockCatalog.failuresLeft > 0;
  if (failed) mockCatalog.failuresLeft -= 1;
  const result = Promise.resolve(failed
    ? { data: null, error: new Error('catalog read failed'), count: null }
    : { data: [product], error: null, count: 1 });
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'range']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = result.then.bind(result);
  chain.catch = result.catch.bind(result);
  chain.finally = result.finally.bind(result);
  return chain;
}

const mockSearch = vi.hoisted(() => ({ value: '' }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams(mockSearch.value), vi.fn()],
}));

vi.mock('../lib/db', () => ({
  supabase: {
    from: vi.fn(() => buildProductsQuery()),
    rpc: mockRpc,
  },
  assertRpcResult: <T,>(data: T) => data,
}));

vi.mock('../lib/idempotency', () => ({
  generateIdempotencyKey: mockGenerateIdempotencyKey,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: mockAuth.role, full_name: 'Sales User' } }),
}));

// A non-admin's catalog carries no cost; an admin's carries the real one.
vi.mock('../lib/costFields', () => ({
  PRODUCT_COLUMNS: 'id',
  withAdminCosts: async (_table: string, rows: Array<Record<string, unknown>>, isAdmin: boolean) =>
    rows.map((row) => (isAdmin ? row : { ...row, current_cost: undefined })),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// Records every isDirty value the page hands the unsaved-changes guard.
const dirty = vi.hoisted(() => ({ values: [] as boolean[] }));
vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: (isDirty: boolean) => { dirty.values.push(isDirty); return { state: 'unblocked' }; },
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

import NewPurchaseOrder from './NewPurchaseOrder';

beforeEach(() => {
  vi.clearAllMocks();
  dirty.values = [];
  mockAuth.role = 'admin';
  mockCatalog.failuresLeft = 0;
  mockGenerateIdempotencyKey.mockReturnValue('key');
  mockRpc.mockImplementation(async (name: string) => {
    if (name === 'get_product_vendors') return { data: [{ vendor_name: 'Test Vendor', is_preferred: true, last_cost_cents: 980 }], error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
});
afterEach(() => {
  cleanup();
  mockSearch.value = '';
});

describe('NewPurchaseOrder unsaved changes', () => {
  it('a blank PO stays clean after the catalog loads, and a notes edit makes it dirty', async () => {
    render(<NewPurchaseOrder />);
    await screen.findByRole('button', { name: 'Select Product' });
    await new Promise((r) => setTimeout(r, 400));
    expect(dirty.values).not.toContain(true);

    fireEvent.change(screen.getByPlaceholderText('Internal notes about this PO...'), { target: { value: 'call first' } });
    expect(dirty.values[dirty.values.length - 1]).toBe(true);
  });

  it('a Reorder link pre-fill and its cost suggestion leave the PO clean', async () => {
    mockSearch.value = 'product=product-1';
    render(<NewPurchaseOrder />);
    await waitFor(() => expect(screen.getByDisplayValue('9.8')).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 400));
    expect(dirty.values).not.toContain(true);
  });
});
