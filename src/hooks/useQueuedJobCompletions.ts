/**
 * Which jobs have a completion saved on this phone that is still waiting to send.
 * Reads the offline queue now and every 5 seconds (the same check the offline banner
 * runs), so a completion that sends, needs attention or is discarded drops out on its own.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getQueuedJobCompletionIds } from '../lib/offlineQueue';

const QUEUE_CHECK_MS = 5000;

function sameIds(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/** `user` is the signed-in person; only their own saved completions count. */
export function useQueuedJobCompletions(user: { id: string } | null | undefined) {
  const currentUserId = user?.id ?? null;
  const [queuedJobIds, setQueuedJobIds] = useState<Set<string>>(() => new Set());
  // Only the newest read may set state: a read that started before a completion was
  // saved must not take its job back off the list.
  const readSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const ids = await getQueuedJobCompletionIds(currentUserId);
      // Same jobs as shown: keep the same set, so the screen does not redraw every check.
      if (seq === readSeq.current) setQueuedJobIds((prev) => (sameIds(prev, ids) ? prev : ids));
    } catch {
      // Offline storage unavailable: keep what is shown; the offline banner reports storage errors.
    }
  }, [currentUserId]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), QUEUE_CHECK_MS);
    return () => {
      clearInterval(interval);
      readSeq.current += 1;
    };
  }, [refresh]);

  /** Show a just-saved completion at once, before the next queue read confirms it. */
  const markQueued = useCallback((jobId: string) => {
    readSeq.current += 1;
    setQueuedJobIds((prev) => new Set(prev).add(jobId));
    void refresh();
  }, [refresh]);

  return { queuedJobIds, markQueued };
}
