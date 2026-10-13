## 2026-10-13 - GitHub branch cleanup audit: 189 branches measured, records rescued before deletion

Documentation only; nothing was deleted and no code or database changed.

Mason asked to analyze every GitHub branch and remove what is useless. A read-only 56-agent workflow
(investigators per topic, two skeptics each, a prior-reports reader and a completeness critic) measured
all 189 non-`main` branches. The report and restore ledger are in
`docs/audits/2026-10-13-github-branch-cleanup-audit.md`. Its verdicts: 178 deletable (166 now, 12 after
this PR), 5 kept, 2 for Mason's decision, plus 4 open-PR branches. The deletions themselves wait for
Mason's explicit yes.

Records that existed only on branches about to be removed, now on `main`:

- `docs/manual/DECISION_LOG.md`: Mason's 2026-08-09 pricing answers (commission clawback on returns,
  which is not built; no backfill; per-product margin targets; the below-cost wall) and the 2026-08-27
  ingredient identity model D-AA. The 2026-09-01 return-credit split entry is marked superseded by
  #544's close.
- `docs/manual/KNOWN_ISSUES.md`: three OPEN entries.
  - A latent quote re-save refusal (QuoteBuilder sends no line ids; checked live, no quote affected).
  - `quote_sections` TRUNCATE/TRIGGER/REFERENCES grants (verified live) and the below-cost reason
    fallback.
  - An unlisted MCP tool running with no prompt, plus write-time guards that skip `MultiEdit`
    (verified on `main`).
  - A review proof readable and rewritable through a Windows 8.3 short name (from PR #612, not re-run).
  
  The F1, F3, section1 and `adjust_inventory` lap pointers now name the tag or PR that keeps each branch.
- `docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md`: a header note saying Revisions 12-13 never
  merged and pointing to D-AA.

Proof observed: every branch got exactly one verdict (critic cross-check against the live branch list);
61 cited successor PRs confirmed MERGED; 8 delete verdicts re-run end to end; no branch tip moved during
the audit; read-only live queries for the quote and grant findings. Not verified: the 8.3 short-name
route was not reproduced on 2026-10-13; the below-cost reason fallback was not re-measured.
