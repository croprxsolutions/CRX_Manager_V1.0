import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SaleInvoicesCard, { activeTotalCents } from './SaleInvoicesCard';

const invoices = [
  { id: 'inv-1', number: 'CS-2026-0005-1', payerName: 'Maple Hollow Farms', sharePct: 50, status: 'draft', total: 734.83, balance: 734.83 },
  { id: 'inv-2', number: 'CS-2026-0005-2', payerName: 'Cedar Ridge Ag', sharePct: 50, status: 'draft', total: 687.01, balance: 687.01 },
];

function renderCard(props: Partial<Parameters<typeof SaleInvoicesCard>[0]> = {}) {
  const onPostAll = vi.fn(() => Promise.resolve());
  render(
    <MemoryRouter>
      <SaleInvoicesCard invoices={invoices} canPost onPostAll={onPostAll} posting={false} {...props} />
    </MemoryRouter>,
  );
  return onPostAll;
}

describe('SaleInvoicesCard', () => {
  it('shows each invoice as one link with its payer, share, amount and status', () => {
    renderCard();
    const row = screen.getByRole('link', { name: /CS-2026-0005-1/ });
    expect(row).toHaveAttribute('href', '/invoices/inv-1');
    expect(within(row).getByText('Maple Hollow Farms · 50%')).toBeInTheDocument();
    expect(within(row).getByText('$734.83')).toBeInTheDocument();
    expect(within(row).getByText('Draft')).toBeInTheDocument();
    expect(screen.queryByText('draft')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /CS-2026-0005-2/ })).toHaveAttribute('href', '/invoices/inv-2');
    expect(screen.getByText('$1,421.84')).toBeInTheDocument();
  });

  it('leaves voided and cancelled invoices out of the total, adding whole cents', () => {
    renderCard({ invoices: [
      { ...invoices[0], status: 'voided' },
      { ...invoices[1], status: 'posted' },
      { id: 'inv-3', number: 'CS-2026-0005-3', payerName: 'Pine Flats', status: 'draft', total: 687.01, balance: 687.01 },
    ] });
    expect(screen.getByText('$1,374.02')).toBeInTheDocument();
    expect(activeTotalCents([{ status: 'draft', total: 0.1 }, { status: 'draft', total: 0.2 }, { status: 'cancelled', total: 5 }])).toBe(30);
  });

  it('asks before posting the drafts, listing each one', async () => {
    const onPostAll = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Post 2 drafts…' }));
    expect(onPostAll).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Post 2 drafts on this sale?' });
    expect(within(dialog).getByText('CS-2026-0005-1')).toBeInTheDocument();
    expect(within(dialog).getByText('$734.83')).toBeInTheDocument();
    expect(within(dialog).getByText('CS-2026-0005-2')).toBeInTheDocument();
    expect(within(dialog).getByText('$687.01')).toBeInTheDocument();
    const buttons = within(dialog).getAllByRole('button').map((b) => b.textContent?.trim()).filter((t) => t === 'Keep as drafts' || t === 'Post 2 drafts');
    expect(buttons).toEqual(['Keep as drafts', 'Post 2 drafts']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 2 drafts' }));
    await waitFor(() => expect(onPostAll).toHaveBeenCalledTimes(1));
  });

  it('keeping them as drafts posts nothing', async () => {
    const onPostAll = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Post 2 drafts…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep as drafts' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onPostAll).not.toHaveBeenCalled();
  });

  it('offers no post button without the right, or with no drafts', () => {
    renderCard({ canPost: false });
    expect(screen.queryByRole('button', { name: /Post/ })).not.toBeInTheDocument();
  });

  it('counts only drafts and unposted invoices', () => {
    renderCard({ invoices: [invoices[0], { ...invoices[1], status: 'posted' }] });
    expect(screen.getByRole('button', { name: 'Post 1 draft…' })).toBeInTheDocument();
    expect(screen.getByText('Posted')).toBeInTheDocument();
  });

  it('keeps the invoice type when it is not a sale, and what has been paid', () => {
    renderCard({ invoices: [
      { ...invoices[0], status: 'posted', paid: 200, balance: 534.83 },
      { id: 'cm-1', number: 'CM-0001', payerName: 'Maple Hollow Farms', status: 'posted', total: -150, balance: -150, typeLabel: 'Credit memo' },
    ] });
    const row = screen.getByRole('link', { name: /CS-2026-0005-1/ });
    expect(within(row).getByText('Paid $200.00')).toBeInTheDocument();
    expect(within(screen.getByRole('link', { name: /CM-0001/ })).getByText('Maple Hollow Farms · Credit memo')).toBeInTheDocument();
    expect(within(screen.getByRole('link', { name: /CM-0001/ })).queryByText(/^Paid/)).not.toBeInTheDocument();
  });

  it('status pills follow the shared invoice palette: Paid darker than Posted, Overdue amber', () => {
    renderCard({ invoices: [
      { ...invoices[0], status: 'paid', balance: 0 },
      { ...invoices[1], status: 'posted' },
      { id: 'inv-3', number: 'CS-2026-0005-3', payerName: 'Maple Hollow Farms', status: 'overdue', total: 10, balance: 10 },
    ] });
    expect(screen.getByText('Paid').className).toContain('bg-emerald-200');
    expect(screen.getByText('Posted').className).toContain('bg-emerald-100');
    expect(screen.getByText('Overdue').className).toContain('bg-amber-100');
  });

  it('keeps a share to two decimals', () => {
    renderCard({ invoices: [{ ...invoices[0], sharePct: 33.333333 }] });
    expect(screen.getByText('Maple Hollow Farms · 33.33%')).toBeInTheDocument();
  });

  it('with no invoices, explains when they are made', () => {
    renderCard({ invoices: [] });
    expect(screen.getByText('No invoices yet. Product invoices are made after delivery. Record advance payments as prepay.')).toBeInTheDocument();
  });
});
