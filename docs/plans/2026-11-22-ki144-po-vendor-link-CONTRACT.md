# KI-144: a purchase order keeps a link to its vendor — behavior contract

Read at `origin/staging` `ab0f6cdfc` (2026-11-22). Plan-contract pilot. Database part first; the screen and report
readers follow in their own PR once this is on the staging database.

## Facts (with sources)

- `purchase_orders.vendor` is free text with no link to `vendors` (KNOWN_ISSUES KI-144).
- Renaming a vendor (`save_vendor`) changes `vendors.name`; trigger `sync_product_vendor_on_vendor_rename`
  (`20261105180000_preferred_vendor_enforcement.sql:221`) re-copies the name onto products only. POs keep the old text.
- `_vendor_id_for_text(text)` (`20261105180000:24-45`) maps text to one active vendor through its name, an approved
  alias or an approved legacy resolution; NULL when none or several match. A rename adds no alias, so the old name
  stops matching.
- Vendor bills on a PO: `_section9_create_vendor_bill_intent_impl_20260826` (newest body `20270103180000_po_close_short.sql:374`)
  refuses `VENDOR_PO_MISMATCH` when `lower(trim(po.vendor)) <> lower(trim(vendors.name))` (`:418`). After a rename,
  every bill against an older PO for that vendor is refused.
- The `authenticated` role has no table privileges on `purchase_orders` (live read-only query, 2026-11-22: grants
  NULL); every write goes through SECURITY DEFINER functions. All of them write the `vendor` text column; none knows a
  vendor id (screens send a name: `NewPurchaseOrder.tsx`, `BulkPOImport.tsx`, `PurchaseOrderDetail.tsx`).
- `trigger_0_guard_closed_po` (`20270103180000:190-208`) refuses any header change on a closed PO except status,
  updated_at and cost totals.
- Live (read-only, 2026-11-22): 34 POs, 31 match a vendor by name, 3 match none (To-Do decision 23, Mason's call);
  0 closed POs; 0 vendor bills linked to a PO.

## Established decision

Mason, 2026-11-22 (relayed by the Lane E bug captain): **"Keep original name."** Old POs keep the vendor name they were
written with; reports and bill checks find them by vendor id. (DECISION_LOG entry added in this PR.)

## Outcome and authority

- New nullable column `purchase_orders.vendor_id uuid REFERENCES vendors(id)`, indexed. The `vendor` text stays as the
  name printed on the PO.
- Sol round 1 (3 HIGH, fixed): matching is exact active name only, no alias or legacy resolution, for the backfill and
  live saves; a billed PO is backfilled to the one vendor that billed it (bills disagree: NULL); any vendor-text edit
  re-matches by exact name (case/space-only edit with no exact match keeps the link); a link change is refused while
  another vendor has a live bill on the PO (`PO_VENDOR_HAS_BILLS`). MED refuted: column read grant shows only exact-name
  links reps could infer from the printed text; the 40P01 deadlock is documented and retryable.
- Sol round 2 (3 HIGH fixed, 1 refuted): matching is the bill check's own rule (case and outer spaces only, no
  punctuation folding); soft-deleted bills are ignored like voided ones; a vendor-text change on an UNLINKED PO with a
  live bill is refused too. Refuted: "psql -1 without -f fails" (the prover applies via stdin with -1 and prints
  POSTFLIGHT_OK; run 2026-11-22). MEDs refuted: service_role direct bill writes are pre-existing; rep visibility is the
  PO's own vendor; 40P01 documented. Bill-picker search by printed name: screen follow-up.
- One name = one vendor (Mason, 2026-11-22, "go with a"). Creating, renaming or
  restoring a vendor to a name printed on another vendor's purchase orders (linked to it or billed by it) is refused with
  `VENDOR_NAME_ON_OTHER_VENDOR_POS` and a suggestion ("<name> LLC"). New name reuse is refused from this migration on.
  Name reuse that already happened
  before this migration cannot be detected; live evidence shows no PO linked away from its name match.
- Matching (`_po_vendor_id_for_text`): an active vendor whose normalized name equals the text wins (names are unique
  among active vendors); otherwise NULL (no alias; see Sol round 1 above).
- A BEFORE INSERT OR UPDATE trigger owns `vendor_id`: on insert, or when the NORMALIZED `vendor` text changes, it
  matches again by exact name (see Sol round 1 above); on any other update it keeps `OLD.vendor_id`. Whatever a writer
  puts in `vendor_id` is overwritten, so nothing the screen sends is trusted. No RPC signature changes; the deployed
  app keeps working unchanged.
- Order inside the one migration transaction: add the column, backfill, THEN create the trigger (a trigger created
  first would reset the backfill to `OLD.vendor_id`). Unmatched rows stay NULL (the 3 live orphans stay Mason's To-Do
  decision 23; this PR links nothing by guess). The closed-PO guard is disabled for that one UPDATE only, inside the
  same transaction, and its enabled state is checked in the postflight.
- Vendor bills: when the PO has a `vendor_id`, the bill's vendor must be that id; when it has none, the old name
  comparison stays exactly as today. Same error code; the id-mismatch message names the PO's linked vendor by its
  current name and the name printed on the PO.
- Who may act is unchanged: admins create bills; PO writers are unchanged.

## State and failure

- **Rules that always hold:** `vendor_id`, when set, is the vendor the PO's text named when that text was written.
  Renaming a vendor changes neither the PO text nor `vendor_id`. Deleting (soft) a vendor keeps the link (row kept).
- **Existing rows:** backfilled as above. Readers that ignore the column are unaffected.
- **Rollout:** the deployed app sends the same calls; the trigger fills the column. No screen change in this PR.
- **Timing:** the trigger runs inside each writer's own transaction; a vendor renamed concurrently with a PO save gives
  the id of whichever name the text matched at that moment, which is the same vendor.
- **Edit after rename:** a PO screen re-sending the old text unchanged keeps the id; choosing the new name resolves to
  the same id; choosing another vendor moves the id.
- **Undo:** a new forward migration drops the trigger and restores the bill function's pinned prior body; the column
  and its values stay (they cannot be rebuilt reliably after a rename).

## Delivery

DB PR (this one): migration, prover, ledger, changelog, DECISION_LOG. Follow-up PR: screens and reports read
`vendor_id` (PO PDF vendor block, New Vendor Bill PO picker, PO list grouping, receiving filters, price-history and
vendor-link readers).

## Cold challenge (Astra gpt-6.2-astra high, 2026-11-22): 42 findings, settled

- **Fixed in this contract:** trigger-before-backfill wipe (#29); exact name loses to another vendor's alias (#2);
  case/space edit drops a link (#5); rollback drops data (#35, #36); message cannot name the conflict (#19).
- **Disproved by evidence:** wrong historical link from name reuse (#1, #10, #11, #14): live read-only 2026-11-22, the
  backfill set equals today's bill check exactly (31 POs: exact name 31, full matcher 31 unique, 0 ambiguous, bill-check
  match 31, 0 differ; `vendor` NOT NULL, 0 blank; 2 of the 3 orphans name a deleted vendor). The backfill links exactly
  the POs today's bill check already accepts, for the same vendor. Physical vendor delete (#34): no code path deletes
  a vendor row (soft delete only). NULL vendor text (#16): column is NOT NULL.
- **Pre-existing, unchanged and not worsened:** NULL-link fallback accepting a later name owner (#15) is today's rule
  for every PO; a vendor picked under its old name while being renamed (#3) or the new owner of a reused name chosen
  with identical text (#4) gives NULL / keeps the original id, never a vendor the text did not name; a stale editor
  re-sending old text (#6) is today's last-write behavior. The screen PR sends the picked vendor's id and closes #3/#4.
- **Existing business rules this change does not touch (listed for Mason, not blocking):** changing a PO's supplier
  after submission (#8), saving an unmatched vendor (#9), billing a retired vendor (#17), what a reprint shows (#7, #24),
  how reports show unlinked POs (#25). Fixing an orphan's or a wrong link (#12, #13) is To-Do decision 23, done by a
  reviewed data migration if Mason picks the vendor.
- **Proven by the prover below (MISSING-EVIDENCE):** ordering, guard state, other PO triggers' side effects (#30, #31),
  bill entry point and its other refusals (#20, #21), apply/replay (#33, #37), fixtures for alias collision, deleted
  vendor, cosmetic edit (#38). Screen/report behavior (#22, #23, #39) is the follow-up PR's browser proof; KI-144
  stays open until it lands.

## Proof cases (real-schema prover, local Docker)

1. When a PO is saved with a vendor's exact name, then `vendor_id` is that vendor; text that is only an approved
   alias links nobody.
2. When the vendor is renamed, then the old PO keeps its text and `vendor_id`, and a bill for that vendor on that PO is
   accepted (before the fix: `VENDOR_PO_MISMATCH`).
3. When a bill names a different vendor than the PO's `vendor_id`, then `VENDOR_PO_MISMATCH`.
4. When a PO's text matches no vendor, then `vendor_id` is NULL and the bill check uses the name comparison as before.
5. When a PO's vendor text is edited to another vendor, then `vendor_id` follows; an edit to other fields, or a case /
   spacing-only edit after a rename, keeps it; a writer setting `vendor_id` directly is overwritten.
6. When the backfill runs, then matching rows are linked (closed POs included, guard enabled again afterwards, other
   header columns and activity rows unchanged) and unmatched or deleted-vendor rows stay NULL.
7. A direct attempt to set `vendor_id` by an RPC-less path is not possible for `authenticated` (no table privilege),
   and the trigger overrides any value a definer writer passes.
8. Apply: autocommit refused, POSTFLIGHT_OK, re-apply refused.

## Open business decisions

None. Linking the 3 orphan POs stays To-Do decision 23.
