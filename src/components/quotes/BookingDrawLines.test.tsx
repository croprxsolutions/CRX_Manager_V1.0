import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import BookingDrawLines, { type DrawRow } from './BookingDrawLines';

const row = (patch: Partial<DrawRow>): DrawRow => ({
  product_id: 'p1', product_name: 'Glyphosate', booked: 10, drawn: 4, remaining: 6, qty: '', unit: 'gal',
  bookedPrice: 10, todayPrice: 11, extraPrice: 'today', ...patch,
});

function Harness({ rows, stacked }: { rows: DrawRow[]; stacked: boolean }) {
  const [current, setCurrent] = useState(rows);
  return <BookingDrawLines rows={current} onChange={setCurrent} drawing={false} stacked={stacked} />;
}

describe('BookingDrawLines', () => {
  it('on a phone shows one stacked card per product with a large quantity box', () => {
    render(<Harness stacked rows={[row({}), row({ product_id: 'p2', product_name: 'Atrazine', remaining: 0, drawn: 10 })]} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('Glyphosate')).toBeInTheDocument();
    const box = within(cards[0]).getByRole('spinbutton', { name: 'Quantity to draw for Glyphosate' });
    expect(box.className).toContain('min-h-12');
    expect(within(cards[1]).getByRole('spinbutton', { name: 'Quantity to draw for Atrazine' })).toBeDisabled();
  });

  it('Send all remaining fills only lines with something left, to the hundredth', () => {
    render(<Harness stacked={false} rows={[row({ remaining: 333.34 }), row({ product_id: 'p2', product_name: 'Atrazine', remaining: 0, drawn: 10 })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send all remaining' }));
    expect(screen.getByRole('spinbutton', { name: 'Quantity to draw for Glyphosate' })).toHaveValue(333.34);
    expect(screen.getByRole('spinbutton', { name: 'Quantity to draw for Atrazine' })).toHaveValue(null);
  });

  it('offers no Send all remaining when nothing is left on the booking', () => {
    render(<Harness stacked={false} rows={[row({ remaining: 0, drawn: 10 })]} />);
    expect(screen.queryByRole('button', { name: 'Send all remaining' })).not.toBeInTheDocument();
  });
});
