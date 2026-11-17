import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInMemoryQuery } from '../test-utils/inMemoryQuery';

const tables = vi.hoisted(() => ({ rows: {} as Record<string, Record<string, unknown>[]> }));
vi.mock('./db', () => ({ supabaseUntyped: { from: (table: string) => buildInMemoryQuery(tables.rows[table] ?? []) }, assertRpcResult: (data: unknown) => data }));

import { loadOpenChemistryProposals } from './productSetupChemistry';

describe('loadOpenChemistryProposals', () => {
  beforeEach(() => {
    tables.rows = {
      chemistry_change_proposals: [{ id: 'proposal-a', parent_id: 'parent-a', items: [
        { kind: 'ingredient', action: 'retire', row_id: 'link-retired' },
        { kind: 'ingredient', action: 'change', row_id: 'link-renamed', name: 'Submitted old name' },
        { kind: 'ingredient', action: 'change', row_id: 'link-missing', name: 'Unverified submitted name' },
      ], has_delete: true, base_chemistry_version: 2, proposal_version: 1, status: 'proposed', created_by: 'admin', created_at: '2026-11-14T00:00:00Z' }],
      product_parents: [{ id: 'parent-a', name: 'Parent A' }],
      product_parent_ingredients: [
        { id: 'link-retired', ingredient_id: 'ingredient-retired' },
        { id: 'link-renamed', ingredient_id: 'ingredient-renamed' },
      ],
      active_ingredients: [
        { id: 'ingredient-retired', name: 'Retired herbicide', cas: '123-45-6' },
        { id: 'ingredient-renamed', name: 'Current shared name', cas: '987-65-4' },
      ],
    };
  });

  it('resolves names by linked ids, including retired links, and marks unresolved names', async () => {
    const [proposal] = await loadOpenChemistryProposals();
    expect(proposal.parent_name).toBe('Parent A');
    expect(proposal.items[0]).toMatchObject({ display_name: 'Retired herbicide', cas: '123-45-6', unresolved: false });
    expect(proposal.items[1]).toMatchObject({ display_name: 'Current shared name', cas: '987-65-4', unresolved: false });
    expect(proposal.items[2]).toMatchObject({ display_name: null, unresolved: true });
    expect(proposal.unresolved).toBe(true);
  });
});
