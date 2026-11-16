import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import WhoPaysCard from './WhoPaysCard';
import { cardLiveCents } from '../../lib/billSplitLock';

// The page's live amounts: the split writer's line-by-line cents over these lines.
const lines = (...totals: number[]) => (card: Parameters<typeof cardLiveCents>[2]) =>
  cardLiveCents(totals.map((t, i) => ({ id: `l${i}`, total_price: t })), new Set(), card, 'cust-1');

const base = {
  mainCustomerId: 'cust-1',
  mainCustomerName: 'Maple Hollow Farms',
  shares: [{ id: 's1', customerId: 'cust-2', customerName: 'Cedar Ridge Ag', pct: 35 }],
  liveCents: lines(1333.2),
  lock: null,
  fieldSplitBills: false,
  canEdit: true,
  saving: false,
  onAdd: vi.fn(),
  onRemove: vi.fn(),
  clearPick: vi.fn(),
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

  it('three payers with 60-character names: every row keeps its percent and the bar names them all', () => {
    const main = 'Maple Hollow Farms and Sons Agricultural Partnership Limited'.padEnd(60, 'x').slice(0, 60);
    const second = 'Cedar Ridge Ag Cooperative of the Northern River Valley Group'.padEnd(60, 'x').slice(0, 60);
    const third = 'Maple Hollow Farms North Unit Irrigated Acres Holding Company'.padEnd(60, 'x').slice(0, 60);
    expect([main, second, third].map((n) => n.length)).toEqual([60, 60, 60]);
    render(<WhoPaysCard {...base} mainCustomerName={main}
      shares={[{ id: 's1', customerId: 'cust-2', customerName: second, pct: 33.33 }, { id: 's2', customerId: 'cust-3', customerName: third, pct: 33.33 }]} />);
    expect(screen.getByText('3 payers · 100%')).toBeInTheDocument();
    expect(within(row(main)).getByText('33.34%')).toBeInTheDocument();
    expect(within(row(second)).getByText('33.33%')).toBeInTheDocument();
    expect(within(row(third)).getByText('33.33%')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: `${main} 33.34 percent, ${second} 33.33 percent, ${third} 33.33 percent` })).toBeInTheDocument();
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
    const dialog = screen.getByRole('alertdialog', { name: 'Remove Cedar Ridge Ag?' });
    expect(within(dialog).getByText('Their 35% goes back to Maple Hollow Farms, the main customer.')).toBeInTheDocument();
    const buttons = within(dialog).getAllByRole('button').map((b) => b.textContent?.trim()).filter((t) => t === 'Keep payer' || t === 'Remove payer');
    expect(buttons).toEqual(['Keep payer', 'Remove payer']);
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove payer' }));
    expect(onRemove).toHaveBeenCalledWith('s1');
  });

  it('field split note', () => {
    render(<WhoPaysCard {...base} fieldSplitBills />);
    expect(screen.getByText('This sale is split by field, so the field split decides who pays.')).toBeInTheDocument();
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

  it('the preview bills each line on its own, as the invoices will', () => {
    // 33.33% of 10c, 20c and 5c floors to 3c, 6c and 1c: 10c. The whole 35c split at once would give 11c.
    render(<WhoPaysCard {...base} shares={[]} liveCents={lines(0.1, 0.2, 0.05)} picked={{ id: 'cust-2', name: 'Cedar Ridge Ag' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a payer' }));
    fireEvent.change(screen.getByLabelText('Share'), { target: { value: '33.33' } });
    expect(within(row('Cedar Ridge Ag')).getByText('about $0.10 of products')).toBeInTheDocument();
    expect(within(row('Maple Hollow Farms')).getByText('Main customer · keeps the rest · about $0.25 of products')).toBeInTheDocument();
  });

  it('refuses a share that would take the card past 100%, saying what is left', () => {
    const onAdd = vi.fn();
    render(<WhoPaysCard {...base} picked={{ id: 'cust-3', name: 'Birch Lane Co' }} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a payer' }));
    fireEvent.change(screen.getByLabelText('Share'), { target: { value: '70' } });
    expect(screen.getByRole('alert')).toHaveTextContent('The shares would pass 100%. 65% is left for this payer.');
    expect(screen.queryByText('Preview')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add payer' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Share'), { target: { value: '65' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add payer' })).toBeEnabled();
  });

  it('drops the picked customer when the form opens and on Cancel', () => {
    const clearPick = vi.fn();
    render(<WhoPaysCard {...base} clearPick={clearPick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a payer' }));
    expect(clearPick).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(clearPick).toHaveBeenCalledTimes(2);
  });

  it('a share the main customer holds folds into their row, and removing it says they still pay the rest', () => {
    const onRemove = vi.fn();
    render(<WhoPaysCard {...base} onRemove={onRemove} liveCents={lines(100)}
      shares={[{ id: 's0', customerId: 'cust-1', customerName: 'Maple Hollow Farms', pct: 30 }, { id: 's1', customerId: 'cust-2', customerName: 'Cedar Ridge Ag', pct: 40 }]} />);
    expect(screen.getByText('2 payers · 100%')).toBeInTheDocument();
    expect(screen.getAllByText('Maple Hollow Farms')).toHaveLength(1);
    expect(within(row('Maple Hollow Farms')).getByText('60%')).toBeInTheDocument();
    expect(within(row('Maple Hollow Farms')).getByText('Main customer · about $60.00 of products')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Maple Hollow Farms' }));
    expect(screen.getByText('Maple Hollow Farms is the main customer, so they still pay whatever the other payers leave.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove payer' }));
    expect(onRemove).toHaveBeenCalledWith('s0');
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
