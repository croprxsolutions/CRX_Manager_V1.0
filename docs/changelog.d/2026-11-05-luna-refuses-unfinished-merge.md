## 2026-11-05 — Luna refuses to review an unfinished merge

- `scripts/luna-review.mjs` now stops with "DID NOT RUN" (exit 2), before Codex is called, when the checkout has
  files with unresolved merge conflicts. It names them and says to finish or abort the merge first.
- Why: a chained `merge origin/main && luna-review` in the background hid a conflict, and Luna reviewed the wrong
  code (retro, 2026-11-05).
- Proof: the new case in `scripts/luna-review.test.mjs` fails on the old script and passes on the new one; the real
  script, run by hand in a throwaway repo with a stopped merge, printed the refusal and exited 2.
