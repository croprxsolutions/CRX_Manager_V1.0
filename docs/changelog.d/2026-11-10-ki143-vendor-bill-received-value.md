## 2026-11-10 — KI-143: PO-linked vendor bills are checked against what arrived (PR #1769; applied live 2026-11-11 8:24 AM Central, ledger `20261111142411`)

- Migration `20270103110000_ki143_vendor_bill_received_value_checks.sql` re-creates `create_vendor_bill` and
  `update_vendor_bill` (same signatures, grants, idempotency and lock order). A bill linked to a purchase order now
  needs the existing confirmation and a reason when the PO's running bill total goes above 105% of the value
  received on it (received quantity x unit cost, whole cents per line), never above the ordered total. Before it was 105% of the ordered total, so a
  short shipment could be billed and paid in full with no question.
- Mason, 2026-11-10: until anything has arrived on the PO, the ordered total stays the limit (early bills pass as
  before); billing above the ordered total (+5%) always needs a reason, even when more arrived.
- The refusal detail (seen only by the admin making the call) adds `received_value_cents` and `limit_cents`. The
  activity row text is unchanged: no costs go to the activity feed, which every active user can read.
- "Arrived" means any quantity received, even on a $0-cost line. The live sweep `section9-po-ap-controls` is re-pinned
  to the new threshold.
- Status and vendor checks were already enforced one layer down (`PO_NOT_BILLABLE`, `VENDOR_PO_MISMATCH`); unchanged.
- New Vendor Bill no longer fills in the PO's ordered total as the amount, and a PO whose vendor is not on the vendor list
  is not linked; the admin is told why.
- Contract: `docs/plans/2026-11-10-ki143-vendor-bill-received-value-CONTRACT.md`.
- Proof: `node scripts/smoke/prove-ki143-vendor-bill-received-value-real-schema.mjs`.
