import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import InvoiceAmountDue from './InvoiceAmountDue';

const breakdown = {
  productsCents: 66660,
  charges: [{ label: 'Freight', cents: 4500 }],
  discount: { label: 'Standing discount 3%', cents: -2000 },
  tax: { label: 'Sales tax 6.25%', cents: 4323 },
  totalCents: 73483,
};
const base = { breakdown, totalCents: 73483, paidCents: 0, prepayCents: 0, balanceCents: 73483, admin: null };

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
    render(<InvoiceAmountDue {...base} breakdown={{ productsCents: 1000, charges: [], discount: null, tax: null, totalCents: 1000 }} totalCents={1000} balanceCents={1000} />);
    expect(screen.queryByText(/Standing discount/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sales tax/)).not.toBeInTheDocument();
    expect(screen.getByText('Products')).toBeInTheDocument();
    expect(screen.getByText('Invoice total')).toBeInTheDocument();
  });

  it('shows the saved invoice total, and no breakdown rows when the lines do not add up to it', () => {
    render(<InvoiceAmountDue {...base} totalCents={80000} balanceCents={80000} />);
    const card = screen.getByRole('region', { name: 'Amount due' });
    expect(card.textContent).toMatch(/^Amount dueInvoice total\$800\.00Paid\$0\.00Balance due\$800\.00$/);
    expect(screen.queryByText('Products')).not.toBeInTheDocument();
    expect(screen.queryByText('Freight')).not.toBeInTheDocument();
    expect(screen.queryByText(/Sales tax/)).not.toBeInTheDocument();
  });

  it('while there are unsaved edits, says the totals update on save and keeps the saved total', () => {
    render(<InvoiceAmountDue {...base} dirty totalCents={73483} breakdown={{ ...breakdown, productsCents: 76660, totalCents: 83483 }} />);
    const card = screen.getByRole('region', { name: 'Amount due' });
    expect(within(card).getByText('Invoice total').parentElement).toHaveTextContent('$734.83');
    expect(within(card).getByText('Totals update when you save')).toBeInTheDocument();
    expect(within(card).queryByText('Products')).not.toBeInTheDocument();
    expect(card).not.toHaveTextContent('$834.83');
  });

  // Sol MED: unsaved rows that happen to add up to the saved total would read as saved ($90 + $20 beside a saved $110).
  it('while there are unsaved edits, shows no rows even when they add up to the saved total', () => {
    render(<InvoiceAmountDue {...base} dirty />);
    const card = screen.getByRole('region', { name: 'Amount due' });
    expect(within(card).getByText('Invoice total').parentElement).toHaveTextContent('$734.83');
    expect(within(card).getByText('Totals update when you save')).toBeInTheDocument();
    for (const row of ['Products', 'Freight', 'Standing discount 3%', 'Sales tax 6.25%']) {
      expect(within(card).queryByText(row)).not.toBeInTheDocument();
    }
  });

  it('with no unsaved edits there is no save note', () => {
    render(<InvoiceAmountDue {...base} />);
    expect(screen.queryByText('Totals update when you save')).not.toBeInTheDocument();
  });

  it('a field application invoice names the first row Subtotal', () => {
    render(<InvoiceAmountDue {...base} firstLabel="Subtotal" />);
    expect(screen.getByText('Subtotal').parentElement).toHaveTextContent('$666.60');
    expect(screen.queryByText('Products')).not.toBeInTheDocument();
  });

  it('shows Written off only when some was written off', () => {
    const { rerender } = render(<InvoiceAmountDue {...base} writtenOffCents={2500} balanceCents={70983} />);
    expect(screen.getByText('Written off').parentElement).toHaveTextContent('$25.00');
    expect(screen.getByRole('region', { name: 'Amount due' }).textContent).toMatch(/Paid\$0\.00Written off\$25\.00Balance due\$709\.83/);
    rerender(<InvoiceAmountDue {...base} writtenOffCents={0} />);
    expect(screen.queryByText('Written off')).not.toBeInTheDocument();
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
