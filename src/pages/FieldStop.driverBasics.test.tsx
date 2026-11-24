/**
 * FieldStop.driverBasics.test.tsx: the stop screen's driver basics. Where to go (an address even when the
 * delivery has no address of its own), Call and Navigate, the one-tap Signed by name, Next Stop opening the
 * next stop on today's route, the one no-signal message, today's saved copy of the stop in a dead spot, and
 * reporting an issue in the completion step (sent with complete_delivery as the delivery detail sends it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { todayInBusinessTz } from '../lib/dateUtils';

const SIGNATURE_DATA_URL = `data:image/png;base64,iVBORw0KGgo${'A'.repeat(669)}`;

const { mockFrom, mockNavigate, mockRpc, mockToast, env, tables } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  // Stable across renders, as the real hook is (fetchStop depends on it).
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
  mockRpc: vi.fn(),
  env: { role: 'driver', online: true, contact: 'J. Hollow' as string | null },
  tables: { data: {} as Record<string, unknown[]> },
}));

function buildChain(table: string): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = () => self;
  for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'is', 'in', 'order', 'limit']) self[m] = method;
  const rows = () => tables.data[table] ?? [];
  self.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
  self.single = self.maybeSingle;
  self.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve({ data: rows(), error: null }).then(ok, bad);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: {
    from: mockFrom,
    rpc: mockRpc,
    storage: { from: () => ({ upload: () => Promise.resolve({ data: { path: 'x' }, error: null }) }) },
  },
  sanitizeError: (e: unknown) => (e as Error)?.message || 'Error',
  checkMutationResult: vi.fn(),
  assertRpcResult: (d: unknown, op: string) => {
    if (d === null || d === undefined) throw new Error(`${op} returned no result`);
    return d;
  },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'driver-1', role: env.role } }) }));
vi.mock('../lib/driverFarms', () => ({
  fetchDriverFarms: (ids: string[]) => Promise.resolve(new Map(
    ((tables.data.customers ?? []) as { id: string; farm_name: string; email?: string | null; phone?: string | null }[])
      .filter((c) => ids.includes(c.id))
      .map((c) => [c.id, { id: c.id, farm_name: c.farm_name, phone: c.phone ?? null, email: c.email ?? null, address: null }]),
  )),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyDeliveryRemainder: vi.fn(), notifyDeliveryCompleted: vi.fn() }));
vi.mock('../lib/connectivity', () => ({ hasSignal: () => Promise.resolve(true), NO_SIGNAL_MESSAGE: 'no signal' }));
vi.mock('../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => env.online }));
vi.mock('../hooks/useUnsavedChanges', () => ({ useUnsavedChanges: () => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }) }));
vi.mock('../lib/imageCompression', () => ({ compressImage: vi.fn() }));
vi.mock('../components/deliveries/useDeliveryBrands', () => ({
  useDeliveryBrands: () => ({ dirty: false, brands: null, drafts: {}, saveForCompletion: () => Promise.resolve(-1) }),
}));
vi.mock('../components/deliveries/DeliveryBrandPicker', () => ({ DeliveryBrandsPanel: () => null }));
vi.mock('../components/ui/SignatureCanvas', () => ({
  default: ({ onSignatureChange }: { onSignatureChange: (value: string | null) => void }) => (
    <button type="button" onClick={() => onSignatureChange(SIGNATURE_DATA_URL)}>Sign here</button>
  ),
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'del-1' }), useNavigate: () => mockNavigate };
});

import FieldStop from './FieldStop';

const baseStop = {
  id: 'del-1', delivery_number: 'DEL-00005', status: 'scheduled', updated_at: null, customer_id: 'cust-1',
  order_id: 'ord-1', created_by: 'user-1', delivery_address_id: null, delivery_notes: null, assigned_driver: 'driver-1',
  scheduled_date: todayInBusinessTz(),
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  env.role = 'driver';
  env.online = true;
  env.contact = 'J. Hollow';
  tables.data = {
    deliveries: [baseStop],
    delivery_items: [{ id: 'item-1', quantity: 2, product_id: 'prod-1', product: { product_name: 'Test Chem' } }],
    customers: [{ id: 'cust-1', farm_name: 'Maple Hollow Farms', email: 'farm@example.test', phone: '(618) 555-0142' }],
    delivery_photos: [],
  };
  mockFrom.mockImplementation((table: string) => buildChain(table));
  mockRpc.mockImplementation((name: string) => Promise.resolve(
    name === 'get_delivery_receipt_recipient'
      ? { data: { farm_name: 'Maple Hollow Farms', contact_name: env.contact, email: 'farm@example.test' }, error: null }
      : name === 'complete_delivery' ? { data: { success: true }, error: null } : { data: null, error: null },
  ));
});

describe('FieldStop: where to go', () => {
  it('shows the farm address for the office when the delivery has no address of its own, with Call and Navigate', async () => {
    env.role = 'admin';
    tables.data.deliveries = [{
      ...baseStop,
      customer: { farm_name: 'Maple Hollow Farms', email: 'farm@example.test', contact_name: 'J. Hollow', phone: '618-555-0142 x9', shipping_address: '', billing_address: '12 Main St, Robinson, IL' },
    }];
    render(<MemoryRouter><FieldStop /></MemoryRouter>);
    expect(await screen.findByText('12 Main St, Robinson, IL')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Call/ })).toHaveAttribute('href', 'tel:6185550142');
    expect(screen.getByRole('link', { name: /Navigate/ })).toHaveAttribute(
      'href', 'https://www.google.com/maps/dir/?api=1&destination=12%20Main%20St%2C%20Robinson%2C%20IL',
    );
  });

  it('navigates to the delivery address pin when it has one, and calls the farm phone from the driver lookup', async () => {
    tables.data.deliveries = [{ ...baseStop, delivery_address_id: 'addr-1' }];
    tables.data.customer_addresses = [{ address_line: '900 Field Rd', city: 'Oblong', state: 'IL', zip: '62449', latitude: 39.0012, longitude: -87.9083 }];
    render(<MemoryRouter><FieldStop /></MemoryRouter>);
    expect(await screen.findByText('900 Field Rd, Oblong, IL, 62449')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Navigate/ })).toHaveAttribute(
      'href', 'https://www.google.com/maps/dir/?api=1&destination=39.0012%2C-87.9083',
    );
    expect(screen.getByRole('link', { name: /Call/ })).toHaveAttribute('href', 'tel:6185550142');
  });

  it('shows no Call or Navigate button when there is no phone or address on file', async () => {
    tables.data.customers = [{ id: 'cust-1', farm_name: 'Maple Hollow Farms', email: 'farm@example.test', phone: null }];
    render(<MemoryRouter><FieldStop /></MemoryRouter>);
    expect(await screen.findByText(/Tap Start Delivery when you arrive/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Call/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Navigate/ })).not.toBeInTheDocument();
  });

  it('shows delivery notes full size and wrapped, not cut to one line', async () => {
    tables.data.deliveries = [{ ...baseStop, delivery_notes: 'Gate code 4471. Leave by the north bin.' }];
    render(<MemoryRouter><FieldStop /></MemoryRouter>);
    const notes = await screen.findByText('Gate code 4471. Leave by the north bin.');
    expect(notes).toHaveClass('text-base', 'whitespace-pre-wrap');
    expect(notes).not.toHaveClass('truncate');
  });
});

/** An in-progress stop walked to the Sign step. */
async function reachSign() {
  tables.data.deliveries = [{ ...baseStop, status: 'in_progress' }];
  render(<MemoryRouter><FieldStop /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /All Full/ }));
}

describe('FieldStop: Signed by', () => {

  it('offers the loaded contact name as a one tap chip that fills the field, still editable', async () => {
    await reachSign();
    fireEvent.click(await screen.findByRole('button', { name: 'Use J. Hollow' }));
    const input = screen.getByLabelText(/Signed by/);
    expect(input).toHaveValue('J. Hollow');
    expect(screen.queryByRole('button', { name: 'Use J. Hollow' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Sam Hollow' } });
    expect(input).toHaveValue('Sam Hollow');
    expect(screen.getByRole('button', { name: 'Use J. Hollow' })).toBeInTheDocument();
  });

  it('sends the name the driver picked as the signer, unchanged', async () => {
    await reachSign();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign here' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use J. Hollow' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue to Review/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Complete Delivery/ }));
    await screen.findByText('Delivery complete');
    expect(mockRpc).toHaveBeenCalledWith('complete_delivery', expect.objectContaining({ p_signed_by: 'J. Hollow' }));
  });
});

describe('FieldStop: reporting an issue in the completion step', () => {
  it('a driver reports a damaged product from the stop screen and it goes with the same complete_delivery save', async () => {
    await reachSign();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign here' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use J. Hollow' }));
    // Notes appear only once a type is chosen, as on the delivery detail.
    expect(screen.queryByLabelText('Describe the issue')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Report an issue/), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('Describe the issue'), { target: { value: '  one jug cracked  ' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue to Review/ }));
    // The driver sees the issue before completing.
    expect(await screen.findByText('Issue')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Complete Delivery/ }));
    await screen.findByText('Delivery complete');
    const calls = mockRpc.mock.calls.filter(([name]) => name === 'complete_delivery');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(expect.objectContaining({
      p_delivery_id: 'del-1', p_signed_by: 'J. Hollow', p_evidence: 'signature',
      p_issue_type: 'other', p_issue_notes: 'one jug cracked',
    }));
  });

  it('sends no issue fields when none is reported (the completion is unchanged)', async () => {
    await reachSign();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign here' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use J. Hollow' }));
    expect(screen.getByLabelText(/Report an issue/)).toHaveValue('none');
    fireEvent.click(screen.getByRole('button', { name: /Continue to Review/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Complete Delivery/ }));
    await screen.findByText('Delivery complete');
    const params = mockRpc.mock.calls.find(([name]) => name === 'complete_delivery')![1];
    expect(params).not.toHaveProperty('p_issue_type');
    expect(params).not.toHaveProperty('p_issue_notes');
  });
});

describe('FieldStop: Next Stop', () => {
  async function completeStop() {
    await reachSign();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign here' }));
    fireEvent.change(screen.getByLabelText(/Signed by/), { target: { value: 'J. Hollow' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue to Review/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Complete Delivery/ }));
    await screen.findByText('Delivery complete');
  }

  it('opens the next open stop on today\'s route', async () => {
    await completeStop();
    tables.data.deliveries = [
      { ...baseStop, id: 'del-1', status: 'completed' },
      { ...baseStop, id: 'del-tomorrow', scheduled_date: '2999-01-01' },
      { ...baseStop, id: 'del-2' },
    ];
    fireEvent.click(screen.getByRole('button', { name: /Next Stop/ }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/my-route/del-2'));
  });

  it('goes back to My Route when no stop remains today', async () => {
    await completeStop();
    tables.data.deliveries = [{ ...baseStop, id: 'del-tomorrow', scheduled_date: '2999-01-01' }];
    fireEvent.click(screen.getByRole('button', { name: /Next Stop/ }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/my-route'));
  });

  it('does not move a driver who already left the screen while Next Stop was still looking', async () => {
    await completeStop();
    let reply: (v: unknown) => void = () => {};
    mockFrom.mockImplementation((table: string) => {
      const chain = buildChain(table);
      if (table === 'deliveries') chain.then = (ok: (v: unknown) => unknown) => new Promise((r) => { reply = r; }).then(ok);
      return chain;
    });
    fireEvent.click(screen.getByRole('button', { name: /Next Stop/ }));
    mockNavigate.mockClear();
    await new Promise((r) => setTimeout(r, 0));
    cleanup(); // the driver tapped Back
    reply({ data: [{ ...baseStop, id: 'del-2' }], error: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('FieldStop: no signal', () => {
  it('shows one honest message: nothing is saved offline', async () => {
    env.online = false;
    render(<MemoryRouter><FieldStop /></MemoryRouter>);
    const message = await screen.findByText(/nothing on your route is saved offline/);
    expect(message).toBeInTheDocument();
    expect(screen.getAllByText(/saved offline/)).toHaveLength(1);
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();
    expect(screen.queryByText(/save locally/)).not.toBeInTheDocument();
  });
});

describe('FieldStop: saved copy in a dead spot', () => {
  function failStopRead() {
    mockFrom.mockImplementation((table: string) => {
      const chain = buildChain(table);
      if (table === 'deliveries') chain.maybeSingle = () => Promise.resolve({ data: null, error: { message: 'TypeError: Failed to fetch' } });
      return chain;
    });
  }

  it('shows today\'s saved copy, read-only, instead of sending the driver back to My Route', async () => {
    tables.data.deliveries = [{ ...baseStop, delivery_notes: 'Gate code 4471.' }];
    const first = render(<MemoryRouter><FieldStop /></MemoryRouter>);
    expect(await screen.findByText('Gate code 4471.')).toBeInTheDocument();
    first.unmount();

    failStopRead();
    render(<MemoryRouter><FieldStop /></MemoryRouter>);
    expect(await screen.findByText(/^No signal — showing this stop as of /)).toBeInTheDocument();
    expect(screen.getByText("You can't start or complete this stop until signal returns.")).toBeInTheDocument();
    expect(screen.getByText('Maple Hollow Farms')).toBeInTheDocument();
    expect(screen.getByText('Gate code 4471.')).toBeInTheDocument();
    expect(screen.getByText('Test Chem')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Call/ })).toHaveAttribute('href', 'tel:6185550142');
    expect(screen.getByRole('button', { name: /Needs signal to start/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Start Delivery/ })).not.toBeInTheDocument();
    // Like the main button, nothing on the saved copy can report an issue.
    expect(screen.queryByLabelText(/Report an issue/)).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalledWith('/my-route');
    expect(mockToast).not.toHaveBeenCalledWith('error', 'Could not load this stop');
  });

  it('saves no customer email on the phone', async () => {
    render(<MemoryRouter><FieldStop /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: /Start Delivery/ })).toBeInTheDocument();
    const stored = Object.keys(window.localStorage).map((key) => window.localStorage.getItem(key) ?? '').join('');
    expect(stored).toContain('Maple Hollow Farms');
    expect(stored).not.toContain('farm@example.test');
  });

  it('opens the live stop again when Try again finds signal', async () => {
    const first = render(<MemoryRouter><FieldStop /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: /Start Delivery/ })).toBeInTheDocument();
    first.unmount();
    failStopRead();
    render(<MemoryRouter><FieldStop /></MemoryRouter>);
    // Still no signal: the saved copy stays.
    fireEvent.click(await screen.findByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('button', { name: /Try again/ })).toBeEnabled();
    expect(screen.getByText(/^No signal — showing this stop/)).toBeInTheDocument();
    mockFrom.mockImplementation((table: string) => buildChain(table));
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('button', { name: /Start Delivery/ })).toBeInTheDocument();
    expect(screen.queryByText(/^No signal — showing this stop/)).not.toBeInTheDocument();
  });

  it('still goes back to My Route when there is no saved copy', async () => {
    failStopRead();
    render(<MemoryRouter><FieldStop /></MemoryRouter>);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/my-route'));
    expect(mockToast).toHaveBeenCalledWith('error', 'Could not load this stop');
  });
});
