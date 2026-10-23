import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  listProductBrands: vi.fn(),
  saveProductBrand: vi.fn(),
  lookupEpaRegistration: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../../lib/activityLogger', () => ({ logActivity: mocks.logActivity }));
vi.mock('../../lib/epaLookupClient', () => ({ lookupEpaRegistration: mocks.lookupEpaRegistration }));
vi.mock('./ProductSearchPicker', () => ({
  default: ({ onSelect }: { onSelect: (product: { id: string; product_name: string }) => void }) => (
    <>
      <button type="button" onClick={() => onSelect({ id: 'p2', product_name: 'Roundup 5.4# Generic - Bulk' })}>
        Pick bulk size
      </button>
      <button type="button" onClick={() => onSelect({ id: 'p3', product_name: 'Roundup 5.4# Generic - Jug' })}>
        Pick jug size
      </button>
    </>
  ),
}));
vi.mock('../../lib/productBrands', async () => {
  const actual = await vi.importActual<typeof import('../../lib/productBrands')>('../../lib/productBrands');
  return { ...actual, listProductBrands: mocks.listProductBrands, saveProductBrand: mocks.saveProductBrand };
});

import ProductBrandsSection from './ProductBrandsSection';

const slam = {
  id: 'b1', product_id: 'p1', brand_name: 'Slam 5.4', epa_registration: '524-475', manufacturer: null,
  is_currently_sourced: true, is_rup: null, signal_word: 'Caution' as const, row_version: 2,
  created_by: 'u1', updated_by: 'u1', created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:00:00Z',
};

const productName = 'Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4) - 2.5 Gal';

describe('ProductBrandsSection', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listProductBrands.mockResolvedValue([slam]);
  });

  it('shows brands read-only to a non-admin', async () => {
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin={false} userId="u2" />);
    expect(await screen.findByText('Slam 5.4')).toBeInTheDocument();
    expect(screen.getByText('524-475')).toBeInTheDocument();
    expect(screen.getByText('Not confirmed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add brand/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByText(/named in the product name/i)).not.toBeInTheDocument();
  });

  it('suggests only the brands from the name that are not listed yet', async () => {
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin userId="u1" />);
    await screen.findByText('Slam 5.4');
    expect(screen.getByText(/named in the product name/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ag Saver 5\.4/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^\s*Slam 5\.4/ })).not.toBeInTheDocument();
  });

  it('adds a suggested brand with its EPA number and reloads', async () => {
    mocks.saveProductBrand.mockResolvedValue({ ...slam, id: 'b2', brand_name: 'Ag Saver 5.4', row_version: 1 });
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin userId="u1" />);
    await screen.findByText('Slam 5.4');
    fireEvent.click(screen.getByRole('button', { name: /Ag Saver 5\.4/ }));
    expect(screen.getByLabelText('Brand name')).toHaveValue('Ag Saver 5.4');
    fireEvent.change(screen.getByLabelText('EPA Reg. No.'), { target: { value: '100-1234-5905' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save brand' }));
    await waitFor(() => expect(mocks.saveProductBrand).toHaveBeenCalledTimes(1));
    const [input, key] = mocks.saveProductBrand.mock.calls[0];
    expect(input).toMatchObject({
      productId: 'p1', brandName: 'Ag Saver 5.4', epaRegistration: '100-1234-5905',
      isCurrentlySourced: true, isRup: null, signalWord: null,
    });
    expect(input.brandId).toBeUndefined();
    expect(key).toMatch(/^upsert_product_brand:u1:/);
    await waitFor(() => expect(mocks.listProductBrands).toHaveBeenCalledTimes(2));
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Brand added.');
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      event: 'product_brand_added', performedBy: 'u1', entityType: 'product', entityId: 'p1',
    }));
  });

  it('refuses a malformed EPA number before calling the server', async () => {
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin userId="u1" />);
    await screen.findByText('Slam 5.4');
    fireEvent.click(screen.getByRole('button', { name: /add brand/i }));
    fireEvent.change(screen.getByLabelText('Brand name'), { target: { value: 'Mad Dog' } });
    fireEvent.change(screen.getByLabelText('EPA Reg. No.'), { target: { value: 'EPA 524-475' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save brand' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not an EPA registration number/);
    expect(mocks.saveProductBrand).not.toHaveBeenCalled();
  });

  it('edits with the version it read; when someone else changed it, closes the form and reloads', async () => {
    mocks.saveProductBrand.mockRejectedValue({ message: 'BRAND_CHANGED: someone else changed this brand' });
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin userId="u1" />);
    await screen.findByText('Slam 5.4');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByLabelText(/currently sourced/i));
    fireEvent.click(screen.getByRole('button', { name: 'Save brand' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringContaining('Someone else changed this brand')));
    expect(mocks.saveProductBrand.mock.calls[0][0]).toMatchObject({
      brandId: 'b1', expectedRowVersion: 2, isCurrentlySourced: false,
    });
    await waitFor(() => expect(mocks.listProductBrands).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Save brand' })).not.toBeInTheDocument();
  });

  it('drops an EPA lookup that comes back after the number was changed', async () => {
    let resolveLookup: (value: unknown) => void = () => {};
    mocks.lookupEpaRegistration.mockReturnValue(new Promise((resolve) => { resolveLookup = resolve; }));
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin userId="u1" />);
    await screen.findByText('Slam 5.4');
    fireEvent.click(screen.getByRole('button', { name: /add brand/i }));
    fireEvent.change(screen.getByLabelText('EPA Reg. No.'), { target: { value: '524-475' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    fireEvent.change(screen.getByLabelText('EPA Reg. No.'), { target: { value: '524-999' } });
    resolveLookup({
      found: true, regType: 'section3', eparegno: '524-475', productname: 'ROUNDUP POWERMAX',
      signalWordCanonical: 'Danger', needsManual: false, manufacturer: 'Bayer', rupYn: 'Yes',
      productStatus: 'Active', isCancelled: false, latestLabelPdfUrl: null, activeIngredients: [], labelPdfs: [],
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /look up/i })).not.toBeDisabled());
    expect(screen.queryByText(/ROUNDUP POWERMAX/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Signal word')).toHaveValue('');
  });

  it('fills signal word and restricted-use status from the EPA lookup', async () => {
    mocks.lookupEpaRegistration.mockResolvedValue({
      found: true, regType: 'section3', eparegno: '524-475', productname: 'ROUNDUP POWERMAX',
      signalWordCanonical: 'Warning', needsManual: false, manufacturer: 'Bayer', rupYn: 'No',
      productStatus: 'Active', isCancelled: false, latestLabelPdfUrl: null, activeIngredients: [], labelPdfs: [],
    });
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin userId="u1" />);
    await screen.findByText('Slam 5.4');
    fireEvent.click(screen.getByRole('button', { name: /add brand/i }));
    fireEvent.change(screen.getByLabelText('EPA Reg. No.'), { target: { value: '524-475' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    expect(await screen.findByText(/ROUNDUP POWERMAX/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /use EPA/i }));
    expect(screen.getByLabelText('Signal word')).toHaveValue('Warning');
    expect(screen.getByLabelText('Restricted use (RUP)')).toHaveValue('no');
    expect(screen.getByLabelText('Manufacturer')).toHaveValue('Bayer');
  });

  it('copies brands from another size; a retry after a partial failure reuses the failed brand’s key and skips copied ones', async () => {
    const bulkAg = { ...slam, id: 'x1', product_id: 'p2', brand_name: 'Ag Saver 5.4', epa_registration: '100-1234-5905' };
    const bulkMad = { ...slam, id: 'x2', product_id: 'p2', brand_name: 'Mad Dog', epa_registration: '228-366' };
    const bulkOld = { ...slam, id: 'x3', product_id: 'p2', brand_name: 'Old Brand', is_currently_sourced: false };
    const bulkSlam = { ...slam, id: 'x4', product_id: 'p2' };
    mocks.listProductBrands.mockImplementation(async (id: string) => (id === 'p2' ? [bulkAg, bulkMad, bulkOld, bulkSlam] : [slam]));
    mocks.saveProductBrand
      .mockResolvedValueOnce({ ...bulkAg, id: 'n1', product_id: 'p1' })
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ...bulkMad, id: 'n2', product_id: 'p1' });
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin userId="u1" />);
    await screen.findByText('Slam 5.4');
    fireEvent.click(screen.getByRole('button', { name: /copy from another product/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick bulk size' }));
    // Slam is already listed; the retired brand is shown but not pre-ticked.
    expect(await screen.findByText(/Mad Dog/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Slam 5\.4/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Old Brand/)).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Copy 2 brands' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringContaining('Copied 1 of 2')));
    const failedKey = mocks.saveProductBrand.mock.calls[1][1];
    expect(screen.queryByLabelText(/Ag Saver 5\.4/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy 1 brand' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Copy 1 brand' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('success', 'Copied 1 brand.'));
    expect(mocks.saveProductBrand).toHaveBeenCalledTimes(3);
    expect(mocks.saveProductBrand.mock.calls[2][0]).toMatchObject({ productId: 'p1', brandName: 'Mad Dog', epaRegistration: '228-366' });
    expect(mocks.saveProductBrand.mock.calls[2][1]).toBe(failedKey);
  });

  it('drops a late reply for an earlier copy source, so the picked product’s brands are the ones copied', async () => {
    const bulkMad = { ...slam, id: 'x2', product_id: 'p2', brand_name: 'Mad Dog', epa_registration: '228-366' };
    const jugAg = { ...slam, id: 'y1', product_id: 'p3', brand_name: 'Ag Saver 5.4', epa_registration: '100-1234-5905' };
    let releaseBulk: (rows: typeof slam[]) => void = () => {};
    mocks.listProductBrands.mockImplementation((id: string) => {
      if (id === 'p2') return new Promise((resolve) => { releaseBulk = resolve; });
      return Promise.resolve(id === 'p3' ? [jugAg] : [slam]);
    });
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin userId="u1" />);
    await screen.findByText('Slam 5.4');
    fireEvent.click(screen.getByRole('button', { name: /copy from another product/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick bulk size' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick jug size' }));
    expect(await screen.findByLabelText(/Ag Saver 5\.4/)).toBeInTheDocument();
    releaseBulk([bulkMad]);
    await waitFor(() => expect(mocks.listProductBrands).toHaveBeenCalledWith('p2'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByLabelText(/Mad Dog/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Ag Saver 5\.4/)).toBeChecked();
    expect(screen.getByRole('button', { name: 'Copy 1 brand' })).toBeEnabled();
  });

  it('keeps Copy off until this product’s own brands have loaded', async () => {
    let releaseOwn: (rows: typeof slam[]) => void = () => {};
    mocks.listProductBrands.mockImplementation((id: string) => (
      id === 'p1' ? new Promise((resolve) => { releaseOwn = resolve; }) : Promise.resolve([{ ...slam, id: 'x4', product_id: 'p2' }])
    ));
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin userId="u1" />);
    expect(screen.getByRole('button', { name: /copy from another product/i })).toBeDisabled();
    releaseOwn([slam]);
    await screen.findByText('Slam 5.4');
    expect(screen.getByRole('button', { name: /copy from another product/i })).toBeEnabled();
  });

  it('pauses a retry when this product’s list fails to reload after a partial copy', async () => {
    const bulkAg = { ...slam, id: 'x1', product_id: 'p2', brand_name: 'Ag Saver 5.4', epa_registration: '100-1234-5905' };
    const bulkMad = { ...slam, id: 'x2', product_id: 'p2', brand_name: 'Mad Dog', epa_registration: '228-366' };
    let ownLoads = 0;
    mocks.listProductBrands.mockImplementation((id: string) => {
      if (id === 'p2') return Promise.resolve([bulkAg, bulkMad]);
      ownLoads += 1;
      return ownLoads === 1 ? Promise.resolve([slam]) : Promise.reject(new Error('network down'));
    });
    mocks.saveProductBrand
      .mockResolvedValueOnce({ ...bulkAg, id: 'n1', product_id: 'p1' })
      .mockRejectedValueOnce(new Error('network down'));
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin userId="u1" />);
    await screen.findByText('Slam 5.4');
    fireEvent.click(screen.getByRole('button', { name: /copy from another product/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick bulk size' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy 2 brands' }));
    expect(await screen.findByText(/copying is paused/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy 1 brand' })).toBeDisabled();
    expect(mocks.saveProductBrand).toHaveBeenCalledTimes(2);
  });

  it('stops offering a brand that a reload shows this product already has', async () => {
    const bulkAg = { ...slam, id: 'x1', product_id: 'p2', brand_name: 'Ag Saver 5.4', epa_registration: '100-1234-5905' };
    const bulkMad = { ...slam, id: 'x2', product_id: 'p2', brand_name: 'Mad Dog', epa_registration: '228-366' };
    let ownLoads = 0;
    mocks.listProductBrands.mockImplementation((id: string) => {
      if (id === 'p2') return Promise.resolve([bulkAg, bulkMad]);
      ownLoads += 1;
      // After the partial copy, the reload shows Ag Saver (copied) and Mad Dog (another admin added it).
      return Promise.resolve(ownLoads === 1 ? [slam] : [
        slam, { ...bulkAg, id: 'n1', product_id: 'p1' }, { ...bulkMad, id: 'b9', product_id: 'p1' },
      ]);
    });
    mocks.saveProductBrand
      .mockResolvedValueOnce({ ...bulkAg, id: 'n1', product_id: 'p1' })
      .mockRejectedValueOnce({ message: 'BRAND_NAME_TAKEN: that brand is already listed' });
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin userId="u1" />);
    await screen.findByText('Slam 5.4');
    fireEvent.click(screen.getByRole('button', { name: /copy from another product/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick bulk size' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy 2 brands' }));
    expect(await screen.findByText(/no brands this one doesn’t already list/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Mad Dog/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy 0 brands' })).toBeDisabled();
  });

  it('shows a failed copy-source read as a failure with a retry, not as "no brands"', async () => {
    const bulkMad = { ...slam, id: 'x2', product_id: 'p2', brand_name: 'Mad Dog', epa_registration: '228-366' };
    let sourceLoads = 0;
    mocks.listProductBrands.mockImplementation((id: string) => {
      if (id !== 'p2') return Promise.resolve([slam]);
      sourceLoads += 1;
      return sourceLoads === 1 ? Promise.reject(new Error('network down')) : Promise.resolve([bulkMad]);
    });
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin userId="u1" />);
    await screen.findByText('Slam 5.4');
    fireEvent.click(screen.getByRole('button', { name: /copy from another product/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick bulk size' }));
    expect(await screen.findByText(/couldn’t load Roundup 5\.4# Generic - Bulk’s brands/i)).toBeInTheDocument();
    expect(screen.queryByText(/no brands this one doesn’t already list/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByLabelText(/Mad Dog/)).toBeChecked();
    expect(screen.getByRole('button', { name: 'Copy 1 brand' })).toBeEnabled();
  });

  it('says so when brands fail to load and offers a retry', async () => {
    mocks.listProductBrands.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce([slam]);
    render(<ProductBrandsSection productId="p1" productName={productName} isAdmin={false} userId="u2" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t load brands/i);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Slam 5.4')).toBeInTheDocument();
  });
});
