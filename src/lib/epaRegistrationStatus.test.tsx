import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock('./db', () => ({
  supabaseUntyped: { rpc: mockRpc },
  assertRpcResult: (data: unknown) => data,
}));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import {
  CHECK_TIMEOUT_MS,
  cancelledOnText,
  getCancelledRegistrations,
  normalizeEpaRegistration,
  registrationCheck,
  useCancelledRegistrations,
  type BrandListState,
  type LookupState,
  type RegistrationCheck,
} from './epaRegistrationStatus';
import CancelledRegistrationBanner from '../components/products/CancelledRegistrationBanner';
import ProductBrandsSection from '../components/products/ProductBrandsSection';

const brandsRead = vi.hoisted(() => ({ fail: false }));
vi.mock('./productBrands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./productBrands')>()),
  getProductBrands: async () => {
    if (brandsRead.fail) throw new Error('offline');
    return {
      parentId: null,
      parentName: null,
      brands: [{ id: 'b1', product_id: 'p1', brand_name: 'Slam 5.4', epa_registration: '524-475', manufacturer: null,
        is_currently_sourced: true, is_rup: null, signal_word: null, row_version: 1, created_by: 'u', updated_by: 'u',
        created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:00:00Z' }],
    };
  },
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const cancelledRow = (n: string, on: string | null = null) => ({ epa_registration: n, registration_status: 'cancelled', cancelled_on: on });
const reply = (rows: unknown[]) => ({ data: rows, error: null });

describe('getCancelledRegistrations', () => {
  beforeEach(() => mockRpc.mockReset());

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
    mockRpc.mockResolvedValue(reply([
      cancelledRow('524-475', '2025-03-01'),
      { epa_registration: '100-885', registration_status: 'active', cancelled_on: null },
      { epa_registration: '7-1', registration_status: 'unknown', cancelled_on: null },
      cancelledRow('264-849'),
    ]));
    const result = await getCancelledRegistrations(['524-475', ' 524-475', '100-885', '7-1', '264-849']);
    expect(mockRpc).toHaveBeenCalledWith('get_epa_registrations', { p_numbers: ['524-475', '100-885', '7-1', '264-849'] });
    expect([...result]).toEqual([['524-475', '2025-03-01'], ['264-849', null]]);
  });

  it('a failed read throws instead of returning "none cancelled"', async () => {
    mockRpc.mockResolvedValue({ data: null, error: new Error('boom') });
    await expect(getCancelledRegistrations(['524-475'])).rejects.toThrow('boom');
  });
});

describe('registrationCheck: every combination of product, brand list and lookup', () => {
  const brands: BrandListState[] = ['loading', 'slow', 'loaded', 'failed'];
  const lookups: LookupState[] = ['checking', 'done', 'failed'];
  const expected = (productLoaded: boolean, b: BrandListState, l: LookupState): RegistrationCheck => {
    if (!productLoaded) return 'checking';
    if (b === 'failed' || b === 'slow' || l === 'failed') return 'incomplete';
    if (b === 'loading' || l === 'checking') return 'checking';
    return 'complete';
  };
  for (const productLoaded of [false, true]) {
    for (const b of brands) {
      for (const l of lookups) {
        it(`product ${productLoaded ? 'loaded' : 'loading'}, brands ${b}, lookup ${l} -> ${expected(productLoaded, b, l)}`, () => {
          expect(registrationCheck(productLoaded, b, l)).toBe(expected(productLoaded, b, l));
        });
      }
    }
  }

  it('says "complete" only when everything answered', () => {
    const complete = [false, true].flatMap((p) => brands.flatMap((b) => lookups.filter((l) => registrationCheck(p, b, l) === 'complete').map((l) => `${p}/${b}/${l}`)));
    expect(complete).toEqual(['true/loaded/done']);
  });
});

describe('useCancelledRegistrations', () => {
  beforeEach(() => { mockRpc.mockReset(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('no numbers: done at once, nothing asked', async () => {
    const { result } = renderHook(() => useCancelledRegistrations([null, '']));
    await act(async () => {});
    expect(result.current.lookup).toBe('done');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('pending, then answered: checking, then done with the cancelled set', async () => {
    let answer!: (v: unknown) => void;
    mockRpc.mockReturnValue(new Promise((r) => { answer = r; }));
    const { result } = renderHook(() => useCancelledRegistrations(['524-475']));
    expect(result.current.lookup).toBe('checking');
    await act(async () => { answer(reply([cancelledRow('524-475')])); });
    expect(result.current).toEqual({ key: '524-475', lookup: 'done', cancelled: new Map([['524-475', null]]) });
  });

  it('failed read: failed', async () => {
    mockRpc.mockResolvedValue({ data: null, error: new Error('offline') });
    const { result } = renderHook(() => useCancelledRegistrations(['524-475']));
    await act(async () => {});
    expect(result.current.lookup).toBe('failed');
  });

  it('no reply: failed after the timeout; a late reply still lands', async () => {
    let answer!: (v: unknown) => void;
    mockRpc.mockReturnValue(new Promise((r) => { answer = r; }));
    const { result } = renderHook(() => useCancelledRegistrations(['524-475']));
    act(() => { vi.advanceTimersByTime(CHECK_TIMEOUT_MS - 1); });
    expect(result.current.lookup).toBe('checking');
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.lookup).toBe('failed');
    await act(async () => { answer(reply([cancelledRow('524-475')])); });
    expect(result.current.lookup).toBe('done');
    expect(result.current.cancelled.has('524-475')).toBe(true);
  });

  it('numbers change: the old answer is never shown for the new numbers, and a late old reply is dropped', async () => {
    const answers: ((v: unknown) => void)[] = [];
    mockRpc.mockImplementation(() => new Promise((r) => { answers.push(r); }));
    const { result, rerender } = renderHook(({ n }) => useCancelledRegistrations(n), { initialProps: { n: ['524-475'] } });
    rerender({ n: ['100-885'] });
    expect(result.current.lookup).toBe('checking');
    await act(async () => { answers[0](reply([cancelledRow('524-475')])); });
    expect(result.current.lookup).toBe('checking');
    expect(result.current.cancelled.size).toBe(0);
  });

  it('A, then B, then back to A: A\'s earlier answer is not reused while its new check hangs', async () => {
    const answers: ((v: unknown) => void)[] = [];
    mockRpc.mockImplementation(() => new Promise((r) => { answers.push(r); }));
    const { result, rerender } = renderHook(({ n }) => useCancelledRegistrations(n), { initialProps: { n: ['524-475'] } });
    await act(async () => { answers[0](reply([])); });
    expect(result.current.lookup).toBe('done');
    rerender({ n: ['100-885'] });
    rerender({ n: ['524-475'] });
    expect(result.current.lookup).toBe('checking');
    act(() => { vi.advanceTimersByTime(CHECK_TIMEOUT_MS); });
    expect(result.current.lookup).toBe('failed');
  });
});

describe('CancelledRegistrationBanner: what each check state shows', () => {
  const product = { label: 'This product', epaRegistration: '524-475' };
  const brand = { label: 'Brand Slam', epaRegistration: '264-849' };
  const other = { label: 'Brand Other', epaRegistration: '100-885' };
  const cancelled = new Map([['524-475', '2025-03-01'], ['264-849', null]]);

  it('complete, none cancelled: shows nothing', () => {
    const { container } = render(<CancelledRegistrationBanner sources={[other]} cancelled={new Map()} check="complete" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('complete, some cancelled: names each number, its owner and date; selling not blocked; no notice', () => {
    render(<CancelledRegistrationBanner sources={[product, brand, other]} cancelled={cancelled} check="complete" />);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(`This product: EPA Reg. No. 524-475, ${cancelledOnText('2025-03-01')}.`);
    expect(banner).toHaveTextContent('Brand Slam: EPA Reg. No. 264-849, cancelled (date not recorded).');
    expect(banner).not.toHaveTextContent('100-885');
    expect(banner).toHaveTextContent('Selling is not blocked.');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('checking, none found yet: says it is checking', () => {
    render(<CancelledRegistrationBanner sources={[other]} cancelled={new Map()} check="checking" />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking EPA registration status');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('checking, one already found: shows it', () => {
    render(<CancelledRegistrationBanner sources={[product]} cancelled={cancelled} check="checking" />);
    expect(screen.getByRole('alert')).toHaveTextContent('This product: EPA Reg. No. 524-475');
  });

  it('incomplete, none found: says it could not check', () => {
    render(<CancelledRegistrationBanner sources={[other]} cancelled={new Map()} check="incomplete" />);
    expect(screen.getByRole('status')).toHaveTextContent('Could not check whether all of this product');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('incomplete, one found: shows it and says it could not check the rest', () => {
    render(<CancelledRegistrationBanner sources={[product]} cancelled={cancelled} check="incomplete" />);
    expect(screen.getByRole('alert')).toHaveTextContent('This product: EPA Reg. No. 524-475');
    expect(screen.getByRole('status')).toHaveTextContent('Could not check');
  });
});

describe('ProductBrandsSection reporting', () => {
  beforeEach(() => { brandsRead.fail = false; });

  it('marks a brand row on a cancelled registration and reports loading, then the brands', async () => {
    const onBrandsChange = vi.fn();
    render(<ProductBrandsSection productId="p1" productName="X" isAdmin={false} userId="u"
      cancelled={new Map([['524-475', null]])} onBrandsChange={onBrandsChange} />);
    expect(await screen.findByText('cancelled (date not recorded)')).toBeInTheDocument();
    expect(onBrandsChange).toHaveBeenCalledWith('p1', undefined);
    await waitFor(() => expect(onBrandsChange).toHaveBeenLastCalledWith('p1', [expect.objectContaining({ epa_registration: '524-475' })]));
  });

  it('reports a failed brand-list read as null, never as an empty list', async () => {
    brandsRead.fail = true;
    const onBrandsChange = vi.fn();
    render(<ProductBrandsSection productId="p1" productName="X" isAdmin={false} userId="u" onBrandsChange={onBrandsChange} />);
    await waitFor(() => expect(onBrandsChange).toHaveBeenLastCalledWith('p1', null));
    expect(onBrandsChange).not.toHaveBeenCalledWith('p1', []);
  });
});
