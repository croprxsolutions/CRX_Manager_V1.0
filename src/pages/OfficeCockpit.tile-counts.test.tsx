import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Goal 4: a tile lists at most 50 examples, but its count must be the true number of matching rows.
const UNBILLED_ROWS = Array.from({ length: 50 }, (_, i) => ({
  id: `job-${i}`,
  job_number: `JOB-${i}`,
  job_date: '2026-03-01',
  total_acres: 10,
  total_price_cents: 1000,
  customer: { farm_name: 'Volume Farm' },
}));

function query(table: string) {
  const builder: Record<string, unknown> = {};
  let completedJobs = false;
  const self = () => builder;
  for (const method of ['select', 'is', 'order', 'limit', 'range', 'in', 'gte', 'lte', 'lt', 'gt', 'not']) {
    builder[method] = vi.fn(self);
  }
  builder.eq = vi.fn((column: string, value: unknown) => {
    if (table === 'jobs' && column === 'status' && value === 'completed') completedJobs = true;
    return builder;
  });
  builder.then = vi.fn((resolve: (value: unknown) => unknown) => Promise.resolve(
    completedJobs ? { data: UNBILLED_ROWS, error: null, count: 600 } : { data: [], error: null, count: 0 },
  ).then(resolve));
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

describe('OfficeCockpit tile counts', () => {
  it('shows the true count of unbilled jobs, not the 50 examples it lists', async () => {
    render(<OfficeCockpit />);
    expect(await screen.findByText('+594 more', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('600')).toBeTruthy();
    expect(screen.queryByText('50')).toBeNull();
  });
});
