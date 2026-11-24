## 2026-11-25 — Sol skips take exact replies only (#2271)

Mason's rule, 2026-11-24: a Sol skip counts only for `skip` (all shown) or `skip 1 3` (those), with an
optional reason on a second line, logged word for word.

- Fixes #2271: `yes, skip 1` and `yes, except 2` skipped every finding. `skipFromReply` now reads only
  the exact first line; `yes, <reason>`, `I disagree`, `don't fix`, `accept` and the 2026-11-22 loose
  forms skip nothing. A reply starting with skip or yes that is not exact comes back refused, so the hook
  prints NOT SKIPPED instead of staying silent.
- The reason line passes `reasonProblem` (public log) and is recorded word for word, trimmed.
- The skip request's summary now gives the two exact replies and no longer invites a yes. Requests and
  receipts built with the old summary or an old reply no longer verify; he answers again with `skip`.
- Unchanged: carry-forward of skips, decision-log files, the reply counting in any conversation that
  showed the summary, the migration `yes`.
- Tests: `.claude/hooks/sol-accept-lib.test.mjs` (exact replies, reason line verbatim, #2271 cases,
  hook end to end); `sol-skip-carry.test.mjs` and `owner-approval-lib.test.mjs` pass unchanged.
- Decision: `docs/manual/decision-log.d/2026-11-24-sol-skip-exact-replies.md`.
