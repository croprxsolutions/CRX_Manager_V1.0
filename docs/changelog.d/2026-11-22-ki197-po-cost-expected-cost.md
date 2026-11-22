## 2026-11-22 - KI-197: the database can refuse a PO cost correction made from a stale screen (database part; the screen PR turns it on)

- Migration `20270214100000_po_cost_expected_cost_check.sql`: `set_purchase_order_item_costs` accepts the cost the admin saw for each line and refuses the whole save (`PO_COST_CHANGED_SINCE_LOADED`) if someone changed that cost since. Before, a second admin working from an older screen silently replaced a newer correction.
- No data changes. Older screens keep working as before; the screen PR sends the field after this is on the staging database, and a follow-up makes it required once every screen sends it.
- Proof: `node scripts/smoke/prove-po-cost-expected-cost-real-schema.mjs` (`PO_COST_EXPECTED_COST_PROOF_PASS`, local Docker): matching cost saves; a stale line refuses the whole call with nothing saved; a stale confirm is refused; bad values refused by name; replay returns the first result; two admins on different lines both save; received-line reason, cancelled PO and admin-only rules unchanged; two real sessions racing give one winner and one refusal.
- Not verified: the staging database (applied by the staging DB job after merge).
