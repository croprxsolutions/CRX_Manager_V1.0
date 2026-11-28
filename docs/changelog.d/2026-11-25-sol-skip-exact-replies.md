## 2026-11-25 — Sol skips take exact one-line replies only (#2271)

Mason's rule, 2026-11-24: a Sol skip counts only for `skip` (all shown) or `skip 1 3` (those). The
optional reason line he also allowed was dropped on 2026-11-25 (Taha) after Sol showed it could
narrow or widen the skip; the log keeps its fixed sentence.

- Fixes #2271: `yes, skip 1` and `yes, except 2` skipped every finding. `skipFromReply` now takes only
  the exact one-line reply; `yes, <reason>`, `I disagree`, `don't fix`, `accept`, the 2026-11-22 loose
  forms and any second non-blank line skip nothing (blank lines are ignored). A reply starting with skip or yes that is not exact comes back
  refused, so the hook prints NOT SKIPPED instead of staying silent. Vertical tab and form feed count as
  line breaks.
- The skip request's summary now gives the two exact replies and no longer invites a yes or a reason.
  Requests and receipts built with the old summary or an old reply no longer verify: run
  `owner-accept-sol-finding.mjs` again for only the findings still open, show him the fresh summary,
  and he answers again (`skip`, or `skip` and the numbers).
- Unchanged: carry-forward of skips, decision-log files, the reply counting in any conversation that
  showed the summary, the migration `yes`.
- Tests: `.claude/hooks/sol-accept-lib.test.mjs` (exact replies, #2271 cases, second lines refused,
  hook end to end); `sol-skip-carry.test.mjs` and `owner-approval-lib.test.mjs` pass unchanged.
- Decision: `docs/manual/decision-log.d/2026-11-24-sol-skip-exact-replies.md`.
