import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Cost and margin are admin-only (Mason, 2026-10-15). Since 20261019010000 the
// sales reports send cost/profit/margin as NULL to non-admins; this pins that the
// screen then shows those columns only to admins and never prints a fake $0.

const H = vi.hoisted(() => ({
  auth: { role: 'admin' as 'admin' | 'sales_rep' },
  detailRow: null as Record<string, unknown> | null,
}));

type QueryBuilder = {
  select: () => QueryBuilder;
  eq: () => QueryBuilder;
  order: () => QueryBuilder;
  limit: () => QueryBuilder;
  in: () => QueryBuilder;
  not: () => QueryBuilder;
  then: (resolve: (value: unknown) => unknown) => unknown;
};

vi.mock('../lib/db', () => ({
  supabase: {
    from: () => {
      const builder: QueryBuilder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        in: () => builder,
        not: () => builder,
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return builder;
    },
    rpc: (name: string) => Promise.resolve({
      data: name === 'get_sales_detail_report' ? [H.detailRow] : [],
      error: null,
    }),
  },
  assertRpcResult: <T,>(data: T) => data,
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => H.auth }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../components/products/ProductSearchPicker', () => ({ default: () => null }));
vi.mock('../lib/csvExport', () => ({ exportToCSV: vi.fn(), fmtCSV: vi.fn(), fmtDateCSV: vi.fn() }));
// Keep the real whole-cent fmtCurrency; only the PDF download is stubbed.
vi.mock('../lib/reportPdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/reportPdf')>()),
  downloadReportPdf: vi.fn(),
}));

import SalesReports from './SalesReports';

const row = (cost: number | null, profit: number | null, margin: number | null) => ({
  order_date: '2026-10-01', order_number: 'ORD-1', customer_name: 'Prairie View Farms', customer_id: 'c1',
  product_name: 'Roundup', product_id: 'p1', sku: 'R1', category: 'Herbicide', quantity: 2, unit: 'GL',
  unit_price: 10, total_price: 20, cost, profit, margin_pct: margin, sales_rep_name: 'Rep', invoice_number: null, season: 2027,
});

beforeEach(() => { cleanup(); });
afterEach(() => { cleanup(); });

describe('SalesReports cost columns', () => {
  it('shows a sales rep revenue but no cost, profit or margin column or card', async () => {
    H.auth.role = 'sales_rep';
    H.detailRow = row(null, null, null);
    render(<MemoryRouter><SalesReports /></MemoryRouter>);

    expect(await screen.findByText('Prairie View Farms')).toBeInTheDocument();
    expect(screen.getByText('Total Revenue')).toBeInTheDocument();
    expect(screen.queryByText('Total Profit')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^Cost/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^Profit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^Margin/ })).not.toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('still shows an admin the cost, profit and margin columns', async () => {
    H.auth.role = 'admin';
    H.detailRow = row(12, 8, 40);
    render(<MemoryRouter><SalesReports /></MemoryRouter>);

    expect(await screen.findByText('Prairie View Farms')).toBeInTheDocument();
    expect(screen.getByText('Total Profit')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Cost/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Margin/ })).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });
});
