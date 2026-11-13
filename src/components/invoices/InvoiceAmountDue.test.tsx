import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import InvoiceAmountDue from './InvoiceAmountDue';

const breakdown = {
  productsCents: 66660,
  charges: [{ label: 'Freight', cents: 4500 }],
  discount: { label: 'Standing discount 3%', cents: -2000 },
  tax: { label: 'Sales tax 6.25%', cents: 4323 },
  totalCents: 73483,
};
const base = { breakdown, paidCents: 0, prepayCents: 0, balanceCents: 73483, admin: null };

describe('InvoiceAmountDue', () => {
  it('lists products, each charge, the discount, tax, total, paid and balance in that order', () => {
    render(<InvoiceAmountDue {...base} />);
    const card = screen.getByRole('region', { name: 'Amount due' });
    expect(card.textContent).toMatch(
      /Products\$666\.60Freight\$45\.00Standing discount 3%−\$20\.00Sales tax 6\.25%\$43\.23Invoice total\$734\.83Paid\$0\.00Balance due\$734\.83/,
    );
    expect(screen.queryByText('Prepay applied')).not.toBeInTheDocument();
  });

  it('shows Prepay applied only when some was applied', () => {
    render(<InvoiceAmountDue {...base} prepayCents={1500} balanceCents={71983} />);
    expect(screen.getByText('Prepay applied').parentElement).toHaveTextContent('$15.00');
  });

  it('shows cost and margin for an admin, and nothing of either for a sales rep', () => {
    const { rerender } = render(<InvoiceAmountDue {...base} admin={{ costCents: 55590, marginCents: 9070, marginPct: 14.0 }} />);
    expect(screen.getByText('Cost')).toHaveTextContent('$555.90');
    expect(screen.getByText('Margin')).toHaveTextContent('$90.70 · 14.0%');
    rerender(<InvoiceAmountDue {...base} admin={null} />);
    expect(screen.queryByText('Cost')).not.toBeInTheDocument();
    expect(screen.queryByText('Margin')).not.toBeInTheDocument();
    expect(screen.queryByText(/\$555\.90/)).not.toBeInTheDocument();
  });

  it('an invoice with no charges, discount or tax shows Products and Invoice total only', () => {
    render(<InvoiceAmountDue {...base} breakdown={{ productsCents: 1000, charges: [], discount: null, tax: null, totalCents: 1000 }} balanceCents={1000} />);
    expect(screen.queryByText(/Standing discount/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sales tax/)).not.toBeInTheDocument();
    expect(screen.getByText('Products')).toBeInTheDocument();
    expect(screen.getByText('Invoice total')).toBeInTheDocument();
  });

  it('a new invoice has no Paid or Balance due yet', () => {
    render(<InvoiceAmountDue {...base} paidCents={null} />);
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
    expect(screen.queryByText('Balance due')).not.toBeInTheDocument();
  });

  it('places the discount control inside the card', () => {
    render(<InvoiceAmountDue {...base} discountControl={<label>Standing discount for this sale<input /></label>} />);
    expect(screen.getByRole('region', { name: 'Amount due' })).toContainElement(screen.getByLabelText('Standing discount for this sale'));
  });
});
