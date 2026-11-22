/**
 * KI-182: the Purchase Orders bulk Cancel sends a random retry code (not one built from the user and PO, which
 * anyone could work out and use first), and a retry after a failed cancel sends the same code again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const H = vi.hoisted(() => ({
  cancelKeys: [] as string[],
  cancelReplies: [] as { data: unknown; error: unknown }[],
  toast: vi.fn(),
}));

function rows(data: unknown) {
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null, count: null }).then(resolve);
      return () => q;
    },
  });
  return q;
}

const PO = { id: 'po1', po_number: 'PO-1001', vendor: 'Acme Chem', status: 'submitted', created_at: '2026-10-01T12:00:00Z', expected_delivery_date: null, total_cost: 50 };

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  const client = {
    from: (table: string) => rows(table === 'purchase_orders' ? [PO] : []),
    rpc: async (name: string, args: { p_idempotency_key?: string }) => {
      if (name !== 'cancel_purchase_order') return { data: {}, error: null };
      H.cancelKeys.push(args.p_idempotency_key ?? '');
      return H.cancelReplies.shift() ?? { data: { success: true }, error: null };
    },
  };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import PurchaseOrders from './PurchaseOrders';

afterEach(cleanup);

async function cancelSelected() {
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel POs' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /Cancel 1 purchase order/ }));
}

describe('Purchase Orders bulk cancel retry code (KI-182)', () => {
  it('is random, not built from the user and PO, and a retry after a failure reuses it', async () => {
    H.cancelReplies.push({ data: null, error: { message: 'connection reset' } });
    render(<MemoryRouter initialEntries={['/purchase-orders']}><PurchaseOrders /></MemoryRouter>);
    expect(await screen.findByText('PO-1001')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('checkbox').at(-1)!);
    await cancelSelected();
    await waitFor(() => expect(H.cancelKeys).toHaveLength(1));
    expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('Failed to cancel PO PO-1001'));

    fireEvent.click(screen.getAllByRole('checkbox').at(-1)!);
    await cancelSelected();
    await waitFor(() => expect(H.cancelKeys).toHaveLength(2));

    const [first, retry] = H.cancelKeys;
    expect(first).not.toBe('cancel_purchase_order:user-1:po1');
    expect(first).toMatch(/^cancel_purchase_order:user-1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(retry).toBe(first);
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('success', 'Cancelled 1 purchase order(s)'));
  });
});
