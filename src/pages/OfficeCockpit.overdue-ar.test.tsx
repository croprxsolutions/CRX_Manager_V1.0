import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// The overdue tile counts chemical-sale (and misc-charge) invoices too, not only field-app ones,
// with the same posted/overdue + past-due + open-balance rule as before.
const OVERDUE_ROWS = [
  { id: 'chem-1', invoice_number: 'INV-C1', invoice_type: 'chemical_sale', due_date: '2026-10-01', balance_cents: 12500, customer: { farm_name: 'Chem Farm' } },
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `field-${i}`,
    invoice_number: `FA-${i}`,
    invoice_type: 'field_application',
    due_date: '2026-10-02',
    balance_cents: 1000,
    customer: { farm_name: 'Field Farm' },
  })),
];

const overdueFilters: { invoiceTypes: unknown; statuses: unknown } = { invoiceTypes: null, statuses: null };

function query(table: string) {
  const builder: Record<string, unknown> = {};
  let isOverdueRead = false;
  let invoiceTypes: unknown = null;
  let statuses: unknown = null;
  const self = () => builder;
  for (const method of ['select', 'eq', 'is', 'order', 'limit', 'range', 'gte', 'lte', 'lt', 'not']) {
    builder[method] = vi.fn(self);
  }
  builder.in = vi.fn((column: string, values: unknown) => {
    if (column === 'invoice_type') invoiceTypes = values;
    if (column === 'status') statuses = values;
    return builder;
  });
  builder.gt = vi.fn((column: string) => {
    if (table === 'invoices' && column === 'balance_cents') isOverdueRead = true;
    return builder;
  });
  builder.then = vi.fn((resolve: (value: unknown) => unknown) => {
    if (isOverdueRead) {
      overdueFilters.invoiceTypes = invoiceTypes;
      overdueFilters.statuses = statuses;
    }
    return Promise.resolve(
      isOverdueRead ? { data: OVERDUE_ROWS, error: null, count: 12 } : { data: [], error: null, count: 0 },
    ).then(resolve);
  });
  return builder;
}

const stableNavigate = vi.fn();
const stableToast = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => stableNavigate }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { role: 'admin' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: stableToast }) }));
vi.mock('../lib/idempotency', () => ({ generateIdempotencyKey: vi.fn(() => 'key') }));
vi.mock('../lib/criticalAction', () => ({ runCriticalAction: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/deliveryInvoiceCoverage', async () => ({
  ...(await vi.importActual<typeof import('../lib/deliveryInvoiceCoverage')>('../lib/deliveryInvoiceCoverage')),
  fetchActiveInvoiceCoveragePages: vi.fn(() => Promise.resolve({ data: [], error: null })),
}));
// RPC reads are paged (rpc → order → range): wrap a reply in a builder that resolves to {data, error, count}.
const { paged } = vi.hoisted(() => ({
  paged: (reply: unknown) => {
    const q: Record<string, unknown> = {
      order: () => q,
      range: () => q,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(reply).then((x) => resolve({ ...(x as object), count: Array.isArray((x as { data?: unknown }).data) ? (x as { data: unknown[] }).data.length : null }), reject),
    };
    return q;
  },
}));

vi.mock('../lib/db', async () => ({
  supabase: {
    from: vi.fn((table: string) => query(table)),
    rpc: vi.fn((name: string) => paged({ data: name === 'operational_dashboard_summary' ? {} : [], error: null })),
  },
  supabaseUntyped: {
    from: vi.fn((table: string) => query(table)),
    rpc: vi.fn(() => paged({ data: [], error: null })),
  },
  assertRpcResult: vi.fn((data: unknown) => data),
  hasRpcCode: vi.fn(() => false),
  RpcErrorCodes: { INVOICE_ALREADY_POSTED: 'INVOICE_ALREADY_POSTED' },
  sanitizeError: (await vi.importActual<typeof import('../lib/errorSanitizer')>('../lib/errorSanitizer')).sanitizeError,
}));

import OfficeCockpit from './OfficeCockpit';

describe('OfficeCockpit overdue AR tile', () => {
  it('reads chemical-sale invoices with the same overdue rule and counts them', async () => {
    render(<OfficeCockpit />);
    expect(await screen.findByText('Overdue AR', {}, { timeout: 5000 })).toBeTruthy();
    expect(overdueFilters.invoiceTypes).toEqual(['field_application', 'chemical_sale', 'misc_charge']);
    expect(overdueFilters.statuses).toEqual(['posted', 'overdue']);
    // 12 matching invoices, 6 listed.
    expect(screen.getByText('+6 more')).toBeTruthy();
    expect(screen.getByText('Chem Farm')).toBeTruthy();
    expect(screen.getByText('Chemical')).toBeTruthy();
  });

  it('opens a chemical invoice in Invoices and a field-app invoice in Field Invoices', async () => {
    stableNavigate.mockClear();
    render(<OfficeCockpit />);
    fireEvent.click((await screen.findByText('#INV-C1', {}, { timeout: 5000 })).closest('button')!);
    expect(stableNavigate).toHaveBeenCalledWith('/invoices/chem-1');
    fireEvent.click(screen.getByText('#FA-0').closest('button')!);
    expect(stableNavigate).toHaveBeenCalledWith('/field-invoices/field-0');
  });
});
