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

describe('DeliveryDetail edit: the driver choice (Mason 2026-11-23: the office may unassign)', () => {
  async function editDriverAndSave(choice?: string) {
    tables.data.profile_public_view = [{ id: 'user-1', full_name: 'Dana Driver', role: 'driver', is_active: true }];
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }, { timeout: 3000 }));
    await screen.findByRole('option', { name: /Dana Driver/ });
    const select = screen.getByRole('option', { name: 'Unassigned' }).closest('select')!;
    if (choice !== undefined) fireEvent.change(select, { target: { value: choice } });
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(editCalls()).toHaveLength(1));
    return editCalls()[0][1] as Record<string, unknown>;
  }

  it('Unassigned on a delivery with a driver asks the server to clear it', async () => {
    const args = await editDriverAndSave('');
    expect(args.p_clear_driver).toBe(true);
    expect(args.p_expected_driver).toBe('user-1');
    expect(args.p_assigned_driver).toBeUndefined();
  });

  it('leaving the driver alone sends no driver, so the server keeps the current one (Taha, #2364)', async () => {
    const args = await editDriverAndSave();
    expect(args.p_assigned_driver).toBeUndefined();
    expect(args).not.toHaveProperty('p_clear_driver');
    expect(args).not.toHaveProperty('p_expected_driver');
  });

  it('picking another driver sends that driver and no clear', async () => {
    tables.data.profile_public_view = [
      { id: 'user-1', full_name: 'Dana Driver', role: 'driver', is_active: true },
      { id: 'user-2', full_name: 'Lee Driver', role: 'driver', is_active: true },
    ];
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }, { timeout: 3000 }));
    await screen.findByRole('option', { name: /Lee Driver/ });
    fireEvent.change(screen.getByRole('option', { name: 'Unassigned' }).closest('select')!, { target: { value: 'user-2' } });
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(editCalls()).toHaveLength(1));
    const args = editCalls()[0][1] as Record<string, unknown>;
    expect(args.p_assigned_driver).toBe('user-2');
    expect(args).not.toHaveProperty('p_clear_driver');
    expect(args).not.toHaveProperty('p_expected_driver');
  });

  it('an inactive current driver stays selectable after another pick', async () => {
    tables.data.profile_public_view = [];
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }, { timeout: 3000 }));
    const select = (await screen.findByRole('option', { name: 'Unassigned' })).closest('select')!;
    fireEvent.change(select, { target: { value: '' } });
    expect(screen.getByRole('option', { name: 'Current driver (not in list)' })).toBeTruthy();
  });
});

describe('DeliveryDetail edit: a driver taken while the form is open (Sol r2 HIGH 1)', () => {
  it('saving the form after Take Delivery keeps the driver just taken', async () => {
    tables.data.deliveries = [{ ...(tables.data.deliveries[0] as object), assigned_driver: null }];
    tables.data.profile_public_view = [{ id: 'user-1', full_name: 'Dana Driver', role: 'driver', is_active: true }];
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }, { timeout: 3000 }));
    await screen.findByRole('option', { name: /Dana Driver/ });
    // Take Delivery: the server assigns user-1, and the page re-reads the delivery.
    tables.data.deliveries = [{ ...(tables.data.deliveries[0] as object), assigned_driver: 'user-1' }];
    fireEvent.click(screen.getByRole('button', { name: /Take Delivery/ }));
    fireEvent.click((await screen.findAllByRole('button', { name: /Take Delivery/ })).at(-1)!);
    await waitFor(() => expect(mockRpc.mock.calls.some(([n]) => n === 'reassign_delivery')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Take Delivery/ })).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(editCalls()).toHaveLength(1));
    expect(editCalls()[0][1]).not.toHaveProperty('p_clear_driver');
  });
});

describe('DeliveryDetail edit: Unassigned from a stale form (Sol r3 HIGH 1)', () => {
  it('names the driver the form showed, and shows the refusal when the driver changed since', async () => {
    tables.data.profile_public_view = [{ id: 'user-1', full_name: 'Dana Driver', role: 'driver', is_active: true }];
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'edit_delivery'
      ? { data: null, error: { message: 'DRIVER_CHANGED: the driver was changed since the form opened; reload and try again' } }
      : { data: { success: true }, error: null }));
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }, { timeout: 3000 }));
    await screen.findByRole('option', { name: /Dana Driver/ });
    fireEvent.change(screen.getByRole('option', { name: 'Unassigned' }).closest('select')!, { target: { value: '' } });
    const deliveryLoads = () => mockFrom.mock.calls.filter(([t]) => t === 'deliveries').length;
    const loadsBefore = deliveryLoads();
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(editCalls()).toHaveLength(1));
    expect(editCalls()[0][1]).toMatchObject({ p_clear_driver: true, p_expected_driver: 'user-1' });
    // sanitizeError is stubbed here; errorSanitizer.test.ts checks the plain wording.
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/driver was changed/)));
    // Sol r4 HIGH 1: the stale form closes and the delivery reloads, so the next edit shows the current driver.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Save Changes/ })).toBeNull());
    await waitFor(() => expect(deliveryLoads()).toBeGreaterThan(loadsBefore));
  });

  it('a delivery started since the form opened: the refusal closes the form and reloads (Taha, #2364)', async () => {
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'edit_delivery'
      ? { data: null, error: { message: 'Cannot edit delivery items once delivery is in progress' } }
      : { data: { success: true }, error: null }));
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }, { timeout: 3000 }));
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(editCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Save Changes/ })).toBeNull());
  });

  it('Unassigned is greyed out on a started delivery that has a driver', async () => {
    tables.data.deliveries = [{ ...(tables.data.deliveries[0] as object), status: 'in_progress' }];
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }, { timeout: 3000 }));
    expect(((await screen.findByRole('option', { name: 'Unassigned' })) as HTMLOptionElement).disabled).toBe(true);
  });

  it('unlocks the form after an unconfirmed (empty) reply, so Save can retry', async () => {
    tables.data.profile_public_view = [{ id: 'user-1', full_name: 'Dana Driver', role: 'driver', is_active: true }];
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'edit_delivery'
      ? { data: null, error: null }
      : { data: { success: true }, error: null }));
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }, { timeout: 3000 }));
    await screen.findByRole('option', { name: /Dana Driver/ });
    fireEvent.change(screen.getByRole('option', { name: 'Unassigned' }).closest('select')!, { target: { value: '' } });
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/returned no result/)));
    expect((screen.getByRole('button', { name: /Save Changes/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('option', { name: 'Unassigned' }).closest('select') as HTMLSelectElement).disabled).toBe(false);
  });

  it('re-picking the original driver after an unconfirmed Unassigned sends that driver (Sol r7 HIGH 4)', async () => {
    tables.data.profile_public_view = [{ id: 'user-1', full_name: 'Dana Driver', role: 'driver', is_active: true }];
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'edit_delivery'
      ? { data: null, error: null }
      : { data: { success: true }, error: null }));
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }, { timeout: 3000 }));
    await screen.findByRole('option', { name: /Dana Driver/ });
    const select = () => screen.getByRole('option', { name: 'Unassigned' }).closest('select')!;
    fireEvent.change(select(), { target: { value: '' } });
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/returned no result/)));
    // The clear may have landed: picking the driver back must send it, not trust the at-open value.
    fireEvent.change(select(), { target: { value: 'user-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(editCalls()).toHaveLength(2));
    expect(editCalls()[1][1]).toMatchObject({ p_assigned_driver: 'user-1' });
    expect(editCalls()[1][1]).not.toHaveProperty('p_clear_driver');
  });

  it('locks the driver list while the save is in flight, so it cannot show a pick the save ignores', async () => {
    tables.data.profile_public_view = [{ id: 'user-1', full_name: 'Dana Driver', role: 'driver', is_active: true }];
    mockRpc.mockImplementation((name: string) => (name === 'edit_delivery'
      ? new Promise(() => {})
      : Promise.resolve({ data: { success: true }, error: null })));
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }, { timeout: 3000 }));
    await screen.findByRole('option', { name: /Dana Driver/ });
    const select = screen.getByRole('option', { name: 'Unassigned' }).closest('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(editCalls()).toHaveLength(1));
    expect(select.disabled).toBe(true);
  });
});

describe('DeliveryDetail edit: Edit stays locked until the reload after a save lands (Sol r9 HIGH 8)', () => {
  it('greys out Edit while the saved delivery reloads, then frees it', async () => {
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }, { timeout: 3000 }));
    const save = await screen.findByRole('button', { name: /Save Changes/ });
    // Hold the reload's line read, so the page still shows the delivery as it was before the save.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    mockFrom.mockImplementation((table: string) => {
      const chain = buildChain(table);
      if (table === 'delivery_items') {
        const then = chain.then as (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise<unknown>;
        chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => held.then(() => then(ok, bad));
      }
      return chain;
    });
    fireEvent.click(save);
    await waitFor(() => expect(editCalls()).toHaveLength(1));
    const edit = (await screen.findByRole('button', { name: /^Edit$/ })) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    release();
    await waitFor(() => expect((screen.getByRole('button', { name: /^Edit$/ }) as HTMLButtonElement).disabled).toBe(false));
  });
});
