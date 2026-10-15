/**
 * Download one private staff photo with the signed-in user's session and expose it as a
 * tab-local blob: URL (see src/lib/privatePhotos.ts for why). Field-safe: a dropped connection
 * ends in a retryable error (never an endless spinner), the photo retries by itself when the
 * device comes back online, an unmount aborts the download, and the blob URL is released when
 * the photo leaves the screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/db';
import { Sentry } from '../lib/sentry';
import type { PrivatePhotoBucket } from '../lib/privatePhotos';

export type PrivatePhotoState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error' };

export interface PrivatePhoto {
  state: PrivatePhotoState;
  /** Try the download again (after a failure). */
  retry: () => void;
}

// One report per object per page load: an offline page or a missing object must not send one
// Sentry event per thumbnail per mount.
const reported = new Set<string>();

export function usePrivatePhoto(bucket: PrivatePhotoBucket, path: string | null | undefined): PrivatePhoto {
  const key = path ? `${bucket}/${path}` : '';
  const [attempt, setAttempt] = useState(0);
  // The result is tagged with the key and attempt that produced it, so a result for another path
  // (or a blob already released by an earlier effect) is never shown.
  const [loaded, setLoaded] = useState<{ tag: string; state: PrivatePhotoState } | null>(null);
  const tag = `${key}#${attempt}`;

  useEffect(() => {
    if (!path) return undefined;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const fail = (error: unknown) => {
      if (controller.signal.aborted) return;
      setLoaded({ tag, state: { status: 'error' } });
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (!offline && !reported.has(key)) {
        reported.add(key);
        Sentry.captureException(error instanceof Error ? error : new Error('Private photo download failed'), {
          level: 'warning',
          extra: { context: 'Private photo download failed', bucket },
        });
      }
    };
    supabase.storage.from(bucket).download(path, {}, { signal: controller.signal })
      .then(({ data, error }) => {
        if (controller.signal.aborted) return;
        if (error || !data) {
          // A refusal (signed out, deactivated, not allowed) or a missing file.
          fail(error ?? new Error('empty photo download'));
          return;
        }
        objectUrl = URL.createObjectURL(data);
        setLoaded({ tag, state: { status: 'ready', url: objectUrl } });
      })
      // A connection dropped mid-download rejects instead of returning an error.
      .catch(fail);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bucket, path, key, tag]);

  const failed = loaded?.tag === tag && loaded.state.status === 'error';
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // Back online after a failure: try again by itself.
  useEffect(() => {
    if (!failed) return undefined;
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [failed, retry]);

  if (!path) return { state: { status: 'error' }, retry };
  return { state: loaded?.tag === tag ? loaded.state : { status: 'loading' }, retry };
}
