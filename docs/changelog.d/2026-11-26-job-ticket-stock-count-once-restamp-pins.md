## 2026-11-26 — Count-once migration: body fingerprints follow the restamp

The restamp to `20270314150000` changed comment text inside the three rewritten function bodies, so the migration's post-apply fingerprint check and the rollback's body check now pin the regenerated bodies' md5s. No behavior change; the prover caught the stale pins.
