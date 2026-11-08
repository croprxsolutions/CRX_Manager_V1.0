import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchParentChemistry: vi.fn(),
  fetchActiveCostsWithVersion: vi.fn(),
  fetchIngredientWorklist: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../../lib/productChemistry', async () => {
  const actual = await vi.importActual<typeof import('../../lib/productChemistry')>('../../lib/productChemistry');
  return { ...actual, ...mocks, pendingSaves: () => [] };
});

import ProductChemistrySection from './ProductChemistrySection';

const chem = {
  parent_id: 'par1', parent_name: 'TEST Atrazine 4L', product_form: 'liquid', is_active: true, chemistry_version: 1,
  chemistry: { ingredients: [], modes_of_action: [], fertilizer: [] }, epa_refusal: null, sizes: [],
};
const costs = (lbPerGal: number) => ({
  parent_id: 'par1', parent_name: 'TEST Atrazine 4L', chemistry_version: 1, label: 'replacement cost',
  density: { lb_per_gal: lbPerGal, weight_row_id: 'w1' }, reference: { product_id: null, source: null, reason: 'REFERENCE_UNSET' },
  parent_figures: null, sizes: [],
});

const section = (refreshKey: string) => (
  <ProductChemistrySection parentId="par1" parentVersion={1} refreshKey={refreshKey} isAdmin profileId="u1" busy={false} />
);

describe('ProductChemistrySection', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.fetchParentChemistry.mockResolvedValue(chem);
    mocks.fetchIngredientWorklist.mockResolvedValue({ needs_cas: [], possible_duplicates: [] });
  });

  // Regression (PR #1646): a weight or pricing save elsewhere on the page must re-read cost per lb of active.
  it('re-reads cost per lb of active when the page saves a weight or pricing', async () => {
    mocks.fetchActiveCostsWithVersion.mockResolvedValueOnce({ costs: costs(10), refVersion: 0 })
      .mockResolvedValueOnce({ costs: costs(12), refVersion: 0 });
    const { rerender } = render(section('["t1",1,0]'));
    expect(await screen.findByText('Weight per gallon: 10 lb/gal (approved)')).toBeInTheDocument();
    rerender(section('["t1",1,1]'));
    expect(await screen.findByText('Weight per gallon: 12 lb/gal (approved)')).toBeInTheDocument();
    await waitFor(() => expect(mocks.fetchActiveCostsWithVersion).toHaveBeenCalledTimes(2));
  });
});
