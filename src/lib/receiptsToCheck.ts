// KI-25 office list: needs_check receipts, plus owed ones still waiting after an hour. No age cut-off: an unsent
// receipt stays listed until it is sent, so a long sender outage cannot hide one (Sol, PR #1647).
// shortcut: no "mark handled" action yet, so a needs_check row the office already dealt with stays listed and a
// worker retry is not paused by a manual send; add a close RPC (its own migration PR) before the KI-25 app switch.
export const RECEIPTS_TO_CHECK_PAGE = 50;

export function receiptsToCheckFilter(now: Date) {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  return `status.eq.needs_check,and(status.in.(pending,sending),created_at.lt."${hourAgo}")`;
}
