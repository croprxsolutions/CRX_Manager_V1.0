import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchSellPriceHistory: vi.fn(), captureException: vi.fn() }));

vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../../lib/sellPriceHistory', async () => {
  const actual = await vi.importActual<typeof import('../../lib/sellPriceHistory')>('../../lib/sellPriceHistory');
  return { ...actual, fetchSellPriceHistory: mocks.fetchSellPriceHistory };
});

import ProductSellPriceHistory from './ProductSellPriceHistory';

const base = {
  change_reason: null, change_note: null,
  old_tier2_price: 9.5, new_tier2_price: 9.5, old_tier3_price: null, new_tier3_price: null,
};

describe('ProductSellPriceHistory', () => {
  beforeEach(() => {
    mocks.fetchSellPriceHistory.mockReset();
    mocks.captureException.mockReset();
  });

  it('charts each tier on a date axis and lists the starting point and each change, newest first', async () => {
    mocks.fetchSellPriceHistory.mockResolvedValue([
      { ...base, id: 's', changed_at: '2026-10-01T15:00:00Z', change_source: 'starting_snapshot', change_reason: 'Prices when price history started', old_tier1_price: 10, new_tier1_price: 10 },
      { ...base, id: 'r', changed_at: '2026-10-20T15:00:00Z', change_source: 'pricing_worksheet', change_reason: 'Wells letter', old_tier1_price: 10, new_tier1_price: 11 },
    ]);
    render(<ProductSellPriceHistory productId="p1" />);
    const chart = await screen.findByRole('img', { name: /Sell prices by tier from Oct 1, 2026 to/ });
    // Tier 1 and tier 2 at both points; tier 3 has no price.
    expect(chart.querySelectorAll('circle')).toHaveLength(4);
    expect(chart.querySelectorAll('path')).toHaveLength(2);

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Price sheet')).toBeInTheDocument();
    expect(within(items[0]).getByText('$10.00')).toHaveClass('line-through');
    expect(within(items[0]).getByText('$11.00')).toBeInTheDocument();
    expect(within(items[0]).getByText('Wells letter')).toBeInTheDocument();
    expect(within(items[1]).getByText('Starting point')).toBeInTheDocument();
    expect(within(items[1]).queryByText('$10.00')).not.toHaveClass('line-through');
  });

  it('names who made each change, and shows the source alone when no name came back', async () => {
    mocks.fetchSellPriceHistory.mockResolvedValue([
      { ...base, id: 's', changed_at: '2026-10-01T15:00:00Z', change_source: 'starting_snapshot', changer: null, old_tier1_price: 10, new_tier1_price: 10 },
      { ...base, id: 'a', changed_at: '2026-10-20T15:00:00Z', change_source: 'pricing_worksheet', changer: { full_name: 'Pat Admin' }, old_tier1_price: 10, new_tier1_price: 11 },
      { ...base, id: 'b', changed_at: '2026-10-21T15:00:00Z', change_source: 'product_page', changer: { full_name: '  ' }, old_tier1_price: 11, new_tier1_price: 12 },
    ]);
    render(<ProductSellPriceHistory productId="p1" />);
    await screen.findByRole('img', { name: /Sell prices by tier/ });
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]).getByText('Product page')).toBeInTheDocument();
    expect(within(items[1]).getByText('Price sheet · Pat Admin')).toBeInTheDocument();
    expect(within(items[2]).getByText('Starting point')).toBeInTheDocument();
  });

  it('draws the prices in effect before the first change of a product with older history', async () => {
    mocks.fetchSellPriceHistory.mockResolvedValue([
      { ...base, id: 'r', changed_at: '2026-10-20T15:00:00Z', change_source: 'product_page', old_tier1_price: 10, new_tier1_price: 11 },
    ]);
    render(<ProductSellPriceHistory productId="p1" />);
    const chart = await screen.findByRole('img', { name: /Sell prices by tier/ });
    // Tier 1's line starts at the left edge on its old price, then steps up at the change.
    const tier1 = chart.querySelector('path[stroke="#15803d"]');
    expect(tier1?.getAttribute('d')).toMatch(/^M 5 /);
    expect(screen.getByText(/^Before, then Oct 20, 2026$/)).toBeInTheDocument();
    // $10 (before) is the bottom of the range, $11 the top.
    expect(screen.getByText(/\$9\.50 – \$11\.00/)).toBeInTheDocument();
  });

  it('shows the prices of a product whose only logged change was to cost', async () => {
    mocks.fetchSellPriceHistory.mockResolvedValue([
      { ...base, id: 'c', changed_at: '2026-10-20T15:00:00Z', change_source: 'product_page', old_tier1_price: 10, new_tier1_price: 10 },
    ]);
    render(<ProductSellPriceHistory productId="p1" />);
    expect(await screen.findByRole('img', { name: /Sell prices by tier/ })).toBeInTheDocument();
    expect(screen.queryByText('No price changes recorded since this product was created.')).not.toBeInTheDocument();
  });

  it('never shows one product\'s history on another product\'s page', async () => {
    let resolveB: (rows: unknown[]) => void = () => {};
    mocks.fetchSellPriceHistory
      .mockResolvedValueOnce([
        { ...base, id: 'a', changed_at: '2026-10-20T15:00:00Z', change_source: 'product_page', change_reason: 'Product A change', old_tier1_price: 10, new_tier1_price: 11 },
      ])
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
    const { rerender } = render(<ProductSellPriceHistory productId="a" />);
    expect(await screen.findByText('Product A change')).toBeInTheDocument();
    rerender(<ProductSellPriceHistory productId="b" />);
    expect(screen.queryByText('Product A change')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading sell price history');
    resolveB([]);
    expect(await screen.findByText('No price changes recorded since this product was created.')).toBeInTheDocument();
  });

  it('says a failed load could not be loaded, reports it, and retries', async () => {
    mocks.fetchSellPriceHistory.mockRejectedValueOnce(new Error('network'));
    mocks.fetchSellPriceHistory.mockResolvedValueOnce([]);
    render(<ProductSellPriceHistory productId="p1" />);
    expect(await screen.findByText('Sell price history could not be loaded')).toBeInTheDocument();
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('No price changes recorded since this product was created.')).toBeInTheDocument();
  });

  it('keeps the last answer, marked out of date, when a refresh fails, and never stretches it to today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-25T18:00:00Z'));
      let failRefresh: (error: Error) => void = () => {};
      const rows = [
        { ...base, id: 'r', changed_at: '2026-10-20T15:00:00Z', change_source: 'pricing_worksheet', change_reason: 'Wells letter', old_tier1_price: 10, new_tier1_price: 11 },
      ];
      mocks.fetchSellPriceHistory
        .mockResolvedValueOnce(rows)
        .mockImplementationOnce(() => new Promise((_, reject) => { failRefresh = reject; }))
        .mockResolvedValueOnce(rows);
      const { rerender } = render(<ProductSellPriceHistory productId="p1" reloadToken={0} />);
      expect(await screen.findByRole('img', { name: /to Oct 25, 2026$/ })).toBeInTheDocument();

      vi.setSystemTime(new Date('2026-11-20T18:00:00Z'));
      rerender(<ProductSellPriceHistory productId="p1" reloadToken={1} />);
      expect(screen.getByRole('status')).toHaveTextContent('Refreshing sell price history');
      expect(screen.getByText('Wells letter').closest('[aria-busy="true"]')).not.toBeNull();

      await act(async () => { failRefresh(new Error('network')); });
      expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh. This history may be out of date.');
      expect(screen.getByText('Wells letter')).toBeInTheDocument();
      // The axis still ends on the day the shown answer was read, not today.
      expect(screen.getByRole('img', { name: /to Oct 25, 2026$/ })).toBeInTheDocument();
      expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ extra: { context: 'sell_price_history' } }));

      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      expect(await screen.findByRole('img', { name: /to Nov 20, 2026$/ })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a price it cannot show exactly is a failed read, not an empty history', async () => {
    mocks.fetchSellPriceHistory.mockResolvedValueOnce([
      { ...base, id: 'x', changed_at: '2026-10-20T15:00:00Z', change_source: 'product_page', old_tier1_price: 10, new_tier1_price: 10.555 },
    ]);
    render(<ProductSellPriceHistory productId="p1" />);
    expect(await screen.findByText('Sell price history could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No price changes recorded since this product was created.')).not.toBeInTheDocument();
  });
});
