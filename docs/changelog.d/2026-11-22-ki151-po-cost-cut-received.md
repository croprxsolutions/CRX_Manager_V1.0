## 2026-11-22 - KI-151: a PO cost correction is judged against what arrived

- Migration `20270223100000_po_cost_cut_judged_against_received.sql`: `set_purchase_order_item_costs` refuses a cost cut that would leave the PO's active vendor bills more than 5% over what arrived (once anything has arrived) or over the ordered total (before anything arrives), the same limit vendor bills use since KI-143. Before, it compared only with the ordered total, so a received line could be cut below what was billed for it.
- No data changes. Applies after the KI-197 migration (same function).
- Proof: `node scripts/smoke/prove-po-cost-cut-received-real-schema.mjs` (`PO_COST_CUT_RECEIVED_PROOF_PASS`, local Docker).
- Not verified: the staging database (applied by the staging DB job after merge).
