import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import QuoteSplitNote from './QuoteSplitNote';

const split = { splits: [{ recipient: 'Test Rep One', percentage: 60 }, { recipient: 'Test Rep Two', percentage: 40 }] };

describe('QuoteSplitNote', () => {
  it('says where the split came from, wrapping a long farm name instead of hiding it (Sol LOW)', () => {
    render(<QuoteSplitNote note={{ kind: 'from', customer: 'Big Sky Farms 18', split }} />);
    const text = screen.getByText("From Big Sky Farms 18's split.");
    expect(text).not.toHaveClass('truncate');
    expect(text).toHaveClass('break-words');
  });

  it('says a customer with an empty split gives no commission', () => {
    render(<QuoteSplitNote note={{ kind: 'from', customer: 'Dry Creek Farms 3', split: { splits: [] } }} />);
    expect(screen.getByText("From Dry Creek Farms 3's split: no commission.")).toBeInTheDocument();
  });

  it('asks for a split when the customer has none', () => {
    render(<QuoteSplitNote note={{ kind: 'none', customer: 'Cedar Creek Farms 12' }} />);
    expect(screen.getByText('Cedar Creek Farms 12 has no split. Pick one.')).toBeInTheDocument();
  });

  it('keeps an empty line in place when there is nothing to say', () => {
    const { container } = render(<QuoteSplitNote note={null} />);
    expect(container.firstElementChild).toHaveClass('min-h-5');
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });

  it('never offers Use it or Keep mine', () => {
    render(<QuoteSplitNote note={{ kind: 'none', customer: 'Cedar Creek Farms 12' }} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
