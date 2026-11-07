## 2026-11-06 — Luna runs the code-health check before it reviews

- `scripts/luna-review.mjs` now runs the `src/` code-health ratchet (`scripts/check-code-health.mjs`, the check
  pre-push runs) before calling Codex, whenever the reviewed diff touches `src/`. A failure stops with "DID NOT RUN"
  (exit 2), names the violations, and spends no Luna tokens. A check that cannot run (no `node_modules` or knip)
  does not block: Luna continues and the result says `Code health: NOT CHECKED`.
- Why: on PR #1578 Luna came back clean, then pre-push refused the push for one new complexity violation; the fix
  changed code and forced another whole-branch Luna round, about 10 minutes wasted (retro, 2026-11-06).
- Proof: the new cases in `scripts/luna-review.test.mjs` fail on the old script and pass on the new one; the real
  script refused a branch with a deliberate complexity violation before calling Codex, and went ahead on a clean
  `src/` change.
