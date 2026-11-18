import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import QuoteSplitNote from './QuoteSplitNote';

const offer = { kind: 'offer' as const, customer: 'Big Sky Farms 18', split: { splits: [{ recipient: 'Test Rep One', percentage: 60 }, { recipient: 'Test Rep Two', percentage: 40 }] } };

describe('QuoteSplitNote', () => {
  it('offers the customer split on one fixed line, full text on hover', () => {
    const onUse = vi.fn();
    render(<QuoteSplitNote note={offer} onUse={onUse} onKeep={vi.fn()} />);
    const text = screen.getByText("Use Big Sky Farms 18's split (Test Rep One 60% · Test Rep Two 40%)?");
    expect(text).toHaveClass('truncate');
    expect(text).toHaveAttribute('title', text.textContent);
    expect(text.parentElement).toHaveClass('h-5');
    fireEvent.click(screen.getByRole('button', { name: 'Use it' }));
    expect(onUse).toHaveBeenCalledTimes(1);
  });

  it('locks Use it and Keep mine while the split is locked (a save in flight)', () => {
    const onUse = vi.fn();
    render(<QuoteSplitNote note={offer} onUse={onUse} onKeep={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: 'Use it' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Use it' }));
    expect(onUse).not.toHaveBeenCalled();
  });

  it('keeps the empty line in place when there is nothing to say', () => {
    const { container } = render(<QuoteSplitNote note={null} onUse={vi.fn()} onKeep={vi.fn()} />);
    expect(container.firstElementChild).toHaveClass('h-5');
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });
});
