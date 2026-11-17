import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchParentChemistry: vi.fn(),
  fetchActiveCostsWithVersion: vi.fn(),
  fetchIngredientWorklist: vi.fn(),
  fetchParentModeGroups: vi.fn(),
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

const section = (refreshKey: string, isAdmin = true) => (
  <ProductChemistrySection parentId="par1" parentVersion={1} refreshKey={refreshKey} isAdmin={isAdmin} profileId="u1" busy={false} />
);

const ingredientRow = (id: string, name: string) => ({
  row_id: `r-${id}`, ingredient_id: id, name, cas: null, provisional: false, is_parent_form: false, canonical_ingredient_id: null,
  canonical_name: null, canonical_fraction: null, strength_value: 10, strength_unknown: false, strength_unit: 'pct_ww',
  strength_basis: 'active_ingredient', source: 'label', source_note: null,
});
const withIngredients = (...rows: ReturnType<typeof ingredientRow>[]) => ({ ...chem, chemistry: { ...chem.chemistry, ingredients: rows } });
function groups(ingredients: unknown[], summary: unknown[], notRecorded: number, version = 1) {
  return { parent_id: 'par1', chemistry_version: version, ingredients, summary, not_recorded_count: notRecorded };
}
const scheme = (status: string, live: string[], derived: string[], typed: string[] = []) => ({
  scheme: 'HRAC', status, live, derived, typed: typed.map((code) => ({ row_id: `t${code}`, group_code: code, source: 'typed' })),
});

describe('ProductChemistrySection', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.fetchParentChemistry.mockResolvedValue(chem);
    mocks.fetchIngredientWorklist.mockResolvedValue({ needs_cas: [], possible_duplicates: [] });
    mocks.fetchParentModeGroups.mockResolvedValue(groups([], [], 0, 1));
    mocks.fetchActiveCostsWithVersion.mockResolvedValue({ costs: costs(10), refVersion: 0 });
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

  // MOA-1 sheet 3.3: each row of the table, the summary, and "group not recorded".
  it("shows each ingredient's live groups with where they come from, and the summary", async () => {
    mocks.fetchParentChemistry.mockResolvedValue(withIngredients(
      ingredientRow('a', 'atrazine'), ingredientRow('b', 'mesotrione'), ingredientRow('c', 'glyphosate salt'),
      ingredientRow('d', 'dicamba'), ingredientRow('e', 'unknownium'),
    ));
    mocks.fetchParentModeGroups.mockResolvedValue(groups([
      { ingredient_id: 'a', name: 'atrazine', derived_from: 'from_ingredient', acid_name: null, schemes: [scheme('differs', ['5'], ['27'], ['5'])], not_recorded: false },
      { ingredient_id: 'b', name: 'mesotrione', derived_from: 'from_ingredient', acid_name: null, schemes: [scheme('derived', ['27'], ['27'])], not_recorded: false },
      { ingredient_id: 'c', name: 'glyphosate salt', derived_from: 'from_acid', acid_name: 'glyphosate', schemes: [scheme('matches', ['9'], ['9'], ['9'])], not_recorded: false },
      { ingredient_id: 'd', name: 'dicamba', derived_from: null, acid_name: null, schemes: [scheme('typed', ['4'], [], ['4'])], not_recorded: false },
      { ingredient_id: 'e', name: 'unknownium', derived_from: null, acid_name: null, schemes: [], not_recorded: true },
    ], [
      { scheme: 'HRAC', group_code: '4', differs: false }, { scheme: 'HRAC', group_code: '5', differs: true },
      { scheme: 'HRAC', group_code: '9', differs: false }, { scheme: 'HRAC', group_code: '27', differs: false },
    ], 1));
    render(section('k'));
    expect(await screen.findByTestId('groups-summary')).toHaveTextContent('Groups: HRAC 4, 5 (differs), 9, 27 · 1 ingredient: group not recorded');
    expect(screen.getByText('differs: ingredient list says HRAC 27; this product says HRAC 5')).toBeInTheDocument();
    expect(screen.getByText('from ingredient list')).toBeInTheDocument();
    expect(screen.getByText("matches glyphosate's list")).toBeInTheDocument();
    expect(screen.getByText('typed on this product')).toBeInTheDocument();
    expect(screen.getByText('Group not recorded')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Set groups' })).toHaveLength(5);
  });

  it('a non-admin sees the groups but no Set groups button', async () => {
    mocks.fetchParentChemistry.mockResolvedValue(withIngredients(ingredientRow('b', 'mesotrione')));
    mocks.fetchParentModeGroups.mockResolvedValue(groups([
      { ingredient_id: 'b', name: 'mesotrione', derived_from: 'from_ingredient', acid_name: null, schemes: [scheme('derived', ['27'], ['27'])], not_recorded: false },
    ], [{ scheme: 'HRAC', group_code: '27', differs: false }], 0));
    render(section('k', false));
    expect(await screen.findByTestId('groups-summary')).toHaveTextContent('Groups: HRAC 27');
    expect(screen.queryByRole('button', { name: 'Set groups' })).toBeNull();
  });

  it('names only the EPA-confirmed codes when a scheme mixes EPA and typed codes', async () => {
    mocks.fetchParentChemistry.mockResolvedValue(withIngredients(ingredientRow('d', 'dicamba')));
    const mixed = { ...scheme('typed', ['5', '27'], []), typed: [
      { row_id: 't5', group_code: '5', source: 'epa_lookup' }, { row_id: 't27', group_code: '27', source: 'typed' },
    ] };
    mocks.fetchParentModeGroups.mockResolvedValue(groups([
      { ingredient_id: 'd', name: 'dicamba', derived_from: null, acid_name: null, schemes: [mixed], not_recorded: false },
    ], [{ scheme: 'HRAC', group_code: '5', differs: false }, { scheme: 'HRAC', group_code: '27', differs: false }], 0));
    render(section('k'));
    expect(await screen.findByText('typed on this product; EPA confirmed HRAC 5')).toBeInTheDocument();
  });

  it('Set groups is locked while the page has unsaved changes', async () => {
    mocks.fetchParentChemistry.mockResolvedValue(withIngredients(ingredientRow('b', 'mesotrione')));
    mocks.fetchParentModeGroups.mockResolvedValue(groups([
      { ingredient_id: 'b', name: 'mesotrione', derived_from: 'from_ingredient', acid_name: null, schemes: [scheme('derived', ['27'], ['27'])], not_recorded: false },
    ], [{ scheme: 'HRAC', group_code: '27', differs: false }], 0));
    render(<ProductChemistrySection parentId="par1" parentVersion={1} refreshKey="k" isAdmin profileId="u1" busy />);
    expect(await screen.findByRole('button', { name: 'Set groups' })).toBeDisabled();
  });

  it('re-reads both once when the two reads saw different chemistry, then says the groups are being updated', async () => {
    mocks.fetchParentChemistry.mockResolvedValue(withIngredients(ingredientRow('b', 'mesotrione')));
    mocks.fetchParentModeGroups.mockResolvedValue(groups([], [], 0, 2));
    render(section('k'));
    expect(await screen.findByText('Groups are being updated; reload the page.')).toBeInTheDocument();
    expect(mocks.fetchParentChemistry).toHaveBeenCalledTimes(2);
    expect(mocks.fetchParentModeGroups).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('groups-summary')).toBeNull();
  });

  it('a matching re-read shows the groups', async () => {
    mocks.fetchParentChemistry.mockResolvedValue(withIngredients(ingredientRow('b', 'mesotrione')));
    mocks.fetchParentModeGroups.mockResolvedValueOnce(groups([], [], 1, 2)).mockResolvedValueOnce(groups([
      { ingredient_id: 'b', name: 'mesotrione', derived_from: null, acid_name: null, schemes: [], not_recorded: true },
    ], [], 1, 1));
    render(section('k'));
    expect(await screen.findByTestId('groups-summary')).toHaveTextContent('Groups: none recorded · 1 ingredient: group not recorded');
  });
});
