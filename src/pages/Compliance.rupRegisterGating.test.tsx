/**
 * Compliance.rupRegisterGating.test.tsx — the RUP Sales Register tab is admin-only.
 *
 * Migration 20261014220000_rup_register_admin_only makes get_rup_sales_register refuse every
 * caller who is not an active admin. The database refusal is the protection; this guards the
 * screen half: a sales rep never sees the tab or fires the guaranteed-refused call, an admin
 * still opens the register, and an admin demoted while on the register falls back to Licenses
 * instead of an empty panel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { pagedRpcReply } from '../test-utils/inMemoryQuery';

const H = vi.hoisted(() => ({
  rpc: vi.fn(),
  role: { current: 'admin' as string },
  active: { current: true },
  toast: vi.fn(),
}));

// Chainable stub: every query builder method returns the builder, and awaiting it yields no rows.
vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const builder: Record<string, unknown> = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
      return () => builder;
    },
  });
  // The register is read page by page; pagedRpcReply serves the mocked reply like the server.
  return {
    ...actual,
    supabase: { from: () => builder, rpc: (...args: unknown[]) => pagedRpcReply(H.rpc(...args)) },
    supabaseUntyped: { rpc: (...args: unknown[]) => H.rpc(...args) },
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: H.role.current,
    profile: { id: 'u', full_name: 'Test', role: H.role.current, is_active: H.active.current },
    user: { id: 'u' },
    loading: false,
  }),
}));

const STABLE_TOAST = { toast: H.toast };
vi.mock('../components/ui/Toast', () => ({ useToast: () => STABLE_TOAST }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

async function renderPage() {
  const { default: Compliance } = await import('./Compliance');
  return render(<Compliance />, { wrapper });
}

const registerTab = () => screen.queryByRole('button', { name: /RUP Sales Register/ });
// Matched by name, whatever the other arguments: a never-called check must not
// pass just because the call's argument list changed shape.
const registerCalls = () => H.rpc.mock.calls.filter(([name]) => name === 'get_rup_sales_register');

beforeEach(() => {
  H.rpc.mockReset();
  H.rpc.mockResolvedValue({ data: [], error: null });
  H.toast.mockReset();
  H.role.current = 'admin';
  H.active.current = true;
});
afterEach(cleanup);

describe('Compliance RUP Sales Register gating', () => {
  it('shows and loads missing-brand follow-up for an active admin below the page header', async () => {
    H.rpc.mockImplementation(async (name: string) => ({
      data: name === 'get_deliveries_missing_brands' ? [{
        delivery_id: 'delivery-1', delivery_number: 'DL-100', delivered_on: '2026-11-12',
        delivery_item_id: 'item-1', product_name: 'Test product', quantity_delivered: 10,
        picked_quantity: 0, reasons: ['brand_not_recorded'],
      }] : [],
      error: null,
    }));
    await renderPage();
    const cardTitle = await screen.findByRole('heading', { name: 'Deliveries missing brands' });
    expect(cardTitle).toBeTruthy();
    const pageTitle = screen.getByRole('heading', { name: 'Compliance', level: 1 });
    expect(pageTitle.compareDocumentPosition(cardTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByText('DL-100')).toBeTruthy();
    const tabs = screen.getByRole('button', { name: /Applicator Licenses/ });
    expect(cardTitle.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(H.rpc).toHaveBeenCalledWith('get_deliveries_missing_brands', expect.objectContaining({ p_from: expect.any(String), p_to: expect.any(String) }));
  });

  it.each([
    { name: 'a sales rep', role: 'sales_rep', active: true },
    { name: 'an inactive admin', role: 'admin', active: false },
  ])('does not mount or call missing-brand follow-up for $name', async ({ role, active }) => {
    H.role.current = role;
    H.active.current = active;
    await renderPage();
    await screen.findByRole('button', { name: /Applicator Licenses/ });
    expect(screen.queryByRole('heading', { name: 'Deliveries missing brands' })).toBeNull();
    expect(H.rpc.mock.calls.some(([name]) => name === 'get_deliveries_missing_brands')).toBe(false);
  });

  it('hides the register tab from a sales rep and never calls the register', async () => {
    H.role.current = 'sales_rep';
    await renderPage();
    await screen.findByRole('button', { name: /Applicator Licenses/ });
    expect(screen.getByRole('button', { name: /RUP Products/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Field Listing/ })).toBeTruthy();
    expect(registerTab()).toBeNull();
    expect(registerCalls()).toHaveLength(0);
  });

  it('hides the register tab from an inactive admin profile and never calls the register', async () => {
    H.active.current = false;
    await renderPage();
    await screen.findByRole('button', { name: /Applicator Licenses/ });
    expect(registerTab()).toBeNull();
    expect(registerCalls()).toHaveLength(0);
  });

  it('lets an admin open the register', async () => {
    await renderPage();
    const tab = await screen.findByRole('button', { name: /RUP Sales Register/ });
    fireEvent.click(tab);
    await waitFor(() => expect(registerCalls().length).toBeGreaterThan(0));
  });

  it('falls back to Licenses when an admin on the register is demoted in place', async () => {
    const view = await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /RUP Sales Register/ }));
    await waitFor(() => expect(registerCalls().length).toBeGreaterThan(0));
    const calls = H.rpc.mock.calls.length;

    H.role.current = 'sales_rep';
    const { default: Compliance } = await import('./Compliance');
    view.rerender(<Compliance />);

    await waitFor(() => expect(registerTab()).toBeNull());
    // The Licenses panel's header action is back, so the page is not left on an empty panel.
    expect(await screen.findByRole('button', { name: /Add License/i })).toBeTruthy();
    expect(H.rpc.mock.calls.slice(calls).some(([fn]) => fn === 'get_rup_sales_register')).toBe(false);
  });
});
