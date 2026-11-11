# KI-143 behavior contract: vendor bills checked against what arrived

Read at `origin/main` 17ba96fbe, 2026-11-10. Live read-only checks the same day. Settled after one cold challenge
(Astra, gpt-6-astra high, 58 findings; settlement below).

## Facts (with source)

- `create_vendor_bill` latest body: `supabase/migrations/20261204100000_ki18_batch1_chicago_today.sql` L4950; live
  `md5(prosrc)` = repo (9f17ea87…). Chain: `create_vendor_bill` → `_section9_create_vendor_bill_cumulative_impl` →
  `_section9_create_vendor_bill_intent_impl_20260826` (live body read 2026-11-10).
- The public wrapper asks for confirmation + reason when the running total of active bills on the PO exceeds 105% of
  `purchase_orders.total_cost_cents` (or that total is ≤ 0). It never reads `quantity_received`.
- **Correction to the sweep:** the private `_section9_create_vendor_bill_intent_impl_20260826` already refuses a PO
  not in submitted / partially_received / fully_received (`PO_NOT_BILLABLE`, so cancelled and draft) and a vendor
  whose name differs from the PO's vendor text ignoring case and outer spaces (`VENDOR_PO_MISMATCH`). The sweep read
  only the wrapper. Those two KI-143 claims need no change.
- `update_vendor_bill` latest body: `supabase/migrations/20260831233000_bind_section9_replays_to_intent.sql`; live md5 =
  repo (431294…). Same 105%-of-ordered rule on edits; the bill's PO and vendor are not editable.
- `total_cost_cents` = Σ round(`quantity_ordered` × `unit_cost` × 100) on all 34 live POs. `quantity_received` is in
  the line's own unit (4 POs over-received). CHECKs: `quantity_received >= 0`, `unit_cost` whole cents ≥ 0. No line
  lifecycle column.
- `vendors`: unique `normalize_vendor_alias(name)` among active vendors, so a normalized name names one vendor.
  31 of 34 POs match a vendor (case-insensitive, trimmed); 3 match none (KI-144).
- `vendor_bills`: no INSERT/UPDATE/DELETE grant to `authenticated`/`anon`; every private bill implementation is
  executable by `postgres` only. Receiving (`_section9_receive_po_items_serialized`) locks `FOR UPDATE OF poi, po`.
- Screen `src/pages/NewVendorBill.tsx` `handlePOSelect` fills the ordered total and keeps the previously picked vendor
  when the PO's vendor matches none (lower-case only, no trim).
- Live: 6 bills, 0 linked to a PO.

## Outcome and authority

A PO-linked bill (create or edit) whose running total exceeds what was received on that PO (+5%; the ordered total
+5% while nothing has arrived) needs the existing
confirmation and a reason, logged with the amounts. Authority unchanged: admin only. The PO and vendor ids are
locators; the server reads receipts, costs and status itself under the PO row lock.

Smallest change: one migration re-creating the two public wrappers with the same signatures, grants, fingerprints
and lock order, changing only the threshold base and the log text. Screen: stop pre-filling the ordered total (the
admin types the vendor bill's own figure; avoids a browser-side received total), match the vendor with trim like the
server, and clear the vendor when the PO's vendor is not on the list. Messages say "received".

Files: migration + ledger note, `src/pages/NewVendorBill.tsx`, `src/pages/VendorBillDetail.tsx` (message), the
prover, `docs/manual/KNOWN_ISSUES.md`.

## Rules

1. Received value = Σ round(`quantity_received` × `unit_cost` × 100) over the PO's lines, read after the PO lock.
2. Limit = the smaller of received value and ordered total once any quantity has arrived (a $0-cost line counts as
   arrived), else the ordered total (Mason 2026-11-10). Confirmation +
   reason are required when (other active bills + this bill) > 0 and either limit ≤ 0 or running total × 100 >
   limit × 105. Same error codes; DETAIL (admin caller only) adds
   `received_value_cents` and `limit_cents`. The activity row text is unchanged: `activity_feed` is readable by every
   active user and PO costs are admin-only, so no amounts are logged there.
3. The check is entry-time (each create and edit), PO-level dollars, as today; it is not a lasting invariant over
   later cancellations, receipt changes or cost corrections, and it does not match bill lines to PO lines.
4. A refused call stores nothing; its retry is judged against current receipts. A successful replay returns the
   stored bill (unchanged).

## Existing rows and rollout

No bill has a PO (re-check at apply: `SELECT count(*) FROM vendor_bills WHERE purchase_order_id IS NOT NULL` → 0).
The migration applies before the screen merges; between apply and deploy the old screen still pre-fills the ordered
total and its overage message says "of the purchase order", so an admin may see a confirmation whose wording names
the wrong base for that window (no wrong money outcome).

## Timing

Bill vs receipt: both lock the PO row; the received sum is read after the lock, under read committed. No new lock is
taken. Reversing a receipt changes the line before it locks the PO, so a reversal racing a bill can still leave that
bill above the new received value (existing ordering; follow-up below). Double click/retry: the unchanged durable-intent + idempotency path; new behaviour raises only existing codes.

## Undo

A wrongly confirmed bill is voided with `void_vendor_bill` (unchanged; a voided bill leaves the running total). The
code rollback is a reviewed migration restoring the two prior bodies; bills saved meanwhile stay.

## Proof cases

Real-schema prover `scripts/smoke/prove-ki143-vendor-bill-received-value-real-schema.mjs` (scratch container):
BEFORE hole; candidate applies once; cancelled/other/blank vendor still refused; $420.00 on $400 received saves and
$420.01 asks; adjustments count; DETAIL; blank reason refused; reason logged with amounts; nothing received keeps the ordered limit;
running totals; voided bills excluded; fractional receipt rounding; over-received stays capped at ordered; edits; later receipt raises
the limit; sales rep refused. Live: bodies' md5 and grants after apply, a rolled-back refusal on a live PO, and the
screen opened in the browser (no save).

## Reviewer findings (rls-security, migration-drift, compliance; 2026-11-10)

- Fixed: activity text no longer carries amounts (cost leak to non-admins); arrival judged by quantity, not value;
  postflight pins the LEAST line; sweep `section9-po-ap-controls` re-pinned to the new threshold (fingerprint
  re-authorised); screen clears the PO when its vendor is not on the list, trims spaces only like Postgres, wording.
- Accepted: editing an older bill re-checks it against the current limit, so after a partial receipt an early bill's
  edit may ask for a reason (that is the rule Mason chose; no saved bill changes).
- Follow-ups (not this PR): receipt reversal locks the PO only after changing the line; `set_purchase_order_item_costs`
  still guards cost corrections against the ordered total only; re-key the two `cost-exposure-review` allowlist
  entries after the apply (their keys hash the live bodies).

## Challenge settlement (Astra, 58 findings)

- Refuted with evidence: 6 (unique normalized vendor name), 8 (trimmed census = same counts), 9 (PO vendor NOT NULL;
  blank refused by the private check), 18 (CHECKs), 19 (no line lifecycle), 32 (impls postgres-only), 33 (no table
  write grants), 34 (private impl read: status + vendor checks, no ordered threshold), 49 (20270102 sorts after
  20261204), 12 (a received line's cost changes only through the admin, reasoned `set_purchase_order_item_costs`).
- Fixed: 24 (screen trims), 40 (rule 4 wording), 47 (log amounts), 57 (boundary, fraction, adjustment, void cases),
  58 (no browser received total: amount not pre-filled), 22/25/26/27 (moot with 58), 1/2/4/5 (status and vendor
  stay with the existing private check; Rule 3 states entry-time scope).
- Existing behaviour, unchanged, out of scope: 10, 11, 16, 17, 29, 30, 35-39, 41-46, 52 (unlinked bills), 53.
- Accepted with reason: 48 (short window, wording only), 50 (KI-142 told that `closed` needs adding to the private
  status list; KI-144 owns vendor identity), 51 (re-check at apply), 54/55 (rollback and live check above).
- Mason, 2026-11-10 (relayed by the sweep session; DECISION_LOG): bills before any receipt need no reason up to the
  ordered total +5% ("No, let early bills through"; we recommended asking); billing above the ordered total always needs a reason, even
  when more arrived ("no do not allow to go more than was ordered without a reason", correcting "Yes, allow it").
