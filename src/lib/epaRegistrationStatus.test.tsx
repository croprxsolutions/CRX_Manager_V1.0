import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock('./db', () => ({
  supabaseUntyped: { rpc: mockRpc },
  assertRpcResult: (data: unknown) => data,
}));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { CHECK_TIMEOUT_MS, cancelledOnText, getCancelledRegistrations, normalizeEpaRegistration, useCancelledRegistrations } from './epaRegistrationStatus';
import CancelledRegistrationBanner from '../components/products/CancelledRegistrationBanner';
import ProductBrandsSection from '../components/products/ProductBrandsSection';

const brandsRead = vi.hoisted(() => ({ fail: false }));
vi.mock('./productBrands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./productBrands')>()),
  getProductBrands: async () => { if (brandsRead.fail) throw new Error('offline'); return {
    parentId: null,
    parentName: null,
    brands: [{ id: 'b1', product_id: 'p1', brand_name: 'Slam 5.4', epa_registration: '524-475', manufacturer: null,
      is_currently_sourced: true, is_rup: null, signal_word: null, row_version: 1, created_by: 'u', updated_by: 'u',
      created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:00:00Z' }],
  }; },
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

describe('cancelled registrations', () => {
  beforeEach(() => { mockRpc.mockReset(); brandsRead.fail = false; });

  it('normalizes like the database', () => {
    expect(normalizeEpaRegistration(' 100-1234-abc ')).toBe('100-1234-ABC');
    expect(normalizeEpaRegistration('   ')).toBeNull();
    expect(normalizeEpaRegistration(null)).toBeNull();
  });

  it('never asks for every registration when there are no numbers', async () => {
    expect((await getCancelledRegistrations([null, ' ', undefined])).size).toBe(0);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('keeps only cancelled rows, keyed by the stored number', async () => {
    mockRpc.mockResolvedValue({ data: [
      { epa_registration: '524-475', registration_status: 'cancelled', cancelled_on: '2025-03-01' },
      { epa_registration: '100-885', registration_status: 'active', cancelled_on: null },
      { epa_registration: '264-849', registration_status: 'cancelled', cancelled_on: null },
    ], error: null });
    const result = await getCancelledRegistrations(['524-475', ' 524-475', '100-885', '264-849']);
    expect(mockRpc).toHaveBeenCalledWith('get_epa_registrations', { p_numbers: ['524-475', '100-885', '264-849'] });
    expect([...result]).toEqual([['524-475', '2025-03-01'], ['264-849', null]]);
  });

  it('a failed read throws instead of returning "none cancelled"', async () => {
    mockRpc.mockResolvedValue({ data: null, error: new Error('boom') });
    await expect(getCancelledRegistrations(['524-475'])).rejects.toThrow('boom');
  });

  it('banner names each cancelled number, its owner and its date, and says selling is not blocked', () => {
    render(<CancelledRegistrationBanner
      sources={[
        { label: 'This product', epaRegistration: '524-475' },
        { label: 'Brand Slam', epaRegistration: '264-849' },
        { label: 'Brand Other', epaRegistration: '100-885' },
      ]}
      cancelled={new Map([['524-475', '2025-03-01'], ['264-849', null]])}
      failed={false}
    />);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(`This product: EPA Reg. No. 524-475, ${cancelledOnText('2025-03-01')}.`);
    expect(banner).toHaveTextContent('Brand Slam: EPA Reg. No. 264-849, cancelled (date not recorded).');
    expect(banner).not.toHaveTextContent('100-885');
    expect(banner).toHaveTextContent('Selling is not blocked.');
  });

  it('banner shows nothing when none is cancelled, and a notice when the read failed', () => {
    const sources = [{ label: 'This product', epaRegistration: '524-475' }];
    const { rerender, container } = render(<CancelledRegistrationBanner sources={sources} cancelled={new Map()} failed={false} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CancelledRegistrationBanner sources={sources} cancelled={new Map()} failed />);
    expect(screen.getByRole('status')).toHaveTextContent('Could not check');
  });

  it('a failed check still shows what was found as cancelled', () => {
    render(<CancelledRegistrationBanner sources={[{ label: 'This product', epaRegistration: '524-475' }]}
      cancelled={new Map([['524-475', null]])} failed />);
    expect(screen.getByRole('alert')).toHaveTextContent('This product: EPA Reg. No. 524-475');
    expect(screen.getByRole('status')).toHaveTextContent('Could not check');
  });

  it('reports a failed brand-list read as null, never as an empty list', async () => {
    brandsRead.fail = true;
    const onBrandsChange = vi.fn();
    render(<ProductBrandsSection productId="p1" productName="X" isAdmin={false} userId="u" onBrandsChange={onBrandsChange} />);
    await waitFor(() => expect(onBrandsChange).toHaveBeenLastCalledWith(null));
    expect(onBrandsChange).toHaveBeenCalledWith(undefined);
    expect(onBrandsChange).not.toHaveBeenCalledWith([]);
  });

  it('marks a brand row on a cancelled registration and reports the loaded brands', async () => {
    const onBrandsChange = vi.fn();
    render(<ProductBrandsSection productId="p1" productName="X" isAdmin={false} userId="u"
      cancelled={new Map([['524-475', null]])} onBrandsChange={onBrandsChange} />);
    expect(await screen.findByText('cancelled (date not recorded)')).toBeInTheDocument();
    await waitFor(() => expect(onBrandsChange).toHaveBeenLastCalledWith([expect.objectContaining({ epa_registration: '524-475' })]));
  });

  it('a check with no reply shows "could not check" after the timeout', () => {
    vi.useFakeTimers();
    try {
      mockRpc.mockReturnValue(new Promise(() => {}));
      const { result } = renderHook(() => useCancelledRegistrations(['524-475']));
      expect(result.current.failed).toBe(false);
      act(() => { vi.advanceTimersByTime(CHECK_TIMEOUT_MS); });
      expect(result.current.failed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
