import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import PriceInput from './PriceInput';
import { NEGATIVE_PRICE_MESSAGE, NOT_A_PRICE_MESSAGE, TOO_MANY_DECIMALS_MESSAGE, priceProblem } from '../../lib/priceProblem';

// Types like a keyboard: each key is added to whatever the box shows now.
const typeKeys = (box: HTMLElement, keys: string) => {
  for (const key of keys) fireEvent.change(box, { target: { value: (box as HTMLInputElement).value + key } });
};
const clear = (box: HTMLElement) => fireEvent.change(box, { target: { value: '' } });

// Holds the line's price and draft the way InvoiceDetail does.
function Harness({ start }: { start: number }) {
  const [cents, setCents] = useState(start);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <>
      <PriceInput
        className="border border-gray-200 focus:ring-crx-green/20 focus:border-crx-green"
        cents={cents} draft={draft} label="Unit price for Herbicide" onCents={setCents} onDraft={setDraft}
      />
      <output aria-label="stored">{cents}</output>
      <output aria-label="draft">{draft ?? 'none'}</output>
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

  it('a third decimal stays in the box with a note, and the line keeps its last good amount', () => {
    render(<Harness start={3333} />);
    const box = screen.getByLabelText('Unit price for Herbicide');
    typeKeys(box, '5'); // the cursor was at the end of 33.33
    expect(box).toHaveValue('33.335');
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(TOO_MANY_DECIMALS_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText('stored')).toHaveTextContent('3333');
    expect(screen.getByLabelText('draft')).toHaveTextContent('33.335');
    fireEvent.blur(box); // leaving a bad price keeps it, so Save can still see it
    expect(screen.getByLabelText('draft')).toHaveTextContent('33.335');
    fireEvent.change(box, { target: { value: '33.35' } });
    expect(screen.queryByText(TOO_MANY_DECIMALS_MESSAGE)).not.toBeInTheDocument();
    expect(box).not.toHaveAttribute('aria-invalid');
  });

  it('leaving the box tidies a usable amount to two decimals and drops the draft', () => {
    render(<Harness start={0} />);
    const box = screen.getByLabelText('Unit price for Herbicide');
    clear(box);
    typeKeys(box, '0.5');
    fireEvent.blur(box);
    expect(box).toHaveValue('0.50');
    expect(screen.getByLabelText('draft')).toHaveTextContent('none');
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

  it('keeps the helper line in place with or without a note, so nothing below moves', () => {
    render(<Harness start={3333} />);
    const box = screen.getByLabelText('Unit price for Herbicide');
    const line = box.nextElementSibling as HTMLElement;
    expect(line).toHaveClass('min-h-5');
    expect(line).toBeEmptyDOMElement();
    expect(box).toHaveClass('border-gray-200');
    typeKeys(box, '5');
    expect(box.nextElementSibling).toBe(line);
    expect(line).toHaveTextContent(TOO_MANY_DECIMALS_MESSAGE);
    expect(box).toHaveAttribute('aria-describedby', line.id);
    expect(box).toHaveClass('border-red-500');
    expect(box).not.toHaveClass('border-gray-200');
  });

  it.each([['', null], ['25.50', null], ['$25', null], ['.5', null], ['1.005', TOO_MANY_DECIMALS_MESSAGE], ['12.345', TOO_MANY_DECIMALS_MESSAGE], ['-1', NEGATIVE_PRICE_MESSAGE], ['1a', NOT_A_PRICE_MESSAGE], ['1.2.3', NOT_A_PRICE_MESSAGE], ['.', NOT_A_PRICE_MESSAGE]])('priceProblem(%j)', (text, expected) => {
    expect(priceProblem(text)).toBe(expected);
  });
});
