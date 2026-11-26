## 2026-11-26 - A clean Sol now labels our lane PR for Taha automatically

- New `.claude/hooks/taha-ready-after-sol.mjs`: when a clean Sol proof is written, and after a push, `gh pr create` or `gh pr ready`, an open, non-draft lane PR of ours whose current head has a clean Sol gets `ready-for-taha` and Taha's review request. The Taha ready bot cannot see Sol proofs, and agents kept forgetting the manual step (Mason labelled #2610 by hand). Best-effort: a gh failure prints the manual command and never fails the proof or the push.
- Not covered: a fix pushed after Sol without a new Sol run (the merge gate still accepts the earlier proof); `ship.md` keeps the manual command for that case.
- Proof: `node .claude/hooks/hook-router.test.mjs`; a dry run against the open PRs (label calls intercepted) found clean proofs for #2643 and #2610 and would have labelled both.
