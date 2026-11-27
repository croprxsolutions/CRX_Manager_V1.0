/**
 * ApplicationServices.roleGating.test.tsx — regression guard for the two bugs the
 * adversarial review of PR #267 caught in the cost carve-out's frontend half.
 *
 * Migration 20260729015706 revoked `application_services.cost_per_acre_cents` from
 * the shared `authenticated` role and put it behind `admin_get_application_service_costs`,
 * which raises 42501 for everyone else. The first cut of the page called that RPC
 * unconditionally, which produced two distinct failures:
 *
 *   1. Every driver / sales-rep page load fired a guaranteed-denied request, captured
 *      a Sentry exception and toasted an error about a column they are not meant to
 *      see. (Noise, and it teaches staff to ignore error toasts.)
 *   2. `assertRpcResult` THROWS when an RPC resolves with `data === null`. The throw
 *      escaped `fetchServices`, skipping `setLoading(false)` — the page sat on its
 *      loading skeleton forever, with an unhandled rejection behind it.
 *
 * These assertions fail if either regression returns. They drive the real page
 * component and the REAL `assertRpcResult`, so case 2 exercises the actual throw
 * rather than a stub of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const SERVICE_ROW = {
  id: 'svc-1',
  name: 'Y-Drop Nitrogen',
  vehicle_id: null,
  default_rate_per_acre_cents: 1200,
  is_active: true,
  sort_order: 0,
  created_by: 'u',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  vehicle: null,
};

const H = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  role: { current: 'admin' as string | null },
  toast: vi.fn(),
  captureException: vi.fn(),
  billingRead: vi.fn(),
}));

// Chainable stub: .from().select().order() awaits to the service list.
vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual, // keeps the REAL assertRpcResult — its throw is what case 2 tests
    supabase: { from: H.from, rpc: H.rpc },
    supabaseUntyped: { from: H.from, rpc: H.rpc },
  };
});

vi.mock('../lib/applicationServiceBilling', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readApplicationServiceBillingIfReady: H.billingRead };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: H.role.current,
    profile: { id: 'u', full_name: 'Test', role: H.role.current, is_active: true },
    user: { id: 'u' },
    loading: false,
  }),
}));

const STABLE_TOAST = { toast: H.toast };
vi.mock('../components/ui/Toast', () => ({ useToast: () => STABLE_TOAST }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: H.captureException } }));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

async function renderPage() {
  const { default: ApplicationServices } = await import('./ApplicationServices');
  return render(<ApplicationServices />, { wrapper });
}

beforeEach(() => {
  H.from.mockReset();
  H.from.mockImplementation(() => {
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'order', 'eq', 'in']) builder[m] = () => builder;
    builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: [SERVICE_ROW], error: null });
    return builder;
  });
  H.rpc.mockReset();
  H.toast.mockReset();
  H.captureException.mockReset();
  H.role.current = 'admin';
  H.billingRead.mockReset();
  H.billingRead.mockResolvedValue(null);
});
afterEach(cleanup);

describe('ApplicationServices cost gating', () => {
  it('does NOT call the admin-only cost RPC for a non-admin', async () => {
    H.role.current = 'driver';
    await renderPage();

    // The row loaded, so the page finished its fetch and left the skeleton.
    expect(await screen.findByText('Y-Drop Nitrogen')).toBeTruthy();
    expect(H.rpc).not.toHaveBeenCalled();
    // No denied-RPC noise for a column they were never meant to see.
    expect(H.toast).not.toHaveBeenCalled();
    expect(H.captureException).not.toHaveBeenCalled();
    // …and the permanently-blank Cost/Acre column is not advertised to them.
    expect(screen.queryByText('Cost/Acre')).toBeNull();
  });

  it('keeps the newest rows when an older overlapping list request resolves last', async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((complete) => { resolve = complete; });
      return { promise, resolve };
    }

    const olderRequest = deferred<{ data: typeof SERVICE_ROW[]; error: null }>();
    const newerRequest = deferred<{ data: typeof SERVICE_ROW[]; error: null }>();
    const requests = [olderRequest, newerRequest];
    let requestIndex = 0;
    H.from.mockImplementation(() => {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'eq', 'in']) builder[m] = () => builder;
      builder.then = (resolve: (v: unknown) => unknown) => requests[requestIndex++].promise.then(resolve);
      return builder;
    });

    const { default: ApplicationServices } = await import('./ApplicationServices');
    const view = render(<ApplicationServices />, { wrapper });
    await waitFor(() => expect(requestIndex).toBe(1));

    H.role.current = 'driver';
    view.rerender(<ApplicationServices />);
    await waitFor(() => expect(requestIndex).toBe(2));

    const newerRow = { ...SERVICE_ROW, id: 'svc-new', name: 'Newer Service' };
    await act(async () => {
      newerRequest.resolve({ data: [newerRow], error: null });
    });
    expect(await screen.findByText('Newer Service')).toBeTruthy();

    const olderRow = { ...SERVICE_ROW, id: 'svc-old', name: 'Older Service' };
    await act(async () => {
      olderRequest.resolve({ data: [olderRow], error: null });
    });
    expect(screen.getByText('Newer Service')).toBeTruthy();
    expect(screen.queryByText('Older Service')).toBeNull();
  });

  it('calls the cost RPC for an admin and merges the cents into the table', async () => {
    H.rpc.mockResolvedValue({ data: [{ service_id: 'svc-1', cost_per_acre_cents: '650' }], error: null });
    await renderPage();

    expect(await screen.findByText('$6.50/ac')).toBeTruthy();
    expect(H.rpc).toHaveBeenCalledTimes(1);
    expect(H.rpc.mock.calls[0][0]).toBe('admin_get_application_service_costs');
    expect(screen.queryByText('Cost/Acre')).toBeTruthy();
  });

  it('still finishes loading when the RPC resolves null and assertRpcResult throws', async () => {
    // The exact shape that stranded the page: no error object, but a null payload.
    H.rpc.mockResolvedValue({ data: null, error: null });
    await renderPage();

    // Row rendered => setLoading(false) ran => the throw did not escape fetchServices.
    expect(await screen.findByText('Y-Drop Nitrogen')).toBeTruthy();
    // Cost is UNKNOWN, rendered as '-', never as $0.00/ac (which would read as 100% margin).
    expect(screen.queryByText('$0.00/ac')).toBeNull();
    await waitFor(() => expect(H.captureException).toHaveBeenCalled());
    expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load application service costs');
  });

  it('shows the billing and outside company columns while their data is unavailable', async () => {
    H.role.current = 'sales_rep';
    await renderPage();

    expect(await screen.findByText('Y-Drop Nitrogen')).toBeTruthy();
    expect(screen.getByText('Billed by CRX')).toBeTruthy();
    expect(screen.getByText('Outside Company')).toBeTruthy();
    expect(screen.getAllByText('Not available yet')).toHaveLength(2);
    expect(H.toast).not.toHaveBeenCalled();
    expect(H.billingRead).toHaveBeenCalledWith(['svc-1'], false);
  });
});
