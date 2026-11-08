import { describe, expect, it, vi } from 'vitest';
import * as db from './db';
import { headerEdited, matchesPageRead, resolveTicketLines, totalWeightText, warnWeightsChangedWhileSaving, weightsChangedWhileSaving, type BlendTicketWeights, type TicketSnapshot } from './blendTicketWeights';
import type { ProductWeightsResult } from './productWeights';
import type { WeightUnitFactors } from '../types';

const units: WeightUnitFactors = { factors: { gal: { kind: 'volume', factor: 1 }, lb: { kind: 'weight', factor: 1 } }, ambiguous: [] };
const snap = (lb: number): TicketSnapshot => ({ blend_ticket_id: 't1', product_id: 'p1', captured_name: 'TEST P', product_form: 'liquid',
  weight_kind: 'density', value_id: 'v1', value_reviewed_at: '2026-11-07T15:00:00Z', value_reviewed_by: null, lb_per_unit: lb,
  per_unit: 'Gal', unit_factors: units, source: 'sds', value_basis: null, none_reason: null, captured_how: 'at_save', captured_at: 't' });
const pageLine = { id: 'l1', product_id: 'p1', quantity: 2, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null };
const saved: BlendTicketWeights = {
  read_at: 't', basis_unit_factors: units, current_unit_factors: units, retained: {},
  ticket: { total_volume: 100, total_volume_unit: 'Lb', total_acres: null, application_rate: null },
  lines: [{ line_id: 'l1', product_id: 'p1', line: pageLine, weight: snap(8) }],
};
const current: ProductWeightsResult = { read_at: 't', units, products: {
  p1: { product_id: 'p1', found: true, product_form: 'liquid', weight: { kind: 'density', lb_per_unit: 10, per_unit: 'Gal' } },
  p2: { product_id: 'p2', found: true, product_form: 'liquid', weight: { kind: 'density', lb_per_unit: 9, per_unit: 'Gal' } },
} };
const line = (over: Record<string, unknown>) => ({ id: 'l1', product_id: 'p1', product_name: 'TEST P', quantity: 2, unit: 'Gal', catalogForm: 'liquid', ...over });
const lbOf = (resolved: ReturnType<typeof resolveTicketLines>[number]) => ('lb' in resolved.mapped.weightLb! ? resolved.mapped.weightLb.lb : null);

describe('resolveTicketLines', () => {
  it('weighs a saved line at its saved weight, with its current amount, not today\'s weight', () => {
    const [first] = resolveTicketLines([line({ quantity: 3 })], { saved, current });
    expect(lbOf(first)).toBe(24);
    expect(first.text).toBe('24.00 lb · weight saved with this ticket: 8 lb/gal, from the SDS, approved 11/7/2026');
  });

  it('previews a new line of a captured product at the ticket\'s saved weight (the save reuses it)', () => {
    expect(lbOf(resolveTicketLines([line({ id: 'new' })], { saved, current })[0])).toBe(16);
  });

  it('previews a relinked line at the new product\'s current weight', () => {
    const [relinked] = resolveTicketLines([line({ product_id: 'p2', product_name: 'TEST Q' })], { saved, current });
    expect(lbOf(relinked)).toBe(18);
    expect(relinked.text).toBe('18.00 lb · current approved weight; kept when you save');
  });

  it('names an unlinked line and a line whose weight could not be read', () => {
    expect(resolveTicketLines([line({ product_id: null })], { saved, current })[0].text).toBe('TEST P is not linked to a product, so it has no weight');
    expect(resolveTicketLines([line({ id: 'new', product_id: 'p3' })], { saved, current: null })[0].text).toBe('TEST P: weights unavailable');
  });

  it('says a saved "no weight" line had none when saved, even after a weight is approved today', () => {
    const none = { ...snap(8), weight_kind: 'none' as const, lb_per_unit: null, value_id: null, none_reason: 'no_approved_weight' as const };
    const savedNone = { ...saved, lines: [{ ...saved.lines[0], weight: none }] };
    expect(resolveTicketLines([line({})], { saved: savedNone, current })[0].text).toBe('TEST P had no approved weight when this ticket was saved');
  });

  it('withholds the total with each reason', () => {
    const lines = resolveTicketLines([line({}), line({ id: 'x', product_id: null, product_name: 'TEST U' })], { saved, current });
    expect(totalWeightText(lines)).toBe('Total product weight not shown: TEST U is not linked to a product, so it has no weight');
  });
});

describe('matchesPageRead and headerEdited', () => {
  it('accepts the same ticket and refuses a line changed between the two reads', () => {
    expect(matchesPageRead(saved, { total_volume: 100.0, total_volume_unit: 'Lb', total_acres: null, application_rate: null }, [pageLine])).toBe(true);
    expect(matchesPageRead(saved, saved.ticket!, [{ ...pageLine, quantity: 3 }])).toBe(false);
    expect(matchesPageRead(saved, { ...saved.ticket, total_volume: 90 }, [pageLine])).toBe(false);
  });

  it('treats 100 and 100.0 as the same header, and a new unit as an edit', () => {
    expect(headerEdited(saved, 100.0, 'Lb')).toBe(false);
    expect(headerEdited(saved, 100, 'lb')).toBe(true);
  });
});

describe('weightsChangedWhileSaving', () => {
  it('names a line whose saved weight differs from its preview, and never a line that was not previewed', async () => {
    const rpc = vi.spyOn(db.supabaseUntyped, 'rpc').mockResolvedValue({ data: saved, error: null } as never);
    const lines = [line({})];
    const preview = resolveTicketLines(lines, { saved: null, current });
    expect(await weightsChangedWhileSaving('t1', lines, preview)).toEqual(['TEST P']);
    expect(await weightsChangedWhileSaving('t1', lines, [])).toEqual([]);
    // A line whose weight read failed showed "weights unavailable": never reported as changed.
    const unread = resolveTicketLines(lines, { saved: null, current: null });
    expect(unread[0].unread).toBe(true);
    expect(await weightsChangedWhileSaving('t1', lines, unread)).toEqual([]);
    rpc.mockRestore();
  });
});

describe('warnWeightsChangedWhileSaving', () => {
  it('warns per changed line, skips a preview that was not ready, and says so when the check cannot run', async () => {
    const lines = [line({})];
    const ready = { status: 'ready', lines: resolveTicketLines(lines, { saved: null, current }) };
    const warn = vi.fn();
    const rpc = vi.spyOn(db.supabaseUntyped, 'rpc').mockResolvedValue({ data: saved, error: null } as never);
    await warnWeightsChangedWhileSaving('t1', lines, ready, warn, 'test');
    expect(warn.mock.calls).toEqual([["TEST P's weight changed while saving; the ticket keeps the saved weight"]]);

    warn.mockClear();
    await warnWeightsChangedWhileSaving('t1', lines, { ...ready, status: 'unavailable' }, warn, 'test');
    expect(warn.mock.calls).toEqual([['The ticket saved, but some weights were not shown before saving. Reopen the ticket to see the weights it kept.']]);
    warn.mockClear();

    // Ready overall, but one line's weight was never read: told to reopen, and that line is not called "changed".
    await warnWeightsChangedWhileSaving('t1', lines, { status: 'ready', lines: resolveTicketLines(lines, { saved: null, current: null }) }, warn, 'test');
    expect(warn.mock.calls).toEqual([['The ticket saved, but some weights were not shown before saving. Reopen the ticket to see the weights it kept.']]);
    warn.mockClear();

    rpc.mockResolvedValue({ data: null, error: { message: 'down' } } as never);
    await warnWeightsChangedWhileSaving('t1', lines, ready, warn, 'test');
    expect(warn.mock.calls).toEqual([['The ticket saved, but its weights could not be checked. Reopen the ticket to see them.']]);
    rpc.mockRestore();
  });
});
