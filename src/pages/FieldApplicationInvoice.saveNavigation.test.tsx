/**
 * FieldApplicationInvoice.saveNavigation.test.tsx — first Save of a NEW field-app invoice.
 *
 * Bug (2026-10-09): after a successful first Save the page called setDirty(false) and
 * navigate() back-to-back. The router still held the block check from the last
 * committed render (dirty = true), so it blocked the move and showed a false
 * "Unsaved Changes" prompt. Choosing Stay left the user on /invoices/field-app/new, and
 * a second Save sent p_invoice_id = null again, creating a SECOND invoice.
 *
 * Unlike FieldApplicationInvoice.test.tsx, this file uses the REAL router (a data router,
 * as App.tsx does) and the REAL useUnsavedChanges hook, because the bug lives in how
 * those two interact. Only the database, auth and toast are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';

// In Vitest, 'react-router-dom' (the page's useNavigate) and 'react-router' (the hook's
// useBlocker) can resolve to two separate module copies with two separate router
// contexts. The app bundle has one copy. Point the page's import at the same copy the
// hook and this test use, so the page runs inside ONE data router as it does in the app.
vi.mock('react-router-dom', async () => vi.importActual('react-router'));

const { mockFrom, mockRpc, mockToast, authState } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  // Mutable so a test can let the signed-in profile arrive after the page first renders.
  authState: { profile: { id: 'user-1', role: 'admin' } as { id: string; role: string } | null },
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
  useAuth: () => ({ profile: authState.profile, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import FieldApplicationInvoice from './FieldApplicationInvoice';
import { createdFieldAppInvoiceStorageKey } from '../lib/fieldAppCreatedInvoice';

const CREATED_ID = '3f2b8c1e-5d4a-4b6f-9a1c-2e7d8f9a0b1c';
const STORAGE_KEY = createdFieldAppInvoiceStorageKey('user-1');

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

function SavedInvoicePage() {
  const { id } = useParams();
  return <p>Saved invoice page {id}</p>;
}

async function renderNewInvoice() {
  const router = createMemoryRouter(
    [
      { path: '/invoices/field-app/new', element: <FieldApplicationInvoice /> },
      { path: '/invoices/field-app/:id', element: <SavedInvoicePage /> },
    ],
    { initialEntries: ['/invoices/field-app/new'] },
  );
  let unmount = () => {};
  await act(async () => {
    ({ unmount } = render(<RouterProvider router={router} />));
  });
  return Object.assign(router, { unmountPage: unmount });
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

/** Make the form dirty the way a user does: type into a field. */
function editHeaderNotes(value: string) {
  fireEvent.change(screen.getByPlaceholderText('Printed at top of invoice'), { target: { value } });
}

describe('FieldApplicationInvoice — first Save of a new invoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    authState.profile = { id: 'user-1', role: 'admin' };
    mockFrom.mockImplementation(() => emptyChain());
  });

  it('navigates to the saved invoice with no false "Unsaved Changes" prompt', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field_app_invoice') {
        return Promise.resolve({ data: { invoice_ids: ['inv-A'], invoice_group_id: null }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    const router = await renderNewInvoice();

    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/invoices/field-app/inv-A'));
    expect(await screen.findByText('Saved invoice page inv-A')).toBeInTheDocument();
    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('success', 'Invoice created');
    expect(saveCalls()).toHaveLength(1);
  });

  it('a second Save after the invoice was created updates that invoice instead of creating another', async () => {
    // Billing details fail on the first save: the invoice IS created, the form rightly
    // stays dirty, and the leave-page prompt appears. The user picks Stay and saves again.
    let billingAttempts = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field_app_invoice') {
        return Promise.resolve({ data: { invoice_ids: ['inv-A'], invoice_group_id: null }, error: null });
      }
      if (name === 'update_field_app_invoice_billing') {
        billingAttempts += 1;
        return Promise.resolve(billingAttempts === 1
          ? { data: null, error: { message: 'network blip' } }
          : { data: { success: true }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    const router = await renderNewInvoice();

    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    const stay = await screen.findByRole('button', { name: 'Stay' });
    expect(saveCalls()).toHaveLength(1);
    expect((saveCalls()[0][1] as { p_invoice_id: string | null }).p_invoice_id).toBeNull();
    fireEvent.click(stay);
    await waitFor(() => expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/invoices/field-app/new');

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(saveCalls()).toHaveLength(2));
    // The repeat Save targets the invoice the first Save created — never a new one.
    expect((saveCalls()[1][1] as { p_invoice_id: string | null }).p_invoice_id).toBe('inv-A');
    await waitFor(() => expect(router.state.location.pathname).toBe('/invoices/field-app/inv-A'));
    expect(mockToast).toHaveBeenCalledWith('success', 'Invoice saved');
  });

  it('a page refresh after the invoice was created opens that invoice instead of a blank new form', async () => {
    mockSaveWithFirstBillingFailure(CREATED_ID);
    const first = await renderNewInvoice();

    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument());
    expect(first.state.location.pathname).toBe('/invoices/field-app/new');

    // The created id is kept for this tab before the failing billing step ran.
    const kept = window.sessionStorage.getItem(STORAGE_KEY);
    expect(kept).not.toBeNull();
    expect(JSON.parse(kept as string).invoiceId).toBe(CREATED_ID);

    // A real browser refresh throws the page away WITHOUT running React cleanup, so the
    // tab's sessionStorage survives. Unmounting here does run cleanup, so put the entry
    // back the way a refresh would have left it, then load /new again from scratch.
    first.unmountPage();
    window.sessionStorage.setItem(STORAGE_KEY, kept as string);
    const reloaded = await renderNewInvoice();

    await waitFor(() => expect(reloaded.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
    expect(await screen.findByText(`Saved invoice page ${CREATED_ID}`)).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('info', expect.stringContaining('already created this invoice'));
    // Only the first Save ever created anything, and leaving /new forgot the entry.
    expect(saveCalls()).toHaveLength(1);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('if the leave-page prompt stops that move and the user stays, Save still updates the created invoice', async () => {
    // The reloaded page is already dirty when the signed-in profile arrives, so the move to
    // the created invoice is stopped by the "Unsaved Changes" prompt (Luna, PR #893).
    mockSaveWithFirstBillingFailure(CREATED_ID);
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, userId: 'user-1', invoiceId: CREATED_ID, expiresAt: Date.now() + 60_000,
    }));
    authState.profile = null;
    const router = await renderNewInvoice();
    editHeaderNotes('Spray north field');

    authState.profile = { id: 'user-1', role: 'admin' };
    editHeaderNotes('Spray north field again');
    fireEvent.click(await screen.findByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/invoices/field-app/new');
    // Still remembered, so another refresh would find it too.
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect((saveCalls()[0][1] as { p_invoice_id: string | null }).p_invoice_id).toBe(CREATED_ID);
  });

  it('a fully successful first Save leaves nothing behind for a later new invoice', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field_app_invoice') {
        return Promise.resolve({ data: { invoice_ids: [CREATED_ID], invoice_group_id: null }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    const router = await renderNewInvoice();

    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
    // Leaving /new in the app ended that draft: a new invoice started later is a new one.
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(mockToast).not.toHaveBeenCalledWith('info', expect.anything());
  });
});
