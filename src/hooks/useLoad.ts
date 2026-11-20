import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { sanitizeError } from '../lib/errorSanitizer';
import { Sentry } from '../lib/sentry';
import { useLatestRef } from './useLatestRef';

export type LoadState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'failed'; error: unknown }
  // stale: the last refresh failed, so `data` may be out of date; it clears only when a refresh succeeds.
  | { status: 'loaded'; data: T; refreshing: boolean; stale: boolean };

export type ReloadResult<T> =
  | { status: 'applied'; data: T }
  | { status: 'failed'; error: unknown }
  // A newer read started, the key went null, or the screen closed (reload after unmount reads nothing).
  | { status: 'skipped' };

export interface LoadOptions {
  /** Same record, read again: a change keeps the shown data, marked refreshing. */
  refreshToken?: unknown;
  /** Sentry tags/extra for a failed read (keep the screen's existing names), or false to not report. */
  report?: false | { tags?: Record<string, string>; extra?: Record<string, unknown> };
}

// token: the refreshToken the data was read for, so a new token shows refreshing at once.
type Stored<T> = { key: string; token: unknown } & Exclude<LoadState<T>, { status: 'idle' }>;
type Pending<T> = { generation: number; resolve: (result: ReloadResult<T>) => void };

/**
 * Read data for a screen (pilot, docs/plans/2026-11-20-shared-data-loading-product-pilot.md).
 * `key` names the record (null = do not read); a new key drops the old data at once. Only the newest
 * request's answer is used. `load` gets `isCurrent()` to check before starting any later request.
 * Call `reload` from handlers or effects, not layout effects (it reads the committed key).
 */
export function useLoad<T>(
  key: string | null,
  load: (isCurrent: () => boolean) => Promise<T>,
  options: LoadOptions = {},
): LoadState<T> & { reload: () => Promise<ReloadResult<T>> } {
  const { refreshToken, report } = options;
  const [stored, setStored] = useState<Stored<T> | null>(null);
  const generation = useRef(0);
  const pending = useRef<Pending<T> | null>(null);
  const mounted = useRef(false);
  const keyRef = useLatestRef(key);
  const tokenRef = useLatestRef(refreshToken);
  const loadRef = useLatestRef(load);
  const reportRef = useLatestRef(report);

  const invalidate = useCallback(() => {
    generation.current += 1;
    pending.current?.resolve({ status: 'skipped' });
    pending.current = null;
  }, []);

  const start = useCallback((readKey: string): Promise<ReloadResult<T>> => {
    invalidate();
    const mine = generation.current;
    const isCurrent = () => generation.current === mine;
    const token = tokenRef.current;
    setStored((s) => (s?.key === readKey && s.status === 'loaded'
      ? { ...s, token, refreshing: true }
      : { key: readKey, token, status: 'loading' }));
    return new Promise((resolve) => {
      pending.current = { generation: mine, resolve };
      const settle = (result: ReloadResult<T>) => {
        if (!isCurrent()) return; // already resolved as skipped by whatever superseded it
        pending.current = null;
        if (result.status === 'applied') {
          setStored({ key: readKey, token, status: 'loaded', data: result.data, refreshing: false, stale: false });
        } else if (result.status === 'failed') {
          const how = reportRef.current;
          if (how !== false) {
            const error = result.error instanceof Error ? result.error : new Error(sanitizeError(result.error));
            Sentry.captureException(error, { tags: how?.tags, extra: how?.extra });
          }
          setStored((s) => (s?.key === readKey && s.status === 'loaded'
            ? { ...s, refreshing: false, stale: true }
            : { key: readKey, token, status: 'failed', error: result.error }));
        }
        resolve(result);
      };
      let read: Promise<T>;
      try {
        read = Promise.resolve(loadRef.current(isCurrent));
      } catch (error) {
        read = Promise.reject(error);
      }
      read.then((data) => settle({ status: 'applied', data }), (error: unknown) => settle({ status: 'failed', error }));
    });
  }, [invalidate, loadRef, reportRef, tokenRef]);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // A key or token change, and unmount, end the old request's authority at commit, before the next read starts.
  useLayoutEffect(() => invalidate, [key, refreshToken, invalidate]);

  useEffect(() => {
    if (key === null) { setStored(null); return; }
    void start(key);
  }, [key, refreshToken, start]);

  const reload = useCallback(async (): Promise<ReloadResult<T>> => {
    const current = keyRef.current;
    // After unmount nobody shows the answer, so read nothing.
    return current === null || !mounted.current ? { status: 'skipped' } : start(current);
  }, [keyRef, start]);

  if (key === null) return { status: 'idle', reload };
  if (!stored || stored.key !== key) return { status: 'loading', reload };
  if (stored.status !== 'loaded') return stored.status === 'failed' ? { status: 'failed', error: stored.error, reload } : { status: 'loading', reload };
  const { data, stale } = stored;
  return { status: 'loaded', data, stale, refreshing: stored.refreshing || stored.token !== refreshToken, reload };
}
