## 2026-10-21 — carry-forward proof test no longer depends on the wall clock

- `scripts/write-codex-push-proof.test.mjs` fixed its clock at 2026-10-21 18:00 UTC but built one
  carried proof with the real time, so from that moment on the proof looked newer than the test's
  "now" and was refused ("older than 24 hours"), failing CI for every PR. The proof is now stamped
  at the test's fixed time. Test-only; the proof writer is unchanged. Shipped inside PR #1006, whose
  CI it broke.
