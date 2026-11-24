/** DeliveryDetail "Remaining After" (F05): leaves out units on the order's other open loads and never counts this load twice. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { auth, brand, mockFrom, mockRpc, mockToast, mockSendEmail, mockUpload, route, tables } = vi.hoisted(() => ({
  auth: { role: 'admin', profile: { id: 'user-1', role: 'admin' }, deniedPages: [] as string[] },
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockSendEmail: vi.fn(),
  mockUpload: vi.fn(),
  route: { id: 'del-1' },
  brand: { dirty: false },
  tables: { data: {} as Record<string, unknown[]> },
}));

function buildChain(baseTable: string): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  let table = baseTable;
  const method = (..._args: unknown[]) => self;
  for (const m of [
    'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte',
    'lt', 'lte', 'like', 'ilike', 'is', 'in', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'returns', 'abortSignal', 'range',
  ]) self[m] = method;
  self.select = (cols?: string) => {
    if (baseTable === 'delivery_items' && String(cols).includes('deliveries!inner')) table = 'other_open_items';
    return self;
  };
  // Read the table when the query resolves, so a test can change it between calls.
  const rows = () => tables.data[table] ?? [];
  self.single = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
  self.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
  self.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve({ data: rows(), error: null, count: rows().length }).then(ok, bad);
  return self;
}

vi.mock('../hooks/useUnsavedChanges', () => ({ useUnsavedChanges: () => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }) }));
vi.mock('../lib/db', () => ({
  supabase: {
    from: mockFrom,
    rpc: mockRpc,
    storage: {
      from: () => ({
        createSignedUrl: () => Promise.resolve({ data: null, error: null }),
        upload: mockUpload,
        getPublicUrl: () => ({ data: { publicUrl: '' } }),
      }),
    },
  },
  supabaseUntyped: { from: mockFrom },
  sanitizeError: (e: unknown) => (e as Error)?.message || 'Error',
  checkMutationResult: vi.fn(),
  assertRpcResult: (d: unknown, op: string) => {
    if (d === null || d === undefined) throw new Error(`${op} returned no result`);
    return d;
  },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({
  notifyDeliveryRemainder: vi.fn(), notifyDeliveryCompleted: vi.fn(),
}));
vi.mock('../lib/connectivity', () => ({ hasSignal: () => Promise.resolve(true), NO_SIGNAL_MESSAGE: 'no signal' }));
vi.mock('../lib/deliveryPdf', () => ({ downloadDeliveryPdf: vi.fn() }));
vi.mock('../lib/emailService', () => ({ sendEmail: mockSendEmail, buildEmailHtml: () => '<p></p>' }));
vi.mock('../lib/rupCompliance', () => ({ checkRUPCompliance: () => Promise.resolve({ compliant: true, warnings: [] }) }));
vi.mock('../lib/deliverySplitBilling', () => ({
  fetchSplitBillingOrderIds: () => Promise.resolve({ data: new Set(), error: null }), SPLIT_BILLING_BLOCK_REASON: '', billSplitFailed: () => false, BILL_SPLIT_FAILED_MESSAGE: '',
}));
vi.mock('../components/deliveries/useDeliveryBrands', () => ({
  useDeliveryBrands: () => ({
    brands: null, drafts: {}, setLineDraft: vi.fn(), dirty: brand.dirty, saving: false, loading: false,
    savedAt: null, loadFailed: false, save: vi.fn(), reload: vi.fn(),
  }),
}));
vi.mock('../lib/imageCompression', () => ({ compressImage: vi.fn() }));
vi.mock('../components/deliveries/StartDeliveryModal', () => ({ default: () => null }));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));
vi.mock('../components/ui/SignatureCanvas', () => ({ default: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: route.id }), useNavigate: () => vi.fn() };
});

import DeliveryDetail from './DeliveryDetail';

// ORD-2026-0036 on staging: 3 ordered; DEL-00034 completed 1; DEL-00035 and DEL-00036 hold 1 each.
function setup(status: string, quantityDelivered: number, otherOpen: Array<{ order_item_id: string; quantity: number }>, orderDelivered: number) {
  tables.data = {
    deliveries: [{
      id: 'del-1', delivery_number: 'DEL-1', status, scheduled_date: '2026-11-22', customer_id: 'cust-1',
      order_id: 'ord-1', assigned_driver: 'user-1', created_by: 'user-1', delivery_notes: '', priority: 'normal',
    }],
    delivery_items: [{ id: 'item-1', delivery_id: 'del-1', order_item_id: 'oi-1', product_id: 'prod-1', quantity: 1, quantity_delivered: quantityDelivered, product: { product_name: 'Test Chem' } }],
    other_open_items: otherOpen,
    delivery_photos: [],
    delivery_remainders: [],
    customers: [{ id: 'cust-1', farm_name: 'Test Farm' }],
    customer_addresses: [],
    profile_public_view: [],
    order_items: [{ id: 'oi-1', total_units_needed: 3, quantity_delivered: orderDelivered, quantity_remaining: 3 - orderDelivered }],
    orders: [{ id: 'ord-1', order_number: 'ORD-1', quote_id: null }],
    invoices: [],
    inventory: [],
  };
}

async function productRow() {
  const table = (await screen.findByText('Remaining After', {}, { timeout: 3000 })).closest('table') as HTMLElement;
  const row = within(table).getByText('Test Chem').closest('tr') as HTMLElement;
  return within(row).getAllByRole('cell').map((c) => c.textContent?.trim());
}

beforeEach(() => {
  vi.clearAllMocks();
  route.id = 'del-1';
  mockRpc.mockResolvedValue({ data: { success: true }, error: null });
  mockFrom.mockImplementation((table: string) => buildChain(table));
});

describe('DeliveryDetail Remaining After (F05)', () => {
  it('an open load leaves out what another open load holds (DEL-00036: 0, not 1)', async () => {
    setup('scheduled', 0, [{ order_item_id: 'oi-1', quantity: 1 }], 1);
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    // Product, Ordered, Prev. Delivered, This Delivery, Remaining After, Unit
    expect((await productRow()).slice(1, 5)).toEqual(['3', '1', '1', '0']);
  });

  it('a completed load does not count its own units as delivered before it (DEL-00034: prev 0)', async () => {
    setup('completed', 1, [{ order_item_id: 'oi-1', quantity: 1 }, { order_item_id: 'oi-1', quantity: 1 }], 1);
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    // Product, Ordered, Prev. Delivered, This Delivery, Actual, Remaining After, Unit
    expect((await productRow()).slice(1, 6)).toEqual(['3', '0', '1', '1', '0']);
  });
});
