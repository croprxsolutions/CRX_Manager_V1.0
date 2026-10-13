## 2026-10-13 - GitHub branch cleanup audit: 191 branches measured, Sol 6.1 reviewed, records rescued before deletion

Documentation only; nothing was deleted and no code or database changed.

Mason asked to analyze every GitHub branch and remove what is useless, then had Codex `gpt-6.1-sol`
review the proposal first. The report and restore ledger are in
`docs/audits/2026-10-13-github-branch-cleanup-audit.md`.

**How it was reviewed.** A read-only 56-agent workflow measured the 185 branches not owned by an open PR.
It used investigators per topic, two skeptics per delete verdict, a prior-reports reader and a
completeness critic. Sol's advisory review returned BLOCK with 45 findings (5 HIGH). Claude agreed with
nearly all of them, revised the proposal, and recorded the changes in the report.

**Verdicts.** 177 deletable (160 after Mason's yes, 17 after this PR merges), 6 kept, 2 for Mason's
decision. Each deletion is an atomic compare-and-delete, so a newly pushed commit cannot be lost. The
deletions wait for Mason's explicit yes.

Rescued or corrected on `main`:

- **`docs/manual/DECISION_LOG.md`**
  - Mason's 2026-08-09 pricing answers. Commission clawback on returns is settled but, per a full
    live-catalog trace, not built. The entry also covers the no-backfill boundary and the below-cost
    wall's full operative rule.
  - The 2026-08-27 ingredient identity model D-AA.
  - The 2026-09-01 return-credit split entry, marked superseded by #544's close.
- **`docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md`**: PR #507's Revisions 12-13, merged in
  unchanged (a clean three-way merge), plus that PR's changelog fragment.
- **`docs/manual/KNOWN_ISSUES.md`**, new OPEN entries:
  - Two latent quote bugs (re-save refusal; Convert to Order leaving an accepted quote with no order) and a
    display-only quote cost difference, all traced on `main`. Plus the `quote_sections` grants (verified
    live) and the below-cost reason fallback.
  - A HIGH permission gap: connected MCP tools with no ask/deny rule run without a prompt (measured
    against the hooks and both settings files).
  - The review-proof forgery class, with its full limitation.
  - A small-notes list, each item with how it was checked.
  
  Existing pointers to branches on the cleanup list are reworded to stay true before and after deletion.
- **Stale references:** `docs/manual/CURRENT_STATE.md` (#605/#612/#631 closed) and one changelog citation
  repointed to PR #591.

Proof observed:
- every branch got exactly one verdict;
- 59 cited successor PRs confirmed MERGED;
- every branch re-measured at `7abd52f6d` after #893 moved `main`;
- four PR refs fetched back to their exact branch tips;
- all 23 applied migrations whose names appear on branches match `main`'s file by the live recorded-SQL
  fingerprint;
- live checks were read-only `SELECT`s.

Not verified: the 8.3 short-name route was not reproduced; the below-cost reason fallback, the Net 30
posting behavior and the return-credit prover were reasoned, not run.
