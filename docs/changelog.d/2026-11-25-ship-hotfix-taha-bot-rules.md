## 2026-11-25 — ship.md: hotfix label timing, Taha bot on hotfixes, release-gate re-run

Agents kept hitting the same hotfix traps today (#2533, #2554, #2568, #2573), so `ship.md` now says:

- **`hotfix-backport` follows the latest push** (`release-flow.mjs` `backportAllowed`): any push, even a merge
  of `main`, needs Taha to remove and re-add it. That guard failure is not a code bug; no push fixes it.
- **Updating a hotfix from `main` keeps Taha's Approve** (seen on #2573); check the reviews before saying otherwise.
- **release-gate on hotfixes** has its own queue since #2573; if it still never posts, re-run the PR's current
  `Release flow guard (main)` run, never an older one.
- **Taha ready bot** runs from `main` after each CI run (the 30-minute schedule fires only every few hours) and,
  from the release that carries #2589, asks Taha about hotfixes (Approve + label, or the label alone).
