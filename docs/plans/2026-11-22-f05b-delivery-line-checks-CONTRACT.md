# F05b — Delivery line checks (#2274, #2275): behavior contract

Read at `origin/staging` 728f700a3 (2026-11-22). Follow-up to F05 (#2264, `20270224100000`). Migration `20270224190000_f05b_delivery_line_checks.sql` (stamp from the merge captain).

## Outcome and authority

- **#2274:** the database refuses to complete a delivery where nothing is delivered: no line would get a delivered quantity above 0, including a delivery with no lines. Today only the screens refuse this (`src/pages/DeliveryDetail.tsx` `hasAnyQty`, `src/pages/FieldStop.tsx`); a direct `complete_delivery` call with every figure 0 completes an empty load.
- **#2275:** delivery line quantities (`delivery_items.quantity`, `quantity_delivered`) must be finite. NaN and ±Infinity are refused on every write, as F05 did for order lines.
- **Smallest change (one migration):**
  - #2274: one check added to the completion step `_complete_delivery_authorized_impl` (the wrapper re-emitted from `20270203120000`, otherwise unchanged). When the delivery is `in_progress` (a real completion, not a replay), it computes each line's delivered figure exactly as the body will store it (`GREATEST(0, LEAST(sent figure, scheduled))` when a figure was sent, else the scheduled quantity) and refuses with `DELIVERY_NOTHING_DELIVERED` (SQLSTATE 23514) if none is above 0. It runs after the delivery row is locked; it also locks that delivery's lines, then checks, before this step's own order-line and stock locks and any write (the caller may already hold stock locks; a refusal rolls the whole call back). Today a direct line write already locks the delivery row first (the parent-lock trigger), so the row lock waits for one in flight; the line lock keeps that true if the trigger changes.
  - #2275: one table `CHECK` constraint `delivery_items_quantities_finite` (`quantity` strictly between ±Infinity; `quantity_delivered` NULL or strictly between; NaN sorts above every number in PostgreSQL, so it fails the `< Infinity` comparison).
- **Why the completion step, not a table trigger:** every completion goes through it. `complete_delivery` and `start_and_complete_delivery` (and offline sync, through `complete_delivery`) all end in this wrapper, and the deliveries trigger `_require_delivery_completion_evidence` refuses any move to `completed` without the marker only `complete_delivery` sets. A deferred trigger was dropped after the cold challenge: it fired at commit, so offline sync's refusal would have rolled back the office-review record (Astra BLOCKER), and it would also have caught `fix_delivery` and other writes to completed rows.
- **Who may act:** unchanged. The wrapper keeps `SECURITY DEFINER`, `SET search_path = public, pg_temp`, and no EXECUTE for anon, authenticated or service_role (callable only through `complete_delivery`).

## State and failure

- **Automatic record changes:** none. The completion is refused and nothing from that call is kept.
- **Existing rows (live, read-only 2026-11-22):** 0 delivery lines with a non-finite value, so the constraint validates; the preflight re-checks on the target database and stops, listing line ids, if any exist. 5 of 71 completed loads have nothing delivered (March 2026, all with no lines). The check runs only when an `in_progress` load is completed, so those rows and edits to them are untouched.
- **Retries:** a retry of a saved completion (same key) is answered from its saved receipt when it carries the same figures, and is not re-checked (the delivery is already completed, so the new check is skipped). A refused call saves no key, so its retry is refused the same way.
- **Offline sync:** today's offline completions carry no proof, so the proof check refuses them and they go to office review (`20261022075000`) before the new rule is reached. Nothing changes for them. If offline completions later carry proof, the new refusal is still raised inside the `complete_delivery` call, which `process_offline_action` catches and records for review (the refusal is an ordinary exception, not a commit-time one).
- **Rollout:** the deployed app already refuses both cases on screen, so no screen flow hits the new refusals. `errorSanitizer` shows "The delivery was not completed. …" for `DELIVERY_NOTHING_DELIVERED` and a plain "Nothing was saved. …" sentence for the constraint.
- **Undo:** `scripts/smoke/f05b-delivery-line-checks-reverse.sql` drops the constraint and restores the `20270203120000` wrapper exactly.

## Cold challenge (Astra, gpt-6.2-astra high): how each finding was settled

- BLOCKERs on the deferred trigger (offline record rolled back at commit; `fix_delivery` and other completed-row writes caught): settled by the redesign above.
- Proof cases corrected: Quick Delivery creates a `scheduled` load and does not complete it, so it is not a case; the `fix_delivery` remark was wrong and is removed.
- Wording: the message says the delivery was not completed, not "Nothing was saved".
- Evidence: the refusals are proved as real committed calls read back from a new connection; offline is proved unchanged (still committed for review); constraint cases run with other triggers off so only the constraint can refuse.
- Refuted, NaN figures sent by a screen: JSON has no NaN (it arrives as null), and the body already refuses a non-number figure with `DELIVERY_QUANTITIES_INVALID`.
- Pre-existing, not in scope: a delivery with no assigned driver may be completable by any active driver. Reported to Mason separately.

## Proof cases (disposable Postgres with the real migrations: `scripts/smoke/prove-f05b-delivery-line-checks-real-schema.mjs`)

Before the migration: an all-zero completion completes, and a line accepts NaN and Infinity (the gap is real). A non-finite line blocks the apply and is named. The migration takes one lock, `ACCESS EXCLUSIVE` on `delivery_items`, first and never upgrades it, so it cannot deadlock with a completion (Sol r1 HIGH); the proof applies it while a completion that has read its lines is still open, and both finish.

1. When `complete_delivery` sends every figure 0 (or negative), then it is refused `DELIVERY_NOTHING_DELIVERED`; the load stays `in_progress`, no line delivered, no remainder; stock, order line and keys unchanged.
2. When one line is 0 and another is 1, then it completes as a partial delivery.
3. When `start_and_complete_delivery` sends all zero, then it is refused and the load stays `scheduled`; with full quantities it completes.
4. When a delivery with no lines is completed, then it is refused.
5. When a legacy completed load with no lines has its notes edited, then the edit succeeds.
6. When a saved completion is retried with its key and the same figures, then the same saved receipt is returned (a different payload under the same key stays refused `IDEMPOTENCY_INTENT_MISMATCH`, as today).
7. When offline sync runs an all-zero completion, then (unchanged; the proof check refuses it first) the action is committed as `needs_review` with attempt 1 and the load stays `in_progress`.
8. When a line is inserted or updated with NaN, Infinity or -Infinity in either quantity, then the constraint refuses it; 1.25, 0.5, 0 and NULL delivered save.
9. anon, authenticated and service_role cannot call the completion step directly.
10. When a direct line delete that began while the load was scheduled is still open as start-and-complete runs, then the completion waits for it, sees no lines and is refused; the load stays scheduled (Luna round 2 HIGH). Today the wait comes from the delivery row lock the delete already holds; the extra line lock is not separately exercised.
11. Rollback: the reverse script refuses unless the installed body is the F05b one, then restores the old body and drops the constraint; an all-zero completion goes through again.

## Open business decisions

None. #2274 and #2275 restate rules the screens already enforce (Mason dropped the 0-delivered way out on 2026-11-22, F05 Sol r2 settlement).
