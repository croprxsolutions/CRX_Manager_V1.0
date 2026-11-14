import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SaleMoneySummary from './SaleMoneySummary';

const base = { saleTotal: 1333.2, invoiced: 1421.84, paid: 0, balanceDue: 1421.84, showProfit: false, invoiceNote: null };

describe('SaleMoneySummary', () => {
  it('shows the sale, invoiced, paid and balance due amounts', () => {
    render(<SaleMoneySummary {...base} />);
    expect(screen.getByText('Sale total')).toBeInTheDocument();
    expect(screen.getByText('$1,333.20')).toBeInTheDocument();
    expect(screen.getByText('Invoiced')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('$0.00')).toBeInTheDocument();
    expect(screen.getByText('Balance due')).toBeInTheDocument();
    expect(screen.getAllByText('$1,421.84')).toHaveLength(2);
    expect(screen.queryByText('Profit · margin')).not.toBeInTheDocument();
  });

  it('says under Balance due how many invoices there are and whether they are drafts', () => {
    render(<SaleMoneySummary {...base} balanceNote="2 invoices, both drafts" />);
    expect(screen.getByText('2 invoices, both drafts')).toBeInTheDocument();
  });

  it('shows profit and margin only when asked', () => {
    render(<SaleMoneySummary {...base} showProfit profit={221.4} marginPct={16.6} />);
    expect(screen.getByText('Profit · margin')).toBeInTheDocument();
    expect(screen.getByText('$221.40')).toBeInTheDocument();
    expect(screen.getByText('16.6%')).toBeInTheDocument();
  });

  it('shows a written-off amount only when there is one', () => {
    const { rerender } = render(<SaleMoneySummary {...base} writtenOff={0} />);
    expect(screen.queryByText('Written off')).not.toBeInTheDocument();
    rerender(<SaleMoneySummary {...base} writtenOff={12.5} />);
    expect(screen.getByText('Written off')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
  });

  it('with no invoice totals, shows the note instead of $0.00 tiles', () => {
    render(<SaleMoneySummary {...base} invoiced={null} paid={null} balanceDue={null} invoiceNote="You can't view any invoices for this order." />);
    expect(screen.getByText("You can't view any invoices for this order.")).toBeInTheDocument();
    expect(screen.queryByText('Invoiced')).not.toBeInTheDocument();
    expect(screen.queryByText('Balance due')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });
});
