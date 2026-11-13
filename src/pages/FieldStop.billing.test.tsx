/**
 * FieldStop.billing.test.tsx: what the driver is told about billing on the review and done steps.
 * The done step reads the same completion response the toasts use (invoice numbers, or the Bill Split
 * failure flag). Toasts are unchanged and not asserted here beyond the completion itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const SIGNATURE_DATA_URL = `data:image/png;base64,iVBORw0KGgo${'A'.repeat(669)}`;

const { mockFrom, mockNavigate, mockRpc, mockToast, tables } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockNavigate: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
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
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'driver-1', role: 'driver' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyDeliveryRemainder: vi.fn(), notifyDeliveryCompleted: vi.fn() }));
vi.mock('../lib/connectivity', () => ({ hasSignal: () => Promise.resolve(true), NO_SIGNAL_MESSAGE: 'no signal' }));
vi.mock('../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }));
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

beforeEach(() => {
  vi.clearAllMocks();
  tables.data = {
    deliveries: [{
      id: 'del-1', delivery_number: 'DEL-00005', status: 'in_progress', updated_at: null, customer_id: 'cust-1',
      order_id: 'ord-1', created_by: 'user-1', delivery_address_id: null, delivery_notes: null, assigned_driver: 'driver-1',
      customer: { farm_name: 'Maple Hollow Farms', email: 'farm@example.test', contact_name: 'J. Hollow' },
    }],
    delivery_items: [{ id: 'item-1', quantity: 2, product_id: 'prod-1', product: { product_name: 'Test Chem' } }],
    delivery_photos: [],
  };
  mockFrom.mockImplementation((table: string) => buildChain(table));
});

/** Walks the stop to the review step: items, signature, signer. */
async function reachReview() {
  render(<MemoryRouter><FieldStop /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /All Full/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Sign here' }));
  fireEvent.change(screen.getByLabelText(/Signed by/), { target: { value: 'J. Hollow' } });
  fireEvent.click(screen.getByRole('button', { name: /Continue to Review/ }));
}

async function completeWith(result: unknown) {
  mockRpc.mockImplementation((name: string) => Promise.resolve(
    name === 'complete_delivery' ? { data: result, error: null } : { data: null, error: null },
  ));
  await reachReview();
  fireEvent.click(await screen.findByRole('button', { name: /Complete Delivery/ }));
  await screen.findByText('Delivery complete');
}

describe('FieldStop billing lines', () => {
  it('tells the driver on the review step what happens next, and that billing is not his job', async () => {
    await reachReview();
    const box = await screen.findByText('What happens next');
    expect(box.closest('div')?.parentElement).toHaveTextContent(
      "Stock comes off the truck. The office gets a draft invoice to check. You don't need to do anything about billing.",
    );
    expect(screen.queryByText(/Inventory will be deducted/)).not.toBeInTheDocument();
  });

  it('names the Bill Split invoices on the done step', async () => {
    await completeWith({ success: true, bill_split_invoices: [{ invoice_number: 'CS-2026-0005-1' }, { invoice_number: 'CS-2026-0005-2' }] });
    expect(screen.getByText('Billing done.').parentElement).toHaveTextContent(
      'Billing done. The office has 2 draft invoices for this delivery (CS-2026-0005-1, CS-2026-0005-2).',
    );
  });

  it('names the single auto invoice on the done step', async () => {
    await completeWith({ success: true, auto_invoice: { invoice_id: 'inv-1', invoice_number: 'INV-77' } });
    expect(screen.getByText('Billing done.').parentElement).toHaveTextContent(
      'Billing done. The office has 1 draft invoice for this delivery (INV-77).',
    );
  });

  it('says the office will finish billing after the Bill Split failure response', async () => {
    await completeWith({ success: true, bill_split_failed: true, bill_split_invoices: [] });
    expect(screen.getByText('The office will finish billing.').parentElement).toHaveTextContent(
      'The office will finish billing. The invoices for this delivery could not be made automatically. The office has been told. Nothing for you to do.',
    );
    expect(screen.queryByText('Billing done.')).not.toBeInTheDocument();
    // The toast is unchanged.
    expect(mockToast).toHaveBeenCalledWith('warning', expect.stringMatching(/Bill Split invoices couldn't be drafted/));
  });

  it('says nothing about billing when no invoice came back and nothing failed (as today)', async () => {
    await completeWith({ success: true });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Delivery completed'));
    expect(screen.queryByText('Billing done.')).not.toBeInTheDocument();
    expect(screen.queryByText('The office will finish billing.')).not.toBeInTheDocument();
  });
});
