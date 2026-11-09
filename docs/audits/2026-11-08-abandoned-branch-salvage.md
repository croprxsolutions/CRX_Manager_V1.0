# Abandoned-branch salvage — 2026-11-08

Mason asked for a branch cleanup on 2026-11-08. The 146 branches were checked against `main`: 61 were
proven to be in `main` (exact file matches, or earlier drafts of merged PRs) and were deleted. Sol (gpt-6-sol, high,
advisory) then held the 28 "abandoned" branches (PR closed, or plan replaced) because no script can prove they hold
nothing useful. Four read-only readers went through all 28 against `origin/main`, and the main claims were
re-checked by hand. This file records everything worth keeping, so those branches can be deleted.

**Where the originals are.** Every deleted branch tip is in Mason's local backup bundle
`C:\Users\mason\Documents\CRX-branch-backups\branches-2026-11-08.bundle` (restore-tested: all 113 tips
matched). Branches that had a PR can also be restored from that PR's page on GitHub.
Restore one with `git fetch <bundle> refs/heads/<branch>:refs/heads/<branch>`.

## Kept as branches (not deleted)

| Branch | Tip | Why kept |
|---|---|---|
| `claude/loosen-claude-permissions-20260905` (PR #605) | `d5cc21353e` | Holds the env-guard fix (tooling-guards entry, PR #605 bullet); port it to current `main`, then delete |
| `claude/review-proof-guard-worktree-path-7639d0` (PR #1536) | `b8ae8bf6e0` | Holds KI-107's pinned test cases (Mason closed its fix on 2026-11-05); carry the tests to `main`, then delete |

## Recorded in KNOWN_ISSUES.md

| KI | What | Source branch (tip) |
|---|---|---|
| tooling-guards entry, PR #605 bullet | A gap in `env-guard`'s frontend secret-key checks (details withheld until the fix ships). (The MultiEdit gap on the same branch was already recorded and ACCEPTED on 2026-11-02.) | `claude/loosen-claude-permissions-20260905` (`d5cc21353e`) |
| KI-107 | Review-proof guard refuses a delete after `cd` into a worktree when any part of the command has `..` or a variable | `claude/review-proof-guard-worktree-path-7639d0` (`b8ae8bf6e0`) |
| KI-108 | Five products' stored stock did not match their transaction history on 2026-11-01 | `ops/integrity-report-2026-11-01` (`54cc6398b2`, PR #1230) |
| KI-109 | Product Master follow-ups named in the Wave 2 report, never filed | `pm-w2-report-tmp` (`eea6cbc139`) |
| KI-110 | Three small invoicing findings from the admin-only invoicing review | `pra-work` (`45d50f9f15`) |
| KI-111 | Field-acre billing: the real boundary-file import check owed since the June launch, plus small field-app items | `claude/docs-cleanup-3-remove-finished-v2` (`39147b255b`, PR #854) |
| KI-112 | The return-credit real-schema prover fails just after midnight UTC | `gk/return-credit-prover-baseline` (`a3ffcf76d4`, PR #1319) |

The 2026-10-13 "skip it" decision (no database season check on posting) is now in `DECISION_LOG.md`; it was only
on `pra-work`.

## Reference only (history, nothing to act on)

- **Owner sessions land their own PRs** (`pm-w2-report-tmp`). WP-PM-7's session had been told never to apply or
  merge, so nobody landed it until another session took the branch. Tell each owner session up front that it lands
  its own PR, live apply included.
- **Main's own check blocked every branch for about an hour** (`pm-w2-report-tmp`). The code-health check (#1352)
  flagged one of `main`'s own files, so every branch that merged `main` was refused until #1357.
- **Product Master Wave 2 unit audit** (`pm-w2-report-tmp`): 594 of 604 products had matching units, 8 had a blank
  Unit, 1 differed only in capital letters.
- **Merge-gate false-alarm count** (`claude/work-efficiency-analysis-e8d5a2`, `e1940f41d4`, PR #1128): across 266
  sessions, the merge gate refused 1,171 commands, about 39 of them for real (about 97% false). This is the
  evidence behind the 2026-10-30 guard reductions.
- **Folder cleanup of 2026-11-03** (`claude/folder-cleanup-audit-68b34d`, `109c385c1f`, PR #1369):
  - Backups of 47 folders are in `C:\CRX_Backups\cleanup-2026-11-03\<folder>\`: a git bundle plus a zip of
    ignored files. Restore with `git clone <backup>\repo.bundle <new-folder>`, then unzip `ignored.zip` into it.
  - Worktrees that link `node_modules` to another folder must have the link removed first (`cmd /c rmdir`).
  - Old invoice PDFs left in worktree roots may hold customer data, so those zips stay on this PC.
  - The `%TEMP%\crx-*` leak it counted (31,097 folders) was down to 165 on 2026-11-08.
- **Why a delivery completion racing a post cannot change a posted invoice** (`pra-work`). Posting locks the
  order's `order_items` rows (`guard_mono_invoice_split_billing_post`), and the completion holds those rows, so
  the two serialize or one aborts as a deadlock.
- **KI-03 screen reference** (`claude/invoicing-admin-only-20261009`, `1a2148f`): screens that hide every
  invoice action from non-admins, with tests. The rule KI-03 needs is different (hide Edit and Post on other reps'
  invoices), but these are a starting point.
- **Product Master Wave 1 report** (`loop/product-master-w1-r1-2026-11-01`): owner questions and deferred LOWs,
  now mostly landed.
- **KI-14's four Sol-blocked designs** (`claude/ki14-transfer-due-date-terms`): history only; #1556 shipped the
  redo.

## Nothing worth keeping

`claude/invoicing-admin-only-db-20261010` (an older subset of `pra-work`), `claude/send-email-followups-1302`
(shipped as #1515), both `parent-epa-correction` drafts (main landed a different design; the line-id design is
rejected in the decision log), `loop/product-master-2026-10`, `loop/product-master-w2-r2-2026-11-02` (a subset of
`pm-w2-report-tmp`), `claude/docs-cleanup-3-remove-finished` (a subset of v2),
`claude/docs-cleanup-revert-rule-wording-20261014` (older wording that is now wrong), `claude/undici-audit-fix` and
`claude/audit-brace-expansion-fast-uri` (main has newer versions), `claude/last-charged-prices-applied-records`,
`claude/cost-exposure-rekey-ki100`, `claude/sweep-rekey-batch4b` (all landed), `claude/gallant-jackson-b07f96`,
`claude/review-proof-guard-read-only-narrowing` (the goal landed another way; KI-46 has the finding),
`claude/wonderful-banach-755ecb` (landed as #1353).

**Limits.** "Not on main" rests on keyword searches of `main`'s docs, so an item recorded in different words may
have been missed. Nothing was checked against the live database.
