import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MONEY_PRECISION_MESSAGE } from '../../lib/parseCents';
import QuickPriceChangeModal from './QuickPriceChangeModal';

const product = {
  product_name: 'Invented Herbicide',
  sku: 'INV-1',
  current_cost: 80,
  tier1_price: 100,
  tier2_price: 103.23,
  tier3_price: 106.67,
};

function setup(overrides: Partial<typeof product> | { tier2_price: null } = {}) {
  const onSubmit = vi.fn();
  render(<QuickPriceChangeModal product={{ ...product, ...overrides }} onClose={vi.fn()} onSubmit={onSubmit} />);
  return onSubmit;
}

const typeTierTwo = (value: string) => fireEvent.change(screen.getByLabelText('Tier 2 price'), { target: { value } });
const review = () => fireEvent.click(screen.getByRole('button', { name: 'Review Price Change' }));

describe('QuickPriceChangeModal', () => {
  it('starts from the saved amounts and hands on exactly what was typed', () => {
    const onSubmit = setup();
    typeTierTwo(' 110.25 ');
    review();
    expect(onSubmit).toHaveBeenCalledWith({
      current_cost: '80',
      tier1_price: '100',
      tier2_price: '110.25',
      tier3_price: '106.67',
    });
  });

  it('refuses more than two decimal places, never rounding', () => {
    const onSubmit = setup();
    typeTierTwo('1.999');
    review();
    expect(screen.getByText(MONEY_PRECISION_MESSAGE)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 'abc', '-5', '1e5', '12.3.4'])('never reads %j as a price', (typed) => {
    const onSubmit = setup();
    typeTierTwo(typed);
    review();
    expect(screen.getByText(/Enter (an amount|a plain dollar amount)/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('asks for a price the product does not have yet', () => {
    const onSubmit = setup({ tier2_price: null });
    expect(screen.getByLabelText('Tier 2 price')).toHaveValue('');
    review();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
