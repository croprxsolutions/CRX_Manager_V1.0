## 2026-10-28 — docs cleanup, part 1: finished audits, handoffs and plans removed

Mason asked for a docs cleanup to remove finished or no-longer-relevant documents. This part removes
35 files from `docs/audits/`, `docs/handoffs/`, `docs/plans/` and `docs/reports/` whose own headers
said the work was finished, closed, executed or replaced: branch-cleanup ledgers and plans, PR #432
handoffs, replaced Section 10/12 gauntlet drafts, finished Claude/Codex handoffs and closeouts, the
replaced product-data-model working plan, and a frozen guard-denial baseline. `docs/handoffs/` and
`docs/reports/` are now empty.

Every removed file is listed, with why it went and how to restore it from git, in
`docs/audits/2026-10-28-removed-finished-docs.md`. Mentions of removed files in the decision log,
the product-data-model plans, the gauntlet index and three older audits now say "removed 2026-10-28"
and point to that list; the frozen `KNOWN_ISSUES` history file got one header note instead.

Kept on purpose: anything a database migration, agent command, hook or script refers to, anything
outside the documentation-only folders (handled in a later part with full review), and every
idea or brainstorm document, which Mason is reviewing one by one.

Proof: a repository-wide search found no remaining reference to a removed file outside the change
log history, raw `git status` output quoted inside older audits, and the annotated mentions.
Not verified: nothing runtime changed, so there is no app behavior to observe.
