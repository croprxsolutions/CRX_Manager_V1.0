/**
 * DeliveryDetail.completion.test.tsx — Goal 5 completion paths on the REAL DeliveryDetail page
 * (migration 20261022075000). The server contract these tests lean on: an exact retry with the same
 * key and identical args replays the saved result before any status or evidence check.
 *
 * Covered here:
 *   - "Record without proof" is offered to an admin only (hidden for a sales rep and for a driver);
 *   - a no-proof completion sends no customer receipt email;
 *   - a failed signature upload still sends the completion, under the key whose path was uploaded;
 *   - SIGNATURE_IMAGE_MISSING retires the key, so the next tap is a fresh attempt;
 *   - a lost reply on a delivery that turns out completed is resent IDENTICALLY (same key, same
 *     args) and then runs the normal success path (receipt email included).
 *   - the "Invoices on this sale" card: always there once completed, one link per invoice (this
 *     delivery's tagged), the empty states (Create invoice… for an admin only; billed outside CRX),
 *     and it fills without a reload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const SIGNATURE_DATA_URL = `data:image/png;base64,iVBORw0KGgo${'A'.repeat(669)}`;

const { auth, mockFrom, mockNotifyCompleted, mockRpc, mockToast, mockSendEmail, mockUpload, route, tables } = vi.hoisted(() => ({
  mockNotifyCompleted: vi.fn(),
  auth: { role: 'admin', profile: { id: 'user-1', role: 'admin' }, deniedPages: [] as string[] },
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockSendEmail: vi.fn(),
  mockUpload: vi.fn(),
  route: { id: 'del-1' },
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
  supabaseUntyped: { from: mockFrom, rpc: mockRpc },
  sanitizeError: (e: unknown) => (e as Error)?.message || 'Error',
  checkMutationResult: vi.fn(),
  assertRpcResult: (d: unknown, op: string) => {
    if (d === null || d === undefined) throw new Error(`${op} returned no result`);
    return d;
  },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
// Drivers read farms through get_driver_customers (#2018); serve it from the fake customers rows.
vi.mock('../lib/driverFarms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/driverFarms')>();
  return {
    ...actual,
    // Office users read the fake customers table as before; a driver gets only the lookup's fields.
    fetchDeliveryFarm: (id: string, isDriver: boolean) => {
      if (!isDriver) return actual.fetchDeliveryFarm(id, false);
      const c = ((tables.data.customers ?? []) as { id: string; farm_name: string; email?: string | null }[])
        .find((row) => row.id === id);
      const data = c ? { id: c.id, farm_name: c.farm_name, phone: null, email: c.email ?? null, billing_address: null, shipping_address: null } : null;
      return Promise.resolve({ data, error: null });
    },
  };
});
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({
  notifyDeliveryRemainder: vi.fn(), notifyDeliveryCompleted: mockNotifyCompleted,
}));
vi.mock('../lib/connectivity', () => ({ hasSignal: () => Promise.resolve(true), NO_SIGNAL_MESSAGE: 'no signal' }));
vi.mock('../lib/deliveryPdf', () => ({ downloadDeliveryPdf: vi.fn() }));
vi.mock('../lib/emailService', () => ({ sendEmail: mockSendEmail, buildEmailHtml: () => '<p></p>', EmailUnconfirmedError: class extends Error {} }));
vi.mock('../lib/rupCompliance', () => ({ checkRUPCompliance: () => Promise.resolve({ compliant: true, warnings: [] }) }));
vi.mock('../lib/deliverySplitBilling', () => ({
  fetchSplitBillingOrderIds: () => Promise.resolve({ data: new Set(), error: null }), SPLIT_BILLING_BLOCK_REASON: '', billSplitFailed: () => false, BILL_SPLIT_FAILED_MESSAGE: '',
}));
// No branded lines: the brand list loads empty, so completion confirms it (seq 0) and warns about nothing.
vi.mock('../lib/deliveryBrands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/deliveryBrands')>()),
  getDeliveryBrands: () => brandsLoad(),
}));
const emptyBrands = async () => ({ delivery_id: 'del-1', status: 'in_progress', event_seq: 0, lines: [] });
let brandsLoad: () => Promise<unknown> = emptyBrands;
vi.mock('../lib/imageCompression', () => ({ compressImage: vi.fn() }));
vi.mock('../components/deliveries/StartDeliveryModal', () => ({ default: () => null }));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));
vi.mock('../components/ui/SignatureCanvas', () => ({
  default: ({ onSignatureChange }: { onSignatureChange: (value: string | null) => void }) => (
    <button type="button" onClick={() => onSignatureChange(SIGNATURE_DATA_URL)}>Sign here</button>
  ),
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: route.id }), useNavigate: () => vi.fn() };
});

import DeliveryDetail from './DeliveryDetail';
import { signatureImagePathFor } from '../lib/deliveryEvidence';

const OPEN_DELIVERY = {
  id: 'del-1',
  delivery_number: 'DEL-1',
  status: 'in_progress',
  scheduled_date: '2026-10-21',
  delivery_date: '2026-10-21',
  customer_id: 'cust-1',
  order_id: null,
  assigned_driver: 'user-1',
  created_by: 'user-1',
  signature_url: null,
  signed_by: null,
};

const COMPLETE_RESULT = { success: true, delivery_id: 'del-1' };

function setRole(role: 'admin' | 'sales_rep' | 'driver') {
  auth.role = role;
  auth.profile = { id: 'user-1', role };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNotifyCompleted.mockImplementation(() => Promise.resolve());
  route.id = 'del-1';
  setRole('admin');
  mockUpload.mockResolvedValue({ data: { path: 'x' }, error: null });
  mockSendEmail.mockResolvedValue({ success: true });
  tables.data = {
    deliveries: [{ ...OPEN_DELIVERY }],
    delivery_items: [{ id: 'item-1', delivery_id: 'del-1', product_id: 'prod-1', quantity: 2, product: { product_name: 'Test Chem' } }],
    delivery_photos: [],
    delivery_remainders: [],
    customers: [{ id: 'cust-1', farm_name: 'Test Farm', email: 'farmer@example.test', contact_name: 'Pat' }],
    profile_public_view: [],
    inventory: [],
  };
  mockFrom.mockImplementation((table: string) => buildChain(table));
});

async function renderPage() {
  render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
  await screen.findByText('DEL-1', undefined, { timeout: 3000 }).catch(() => undefined);
}

function completeRpcCalls() {
  return mockRpc.mock.calls.filter(([name]) => name === 'complete_delivery');
}

/** Clicks the page's Complete button, then the confirm box's Complete button. */
async function completeAndConfirm() {
  const [pageButton] = await screen.findAllByRole('button', { name: /^Complete Delivery$/ });
  fireEvent.click(pageButton);
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Complete Delivery$/ }).length).toBeGreaterThan(1));
  const buttons = screen.getAllByRole('button', { name: /^Complete Delivery$/ });
  fireEvent.click(buttons[buttons.length - 1]);
}

async function signAndFillSigner() {
  fireEvent.click(await screen.findByRole('button', { name: 'Sign here' }));
  fireEvent.change(screen.getByLabelText(/Signed By/i), { target: { value: 'Pat Farmer' } });
}

describe('Record without proof is admin-only on screen', () => {
  it('shows the option to an admin', async () => {
    await renderPage();
    expect(await screen.findByLabelText(/Record without proof/i)).toBeInTheDocument();
  });

  it('hides the option from a sales rep', async () => {
    setRole('sales_rep');
    await renderPage();
    await screen.findByRole('button', { name: /^Complete Delivery$/ });
    expect(screen.queryByLabelText(/Record without proof/i)).not.toBeInTheDocument();
  });

  it('hides the option from the assigned driver', async () => {
    setRole('driver');
    await renderPage();
    await screen.findByText(/DEL-1/);
    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('delivery_items'));
    expect(screen.queryByText(/Record without proof/i)).not.toBeInTheDocument();
  });
});

describe('completion paths', () => {
  it('completes as brands not confirmed when the brand list never finishes loading (brands never block)', async () => {
    brandsLoad = () => new Promise(() => undefined);
    try {
      mockRpc.mockResolvedValue({ data: COMPLETE_RESULT, error: null });
      await renderPage();
      fireEvent.click(await screen.findByLabelText(/Record without proof/i));
      fireEvent.change(screen.getByLabelText(/Why is there no proof/i), { target: { value: 'Customer confirmed by phone that all arrived' } });
      fireEvent.change(screen.getByLabelText(/^Delivered on$/), { target: { value: '2026-10-01' } });
      await completeAndConfirm();
      await waitFor(() => expect(completeRpcCalls()).toHaveLength(1));
      expect(completeRpcCalls()[0][1].p_brand_base_seq).toBe(-1);
    } finally {
      brandsLoad = emptyBrands;
    }
  });

  it('sends no customer receipt email after a no-proof completion, and sends its date', async () => {
    mockRpc.mockResolvedValue({ data: COMPLETE_RESULT, error: null });
    await renderPage();
    fireEvent.click(await screen.findByLabelText(/Record without proof/i));
    fireEvent.change(screen.getByLabelText(/Why is there no proof/i), { target: { value: 'Customer confirmed by phone that all arrived' } });
    expect(screen.getByLabelText(/^Delivered on$/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Delivered on$/), { target: { value: '2026-10-01' } });
    await completeAndConfirm();

    await waitFor(() => expect(completeRpcCalls()).toHaveLength(1));
    const params = completeRpcCalls()[0][1];
    expect(params.p_evidence).toBe('no_proof');
    expect(params.p_completed_at).toBe('2026-10-01T17:00:00.000Z');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.stringMatching(/Delivery completed/)));
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('still sends the completion after a failed signature upload, under the key whose path it tried', async () => {
    mockUpload.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } });
    mockRpc.mockResolvedValue({ data: COMPLETE_RESULT, error: null });
    await renderPage();
    await signAndFillSigner();
    await completeAndConfirm();

    await waitFor(() => expect(completeRpcCalls()).toHaveLength(1));
    const params = completeRpcCalls()[0][1];
    const expectedPath = await signatureImagePathFor('del-1', params.p_idempotency_key);
    expect(mockUpload).toHaveBeenCalledWith(expectedPath, expect.anything(), expect.anything());
    expect(params.p_evidence).toBe('signature');
    expect(params.p_evidence_ref).toBe(expectedPath);
  });

  it('mints a new key on the next tap after SIGNATURE_IMAGE_MISSING', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'SIGNATURE_IMAGE_MISSING: no signature image saved for this attempt' } });
    await renderPage();
    await signAndFillSigner();
    await completeAndConfirm();
    await waitFor(() => expect(completeRpcCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Complete Delivery$/ })[0]).not.toBeDisabled());

    mockRpc.mockResolvedValueOnce({ data: COMPLETE_RESULT, error: null });
    await completeAndConfirm();
    await waitFor(() => expect(completeRpcCalls()).toHaveLength(2));
    const [first, second] = completeRpcCalls().map(([, params]) => params);
    expect(second.p_idempotency_key).not.toBe(first.p_idempotency_key);
    expect(second.p_evidence_ref).toBe(await signatureImagePathFor('del-1', second.p_idempotency_key));
  });

  it('replays a lost reply identically when the delivery turns out completed, then runs the success path', async () => {
    mockRpc
      .mockImplementationOnce(() => {
        // The server committed, but the reply never arrived.
        tables.data.deliveries = [{ ...OPEN_DELIVERY, status: 'completed' }];
        return Promise.resolve({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' } });
      })
      .mockResolvedValueOnce({ data: COMPLETE_RESULT, error: null });
    await renderPage();
    await signAndFillSigner();
    await completeAndConfirm();

    await waitFor(() => expect(completeRpcCalls()).toHaveLength(2));
    const [first, replay] = completeRpcCalls().map(([, params]) => params);
    expect(replay).toEqual(first);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.stringMatching(/Delivery completed/)));
    // KI-25: the receipt is asked for in the completion itself (the replay too); the screen emails nothing.
    expect(first.p_email_receipt).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('says the delivery is completed and no receipt was sent when the identical replay also fails', async () => {
    mockRpc
      .mockImplementationOnce(() => {
        tables.data.deliveries = [{ ...OPEN_DELIVERY, status: 'completed' }];
        return Promise.resolve({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' } });
      })
      .mockResolvedValueOnce({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' } });
    await renderPage();
    await signAndFillSigner();
    await completeAndConfirm();

    await waitFor(() => expect(completeRpcCalls()).toHaveLength(2));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/an earlier attempt went through\)\. If that attempt asked for a receipt, the server sends it/)));
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('receipt opt-out when this screen cannot see the customer email (Sol, PR #1649)', () => {
  beforeEach(() => {
    // The customer row is hidden and the recipient lookup fails: the screen knows no address.
    tables.data.customers = [];
    mockRpc.mockImplementation((name: string) => name === 'get_delivery_receipt_recipient'
      ? Promise.resolve({ data: null, error: { message: 'lookup failed' } })
      : Promise.resolve({ data: COMPLETE_RESULT, error: null }));
  });

  it('still shows the receipt box, and unticking it asks for no receipt', async () => {
    await renderPage();
    const box = await screen.findByLabelText(/Email delivery receipt to customer/i);
    fireEvent.click(box);
    await signAndFillSigner();
    await completeAndConfirm();

    await waitFor(() => expect(completeRpcCalls()).toHaveLength(1));
    expect(completeRpcCalls()[0][1]).not.toHaveProperty('p_email_receipt');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.stringMatching(/Delivery completed/)));
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.anything());
  });

  it('left ticked, asks for the receipt and warns that no email was found here', async () => {
    await renderPage();
    await signAndFillSigner();
    await completeAndConfirm();

    await waitFor(() => expect(completeRpcCalls()).toHaveLength(1));
    expect(completeRpcCalls()[0][1].p_email_receipt).toBe(true);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringMatching(/No customer email was found here/)));
  });
});

const ORDER_ID = 'ord-1';
const INVOICE_ROWS = [
  { id: 'inv-1', invoice_number: 'CS-2026-0005-1', invoice_date: '2026-11-06', status: 'draft', total_amount_cents: 73483, order_id: ORDER_ID, delivery_id: 'del-1', invoice_type: 'chemical_sale', deleted_at: null, customer: { farm_name: 'Maple Hollow Farms' } },
  { id: 'inv-2', invoice_number: 'CS-2026-0005-2', invoice_date: '2026-11-06', status: 'posted', total_amount_cents: 68701, order_id: ORDER_ID, delivery_id: 'del-1', invoice_type: 'chemical_sale', deleted_at: null, customer: { farm_name: 'Cedar Ridge Ag' } },
];
// An invoice for another delivery on the same sale.
const OTHER_DELIVERY_INVOICE = { id: 'inv-9', invoice_number: 'CS-2026-0004', invoice_date: '2026-11-01', status: 'posted', total_amount_cents: 10000, order_id: ORDER_ID, delivery_id: 'del-0', invoice_type: 'chemical_sale', deleted_at: null, customer: { farm_name: 'Maple Hollow Farms' } };
const EMPTY_TEXT = 'No invoice yet. This delivery is complete but nothing has been billed.';
const REP_EMPTY_TEXT = 'No invoices you can see for this delivery. Ask the office whether it has been billed.';
const paragraph = (text: string) => (_: string, el: Element | null) => el?.tagName === 'P' && el.textContent === text;
const emptyText = paragraph(EMPTY_TEXT);

function useCompletedDeliveryOnOrder(invoices: unknown[]) {
  tables.data.deliveries = [{ ...OPEN_DELIVERY, status: 'completed', order_id: ORDER_ID }];
  tables.data.orders = [{ id: ORDER_ID, order_number: 'ORD-2026-0007', quote_id: null }];
  tables.data.invoices = invoices;
}

function invoicesCard() {
  return document.getElementById('delivery-invoices') as HTMLElement;
}

describe('Invoices on this sale card', () => {
  it('lists each invoice as one link: number, Bill to, total and a title-case status', async () => {
    useCompletedDeliveryOnOrder(INVOICE_ROWS);
    await renderPage();
    expect(await screen.findByRole('heading', { name: 'Invoices on this sale' })).toBeInTheDocument();
    const first = await screen.findByRole('link', { name: /CS-2026-0005-1/ });
    expect(first).toHaveAttribute('href', '/invoices/inv-1');
    expect(first).toHaveTextContent('Maple Hollow Farms');
    expect(first).toHaveTextContent('$734.83');
    expect(first).toHaveTextContent('Draft');
    const second = screen.getByRole('link', { name: /CS-2026-0005-2/ });
    expect(second).toHaveAttribute('href', '/invoices/inv-2');
    expect(second).toHaveTextContent('Cedar Ridge Ag');
    expect(second).toHaveTextContent('$687.01');
    expect(second).toHaveTextContent('Posted');
    expect(invoicesCard()).not.toHaveTextContent(EMPTY_TEXT);
  });

  it('tags only this delivery\'s invoices with "This delivery"', async () => {
    useCompletedDeliveryOnOrder([...INVOICE_ROWS, OTHER_DELIVERY_INVOICE]);
    await renderPage();
    expect(await screen.findByRole('link', { name: /CS-2026-0005-1/ })).toHaveTextContent('This delivery');
    expect(screen.getByRole('link', { name: /CS-2026-0005-2/ })).toHaveTextContent('This delivery');
    expect(screen.getByRole('link', { name: /CS-2026-0004/ })).not.toHaveTextContent('This delivery');
  });

  it('with only another delivery\'s invoice, an admin still sees the empty text and Create invoice…', async () => {
    useCompletedDeliveryOnOrder([OTHER_DELIVERY_INVOICE]);
    await renderPage();
    await screen.findByText(emptyText);
    expect(screen.getByRole('button', { name: 'Create invoice…' })).toBeInTheDocument();
  });

  it('billed outside CRX: shows the stored reason, no empty text and no button', async () => {
    useCompletedDeliveryOnOrder([]);
    tables.data.delivery_external_billings = [{ reason: 'Billed in the old system by the office' }];
    await renderPage();
    await screen.findByText(paragraph('Billed outside CRX. Billed in the old system by the office'));
    expect(screen.queryByText(emptyText)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create invoice/i })).not.toBeInTheDocument();
  });

  it('billed outside CRX: an admin sees the stored reason once (no second header note)', async () => {
    useCompletedDeliveryOnOrder([]);
    tables.data.delivery_external_billings = [{ reason: 'Billed in the old system by the office' }];
    await renderPage();
    await screen.findByText(paragraph('Billed outside CRX. Billed in the old system by the office'));
    expect(screen.getAllByText(/Billed outside CRX/)).toHaveLength(1);
  });

  it('billed outside CRX: a sales rep gets the plain empty text, not the stored reason', async () => {
    setRole('sales_rep');
    useCompletedDeliveryOnOrder([]);
    tables.data.delivery_external_billings = [{ reason: 'Billed in the old system by the office' }];
    await renderPage();
    await screen.findByText(paragraph(REP_EMPTY_TEXT));
    expect(screen.queryByText(/Billed outside CRX/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Billed in the old system/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create invoice/i })).not.toBeInTheDocument();
  });

  it('with no invoice, an admin sees the empty text and Create invoice… opens the existing confirm', async () => {
    useCompletedDeliveryOnOrder([]);
    await renderPage();
    await screen.findByText(emptyText);
    fireEvent.click(screen.getByRole('button', { name: 'Create invoice…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Create an invoice for this delivery?' });
    expect(within(dialog).getByText('This makes a draft invoice for completed delivery DEL-1.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create invoice' })).toBeInTheDocument();
  });

  // Review MED 1: an invoice linked by delivery_id on a delivery with no order was never found.
  it('finds an invoice linked by delivery_id on a delivery with no order (no false "No invoice yet")', async () => {
    tables.data.deliveries = [{ ...OPEN_DELIVERY, status: 'completed', order_id: null }];
    tables.data.invoices = [INVOICE_ROWS[0]];
    await renderPage();
    expect(await screen.findByRole('link', { name: /CS-2026-0005-1/ })).toHaveAttribute('href', '/invoices/inv-1');
    expect(screen.queryByText(emptyText)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create invoice…' })).not.toBeInTheDocument();
    expect(mockFrom).toHaveBeenCalledWith('invoices');
  });

  // Review MED 2: until the invoice reads return, neither the empty text nor Create invoice shows.
  it('shows neither "No invoice yet" nor Create invoice… while the invoice read is still pending', async () => {
    useCompletedDeliveryOnOrder([]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockFrom.mockImplementation((table: string) => {
      const chain = buildChain(table) as { then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => unknown };
      if (table !== 'invoices') return chain;
      const realThen = chain.then;
      chain.then = (ok, bad) => gate.then(() => realThen(ok, bad));
      return chain;
    });
    render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('invoices'));
    expect(screen.queryByText(emptyText)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create invoice…' })).not.toBeInTheDocument();
    release();
    await screen.findByText(emptyText);
    expect(screen.getByRole('button', { name: 'Create invoice…' })).toBeInTheDocument();
  });

  // Attack LOW-3: drivers cannot read invoices (RLS) and FieldStop tells them billing is not their job.
  it('a driver on a completed delivery sees no Invoices on this sale card, even with invoices on the sale', async () => {
    setRole('driver');
    useCompletedDeliveryOnOrder(INVOICE_ROWS);
    await renderPage();
    expect((await screen.findAllByText('DEL-1')).length).toBeGreaterThan(0);
    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('invoices'));
    expect(screen.queryByRole('heading', { name: 'Invoices on this sale' })).not.toBeInTheDocument();
    expect(invoicesCard()).toBeNull();
    expect(screen.queryByText(paragraph(REP_EMPTY_TEXT))).not.toBeInTheDocument();
  });

  it('with no invoice, a sales rep is told none he can see, without the button', async () => {
    setRole('sales_rep');
    useCompletedDeliveryOnOrder([]);
    await renderPage();
    await screen.findByText(paragraph(REP_EMPTY_TEXT));
    expect(screen.queryByText(emptyText)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create invoice/i })).not.toBeInTheDocument();
  });

  it('fills right after completion, without waiting for the notifications (No invoices until refresh)', async () => {
    tables.data.deliveries = [{ ...OPEN_DELIVERY, order_id: ORDER_ID }];
    tables.data.orders = [{ id: ORDER_ID, order_number: 'ORD-2026-0007', quote_id: null }];
    tables.data.invoices = [];
    // The follow-up notifications are slow (or never finish): the page must not wait on them.
    mockNotifyCompleted.mockImplementation(() => new Promise(() => undefined));
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'complete_delivery') return Promise.resolve({ data: null, error: null });
      tables.data.deliveries = [{ ...OPEN_DELIVERY, order_id: ORDER_ID, status: 'completed' }];
      tables.data.invoices = INVOICE_ROWS;
      return Promise.resolve({ data: { ...COMPLETE_RESULT, bill_split_invoices: [{ invoice_number: 'CS-2026-0005-1' }, { invoice_number: 'CS-2026-0005-2' }] }, error: null });
    });
    await renderPage();
    await signAndFillSigner();
    await completeAndConfirm();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.stringMatching(/Draft invoices CS-2026-0005-1, CS-2026-0005-2 created/)));
    expect(await screen.findByRole('link', { name: /CS-2026-0005-1/ })).toHaveAttribute('href', '/invoices/inv-1');
  });
});

// KI-25 follow-up (20261221100000): Email Confirmation pauses a queued receipt before its hand send, so the server
// cannot email a second copy afterwards, and marks it handled once the email went out.
describe('Email Confirmation and the server receipt queue', () => {
  const COMPLETED = { ...OPEN_DELIVERY, status: 'completed', completed_at: '2026-10-21T15:00:00Z', signed_by: 'Pat' };
  const answer = (over: Record<string, unknown> = {}) => ({
    data: { delivery_id: 'del-1', outcome: 'paused', previous_status: 'pending', sent_at: null, send_authorized_at: null, queued_at: '2026-10-21T15:00:00.123456+00:00', ...over },
    error: null,
  });
  const closeCalls = () => mockRpc.mock.calls.filter(([name]) => name === 'close_delivery_receipt').map(([, args]) => args.p_reason);

  beforeEach(() => { tables.data.deliveries = [{ ...COMPLETED }]; });

  it('pauses the queued receipt before sending, then marks it handled', async () => {
    const order: string[] = [];
    mockRpc.mockImplementation((name: string, args: { p_reason?: string }) => {
      if (name === 'close_delivery_receipt') order.push(`close:${args.p_reason}`);
      return Promise.resolve(answer(args.p_reason === 'handled' ? { outcome: 'closed', previous_status: 'needs_check' } : {}));
    });
    mockSendEmail.mockImplementation(() => { order.push('send'); return Promise.resolve({ success: true }); });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Email Confirmation/ }));
    await waitFor(() => expect(order).toEqual(['close:manual_send', 'send', 'close:handled']));
    expect(mockToast).toHaveBeenCalledWith('success', 'Confirmation email sent to farmer@example.test');
  });

  it('a failed send leaves the receipt paused on the office list (never marked handled)', async () => {
    mockRpc.mockImplementation(() => Promise.resolve(answer()));
    mockSendEmail.mockRejectedValue(new Error('provider down'));
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Email Confirmation/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'provider down'));
    expect(closeCalls()).toEqual(['manual_send']);
    // The office is told the server will not send it either (Taha LOW).
    expect(mockToast).toHaveBeenCalledWith('warning', expect.stringMatching(/did not go out.*server will not send it/));
  });

  it('an unconfirmed send never says the email did not go out (Codex P2)', async () => {
    const { EmailUnconfirmedError } = await import('../lib/emailService');
    mockRpc.mockImplementation(() => Promise.resolve(answer()));
    mockSendEmail.mockRejectedValue(new EmailUnconfirmedError('no answer; this email may have been sent'));
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Email Confirmation/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringMatching(/may have gone out.*Check before sending again/)));
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.stringMatching(/did not go out/));
    expect(closeCalls()).toEqual(['manual_send']);
  });

  it('cancelling the second-copy question says the server may already have sent it (Taha LOW)', async () => {
    mockRpc.mockImplementation(() => Promise.resolve(answer({ send_authorized_at: '2026-10-21T15:04:00Z' })));
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Email Confirmation/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringMatching(/may already have emailed.*Check with the customer before sending/)));
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.stringMatching(/did not go out/));
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('asks before sending another copy when the server already emailed it, and sends only on yes', async () => {
    mockRpc.mockImplementation(() => Promise.resolve(answer({ outcome: 'sent', previous_status: 'sent', sent_at: '2026-10-21T15:05:00Z', send_authorized_at: '2026-10-21T15:04:00Z' })));
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Email Confirmation/ }));
    expect(await screen.findByText(/The server already emailed this receipt/)).toBeInTheDocument();
    expect(mockSendEmail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send another copy' }));
    await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
    // The confirmed copy is asked again (the server re-checks the delivery is still completed), without a second dialog.
    await waitFor(() => expect(closeCalls()).toEqual(['manual_send', 'manual_send', 'handled']));
  });

  it('while the server is emailing it, says to try again in a minute and sends nothing', async () => {
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'DELIVERY_RECEIPT_SENDING: this delivery receipt is being emailed right now' } }));
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Email Confirmation/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', 'The server is emailing this receipt right now. Try again in a minute.'));
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
  it('a confirmed second copy sends nothing when the delivery was voided meanwhile (Sol HIGH)', async () => {
    let calls = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'close_delivery_receipt') return Promise.resolve({ data: null, error: null });
      calls += 1;
      return Promise.resolve(calls === 1
        ? answer({ outcome: 'sent', previous_status: 'sent', sent_at: '2026-10-21T15:05:00Z' })
        : { data: null, error: { message: 'DELIVERY_NOT_COMPLETED: this delivery is not completed any more; do not send its receipt' } });
    });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Email Confirmation/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send another copy' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/not completed any more/))); // wording: errorSanitizer.test.ts
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('closes only the receipt it paused: the pause answer queued_at goes back unchanged (#2251)', async () => {
    mockRpc.mockImplementation(() => Promise.resolve(answer()));
    mockSendEmail.mockResolvedValue({ success: true });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Email Confirmation/ }));
    await waitFor(() => expect(closeCalls()).toEqual(['manual_send', 'handled']));
    const calls = mockRpc.mock.calls.filter(([name]) => name === 'close_delivery_receipt').map(([, args]) => args);
    expect(calls[0]).not.toHaveProperty('p_expected_queued_at'); // the pause takes whatever receipt is queued (Mason, 2026-11-22)
    expect(calls[1].p_expected_queued_at).toBe('2026-10-21T15:00:00.123456+00:00'); // to the microsecond, never through Date
  });

  it('when the server says the receipt changed during the send, leaves it and never says to mark it handled (#2251)', async () => {
    mockRpc.mockImplementation((_name: string, args: { p_reason?: string }) => Promise.resolve(args.p_reason === 'handled'
      ? { data: null, error: { message: "DELIVERY_RECEIPT_CHANGED: this delivery's receipt was queued again since; reload the page" } }
      : answer()));
    mockSendEmail.mockResolvedValue({ success: true });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Email Confirmation/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringMatching(/receipt changed while it was sending, so it was left as it is/)));
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.stringMatching(/Mark it handled there/));
  });

  it('with no receipt queued when the send started, closes nothing afterwards (#2251)', async () => {
    mockRpc.mockImplementation(() => Promise.resolve(answer({ outcome: 'none', previous_status: null, queued_at: null })));
    mockSendEmail.mockResolvedValue({ success: true });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Email Confirmation/ }));
    await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(closeCalls()).toEqual(['manual_send']);
  });

});

describe('Email Confirmation warning belongs to its own delivery', () => {
  it('a late "already sent" answer for delivery A never opens the warning on delivery B', async () => {
    tables.data.deliveries = [{ ...OPEN_DELIVERY, status: 'completed', completed_at: '2026-10-21T15:00:00Z', signed_by: 'Pat' }];
    let finishA: (v: unknown) => void = () => {};
    mockRpc.mockImplementation((name: string) => name === 'close_delivery_receipt'
      ? new Promise((resolve) => { finishA = resolve; })
      : Promise.resolve({ data: null, error: null }));
    const view = render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Email Confirmation/ }, { timeout: 3000 }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('close_delivery_receipt', expect.anything()));
    // The office moves to delivery B before A's answer arrives.
    route.id = 'del-2';
    tables.data.deliveries = [{ ...OPEN_DELIVERY, id: 'del-2', delivery_number: 'DEL-2', status: 'completed', completed_at: '2026-10-21T15:00:00Z', signed_by: 'Pat' }];
    view.rerender(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    await screen.findAllByText('DEL-2', undefined, { timeout: 3000 });
    finishA({ data: { delivery_id: 'del-1', outcome: 'sent', previous_status: 'sent', sent_at: '2026-10-21T15:05:00Z', send_authorized_at: null }, error: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: 'Send another copy' })).not.toBeInTheDocument();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

});
