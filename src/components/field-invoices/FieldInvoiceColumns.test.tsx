/**
 * FieldInvoiceColumns.test.tsx — every invoice list leads with the same columns.
 *
 * Chemical Invoices and the Field Invoices Drafts, Posted and All Invoices tabs all start with
 * Invoice #, Customer, Date, Due, Total, Status (Invoices.redesign.test.tsx pins the chemical
 * list); each list's own columns follow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../../test-utils/inMemoryQuery';

const H = vi.hoisted(() => ({ from: vi.fn(), toast: vi.fn() }));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return { ...actual, supabase: { from: (table: string) => H.from(table === 'invoices_postable' ? 'invoices' : table), rpc: vi.fn() } };
});
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin', deniedPages: [] }),
}));
// One toast function for every render, so the panels' fetch effect does not restart each render.
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import FieldInvoicesUnpostedPanel from './FieldInvoicesUnpostedPanel';
import FieldInvoicesPostedPanel from './FieldInvoicesPostedPanel';
import FieldInvoicesListPanel from './FieldInvoicesListPanel';

const LEADING = ['Invoice #', 'Customer', 'Date', 'Due', 'Total', 'Status'];

function fieldInvoice(number: string, status: string) {
  return {
    id: number,
    invoice_number: number,
    invoice_post_version: `v1:${number}`,
    invoice_type: 'field_application',
    status,
    customer_id: 'cust-1',
    customer: { farm_name: 'Test Farm' },
    job: null,
    invoice_group_id: null,
    deleted_at: null,
    field_app_locations: [],
    invoice_items: [],
    total_acres: 10,
    total_amount_cents: 10000,
    paid_amount_cents: 0,
    prepay_applied_cents: 0,
    balance_cents: 10000,
    season: 2027,
    invoice_date: '2026-10-06',
    due_date: '2026-11-05',
    created_at: '2026-10-06T15:00:00+00:00',
  };
}

const headerNames = () => screen.getAllByRole('columnheader').map((h) => h.textContent?.trim()).filter(Boolean);
const rowOf = (number: string) => screen.getAllByText(number).map((el) => el.closest('tr')).find(Boolean)!;

describe('field invoice lists lead with the chemical list columns', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00'));
    H.from.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices'
      ? [fieldInvoice('FA-D', 'draft'), fieldInvoice('FA-P', 'posted')]
      : []));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('Drafts', async () => {
    render(<MemoryRouter><FieldInvoicesUnpostedPanel /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('FA-D').length).toBeGreaterThan(0));
    // The first header is the tick-box column (named for screen readers only).
    expect(headerNames().slice(1, 7)).toEqual(LEADING);
    expect(within(rowOf('FA-D')).getByText(new Date(2026, 10, 5).toLocaleDateString())).toBeInTheDocument();
    expect(within(rowOf('FA-D')).getByText('Draft')).toBeInTheDocument();
  });

  it('Posted', async () => {
    render(<MemoryRouter><FieldInvoicesPostedPanel /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('FA-P').length).toBeGreaterThan(0));
    expect(headerNames().slice(0, 6)).toEqual(LEADING);
    expect(within(rowOf('FA-P')).getByText('Posted')).toBeInTheDocument();
  });

  it('All Invoices', async () => {
    render(<MemoryRouter><FieldInvoicesListPanel /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('FA-P').length).toBeGreaterThan(0));
    expect(headerNames().slice(0, 6)).toEqual(LEADING);
  });
});
