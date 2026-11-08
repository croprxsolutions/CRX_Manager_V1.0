// KI-25 office list: needs_check receipts, plus owed ones still waiting after an hour, from the last 14 days.
// shortcut: no "mark handled" action; rows age off after 14 days. Add a close RPC if the list gets noisy.
const WINDOW_DAYS = 14;
// shortcut: newest 50 only, with a "more than fit" notice; 50 unsent receipts in 14 days means the sender is down,
// which the notice already says. Add paging if real volume ever gets near it.
export const RECEIPTS_TO_CHECK_LIMIT = 50;

export function receiptsToCheckFilter(now: Date) {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return { or: `status.eq.needs_check,and(status.in.(pending,sending),created_at.lt."${hourAgo}")`, since };
}
