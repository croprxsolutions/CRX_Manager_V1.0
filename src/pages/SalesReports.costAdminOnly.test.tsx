import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Cost and margin are admin-only (Mason, 2026-10-15). Since 20261019010000 the
// sales reports send cost/profit/margin as NULL to non-admins; this pins that the
// screen then shows those columns only to admins and never prints a fake $0.

const H = vi.hoisted(() => ({
  auth: { role: 'admin' as 'admin' | 'sales_rep' },
  detailRow: null as Record<string, unknown> | null,
  summaryRow: null as Record<string, unknown> | null,
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
      data: name === 'get_sales_detail_report' ? [H.detailRow]
        : name === 'get_sales_summary_report' ? [H.summaryRow]
          : [],
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
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';

const row = (cost: number | null, profit: number | null, margin: number | null) => ({
  order_date: '2026-10-01', order_number: 'ORD-1', customer_name: 'Prairie View Farms', customer_id: 'c1',
  product_name: 'Roundup', product_id: 'p1', sku: 'R1', category: 'Herbicide', quantity: 2, unit: 'GL',
  unit_price: 10, total_price: 20, cost, profit, margin_pct: margin, sales_rep_name: 'Rep', invoice_number: null, season: 2027,
});

// The server sends NULL cost/profit/margin to non-admins (20261019010000).
const summaryRow = (admin: boolean) => ({
  group_key: 'Roundup', group_id: 'p1', total_quantity: 2, total_revenue: 20,
  total_cost: admin ? 12 : null, total_profit: admin ? 8 : null, margin_pct: admin ? 40 : null, order_count: 1, line_count: 1,
});
const SENSITIVE = new Set(['Cost', 'Profit', 'Margin', 'Margin %']);
const hasSensitive = (headers: string[]) => headers.some((header) => SENSITIVE.has(header.trim()));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  H.detailRow = null;
  H.summaryRow = null;
});
afterEach(() => { cleanup(); });

describe('SalesReports cost columns', () => {
  it.each([
    { role: 'sales_rep' as const, showsCost: false },
    { role: 'admin' as const, showsCost: true },
  ])('summary table, CSV and PDF follow role visibility ($role)', async ({ role, showsCost }) => {
    H.auth.role = role;
    H.summaryRow = summaryRow(showsCost);
    render(<MemoryRouter initialEntries={['/?tab=by_product']}><SalesReports /></MemoryRouter>);

    expect(await screen.findByText('Roundup')).toBeInTheDocument();
    expect(hasSensitive(screen.getAllByRole('columnheader').map((h) => h.textContent || ''))).toBe(showsCost);

    fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
    await waitFor(() => expect(exportToCSV).toHaveBeenCalled());
    const csvColumns = vi.mocked(exportToCSV).mock.calls[0][1] as Array<{ header: string }>;
    expect(hasSensitive(csvColumns.map((c) => c.header))).toBe(showsCost);

    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await waitFor(() => expect(downloadReportPdf).toHaveBeenCalled());
    const pdfColumns = (vi.mocked(downloadReportPdf).mock.calls[0][0] as { columns: Array<{ header: string }> }).columns;
    expect(hasSensitive(pdfColumns.map((c) => c.header))).toBe(showsCost);
  });

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
