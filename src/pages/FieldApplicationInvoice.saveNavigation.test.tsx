/**
 * FieldApplicationInvoice.saveNavigation.test.tsx — first Save of a NEW field-app invoice.
 *
 * Bug (2026-10-09): after a successful first Save the page called setDirty(false) and
 * navigate() back-to-back. The router still held the block check from the last
 * committed render (dirty = true), so it blocked the move and showed a false
 * "Unsaved Changes" prompt. Choosing Stay left the user on /invoices/field-app/new, and
 * a second Save sent p_invoice_id = null again, creating a SECOND invoice.
 *
 * Follow-up (CodeRabbit, PR #893): the id of the invoice that first Save created must
 * survive a page refresh. It is written into the address (/new?created=<id>); a refresh
 * opens the created invoice, and pressing New there starts a genuinely new one.
 *
 * Unlike FieldApplicationInvoice.test.tsx, this file uses the REAL router (a data router,
 * as App.tsx does), the REAL route wrapper and the REAL useUnsavedChanges hook, because
 * the bug lives in how those interact. Only the database, auth and toast are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';

// In Vitest, 'react-router-dom' (the page's useNavigate) and 'react-router' (the hook's
// useBlocker) can resolve to two separate module copies with two separate router
// contexts. The app bundle has one copy. Point the page's import at the same copy the
// hook and this test use, so the page runs inside ONE data router as it does in the app.
vi.mock('react-router-dom', async () => vi.importActual('react-router'));

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: <T,>(data: T) => data,
  checkMutationResult: () => {},
  sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  RpcErrorCodes: {
    ZERO_APPLIED_ACRES: 'ZERO_APPLIED_ACRES',
    ACTOR_MISMATCH: 'ACTOR_MISMATCH',
    INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED: 'INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED',
    INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED: 'INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED',
  },
  hasRpcCode: () => false,
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import FieldApplicationInvoiceRoute from '../components/FieldApplicationInvoiceRoute';

const CREATED_ID = '3f2b8c1e-5d4a-4b6f-9a1c-2e7d8f9a0b1c';
const SECOND_ID = '7a9d2e4f-1b3c-4d5e-8f6a-0b1c2d3e4f5a';
const NEW_PATH = '/invoices/field-app/new';

/** Invoices the page's "is this my new draft?" check can read, by id. */
const invoiceRows = new Map<string, Record<string, unknown>>();
let invoiceCheckError: { message: string } | null = null;
/** When true, the check never answers (a slow network), so the page is still checking. */
let invoiceCheckHangs = false;

function ownNewDraft(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, invoice_type: 'field_application', status: 'draft', created_by: 'user-1',
    created_at: new Date().toISOString(), ...overrides,
  };
}

function emptyChain() {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'gte', 'lte', 'order', 'limit', 'update', 'insert', 'delete']) {
    chain[m] = vi.fn(() => chain);
  }
  const result = { data: [], error: null };
  chain.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
  chain.then = (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

/** Like emptyChain, but maybeSingle answers the check with the row for the filtered id. */
function invoicesChain() {
  const chain = emptyChain();
  let idFilter: string | null = null;
  chain.eq = vi.fn((column: string, value: string) => {
    if (column === 'id') idFilter = value;
    return chain;
  });
  chain.maybeSingle = vi.fn(() => (invoiceCheckHangs
    ? new Promise(() => {})
    : Promise.resolve(invoiceCheckError
      ? { data: null, error: invoiceCheckError }
      : { data: (idFilter && invoiceRows.get(idFilter)) || null, error: null })));
  return chain;
}

function SavedInvoicePage() {
  const { id } = useParams();
  return <p>Saved invoice page {id}</p>;
}

/** The app's routes for this page: /new through the real wrapper, /:id stubbed. */
async function renderAt(entry = NEW_PATH) {
  const router = createMemoryRouter(
    [
      { path: NEW_PATH, element: <FieldApplicationInvoiceRoute /> },
      { path: '/invoices/field-app/:id', element: <SavedInvoicePage /> },
    ],
    { initialEntries: [entry] },
  );
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  return router;
}

/** Billing details fail on the FIRST attempt only: the invoice is created, the form stays dirty. */
function mockSaveWithFirstBillingFailure(invoiceId: string) {
  let billingAttempts = 0;
  mockRpc.mockImplementation((name: string) => {
    if (name === 'save_field_app_invoice') {
      return Promise.resolve({ data: { invoice_ids: [invoiceId], invoice_group_id: null }, error: null });
    }
    if (name === 'update_field_app_invoice_billing') {
      billingAttempts += 1;
      return Promise.resolve(billingAttempts === 1
        ? { data: null, error: { message: 'network blip' } }
        : { data: { success: true }, error: null });
    }
    return Promise.resolve({ data: { success: true }, error: null });
  });
}

function saveCalls() {
  return mockRpc.mock.calls.filter(([name]) => name === 'save_field_app_invoice');
}

function savedInvoiceId(call: number) {
  return (saveCalls()[call][1] as { p_invoice_id: string | null }).p_invoice_id;
}

const headerNotes = () => screen.getByPlaceholderText('Printed at top of invoice') as HTMLInputElement;

/** Make the form dirty the way a user does: type into a field. */
function editHeaderNotes(value: string) {
  fireEvent.change(headerNotes(), { target: { value } });
}

/** First Save creates the invoice, billing fails, the leave-page prompt appears, the user stays. */
async function createWithPartialFailureAndStay() {
  editHeaderNotes('Spray north field');
  fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'Stay' }));
  await waitFor(() => expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument());
}

describe('FieldApplicationInvoice — first Save of a new invoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoiceRows.clear();
    invoiceCheckError = null;
    invoiceCheckHangs = false;
    mockFrom.mockImplementation((table: string) => (table === 'invoices' ? invoicesChain() : emptyChain()));
  });

  it('navigates to the saved invoice with no false "Unsaved Changes" prompt', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field_app_invoice') {
        return Promise.resolve({ data: { invoice_ids: [CREATED_ID], invoice_group_id: null }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    const router = await renderAt();

    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
    expect(await screen.findByText(`Saved invoice page ${CREATED_ID}`)).toBeInTheDocument();
    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('success', 'Invoice created');
    expect(saveCalls()).toHaveLength(1);
  });

  it('a second Save after the invoice was created updates that invoice instead of creating another', async () => {
    mockSaveWithFirstBillingFailure(CREATED_ID);
    const router = await renderAt();

    await createWithPartialFailureAndStay();
    expect(saveCalls()).toHaveLength(1);
    expect(savedInvoiceId(0)).toBeNull();
    expect(router.state.location.pathname).toBe(NEW_PATH);

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(saveCalls()).toHaveLength(2));
    // The repeat Save targets the invoice the first Save created — never a new one.
    expect(savedInvoiceId(1)).toBe(CREATED_ID);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
    expect(mockToast).toHaveBeenCalledWith('success', 'Invoice saved');
  });

  it('the first Save writes the created invoice into the address and keeps the typed values', async () => {
    mockSaveWithFirstBillingFailure(CREATED_ID);
    const router = await renderAt();

    await createWithPartialFailureAndStay();

    expect(router.state.location.pathname).toBe(NEW_PATH);
    expect(router.state.location.search).toBe(`?created=${CREATED_ID}`);
    // Same page: nothing typed was thrown away.
    expect(headerNotes().value).toBe('Spray north field');
  });

  it('a refresh of that address opens the created invoice instead of a blank new form', async () => {
    invoiceRows.set(CREATED_ID, ownNewDraft(CREATED_ID));
    // A browser refresh starts the app again at the address the first Save wrote.
    const router = await renderAt(`${NEW_PATH}?created=${CREATED_ID}`);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
    expect(await screen.findByText(`Saved invoice page ${CREATED_ID}`)).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('info', expect.stringContaining('already created this invoice'));
    expect(saveCalls()).toHaveLength(0);
  });

  it('an address whose created id is not an invoice id stays a new invoice', async () => {
    mockSaveWithFirstBillingFailure(CREATED_ID);
    const router = await renderAt(`${NEW_PATH}?created=..%2F..%2Fadmin`);

    expect(router.state.location.pathname).toBe(NEW_PATH);
    expect(mockToast).not.toHaveBeenCalledWith('info', expect.anything());
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(savedInvoiceId(0)).toBeNull();
  });

  it.each([
    ['no such invoice', null],
    ['an invoice someone else created', { created_by: 'user-2' }],
    ['an invoice that is already posted', { status: 'posted' }],
    ['a different kind of invoice', { invoice_type: 'chemical_sale' }],
    ['a draft created more than a day ago', { created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }],
    ['a draft dated in the future', { created_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() }],
  ])('an address naming %s drops the id and stays a new invoice', async (_label, overrides) => {
    if (overrides) invoiceRows.set(CREATED_ID, ownNewDraft(CREATED_ID, overrides));
    mockSaveWithFirstBillingFailure(SECOND_ID);
    const router = await renderAt(`${NEW_PATH}?created=${CREATED_ID}`);

    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(router.state.location.pathname).toBe(NEW_PATH);
    expect(mockToast).not.toHaveBeenCalledWith('info', expect.anything());
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(savedInvoiceId(0)).toBeNull();
  });

  it('if the check cannot run, the page stays put and Save refuses: no duplicate and no unchecked invoice', async () => {
    invoiceCheckError = { message: 'network down' };
    mockSaveWithFirstBillingFailure(SECOND_ID);
    const router = await renderAt(`${NEW_PATH}?created=${CREATED_ID}`);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Could not check')));
    expect(router.state.location.pathname).toBe(NEW_PATH);
    expect(router.state.location.search).toBe(`?created=${CREATED_ID}`);
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(mockToast).toHaveBeenCalledWith('info', expect.stringContaining('nothing was saved'));
    expect(saveCalls()).toHaveLength(0);
  });

  it('Save refuses while the check is still running', async () => {
    invoiceCheckHangs = true;
    mockSaveWithFirstBillingFailure(SECOND_ID);
    await renderAt(`${NEW_PATH}?created=${CREATED_ID}`);

    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(mockToast).toHaveBeenCalledWith('info', expect.stringContaining('One moment'));
    expect(saveCalls()).toHaveLength(0);
  });

  it('accepts an invoice id of any UUID version', async () => {
    const v7Id = '01927a3b-4c5d-7e6f-8a9b-0c1d2e3f4a5b';
    invoiceRows.set(v7Id, ownNewDraft(v7Id));
    const router = await renderAt(`${NEW_PATH}?created=${v7Id}`);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${v7Id}`));
  });

  it('a Save still running when the user presses New does not pull them back to the old invoice', async () => {
    // The invoice is created and its id written into the address; the billing step is
    // still running when the user presses New and leaves the dirty form.
    let finishBilling: (v: unknown) => void = () => {};
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field_app_invoice') {
        return Promise.resolve({ data: { invoice_ids: [CREATED_ID], invoice_group_id: null }, error: null });
      }
      if (name === 'update_field_app_invoice_billing') {
        return new Promise((resolve) => { finishBilling = resolve; });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    const router = await renderAt();
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(router.state.location.search).toBe(`?created=${CREATED_ID}`));
    await waitFor(() => expect(mockRpc.mock.calls.some(([n]) => n === 'update_field_app_invoice_billing')).toBe(true));

    await act(async () => {
      await router.navigate(NEW_PATH);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    await act(async () => {
      finishBilling({ data: { success: true }, error: null });
    });

    // The old page's Save finished its writes but left the user on the new, blank page.
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Invoice created'));
    expect(router.state.location.pathname).toBe(NEW_PATH);
    expect(router.state.location.search).toBe('');
    expect(headerNotes().value).toBe('');
  });

  it('Back from a second new invoice to the first one opens the first, never saving onto the second', async () => {
    // Two drafts in one tab, each created by a first Save whose billing step failed.
    const created = [CREATED_ID, SECOND_ID];
    mockRpc.mockImplementation((name: string, args: { p_invoice_id: string | null }) => {
      if (name === 'save_field_app_invoice') {
        const invoiceId = args.p_invoice_id ?? created.shift();
        return Promise.resolve({ data: { invoice_ids: [invoiceId], invoice_group_id: null }, error: null });
      }
      if (name === 'update_field_app_invoice_billing') {
        return Promise.resolve({ data: null, error: { message: 'network blip' } });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    invoiceRows.set(CREATED_ID, ownNewDraft(CREATED_ID));
    invoiceRows.set(SECOND_ID, ownNewDraft(SECOND_ID));
    const router = await renderAt();

    await createWithPartialFailureAndStay();
    expect(router.state.location.search).toBe(`?created=${CREATED_ID}`);
    await act(async () => {
      await router.navigate(NEW_PATH);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(headerNotes().value).toBe(''));
    await createWithPartialFailureAndStay();
    expect(router.state.location.search).toBe(`?created=${SECOND_ID}`);
    expect(savedInvoiceId(1)).toBeNull();

    await act(async () => {
      await router.navigate(-1);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
    expect(saveCalls()).toHaveLength(2);
  });

  it('going to the plain /new address from /new?created=<id> starts a genuinely new invoice', async () => {
    mockSaveWithFirstBillingFailure(CREATED_ID);
    const router = await renderAt();
    await createWithPartialFailureAndStay();

    // What the New buttons do (top bar, Field Invoices list): navigate to the plain /new
    // address. This page has no New button of its own.
    await act(async () => {
      await router.navigate(NEW_PATH);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));

    // A fresh page: nothing typed carried over, and Save creates a new invoice.
    await waitFor(() => expect(headerNotes().value).toBe(''));
    editHeaderNotes('Spray south field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(2));
    expect(savedInvoiceId(1)).toBeNull();
  });
});
