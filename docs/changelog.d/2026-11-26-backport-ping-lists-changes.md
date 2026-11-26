## 2026-11-26 — Taha bot: the hotfix-backport ask lists what the hotfix brings to live

Taha asked (2026-11-26) to see exactly what goes live when the bot asks him for `hotfix-backport`.
The ping (`.github/scripts/taha-ready.mjs` `backportList`) now adds, from GitHub's compare of `main` with the
hotfix head: every commit `main` does not have, as `#<PR> title` (short SHA + subject when a commit has no PR
number; merge commits flagged, since a conflict fix can add code), capped at 10 with "…and N more", then the
changed files (first 10, "and N more"). A commit already cherry-picked onto `main` can still be listed; the file
list is the real diff. If GitHub cannot be read the ping still goes, saying to check the PR's Commits and Files
tabs. Other pings are unchanged.
