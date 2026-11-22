## 2026-11-22 - KI-151: a PO cost correction is judged against what arrived

- Migration `20270223100000_po_cost_cut_judged_against_received.sql`: `set_purchase_order_item_costs` refuses a cost cut when it puts the PO's active vendor bills more than 5% over what arrived (capped at the ordered total; the ordered total before anything arrives, the same limit vendor bills use since KI-143) after they were within it, so a bill already over what arrived (billed up front, goods still coming) does not block a correction (Mason, 2026-11-22). As before, no cut may leave the bills more than 5% over the ordered total. Before, it compared only with the ordered total, so a received line could be cut below what was billed for it.
- No data changes. Applies after the KI-197 migration (same function).
- Proof: `node scripts/smoke/prove-po-cost-cut-received-real-schema.mjs` (`PO_COST_CUT_RECEIVED_PROOF_PASS`, local Docker).
- Not verified: the staging database (applied by the staging DB job after merge).
