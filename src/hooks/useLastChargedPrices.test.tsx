import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchLastChargedPrices: vi.fn(), captureException: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../lib/lastChargedPrices', () => ({ fetchLastChargedPrices: mocks.fetchLastChargedPrices }));

import { useLastChargedPrices } from './useLastChargedPrices';

const lines = [{ productId: 'p1', productName: 'A' }, { productId: 'p2', productName: 'B' }, { productId: 'p1', productName: 'A' }];

describe('useLastChargedPrices', () => {
  beforeEach(() => {
    mocks.fetchLastChargedPrices.mockReset();
    mocks.fetchLastChargedPrices.mockResolvedValue(new Map());
  });

  it('loads once on mount for the distinct products, and not again on a re-render with the same set', async () => {
    const { result, rerender } = renderHook(({ l }) => useLastChargedPrices('c1', l), { initialProps: { l: lines } });
    await waitFor(() => expect(result.current.state.status).toBe('loaded'));
    expect(mocks.fetchLastChargedPrices).toHaveBeenCalledWith('c1', ['p1', 'p2']);
    rerender({ l: [...lines] });
    expect(mocks.fetchLastChargedPrices).toHaveBeenCalledTimes(1);
    expect(result.current.products).toHaveLength(2);
  });

  it('shows loading at once for a new customer or product set, and refetches', async () => {
    const { result, rerender } = renderHook(({ c, l }) => useLastChargedPrices(c, l), { initialProps: { c: 'c1', l: lines } });
    await waitFor(() => expect(result.current.state.status).toBe('loaded'));
    rerender({ c: 'c2', l: lines });
    expect(result.current.state.status).toBe('loading');
    await waitFor(() => expect(result.current.state.status).toBe('loaded'));
    expect(mocks.fetchLastChargedPrices).toHaveBeenLastCalledWith('c2', ['p1', 'p2']);
  });

  it('does nothing when disabled, without a customer, or without products', () => {
    renderHook(() => useLastChargedPrices('c1', lines, false));
    renderHook(() => useLastChargedPrices('', lines));
    renderHook(() => useLastChargedPrices('c1', []));
    expect(mocks.fetchLastChargedPrices).not.toHaveBeenCalled();
  });

  it('reports a failed load and retries', async () => {
    mocks.fetchLastChargedPrices.mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useLastChargedPrices('c1', lines));
    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.state.status).toBe('loaded'));
    expect(mocks.fetchLastChargedPrices).toHaveBeenCalledTimes(2);
  });
});
