# Behavior contract: offline job completion takes the job row FOR NO KEY UPDATE (#2257)

Read at `origin/staging` b2f3b2e1c + 42039d705 (2026-11-23).

## 1. Outcome and authority

- **Outcome.** A field job completed through offline sync and a sibling job on the same open booking completed directly at the same time both finish. Today PostgreSQL can cancel one of them (deadlock, 40P01); the offline one then retries, and after enough failures goes to office review.
- **Smallest change.** In `process_offline_action`, the target lock for a `complete_job` receipt changes from `FOR UPDATE` to `FOR NO KEY UPDATE`. Nothing else in the function changes. Delivery receipts keep `FOR UPDATE` (no report of a delivery deadlock; out of scope). New migration only; `complete_job`, the booking sync (`_sync_quote_job_reservations`) and every booking function are untouched (Taha's area).
- **Who may act.** Unchanged: the same actor, receipt and idempotency checks run before the lock.

## 2. State and failure

- **Rules that always hold.**
  - Two actions on the same job still run one after the other: `FOR NO KEY UPDATE` conflicts with itself, with `FOR UPDATE`, with any `UPDATE` of the row and with `DELETE`. So the `updated_at` snapshot check still cannot be crossed by an office edit or another completion of the same job between the check and the completion.
  - What it no longer blocks: `FOR KEY SHARE`, the lock a foreign-key check takes when another transaction inserts a row that points at this job (a sibling completion rebuilding this job's `job_product_draws` / `inventory_holds` rows). Those inserts cannot change the job row itself.
  - The job's primary key is never changed by any path, so the weaker lock loses nothing the old one protected in practice.
- **Existing rows.** None change. Receipts already saved run through the same body.
- **Timing.**
  - Same job, offline + direct at once: still serialized; the second waits, then sees the job completed (same outcomes as today).
  - Sibling jobs on one booking, offline + direct at once: with the application-record number lock that #2170 adds to `complete_job` (taken before the body's status update), both finish. On `staging` before #2170, `complete_job`'s own body re-locks the job `FOR UPDATE` before the booking sync, so the sibling deadlock can still happen there until #2170 lands; this change is a precondition, not harmful on its own.
  - Retry after a deadlock: unchanged (the offline call re-raises 40P01 so the receipt stays `received` and the attempt count rolls back).
- **Undo.** Rollback script restores the previous body byte for byte.

## 3. Delivery

Database only, one migration, compatible with the deployed app (same signature, result and grants). Independent of #2170's merge order; the full deadlock fix needs both.

## 4. Proof cases (real migrated database, Docker; never live)

1. When the migration is applied, the body differs from the old one only in that one lock clause; owner, `SECURITY DEFINER`, `search_path` and grants are unchanged.
2. When an offline completion of job J1 and a direct completion of sibling J2 (same open booking) race, with #2170's migration applied: before the change one is cancelled with a deadlock; after the change both succeed, J1's receipt is `succeeded`, both jobs are `completed`.
3. When an office edit (a plain UPDATE of J1) is in progress, the offline completion of J1 waits for it, then lands in office review as `TARGET_STATE_CONFLICT` (the snapshot changed), as today.
4. When two offline/direct completions of the same job race, the second waits and does not complete the job twice.
5. Rollback restores the old body; the migration refuses a second apply and an autocommit run.

## 5. Astra cold challenge (gpt-6.2-astra high, 2026-11-23): 20 findings, disposition

- **Proof shape (6, 7, 8, 9, 10, 11, 16, 17, 18): taken.** The prover forces the schedule (the direct completion holds the record-number lock first; the offline one holds its job and waits; the booking sync then rebuilds the offline job's draw), shows the old lock deadlocks on it and the new one does not, checks stock moves, application records and draws against a job completed alone, covers same-job races with another key and the same key, an office edit that commits a new `updated_at`, the receipt left `received` with its attempt rolled back when the offline call is the deadlock victim, refusals that leave the body unchanged, and both migration orders with #2170.
- **4 (lock upgrade): accepted residual, named.** `complete_job`'s inner body still re-locks the job `FOR UPDATE`. A transaction that inserts a child row of the job and then updates the job, while the offline call holds the weaker lock, can now deadlock with it. The one such path is `load_recipe_into_job` (office loads a recipe onto an in-progress job at the moment that job is completed offline); #2170's direct path has the same exposure. A deadlock cancels one side and the offline action retries, the same outcome as today's sibling deadlock, which is the far more common case (two applicators on one booking). Follow-up: once #2170 lands, lock the job `FOR NO KEY UPDATE` inside the completion body too (or lock it first in `load_recipe_into_job`).
- **3 (sync locks the job): refuted.** `_sync_quote_job_reservations` (20261107070000) never updates `jobs` and takes no explicit lock on a job; the only lock it puts on a sibling job is the foreign-key `KEY SHARE` of its draw/hold insert. The before/after race proves it.
- **5 (other `KEY SHARE` callers): refuted.** No function body takes `FOR KEY SHARE`/`FOR SHARE` on `jobs` (catalog search); `jobs.id` is the only key referenced by foreign keys.
- **13, 15 (stale body): already covered.** The migration refuses unless the live body is exactly the 20260714203709 body (md5), and the rollback refuses unless it is exactly this migration's body.
- **14: not applicable** (the old postcheck is not copied; the postflight pins the exact new body md5).
- **1, 12 (retry limit, lock timeouts): unchanged by this change**; the offline client's retry and office-review rules stay as they are.
- **19: refuted.** `offline_action_receipts.operation` is constrained to `complete_delivery` / `complete_job`.
- **20: unchanged paths.** Legacy, succeeded and needs-review receipts return before the lock; only the lock clause differs (body diff).
- **2 (direct caller as victim):** covered: the before case reports which side was cancelled; the after case has neither cancelled.

## Open business decisions

None.

## Status: PARKED (2026-11-23 overnight), behind #2170

Sol round 1 (gpt-6.2-sol high, capture kept in the session scratchpad) returned two HIGHs that share one cause with Astra #4 and Luna r1's MED, so this is the same mechanism a third time:

1. The weaker outer lock (`FOR NO KEY UPDATE`) lets another transaction take `KEY SHARE` on the job through a child row's foreign key and then wait to update the job, while `complete_job`'s inner body upgrades to `FOR UPDATE` (`20261217100000_job_access_ends_with_the_job.sql:539`). Sol's concrete case is the office spray-record save (its EPA-history trigger, `20261204120000_job_lines_keep_epa_number.sql:201/260`), not `load_recipe_into_job` (the app lost EXECUTE on that in `20261023100000`). A deadlock there can cancel the office save.
2. Landing `20270225120000` first makes the staging stamp gate refuse #2170's `20270224170000`.

The real fix is to take the job `FOR NO KEY UPDATE` everywhere completion locks it, including the inner `complete_job` body that #2170 also redefines. So this change belongs inside #2170 or on top of it after it merges (restamped after it), not ahead of it. Proof work here is reusable: the forced sibling-race prover (`scripts/smoke/prove-offline-job-lock-no-key-update-real-schema.mjs`) shows the deadlock before and both completions finishing after.

Sol MEDs to carry: the prover should pin #2170's SQL by hash rather than read a branch ref; force lock waits with advisory locks or `pg_locks` polling instead of fixed delays; require exactly one application record per job and per-job stock deltas; re-key the cost-exposure allowlist after apply. LOWs: correct section 5's office-path inventory (spray save, the EPA trigger's `FOR SHARE`); pin the full ACL in the preflight.
