import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import WhoPaysCard from './WhoPaysCard';

const base = {
  mainCustomerName: 'Maple Hollow Farms',
  shares: [{ id: 's1', customerName: 'Cedar Ridge Ag', pct: 35 }],
  productsTotal: 1333.2,
  lock: null,
  fieldSplitBills: false,
  canEdit: true,
  saving: false,
  onAdd: vi.fn(),
  onRemove: vi.fn(),
  customerPicker: <span>picker</span>,
};

const row = (name: string) => screen.getByText(name).closest('[data-payer]') as HTMLElement;

describe('WhoPaysCard', () => {
  it('shows the main customer with the rest of the split', () => {
    render(<WhoPaysCard {...base} />);
    expect(screen.getByText('2 payers · 100%')).toBeInTheDocument();
    expect(within(row('Maple Hollow Farms')).getByText('65%')).toBeInTheDocument();
    expect(within(row('Maple Hollow Farms')).getByText('Main customer · about $866.58 of products')).toBeInTheDocument();
    expect(within(row('Cedar Ridge Ag')).getByText('35%')).toBeInTheDocument();
    expect(within(row('Cedar Ridge Ag')).getByText('about $466.62 of products')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Maple Hollow Farms 65 percent, Cedar Ridge Ag 35 percent' })).toBeInTheDocument();
  });

  it('one payer reads as 100%', () => {
    render(<WhoPaysCard {...base} shares={[]} />);
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === 'Maple Hollow Farms pays 100%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a payer' })).toBeInTheDocument();
  });

  it('locked card explains why and hides editing', () => {
    render(<WhoPaysCard {...base} lock={{ text: 'Delivery DEL-00005 is complete and billed. To change who pays, void its invoices or the delivery first.' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Locked. Delivery DEL-00005 is complete and billed. To change who pays, void its invoices or the delivery first.');
    expect(screen.queryByRole('button', { name: 'Add a payer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it('remove asks first', () => {
    const onRemove = vi.fn();
    render(<WhoPaysCard {...base} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cedar Ridge Ag' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Cedar Ridge Ag?' });
    expect(within(dialog).getByText('Their 35% goes back to Maple Hollow Farms, the main customer.')).toBeInTheDocument();
    const buttons = within(dialog).getAllByRole('button').map((b) => b.textContent?.trim()).filter((t) => t === 'Keep payer' || t === 'Remove payer');
    expect(buttons).toEqual(['Keep payer', 'Remove payer']);
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove payer' }));
    expect(onRemove).toHaveBeenCalledWith('s1');
  });

  it('field split note', () => {
    render(<WhoPaysCard {...base} fieldSplitBills />);
    expect(screen.getByText('This sale is split by field below, so the field split decides who pays.')).toBeInTheDocument();
    expect(screen.queryByText(/about \$/)).not.toBeInTheDocument();
  });

  it('adds a payer with the share typed, previewing the split first', async () => {
    const onAdd = vi.fn().mockResolvedValue(true);
    render(<WhoPaysCard {...base} shares={[]} picked={{ id: 'c2', name: 'Cedar Ridge Ag' }} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a payer' }));
    expect(screen.getByText('picker')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Share'), { target: { value: '35' } });
    expect(within(row('Maple Hollow Farms')).getByText('65%')).toBeInTheDocument();
    expect(within(row('Cedar Ridge Ag')).getByText('35%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add payer' }));
    expect(onAdd).toHaveBeenCalledWith('c2', 35);
    expect(await screen.findByRole('button', { name: 'Add a payer' })).toBeInTheDocument();
  });

  it('keeps the form open when the add was refused', async () => {
    const onAdd = vi.fn().mockResolvedValue(false);
    render(<WhoPaysCard {...base} shares={[]} picked={{ id: 'c2', name: 'Cedar Ridge Ag' }} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a payer' }));
    fireEvent.change(screen.getByLabelText('Share'), { target: { value: '35' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add payer' }));
    await vi.waitFor(() => expect(onAdd).toHaveBeenCalled());
    expect(screen.getByLabelText('Share')).toHaveValue(35);
  });

  it('renders the line split under its own disclosure', () => {
    render(<WhoPaysCard {...base} lineSplit={<p>line editor</p>} />);
    expect(screen.getByText('Split by line').closest('details')).toContainElement(screen.getByText('line editor'));
    expect(screen.getByText("Each line follows this split. Charges, discount and tax are worked out on each payer's invoice.")).toBeInTheDocument();
  });
});
