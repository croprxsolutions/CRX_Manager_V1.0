import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ supabaseUntyped: { rpc: vi.fn(), from: vi.fn() }, assertRpcResult: (d: unknown) => d }));

import {
  approvalEntry,
  approvalProblems,
  chosenRates,
  initialDraft,
  membersWithRateChange,
  productParentErrorMessage,
  sameEpaGroupNames,
  type ProposalGroup,
  type ProposalMember,
} from './productParentProposals';

function member(id: string, patch: Partial<ProposalMember> = {}): ProposalMember {
  return {
    product_id: id, product_name: `Rho ${id}`, sku: null, product_form: 'liquid', container_size: '2.5',
    container_unit: 'Gal', inventory_unit: 'Gal', is_active: true, category: 'Herbicide', use_timings: null,
    rate_per_acre: '1', rate_unit: 'qt', suggested_rate: null, epa_registration: '524-475', manufacturer: 'Bayer',
    suggested_size_role: 'package', brands: [], ...patch,
  };
}

function group(patch: Partial<ProposalGroup> = {}): ProposalGroup {
  return {
    id: '00000000-0000-4000-8000-000000000001', proposal_id: 'prop', suggested_name: 'Rho', product_form: 'liquid',
    generic_epa_registration: '524-475', identity_basis: 'epa_number', members: [member('a'), member('b')], conflicts: {},
    flags: [], group_fingerprint: 'fp', status: 'proposed', parent_id: null, decided_at: null, reason: null, ...patch,
  };
}

describe('approval drafts', () => {
  it('refuses a parent name over the 200 characters a parent can hold', () => {
    const g = group();
    expect(approvalProblems(g, { ...initialDraft(g), name: 'x'.repeat(200) })).toEqual([]);
    expect(approvalProblems(g, { ...initialDraft(g), name: 'x'.repeat(201) })).toEqual(['Shorten the parent name to 200 characters or fewer.']);
    // Counted as the database counts: one character each, not two UTF-16 units.
    expect(approvalProblems(g, { ...initialDraft(g), name: '\u{1F33E}'.repeat(150) })).toEqual([]);
  });

  it('names the other groups that share the EPA number, and none for a group with no EPA number', () => {
    const a = group({ id: 'a', suggested_name: 'Rho' });
    const b = group({ id: 'b', suggested_name: 'Rho Max' });
    const c = group({ id: 'c', suggested_name: 'Other', generic_epa_registration: '100-1' });
    const none = group({ id: 'n', generic_epa_registration: null });
    expect(sameEpaGroupNames(a, [a, b, c, none])).toEqual(['Rho Max']);
    expect(sameEpaGroupNames(none, [a, b, c, group({ id: 'm', generic_epa_registration: null })])).toEqual([]);
  });

  it('is ready as suggested when the sizes agree', () => {
    const g = group();
    expect(approvalProblems(g, initialDraft(g))).toEqual([]);
  });

  it('asks for a pick on every conflict and the owner tick on a no-EPA group', () => {
    const g = group({ identity_basis: 'owner_confirmed', conflicts: { rates: [
      { rate_per_acre: '1', rate_unit: 'qt', suggested_rate: null },
      { rate_per_acre: '2', rate_unit: 'qt', suggested_rate: null },
    ] } });
    const draft = initialDraft(g);
    expect(approvalProblems(g, draft)).toEqual([
      'Pick the rate.',
      'No size has an EPA number: tick that they are the same product.',
    ]);
    expect(approvalProblems(g, { ...draft, picks: { rates: 1 }, ownerConfirmed: true })).toEqual([]);
  });

  it('defaults a chemical tote to vendor-filled but waits for an answer on a fertilizer tote', () => {
    const chem = group({ members: [member('a', { suggested_size_role: 'fixed_tote' })] });
    expect(initialDraft(chem).totes).toEqual({ a: false });
    const fert = group({ members: [member('a', { category: 'Fertilizer', suggested_size_role: 'fixed_tote' })] });
    expect(initialDraft(fert).totes).toEqual({});
    expect(approvalProblems(fert, initialDraft(fert))).toContain('Say whether each tote is shop-filled.');
  });

  it('allows shop-filled only on a fertilizer parent that has a Bulk size, as approval does', () => {
    const chem = group({ members: [member('a', { suggested_size_role: 'bulk' }), member('b', { suggested_size_role: 'fixed_tote' })] });
    expect(approvalProblems(chem, { ...initialDraft(chem), totes: { b: true } }))
      .toContain('Only fertilizer totes can be shop-filled: mark the tote vendor-filled.');
    const fert = group({ members: [member('a', { category: 'Fertilizer', suggested_size_role: 'bulk' }),
      member('b', { category: 'Fertilizer', suggested_size_role: 'fixed_tote' })] });
    expect(approvalProblems(fert, { ...initialDraft(fert), totes: { b: true } })).toEqual([]);
    const noBulk = { ...initialDraft(fert), totes: { b: true }, sizeRoles: { a: 'package' as const, b: 'fixed_tote' as const } };
    expect(approvalProblems(fert, noBulk)).toContain('A shop-filled tote needs a Bulk size to fill from.');
  });

  it('refuses two Bulk sizes', () => {
    const g = group();
    const draft = { ...initialDraft(g), sizeRoles: { a: 'bulk' as const, b: 'bulk' as const } };
    expect(approvalProblems(g, draft)).toContain('Only one size can be Bulk.');
  });
});

describe('approvalEntry', () => {
  it('sends the exact picked value, the roles, tote answers and only the prices of changing sizes', () => {
    const rates = [
      { rate_per_acre: '1', rate_unit: 'qt', suggested_rate: null },
      { rate_per_acre: '2', rate_unit: 'qt', suggested_rate: null },
    ];
    const g = group({
      conflicts: { rates },
      members: [member('a'), member('b', { rate_per_acre: '2' }), member('c', { suggested_size_role: 'bulk', rate_per_acre: '2' }),
        member('d', { suggested_size_role: 'fixed_tote', rate_per_acre: '2', category: 'Fertilizer' })],
    });
    const draft = { ...initialDraft(g), picks: { rates: 1 }, totes: { d: true }, name: ' Rho 4L ' };
    const picked = chosenRates(g, draft);
    expect(picked).toBe(rates[1]);
    expect(membersWithRateChange(g, picked!).map((m) => m.product_id)).toEqual(['a']);
    const prices = { a: { tier1_price_per_acre: 5, tier2_price_per_acre: 4.5, tier3_price_per_acre: 4 } };
    expect(approvalEntry(g, draft, prices)).toEqual({
      group_id: g.id,
      group_fingerprint: 'fp',
      name: 'Rho 4L',
      choices: { rates: rates[1] },
      owner_confirmed: false,
      size_roles: { a: 'package', b: 'package', c: 'bulk', d: 'fixed_tote' },
      totes: { d: { shop_filled: true, fill_source_product_id: 'c' } },
      prices,
    });
  });

  it('compares a seed or each size’s rate unit with its stock unit, as approval does', () => {
    const g = group({ product_form: 'seed', members: [
      member('a', { product_form: 'seed', rate_unit: 'bag', inventory_unit: 'bag' }),
      member('b', { product_form: 'seed', rate_unit: 'bag', inventory_unit: 'each' }),
    ] });
    expect(membersWithRateChange(g, { rate_per_acre: '1', rate_unit: null, suggested_rate: null }).map((m) => m.product_id)).toEqual(['b']);
  });

  it('treats 1.50 and 1.5, and a blank and a missing suggested rate, as the same, as SQL does', () => {
    const g = group({ members: [member('a', { rate_per_acre: '1.50', suggested_rate: ' ' })] });
    expect(membersWithRateChange(g, { rate_per_acre: '1.5', rate_unit: 'qt', suggested_rate: null })).toEqual([]);
  });

  it('sends a brand pick per name when the sizes list brands', () => {
    const brand = { brand_id: 'b1', row_version: 1, brand_name: 'Slam', epa_registration: null, manufacturer: null,
      is_currently_sourced: true, is_rup: null, signal_word: null };
    const g = group({ members: [member('a', { brands: [brand] }), member('b')], flags: ['brand_lists_differ'] });
    const entry = approvalEntry(g, initialDraft(g), {});
    expect(entry.brands).toEqual({ slam: { keep: true, source_brand_id: 'b1' } });
  });
});

describe('productParentErrorMessage', () => {
  it('turns the refusals the screen can hit into plain English', () => {
    expect(productParentErrorMessage({ message: 'PRODUCT_PARENT_EPA_HAS_PARENT: parent "Rho" already has EPA number none and this name; build a new proposal' }))
      .toBe('A parent with this EPA number and name already exists (parent "Rho" already has EPA number none and this name). Build a new proposal; the group will then show as held.');
    expect(productParentErrorMessage({ message: 'PRODUCT_PARENT_TOTE_ANSWER_REQUIRED: say whether each tote of "Rho" is shop-filled' }))
      .toBe('Say whether each tote is shop-filled from the Bulk size or a vendor-filled package, then approve again.');
    expect(productParentErrorMessage({ message: 'PRODUCT_PARENT_BRANDS_DIFFER: "Rho" and "Rho 2" list different brands; make their brand lists match before moving a size' }))
      .toBe(`This size can't move: "Rho" and "Rho 2" list different brands. Make the two brand lists match first, then move it.`);
    expect(productParentErrorMessage({ message: 'PRODUCT_PARENT_GROUPING_NOT_OPEN: grouping opens when the new product screens are live' }))
      .toMatch(/^Grouping is not switched on yet/);
  });

  it('keeps the server words for other parent refusals', () => {
    expect(productParentErrorMessage({ message: 'PRODUCT_PARENT_TWO_BULK: "Rho" can have one bulk size' }))
      .toBe('Nothing was saved. "Rho" can have one bulk size');
  });
});
