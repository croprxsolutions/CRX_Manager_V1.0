import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import InvoicePayersTable from './InvoicePayersTable';

const rows = [
  { payerName: 'Maple Hollow Farms', invoiceId: 'inv-1', invoiceNumber: 'CS-2026-0005-1', pct: 50, totalCents: 73483, status: 'draft', isThis: true },
  { payerName: 'Cedar Ridge Ag', invoiceId: 'inv-2', invoiceNumber: 'CS-2026-0005-2', pct: 50, totalCents: 68701, status: 'draft', isThis: false },
];

const renderTable = (props: Partial<Parameters<typeof InvoicePayersTable>[0]> = {}) => render(
  <MemoryRouter><InvoicePayersTable rows={rows} {...props} /></MemoryRouter>,
);

describe('InvoicePayersTable', () => {
  it('has Payer, Share and Amount columns and counts the payers', () => {
    renderTable();
    expect(screen.getByRole('heading', { name: 'Who pays' })).toBeInTheDocument();
    expect(screen.getByText('2 payers')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Payer', 'Share', 'Amount']);
  });

  it('marks this invoice without linking it, and links every other payer invoice', () => {
    renderTable();
    const [, thisRow, otherRow] = screen.getAllByRole('row');
    expect(thisRow).toHaveTextContent('CS-2026-0005-1 · this invoice');
    expect(within(thisRow).queryByRole('link')).not.toBeInTheDocument();
    expect(within(otherRow).getByRole('link', { name: 'CS-2026-0005-2' })).toHaveAttribute('href', '/invoices/inv-2');
    expect(within(otherRow).getByText('Draft')).toBeInTheDocument();
  });

  it('totals the delivery: 100% and the sum of every payer', () => {
    renderTable();
    const footer = screen.getAllByRole('row').slice(-1)[0];
    expect(footer).toHaveTextContent('Delivery total');
    expect(footer).toHaveTextContent('100%');
    expect(footer).toHaveTextContent('$1,421.84');
  });

  it('uses the true minus sign, two-decimal shares and the shared status palette', () => {
    renderTable({ rows: [
      { ...rows[0], pct: 33.333333, totalCents: -1500, status: 'paid' },
      { ...rows[1], pct: 66.666667, status: 'posted' },
    ] });
    const [, first, second] = screen.getAllByRole('row');
    expect(first).toHaveTextContent('33.33%');
    expect(first).toHaveTextContent('\u2212$15.00');
    expect(second).toHaveTextContent('66.67%');
    expect(within(first).getByText('Paid').className).toContain('bg-emerald-200');
    expect(within(second).getByText('Posted').className).toContain('bg-emerald-100');
  });

  it('says where the shares come from when the sale is known', () => {
    renderTable({ saleHref: '/orders/ord-7', saleNumber: 'ORD-2026-0007' });
    expect(screen.getByText(/Shares come from sale/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ORD-2026-0007' })).toHaveAttribute('href', '/orders/ord-7');
  });
});
