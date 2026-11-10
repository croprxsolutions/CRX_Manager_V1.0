import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  toast: vi.fn(),
  parse: vi.fn(),
  loadExport: vi.fn(),
  getProductParents: vi.fn(),
  previewParentRates: vi.fn(),
  setParentRates: vi.fn(),
}));

vi.mock('../../lib/db', () => ({
  supabase: { rpc: vi.fn() },
  assertRpcResult: (data: unknown) => data,
  sanitizeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock('../../lib/productSetup', () => ({ listProductCategories: vi.fn(async () => [{ name: 'Herbicide', is_active: true }]) }));
vi.mock('../../lib/productUseTimings', () => ({ listProductUseTimingOptions: vi.fn(async () => []) }));
vi.mock('../../lib/productParents', () => ({
  getProductParents: H.getProductParents,
  previewParentRates: H.previewParentRates,
  setParentRates: H.setParentRates,
}));
vi.mock('../../lib/productSetupWorkbook', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/productSetupWorkbook')>()),
  parseSetupWorkbook: H.parse,
  loadSetupWorkbookExport: H.loadExport,
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import ProductSetupWorkbookModal from './ProductSetupWorkbookModal';
import { setupMembershipHash, type ParentRateUploadRow } from '../../lib/productSetupWorkbook';
import type { ParentRatePreview, ProductParent } from '../../lib/productParents';

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
const preview: ParentRatePreview = {
  parent_id: 'parent-1', parent_version: 7, rates_locked: false,
  before: { rate_per_acre: '13', rate_unit: 'oz', suggested_rate: null },
  after: { rate_per_acre: '14', rate_unit: 'oz', suggested_rate: null },
  sizes: [{ product_id: SIZE, product_name: 'Atrazine 4L 2.5 gal', pricing_version: 3, unit_size: '2.5', inventory_unit: 'Gal',
    product_form: 'liquid', rate_per_acre: '13', rate_unit: 'oz', suggested_rate: null,
    prices: { tier1_price_per_acre: 4.5, tier2_price_per_acre: 4, tier3_price_per_acre: 3.5 },
    before_prices: { tier1_price_per_acre: 4.2, tier2_price_per_acre: 3.8, tier3_price_per_acre: 3.3 } }],
};

async function upload(membershipHash: string, parentRateRows: ParentRateUploadRow[] = [editedParent]) {
  H.parse.mockResolvedValue({ setupRows: [{ product_id: SIZE }], rateRows: [], parentRateRows, membershipHash });
  render(<ProductSetupWorkbookModal open profileId="u1" onClose={vi.fn()} onSaved={vi.fn()} />);
  const file = new File(['x'], 'setup.xlsx');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
  fireEvent.change(screen.getByLabelText('Setup workbook file'), { target: { files: [file] } });
}

describe('ProductSetupWorkbookModal parent rates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.loadExport.mockResolvedValue({ rates_locked: false, rows: [] });
    H.getProductParents.mockResolvedValue([parent]);
    H.previewParentRates.mockResolvedValue(preview);
    H.setParentRates.mockResolvedValue({ changed_count: 1 });
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

  it('drops the old preview after a refused save, so the next try previews the current sizes', async () => {
    H.setParentRates.mockRejectedValueOnce(new Error('PRODUCT_PARENT_STALE: a size changed since the preview'));
    await upload(await setupMembershipHash([SIZE], [parent]));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'PRODUCT_PARENT_STALE: a size changed since the preview'));
    expect(screen.getByRole('button', { name: 'Confirm Parent Rates tab' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview parent rates again' }));
    await waitFor(() => expect(H.previewParentRates).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Parent Rates tab' }));
    await waitFor(() => expect(H.setParentRates).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Saved rates for 1 parent.')).toBeInTheDocument();
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
    await upload(await setupMembershipHash([SIZE], [parent]), rows);
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'Save at most 500 changed parents on the Parent Rates tab at a time.'));
    expect(H.previewParentRates).not.toHaveBeenCalled();
  });
});
