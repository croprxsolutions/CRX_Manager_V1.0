import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('./db', () => ({
  supabaseUntyped: { rpc: (...args: unknown[]) => rpc(...args) },
  assertRpcResult: <T,>(data: unknown) => { if (data == null) throw new Error('no response'); return data as T; },
}));

import { previewSetupWeights, weightRowsToRpcRows } from './productSetupChemistry';
import type { WeightWorkbookRow } from './productSetupChemistryWorkbook';

const displayRow: WeightWorkbookRow = {
  kind: 'density', subject_id: 'parent-a', name: 'Display name only', expected_version: 7,
  value: 8.375, unit: 'lb_per_gal', source: 'measured', source_note: 'Scale reading 10/20', reason: 'Correction', evidence: 'Scale ticket 4',
};
const expectedRpcRow = {
  kind: 'density', subject_id: 'parent-a', expected_version: 7, value: 8.375, unit: 'lb_per_gal',
  source: 'measured', source_note: 'Scale reading 10/20', reason: 'Correction', evidence: 'Scale ticket 4',
};

describe('weight preview RPC wire shape', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: { rows: [] }, error: null });
  });

  it('projects a display-bound row to the same exact nine fields accepted by DM-1b SQL', async () => {
    const projected = weightRowsToRpcRows([displayRow]);
    expect(projected).toEqual([expectedRpcRow]);
    expect(Object.keys(projected[0])).toEqual([
      'kind', 'subject_id', 'expected_version', 'value', 'unit', 'source', 'source_note', 'reason', 'evidence',
    ]);
    expect(projected[0]).not.toHaveProperty('name');

    await previewSetupWeights([displayRow]);

    expect(rpc).toHaveBeenCalledWith('preview_weights_tab', { p_rows: [expectedRpcRow] });
  });
});
