## 2026-11-26 — Two more agent tests no longer fail on a slow PC

Mason: false-alarm test failures cost 20+ minutes of reruns per PR. These are the last two known flaky checks
from the PR #2634 work.

- `.codex/hooks/production-action-guard.test.mjs`: "gh binary matching stays linear" now measures growth the same
  way as the word-splitting check below it (750 vs 6,000 repeats, fastest of 5, fail at 24x growth, 5-second
  backstop) instead of a 250ms wall-clock cap. Real code grows 3–9x; a temporary quadratic loop in
  `ghBinaryMentioned` failed it at 73x. The shared timing helper moved up so both checks use it.
- `.claude/hooks/session-context-reminder.mjs`: the stale-guards warning made three `git` calls with 1 second each;
  if any one ran long the warning silently vanished. That was the 2026-11-26 flake (measured under load: one call
  took 1.3s). The three calls now share one 3-second budget, the same worst case as before, so one slow call no
  longer drops the warning. The test reads both phrases from one hook run instead of two.
- Proven backwards: removing "Follow the gate anyway" from the warning, or shrinking the budget to 1ms, fails the
  reminder test; both reverted.
