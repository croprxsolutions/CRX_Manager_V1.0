-- =============================================================================
-- stock-matches-history.sql — a product's stock equals its signed movement history
-- KI-159 (docs/manual/KNOWN_ISSUES.md), Product Master review 2026-11-13 C-5.
--
-- INVARIANT
--   For each product with any history, SUM(inventory.quantity_available) over all of
--   its stock rows equals the signed sum of its inventory_transactions. Same rules as
--   the browser check (src/lib/reconciliation.ts checkInventoryLedger):
--     add:      received, cancelled_delivery_reversal, void_delivery_reversal
--     subtract: delivered, job_applied
--     signed:   adjusted, transferred, returned, tote_fill_out, tote_fill_in
--     ignored:  booked, prebooked, released, prebook_reconciliation (prebook only) and
--               unknown types, plus the five historical prebook-only `adjusted` rows.
--   `returned` is signed: a return receipt writes +qty, its cancellation -qty
--   (_cancel_return_intent_impl_20260812). Reading it as always-positive would
--   expect +20 after a received-then-cancelled return of 10 (KI-159).
--   History rows carry no stock-row id, so the check is per product, not per row
--   (a per-row check flags every product held in two warehouses).
--
-- WOULD HAVE CAUGHT
--   A write path that moves quantity_available without a history row (or the
--   reverse), and any "trust the history" repair run with the wrong sign: KI-108's
--   20270103150000 repair read `returned` as always-positive. Any repeat of a
--   history-based repair must use the signed rule above.
--
-- EXPECTED RESULT
--   ZERO rows (live 2026-11-15, read-only: 0 rows; 0 `returned` rows exist).
--
-- KNOWN LIMITS
--   * A product with no history at all is not checked (its opening balance is unknown).
--   * Tolerance 0.01 of the stock unit, like the browser check.
-- =============================================================================
WITH tx AS (
  SELECT t.product_id,
         SUM(CASE
               WHEN t.transaction_type IN ('received', 'cancelled_delivery_reversal', 'void_delivery_reversal')
                 THEN abs(t.quantity)
               WHEN t.transaction_type IN ('delivered', 'job_applied')
                 THEN -abs(t.quantity)
               WHEN t.transaction_type IN ('adjusted', 'transferred', 'returned', 'tote_fill_out', 'tote_fill_in')
                 THEN t.quantity
               ELSE 0
             END) AS expected_qty
  FROM inventory_transactions t
  WHERE t.id NOT IN (
    '14880dd6-9324-4a6e-a1fb-f951b87ad090'::uuid,
    '23a36a20-db16-42a1-8346-ba9bd97894eb'::uuid,
    'd6b92523-5bc2-43d5-a566-2b8399596a9b'::uuid,
    '86fc5133-776e-463c-ac6b-f67bbf1f76ae'::uuid,
    '386a1ce0-1cf7-422e-86f9-55cd105cc93f'::uuid)
  GROUP BY t.product_id
),
stock AS (
  SELECT i.product_id, SUM(i.quantity_available) AS actual_qty
  FROM inventory i
  WHERE i.quantity_available IS NOT NULL
  GROUP BY i.product_id
)
SELECT
  'product:' || s.product_id::text || ':stock_vs_history'           AS identity_key,
  'stock_vs_history'::text                                         AS violation_type,
  round(tx.expected_qty, 2)                                        AS expected_qty,
  round(s.actual_qty, 2)                                           AS actual_qty,
  'Product ' || COALESCE(p.product_name, s.product_id::text) || ': stock '
    || round(s.actual_qty, 2)::text || ' but history totals '
    || round(tx.expected_qty, 2)::text                             AS detail,
  'product:' || s.product_id::text || ':stock_vs_history'           AS violation_key
FROM stock s
JOIN tx ON tx.product_id = s.product_id
LEFT JOIN products p ON p.id = s.product_id
WHERE abs(s.actual_qty - tx.expected_qty) > 0.01
ORDER BY identity_key;
