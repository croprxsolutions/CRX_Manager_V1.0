# Behavior contract: field-app save refuses invoices another editor owns

Release #2388 Sol HIGH 3 (release head c2732b049). Read at origin/staging 0882a18e0, 2026-11-23 (the fix PR targets staging).

## Facts (sources)

- `save_field_app_invoice` (public wrapper, `20261102180000_bind_money_replay_receipts_batch4a.sql` §6) checks key, actor and
  role and the replay receipt, then calls `_save_field_app_invoice_replay_impl_20261015` (non-admin cost) →
  `_save_field_app_invoice_cost_step2_impl` (the lock layer from `20260714224000`: refuses a deleted target, takes the group
  advisory lock then member row locks, refuses posted/voided) → `_save_field_app_invoice_impl_20260714`
  (newest body `20270205100000_field_app_refuses_payer_change.sql`). Only the wrapper is executable by `authenticated`
  (`src/lib/rpcIdempotencyScope.test.ts:498`).
- The impl rebuilds the invoice from the fields sent: it deletes every group member's lines, shares and field rows
  (lines 151-165), derives payers from Field Setup (`derive_customer_shares_from_fields`, line 183), cancels every group
  member whose farm is not in that list (lines 191-219), creates a draft for any new farm (lines 289-307), and writes its
  field rows (`field_app_locations`: `invoice_id` for one farm, `invoice_group_id` for a group; lines 688-705). Every invoice
  it saves therefore carries field rows.
- Job transfer (`_transfer_job_to_invoice_intent_impl_20260908`, newest `20270226150000…:231`) creates one invoice per
  owner from the job's saved shares, each with `job_id` and a shared `invoice_group_id`, and writes no field rows; its
  single-owner path likewise. Blend-ticket invoices carry `blend_ticket_id` and no field rows.
- Split billing (`_save_field_app_split_invoice_impl`, newest `20270224130000…`) stamps `field_app_billing_set_id` on every
  member and owns its group's lines and line shares (it also writes group field rows).
- The screen keeps both out of this editor (`src/pages/FieldApplicationInvoice.tsx:1060-1107`, `:1142-1146`); the server
  does not.
- Reps may work any customer (`20261013220000_reps_work_any_customer.sql`), so naming an invoice's origin in an error
  discloses nothing a rep cannot already open.
- **Live, read-only, 2026-11-23:** 3 field-application invoices: 2 posted engine-built with field rows, 1 editable job-made
  single invoice with no field rows. 0 Split Billing members, 0 job-made group members, 0 `invoice_orphan_cancelled`
  events ever: the bug has never fired, nothing needs repair.

## 1. Outcome and authority

- **Outcome:** a NEW `save_field_app_invoice` write to an existing invoice rebuilds only invoices this editor built. It
  refuses, with nothing changed, when the invoice or any live member of its group belongs to a Split Billing set, or the
  invoice (standalone: by `invoice_id`; grouped: by `invoice_group_id`) carries no field rows.
  `FIELD_APP_WRONG_EDITOR: Nothing was saved. …` with one plain sentence (Split Billing / made from a job or blend ticket).
  The message states why, without promising a screen.
- **Smallest change:** one new migration `20270228140000` re-emitting only the public wrapper with this check, placed
  after the replay lookup and taken only when the call is not a replay; before checking, it takes the lock layer's locks in
  the same order (group advisory lock, anchor member, all members; or the single row). Preflight pins the current wrapper
  body, postflight the new. The impl, lock layer, cost layer and grants are unchanged.
- **Who may act:** unchanged (active admin or sales rep).
- **Locators only:** `p_invoice_id` is a locator; the server reads group membership, the billing-set stamp and field rows itself.

## 2. State and failure

- **Automatic record changes:** removes one. A field-app save can no longer cancel, rebuild or replace job-made,
  blend-made or Split Billing invoices. Stop-and-explain. The screen never offers these saves (it opens them elsewhere),
  so staff lose no path they have today.
- **Rule that always holds:** a refused save raises before any write; the whole call rolls back (no receipt, no feed row).
- **Existing rows:** none written. Engine-built invoices (with field rows, with or without a linked job, single or
  group) and new invoices save as before. The one live job-made editable invoice would be refused here, which matches
  the screen (it opens in the invoice editor).
- **Timing:** retry of a refused call → refused again while its origin is unchanged. Retry of an earlier successful save
  (same key, same request) → the receipt path runs first and the check is skipped, so the first result returns even if
  that save left the target without field rows. Two users on one group: the check holds the group lock through the
  rebuild (same lock order as the lock layer, which re-takes it in the same transaction), so the group checked is the
  group rebuilt. Job transfer creates new invoices and a new group, never converts an existing one.
- **Undo:** none needed. Rollback = a new migration re-emitting the preflight-pinned body (reopens the gap; no data to
  repair, per the live count).

## 3. Delivery

Database only; no screen change. One PR into `staging`.

## 4. Proof cases (disposable replayed database, `scripts/smoke/prove-field-app-save-refuses-other-editors-real-schema.mjs`)

1. When a completed job whose saved split bills A and B (Field Setup lists C 100%) is invoiced through
   `transfer_job_to_invoice` and A's invoice is saved through `save_field_app_invoice` with the job's field, then before:
   A and B cancelled, C billed; after: refused (admin and sales rep), and every invoice, line, share, field row, receipt,
   feed and audit row is identical afterwards with no receipt kept.
2. When a single-farm job invoice is saved there, then it is refused.
3. When a Split Billing member is saved there, then it is refused.
4. When an engine-built group, a field-app invoice linked to a job, a job-linked engine group, or a new invoice is saved,
   then each ends exactly as before the migration.
5. When a successful save is retried with the same key after its invoice lost its field rows, then the retry returns
   the first result and changes nothing.
6. The migration applies once (grants unchanged) and a second apply stops at its preflight.

## Cold challenge (Astra, gpt-6.2-astra high, 2026-11-23): 22 findings, settled

- Corrected: #13/#14 (check now after the replay lookup, skipped on a replay; case 5); #15/#16 (locks taken as the lock
  layer does, case-proven single-session; the lock order is the lock layer's own); #1/#3 (positive ownership: field
  rows required, whatever the source link); #2/#4 (field rows keyed as the impl writes them); #11 (message no longer
  promises a destination); #18/#19 (cases 2, 3, 4, 5, rep case; full-row comparison incl. receipts).
- Disproved: #5 (deleted target: refused 'Invoice not found' by the new check and the lock layer); #10 (reps work any
  customer); #12 (every refused path still saves nothing; only the sentence differs); #17/#21 (live counts above: no
  groups, no split members, no past orphan cancellations, so nothing to repair); #20 (staging is the base; release re-cut follows).
- Out of scope, follow-ups: #6/#7 (screen routing of a job-linked engine group and a job-backed split child counts field
  rows by `invoice_id` only, so it sends them to the invoice editor; pre-existing screen behavior, and the server now
  refuses nothing those screens send); #8 (mixed-marker groups: no writer produces them; live 0).
- No DECISION findings needed Mason: refusing (vs re-billing from the job) leaves every current path working.

## Targeted re-check (Astra, gpt-6.2-astra high, 2026-11-23): 6 findings, settled

- No counterexample to the replay ordering.
- Corrected: #1/#3 (after locking, the check re-reads the target as the lock layer does: gone -> 'Invoice not found',
  moved to another group -> 'Invoice group changed while saving; reload and try again'); #4 (the no-field-rows sentence
  no longer claims a job/blend origin: a cancelled former group member also has none).
- Accepted with reason: #2 (a deadlock needs a writer that groups an existing standalone invoice; the field-app save
  refuses that since 20270205100000, and PostgreSQL would abort one save, not corrupt data); #5 (no writer removes an
  engine group's field rows or adds a stamped sibling outside this save path; Split Billing stamps groups it creates);
  #6 (a field row carrying both keys is never written: the save writes exactly one; LOW).

## Pre-ship reviewers (2026-11-23)

- `rls-security-reviewer` H1 (HIGH, confirmed live read-only): the check trusts field rows, and signed-in admins and
  sales reps could insert, update and delete `field_app_locations` / `field_app_location_shares` directly, so one direct
  insert onto a job's group let the save through. Fixed in this migration: revoke INSERT, UPDATE, DELETE, TRUNCATE on
  both tables from PUBLIC, anon, authenticated (SELECT kept). Live, the only writers are the two SECURITY DEFINER save
  functions; no screen or Edge Function writes them; no column-level grants. Proof case added (before: the bypass
  cancels A and B; after: permission denied). L1 (assert EXECUTE in postflight): done. L2 (service_role may call the
  impl directly): pre-existing, trusted backend role; noted.
- `migration-drift-reviewer`: no drift. M1 (live order) is checked by the apply script. L1 (screen shows the
  `FIELD_APP_WRONG_EDITOR:` prefix) is cosmetic; the screen never sends these invoices. L2/L3 (a different refusal
  message for already-refused invoices; nothing written either way): accepted.
