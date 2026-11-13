import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SaleInvoicesCard from './SaleInvoicesCard';

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

  it('with no invoices, explains when they are made', () => {
    renderCard({ invoices: [] });
    expect(screen.getByText('No invoices yet. Product invoices are made after delivery. Record advance payments as prepay.')).toBeInTheDocument();
  });
});
