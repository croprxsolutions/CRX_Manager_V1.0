import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import QuoteSplitNote from './QuoteSplitNote';

const offer = { kind: 'offer' as const, customer: 'Big Sky Farms 18', split: { splits: [{ recipient: 'Test Rep One', percentage: 60 }, { recipient: 'Test Rep Two', percentage: 40 }] } };

describe('QuoteSplitNote', () => {
  it('an offer wraps at every width so the whole split can be read before Use it, long names included (Sol MED)', () => {
    const onUse = vi.fn();
    render(<QuoteSplitNote note={offer} onUse={onUse} onKeep={vi.fn()} />);
    const text = screen.getByText("Use Big Sky Farms 18's split (Test Rep One 60% · Test Rep Two 40%)?");
    expect(text).not.toHaveClass('truncate');
    expect(text).not.toHaveClass('sm:truncate');
    expect(text).toHaveClass('break-words');
    expect(text.parentElement).toHaveClass('min-h-5', 'flex-wrap');
    expect(text.parentElement).not.toHaveClass('h-5');
    fireEvent.click(screen.getByRole('button', { name: 'Use it' }));
    expect(onUse).toHaveBeenCalledTimes(1);
  });

  it('every other note stays on one fixed line', () => {
    render(<QuoteSplitNote note={{ kind: 'from', customer: 'Big Sky Farms 18', split: offer.split }} onUse={vi.fn()} onKeep={vi.fn()} />);
    const text = screen.getByText("From Big Sky Farms 18's split.");
    expect(text).toHaveClass('truncate');
    expect(text.parentElement).toHaveClass('h-5');
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
