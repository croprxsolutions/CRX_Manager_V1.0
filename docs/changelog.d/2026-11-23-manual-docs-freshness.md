## 2026-11-23 - Manual docs: freshness stamp after the 20261123 migrations came due

- `CURRENT_STATE.md` and `KNOWN_ISSUES.md` "Last verified" stamps move to 2026-11-23 for the live ledger only.
- Evidence: read-only `list_migrations` on production on 2026-11-23 shows the newest live row is still `20261121061349` (1,244 rows). The three `20261123*` migrations that came due today were already live since 2026-11-06 (ledger `20261106154806`, `20261106161512`, `20261106170917`), as KNOWN_ISSUES already said.
- The 28 newer migrations on staging (`20270129210000` to `20270224130000`) are not in the live ledger; the docs describe them as on staging, awaiting the production release.
- Stale statuses corrected in KNOWN_ISSUES from PRs merged to staging on 2026-11-22/23 (UTC): SOL-1 to SOL-20 resolved by #2203 (release pass removed); SOL-7 (#2201), KI-129 payments part (#2242), #2196 (#2222), #2063 (#2260), #2135 (#2224), KI-160 database part (#2219), KI-151 (#2266) and KI-197 database part (#2244) are fixed on staging, not live. The BLOCKER/HIGH summary counts follow.
- Not re-checked in this pass: other MED/LOW entries whose fixes merged to staging on 2026-11-22 (for example KI-25, KI-133, KI-182, KI-200 to KI-203) still read as open.
- Unblocks every staging PR, whose docs freshness check failed on the 2026-11-21 stamps.
