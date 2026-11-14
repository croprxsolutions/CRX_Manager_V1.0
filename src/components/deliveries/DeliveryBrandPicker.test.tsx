import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The registration check reads products and get_epa_registrations; both are faked here.
const db = vi.hoisted(() => ({
  products: vi.fn(async (_ids: string[]): Promise<{ data: unknown; error: unknown }> => ({ data: [], error: null })),
  rpc: vi.fn(async (_name: string, _args: { p_numbers: string[] }): Promise<{ data: unknown; error: unknown }> => ({ data: [], error: null })),
}));
vi.mock('../../lib/db', () => ({
  supabase: { from: () => ({ select: () => ({ in: (_col: string, ids: string[]) => db.products(ids) }) }) },
  supabaseUntyped: { rpc: (name: string, args: { p_numbers: string[] }) => db.rpc(name, args) },
  assertRpcResult: (data: unknown) => data,
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
import DeliveryBrandPicker, { DeliveryBrandsPanel } from './DeliveryBrandPicker';
import type { DeliveryBrandsState } from './useDeliveryBrands';
import { OTHER_BRAND, type DeliveryBrands, type DraftLines } from '../../lib/deliveryBrands';

const brands: DeliveryBrands = {
  delivery_id: 'D1', status: 'in_progress', event_seq: 1,
  lines: [
    {
      delivery_item_id: 'L1', product_id: 'P1', product_name: 'Glyphosate 2.5', quantity: 10, quantity_delivered: null, unit_size: 'gal',
      brand_list: [
        { source: 'size', parent_id: null, brand_id: 'b1', brand_name: 'Roundup', epa_registration: '524-475', manufacturer: null, is_currently_sourced: true },
        { source: 'size', parent_id: null, brand_id: 'b2', brand_name: 'Old Brand', epa_registration: null, manufacturer: null, is_currently_sourced: false },
      ],
      picks: [],
    },
    { delivery_item_id: 'L2', product_id: 'P2', product_name: 'Unbranded seed', quantity: 5, quantity_delivered: null, unit_size: 'bag', brand_list: [], picks: [] },
  ],
};

let latest: DraftLines = {};
function Harness() {
  const [drafts, setDrafts] = useState<DraftLines>({});
  return <DeliveryBrandPicker brands={brands} drafts={drafts} disabled={false} fullQuantity={(l) => l.quantity}
    onChange={(id, d) => { latest = { ...latest, [id]: d }; setDrafts((prev) => ({ ...prev, [id]: d })); }} />;
}

describe('DeliveryBrandPicker', () => {
  beforeEach(() => { db.products.mockClear(); db.rpc.mockClear(); });
  it('shows only branded lines, lists current then old stock, takes a typed brand, and splits with the full amount first', () => {
    latest = {};
    render(<Harness />);
    expect(screen.queryByText('Unbranded seed')).toBeNull();
    expect(screen.getByText('No brand picked yet.')).toBeTruthy();
    const select = screen.getByLabelText('Brand for Glyphosate 2.5') as HTMLSelectElement;
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Currently bought', 'Not currently bought (old stock)']);

    fireEvent.change(select, { target: { value: 'b1' } });
    expect(latest.L1).toEqual([expect.objectContaining({ brandId: 'b1', quantity: '' })]);

    fireEvent.click(screen.getByText(/Split: add another brand/));
    expect(latest.L1.map((p) => p.quantity)).toEqual(['10', '']);
    fireEvent.change(screen.getByLabelText('Brand for Glyphosate 2.5 (2)'), { target: { value: OTHER_BRAND } });
    fireEvent.change(screen.getByLabelText('Brand name on the jug for Brand for Glyphosate 2.5 (2)'), { target: { value: 'Credit' } });
    expect(latest.L1[1]).toEqual(expect.objectContaining({ brandId: OTHER_BRAND, typedName: 'Credit' }));

    fireEvent.click(screen.getByLabelText('Remove Brand for Glyphosate 2.5 (2)'));
    expect(latest.L1).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Brand for Glyphosate 2.5'), { target: { value: '' } });
    expect(latest.L1).toEqual([]);
  });
  it('a correction can show a delivered line whose product has no listed brands left, so it can be typed', () => {
    render(<DeliveryBrandPicker brands={brands} drafts={{}} disabled={false} fullQuantity={(l) => l.quantity}
      onChange={() => undefined} showLine={() => true} />);
    expect(screen.getByText('Unbranded seed')).toBeTruthy();
  });
  it('shows the amount of a single saved brand that covers less than the line, so a correction can fix it', () => {
    const short: DraftLines = { L1: [{ brandId: 'b1', typedName: '', typedEpa: '', typedManufacturer: '', quantity: '4' }] };
    render(<DeliveryBrandPicker brands={brands} drafts={short} disabled={false} fullQuantity={() => 5} onChange={() => undefined} />);
    expect((screen.getByLabelText('Amount of Brand for Glyphosate 2.5') as HTMLInputElement).value).toBe('4');
  });
});

const cancelled = (n: string, on: string | null) => ({ epa_registration: n, registration_status: 'cancelled', cancelled_on: on });

describe('DeliveryBrandPicker cancelled-registration warning (#1849)', () => {
  beforeEach(() => {
    db.products.mockReset().mockResolvedValue({ data: [{ id: 'P1', epa_registration: '100-200' }, { id: 'P2', epa_registration: null }], error: null });
    db.rpc.mockReset().mockImplementation(async (_n, args) => ({
      data: args.p_numbers.includes('524-475') ? [cancelled('524-475', '2025-03-01')] : [], error: null,
    }));
  });
  afterEach(() => vi.useRealTimers());

  it('warns beside a picked brand whose registration is cancelled, with the date, and never disables the pick', async () => {
    render(<Harness />);
    const select = screen.getByLabelText('Brand for Glyphosate 2.5') as HTMLSelectElement;
    await waitFor(() => expect(select.querySelector('option[value="b1"]')?.textContent).toMatch(/CANCELLED/));
    expect(screen.queryByTestId('cancelled-registration-pick')).toBeNull();
    fireEvent.change(select, { target: { value: 'b1' } });
    const alert = await screen.findByTestId('cancelled-registration-pick');
    expect(alert.textContent).toContain('Roundup: EPA Reg. No. 524-475, cancelled');
    expect(alert.textContent).toContain(new Date(2025, 2, 1).toLocaleDateString());
    expect(alert.textContent).toMatch(/not blocked/);
    expect(select.disabled).toBe(false);
    fireEvent.change(select, { target: { value: 'b2' } });
    expect(screen.queryByTestId('cancelled-registration-pick')).toBeNull();
  });

  it("warns on the line when the product's own registration is cancelled", async () => {
    db.rpc.mockResolvedValue({ data: [cancelled('100-200', null)], error: null });
    render(<Harness />);
    const alert = await screen.findByTestId('cancelled-registration-product');
    expect(alert.textContent).toContain('Glyphosate 2.5: EPA Reg. No. 100-200, cancelled (date not recorded)');
  });

  it('warns on a typed EPA number from the jug that is cancelled', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Brand for Glyphosate 2.5'), { target: { value: OTHER_BRAND } });
    fireEvent.change(screen.getByLabelText('EPA number for Brand for Glyphosate 2.5 (optional)'), { target: { value: '524-475' } });
    expect((await screen.findByTestId('cancelled-registration-pick')).textContent).toContain('Typed brand: EPA Reg. No. 524-475');
  });

  it('says it could not check when the lookup fails, never that nothing is cancelled', async () => {
    db.rpc.mockResolvedValue({ data: null, error: new Error('offline') });
    render(<Harness />);
    expect((await screen.findByTestId('registration-check-failed')).textContent).toMatch(/Could not check/);
    expect(screen.queryByTestId('cancelled-registration-pick')).toBeNull();
  });

  it('says it could not check when the product read fails', async () => {
    db.products.mockResolvedValue({ data: null, error: new Error('offline') });
    render(<Harness />);
    expect(await screen.findByTestId('registration-check-failed')).toBeTruthy();
  });

  it('says it could not check when the product read throws', async () => {
    db.products.mockRejectedValue(new Error('network down'));
    render(<Harness />);
    expect(await screen.findByTestId('registration-check-failed')).toBeTruthy();
  });

  it('says it could not check when the product read leaves a product out', async () => {
    db.products.mockResolvedValue({ data: [{ id: 'P2', epa_registration: null }], error: null });
    render(<Harness />);
    expect(await screen.findByTestId('registration-check-failed')).toBeTruthy();
  });

  it('checks the EPA number recorded on a saved pick, not only the brand’s current one (Sol r1)', async () => {
    const saved: DeliveryBrands = { ...brands, lines: [{ ...brands.lines[0], brand_list: [{ ...brands.lines[0].brand_list[0], epa_registration: '300-400' }],
      picks: [{ id: 'k1', delivery_item_id: 'L1', source: 'size', parent_brand_id: null, legacy_brand_id: 'b1', brand_name: 'Roundup', epa_registration: '524-475', manufacturer: null, quantity: 10, review_state: null }] }] };
    render(<DeliveryBrandPicker brands={saved} disabled={false} fullQuantity={(l) => l.quantity} onChange={() => undefined}
      drafts={{ L1: [{ brandId: 'b1', typedName: '', typedEpa: '', typedManufacturer: '', quantity: '' }] }} />);
    expect((await screen.findByTestId('cancelled-registration-pick')).textContent).toContain('EPA Reg. No. 524-475');
  });

  it('warns about a cancelled product on a line with no brand list (Sol r1)', async () => {
    db.rpc.mockResolvedValue({ data: [cancelled('100-200', null)], error: null });
    const unbranded: DeliveryBrands = { ...brands, lines: [{ ...brands.lines[0], brand_list: [], picks: [] }] };
    render(<DeliveryBrandsPanel busy={false} state={{ brands: unbranded, drafts: {}, setLineDraft: () => undefined, dirty: false, saving: false,
      savedAt: null, loadFailed: false, save: async () => undefined, reload: async () => undefined } as unknown as DeliveryBrandsState} />);
    expect((await screen.findByTestId('cancelled-registration-product')).textContent).toContain('Glyphosate 2.5: EPA Reg. No. 100-200');
    expect(screen.queryByText('Brands delivered')).toBeNull();
  });

  it('says it is still checking while the lookup is pending (Sol r1)', async () => {
    db.rpc.mockImplementation(() => new Promise(() => undefined));
    render(<Harness />);
    expect((await screen.findByText(/Checking EPA registration status/))).toBeTruthy();
  });

  it('a brand reload rereads the product number and its status (Sol r2)', async () => {
    const pick = { L1: [{ brandId: 'b2', typedName: '', typedEpa: '', typedManufacturer: '', quantity: '' }] };
    const props = { disabled: false, fullQuantity: (l: { quantity: number }) => l.quantity, onChange: () => undefined, drafts: pick };
    const { rerender } = render(<DeliveryBrandPicker brands={brands} {...props} />);
    await waitFor(() => expect(db.rpc).toHaveBeenCalled());
    expect(screen.queryByTestId('cancelled-registration-product')).toBeNull();
    db.products.mockResolvedValue({ data: [{ id: 'P1', epa_registration: '777-1' }, { id: 'P2', epa_registration: null }], error: null });
    db.rpc.mockResolvedValue({ data: [cancelled('777-1', '2026-11-01')], error: null });
    rerender(<DeliveryBrandPicker brands={{ ...brands }} {...props} />);
    expect((await screen.findByTestId('cancelled-registration-product')).textContent).toContain('777-1');
  });

  it('a warning once shown stays when a later lookup fails (Sol r2, Mason 2026-11-12)', async () => {
    const pick = { L1: [{ brandId: 'b1', typedName: '', typedEpa: '', typedManufacturer: '', quantity: '' }] };
    const props = { disabled: false, fullQuantity: (l: { quantity: number }) => l.quantity, onChange: () => undefined, drafts: pick };
    const { rerender } = render(<DeliveryBrandPicker brands={brands} {...props} />);
    await screen.findByTestId('cancelled-registration-pick');
    db.rpc.mockResolvedValue({ data: null, error: new Error('offline') });
    rerender(<DeliveryBrandPicker brands={{ ...brands }} {...props} />);
    await screen.findByTestId('registration-check-failed');
    expect(screen.getByTestId('cancelled-registration-pick').textContent).toContain('524-475');
  });

  it('says it could not check when the lookup never answers', async () => {
    vi.useFakeTimers();
    db.rpc.mockImplementation(() => new Promise(() => undefined));
    render(<Harness />);
    await act(async () => { await Promise.resolve(); }); // the product read answers; the registration lookup never does
    expect(screen.queryByTestId('registration-check-failed')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(15_001); });
    expect(screen.getByTestId('registration-check-failed')).toBeTruthy();
  });
});
