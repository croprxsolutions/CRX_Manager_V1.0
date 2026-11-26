/**
 * Payment History (M9 design v73): each payment's ⋯ menu holds "Mark check as returned" and, as its red last item,
 * "Void payment". A non-check payment says why it can't come back; a returned check shows Returned and offers no Void.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, rpc: vi.fn(), toast: vi.fn(), returned: vi.fn(), dialog: vi.fn() }));

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return { ...actual, supabase: { from: (t: string) => buildInMemoryQuery(H.tables[t] ?? []), rpc: H.rpc } };
});
vi.mock('../lib/m9Reversals', async () => {
  const actual = await vi.importActual<typeof import('../lib/m9Reversals')>('../lib/m9Reversals');
  return { ...actual, loadReturnedPayments: H.returned };
});
vi.mock('../components/prepay/RefundOrReturnDialog', () => ({ default: (p: { open: boolean; allocationSetId?: string }) => { H.dialog(p); return p.open ? <div role="dialog">Mark check as returned {p.allocationSetId}</div> : null; } }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'admin-1', role: 'admin' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import PaymentHistory from './PaymentHistory';

const set = (id: string, method: string, ref: string, extra: Row = {}) => ({
  id, customer_id: 'c1', total_payment_cents: 90000, total_allocated_cents: 90000, payment_method: method, check_number: method === 'check' ? ref : null,
  reference_number: ref, payment_date: '2026-11-10', season: 2026, is_active: true, notes: null, created_at: `2026-11-10T1${id.length}:00:00Z`,
  customers: { farm_name: 'Prairie Ridge Farms' }, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  H.tables = { allocation_sets: [set('s-6311', 'check', '6311'), set('s-ach', 'ach', 'REF-7781'), set('s-6107', 'check', '6107', { total_payment_cents: 170000 })] };
  H.returned.mockResolvedValue(new Map([['s-6107', '2026-11-03']]));
});
afterEach(cleanup);

const menu = async (name: string) => {
  fireEvent.click(await screen.findByRole('button', { name }));
  return screen.getAllByRole('menuitem');
};

describe('Payment History: returned checks and Void in the ⋯ menu', () => {
  it('moves Void into the menu as the last item, after Mark check as returned', async () => {
    render(<MemoryRouter><PaymentHistory /></MemoryRouter>);
    expect(await screen.findByText('View payments, mark returned checks and void incorrect entries')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Void$/ })).not.toBeInTheDocument();
    const items = await menu('More actions for check 6311');
    expect(items.map((i) => i.textContent)).toEqual([
      'Mark check as returnedReturns all of check 6311 ($900.00). Opens with the check picked.', 'Void payment',
    ]);
    fireEvent.click(items[0]);
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Mark check as returned s-6311'));
  });

  it('a non-check payment says why it cannot come back; Void stays', async () => {
    render(<MemoryRouter><PaymentHistory /></MemoryRouter>);
    const items = await menu('More actions for ach REF-7781');
    expect(items[0]).toHaveAttribute('aria-disabled', 'true');
    expect(items[0]).toHaveTextContent('Not a check (ACH). Only checks can come back.');
    expect(items[1]).toHaveTextContent('Void payment');
  });

  it('a returned check shows Returned, $0.00 allocated, no Void', async () => {
    render(<MemoryRouter><PaymentHistory /></MemoryRouter>);
    expect(await screen.findByText('Returned')).toBeInTheDocument();
    const row = screen.getByText('Returned').closest('tr')!;
    expect(row).toHaveTextContent('$1,700.00');
    expect(row).toHaveTextContent('$0.00');
    const items = await menu('More actions for check 6107');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute('aria-disabled', 'true');
    expect(items[0]).toHaveTextContent('Already returned Nov 3');
  });
});
