import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import NearCostConfirmations from './NearCostConfirmations';

describe('NearCostConfirmations', () => {
  it('asks "did you mean 35 for 35%?" for a margin under 1% and reports the tick', () => {
    const onTickChange = vi.fn();
    render(
      <NearCostConfirmations
        products={[{ product_id: 'p1', product_name: 'Roundup', tiers: [
          { tier: 2, price_cents: 642n, cost_cents: 640n, fraction_margin_percent: '0.35' },
          { tier: 3, price_cents: 652n, cost_cents: 640n, fraction_margin_percent: null },
        ] }]}
        ticked={new Set()}
        disabled={false}
        onTickChange={onTickChange}
      />,
    );
    expect(screen.getByText(/margin 0.35%: did you mean 35 for 35%\?/)).toBeInTheDocument();
    expect(screen.getByText(/Tier 3 \$6.52 on a cost of \$6.40/)).not.toHaveTextContent('did you mean');
    const box = screen.getByRole('checkbox', { name: /all 2 prices above are meant/ });
    expect(box).toHaveAccessibleDescription(/Roundup/);
    fireEvent.click(box);
    expect(onTickChange).toHaveBeenCalledWith('p1', true);
  });
});
