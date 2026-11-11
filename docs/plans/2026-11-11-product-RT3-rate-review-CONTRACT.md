# RT-3 · Mason's rate review — behavior contract (2026-11-11)

Grand plan: `docs/plans/2026-10-29-product-GRAND-PLAN.md` › Stage 4 › RT-3 and overlap 11. RT-1 sheet:
`docs/plans/2026-11-08-product-RT1-BUILD-SHEET.md`. Read at `origin/main` `eda8b1597`.

## Facts (checked 2026-11-11)

- RT-1 is live (`20261229110000_product_rates_draft.sql`). Live: **0** `product_rates` rows, **0** events, **456**
  parents (read-only query). The derivation run (RT-1 sheet §9 step 6, Mason's yes) has not happened, so there is
  nothing to review yet; "about 573 rows" is the expected count after it.
- `product_rates` already has `status` (`draft`/`approved`), `approved_by`, `approved_at`, `source_text`, `row_version`
  and a CHECK that ties the approval fields to the status. `_product_rates_guard_change` refuses every change to an
  approved row ("RT-3 adds its own pass").
- RT-1 functions are unchanged since: no later migration redefines them (searched every file after `20261229110000`).
- Writers: `save_draft_product_rate`, `delete_draft_product_rate`, `derive_draft_product_rates` (admin, key required
  via `_product_parent_replay`). Reader: `get_parent_draft_rates`. **No app screen calls any of them** (no RT-1 screens).
- The setup workbook's Rates and Parent Rates tabs write the **live** rate columns (`set_product_rates`,
  `set_parent_rates`); they stay as they are. DM-1b's database half is live; its workbook screens are not built.
- 5 admin profiles live. All product-setup paths are admin-only.

## 1. Outcome and authority

**Business result.** Mason can download one workbook, see every draft rate with its source text, label check and
derive notes, then per row: approve, correct (and approve), add, delete (with reason) or send an approved row back to
draft; and per parent record one outcome: `approved_default`, `no_per_acre_default` or `needs_label_data`. Who and when
is recorded for every decision. Nothing reads these rows until RT-4.

**Smallest change.** One migration plus the workbook screen (two PRs, database first):
- `product_parent_rate_outcomes` (new table, one row per parent): `outcome` (NULL = undecided), `note`,
  `outcome_version`, `decided_by`, `decided_at`. A new table because no existing table holds a per-parent rate decision.
- Event history reuses `product_rate_draft_events`: its `event_type` CHECK widens (superset) with `approved`,
  `reopened`, `outcome_set`, `outcome_cleared`.
- `_product_rates_guard_change` (re-issued): an approved row may change only to `draft` with every value identical
  (the "send back to draft" step). Everything else on an approved row stays refused, delete included.
- An AFTER trigger on `product_rates` (insert, update, delete): any change to a parent's rate rows clears that parent's
  outcome to undecided and logs `outcome_cleared`. So a recorded outcome always describes the rows as they are now.
- RPCs (admin only, SECURITY DEFINER, `search_path = public, pg_temp`):
  - `get_rate_review_workbook()`: every active parent with its sizes, outcome, rate rows (values, unit label, status,
    approver, `row_version`, label check) and only its **latest** derive notes; plus totals (drafts, approved,
    per-100-gal rows, parents by outcome) so "Done when" can be read off it.
  - `preview_rate_review(rates, outcomes)`: runs the whole save and always rolls it back; per-row result.
  - `commit_rate_review(rates, outcomes, key)`: all or nothing; a stale or invalid row refuses everything.
  - Corrections, adds and deletes go through RT-1's own `save_draft_product_rate` / `delete_draft_product_rate`
    (each called with a key derived from the commit key), so every RT-1 rule (units, ranges, one default, above-label
    reason) applies unchanged.
- Workbook (PR 2): its own **Rate review workbook** (a separate download and button, not a tab of the setup workbook,
  whose Rates tabs write the live rates): **Draft Rates** (one row per rate, plus blank rows to add) and **Rate
  Outcomes** (one row per parent). The two sheets are one review operation: previewed together, confirmed with one
  button. The screen sends only the outcome rows Mason edited.
- Files: `supabase/migrations/20270104110000_product_rate_review.sql`, its prover, ledger note; then
  a new rate-review workbook module and modal beside the setup workbook's, `src/types/index.ts`, tests.

**Who may act.** Any admin (`_product_parent_require_admin`: signed in and `is_admin()`), the same as every product
setup path. Non-admins and anon get `ADMIN_REQUIRED`/`AUTH_REQUIRED`; nothing is granted to anon, service_role or
metabase_ro. Tables are SELECT-for-admins by RLS, no write grants: only the functions write.

**Locators vs derived.** The upload sends `rate_id`, `parent_id`, `expected_row_version`,
`expected_outcome_version`. The server: takes the actor from `auth.uid()`; reads each rate's parent from the table and
refuses a row whose `parent_id` does not match; reads status and values itself; recomputes the label check; takes
approver and time from the server, never the file.

## 2. State and failure

**Rules that always hold**
- R1 A row is approved only if, at approval, under the parent lock: it is a draft at the expected version, the parent
  is active, `basis_confirmed` is true, its unit fits the parent's current form and basis, and its label check is not
  `above` without a recorded reason. `not_checked` (no label maximum known) may be approved; the workbook shows it.
- R2 An approved row's values cannot change and it cannot be deleted; only "reopen" (reason required) moves it back to
  draft, keeping the old approval in the event history.
- R3 `approved_default` needs: no draft rows on the parent, and exactly one quoting default, approved.
  `no_per_acre_default` needs: no draft rows and no quoting default (zero rows allowed: quotes auto-fill blank).
  Both re-check every approved row against R1 as the parent is now (form, basis, label maximum), also when the same
  outcome is sent again; the download flags a recorded one that no longer holds (`outcome_problem`, Luna round 1).
  `needs_label_data`: any rows; held back. Every outcome event lists the exact rows (ID, status, version) it covers.
  Blank outcome = undecided (clears, with who and when in the event); the same outcome and note again = unchanged
  (no version move); a new note = a new decision. Absent outcome row = version 0.
- R4 Any change to a parent's rate rows clears its outcome and moves its `outcome_version`, decided or not (trigger, so
  it covers every writer, now and later). So an outcome row downloaded before someone else changed the rows is stale.
  Therefore a parent with outcome `approved_default` or `no_per_acre_default` has no unapproved rows, at all times.
  RT-4 must promote only those two outcomes (recorded for RT-4).
- R5 All of one commit happens in one transaction: rates first (reopen, delete, saves that clear a default, other
  saves, approvals), then outcomes. Locks: REG-1 advisory pair shared, then every touched parent FOR NO KEY UPDATE in
  ID order (same order as RT-1), then rows.

**Existing rows.** Live has 0 rate rows and 0 outcome rows; the migration writes no rows. Old draft rows (after the
derive run) are all `draft` and all parents start undecided. No reader of `product_rates` exists. The deployed app
calls none of the new functions. Query before apply:
`select count(*) from product_rates where status='approved'` → 0.

**Timing**
- Double click / retry after timeout: same key + same payload returns the first receipt; a different payload with the
  same key is refused (`IDEMPOTENCY_PAYLOAD_MISMATCH`). The screen makes the key when the preview is shown and keeps
  it until success.
- Two admins on one row: the second commit finds a moved `row_version`/`outcome_version` and is refused as stale with
  the row's name; nothing saves. Concurrent commits on overlapping parents serialize on the parent locks.
- Stale preview: commit re-runs every check under the locks; preview is advice only.

**Undo and history.** Every approve, reopen, outcome set and outcome clear writes an append-only event (actor, time,
before/after, reason). Reopen keeps the row's values; a repeated reopen of a draft is refused ("not approved").
Clearing an outcome needs no reason (it is not a promotion).

## 3. Delivery

PR 1: migration + prover + ledger note, applied live before merge (non-destructive: new table and functions, a widened
CHECK, one re-issued trigger function). PR 2: workbook tabs, merged only after PR 1 is live.

## 4. Proof cases (real migrated database, prover container; never live data)

1. When an admin approves a draft at its version, then status `approved`, approver = that admin, time set, event `approved`.
2. When the version is old, then `stale`, nothing saved.
3. When the row has `basis_confirmed = false`, or label check `above` with no reason, or a unit that no longer fits the
   parent's form, then approval is refused with that reason.
4. When an approved row's value is edited without reopen, then refused; with reopen + reason, then it is a draft with
   the new values and both events exist.
5. When `postgres` updates or deletes an approved row directly, then refused (trigger), except approved → draft with
   identical values.
6. When `approved_default` is set while a draft row remains, or with no default, or with the default still draft,
   then refused. When all rows are approved and the default is approved, then set, with who/when.
7. When `no_per_acre_default` is set on a parent with a quoting default, then refused; on a parent with zero rows, set.
8. When any rate row of a decided parent is saved, approved, reopened, deleted or derived, then the outcome becomes
   undecided and `outcome_cleared` is logged.
9. When one row in a 3-row upload is invalid, then commit saves nothing and names it; preview shows each row's status
   and leaves the database unchanged.
10. When one upload adds a default and a label row, approves both and sets `approved_default` on that parent, then it
    succeeds (rates before outcomes); when one upload reopens and edits a row of a decided parent and also sets its
    outcome from the same download, the outcome is not stale. (Moving the default between rows cannot happen: only
    the one house per-acre row can be the default, RT-1's unique key.)
11. When a sales rep or anon calls any new function, then refused; when an upload's `parent_id` does not match the
    rate's parent, then refused.
12. When the same commit key is sent twice, then the second returns the first receipt and writes nothing.
13. The download shows only the latest derive batch's notes, and totals that match the table.
14. When another admin adds and approves a row after Mason's download, Mason's outcome row is stale.
15. When a parent's form changes after approval, a promotable outcome is refused naming the row; the row can still be
    reopened and deleted (RT-1's unit check now runs only when parent, basis or unit is written).
16. With the live-rate lock on, drafts are added, approved and decided; the lock is untouched.
17. A bulk wipe (TRUNCATE) is refused on both tables.

## Astra cold challenge (gpt-6-astra, high, 2026-11-11): 72 findings, settled

The packet held this contract, RT-1's SQL and the grand plan excerpt, not the migration, so several findings are
answered by code it did not see. Each DEFECT / MISSING-EVIDENCE is fixed, refuted with evidence, or deferred by name.

**Fixed in the migration and proved:** 13 (row set moved under an outcome: R4 now moves the version on every rate
change; case 14) · 12 (outcome re-checks every approved row; case 15) · 20 (RT-1's unit check trapped an approved row
after a form change; trigger narrowed to parent/basis/unit writes; case 15) · 7 (a hold's event lists its exact rows;
case 6) · 23 (bulk wipe refused; case 17) · 66 (live-rate lock on; case 16) · 34 (case 10 rewritten) · 15, 16, 18
(versions: the external precondition is checked before any write, later steps use the versions they produce, the
outcome token is the version before this upload's own rate changes, absent = 0; cases 3, 10) · 19 (reopen compares
an explicit column list) · 26, 27 (table CHECKs; postflight checks owners, modes, search_path, grants, RLS) · 45, 46
(an unchanged row is "unchanged", never saved; one `decision` column: approve / reopen / delete / blank; case 9)
· 54, 55, 56 (preview rolls back events, receipts, outcomes; its inner keys are random; child keys are commit key +
row index, one save per row; cases 2, 9).

**Refuted:** 28 (`is_admin()` is `RETURN EXISTS(...)`, never NULL) · 25 (`updated_by` is NOT NULL, so the clear event
always has an actor) · 21, 22 (direct writes need the table owner: authenticated has SELECT only; the owner path is a
reviewed migration, RT-1's stance) · 24 (every writer locks parent, then rates, then the outcome row; the trigger runs
after the rate write, so the order holds) · 29, 30 (wording: anon gets "permission denied"; units are readable by all
signed-in users) · 31, 39 (in RT-1's reviewed migration) · 36 (one row per parent/source/basis is RT-1's settled
design) · 48 (rates hang on parents, not sizes; every ID is re-read on the server) · 53 (event IDs may skip; nothing
reads them as contiguous) · 57 (a retry with a new key after a lost reply finds its rows moved and is refused as
stale: nothing applies twice) · 68 (live has 0 rate rows; the RPCs are admin-only and change nothing the app reads)
· 69, 70 (rollback in the migration header; post-apply checks are ship.md's apply gate and the live read-only check)
· 33 (RT-1 settled that a save confirms the basis; the workbook shows `basis_confirmed`, and an unchanged row is never
saved).

**Deferred by name:** 8, 11, 71 to RT-4 (nothing reads approved rows until RT-4; RT-4 must re-check each promoted
parent at cut-over, promote only `approved_default` / `no_per_acre_default`, and prove quote, application and
seed-treatment quantities) · 9, 10 to the derivation run, Mason's yes (RT-1 sheet), its counts reconciled on the first
download · 47, 49, 50, 58, 60, 61 to PR 2's screen (results map by upload row; values stay text; formula-safe export
as the setup workbook does; key kept until success; a stale refusal tells Mason to download again) · 62, 63 to a later
history view (events are readable by admins today) · 65, 67 measured on live after the derivation (about 600 rows)
· 35, 41 not supported in one upload (a source/basis swap is refused as a duplicate; a deleted row is re-added by hand,
its old values are in the event) · 37 notes are those of the latest derivation that wrote notes for that parent · 38 a
hand-added row has no source text (RT-1's writer) · 40 the derivation skips parents that have rows; a re-derive
clears that parent's outcome (R4) · 14, 32, 44, 51, 52, 64 accepted: commit re-checks everything under the locks; a
label-maximum change after a reason was saved shows on the row and is re-checked by R3.

**Decisions:** 1 and 2 decided by Mason below (any admin; approve with the warning). 3 (RT-4's live source) belongs to RT-4. 4, 5 settled
above (its own workbook, one confirm). Routine, decided here: 6 inactive parents are out of the review (RT-4 promotes
active parents only); 42, 43 notes optional, blank clears; 44 a zero default is a real zero (RT-1 allows it).

## Luna rounds (gpt-6-luna, xhigh)

- Round 1 (head 541a611): HIGH an outcome stays "approved" after the parent's form or label maximum changes: fixed (the
  re-check also runs when the same outcome is resent; the download flags `outcome_problem`; case 15). MED the commit
  receipt held only changed rows: fixed (it returns every row, as the preview does).
- Round 2 (head 1ee84b4): MED approving a row someone else approved since the download read as unchanged: fixed (stale;
  case 2). MED a missing `is_quoting_default` on an existing row read as "unchecked": fixed (refused; a new row may
  leave it out = not the default; case 9). LOW two derivations in one transaction share `changed_at`: refuted, each
  derivation is its own RPC call and so its own transaction, and nothing calls `derive_draft_product_rates` twice in
  one; the notes still belong to that parent's latest derivation.

## Business decisions (Mason, 2026-11-11, picked in the coordinator session: both recommended options)

1. **Who may approve rates?** DECIDED: any admin. Recommended: any admin, with their name recorded on every decision (same as all
   product setup today; there are 5 admin accounts). Alternative: only Mason's account, which needs a hard-coded
   user or a new permission and blocks review if Mason is away.
2. **Approve when the label maximum is unknown?** DECIDED: yes, with the warning. Recommended: yes, with the "label maximum not checked" warning shown
   on the row (REG-1's label data is still partial; blocking would block most rows). Alternative: block, and use
   "needs label data" for every such parent.
