import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NewOrder from './NewOrder';

const H = vi.hoisted(() => {
  const customer = { id: 'cust-1', name: 'Test Farm', assigned_tier: 1 };
  // Chainable, awaitable query stub: customers reads return the link's customer, everything else is empty.
  function builder(rows: unknown[]): unknown {
    const result = { data: rows, error: null, count: rows.length };
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(result);
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve({ data: null, error: null });
        return () => proxy;
      },
      apply: () => proxy,
    });
    return proxy;
  }
  return {
    supabase: {
      from: (table: string) => builder(table === 'customers' ? [customer] : []),
      rpc: () => builder([]),
    },
    toast: { toast: vi.fn() },
    navigate: vi.fn(),
    role: 'admin',
    isPhone: false,
  };
});

vi.mock('../lib/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  supabase: H.supabase,
  assertRpcResult: (d: unknown) => d,
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'u1', role: H.role } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => H.toast }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), addBreadcrumb: vi.fn() } }));
vi.mock('../hooks/useIsPhone', () => ({ useIsPhone: () => H.isPhone }));
vi.mock('../lib/openBookings', () => ({
  fetchOpenBookings: () => Promise.resolve([{ id: 'booking-9', quote_number: 'Q-9', status: 'sent' }]),
}));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNavigate: () => H.navigate,
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/orders/new?customer_id=cust-1']}>
      <NewOrder />
    </MemoryRouter>,
  );
}

describe('NewOrder', () => {
  beforeEach(() => {
    H.navigate.mockReset();
    H.role = 'admin';
    H.isPhone = false;
    localStorage.clear();
  });

  it('the open-booking button opens that booking at /quotes/:id?draw=1', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Draw from booking Q-9/ }));
    expect(H.navigate).toHaveBeenCalledWith('/quotes/booking-9?draw=1');
  });

  it.each([true, false])('shows exactly one Create Order button (phone: %s)', async (isPhone) => {
    H.isPhone = isPhone;
    renderPage();
    expect(await screen.findAllByRole('button', { name: 'Create Order' })).toHaveLength(1);
    expect(screen.queryByTestId('order-bottom-bar') !== null).toBe(isPhone);
    expect(screen.getAllByText('Order total')).toHaveLength(1);
  });

  it('shows no order total to field staff', async () => {
    H.role = 'driver';
    renderPage();
    await screen.findByRole('button', { name: 'Create Order' });
    expect(screen.queryByText('Order total')).not.toBeInTheDocument();
  });
});
