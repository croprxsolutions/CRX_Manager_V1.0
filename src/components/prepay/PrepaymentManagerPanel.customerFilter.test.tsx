/**
 * PrepaymentManagerPanel.customerFilter.test.tsx — picking another customer in the Customer box closes the
 * open customer's Individual Credits panel, so A's credits (with Edit and Delete) never sit under B.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, toast: vi.fn(), exportToCSV: vi.fn() }));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => {
        const q = buildInMemoryQuery(H.tables[table] ?? []);
        // The customer box's name search ignores the typed text here and offers every active customer.
        if (table === 'customers') q.or = () => q;
        return q;
      },
      rpc: vi.fn(),
    },
  };
});
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ role: 'admin', profile: { id: 'user-1', role: 'admin' } }) }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/csvExport', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/csvExport');
  return { ...actual, exportToCSV: H.exportToCSV };
});
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../../hooks/useIdempotencyKey', () => ({ useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn() }) }));

import PrepaymentManagerPanel from './PrepaymentManagerPanel';

const credit = (id: string, customerId: string, ref: string) => ({
  id, customer_id: customerId, original_amount_cents: 30000, balance_cents: 30000, reference_number: ref,
  bucket_label: null, notes: null, payment_method: 'check', source_type: 'check', source_reference: ref, allocation_set_id: null,
  created_at: '2026-10-01',
});

beforeEach(() => {
  H.tables = {
    customers: [
      { id: 'c1', farm_name: 'Alpha Farm', account_number: 'A1', is_active: true, prepay_balance_cents: 30000 },
      { id: 'c2', farm_name: 'Beta Farm', account_number: 'A2', is_active: true, prepay_balance_cents: 30000 },
    ],
    invoices: [],
    prepay_credits: [credit('k1', 'c1', 'CHK-ALPHA'), credit('k2', 'c2', 'CHK-BETA')],
  };
});
afterEach(cleanup);

describe('Prepay Credits: customer box and the open credits panel', () => {
  it("closes customer A's credits when customer B is picked in the box", async () => {
    render(<MemoryRouter><PrepaymentManagerPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Alpha Farm/ }));
    expect(await screen.findByText(/Individual Credits — Alpha Farm/)).toBeInTheDocument();
    await screen.findAllByText('CHK-ALPHA');

    const box = screen.getByRole('combobox', { name: 'Prepayments customer' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Beta' } });
    fireEvent.click(await screen.findByRole('option', { name: /Beta Farm/ }));

    await waitFor(() => expect(screen.queryByText(/Individual Credits/)).not.toBeInTheDocument());
    expect(screen.queryByText('CHK-ALPHA')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Edit credit')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Beta Farm/ })).toBeInTheDocument();
  });

  it('Export CSV with one customer picked exports only that customer', async () => {
    render(<MemoryRouter initialEntries={['/prepay?customer=c2']}><PrepaymentManagerPanel /></MemoryRouter>);
    await screen.findByRole('button', { name: /Beta Farm/ });
    await waitFor(() => expect(screen.getByRole('button', { name: /Export CSV/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    const rows = H.exportToCSV.mock.calls[0][0] as Row[];
    expect(rows.map((r) => r.farm_name)).toEqual(['Beta Farm']);
  });
});
