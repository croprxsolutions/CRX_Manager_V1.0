import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ supabaseUntyped: {}, assertRpcResult: (data: unknown) => data }));

import { normalizeEpaNumber, sideText, summarizeNumber, type ParentEpaState } from './epaProposals';
import type { EpaChemistryProposal, EpaLookup, EpaLookupFailure, EpaProposalItem } from '../types';

const NOW = Date.parse('2026-11-12T15:00:00Z');
const lookup = (id: string, minutesAgo: number, status: EpaLookup['status']): EpaLookup => ({
  id, parent_id: 'par1', epa_registration: '100-1', link_kind: 'parent', link_id: 'par1', registration_version: 1,
  chemistry_version: 0, status, requested_by: 'u1', requested_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  recorded_at: status === 'recorded' ? new Date(NOW).toISOString() : null, updated_at: new Date(NOW).toISOString(),
});
const proposal = (id: string, lookupId: string, status: EpaChemistryProposal['status']) => ({
  id, lookup_id: lookupId, epa_registration: '100-1', status, created_at: new Date(NOW).toISOString(),
} as EpaChemistryProposal);
const failure = (lookupId: string) => ({ id: `f-${lookupId}`, lookup_id: lookupId, epa_registration: '100-1', reason: 'not_found' } as EpaLookupFailure);
const state = (partial: Partial<ParentEpaState>): ParentEpaState => ({ numbers: ['100-1'], lookups: [], proposals: [], failures: [], ...partial });

describe('summarizeNumber', () => {
  it('shows the newest lookup that was not replaced, and the open proposal beside it', () => {
    // Lookups arrive newest first, as fetchParentEpaState orders them.
    const s = state({
      lookups: [lookup('l3', 1, 'abandoned'), lookup('l2', 5, 'recorded'), lookup('l1', 9, 'recorded')],
      proposals: [proposal('p1', 'l1', 'proposed')],
      failures: [failure('l2')],
    });
    const summary = summarizeNumber(s, '100-1', NOW);
    expect(summary.open?.id).toBe('p1');
    expect(summary.latest).toEqual({ kind: 'failure', failure: failure('l2') });
  });

  it('shows a pending lookup as running only for 30 minutes', () => {
    expect(summarizeNumber(state({ lookups: [lookup('l1', 5, 'pending')] }), '100-1', NOW).latest.kind).toBe('running');
    expect(summarizeNumber(state({ lookups: [lookup('l1', 31, 'pending')] }), '100-1', NOW).latest.kind).toBe('none');
  });

  it('keeps the newest committed proposal for the kept differences', () => {
    const s = state({ lookups: [lookup('l2', 1, 'recorded')], proposals: [proposal('p2', 'l2', 'rejected'), proposal('p1', 'l1', 'committed')] });
    expect(summarizeNumber(s, '100-1', NOW).committed?.id).toBe('p1');
  });
});

describe('item text', () => {
  it('words an ingredient from EPA and as stored', () => {
    const item = {
      item_id: 'ing:cas:1912-24-9', kind: 'ingredient', class: 'differs_typed', accept_default: false,
      epa: { name: 'Atrazine', cas: '1912-24-9', strength: 42.6 },
      current: { name: 'Atrazine', cas: '1912-24-9', strength_value: 40, strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'typed' },
    } as EpaProposalItem;
    expect(sideText(item, 'epa')).toBe('42.6 % w/w a.i. · CAS 1912-24-9');
    expect(sideText(item, 'current')).toBe('40 % w/w a.i. · CAS 1912-24-9, typed');
  });

  it('words label facts', () => {
    const status = { item_id: 'label:registration_status', kind: 'label', class: 'differs', accept_default: false, epa: true, current: 'unknown' } as EpaProposalItem;
    expect(sideText(status, 'epa')).toBe('Cancelled');
    expect(sideText(status, 'current')).toBe('Unknown');
    const doc = { item_id: 'label:label_document', kind: 'label', class: 'fill', accept_default: true,
      epa: { label_accepted_on: '2025-12-12', label_url: 'https://www3.epa.gov/x.pdf' }, current: { label_accepted_on: null, label_url: null } } as EpaProposalItem;
    expect(sideText(doc, 'epa')).toBe('accepted 2025-12-12, with link');
    expect(sideText(doc, 'current')).toBe('no date');
  });

  it('normalizes numbers as the database does', () => {
    expect(normalizeEpaNumber(' 100 - 1 ')).toBe('100-1');
    expect(normalizeEpaNumber('  ')).toBeNull();
  });
});
