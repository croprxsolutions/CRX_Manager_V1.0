# Behavior contract: refuse a parent EPA correction while the product has work in progress (#2579)

Read at `origin/staging` 1414a0d35 (2026-11-25). Builds on `2026-11-23-par1-epa-correction-on-CONTRACT.md` (#2381).

## 1. Outcome and authority

**Outcome.** An admin's parent EPA-number correction is refused while any size of that parent still has saved work in
progress. The refusal names the work so the admin can finish (or cancel/delete) it, then correct. This closes, at the
source, Sol's #2381 rounds 11-16 findings where an in-progress record picked up the corrected number later: completing
an already-sprayed job, a late first spray entry, an application record from an approved blend ticket, posting an
untouched draft, saving an open field invoice, Split Billing / Create Invoice for a finished job, and a split field
invoice re-saved while unposted. Mason: "go ahead with 2579" (2026-11-25).

**Smallest change.** One new migration re-emits `_product_parent_identity_after` (newest body:
`20270307180000_parent_epa_correction_on.sql`) with one added check, last in the existing "EPA number changes" branch.
Both `preview_product_parent_identity_correction` and `correct_product_parent_identity` already call this function, so
the Preview button and the save refuse alike. No new table, lock, flag or screen state. Formulation/safener-only
corrections are untouched.

**Work in progress** (sizes = every `product_parent_members` row of the parent; the correction always writes every
size, so open work on any size blocks the parent):

| # | Record | Counts while | Source of the definition |
|---|---|---|---|
| W1 | `jobs` with a `job_chemicals` line for a size | not deleted, `status IN ('scheduled','in_progress')` | `jobs.status` enum |
| W2 | same | not deleted, `status = 'completed'`, `invoice_id IS NULL` | Unbilled Applications panel (`src/components/field-invoices/UnbilledApplicationsPanel.tsx:186`) |
| W3 | `blend_tickets` with a `blend_ticket_products` line for a size | not deleted, `review_status` not `rejected`, and either `payment_status = 'unbilled'` or no `application_records` row (`source_type = 'blend_ticket'`) yet | Unbilled panel (approved + unbilled), widened to not-yet-reviewed tickets; an application record can be made from an approved ticket at any time, billed or not (`20260713060200`) |
| W4 | `invoices` with an `invoice_items` line for a size | not deleted, `status IN ('draft','unposted')` (chemical-sale and field invoices alike) | `invoices.status` enum |

**Files:** `supabase/migrations/20270307230000_parent_epa_correction_refuses_open_work.sql`, its ledger and migration
record, the prover `scripts/smoke/prove-parent-epa-open-work-real-schema.mjs`, `src/lib/errorSanitizer.test.ts` (one
row), `docs/reference/product-corrections-record-map.md`.

**Who may act.** Unchanged: admin only (`_product_parent_require_admin`). The function is owner-only (no grants),
called only by the two admin RPCs. The screen sends the parent id and changes; the server derives every size and every
piece of work itself.

**Screen.** `ParentIdentityModal` already shows any `PRODUCT_PARENT_*` refusal text in a toast prefixed "Nothing was
saved." (`src/lib/errorSanitizer.ts:415`). The new code `PRODUCT_PARENT_EPA_OPEN_WORK` lists up to 10 items by number
and state (job: scheduled / in progress / completed, not invoiced; ticket: unbilled / no application record; invoice:
draft / unposted), then "and N more" (staged: the admin clears these and sees the rest). It runs last in the EPA
branch, so the existing, more specific refusals and their remedies win (e.g. `PRODUCT_PARENT_EPA_RUP_DRAFT`: "do not
post it"). No screen code change.

## 2. State and failure

- **Automatic record changes:** none. The rule only refuses; staff finish or delete the work themselves.
- **Rules that always hold:** a parent EPA number never changes while W1-W4 holds a saved row for one of its sizes, as
  seen by the save's check. A refusal raises and rolls back the whole correction (parent, sizes, version, event).
- **Existing rows:** observed 2026-11-25 on production (read-only `execute_sql`, the W1/W2/W3-unbilled/W4 joins
  through `product_parent_members`): 458 parents, zero matching rows (the app is not in real use yet). Re-run the
  final predicates read-only before the production apply.
- **Timing:** READ COMMITTED, no new lock. The save first locks the parent and every size `FOR UPDATE`
  (`_lock_product_parent`, `20261108120000:686`), which conflicts with the `FOR KEY SHARE` an insert of a job,
  blend-ticket or invoice line for a size takes through its foreign key: that insert waits for the correction, or the
  correction waits for it and then sees it (each plpgsql statement takes a new snapshot). A status change on existing
  work (reopen, unpost, restore) takes no product lock and can overlap the check; that work then behaves as before
  this rule (the accepted race, Luna 2026-11-07). Preview takes no lock and is advisory; the save re-checks.
  Retry: unchanged idempotency; a refused call saves no receipt, so a retry re-checks.
- **Undo/history:** correcting back is a new correction and follows the same rule (it waits until open work on the
  sizes is finished). Records made under the mistaken number keep it.

## 3. Delivery

Database only; no screen change depends on it. One PR to `staging`: migration, prover, docs. The preflight pins the
`20270307180000` body (md5 `b97145311af25c6ac873f78aa44bf2ac`) and attributes; the postflight pins the new body and its
ACL exactly `{postgres=X/postgres}`. Ordering: apply right after `20270307180000` in the same release, so the switch is
never on in production without this rule (`20270307180000` is not applied live). Rollback: switch the correction off
(`20270307180000`'s rollback); never re-emit the old helper while the switch is on.

## 4. Proof cases (real-schema prover, local Postgres with test data)

1. A size with a scheduled job: preview and save refuse `PRODUCT_PARENT_EPA_OPEN_WORK` naming the job and its state.
2. Same, each alone: in-progress job; completed job with no invoice; the job on the other size; unreviewed or approved
   unbilled ticket; billed ticket with no application record; unbilled ticket with one; draft invoice; unposted field invoice.
3. Not blocking: job invoiced / cancelled / deleted / for another parent's product; ticket billed or no-charge with
   its application record, rejected, deleted; invoice posted / paid / voided / cancelled / deleted.
4. Each refusal (preview, EPA-only save, EPA + safener save) leaves parent, sizes, version and event count unchanged.
5. A draft that triggers `PRODUCT_PARENT_EPA_RUP_DRAFT` shows that refusal, not the open-work one.
6. A formulation-only correction is not refused by open work. 12 open items: 10 named and "and 2 more".
7. A rep is refused before any work is named. With all work finished the correction commits and writes both sizes.
8. Apply: refused outside one transaction; a second apply stops at the preflight; the ACL stays owner-only.

## Residual (not closed by this rule)

- Work reopened after a correction (a posted split field invoice unposted and re-saved, a cancelled job reopened) takes
  the corrected number: it was not in progress when the correction ran.
- Unsaved screens: a form never saved before the correction is a record made after it, and takes the corrected number
  (Mason 2026-11-23).
- Year-end return-credit attribution and first-number assignment of historical blank lines (the issue's out-of-scope items).

## Cold challenge (Astra gpt-6.2-astra high, 2026-11-25, packet-only, 53 findings) — settled

- Corrected: #1 precedence (open-work check moved last; RUP_DRAFT wins, proof 5); #8/#33 the list promise (10 + count,
  staged; one entry per record); #9/#11 blend tickets (W3 also counts a ticket with no application record);
  #21/#22/#23 timing (the `FOR UPDATE` / `FOR KEY SHARE` serialization above; status changes stay the accepted race);
  #28 undo wording; #36 exact ACL in the postflight; #38/#39 dated observation; #42/#43 ordering and rollback;
  #47/#48 refusal atomicity, combined edit, more than 10 items (proofs 4, 6); #50 record map updated.
- Disproved: #3/#4 an unsaved form or unsaved local line has no row, so its first save is a record made after the
  correction (Mason 2026-11-23); the contract no longer claims it. #12/#24 Create Invoice and Split Billing insert the
  invoices and set the job `invoiced` in one function (`20270303100000:511, 822`). #14 a no-charge job is billed as a
  zero invoice (`send_disposition = 'suppressed_zero_total'`). #19 `review_status`, `payment_status` and `jobs.status`
  are NOT NULL with defaults (schema registry). #32 the caller is an admin, who can open every job, ticket and invoice.
  #37 sizes cannot carry their own number (`guard_product_parent_values`); the parent number changes only through this
  function's two callers.
- Declined: #26 a stale preview stays on screen after a refusal, but the save re-checks and refuses; #45/#46 the rule
  stops the correction while those records are open, so the downstream writers never run across a correction, and the
  `20270307180000` prover covers what records keep afterwards; #49 admin-only, rare action on indexed foreign keys.
- Out of scope (pre-existing or named in the issue): #13/#29 reopening finished work; #17 quotes and orders read the
  product's current number (record map, accepted); #40 historical blank lines (record map follow-up 5).
- To Mason: #6 is D1 below; #5/#7 are answered by Mason's 2026-11-23 rule and the refusal's remedy; #20 is forced
  (the correction writes every size).

## Open business decisions

D1. **Scheduled jobs not yet sprayed (W1 `scheduled`) block too?** **Decided yes (Mason, 2026-11-25).** Recommended **yes** (the issue's "open jobs"; it is
the only way to catch a job sprayed under the old label but entered late). Consequence: in season a common product
almost always has a scheduled job, so its correction waits until those jobs are done or the product is taken off
them. "No" lets corrections through in season but leaves the late-entry case open.
