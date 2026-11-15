import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  toast: vi.fn(),
  rpc: vi.fn(),
  saved: vi.fn(),
  parse: vi.fn(),
  loadExport: vi.fn(),
  getProductParents: vi.fn(),
  previewParentRates: vi.fn(),
  setParentRates: vi.fn(),
  previewRates: vi.fn(), saveRates: vi.fn(), applySetup: vi.fn(), buildSetupPreview: vi.fn(),
  chemistryLoad: vi.fn(), chemistryProposals: vi.fn(), chemistryWeightsPreview: vi.fn(), chemistryIngredientsPreview: vi.fn(),
  pendingSaves: vi.fn(), startChemistrySave: vi.fn(), finishChemistrySave: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: H.rpc }) }));
vi.mock('../../lib/db', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/db')>()),
  supabase: { rpc: H.rpc },
}));
vi.mock('../../lib/productSetup', () => ({ listProductCategories: vi.fn(async () => [{ name: 'Herbicide', is_active: true }]) }));
vi.mock('../../lib/productUseTimings', () => ({ listProductUseTimingOptions: vi.fn(async () => []) }));
vi.mock('../../lib/productParents', () => ({
  getProductParents: H.getProductParents,
  previewParentRates: H.previewParentRates,
  setParentRates: H.setParentRates,
}));
vi.mock('../../lib/productChemistry', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/productChemistry')>()),
  pendingSaves: H.pendingSaves,
  startChemistrySave: H.startChemistrySave,
  finishChemistrySave: H.finishChemistrySave,
}));
vi.mock('../../lib/productSetupChemistry', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/productSetupChemistry')>()),
  loadSetupWorkbookChemistry: H.chemistryLoad,
  loadOpenChemistryProposals: H.chemistryProposals,
  previewSetupWeights: H.chemistryWeightsPreview,
  previewSetupIngredients: H.chemistryIngredientsPreview,
}));
vi.mock('../../lib/productSetupWorkbook', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/productSetupWorkbook')>()),
  parseSetupWorkbook: H.parse,
  loadSetupWorkbookExport: H.loadExport,
  previewProductRates: H.previewRates,
  saveProductRates: H.saveRates,
  applyProductSetup: H.applySetup,
  buildSetupPreview: H.buildSetupPreview,
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import ProductSetupWorkbookModal from './ProductSetupWorkbookModal';
import { supabase } from '../../lib/db';
import { setupMembershipHash, type ParentRateUploadRow, type RateUploadRow } from '../../lib/productSetupWorkbook';
import type { ParentRatePreview, ProductParent } from '../../lib/productParents';
import type { ParsedChemistryWorkbook } from '../../lib/productSetupChemistryWorkbook';

const SIZE = '22222222-2222-4222-8222-222222222222';
const parent: ProductParent = {
  id: 'parent-1', name: 'Atrazine 4L', nickname: null, product_form: 'liquid', formulation_type: null, safener: null,
  generic_epa_registration: null, category: 'Herbicide', use_timings: [], rate_per_acre: '13', rate_unit: 'oz',
  suggested_rate: null, parent_version: 7, is_active: true,
  sizes: [{ product_id: SIZE, product_name: 'Atrazine 4L 2.5 gal', sku: null, size_role: 'package', fill_source_product_id: null, is_active: true }],
};
const editedParent: ParentRateUploadRow = {
  parent_id: 'parent-1', parent_name: 'Atrazine 4L', rate_per_acre: '14', rate_unit: 'oz', suggested_rate: null,
  expected: { parent_version: 7, rate_per_acre: '13', rate_unit: 'oz', suggested_rate: null },
};
const editedRate: RateUploadRow = {
  product_id: SIZE, rate_per_acre: '14', rate_unit: 'oz', suggested_rate: null,
  expected: { rate_per_acre: '13', rate_unit: 'oz', suggested_rate: null, pricing_version: 3, unit_size: '2.5', inventory_unit: 'Gal', product_form: 'liquid' },
};
const preview: ParentRatePreview = {
  parent_id: 'parent-1', parent_version: 7, rates_locked: false,
  before: { rate_per_acre: '13', rate_unit: 'oz', suggested_rate: null },
  after: { rate_per_acre: '14', rate_unit: 'oz', suggested_rate: null },
  sizes: [{ product_id: SIZE, product_name: 'Atrazine 4L 2.5 gal', pricing_version: 3, unit_size: '2.5', inventory_unit: 'Gal',
    product_form: 'liquid', rate_per_acre: '13', rate_unit: 'oz', suggested_rate: null,
    prices: { tier1_price_per_acre: 4.5, tier2_price_per_acre: 4, tier3_price_per_acre: 3.5 },
    before_prices: { tier1_price_per_acre: 4.2, tier2_price_per_acre: 3.8, tier3_price_per_acre: 3.3 } }],
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function upload(
  membershipHash: string, parentRateRows: ParentRateUploadRow[] = [editedParent],
  chemistry: ParsedChemistryWorkbook = { weightRows: [], ingredientRows: [], issues: [], openProposalParentIds: [] },
  rateRows: RateUploadRow[] = [],
) {
  H.parse.mockResolvedValue({ setupRows: [{ product_id: SIZE }], rateRows, parentRateRows, membershipHash, chemistry });
  render(<ProductSetupWorkbookModal open profileId="u1" onClose={vi.fn()} onSaved={H.saved} />);
  const file = new File(['x'], 'setup.xlsx');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
  fireEvent.change(screen.getByLabelText('Setup workbook file'), { target: { files: [file] } });
  await screen.findByText('No open proposals.');
}

describe('ProductSetupWorkbookModal parent rates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.loadExport.mockResolvedValue({ rates_locked: false, rows: [] });
    H.getProductParents.mockResolvedValue([parent]);
    H.previewParentRates.mockResolvedValue(preview);
    H.setParentRates.mockResolvedValue({ changed_count: 1 });
    H.previewRates.mockResolvedValue({ rates_locked: false, rows: [{ product_id: SIZE, product_name: 'Atrazine 4L 2.5 gal', status: 'change',
      before: { rate_per_acre: '13', rate_unit: 'oz', suggested_rate: null, tier1_price_per_acre: 4.5, tier2_price_per_acre: 4, tier3_price_per_acre: 3.5 },
      after: { rate_per_acre: '14', rate_unit: 'oz', suggested_rate: null, tier1_price_per_acre: 4.5, tier2_price_per_acre: 4, tier3_price_per_acre: 3.5 } }] });
    H.saveRates.mockResolvedValue({ changed_count: 1 });
    H.applySetup.mockResolvedValue({ changed_count: 1, rows: [] });
    H.buildSetupPreview.mockReturnValue({ changes: [], stale: [], invalid: [] });
    H.chemistryLoad.mockResolvedValue({ densities: [], net_weights: [], parents: [] });
    H.chemistryProposals.mockResolvedValue([]);
    H.chemistryWeightsPreview.mockResolvedValue({ rows: [{ kind: 'density', subject_id: 'parent-1', name: 'Atrazine 4L',
      expected_version: 1, status: 'change', before: { value: '8', source: 'label', source_note: 'Old label' },
      after: { value: '8.5', source: 'measured', source_note: 'Scale reading' } }] });
    H.chemistryIngredientsPreview.mockResolvedValue({ parents: [{ parent_id: 'parent-1', parent_name: 'Atrazine 4L',
      chemistry_version: 1, status: 'proposal', items: [] }] });
    H.pendingSaves.mockReturnValue([]);
    H.startChemistrySave.mockResolvedValue({});
    H.finishChemistrySave.mockResolvedValue({});
  });

  it('refuses malformed chemistry before sending any tab preview or write RPC', async () => {
    H.parse.mockRejectedValue(new Error('Ingredients row 2, strength_value has a formula. Type the value instead.'));
    render(<ProductSetupWorkbookModal open profileId="u1" onClose={vi.fn()} onSaved={vi.fn()} />);
    const file = new File(['x'], 'malformed-chemistry.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
    fireEvent.change(screen.getByLabelText('Setup workbook file'), { target: { files: [file] } });
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringMatching(/Ingredients row 2, strength_value has a formula/)));
    expect(await screen.findByText('No open proposals.')).toBeInTheDocument();
    expect(H.getProductParents).not.toHaveBeenCalled();
    expect(H.chemistryWeightsPreview).not.toHaveBeenCalled();
    expect(H.chemistryIngredientsPreview).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each(['Weights', 'Ingredients'] as const)('refuses a %s download that exceeds the upload parser limit', async (sheet) => {
    H.chemistryLoad.mockResolvedValue(sheet === 'Weights'
      ? { densities: Array.from({ length: 10_001 }, (_, index) => ({ parent_id: `parent-${index}`, parent_name: `Parent ${index}`,
        version: 1, approved: null, draft: null })), net_weights: [], parents: [] }
      : { densities: [], net_weights: [], parents: Array.from({ length: 3334 }, (_, index) => ({
        parent_id: `parent-${index}`, parent_name: `Parent ${index}`, chemistry_version: 1, epa_refusal: null, ingredients: [],
      })) });
    render(<ProductSetupWorkbookModal open profileId="u1" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download setup workbook' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringMatching(/too large for one chemistry workbook/)));
  });

  it.each(['success', 'error'] as const)('disables close and workbook replacement during a delayed chemistry save, then unlocks on %s', async (outcome) => {
    const membershipHash = await setupMembershipHash([SIZE], [parent]);
    const save = deferred<void>();
    H.startChemistrySave.mockReturnValueOnce(save.promise);
    const chemistry = { weightRows: [], ingredientRows: [{ parent_id: 'parent-1', expected_chemistry_version: 1, row_id: null,
      name: 'New Active', cas: null, strength_value: null, strength_unit: 'pct_ww', strength_basis: 'active_ingredient',
      source: 'label', source_note: 'Label page 1' }], issues: [], openProposalParentIds: [] };
    await upload(membershipHash, [], chemistry);
    expect(await screen.findByText('No open proposals.')).toBeInTheDocument();
    const confirm = await screen.findByRole('button', { name: 'Confirm Ingredients tab' });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(H.startChemistrySave).toHaveBeenCalledOnce());
    await waitFor(() => {
      screen.getAllByRole('button', { name: 'Close' }).forEach((button) => expect(button).toBeDisabled());
      expect(screen.getByRole('button', { name: 'Upload and preview' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Download setup workbook' })).toBeDisabled();
    });
    await act(async () => {
      if (outcome === 'success') save.resolve(undefined);
      else save.reject(new Error('network reply lost'));
      await save.promise.catch(() => undefined);
    });
    await waitFor(() => {
      screen.getAllByRole('button', { name: 'Close' }).forEach((button) => expect(button).toBeEnabled());
      expect(screen.getByRole('button', { name: 'Upload and preview' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Download setup workbook' })).toBeEnabled();
    });
  });

  it('blocks chemistry writes while a legacy Setup save is in flight', async () => {
    const save = deferred<{ changed_count: number; rows: [] }>();
    H.buildSetupPreview.mockReturnValue({ changes: [{ product_id: SIZE, product_name: 'Atrazine 4L 2.5 gal', setup_fingerprint: 'fp',
      changes: { notes: 'updated note' }, display: [] }], stale: [], invalid: [] });
    H.applySetup.mockReturnValueOnce(save.promise);
    const chemistry = { weightRows: [], ingredientRows: [{ parent_id: 'parent-1', expected_chemistry_version: 1, row_id: null,
      name: 'New Active', cas: '1071-83-6', strength_value: 25, strength_unit: 'pct_ww', strength_basis: 'active_ingredient',
      source: 'label', source_note: 'Label page 1' }], issues: [], openProposalParentIds: [] };
    await upload(await setupMembershipHash([SIZE], [parent]), [], chemistry);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Setup tab' }));
    await waitFor(() => expect(H.applySetup).toHaveBeenCalledOnce());
    const ingredientConfirm = screen.getByRole('button', { name: 'Confirm Ingredients tab' });
    expect(ingredientConfirm).toBeDisabled();
    fireEvent.click(ingredientConfirm);
    expect(H.startChemistrySave).not.toHaveBeenCalled();
    await act(async () => { save.resolve({ changed_count: 1, rows: [] }); await save.promise; });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm Ingredients tab' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Ingredients tab' }));
    await waitFor(() => expect(H.startChemistrySave).toHaveBeenCalledOnce());
  });

  it('does not block modal navigation just because an unresolved chemistry request exists', async () => {
    H.pendingSaves.mockReturnValue([{ key: 'stored-key', userId: 'u1', scope: 'setup-workbook-chemistry',
      rpc: 'commit_ingredients_tab', args: { p_rows: [] }, label: 'Save Ingredients tab', createdAt: Date.now() }]);
    render(<ProductSetupWorkbookModal open profileId="u1" onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText('No open proposals.')).toBeInTheDocument();
    screen.getAllByRole('button', { name: 'Close' }).forEach((button) => expect(button).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Upload and preview' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Download setup workbook' })).toBeEnabled();
  });

  it('previews an edited parent and saves it with one set_parent_rates call', async () => {
    await upload(await setupMembershipHash([SIZE], [parent]));
    expect(await screen.findByText('Parent Rates tab: 1 parent to change')).toBeInTheDocument();
    expect(H.previewParentRates).toHaveBeenCalledWith('parent-1', editedParent);
    expect(screen.getByText('Atrazine 4L 2.5 gal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledOnce());
    const [rows, key] = H.setParentRates.mock.calls[0];
    expect(rows).toEqual([{ preview, rates: { rate_per_acre: '14', rate_unit: 'oz', suggested_rate: null } }]);
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
    expect(await screen.findByText('Saved rates for 1 parent.')).toBeInTheDocument();
  });

  it.each(['PRODUCT_PARENT_STALE', 'PRODUCT_PARENT_SIZE_STALE', 'PRODUCT_PARENT_RATES_STALE', 'PRODUCT_RATE_PREVIEW_CHANGED', 'PRODUCT_RATES_STALE'])(
    'drops the old preview after Postgrest %s, so the next try previews current sizes', async (code) => {
    H.setParentRates.mockRejectedValueOnce({ code: 'P0001', message: `${code}: a size changed since the preview` });
    await upload(await setupMembershipHash([SIZE], [parent]));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'Nothing was saved. A size changed since the preview'));
    expect(screen.getByRole('button', { name: 'Confirm Parent Rates tab' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview parent rates again' }));
    await waitFor(() => expect(H.previewParentRates).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Saved rates for 1 parent.')).toBeInTheDocument();
  });

  it('refreshes and shows the locked state after a parent-rate lock refusal', async () => {
    H.previewParentRates.mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, rates_locked: true });
    H.setParentRates.mockRejectedValueOnce({ code: 'P0001', message: 'PRODUCT_RATES_LOCKED: rates are locked' });
    await upload(await setupMembershipHash([SIZE], [parent]));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Parent Rates tab' }));
    expect(await screen.findByText(/Rates are locked\. An admin can correct one parent at a time/)).toBeInTheDocument();
    expect(H.previewParentRates).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Confirm Parent Rates tab' })).toBeDisabled();
  });

  it('contains a failed parent-rate lock refresh and leaves Preview again available', async () => {
    H.previewParentRates.mockResolvedValueOnce(preview).mockRejectedValueOnce(new Error('refresh offline'));
    H.setParentRates.mockRejectedValueOnce({ code: 'P0001', message: 'PRODUCT_RATES_LOCKED: rates are locked' });
    await upload(await setupMembershipHash([SIZE], [parent]));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Parent Rates tab' }));
    expect(await screen.findByRole('button', { name: 'Preview parent rates again' })).toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('error', expect.stringMatching(/could not be loaded\. Use Preview parent rates again\. refresh offline/));
    expect(H.saved).toHaveBeenCalledOnce();
  });

  it('keeps an unanswered parent-rate request unchanged when the Setup tab is saved', async () => {
    const setupPreview = { changes: [{ product_id: SIZE, product_name: 'Atrazine 4L 2.5 gal', setup_fingerprint: 'fp',
      changes: { notes: 'updated note' }, display: [] }], stale: [], invalid: [] };
    H.buildSetupPreview.mockReturnValue(setupPreview);
    H.applySetup.mockResolvedValue({ changed_count: 1, rows: [] });
    H.setParentRates.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce({ changed_count: 1 });
    await upload(await setupMembershipHash([SIZE], [parent]));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringMatching(/may have gone through.*retry the same request/)));
    expect(screen.getByRole('button', { name: 'Confirm Parent Rates tab' })).toBeEnabled();
    const originalCall = H.setParentRates.mock.calls[0];
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Setup tab' }));
    await waitFor(() => expect(H.applySetup).toHaveBeenCalledOnce());
    expect(H.previewParentRates).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledTimes(2));
    expect(H.setParentRates.mock.calls[1]).toEqual(originalCall);
    expect(H.previewParentRates).toHaveBeenCalledOnce();
  });

  it('offers a Rates re-preview after the server says the accepted preview is stale', async () => {
    H.saveRates.mockRejectedValueOnce({ code: 'P0001', message: 'PRODUCT_RATE_PREVIEW_CHANGED: rates changed after preview' });
    await upload(await setupMembershipHash([SIZE], [parent]), [], undefined, [editedRate]);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Rates tab' }));
    expect(await screen.findByRole('button', { name: 'Preview rates again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Rates tab' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview rates again' }));
    await waitFor(() => expect(H.previewRates).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm Rates tab' })).toBeEnabled());
  });

  it('shows Rates locked and disables another save after a lock refusal', async () => {
    H.saveRates.mockRejectedValueOnce({ code: 'P0001', message: 'PRODUCT_RATES_LOCKED: rates are locked' });
    await upload(await setupMembershipHash([SIZE], [parent]), [], undefined, [editedRate]);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Rates tab' }));
    expect(await screen.findByText(/Rates are locked\. An admin can correct one product at a time/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Rates tab' })).toBeDisabled();
  });

  it('retries an unanswered parent-rate save with the same rows, preview and idempotency key', async () => {
    H.setParentRates.mockRejectedValueOnce(new Error('network reply lost')).mockResolvedValueOnce({ changed_count: 1 });
    await upload(await setupMembershipHash([SIZE], [parent]));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringMatching(/may have gone through.*retry the same request/)));
    expect(screen.getByRole('button', { name: 'Confirm Parent Rates tab' })).toBeEnabled();
    expect(H.previewParentRates).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledTimes(2));
    expect(H.setParentRates.mock.calls[1]).toEqual(H.setParentRates.mock.calls[0]);
    expect(H.setParentRates.mock.calls[0][0][0].preview).toBe(preview);
    expect(H.previewParentRates).toHaveBeenCalledOnce();
  });

  it('keeps Rates and Parent Rates retries on their own keys: one finishing never clears or reuses the other', async () => {
    H.saveRates.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ changed_count: 1 });
    H.setParentRates.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ changed_count: 1 });
    await upload(await setupMembershipHash([SIZE], [parent]), [editedParent], undefined, [editedRate]);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Rates tab' }));
    await waitFor(() => expect(H.saveRates).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledOnce());
    const ratesCall = H.saveRates.mock.calls[0];
    const parentCall = H.setParentRates.mock.calls[0];
    expect(ratesCall[0].idempotencyKey).not.toBe(parentCall[1]);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledTimes(2));
    expect(H.setParentRates.mock.calls[1]).toEqual(parentCall);
    expect(await screen.findByText('Saved rates for 1 parent.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Rates tab' }));
    await waitFor(() => expect(H.saveRates).toHaveBeenCalledTimes(2));
    expect(H.saveRates.mock.calls[1]).toEqual(ratesCall);
    expect(await screen.findByText('Saved rates for 1 product.')).toBeInTheDocument();
  });

  it('does not let a previous actor preview clear the current Parent Rates retry', async () => {
    const membershipHash = await setupMembershipHash([SIZE], [parent]);
    const setupPreview = { changes: [{ product_id: SIZE, product_name: 'Atrazine 4L 2.5 gal', setup_fingerprint: 'fp',
      changes: { notes: 'updated note' }, display: [] }], stale: [], invalid: [] };
    H.buildSetupPreview.mockReturnValue(setupPreview);
    H.applySetup.mockResolvedValue({ changed_count: 1, rows: [] });
    let resolveOldPreview!: (value: ParentRatePreview) => void;
    const oldPreview = new Promise<ParentRatePreview>((resolve) => { resolveOldPreview = resolve; });
    H.previewParentRates.mockReset().mockRejectedValueOnce(new Error('initial preview failed'))
      .mockImplementationOnce(() => oldPreview).mockResolvedValue(preview);
    H.setParentRates.mockRejectedValueOnce(new TypeError('reply lost')).mockResolvedValueOnce({ changed_count: 1 });
    const view = render(<ProductSetupWorkbookModal open profileId="u1" onClose={vi.fn()} onSaved={H.saved} />);
    const selectFile = () => {
      H.parse.mockResolvedValue({ setupRows: [{ product_id: SIZE }], rateRows: [], parentRateRows: [editedParent], membershipHash,
        chemistry: { weightRows: [], ingredientRows: [], issues: [], openProposalParentIds: [] } });
      const file = new File(['workbook'], 'setup.xlsx');
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
      fireEvent.change(screen.getByLabelText('Setup workbook file'), { target: { files: [file] } });
    };

    selectFile();
    await waitFor(() => expect(H.previewParentRates).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole('button', { name: 'Preview parent rates again' }));
    await waitFor(() => expect(H.previewParentRates).toHaveBeenCalledTimes(2));

    view.rerender(<ProductSetupWorkbookModal open profileId="u2" onClose={vi.fn()} onSaved={H.saved} />);
    selectFile();
    await waitFor(() => expect(H.previewParentRates).toHaveBeenCalledTimes(3));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledOnce());
    const currentRequest = H.setParentRates.mock.calls[0];
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringMatching(/may have gone through/i)));

    await act(async () => { resolveOldPreview(preview); });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Setup tab' }));
    await waitFor(() => expect(H.applySetup).toHaveBeenCalledOnce());
    expect(H.previewParentRates).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledTimes(2));
    expect(H.setParentRates.mock.calls[1]).toEqual(currentRequest);
    expect(H.previewParentRates).toHaveBeenCalledTimes(3);
  });

  it('keeps an unanswered product Rates save intact when Setup is saved, then retries the same request', async () => {
    const setupPreview = { changes: [{ product_id: SIZE, product_name: 'Atrazine 4L 2.5 gal', setup_fingerprint: 'fp',
      changes: { notes: 'updated note' }, display: [] }], stale: [], invalid: [] };
    H.buildSetupPreview.mockReturnValue(setupPreview);
    let syntheticWrites = 0;
    H.saveRates.mockImplementationOnce(async () => {
      syntheticWrites += 1;
      throw new TypeError('Failed to fetch after server commit');
    }).mockImplementationOnce(async () => ({ changed_count: 1 }));
    await upload(await setupMembershipHash([SIZE], [parent]), [], undefined, [editedRate]);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Rates tab' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringMatching(/rate save may have gone through.*retry the same request/i)));
    const originalCall = H.saveRates.mock.calls[0];
    expect(screen.getByRole('button', { name: 'Confirm Rates tab' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Setup tab' }));
    await waitFor(() => expect(H.applySetup).toHaveBeenCalledOnce());
    expect(H.previewRates).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Rates tab' }));
    await waitFor(() => expect(H.saveRates).toHaveBeenCalledTimes(2));
    expect(H.saveRates.mock.calls[1]).toEqual(originalCall);
    expect(syntheticWrites).toBe(1);
    expect(await screen.findByText('Saved rates for 1 product.')).toBeInTheDocument();
    expect(H.previewRates).toHaveBeenCalledOnce();
  });

  it('retains the unanswered Rates request after a PostgREST error on its retry', async () => {
    H.saveRates.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce({ code: 'PGRST202', message: 'Could not find the function in the schema cache' })
      .mockResolvedValueOnce({ changed_count: 1 });
    await upload(await setupMembershipHash([SIZE], [parent]), [], undefined, [editedRate]);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Rates tab' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringMatching(/rate save may have gone through/i)));
    const originalCall = H.saveRates.mock.calls[0];
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Rates tab' }));
    await waitFor(() => expect(H.saveRates).toHaveBeenCalledTimes(2));
    expect(H.saveRates.mock.calls[1]).toEqual(originalCall);
    expect(H.toast).toHaveBeenLastCalledWith('error', expect.stringMatching(/rate save may have gone through/i));
    expect(screen.getByRole('button', { name: 'Confirm Rates tab' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Rates tab' }));
    await waitFor(() => expect(H.saveRates).toHaveBeenCalledTimes(3));
    expect(H.saveRates.mock.calls[2]).toEqual(originalCall);
    expect(await screen.findByText('Saved rates for 1 product.')).toBeInTheDocument();
  });

  it('treats a named business refusal on a Rates replay as final and uses a fresh workbook request', async () => {
    const setupPreview = { changes: [{ product_id: SIZE, product_name: 'Atrazine 4L 2.5 gal', setup_fingerprint: 'fp',
      changes: { notes: 'updated note' }, display: [] }], stale: [], invalid: [] };
    H.buildSetupPreview.mockReturnValue(setupPreview);
    H.applySetup.mockResolvedValue({ changed_count: 1, rows: [{ product_id: SIZE, product_name: 'Atrazine 4L 2.5 gal',
      pricing_version_before: 3, pricing_version_after: 4, fields: ['notes'] }] });
    H.saveRates.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce({ code: 'P0001', message: 'PRODUCT_RATE_INVALID: invalid rate unit' });
    await upload(await setupMembershipHash([SIZE], [parent]), [], undefined, [editedRate]);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Rates tab' }));
    await waitFor(() => expect(H.saveRates).toHaveBeenCalledOnce());

    const replacementRate = { ...editedRate, rate_per_acre: '15' };
    const replacement = new File(['replacement'], 'replacement.xlsx');
    Object.defineProperty(replacement, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
    H.parse.mockResolvedValue({ setupRows: [{ product_id: SIZE }], rateRows: [replacementRate], parentRateRows: [],
      membershipHash: await setupMembershipHash([SIZE], [parent]), chemistry: { weightRows: [], ingredientRows: [], issues: [], openProposalParentIds: [] } });
    fireEvent.change(screen.getByLabelText('Setup workbook file'), { target: { files: [replacement] } });
    await waitFor(() => expect(H.previewRates).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Setup tab' }));
    await waitFor(() => expect(H.applySetup).toHaveBeenCalledOnce());
    await waitFor(() => expect(H.previewRates).toHaveBeenCalledTimes(3));
    expect(H.previewRates.mock.calls[2][0][0]).toMatchObject({ rate_per_acre: '15', expected: { pricing_version: 4 } });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Rates tab' }));
    await waitFor(() => expect(H.saveRates).toHaveBeenCalledTimes(2));
    expect(H.saveRates.mock.calls[1][0].rows[0]).toMatchObject({ rate_per_acre: '15', expected: { pricing_version: 4 } });
    expect(H.toast).toHaveBeenLastCalledWith('error', expect.stringMatching(/invalid rate unit/i));
    expect(H.toast).not.toHaveBeenLastCalledWith('error', expect.stringMatching(/may have gone through/i));
  });

  it('uses its deferred own-Setup rebase after an unanswered Rates save is authoritatively stale', async () => {
    const setupPreview = { changes: [{ product_id: SIZE, product_name: 'Atrazine 4L 2.5 gal', setup_fingerprint: 'fp',
      changes: { notes: 'updated note' }, display: [] }], stale: [], invalid: [] };
    H.buildSetupPreview.mockReturnValue(setupPreview);
    H.applySetup.mockResolvedValue({ changed_count: 1, rows: [{ product_id: SIZE, product_name: 'Atrazine 4L 2.5 gal',
      pricing_version_before: 3, pricing_version_after: 4, fields: ['notes'] }] });
    let writes = 0;
    H.saveRates.mockImplementationOnce(async () => { throw new TypeError('reply lost before commit'); })
      .mockRejectedValueOnce({ code: 'P0001', message: 'PRODUCT_RATES_STALE: preview changed' })
      .mockImplementationOnce(async () => { writes += 1; return { changed_count: 1 }; });
    await upload(await setupMembershipHash([SIZE], [parent]), [], undefined, [editedRate]);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Rates tab' }));
    await waitFor(() => expect(H.saveRates).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Setup tab' }));
    await waitFor(() => expect(H.applySetup).toHaveBeenCalledOnce());
    expect(H.previewRates).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Rates tab' }));
    await waitFor(() => expect(H.saveRates).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview rates again' }));
    await waitFor(() => expect(H.previewRates).toHaveBeenCalledTimes(2));
    expect(H.previewRates.mock.calls[1][0][0]).toMatchObject({ expected: { pricing_version: 4 } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Rates tab' }));
    await waitFor(() => expect(H.saveRates).toHaveBeenCalledTimes(3));
    expect(H.saveRates.mock.calls[2][0].rows[0]).toMatchObject({ expected: { pricing_version: 4 } });
    expect(writes).toBe(1);
  });

  it('preserves an unanswered Parent Rates request through auth refusal and Setup save', async () => {
    const setupPreview = { changes: [{ product_id: SIZE, product_name: 'Atrazine 4L 2.5 gal', setup_fingerprint: 'fp',
      changes: { notes: 'updated note' }, display: [] }], stale: [], invalid: [] };
    H.buildSetupPreview.mockReturnValue(setupPreview);
    H.setParentRates.mockRejectedValueOnce(new TypeError('reply lost'))
      .mockRejectedValueOnce({ code: 'PGRST202', message: 'Could not find the function in the schema cache' })
      .mockRejectedValueOnce({ code: '42501', message: 'ADMIN_REQUIRED' })
      .mockResolvedValueOnce({ changed_count: 1 });
    await upload(await setupMembershipHash([SIZE], [parent]));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledOnce());
    const originalCall = H.setParentRates.mock.calls[0];
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledTimes(2));
    expect(H.toast).toHaveBeenLastCalledWith('error', expect.stringMatching(/may have gone through.*retry the same request/i));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledTimes(3));
    expect(H.toast).toHaveBeenLastCalledWith('error', expect.stringMatching(/sign in again or check administrator access.*may have gone through/i));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Setup tab' }));
    await waitFor(() => expect(H.applySetup).toHaveBeenCalledOnce());
    expect(H.previewParentRates).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledTimes(4));
    expect(H.setParentRates.mock.calls[1]).toEqual(originalCall);
    expect(H.setParentRates.mock.calls[2]).toEqual(originalCall);
    expect(H.setParentRates.mock.calls[3]).toEqual(originalCall);
  });

  it('blocks the save when the parent changed since the download', async () => {
    H.previewParentRates.mockResolvedValue({ ...preview, parent_version: 8 });
    await upload(await setupMembershipHash([SIZE], [parent]));
    expect(await screen.findByText('Atrazine 4L: changed by someone else since you downloaded it')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Parent Rates tab' })).toBeDisabled();
  });

  it('blocks the save when a preview price is too large to show exactly', async () => {
    const size = { ...preview.sizes[0], prices: { ...preview.sizes[0].prices, tier1_price_per_acre: JSON.parse('70368744177664.01') as number } };
    H.previewParentRates.mockResolvedValue({ ...preview, sizes: [size] });
    await upload(await setupMembershipHash([SIZE], [parent]));
    expect(await screen.findByText(/too large to show exactly/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Parent Rates tab' })).toBeDisabled();
  });

  it('refuses the whole upload when products were grouped or moved since the download', async () => {
    await upload(await setupMembershipHash([SIZE], []));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error',
      'Products were grouped or moved since this workbook was downloaded. Download a new workbook.'));
    expect(H.previewParentRates).not.toHaveBeenCalled();
    expect(screen.queryByText(/Parent Rates tab/)).not.toBeInTheDocument();
  });

  it('refuses the upload when the parents cannot be loaded', async () => {
    H.getProductParents.mockRejectedValue(new Error('Parents could not be loaded.'));
    await upload('0'.repeat(64));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'Parents could not be loaded.'));
    expect(screen.queryByText(/tab:/)).not.toBeInTheDocument();
  });
  it('refuses more than 500 edited parents before previewing any', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ ...editedParent, parent_id: `parent-${i}` }));
    await upload(await setupMembershipHash([SIZE], [parent]), rows, {
      weightRows: [{ kind: 'density', subject_id: 'parent-1', name: 'Atrazine 4L', expected_version: 1,
        value: 8.5, unit: 'lb_per_gal', source: 'measured', source_note: 'Scale reading', reason: null, evidence: null }],
      ingredientRows: [{ parent_id: 'parent-1', expected_chemistry_version: 1, row_id: null, name: 'Active A', cas: null,
        strength_value: null, strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'label', source_note: 'Label page 1' }],
      issues: [], openProposalParentIds: [],
    });
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'Save at most 500 changed parents on the Parent Rates tab at a time.'));
    expect(H.previewParentRates).not.toHaveBeenCalled();
    expect(H.chemistryWeightsPreview).not.toHaveBeenCalled();
    expect(H.chemistryIngredientsPreview).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Confirm Weights tab' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm Ingredients tab' })).not.toBeInTheDocument();
  });

  it('keeps valid chemistry previews available when a legacy rate preview fails', async () => {
    H.previewParentRates.mockRejectedValueOnce(new Error('Legacy parent rate preview offline'));
    const hash = await setupMembershipHash([SIZE], [parent]);
    H.parse.mockResolvedValue({
      setupRows: [{ product_id: SIZE }], rateRows: [], parentRateRows: [editedParent], membershipHash: hash,
      chemistry: {
        weightRows: [{ kind: 'density', subject_id: 'parent-1', name: 'Atrazine 4L', expected_version: 1,
          value: 8.5, unit: 'lb_per_gal', source: 'measured', source_note: 'Scale reading', reason: null, evidence: null }],
        ingredientRows: [{ parent_id: 'parent-1', expected_chemistry_version: 1, row_id: 'ingredient-1', name: 'Active A', cas: '1071-83-6',
          strength_value: 25, strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'label', source_note: 'Label page 1' }],
        issues: [], openProposalParentIds: [],
      },
    });
    render(<ProductSetupWorkbookModal open profileId="u1" onClose={vi.fn()} onSaved={vi.fn()} />);
    const file = new File(['x'], 'setup.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
    fireEvent.change(screen.getByLabelText('Setup workbook file'), { target: { files: [file] } });
    expect(await screen.findByText(/Weights tab: 1 changes/)).toBeInTheDocument();
    expect(await screen.findByText(/Ingredients tab: 1 parent proposals/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Weights tab' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Confirm Ingredients tab' })).toBeEnabled();
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'Legacy parent rate preview offline'));
  });

  it('ignores an old actor upload that settles after a new actor has uploaded a workbook', async () => {
    let resolveOldPreview!: (value: ParentRatePreview) => void;
    const oldPreview = new Promise<ParentRatePreview>((resolve) => { resolveOldPreview = resolve; });
    H.previewParentRates.mockReset();
    H.previewParentRates.mockImplementationOnce(() => oldPreview).mockResolvedValue({
      ...preview,
      sizes: [{ ...preview.sizes[0], product_name: 'NEW ACTOR PREVIEW' }],
    });
    const hash = await setupMembershipHash([SIZE], [parent]);
    H.parse.mockResolvedValue({ setupRows: [{ product_id: SIZE }], rateRows: [], parentRateRows: [editedParent], membershipHash: hash });
    const onSaved = vi.fn();
    const view = render(<ProductSetupWorkbookModal open profileId="u1" onClose={vi.fn()} onSaved={onSaved} />);
    const chooseFile = () => {
      const file = new File(['x'], 'setup.xlsx');
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
      fireEvent.change(screen.getByLabelText('Setup workbook file'), { target: { files: [file] } });
    };

    chooseFile();
    await waitFor(() => expect(H.previewParentRates).toHaveBeenCalledTimes(1));
    view.rerender(<ProductSetupWorkbookModal open profileId="u2" onClose={vi.fn()} onSaved={onSaved} />);
    chooseFile();
    expect(await screen.findByText('NEW ACTOR PREVIEW')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Parent Rates tab' })).toBeEnabled();

    resolveOldPreview({ ...preview, sizes: [{ ...preview.sizes[0], product_name: 'OLD ACTOR PREVIEW' }] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm Parent Rates tab' })).toBeEnabled());
    expect(screen.getByText('NEW ACTOR PREVIEW')).toBeInTheDocument();
    expect(screen.queryByText('OLD ACTOR PREVIEW')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledOnce());
    expect(H.setParentRates.mock.calls[0][0][0].preview.sizes[0].product_name).toBe('NEW ACTOR PREVIEW');
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('does not publish an old actor upload when its membership digest settles after a profile change', async () => {
    const hash = await setupMembershipHash([SIZE], [parent]);
    const digest = deferred<ArrayBuffer>();
    const digestBytes = Uint8Array.from(hash.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
    const setupPreview = { changes: [{ product_id: SIZE, product_name: 'Old actor product', setup_fingerprint: 'old-fp',
      changes: { notes: 'old actor notes' }, display: [] }], stale: [], invalid: [] };
    H.buildSetupPreview.mockReturnValue(setupPreview);
    H.parse.mockResolvedValue({ setupRows: [{ product_id: SIZE }], rateRows: [], parentRateRows: [editedParent], membershipHash: hash });
    vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(digest.promise);
    const view = render(<ProductSetupWorkbookModal open profileId="u1" onClose={vi.fn()} onSaved={H.saved} />);
    const file = new File(['old actor'], 'old-actor.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
    fireEvent.change(screen.getByLabelText('Setup workbook file'), { target: { files: [file] } });
    await waitFor(() => expect(crypto.subtle.digest).toHaveBeenCalledOnce());

    view.rerender(<ProductSetupWorkbookModal open profileId="u2" onClose={vi.fn()} onSaved={H.saved} />);
    await act(async () => { digest.resolve(digestBytes.buffer as ArrayBuffer); });

    expect(screen.queryByRole('button', { name: 'Confirm Setup tab' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm Parent Rates tab' })).not.toBeInTheDocument();
    expect(H.applySetup).not.toHaveBeenCalled();
  });

  it('does not publish a legacy rates save or clear the new actor busy state', async () => {
    let resolveOldSave!: (value: { changed_count: number }) => void;
    const oldSave = new Promise<{ changed_count: number }>((resolve) => { resolveOldSave = resolve; });
    H.setParentRates.mockReset();
    H.setParentRates.mockImplementationOnce(() => oldSave).mockResolvedValue({ changed_count: 1 });
    const hash = await setupMembershipHash([SIZE], [parent]);
    const parseFile = () => {
      H.parse.mockResolvedValue({ setupRows: [{ product_id: SIZE }], rateRows: [], parentRateRows: [editedParent], membershipHash: hash });
      const file = new File(['x'], 'setup.xlsx');
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
      fireEvent.change(screen.getByLabelText('Setup workbook file'), { target: { files: [file] } });
    };
    const oldSaved = vi.fn();
    const newSaved = vi.fn();
    const view = render(<ProductSetupWorkbookModal open profileId="u1" onClose={vi.fn()} onSaved={oldSaved} />);
    parseFile();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledOnce());
    view.rerender(<ProductSetupWorkbookModal open profileId="u2" onClose={vi.fn()} onSaved={newSaved} />);
    parseFile();
    expect(await screen.findByRole('button', { name: 'Confirm Parent Rates tab' })).toBeEnabled();
    resolveOldSave({ changed_count: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm Parent Rates tab' })).toBeEnabled());
    expect(oldSaved).not.toHaveBeenCalled();
    expect(newSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledTimes(2));
    expect(newSaved).toHaveBeenCalledOnce();
  });
});
