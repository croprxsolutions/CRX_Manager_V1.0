import { StrictMode, createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));

import { useLoad, type LoadOptions, type ReloadResult } from './useLoad';

// A read the test settles by hand, in any order.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Read = ReturnType<typeof deferred<string>>;

// Each call to the loader opens a new deferred read, recorded with the key it was asked for.
function harness() {
  const reads: { key: string | null; read: Read; isCurrent: () => boolean }[] = [];
  const loaderFor = (key: string | null) => (isCurrent: () => boolean) => {
    const read = deferred<string>();
    reads.push({ key, read, isCurrent });
    return read.promise;
  };
  return { reads, loaderFor };
}

type Props = { k: string | null; token?: number; options?: LoadOptions };

function setup(initial: Props, wrapper?: (props: { children: ReactNode }) => ReactNode) {
  const h = harness();
  const hook = renderHook(
    ({ k, token, options }: Props) => useLoad(k, h.loaderFor(k), { ...options, refreshToken: token }),
    { initialProps: initial, wrapper },
  );
  return { ...h, ...hook };
}

describe('useLoad', () => {
  beforeEach(() => { mocks.captureException.mockReset(); });

  it('loads, then shows the data', async () => {
    const { result, reads } = setup({ k: 'A' });
    expect(result.current.status).toBe('loading');
    await act(async () => { reads[0].read.resolve('a1'); });
    expect(result.current).toMatchObject({ status: 'loaded', data: 'a1', refreshing: false, stale: false });
  });

  it('counts a null answer as loaded', async () => {
    const { result } = renderHook(() => useLoad('A', () => Promise.resolve(null)));
    await waitFor(() => expect(result.current).toMatchObject({ status: 'loaded', data: null }));
  });

  it('ignores an older success that settles after a newer read', async () => {
    const { result, reads } = setup({ k: 'A' });
    let second!: Promise<ReloadResult<string>>;
    let first!: Promise<ReloadResult<string>>;
    await act(async () => { first = result.current.reload(); });
    await act(async () => { second = result.current.reload(); });
    expect(reads).toHaveLength(3);
    await act(async () => { reads[2].read.resolve('newest'); });
    await act(async () => { reads[1].read.resolve('older'); reads[0].read.resolve('oldest'); });
    expect(result.current).toMatchObject({ status: 'loaded', data: 'newest' });
    await expect(first).resolves.toEqual({ status: 'skipped' });
    await expect(second).resolves.toEqual({ status: 'applied', data: 'newest' });
  });

  it('ignores an older failure: no state change and no Sentry report', async () => {
    const { result, reads } = setup({ k: 'A' });
    await act(async () => { void result.current.reload(); });
    await act(async () => { reads[1].read.resolve('fresh'); });
    await act(async () => { reads[0].read.reject(new Error('old')); });
    expect(result.current).toMatchObject({ status: 'loaded', data: 'fresh', stale: false });
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('releases a superseded reload at once, even if its read never settles', async () => {
    const { result } = setup({ k: 'A' });
    let first!: Promise<ReloadResult<string>>;
    await act(async () => { first = result.current.reload(); });
    await act(async () => { void result.current.reload(); });
    await expect(first).resolves.toEqual({ status: 'skipped' });
  });

  it('shows loading at once for a new key and never the old data', async () => {
    const { result, reads, rerender } = setup({ k: 'A' });
    await act(async () => { reads[0].read.resolve('a1'); });
    rerender({ k: 'B' });
    expect(result.current.status).toBe('loading');
    await act(async () => { reads[1].read.resolve('b1'); });
    expect(result.current).toMatchObject({ status: 'loaded', data: 'b1' });
  });

  it('ignores an answer for the old key that settles after the key changed', async () => {
    const { result, reads, rerender } = setup({ k: 'A' });
    rerender({ k: 'B' });
    expect(reads[0].isCurrent()).toBe(false);
    await act(async () => { reads[0].read.resolve('a-late'); });
    expect(result.current.status).toBe('loading');
    await act(async () => { reads[1].read.resolve('b1'); });
    expect(result.current).toMatchObject({ data: 'b1' });
  });

  it('A, then B, then back to A shows loading until a new A read returns', async () => {
    const { result, reads, rerender } = setup({ k: 'A' });
    await act(async () => { reads[0].read.resolve('a-first'); });
    rerender({ k: 'B' });
    rerender({ k: 'A' });
    expect(result.current.status).toBe('loading');
    await act(async () => { reads[1].read.resolve('b-late'); });
    expect(result.current.status).toBe('loading');
    await act(async () => { reads[2].read.resolve('a-second'); });
    expect(result.current).toMatchObject({ status: 'loaded', data: 'a-second' });
  });

  it('a new refreshToken keeps the data, shows refreshing in the same render, and ignores the older read', async () => {
    const { result, reads, rerender } = setup({ k: 'A', token: 0 });
    await act(async () => { reads[0].read.resolve('a1'); });
    let older!: Promise<ReloadResult<string>>;
    await act(async () => { older = result.current.reload(); });
    rerender({ k: 'A', token: 1 });
    expect(result.current).toMatchObject({ status: 'loaded', data: 'a1', refreshing: true });
    expect(reads[1].isCurrent()).toBe(false);
    await expect(older).resolves.toEqual({ status: 'skipped' });
    await act(async () => { reads[1].read.resolve('stale-answer'); });
    expect(result.current).toMatchObject({ data: 'a1', refreshing: true });
    await act(async () => { reads[2].read.resolve('a2'); });
    expect(result.current).toMatchObject({ status: 'loaded', data: 'a2', refreshing: false });
  });

  it('a failed refresh keeps the data marked stale until a refresh succeeds', async () => {
    const { result, reads } = setup({ k: 'A', options: { report: { extra: { context: 'ctx' } } } });
    await act(async () => { reads[0].read.resolve('a1'); });
    let outcome!: Promise<ReloadResult<string>>;
    await act(async () => { outcome = result.current.reload(); });
    expect(result.current).toMatchObject({ data: 'a1', refreshing: true, stale: false });
    const error = new Error('down');
    await act(async () => { reads[1].read.reject(error); });
    await expect(outcome).resolves.toEqual({ status: 'failed', error });
    expect(result.current).toMatchObject({ status: 'loaded', data: 'a1', refreshing: false, stale: true });
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).toHaveBeenCalledWith(error, { tags: undefined, extra: { context: 'ctx' } });
    await act(async () => { void result.current.reload(); });
    expect(result.current).toMatchObject({ stale: true, refreshing: true });
    await act(async () => { reads[2].read.resolve('a2'); });
    expect(result.current).toMatchObject({ data: 'a2', stale: false });
  });

  it('a first read that fails reports once and offers a retry', async () => {
    const { result, reads } = setup({ k: 'A' });
    await act(async () => { reads[0].read.reject({ message: 'permission denied', code: '42501' }); });
    expect(result.current.status).toBe('failed');
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureException.mock.calls[0][0]).toBeInstanceOf(Error);
    await act(async () => { void result.current.reload(); });
    expect(result.current.status).toBe('loading');
  });

  it('report: false keeps a failure out of Sentry', async () => {
    const { result, reads } = setup({ k: 'A', options: { report: false } });
    await act(async () => { reads[0].read.reject(new Error('x')); });
    expect(result.current.status).toBe('failed');
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('a loader that throws before returning a promise is a failure', async () => {
    const { result } = renderHook(() => useLoad('A', () => { throw new Error('bad input'); }));
    await waitFor(() => expect(result.current.status).toBe('failed'));
  });

  it('a null key is idle: no reads, reload skipped, and old data does not come back', async () => {
    const { result, reads, rerender } = setup({ k: 'A' });
    await act(async () => { reads[0].read.resolve('a1'); });
    rerender({ k: null });
    expect(result.current.status).toBe('idle');
    await expect(result.current.reload()).resolves.toEqual({ status: 'skipped' });
    expect(reads).toHaveLength(1);
    rerender({ k: 'A' });
    expect(result.current.status).toBe('loading');
  });

  it('a null key ends an in-flight read', async () => {
    const { result, reads, rerender } = setup({ k: 'A' });
    rerender({ k: null });
    await act(async () => { reads[0].read.resolve('late'); });
    expect(result.current.status).toBe('idle');
  });

  it('a reload kept from before a key change reads the current key', async () => {
    const { result, reads, rerender } = setup({ k: 'A' });
    const kept = result.current.reload;
    rerender({ k: 'B' });
    await act(async () => { void kept(); });
    expect(reads.at(-1)?.key).toBe('B');
  });

  it('unmount mid-read: the late answer is ignored and the waiting caller is released', async () => {
    const { result, reads, unmount } = setup({ k: 'A' });
    let outcome!: Promise<ReloadResult<string>>;
    await act(async () => { outcome = result.current.reload(); });
    unmount();
    await expect(outcome).resolves.toEqual({ status: 'skipped' });
    await act(async () => { reads[1].read.reject(new Error('late')); });
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('an inline loader does not cause a read loop', async () => {
    let calls = 0;
    const { result, rerender } = renderHook(() => useLoad('A', () => { calls += 1; return Promise.resolve(calls); }));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    rerender();
    rerender();
    expect(calls).toBe(1);
  });

  it('under Strict Mode only the last of the doubled reads counts', async () => {
    const strict = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);
    const { result, reads } = setup({ k: 'A' }, strict);
    expect(reads.length).toBeGreaterThanOrEqual(1);
    const last = reads.at(-1)!;
    for (const r of reads.slice(0, -1)) expect(r.isCurrent()).toBe(false);
    await act(async () => { for (const r of reads.slice(0, -1)) r.read.resolve('discarded'); });
    expect(result.current.status).toBe('loading');
    await act(async () => { last.read.resolve('kept'); });
    expect(result.current).toMatchObject({ status: 'loaded', data: 'kept' });
  });
  it('reload after unmount reads nothing and is skipped', async () => {
    const { result, reads, unmount } = setup({ k: 'A' });
    const kept = result.current.reload;
    unmount();
    await expect(kept()).resolves.toEqual({ status: 'skipped' });
    expect(reads).toHaveLength(1);
  });
});
