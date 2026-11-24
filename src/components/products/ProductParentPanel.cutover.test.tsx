import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSource } = vi.hoisted(() => ({ mockSource: vi.fn() }));
vi.mock('../../lib/productParents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/productParents')>()),
  getParentRateSource: mockSource,
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import ProductParentPanel from './ProductParentPanel';
import type { ProductParent } from '../../lib/productParents';

const parent = {
  id: 'par1', name: 'Smart Test', product_form: 'dry', rate_per_acre: '1.8', rate_unit: 'Dry oz', suggested_rate: null,
  parent_version: 4, is_active: true, sizes: [],
} as unknown as ProductParent;
const show = (isAdmin = true) => render(
  <MemoryRouter>
    <ProductParentPanel parent={parent} productId="p1" isAdmin={isAdmin} profileId="u1" ratesLocked categoryOptions={[]}
      timingOptions={[]} rateUnitOptions={[]} busy={false} onChanged={vi.fn()} />
  </MemoryRouter>,
);

beforeEach(() => { mockSource.mockReset(); });

describe('RT-4a: rate in use on the Parent panel', () => {
  it('shows the old rate and offers the switch to an admin', async () => {
    mockSource.mockResolvedValue('legacy');
    show();
    expect(await screen.findByText('Old rate')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to approved rate' })).toBeEnabled();
  });

  it('offers the switch back when the group is on its approved rate', async () => {
    mockSource.mockResolvedValue('approved');
    show();
    expect(await screen.findByText('Approved rate (from the rate review)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch back to old rate' })).toBeEnabled();
  });

  it('offers no switch when the rate in use could not be read', async () => {
    mockSource.mockRejectedValue(new Error('network'));
    show();
    expect(await screen.findByText("Couldn't check; reload the page")).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Switch to approved rate' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', "Couldn't check; reload the page");
  });

  it('shows no switch to a non-admin', async () => {
    mockSource.mockResolvedValue('legacy');
    show(false);
    expect(await screen.findByText('Old rate')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch/ })).toBeNull();
  });
});
