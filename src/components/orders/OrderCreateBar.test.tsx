import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import OrderCreateBar from './OrderCreateBar';

describe('OrderCreateBar', () => {
  it('shows the running total beside Create Order and calls the same handler', () => {
    const onCreate = vi.fn();
    render(<OrderCreateBar placement="inline" totalDollars={1234.5} priceLater={false} saving={false} onCreate={onCreate} />);
    expect(screen.getByText('$1,234.50')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create Order' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('is disabled and says Creating while the order saves', () => {
    render(<OrderCreateBar placement="bottom" totalDollars={10} priceLater={false} saving onCreate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled();
  });

  it('sticks to the bottom on a phone, above the bottom navigation', () => {
    render(<OrderCreateBar placement="bottom" totalDollars={10} priceLater={false} saving={false} onCreate={vi.fn()} />);
    expect(screen.getByTestId('order-bottom-bar').className).toContain('sticky');
  });

  it('shows no money to field staff and says a rush order is priced later', () => {
    const { rerender } = render(<OrderCreateBar placement="bottom" totalDollars={null} priceLater={false} saving={false} onCreate={vi.fn()} />);
    expect(screen.queryByText('Order total')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Order' })).toBeInTheDocument();

    rerender(<OrderCreateBar placement="inline" totalDollars={0} priceLater saving={false} onCreate={vi.fn()} />);
    expect(screen.getByText('Priced later')).toBeInTheDocument();
  });
});
