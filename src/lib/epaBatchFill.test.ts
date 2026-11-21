import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { batchDecision, epaNameMatches, errorText } from './epaBatchFill';
import type { EpaProposalItem } from '../types';

const ing = (key: string, pct: number | null, cas: string | null = '1912-24-9', cls: EpaProposalItem['class'] = 'add'): EpaProposalItem => ({
  item_id: `ing:${key}`, kind: 'ingredient', class: cls, epa: { name: key, cas, strength: pct }, current: null, accept_default: true,
  change: { kind: 'ingredient', name: key, ...(cas ? { cas } : {}), strength_value: pct },
});
const label = (fact: string, cls: EpaProposalItem['class'], epa: unknown = 'Caution'): EpaProposalItem => ({
  item_id: `label:${fact}`, kind: 'label', class: cls, epa, current: null, accept_default: cls !== 'differs', change: {},
});
const proposal = (items: EpaProposalItem[], summary: Record<string, unknown> = {}) => ({
  status: 'proposed' as const, items, epa_summary: { productname: 'AATREX 4L HERBICIDE', ...summary },
});
const names = ['Aatrex 4L'];

describe('epaNameMatches', () => {
  it('matches the first word of any app name', () => {
    expect(epaNameMatches('HALEX GT HERBICIDE', ['Halex GT 2.5 gal'])).toBe(true);
    expect(epaNameMatches('CAPTURE 2 EC', ['Brigade', 'Bifenthrin 2EC'])).toBe(false);
    expect(epaNameMatches('DU PONT DEMOSAN T SEED FUNGICIDE', ['Atrazine 90 DF'])).toBe(false);
    expect(epaNameMatches(null, names)).toBe(false);
    expect(epaNameMatches('SURFACE HERBICIDE', ['Ace'])).toBe(false); // whole words only, never a substring
    expect(epaNameMatches('Lumax® EZ Herbicide', ['Lumax EZ'])).toBe(true);
  });
});

describe('batchDecision', () => {
  it('commits plain adds, accepting only ingredients and declining every writable label item explicitly', () => {
    const d = batchDecision(proposal([ing('atrazine', 42.6), label('signal_word', 'fill'), label('label_document', 'fill', {}),
      label('registration_status', 'differs', false)]), names);
    expect(d).toEqual({ commit: true, ingredients: 1, decisions: [
      { item_id: 'ing:atrazine', accept: true },
      { item_id: 'label:signal_word', accept: false },
      { item_id: 'label:label_document', accept: false },
    ] });
  });

  it.each([
    ['name mismatch', proposal([ing('a', 10)], { productname: 'DEMOSAN T' }), /does not match/],
    ['manual check', proposal([ing('a', 10)], { needsManual: true }), /manual/],
    ['distributor', proposal([ing('a', 10)], { base_label_note: true }), /Distributor/],
    ['cancelled', proposal([ing('a', 10)], { isCancelled: true }), /cancelled/],
    ['no ingredients', proposal([label('signal_word', 'fill')]), /no ingredients/],
    ['no CAS', proposal([ing('a', 10, null, 'add_name_only')]), /needs a person/],
    ['conflict', proposal([ing('a', 10, '94-75-7', 'epa_conflict')]), /needs a person/],
    ['retired', proposal([ing('a', 10, '94-75-7', 'ingredient_retired')]), /needs a person/],
    ['blank CAS', proposal([ing('a', 10, '   ')]), /needs a person/],
    ['malformed CAS', proposal([ing('a', 10, 'n/a')]), /needs a person/],
    ['null percent', proposal([ing('a', null)]), /no percent/],
    ['zero percent', proposal([ing('a', 0)]), /no percent/],
    ['over 100', proposal([ing('a', 60), ing('b', 40.0001, '51218-45-2')]), /more than 100/],
    ['signal word differs', proposal([ing('a', 10), label('signal_word', 'differs')]), /differs/],
    ['newer label over an existing date', proposal([ing('a', 10), { ...label('label_document', 'fill', {}), current: { label_accepted_on: '2020-01-01', label_url: null } }]), /newer label/],
    ['restricted use', proposal([ing('a', 10), label('rup_status', 'rup_upgrade', 'yes')]), /restricted/],
    ['EPA says cancelled', proposal([ing('a', 10), label('registration_status', 'differs', true)]), /cancelled/],
  ])('leaves it for a person: %s', (_name, p, reason) => {
    const d = batchDecision(p, names);
    expect(d.commit).toBe(false);
    if (!d.commit) expect(d.reason).toMatch(reason);
  });

  it('accepts percents summing to exactly 100 despite float drift', () => {
    expect(batchDecision(proposal([ing('a', 33.3333), ing('b', 33.3333, '51218-45-2'), ing('c', 33.3334, '94-75-7')]), names).commit).toBe(true);
  });

  it('adds percents exactly, as the database does (#2120)', () => {
    // Rounding each to five decimals made this exact 100 split read 100.00001.
    expect(batchDecision(proposal([ing('a', 33.333335), ing('b', 33.333335, '51218-45-2'), ing('c', 33.33333, '94-75-7')]), names).commit).toBe(true);
    const over = batchDecision(proposal([ing('a', 33.333334), ing('b', 33.333333, '51218-45-2'), ing('c', 33.333334, '94-75-7')]), names);
    expect(over).toEqual({ commit: false, reason: 'Ingredient percents add up to more than 100' });
    expect(batchDecision(proposal([ing('a', 1e-7), ing('b', 99.9999999, '51218-45-2')]), names).commit).toBe(true);
    expect(batchDecision(proposal([ing('a', 100), ing('b', 1e-21, '51218-45-2')]), names)).toEqual({ commit: false, reason: 'Ingredient percents add up to more than 100' });
  });

  it('refuses a proposal that is not open', () => {
    expect(batchDecision({ ...proposal([ing('a', 10)]), status: 'held' }, names)).toEqual({ commit: false, reason: 'Proposal is held' });
  });
});

describe('fetchBatchCandidates reads', () => {
  // pagedReadCallSites cannot see the tables behind readAll(table, ...), so each read is checked here.
  it('reads only tables and columns in the schema registry, sorting on a selected unique column', () => {
    const registry: Record<string, string[]> = JSON.parse(readFileSync(join(__dirname, '..', '..', '.claude', 'schema-registry.json'), 'utf8')).columns;
    const source = readFileSync(join(__dirname, 'epaBatchFill.ts'), 'utf8');
    const reads = [...source.matchAll(/readAll<[^>]*>\(\s*'(\w+)',\s*'([^']+)',\s*'(\w+)'/g)];
    expect(reads).toHaveLength(10);
    for (const [, table, columns, order] of reads) {
      const cols = columns.split(',').map((c) => c.trim());
      for (const col of cols) expect(registry[table], `${table}.${col}`).toContain(col);
      expect(cols, `${table} order`).toContain(order);
    }
  });
});

describe('errorText', () => {
  it('shows the message of a plain database error object, not [object Object]', () => {
    expect(errorText({ code: 'P0001', message: 'EPA_REGISTRATION_MISSING: EPA registration 1381-158 does not exist yet' }))
      .toBe('EPA_REGISTRATION_MISSING: EPA registration 1381-158 does not exist yet');
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
  });
});

describe('startTabRun', () => {
  it('refuses a second run while one is going, and allows one after it ends', async () => {
    let finish!: () => void;
    const { startTabRun, currentTabRun } = await import('./epaBatchFill');
    expect(startTabRun(() => new Promise<void>((resolve) => { finish = resolve; }))).toBe(true);
    expect(startTabRun(async () => {})).toBe(false);
    finish();
    await currentTabRun();
    expect(currentTabRun()).toBeNull();
    expect(startTabRun(async () => {})).toBe(true);
  });
});
