/**
 * KI-134: a saved count is compared with on hand at the moment it was saved, by the server.
 * The screen must show the server's on hand and variance, not its own arithmetic against
 * the on hand read when the count was started, and must not show a saved count with no
 * variance as a clean line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';

const COUNT = '33333333-3333-4333-8333-333333333333';
const H = vi.hoisted(() => ({ toast: vi.fn(), rpc: vi.fn() }));

const counts = [{
  id: COUNT, count_number: 'CC-3003', warehouse: 'Main Warehouse', status: 'in_progress', item_revision: 1,
  initiated_by: null, completed_by: null, created_at: '2026-11-10T00:00:00Z', items: [],
}];
// Started when 100 were on hand; 10 were received before the shelf was counted.
const items = [{
  id: 'item-1', cycle_count_id: COUNT, product_id: 'p-1', expected_qty: 100,
  counted_qty: null, variance: null, variance_pct: null, is_counted: false,
  product: { product_name: 'CHARLIE PRODUCT' },
}];

vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const builder = (table: string) => {
    let scoped = false;
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = table === 'cycle_counts'
            ? { data: counts, error: null }
            : table === 'cycle_count_items' && scoped
              ? { data: items, error: null, count: items.length }
              : { data: [], error: null };
          return (resolve: (v: unknown) => void) => Promise.resolve(value).then(resolve);
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => Promise.resolve({ data: table === 'cycle_counts' && scoped ? { item_revision: 1 } : null, error: null });
        }
        return (...args: unknown[]) => {
          if (typeof args[1] === 'string' && (args[0] === 'cycle_count_id' || args[0] === 'id')) scoped = true;
          return proxy;
        };
      },
      apply() { return proxy; },
    });
    return proxy;
  };
  return { ...actual, supabase: { from: (table: string) => builder(table), rpc: H.rpc } };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'admin', profile: { id: 'admin-1', full_name: 'Admin' } }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));
const STABLE_TOAST = { toast: H.toast };
vi.mock('../components/ui/Toast', () => ({
  useToast: () => STABLE_TOAST,
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../lib/sentry', () => ({ Sentry: new Proxy({}, { get: () => () => undefined }) }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

const { default: CycleCounts } = await import('./CycleCounts');

async function openAndCount(value: string) {
  render(<CycleCounts />);
  await waitFor(() => expect(screen.getByText('CC-3003')).toBeTruthy());
  fireEvent.click(screen.getByText('CC-3003'));
  await waitFor(() => expect(screen.getByText('CHARLIE PRODUCT')).toBeTruthy());
  fireEvent.change(screen.getByPlaceholderText('Count...'), { target: { value } });
  await waitFor(() => expect(H.rpc).toHaveBeenCalledWith('update_cycle_count_item', expect.objectContaining({ p_counted_qty: Number(value) })));
  return screen.getByText('CHARLIE PRODUCT').closest('tr') as HTMLElement;
}

describe('CycleCounts shows the server on hand at count (KI-134)', () => {
  beforeEach(() => { H.toast.mockReset(); H.rpc.mockReset(); });
  afterEach(() => cleanup());

  it('shows the on hand and variance the server compared the count with', async () => {
    H.rpc.mockResolvedValue({ data: { item_revision: 2, expected_qty: 110, variance: 0, variance_pct: 0 }, error: null });
    const row = await openAndCount('110');
    // Its own arithmetic would have shown 100 and +10.
    await waitFor(() => expect(within(row).getByText('110', { selector: 'td' })).toBeTruthy());
    expect(within(row).queryByText('+10')).toBeNull();
    expect(within(row).getByText('(0%)')).toBeTruthy();
    expect(H.toast).not.toHaveBeenCalled();
  });

  it('treats a saved count with no variance as a failed save', async () => {
    H.rpc.mockResolvedValue({ data: { item_revision: 2 }, error: null });
    const row = await openAndCount('110');
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringMatching(/Failed to save this count/)));
    expect(within(row).getByText('100', { selector: 'td' })).toBeTruthy();
  });
});
