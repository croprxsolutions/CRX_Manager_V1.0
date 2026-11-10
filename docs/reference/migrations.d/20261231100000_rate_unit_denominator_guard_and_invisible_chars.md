**LOCAL CANDIDATE — NOT APPLIED.** `20261231100000_rate_unit_denominator_guard_and_invisible_chars.sql` (SQL sha256: `e05139c077e04e259c20967de98e3feb5f1252777834cf116177915b8aad2fec`). KI-16 bullets 1-2: every writer of a job chemical line or a blend ticket line now refuses a rate unit measured per something other than acres ("oz/cwt"), with save_job's rule and message, and `normalize_rate_unit` folds zero-width and non-breaking characters so a pasted unit no longer blocks billing.

**What changes.** New `unit_fold_invisible(text)` (U+00A0, U+2007, U+202F to a space; U+00AD, U+200B-U+200D, U+2060, U+FEFF deleted) and `rate_unit_line_refusal(text, boolean)` (the fold, then save_job's denominator probe from `20260820120000`, plus its character probe when asked). `normalize_rate_unit` keeps its body with the fold applied first. Two BEFORE INSERT OR UPDATE row triggers, `trg_job_chemicals_rate_unit_guard` and `trg_blend_ticket_products_rate_unit_guard`, judge a row only when its rate unit, price (job) or product (blend) changed; blend lines judge the unit billing uses (the line's, else the product's) and store an invisible-only unit as NULL when that unit is written. Trigger functions have EXECUTE revoked from every API role.

**Who may call.** Helpers are IMMUTABLE invoker, EXECUTE authenticated and service_role only; trigger functions are invoker with EXECUTE revoked from PUBLIC, anon, authenticated and service_role. No RPC added or changed.

**Preflight.** One transaction, `lock_timeout` 5s; refuses if `normalize_rate_unit`'s body differs from live (md5 `3a0e2e8f1ed5611ae7ee343d40a7b3ad`) or a guard trigger exists. Postflight checks normalizer outputs, refusal cases, both triggers enabled, grants, and that no existing row would be refused.

**Proof.** `scripts/smoke/prove-rate-unit-guard-real-schema.mjs` (real schema, BEFORE holes and P1-P8, prints `RATE_UNIT_GUARD_PROOF_PASS`).

**Rollback** (its own reviewed migration): drop the two triggers and the four new functions, re-create the `20260630170000` `normalize_rate_unit` body. No data changes.

Contract: `docs/plans/2026-11-10-ki16-rate-unit-denominator-and-invisible-chars-CONTRACT.md`.
