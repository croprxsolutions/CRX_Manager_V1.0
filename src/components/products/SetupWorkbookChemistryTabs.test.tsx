import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  pendingSaves: vi.fn(), startChemistrySave: vi.fn(), finishChemistrySave: vi.fn(),
  loadOpenChemistryProposals: vi.fn(), previewSetupIngredients: vi.fn(), previewSetupWeights: vi.fn(), toast: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: vi.fn() }) }));
vi.mock('../../lib/db', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/db')>()),
  supabaseUntyped: { rpc: vi.fn() },
}));
vi.mock('../../lib/productChemistry', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/productChemistry')>()),
  pendingSaves: H.pendingSaves,
  startChemistrySave: H.startChemistrySave,
  finishChemistrySave: H.finishChemistrySave,
}));
vi.mock('../../lib/productSetupChemistry', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/productSetupChemistry')>()),
  loadOpenChemistryProposals: H.loadOpenChemistryProposals,
  previewSetupIngredients: H.previewSetupIngredients,
  previewSetupWeights: H.previewSetupWeights,
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import SetupWorkbookChemistryTabs from './SetupWorkbookChemistryTabs';
import { ChemistrySaveUncertain } from '../../lib/productChemistry';
import type { ParsedChemistryWorkbook } from '../../lib/productSetupChemistryWorkbook';
import { weightRowsToRpcRows, type ChemistryProposalView, type WeightPreview } from '../../lib/productSetupChemistry';

const parsed: ParsedChemistryWorkbook = {
  weightRows: [{ kind: 'density', subject_id: 'parent-a', name: 'Parent A', expected_version: 1, value: 8.5,
    unit: 'lb_per_gal', source: 'label', source_note: 'Label page 1', reason: null, evidence: null }],
  ingredientRows: [], issues: [], openProposalParentIds: [],
};
const parsedWithIngredient: ParsedChemistryWorkbook = {
  ...parsed,
  ingredientRows: [{ parent_id: 'parent-a', expected_chemistry_version: 2, row_id: null, name: 'Active B', cas: '1071-83-6',
    strength_value: 25, strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'label', source_note: 'Label section 4' }],
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// Confirm buttons render disabled until their preview loads; a click before then is silently ignored (#1984).
async function clickWhenEnabled(name: string) {
  await waitFor(() => expect(screen.getByRole('button', { name })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('SetupWorkbookChemistryTabs', () => {
  beforeEach(() => {
    // Reset, not clear: an unused mockReturnValueOnce from a failed test must not leak into the next one.
    vi.resetAllMocks();
    H.pendingSaves.mockReturnValue([]);
    H.loadOpenChemistryProposals.mockResolvedValue([]);
    H.previewSetupIngredients.mockResolvedValue({ parents: [] });
    H.previewSetupWeights.mockResolvedValue({ rows: [{ kind: 'density', subject_id: 'parent-a', name: 'Parent A',
      expected_version: 1, status: 'change', before: { value: '8', source: 'label', source_note: null },
      after: { value: '8.5', source: 'label', source_note: 'Label page 1' } }] });
  });

  it('keeps an expired local retry and blocks every new workbook chemistry write', async () => {
    H.pendingSaves.mockReturnValue([{ key: 'old-key', userId: 'admin', scope: 'setup-workbook-chemistry',
      rpc: 'commit_ingredients_tab', args: { p_rows: [] }, label: 'Save Ingredients tab', createdAt: Date.now() - 24 * 60 * 60 * 1000 }]);
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={1} parsed={parsed} onSaved={vi.fn()} />);
    expect(await screen.findByText(/too old to retry safely/i)).toBeInTheDocument();
    const confirm = await screen.findByRole('button', { name: 'Confirm Weights tab' });
    expect(confirm).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Finish save' })).not.toBeInTheDocument();
    expect(H.finishChemistrySave).not.toHaveBeenCalled();
    expect(H.startChemistrySave).not.toHaveBeenCalled();
  });

  it('does not publish a slow preview after a different workbook replaces it', async () => {
    const first = deferred<WeightPreview>();
    const second = deferred<WeightPreview>();
    H.previewSetupWeights.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={1} parsed={parsed} onSaved={vi.fn()} />);
    view.rerender(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={2} parsed={parsed} onSaved={vi.fn()} />);
    await act(async () => {
      first.resolve({ rows: [{ kind: 'density', subject_id: 'parent-a', name: 'OLD PREVIEW', expected_version: 1, status: 'change',
        before: { value: '8', source: 'label', source_note: null }, after: { value: '8.5', source: 'label', source_note: 'old' } }] });
      second.resolve({ rows: [{ kind: 'density', subject_id: 'parent-a', name: 'CURRENT PREVIEW', expected_version: 1, status: 'change',
        before: { value: '8', source: 'label', source_note: null }, after: { value: '8.5', source: 'label', source_note: 'current' } }] });
    });
    await waitFor(() => expect(screen.getByText(/CURRENT PREVIEW/)).toBeInTheDocument());
    expect(screen.queryByText(/OLD PREVIEW/)).not.toBeInTheDocument();
  });

  it('keeps the successful tab preview and lets it retry when the other preview fails', async () => {
    H.previewSetupWeights.mockRejectedValueOnce(new Error('weight preview offline'));
    H.previewSetupIngredients.mockResolvedValue({ parents: [{ parent_id: 'parent-a', parent_name: 'Parent A',
      chemistry_version: 2, status: 'proposal', items: [] }] });
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={3} parsed={parsedWithIngredient} onSaved={vi.fn()} />);
    expect(await screen.findByText('Weights preview needs attention: weight preview offline')).toBeInTheDocument();
    expect(screen.getByText('Parent A: 0 changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Ingredients tab' })).toBeEnabled();
    H.previewSetupWeights.mockResolvedValue({ rows: [{ kind: 'density', subject_id: 'parent-a', name: 'Parent A',
      expected_version: 1, status: 'change', before: { value: '8', source: 'label', source_note: null },
      after: { value: '8.5', source: 'label', source_note: 'Label page 1' } }] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry Weights preview' }));
    expect(await screen.findByText(/Parent A: 8 lb\/gal/)).toBeInTheDocument();
  });

  it('keeps the Ingredients preview confirmable after a Weight draft save', async () => {
    H.previewSetupIngredients.mockResolvedValue({ parents: [{ parent_id: 'parent-a', parent_name: 'Parent A',
      chemistry_version: 2, status: 'proposal', items: [] }] });
    H.startChemistrySave.mockResolvedValue({});
    const onSaved = vi.fn();
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={4} parsed={parsedWithIngredient} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm Weights tab' })).toBeEnabled());
    expect(screen.getByLabelText('Weights tab preview').textContent).toContain('8 lb/gal · label → 8.5 lb/gal · label: Label page 1');
    expect(screen.getByText(/New reason: not provided · Evidence: not provided/)).toBeInTheDocument();
    expect(screen.getByText(/Parent A · Add: Active B \(CAS 1071-83-6\) · 25 pct_ww active_ingredient · label: Label section 4/)).toBeInTheDocument();
    await clickWhenEnabled('Confirm Weights tab');
    expect(await screen.findByText('Weight drafts saved. The approved weights did not change.')).toBeInTheDocument();
    expect(H.startChemistrySave.mock.calls[0][3]).toEqual({ p_rows: [{
      kind: 'density', subject_id: 'parent-a', expected_version: 1, value: 8.5, unit: 'lb_per_gal',
      source: 'label', source_note: 'Label page 1', reason: null, evidence: null,
    }] });
    const ingredientConfirm = screen.getByRole('button', { name: 'Confirm Ingredients tab' });
    expect(ingredientConfirm).toBeEnabled();
    fireEvent.click(ingredientConfirm);
    expect(await screen.findByText('Ingredient proposal saved. It still needs a separate review and Apply decision.')).toBeInTheDocument();
    expect(H.startChemistrySave).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  it('warns about provisional no-CAS ingredients without blocking proposal creation or applying automatically', async () => {
    const ingredient = { ...parsedWithIngredient.ingredientRows[0], cas: null, strength_value: null };
    H.previewSetupIngredients.mockResolvedValue({ parents: [{ parent_id: 'parent-a', parent_name: 'Parent A',
      chemistry_version: 2, status: 'proposal', items: [] }] });
    H.startChemistrySave.mockImplementation(async (_user, _scope, rpc) => {
      if (rpc === 'commit_ingredients_tab') H.loadOpenChemistryProposals.mockResolvedValue([{
        id: 'proposal-no-cas', parent_id: 'parent-a', parent_name: 'Parent A', has_delete: false,
        base_chemistry_version: 2, proposal_version: 1, status: 'proposed', created_by: 'admin',
        created_at: new Date().toISOString(), unresolved: false,
        items: [
          { ...ingredient, kind: 'ingredient', action: 'add', display_name: 'Active B', unresolved: false },
          { kind: 'ingredient', action: 'retire', row_id: 'existing', display_name: 'Existing Active', cas: '1071-83-6',
            strength_value: null, strength_unit: 'pct_ww', strength_basis: 'active_ingredient', unresolved: false },
        ],
      }]);
      return {};
    });
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={4} parsed={{
      ...parsed, ingredientRows: [ingredient],
    }} onSaved={vi.fn()} />);
    expect(await screen.findByText(/Applying a new ingredient without a CAS creates a provisional shared ingredient/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm Ingredients tab' });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(H.startChemistrySave).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(await screen.findByText(/Applying creates a new provisional shared ingredient/)).toBeInTheDocument();
    expect(screen.getByText(/Add Active B.*strength unknown · pct_ww · active_ingredient/)).toBeInTheDocument();
    expect(screen.getByText(/Remove Existing Active/)).not.toHaveTextContent('strength unknown');
    expect(H.startChemistrySave).toHaveBeenCalledOnce();
    expect(H.startChemistrySave).toHaveBeenCalledWith('admin', 'setup-workbook-chemistry', 'commit_ingredients_tab',
      { p_rows: [ingredient] }, 'Save Ingredients tab');
  });

  it.each([true, false])('marks a finished ingredient retry complete only when its saved rows match the current workbook (%s)', async (sameWorkbook) => {
    const ingredient = parsedWithIngredient.ingredientRows[0];
    const pending = { key: 'ingredient-retry', userId: 'admin', scope: 'setup-workbook-chemistry', rpc: 'commit_ingredients_tab' as const,
      args: { p_rows: [ingredient] }, label: 'Save Ingredients tab', createdAt: Date.now() };
    H.previewSetupIngredients.mockResolvedValue({ parents: [{ parent_id: 'parent-a', parent_name: 'Parent A',
      chemistry_version: 2, status: 'proposal', items: [] }] });
    H.startChemistrySave.mockImplementationOnce(async () => {
      H.pendingSaves.mockReturnValue([pending]);
      throw new ChemistrySaveUncertain('reply lost');
    });
    H.finishChemistrySave.mockImplementationOnce(async () => { H.pendingSaves.mockReturnValue([]); });
    const view = render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={parsedWithIngredient} onSaved={vi.fn()} />);
    await clickWhenEnabled('Confirm Ingredients tab');
    expect(await screen.findByRole('button', { name: 'Finish save' })).toBeInTheDocument();
    if (!sameWorkbook) {
      view.rerender(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={9} parsed={{
        ...parsedWithIngredient, ingredientRows: [{ ...ingredient, name: 'Replacement workbook ingredient' }],
      }} onSaved={vi.fn()} />);
      await waitFor(() => expect(H.previewSetupIngredients).toHaveBeenCalledTimes(2));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Finish save' }));
    await waitFor(() => expect(H.finishChemistrySave).toHaveBeenCalledWith(pending));
    if (sameWorkbook) {
      expect(await screen.findByText('Ingredient proposal saved. It still needs a separate review and Apply decision.')).toBeInTheDocument();
    } else {
      expect(screen.queryByText('Ingredient proposal saved. It still needs a separate review and Apply decision.')).not.toBeInTheDocument();
    }
  });

  it.each([
    ['weights', 'WORKBOOK_WEIGHTS_REFUSED'],
    ['ingredients', 'WORKBOOK_INGREDIENTS_REFUSED'],
  ] as const)('requires a fresh %s preview after a definitive server refusal', async (kind, code) => {
    const workbook = kind === 'ingredients' ? parsedWithIngredient : parsed;
    H.previewSetupIngredients.mockResolvedValue({ parents: [{ parent_id: 'parent-a', parent_name: 'Parent A',
      chemistry_version: 2, status: 'proposal', items: [] }] });
    H.startChemistrySave.mockRejectedValueOnce({ code: 'P0001', message: `${code}: nothing was saved. Synthetic refusal` });
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={workbook} onSaved={vi.fn()} />);
    const confirmName = kind === 'weights' ? 'Confirm Weights tab' : 'Confirm Ingredients tab';
    await clickWhenEnabled(confirmName);
    const retryName = kind === 'weights' ? 'Retry Weights preview' : 'Retry Ingredients preview';
    expect(await screen.findByRole('button', { name: retryName })).toBeInTheDocument();
    expect(screen.getByText(/preview needs attention: Nothing was saved\. Synthetic refusal/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: confirmName })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: retryName }));
    const previewCall = kind === 'weights' ? H.previewSetupWeights : H.previewSetupIngredients;
    await waitFor(() => expect(previewCall).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: confirmName })).toBeEnabled());
    expect(H.startChemistrySave).toHaveBeenCalledOnce();
  });

  it('keeps Weights confirmation disabled until a retry preview finishes', async () => {
    const refreshed = deferred<WeightPreview>();
    H.previewSetupWeights.mockRejectedValueOnce(new Error('first preview offline')).mockReturnValueOnce(refreshed.promise);
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={parsed} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry Weights preview' }));
    expect(screen.getByRole('button', { name: 'Confirm Weights tab' })).toBeDisabled();
    await act(async () => {
      refreshed.resolve({ rows: [{ kind: 'density', subject_id: 'parent-a', name: 'Parent A', expected_version: 1, status: 'change' }] });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm Weights tab' })).toBeEnabled());
  });

  it('refreshes a replacement workbook when the old in-flight save settles without leaking callbacks', async () => {
    const oldAttempt = deferred<void>();
    const oldPending = { key: 'old-key', userId: 'admin', scope: 'setup-workbook-chemistry', rpc: 'commit_weights_tab' as const,
      args: { p_rows: [] }, label: 'Save Weights tab', createdAt: Date.now() };
    H.startChemistrySave.mockImplementationOnce(() => {
      H.pendingSaves.mockReturnValue([oldPending]);
      return oldAttempt.promise.then(() => { H.pendingSaves.mockReturnValue([]); });
    }).mockResolvedValueOnce({});
    H.previewSetupWeights.mockImplementation((rows: ParsedChemistryWorkbook['weightRows']) => Promise.resolve({ rows: rows.map((row) => ({
      kind: row.kind, subject_id: row.subject_id, name: row.name, expected_version: row.expected_version, status: 'change' as const,
      before: { value: '8', source: 'label', source_note: null }, after: { value: String(row.value), source: row.source, source_note: row.source_note },
    })) }));
    const oldSaved = vi.fn();
    const newSaved = vi.fn();
    const view = render(<SetupWorkbookChemistryTabs key="admin:5" open profileId="admin" fileGeneration={5} parsed={parsed} onSaved={oldSaved} />);
    await clickWhenEnabled('Confirm Weights tab');
    await waitFor(() => expect(H.startChemistrySave).toHaveBeenCalledTimes(1));
    view.rerender(<SetupWorkbookChemistryTabs key="admin:6" open profileId="admin" fileGeneration={6} parsed={{
      ...parsed, weightRows: [{ ...parsed.weightRows[0], subject_id: 'parent-b', name: 'Parent B' }],
    }} onSaved={newSaved} />);
    expect(await screen.findByText(/Finish the Save Weights tab/)).toBeInTheDocument();
    await act(async () => { oldAttempt.resolve(); });
    expect(oldSaved).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm Weights tab' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Weights tab' }));
    await waitFor(() => expect(H.startChemistrySave).toHaveBeenCalledTimes(2));
    expect(H.startChemistrySave.mock.calls[1][2]).toBe('commit_weights_tab');
    expect(H.startChemistrySave.mock.calls[1][3]).toEqual({ p_rows: [expect.objectContaining({ subject_id: 'parent-b' })] });
    expect(newSaved).toHaveBeenCalledTimes(1);
  });

  it('does not block a new actor on another actor’s pending workbook save', async () => {
    const oldPending = { key: 'admin1-key', userId: 'admin1', scope: 'setup-workbook-chemistry', rpc: 'commit_weights_tab' as const,
      args: { p_rows: [] }, label: 'Save Weights tab', createdAt: Date.now() };
    H.pendingSaves.mockImplementation((userId: string) => userId === 'admin1' ? [oldPending] : []);
    H.startChemistrySave.mockResolvedValue({});
    const view = render(<SetupWorkbookChemistryTabs key="admin1:7" open profileId="admin1" fileGeneration={7} parsed={parsed} onSaved={vi.fn()} />);
    expect(await screen.findByText(/Finish the Save Weights tab/)).toBeInTheDocument();
    view.rerender(<SetupWorkbookChemistryTabs key="admin2:7" open profileId="admin2" fileGeneration={7} parsed={parsed} onSaved={vi.fn()} />);
    await clickWhenEnabled('Confirm Weights tab');
    await waitFor(() => expect(H.startChemistrySave).toHaveBeenCalledWith('admin2', 'setup-workbook-chemistry', 'commit_weights_tab', expect.any(Object), 'Save Weights tab'));
  });

  it('keeps an uncertain old actor save scoped while a new actor saves independently', async () => {
    const oldAttempt = deferred<void>();
    const oldPending = { key: 'admin1-key', userId: 'admin1', scope: 'setup-workbook-chemistry', rpc: 'commit_weights_tab' as const,
      args: { p_rows: [] }, label: 'Save Weights tab', createdAt: Date.now() };
    let queueExists = false;
    H.pendingSaves.mockImplementation((userId: string) => userId === 'admin1' && queueExists ? [oldPending] : []);
    H.startChemistrySave.mockImplementationOnce(() => { queueExists = true; return oldAttempt.promise; }).mockResolvedValueOnce({});
    const oldSaved = vi.fn();
    const newSaved = vi.fn();
    const view = render(<SetupWorkbookChemistryTabs key="admin1:9" open profileId="admin1" fileGeneration={9} parsed={parsed} onSaved={oldSaved} />);
    await clickWhenEnabled('Confirm Weights tab');
    await waitFor(() => expect(H.startChemistrySave).toHaveBeenCalledTimes(1));
    view.rerender(<SetupWorkbookChemistryTabs key="admin2:9" open profileId="admin2" fileGeneration={9} parsed={parsed} onSaved={newSaved} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm Weights tab' })).toBeEnabled());
    const newConfirm = screen.getByRole('button', { name: 'Confirm Weights tab' });
    await act(async () => { oldAttempt.reject(new Error('network outcome uncertain')); });
    expect(oldSaved).not.toHaveBeenCalled();
    expect(newConfirm).toBeEnabled();
    fireEvent.click(newConfirm);
    await waitFor(() => expect(H.startChemistrySave).toHaveBeenCalledTimes(2));
    expect(H.startChemistrySave.mock.calls[1][0]).toBe('admin2');
    expect(newSaved).toHaveBeenCalledTimes(1);
  });

  it('keeps a refreshed proposal list when the initial read resolves late', async () => {
    const initial = deferred<ChemistryProposalView[]>();
    const proposal: ChemistryProposalView = { id: 'new-proposal', parent_id: 'parent-a', parent_name: 'Parent A', items: [],
      has_delete: false, base_chemistry_version: 2, proposal_version: 1, status: 'proposed', created_by: 'admin',
      created_at: new Date().toISOString(), unresolved: false };
    H.loadOpenChemistryProposals.mockReturnValueOnce(initial.promise).mockResolvedValueOnce([proposal]);
    H.startChemistrySave.mockResolvedValue({});
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={parsed} onSaved={vi.fn()} />);
    await clickWhenEnabled('Confirm Weights tab');
    expect(await screen.findByText('Open ingredient proposals (1)')).toBeInTheDocument();
    await act(async () => { initial.resolve([]); });
    expect(screen.getByText('Open ingredient proposals (1)')).toBeInTheDocument();
  });

  it.each(['save', 'finish'] as const)('does not show the old actor %s success toast after proposal refresh resolves late', async (action) => {
    const refreshed = deferred<ChemistryProposalView[]>();
    H.loadOpenChemistryProposals.mockResolvedValueOnce([]).mockReturnValueOnce(refreshed.promise).mockResolvedValue([]);
    const record = { key: `late-${action}`, userId: 'admin1', scope: 'setup-workbook-chemistry', rpc: 'commit_weights_tab' as const,
      args: { p_rows: weightRowsToRpcRows(parsed.weightRows) }, label: 'Save Weights tab', createdAt: Date.now() };
    H.pendingSaves.mockReturnValue(action === 'finish' ? [record] : []);
    H.startChemistrySave.mockResolvedValue({});
    H.finishChemistrySave.mockResolvedValue({});
    const view = render(<SetupWorkbookChemistryTabs open profileId="admin1" fileGeneration={13}
      parsed={action === 'save' ? parsed : null} onSaved={vi.fn()} />);

    await clickWhenEnabled(action === 'save' ? 'Confirm Weights tab' : 'Finish save');
    await waitFor(() => expect(H.loadOpenChemistryProposals).toHaveBeenCalledTimes(2));
    view.rerender(<SetupWorkbookChemistryTabs open profileId="admin2" fileGeneration={13}
      parsed={action === 'save' ? parsed : null} onSaved={vi.fn()} />);
    await act(async () => { refreshed.resolve([]); });

    expect(H.toast).not.toHaveBeenCalledWith('success', 'Weight drafts saved.');
    expect(H.toast).not.toHaveBeenCalledWith('success', 'The pending workbook save finished.');
  });

  it('retries a failed proposal list without uploading the workbook again', async () => {
    H.loadOpenChemistryProposals.mockRejectedValueOnce(new Error('proposal offline')).mockResolvedValueOnce([]);
    H.previewSetupIngredients.mockResolvedValue({ parents: [{ parent_id: 'parent-a', parent_name: 'Parent A',
      chemistry_version: 2, status: 'proposal', items: [] }] });
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={parsedWithIngredient} onSaved={vi.fn()} />);
    expect(await screen.findByText('Proposals could not be loaded: proposal offline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Ingredients tab' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry proposals' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm Ingredients tab' })).toBeEnabled());
    expect(H.loadOpenChemistryProposals).toHaveBeenCalledTimes(2);
    expect(H.previewSetupIngredients).toHaveBeenCalledOnce();
    expect(H.startChemistrySave).not.toHaveBeenCalled();
  });

  it('keeps Ingredients disabled until the initial open-proposal read resolves', async () => {
    const initialRead = deferred<ChemistryProposalView[]>();
    const proposal: ChemistryProposalView = { id: 'existing-proposal', parent_id: 'parent-a', parent_name: 'Parent A', items: [],
      has_delete: false, base_chemistry_version: 2, proposal_version: 1, status: 'proposed', created_by: 'admin',
      created_at: new Date().toISOString(), unresolved: false };
    H.loadOpenChemistryProposals.mockReturnValueOnce(initialRead.promise);
    H.previewSetupIngredients.mockResolvedValue({ parents: [{ parent_id: 'parent-a', parent_name: 'Parent A',
      chemistry_version: 2, status: 'proposal', items: [] }] });
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={parsedWithIngredient} onSaved={vi.fn()} />);
    expect(await screen.findByText('Checking open proposals…')).toBeInTheDocument();
    const confirm = await screen.findByRole('button', { name: 'Confirm Ingredients tab' });
    expect(confirm).toBeDisabled();
    await act(async () => { initialRead.resolve([proposal]); });
    expect(await screen.findByText(/One or more parents already have an open proposal/)).toBeInTheDocument();
    expect(confirm).toBeEnabled();
  });

  it('keeps the latest concurrent proposal retry result when an older retry resolves last', async () => {
    const olderRetry = deferred<ChemistryProposalView[]>();
    const newest: ChemistryProposalView = { id: 'newest-proposal', parent_id: 'parent-a', parent_name: 'Parent A', items: [],
      has_delete: false, base_chemistry_version: 2, proposal_version: 2, status: 'proposed', created_by: 'admin',
      created_at: new Date().toISOString(), unresolved: false };
    H.loadOpenChemistryProposals.mockRejectedValueOnce(new Error('initial proposal read offline'))
      .mockReturnValueOnce(olderRetry.promise).mockResolvedValueOnce([newest]);
    H.previewSetupIngredients.mockResolvedValue({ parents: [{ parent_id: 'parent-a', parent_name: 'Parent A',
      chemistry_version: 2, status: 'proposal', items: [] }] });
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={parsedWithIngredient} onSaved={vi.fn()} />);
    expect(await screen.findByText('Proposals could not be loaded: initial proposal read offline')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry proposals' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry proposals' }));
    expect(await screen.findByText('Parent A · version 2')).toBeInTheDocument();
    await act(async () => { olderRetry.resolve([]); });
    expect(screen.getByText('Parent A · version 2')).toBeInTheDocument();
    expect(screen.queryByText('No open proposals.')).not.toBeInTheDocument();
  });

  it('does not claim one open proposal makes another proposal stale', async () => {
    const proposal: ChemistryProposalView = { id: 'proposal-a', parent_id: 'parent-a', parent_name: 'Parent A', items: [],
      has_delete: false, base_chemistry_version: 2, proposal_version: 1, status: 'proposed', created_by: 'admin', created_at: new Date().toISOString(), unresolved: false };
    H.loadOpenChemistryProposals.mockResolvedValue([proposal]);
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={null} onSaved={vi.fn()} />);
    expect(await screen.findByText('Open ingredient proposals (1)')).toBeInTheDocument();
    expect(screen.queryByText(/Several open proposals exist/)).not.toBeInTheDocument();
  });

  it('requires explicit confirmation before an apply with removal is sent', async () => {
    const proposal: ChemistryProposalView = { id: 'delete-proposal', parent_id: 'parent-a', parent_name: 'Parent A', items: [],
      has_delete: true, base_chemistry_version: 2, proposal_version: 3, status: 'proposed', created_by: 'admin', created_at: new Date().toISOString(), unresolved: false };
    H.loadOpenChemistryProposals.mockResolvedValue([proposal]);
    H.startChemistrySave.mockResolvedValue({});
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={null} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply with removal…' }));
    expect(H.startChemistrySave).not.toHaveBeenCalled();
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply with removal' }));
    await waitFor(() => expect(H.startChemistrySave).toHaveBeenCalledWith('admin', 'setup-workbook-chemistry',
      'promote_chemistry_proposal', { p_proposal_id: proposal.id, p_expected_proposal_version: 3, p_decision: 'apply_delete' }, expect.any(String)));
  });

  it('closes removal confirmation after an uncertain decision and points to Finish save above', async () => {
    const proposal: ChemistryProposalView = { id: 'uncertain-delete', parent_id: 'parent-a', parent_name: 'Parent A', items: [],
      has_delete: true, base_chemistry_version: 2, proposal_version: 3, status: 'proposed', created_by: 'admin', created_at: new Date().toISOString(), unresolved: false };
    const pending = { key: 'uncertain-delete-key', userId: 'admin', scope: 'setup-workbook-chemistry', rpc: 'promote_chemistry_proposal' as const,
      args: { p_proposal_id: proposal.id, p_expected_proposal_version: 3, p_decision: 'apply_delete' }, label: 'Apply proposal for Parent A', createdAt: Date.now() };
    H.loadOpenChemistryProposals.mockResolvedValue([proposal]);
    H.startChemistrySave.mockImplementationOnce(async () => { H.pendingSaves.mockReturnValue([pending]); throw new ChemistrySaveUncertain('uncertain'); });
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={null} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply with removal…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply with removal' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringMatching(/Use Finish save above to retry it/)));
    expect(screen.getByRole('button', { name: 'Finish save' })).toBeInTheDocument();
  });

  it('closes removal confirmation after a definitive server refusal', async () => {
    const proposal: ChemistryProposalView = { id: 'refused-delete', parent_id: 'parent-a', parent_name: 'Parent A', items: [],
      has_delete: true, base_chemistry_version: 2, proposal_version: 3, status: 'proposed', created_by: 'admin', created_at: new Date().toISOString(), unresolved: false };
    H.loadOpenChemistryProposals.mockResolvedValue([proposal]);
    H.startChemistrySave.mockRejectedValueOnce(new Error('proposal changed'));
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={null} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply with removal…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply with removal' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'proposal changed'));
  });

  it('replaces the server rename workaround with a fresh-download instruction', async () => {
    H.previewSetupIngredients.mockResolvedValue({ parents: [{ parent_id: 'parent-a', parent_name: 'Parent A', chemistry_version: 2,
      status: 'refused', problem: 'ACTIVE_INGREDIENT_RENAMED: Active A cannot be renamed here; mark the row __delete and add the new ingredient as a new row' }] });
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={parsedWithIngredient} onSaved={vi.fn()} />);
    expect((await screen.findAllByText(/Active A does not match the current shared ingredient identity\. Download a fresh workbook and review it/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/mark the row __delete and add the new ingredient/)).not.toBeInTheDocument();
  });

  it('replaces stale rename advice when the ingredient commit is refused', async () => {
    H.previewSetupIngredients.mockResolvedValue({ parents: [{ parent_id: 'parent-a', parent_name: 'Parent A', chemistry_version: 2,
      status: 'proposal', items: [] }] });
    H.startChemistrySave.mockRejectedValueOnce({ code: 'P0001', message: 'WORKBOOK_INGREDIENTS_REFUSED: nothing was saved. Parent A: WORKBOOK_ROW_INVALID: Active A cannot be renamed here; mark the row __delete and add the new ingredient as a new row; Parent B: WORKBOOK_ROW_INVALID: Active B cannot be renamed here; mark the row __delete and add the new ingredient as a new row; Parent C: WORKBOOK_SOURCE_REQUIRED: X needs its source document' });
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={parsedWithIngredient} onSaved={vi.fn()} />);
    await clickWhenEnabled('Confirm Ingredients tab');
    expect((await screen.findAllByText(/Active A does not match the current shared ingredient identity\. Download a fresh workbook and review it/)).length).toBeGreaterThan(0);
    expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('Download a fresh workbook and review it'));
    expect(screen.queryByText(/mark the row __delete and add the new ingredient/)).not.toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('Active B does not match the current shared ingredient identity'));
    expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('Parent C: WORKBOOK_SOURCE_REQUIRED: X needs its source document'));
    expect(screen.getByRole('button', { name: 'Confirm Ingredients tab' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry Ingredients preview' })).toBeInTheDocument();
  });

  it('disables decisions for unresolved names and warns when multiple proposals share a parent', async () => {
    const proposals: ChemistryProposalView[] = ['p1', 'p2'].map((id) => ({ id, parent_id: 'parent-a', parent_name: 'Parent A', items: [],
      has_delete: false, base_chemistry_version: 2, proposal_version: 1, status: 'proposed', created_by: 'admin', created_at: new Date().toISOString(), unresolved: true }));
    H.loadOpenChemistryProposals.mockResolvedValue(proposals);
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={null} onSaved={vi.fn()} />);
    expect(await screen.findAllByText(/Several open proposals exist for this parent/)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Apply proposal' }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Reject proposal' }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getAllByText(/current parent or ingredient name could not be resolved/)).toHaveLength(2);
    expect(H.startChemistrySave).not.toHaveBeenCalled();
  });

  it.each([
    ['weights', parsed, 'commit_weights_tab', 'WORKBOOK_WEIGHTS_REFUSED'],
    ['ingredients', parsedWithIngredient, 'commit_ingredients_tab', 'WORKBOOK_INGREDIENTS_REFUSED'],
  ] as const)('re-previews the current %s tab after Finish gets a definitive refusal', async (kind, workbook, rpc, code) => {
    if (kind === 'ingredients') H.previewSetupIngredients.mockResolvedValue({ parents: [{ parent_id: 'parent-a', parent_name: 'Parent A',
      chemistry_version: 2, status: 'proposal', items: [] }] });
    const rows = kind === 'weights' ? weightRowsToRpcRows(workbook.weightRows) : workbook.ingredientRows;
    const pending = { key: `${kind}-finish`, userId: 'admin', scope: 'setup-workbook-chemistry', rpc,
      args: { p_rows: rows }, label: `Save ${kind === 'weights' ? 'Weights' : 'Ingredients'} tab`, createdAt: Date.now() };
    H.pendingSaves.mockReturnValue([pending]);
    H.finishChemistrySave.mockImplementationOnce(async () => {
      H.pendingSaves.mockReturnValue([]);
      throw { code: 'P0001', message: `${code}: nothing was saved. Synthetic refusal` };
    });
    const previewCall = kind === 'weights' ? H.previewSetupWeights : H.previewSetupIngredients;
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={workbook} onSaved={vi.fn()} />);
    // Finish matches the refusal to a tab only once that tab's preview has loaded.
    await screen.findByText(kind === 'weights' ? 'Weights tab: 1 changes' : 'Ingredients tab: 1 parent proposals');
    fireEvent.click(await screen.findByRole('button', { name: 'Finish save' }));
    const retryName = kind === 'weights' ? 'Retry Weights preview' : 'Retry Ingredients preview';
    expect(await screen.findByRole('button', { name: retryName })).toBeInTheDocument();
    const confirmName = kind === 'weights' ? 'Confirm Weights tab' : 'Confirm Ingredients tab';
    expect(screen.getByRole('button', { name: confirmName })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: retryName }));
    await waitFor(() => expect(previewCall).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: confirmName })).toBeEnabled());
  });

  it('refreshes proposals after Finish reports that another admin already decided', async () => {
    const proposal: ChemistryProposalView = { id: 'decided-elsewhere', parent_id: 'parent-a', parent_name: 'Parent A', items: [],
      has_delete: false, base_chemistry_version: 2, proposal_version: 1, status: 'proposed', created_by: 'admin',
      created_at: new Date().toISOString(), unresolved: false };
    const pending = { key: 'proposal-finish', userId: 'admin', scope: 'setup-workbook-chemistry', rpc: 'promote_chemistry_proposal' as const,
      args: { p_proposal_id: proposal.id, p_expected_proposal_version: 1, p_decision: 'apply' }, label: 'Apply proposal for Parent A', createdAt: Date.now() };
    let hasPending = true;
    H.pendingSaves.mockImplementation(() => hasPending ? [pending] : []);
    H.loadOpenChemistryProposals.mockResolvedValueOnce([proposal]).mockResolvedValueOnce([]);
    H.finishChemistrySave.mockImplementationOnce(async () => {
      hasPending = false;
      throw { code: 'P0001', message: 'PROPOSAL_ALREADY_DECIDED: another admin decided this proposal' };
    });
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={10} parsed={null} onSaved={vi.fn()} />);
    expect(await screen.findByText('Parent A · version 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish save' }));
    expect(await screen.findByText('No open proposals.')).toBeInTheDocument();
    expect(H.loadOpenChemistryProposals).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Parent A · version 1')).not.toBeInTheDocument();
  });

  it('shows sign-in or admin guidance after a fresh workbook auth refusal without leaving a retry record', async () => {
    H.previewSetupIngredients.mockResolvedValue({ parents: [{ parent_id: 'parent-a', parent_name: 'Parent A', chemistry_version: 2,
      status: 'proposal', items: [] }] });
    H.startChemistrySave.mockRejectedValueOnce({ code: 'PGRST303', message: 'JWT claims validation failed' });
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={11} parsed={parsedWithIngredient} onSaved={vi.fn()} />);
    await clickWhenEnabled('Confirm Ingredients tab');
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringMatching(/Sign in again or check administrator access/)));
    expect(screen.queryByRole('button', { name: 'Finish save' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Ingredients tab' })).toBeEnabled();
  });

  it('shows auth guidance and keeps Finish for a possibly committed workbook intent', async () => {
    const pending = { key: 'auth-finish', userId: 'admin', scope: 'setup-workbook-chemistry', rpc: 'commit_ingredients_tab' as const,
      args: { p_rows: parsedWithIngredient.ingredientRows }, label: 'Save Ingredients tab', createdAt: Date.now() };
    H.pendingSaves.mockReturnValue([pending]);
    H.finishChemistrySave.mockRejectedValueOnce(new ChemistrySaveUncertain({ code: 'PGRST302', message: 'missing bearer token' }, true));
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={12} parsed={null} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Finish save' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringMatching(/Sign in again.*Finish save to retry the same request/)));
    expect(screen.getByRole('button', { name: 'Finish save' })).toBeInTheDocument();
  });

  const differentIngredientWorkbook: ParsedChemistryWorkbook = { ...parsedWithIngredient,
    ingredientRows: [{ ...parsedWithIngredient.ingredientRows[0], name: 'Different ingredient' }] };
  it.each<[string, ParsedChemistryWorkbook | null]>([
    ['without the original workbook', null],
    ['with a different workbook', differentIngredientWorkbook],
  ])('rewrites rename advice from a saved Ingredients request %s and retains other refusal details', async (_scenario, workbook) => {
    const originalRows = parsedWithIngredient.ingredientRows;
    const pending = { key: 'ingredient-rename-retry', userId: 'admin', scope: 'setup-workbook-chemistry', rpc: 'commit_ingredients_tab' as const,
      args: { p_rows: originalRows }, label: 'Save Ingredients tab', createdAt: Date.now() };
    const aggregate = 'nothing was saved. Parent A: WORKBOOK_ROW_INVALID: Active A cannot be renamed here; mark the row __delete and add the new ingredient as a new row; Parent B: WORKBOOK_ROW_INVALID: Active B cannot be renamed here; mark the row __delete and add the new ingredient as a new row; Parent C: WORKBOOK_SOURCE_REQUIRED: X needs its source document';
    H.pendingSaves.mockReturnValue([pending]);
    H.previewSetupIngredients.mockResolvedValue({ parents: [{ parent_id: 'parent-a', parent_name: 'Parent A', chemistry_version: 2,
      status: 'proposal', items: [] }] });
    H.finishChemistrySave.mockRejectedValueOnce({ code: 'P0001', message: `WORKBOOK_INGREDIENTS_REFUSED: ${aggregate}` });
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={9} parsed={workbook} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Finish save' }));
    const toast = await waitFor(() => {
      const call = H.toast.mock.calls.find(([kind]) => kind === 'error');
      expect(call).toBeDefined();
      return call?.[1] as string;
    });
    expect(toast).toContain('Nothing was saved. Parent A: WORKBOOK_ROW_INVALID: Active A does not match the current shared ingredient identity. Download a fresh workbook and review it');
    expect(toast).toContain('Parent B: WORKBOOK_ROW_INVALID: Active B does not match the current shared ingredient identity. Download a fresh workbook and review it');
    expect(toast).toContain('Parent C: WORKBOOK_SOURCE_REQUIRED: X needs its source document');
    expect(toast).not.toContain('mark the row __delete and add the new ingredient as a new row');
  });

  it('finishes an uncertain proposal decision with the exact saved request', async () => {
    const proposal: ChemistryProposalView = { id: 'proposal-retry', parent_id: 'parent-a', parent_name: 'Parent A', items: [],
      has_delete: false, base_chemistry_version: 2, proposal_version: 4, status: 'proposed', created_by: 'admin', created_at: new Date().toISOString(), unresolved: false };
    const pending = { key: 'decision-key', userId: 'admin', scope: 'setup-workbook-chemistry', rpc: 'promote_chemistry_proposal' as const,
      args: { p_proposal_id: proposal.id, p_expected_proposal_version: 4, p_decision: 'apply' }, label: 'Apply proposal for Parent A', createdAt: Date.now() };
    H.loadOpenChemistryProposals.mockResolvedValue([proposal]);
    H.startChemistrySave.mockImplementationOnce(async () => { H.pendingSaves.mockReturnValue([pending]); throw new Error('uncertain'); });
    H.finishChemistrySave.mockResolvedValue({});
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={null} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply proposal' }));
    expect(await screen.findByRole('button', { name: 'Finish save' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish save' }));
    await waitFor(() => expect(H.finishChemistrySave).toHaveBeenCalledWith(pending));
    expect(H.startChemistrySave).toHaveBeenCalledWith('admin', 'setup-workbook-chemistry', 'promote_chemistry_proposal', pending.args, expect.any(String));
  });

  it.each(['Apply proposal', 'Reject proposal'])('refreshes the open proposal list after %s', async (label) => {
    const proposal: ChemistryProposalView = { id: 'proposal-refresh', parent_id: 'parent-a', parent_name: 'Parent A', items: [],
      has_delete: false, base_chemistry_version: 2, proposal_version: 1, status: 'proposed', created_by: 'admin', created_at: new Date().toISOString(), unresolved: false };
    H.loadOpenChemistryProposals.mockResolvedValueOnce([proposal]).mockResolvedValueOnce([]);
    H.startChemistrySave.mockResolvedValue({});
    render(<SetupWorkbookChemistryTabs open profileId="admin" fileGeneration={8} parsed={null} onSaved={vi.fn()} />);
    expect(await screen.findByText('Open ingredient proposals (1)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(H.loadOpenChemistryProposals).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('No open proposals.')).toBeInTheDocument());
    expect(H.startChemistrySave.mock.calls[0][3]).toEqual({ p_proposal_id: proposal.id, p_expected_proposal_version: 1,
      p_decision: label.startsWith('Apply') ? 'apply' : 'reject' });
  });
});
