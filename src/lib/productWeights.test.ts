import { describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('./db', async () => {
  const actual = await vi.importActual<typeof import('./db')>('./db');
  return { ...actual, supabaseUntyped: { rpc } };
});

import { draftMatchesBasis, fetchProductWeights, isLowerTrust, noWeightMessage, saveWeight, storedWeightPreview, type WeightDraft } from './productWeights';

describe('storedWeightPreview (what the database stores, half-up to 4 decimals)', () => {
  it('converts specific gravity 1.15 to 9.5972 lb/gal', () => {
    expect(storedWeightPreview('1.15', 'specific_gravity')).toBe('9.5972');
  });
  it('rounds a fifth decimal half-up and keeps 4 decimals exactly', () => {
    expect(storedWeightPreview('8.34545', 'lb_per_gal')).toBe('8.3455');
    expect(storedWeightPreview('8.34544', 'lb_per_gal')).toBe('8.3454');
    expect(storedWeightPreview('4000.00004', 'lb')).toBe('4000.0000');
    expect(storedWeightPreview('4000.00005', 'lb')).toBe('4000.0001');
    expect(storedWeightPreview('5', 'lb')).toBe('5.0000');
    expect(storedWeightPreview('0.00001', 'lb')).toBe('0.0000');
  });
  it('refuses anything that is not a plain decimal', () => {
    for (const bad of ['', '2abc', '-1', '1e3', '.5', 'NaN', '1,000']) expect(storedWeightPreview(bad, 'lb')).toBeNull();
  });
});

describe('isLowerTrust (measured > SDS > label > supplier)', () => {
  it('compares against the approved source only', () => {
    expect(isLowerTrust('supplier', 'sds')).toBe(true);
    expect(isLowerTrust('label', 'label')).toBe(false);
    expect(isLowerTrust('measured', 'supplier')).toBe(false);
    expect(isLowerTrust('supplier', undefined)).toBe(false);
  });
});

describe('draftMatchesBasis', () => {
  const draft = (basis: Record<string, unknown>) => ({ basis } as WeightDraft);
  it('matches only the pack or formulation the draft was entered for', () => {
    const pack = { container_size: 5, container_type: 'bag', container_unit: 'Lb', inventory_unit: 'Ea', unit_size: null };
    expect(draftMatchesBasis(draft(pack), { ...pack })).toBe(true);
    expect(draftMatchesBasis(draft(pack), { ...pack, container_size: 10 })).toBe(false);
    expect(draftMatchesBasis(draft(pack), null)).toBe(false);
  });
});

describe('fetchProductWeights', () => {
  it('refuses more than 500 distinct products rather than reading two moments', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `p${i}`);
    await expect(fetchProductWeights(ids)).rejects.toThrow('Too many products to weigh at once');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('sends each product once in one call', async () => {
    rpc.mockResolvedValueOnce({ data: { read_at: 't', units: { factors: {}, ambiguous: [] }, products: {} }, error: null });
    await fetchProductWeights(['a', 'b', 'a']);
    expect(rpc).toHaveBeenCalledWith('get_product_weights', { p_product_ids: ['a', 'b'] });
  });
});

describe('saveWeight', () => {
  it('sends the typed decimal text unchanged and a correction to correct_*', async () => {
    rpc.mockResolvedValue({ data: { version: 2 }, error: null });
    await saveWeight({ subject: { kind: 'density', subject_id: 'par', version: 1 }, value: '9.5972', unit: 'lb_per_gal', source: 'sds', note: ' ', key: 'k1' });
    expect(rpc).toHaveBeenLastCalledWith('set_parent_density', {
      p_parent_id: 'par', p_expected_density_version: 1, p_value: '9.5972', p_unit: 'lb_per_gal', p_source: 'sds', p_source_note: null, p_idempotency_key: 'k1',
    });
    await saveWeight({ subject: { kind: 'net_weight', subject_id: 'p1', version: 3 }, value: '5', unit: 'lb_per_gal', source: 'supplier', note: 'bag', correction: { reason: 'r', evidence: 'e' }, key: 'k2' });
    expect(rpc).toHaveBeenLastCalledWith('correct_size_net_weight', {
      p_product_id: 'p1', p_expected_version: 3, p_net_lb: '5', p_source: 'supplier', p_source_note: 'bag', p_reason: 'r', p_evidence: 'e', p_idempotency_key: 'k2',
    });
  });
});

describe('noWeightMessage', () => {
  it('says what would fix each refusal', () => {
    expect(noWeightMessage('X', 'no_parent')).toBe('Put X in a parent to record its weight');
    expect(noWeightMessage('X', 'no_approved_weight')).toBe('X has no approved weight yet');
    expect(noWeightMessage('X', 'seed_or_each')).toBe("Weight isn't tracked for seed or each products");
    expect(noWeightMessage('X', 'unknown_form')).toBe('X has no form set');
  });
});
