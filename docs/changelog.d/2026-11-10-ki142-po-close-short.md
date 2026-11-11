## 2026-11-10 — KI-142: close a partly received purchase order short (database, not applied)

- Migration `20270103180000_po_close_short.sql`: new PO status `closed` and `close_purchase_order_short`; the unreceived
  remainder stops counting as on order. A closed PO is final and frozen, can still be billed for what arrived, and a
  receipt reversal keeps it closed. No live PO is closed by this change (which ones to close is Mason's To-Do 23).
- Contract: `docs/plans/2026-11-10-ki142-po-close-short-CONTRACT.md`.
- Proof: `node scripts/smoke/prove-po-close-short-real-schema.mjs`.
- The Close Short button ships in a second PR after the database is live. This PR already lets a bill link to a closed
  PO, keeps closed POs out of Outstanding, adds a Closed Short filter and label, and hides Edit and bulk cancel for them.
- Applies after KI-143 (`20270103110000`). A closed PO can never be billed past what arrived, with no override: a bill or a
  receipt reversal that would break it is refused (Sol rounds 1-2). A closed PO's line costs can be raised but never
  lowered (Mason, 2026-11-11).
