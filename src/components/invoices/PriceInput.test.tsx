import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import PriceInput from './PriceInput';
import { NEGATIVE_PRICE_MESSAGE, NOT_A_PRICE_MESSAGE, priceProblem } from '../../lib/priceProblem';
import { MONEY_PRECISION_MESSAGE } from '../../lib/parseCents';

// Types like a keyboard: each key is added to whatever the box shows now.
const typeKeys = (box: HTMLElement, keys: string) => {
  for (const key of keys) fireEvent.change(box, { target: { value: (box as HTMLInputElement).value + key } });
};
const clear = (box: HTMLElement) => fireEvent.change(box, { target: { value: '' } });

function Harness({ start, onProblem = vi.fn() }: { start: number; onProblem?: (id: string, p: unknown) => void }) {
  const [cents, setCents] = useState(start);
  return (
    <>
      <PriceInput cents={cents} label="Unit price for Herbicide" onCents={setCents} onProblem={onProblem} />
      <output aria-label="stored">{cents}</output>
    </>
  );
}

describe('PriceInput', () => {
  it.each([['0.50', '50'], ['1024.09', '102409'], ['4.35', '435']])('clears and types %s like a keyboard', (keys, stored) => {
    render(<Harness start={3333} />);
    const box = screen.getByLabelText('Unit price for Herbicide');
    expect(box).toHaveValue('33.33');
    clear(box);
    typeKeys(box, keys);
    expect(box).toHaveValue(keys);
    expect(screen.getByLabelText('stored')).toHaveTextContent(stored);
  });

  it('a third decimal stays in the box with a message, and the line keeps its last good amount', () => {
    const onProblem = vi.fn();
    render(<Harness start={3333} onProblem={onProblem} />);
    const box = screen.getByLabelText('Unit price for Herbicide');
    typeKeys(box, '5'); // the cursor was at the end of 33.33
    expect(box).toHaveValue('33.335');
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(MONEY_PRECISION_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText('stored')).toHaveTextContent('3333');
    expect(onProblem).toHaveBeenLastCalledWith(expect.any(String), { label: 'Unit price for Herbicide', message: MONEY_PRECISION_MESSAGE });
    fireEvent.change(box, { target: { value: '33.35' } });
    expect(screen.queryByText(MONEY_PRECISION_MESSAGE)).not.toBeInTheDocument();
    expect(onProblem).toHaveBeenLastCalledWith(expect.any(String), null);
  });

  it('leaving the box tidies a usable amount to two decimals', () => {
    render(<Harness start={0} />);
    const box = screen.getByLabelText('Unit price for Herbicide');
    clear(box);
    typeKeys(box, '0.5');
    fireEvent.blur(box);
    expect(box).toHaveValue('0.50');
  });

  it('refuses a negative price and anything that is not a price, storing nothing', () => {
    render(<Harness start={1000} />);
    const box = screen.getByLabelText('Unit price for Herbicide');
    fireEvent.change(box, { target: { value: '-5' } });
    expect(screen.getByText(NEGATIVE_PRICE_MESSAGE)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'abc' } });
    expect(screen.getByText(NOT_A_PRICE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText('stored')).toHaveTextContent('1000');
  });

  it('tells the page the problem is gone when the box goes away', () => {
    const onProblem = vi.fn();
    const { unmount } = render(<Harness start={1000} onProblem={onProblem} />);
    fireEvent.change(screen.getByLabelText('Unit price for Herbicide'), { target: { value: '1.005' } });
    unmount();
    expect(onProblem).toHaveBeenLastCalledWith(expect.any(String), null);
  });

  it.each([['', null], ['25.50', null], ['$25', null], ['.5', null], ['1.005', MONEY_PRECISION_MESSAGE], ['-1', NEGATIVE_PRICE_MESSAGE], ['1.2.3', NOT_A_PRICE_MESSAGE], ['.', NOT_A_PRICE_MESSAGE]])('priceProblem(%j)', (text, expected) => {
    expect(priceProblem(text)).toBe(expected);
  });
});
