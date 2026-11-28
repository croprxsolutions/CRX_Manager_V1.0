import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import NearCostConfirmations from './NearCostConfirmations';

describe('NearCostConfirmations', () => {
  it('asks "did you mean 35 for 35%?" for a margin under 1% and reports the tick', () => {
    const onTickChange = vi.fn();
    render(
      <NearCostConfirmations
        products={[{ product_id: 'p1', product_name: 'Roundup', tiers: [
          { tier: 2, price_cents: 642n, cost_cents: 640n, fraction_margin_percent: '0.35', margin_driven: true },
          { tier: 3, price_cents: 652n, cost_cents: 640n, fraction_margin_percent: null, margin_driven: false },
        ] }]}
        ticked={new Set()}
        disabled={false}
        onTickChange={onTickChange}
      />,
    );
    expect(screen.getByText(/margin 0.35%: did you mean 35 for 35%\?/)).toBeInTheDocument();
    expect(screen.getByText(/Tier 3 \$6.52 on a cost of \$6.40/)).not.toHaveTextContent('did you mean');
    const box = screen.getByRole('checkbox', { name: /all 2 prices and margins above are what I meant/ });
    expect(box).toHaveAccessibleDescription(/Roundup/);
    fireEvent.click(box);
    expect(onTickChange).toHaveBeenCalledWith('p1', true);
  });

  it('keeps the near-cost tick without suggesting a margin correction on price-driven rows', () => {
    render(
      <NearCostConfirmations
        products={[{ product_id: 'p1', product_name: 'Roundup', tiers: [
          { tier: 1, price_cents: 642n, cost_cents: 640n, fraction_margin_percent: '0.326797', margin_driven: false },
        ] }]}
        ticked={new Set()}
        disabled={false}
        onTickChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/margin 0.33%/)).toBeInTheDocument();
    expect(screen.queryByText(/did you mean/)).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /this price and margin are what I meant/ })).toBeInTheDocument();
  });

  it('does not suggest a rounded correction of 100 or more', () => {
    render(
      <NearCostConfirmations
        products={[{ product_id: 'p1', product_name: 'Roundup', tiers: [
          { tier: 1, price_cents: 641n, cost_cents: 640n, fraction_margin_percent: '0.9999999', margin_driven: true },
        ] }]}
        ticked={new Set()}
        disabled={false}
        onTickChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/margin 1%/)).toBeInTheDocument();
    expect(screen.queryByText(/did you mean 100 for 100%/)).not.toBeInTheDocument();
  });
});
