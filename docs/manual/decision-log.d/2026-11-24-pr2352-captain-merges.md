## 2026-11-24 — #2352 is merged into staging by the merge captain, not by Mason by hand

**Decision (Mason, 2026-11-24, in chat: "yes"):** once Sol is clean and the checks pass, the merge captain merges #2352 into staging. This replaces the earlier "Mason merges by hand" line in the PR body.
**Why:** under the staging-first flow a staging merge is not live; the migration's live apply still goes out with the release, after #2247's.
**What this forbids/implies:** the live apply is still gated as usual; a Sol round 14 still needs Mason's own OK.
