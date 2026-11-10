**LOCAL CANDIDATE — NOT APPLIED.** `20261231100000_rate_unit_denominator_guard_and_invisible_chars.sql` (SQL sha256: `97ec95d19998bacac8a4b0bbd6ef7e8c6c528dbb4df6dc47200b3fe3a772c9f7`). KI-16 bullets 1-2: every writer of a job chemical line or a blend ticket line now refuses a rate unit measured per something other than acres ("oz/cwt"), with save_job's rule and message, and `normalize_rate_unit` folds zero-width and non-breaking characters so a pasted unit no longer blocks billing.

**What changes.** New `unit_fold_invisible(text)` (U+00A0, U+2007, U+202F to a space; U+00AD, U+200B-U+200D, U+2060, U+FEFF deleted) and `rate_unit_line_refusal(text, boolean)` (the fold, then save_job's denominator probe from `20260820120000`, plus its character probe when asked). `normalize_rate_unit` keeps its body with the fold applied first. Two BEFORE INSERT OR UPDATE row triggers, `trg_job_chemicals_rate_unit_guard` and `trg_blend_ticket_products_rate_unit_guard`, judge a row only when its rate unit, price (job) or product (blend) changed; blend lines judge the unit billing uses (`NULLIF(btrim(line), '')`, else the product's) and refuse an invisible-only line unit when it is written. A BEFORE UPDATE trigger, `trg_z_products_rate_unit_blend_guard`, refuses a product rate unit edit that such a line would refuse while an unbilled blank-unit blend line relies on it. Trigger functions have EXECUTE revoked from every API role.

**Who may call.** Helpers are IMMUTABLE invoker, EXECUTE authenticated and service_role only; trigger functions are invoker with EXECUTE revoked from PUBLIC, anon, authenticated and service_role. No RPC added or changed.

**Preflight.** One transaction, `lock_timeout` 5s; refuses if `normalize_rate_unit`'s body differs from live (md5 `3a0e2e8f1ed5611ae7ee343d40a7b3ad`) or a guard trigger exists. Postflight checks normalizer outputs, refusal cases, all three triggers enabled, grants, and that no existing row would be refused.

**Proof.** `scripts/smoke/prove-rate-unit-guard-real-schema.mjs` (real schema, BEFORE holes and P1-P9, prints `RATE_UNIT_GUARD_PROOF_PASS`).

**Rollback** (its own reviewed migration): drop the three triggers and the five new functions, re-create the `20260630170000` `normalize_rate_unit` body. No data changes.

Contract: `docs/plans/2026-11-10-ki16-rate-unit-denominator-and-invisible-chars-CONTRACT.md`.
