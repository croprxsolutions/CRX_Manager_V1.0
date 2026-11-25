/** InvoicePaymentsCard (M9): "Mark check as returned" sits in a check payment line's ⋯ menu, for admins only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildInMemoryQuery } from '../../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({ rows: [] as Row[], returned: vi.fn() }));
vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return { ...actual, supabase: { from: () => buildInMemoryQuery(H.rows) } };
});
vi.mock('../../lib/m9Reversals', async () => {
  const actual = await vi.importActual<typeof import('../../lib/m9Reversals')>('../../lib/m9Reversals');
  return { ...actual, loadReturnedPayments: H.returned };
});
vi.mock('../prepay/RefundOrReturnDialog', () => ({ default: (p: { allocationSetId?: string; fromLabel?: string }) => <div role="dialog">return {p.allocationSetId} from {p.fromLabel}</div> }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import InvoicePaymentsCard from './InvoicePaymentsCard';

const alloc = (id: string, setId: string, method: string, ref: string) => ({
  id, invoice_id: 'inv-1', allocation_set_id: setId, amount_cents: 120000,
  allocation_sets: { id: setId, customer_id: 'c1', is_active: true, entity_type: 'payment', payment_method: method, check_number: method === 'check' ? ref : null, reference_number: ref, payment_date: '2026-09-15', total_payment_cents: 170000 },
});

beforeEach(() => {
  vi.clearAllMocks();
  H.rows = [alloc('a1', 's-6107', 'check', '6107'), alloc('a2', 's-ach', 'ach', 'REF-1')];
  H.returned.mockResolvedValue(new Map());
});
afterEach(cleanup);

describe('InvoicePaymentsCard', () => {
  it('a check line gets Mark check as returned; an ACH line gets no menu', async () => {
    render(<InvoicePaymentsCard invoiceId="inv-1" invoiceNumber="INV-20290" farmName="Prairie Ridge Farms" isAdmin onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for check 6107' }));
    expect(screen.queryByRole('button', { name: /More actions for check REF-1/ })).not.toBeInTheDocument();
    const item = screen.getByRole('menuitem', { name: /Mark check as returned/ });
    expect(item).toHaveTextContent('Returns all of check 6107 ($1,700.00). Opens with the check picked.');
    fireEvent.click(item);
    expect(await screen.findByRole('dialog')).toHaveTextContent('return s-6107 from INV-20290');
  });

  it('a rep sees the payments but no menu', async () => {
    render(<InvoicePaymentsCard invoiceId="inv-1" invoiceNumber="INV-20290" farmName="x" isAdmin={false} onChanged={vi.fn()} />);
    expect(await screen.findByText('6107')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /More actions/ })).not.toBeInTheDocument();
    expect(H.returned).not.toHaveBeenCalled();
  });
});
