## 2026-10-23 — Product brands migration renumbered to 20261022090500 (step 1, PR A)

**What changed.** The CRX Coordinator moved swap A (#1057, `20261022090000`) ahead of PR #1050. The not-yet-applied product brands migration is renumbered from `20261022080000` to `20261022090500`, so it applies after swap A and before cost lock B (`20261022091000`). Its SQL is unchanged; only the file name, its header comment, and every reference (migration history row 975, the reference docs, the smoke chain and its Docker proof, `src/lib/db.ts`, and the live-function snapshot note) carry the new number.

**Proof.** No reference to the old number remains. The documentation check, type check and the affected tests pass, and `node scripts/smoke/prove-product-brands.mjs` passes against the renamed file.
