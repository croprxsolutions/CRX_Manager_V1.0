/** DeliveryDetail: a delivery edit waits until unsaved brand choices are saved (an edit can recreate the lines). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function buildChain(table: string): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  for (const m of [
    'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte',
    'lt', 'lte', 'like', 'ilike', 'is', 'in', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'returns', 'abortSignal', 'range',
  ]) self[m] = method;
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

beforeEach(() => {
  vi.clearAllMocks();
  route.id = 'del-1';
  brand.dirty = false;
  mockUpload.mockResolvedValue({ data: { path: 'x' }, error: null });
  mockSendEmail.mockResolvedValue({ success: true });
  mockRpc.mockResolvedValue({ data: { success: true }, error: null });
  tables.data = {
    deliveries: [{
      id: 'del-1', delivery_number: 'DEL-1', status: 'scheduled', scheduled_date: '2026-10-21', customer_id: 'cust-1',
      order_id: 'ord-1', assigned_driver: 'user-1', created_by: 'user-1', delivery_notes: 'old note', priority: 'normal',
    }],
    delivery_items: [{ id: 'item-1', delivery_id: 'del-1', order_item_id: 'oi-1', product_id: 'prod-1', quantity: 2, product: { product_name: 'Test Chem' } }],
    delivery_photos: [],
    delivery_remainders: [],
    customers: [{ id: 'cust-1', farm_name: 'Test Farm' }],
    customer_addresses: [],
    profile_public_view: [],
    order_items: [],
    inventory: [],
  };
  mockFrom.mockImplementation((table: string) => buildChain(table));
});

async function editAndSave() {
  render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }, { timeout: 3000 }));
  fireEvent.click(await screen.findByRole('button', { name: /Save Changes/ }));
}

const editCalls = () => mockRpc.mock.calls.filter(([name]) => name === 'edit_delivery');

describe('DeliveryDetail edit with unsaved brand choices (Sol r2 HIGH 1)', () => {
  it('refuses the edit, so recreated lines never orphan unsaved brand choices', async () => {
    brand.dirty = true;
    await editAndSave();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/Save brands/)));
    expect(editCalls()).toHaveLength(0);
  });

  it('sends the edit when no brand choice is unsaved', async () => {
    await editAndSave();
    await waitFor(() => expect(editCalls()).toHaveLength(1));
  });
});
