## 2026-10-21 — the Sol carry-forward test stamps its carried proof on the test's own clock

- **Problem.** From 18:00 UTC on 2026-10-21, "Lint, Type Check, Test, Build" failed on `main` and on
  every PR, at "carry: a carried proof can itself be carried" in
  `scripts/write-codex-push-proof.test.mjs`. The test fixes its clock at 2026-10-21T18:00Z, but the
  `buildCarryForwardProof()` call there left the proof's timestamp to default to the real time. Once
  the real time passed 18:00Z, the carried proof looked future-dated and was refused.
- **Change.** That test call now passes `timestamp: new Date(nowMs).toISOString()`. No change to the
  proof writer or any gate.
- **Proof.** `node scripts/write-codex-push-proof.test.mjs` failed with that assertion before the edit
  and passes after it.
