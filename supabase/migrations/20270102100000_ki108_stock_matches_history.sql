-- idempotency-body-check: exempt
-- ============================================================================
-- KI-108: make five products' stored stock match their transaction history.
--
-- Data-only. No function, policy or schema change.
--
-- Mason decided in chat on 2026-11-10: trust the transaction history. For
-- 2, 4D Amine 4# - 2.5 Gal, whose history adds to -70 because its March opening
-- load was never recorded, keep the stored 25 and add the missing +95
-- opening-stock row ("Keep 25, add +95").
--
--   Black Strap Molasses Sugar - Tote   2000   -> 675     (stored set to history)
--   Start Right 2.0 (AgBio) - Tote      670.19 -> 140.19  (stored set to history)
--   2, 4D Amine 4# - Bulk               55     -> 0       (stored set to history)
--   Start Right 2.0 (AgBio) - 2.5 Gal   290    -> 280     (stored set to history)
--   2, 4D Amine 4# - 2.5 Gal            25 stays; +95 'adjusted' ledger row
--
-- The approved state is bound below by a signature per product (inventory row
-- id, stored, pre-booked, ledger total, ledger row count, newest ledger time),
-- plus: one inventory row per product, no in-progress cycle count on them.
-- Any difference raises KI108_PREIMAGE_DRIFTED and changes nothing. A database
-- with none of the five PRODUCTS (schema-only rebuild) is a no-op; products
-- present with different rows raise. The ledger total uses the same rules as
-- checkInventoryLedger in src/lib/reconciliation.ts, including its
-- PREBOOK_ONLY_ADJUSTMENT_TX_IDS exclusion.
--
-- Rollback: one transaction. After a successful apply, roll forward: restore
-- the four stored values above and add a -95 'adjusted' row for 2,4D 2.5 Gal
-- (ledger rows are immutable).
-- Contract: docs/plans/2026-11-10-ki108-stock-matches-history-CONTRACT.md
-- ============================================================================

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE public.inventory, public.inventory_transactions IN SHARE ROW EXCLUSIVE MODE;

DO $ki108$
DECLARE
  v_approved jsonb := $rows$
  [
    {"inv_id":"b9ec0d1b-89cb-4595-9ab9-4b46d58d30d2","product_id":"b6e75c1b-f12b-48dd-b946-1fc0298c2ae6","stored":"2000","ledger":"675","tx_count":4,"last_tx":"2026-03-23 20:20:06.997524+00","target":"675","add_opening":"0"},
    {"inv_id":"4f3d6b53-e213-4b2f-9310-ab6080adf81b","product_id":"bab9e77a-26a2-4465-b454-f01c19dc847b","stored":"670.19","ledger":"140.19","tx_count":23,"last_tx":"2026-04-28 14:42:30.410206+00","target":"140.19","add_opening":"0"},
    {"inv_id":"ee742c21-b168-42b1-bdf4-95f179c62bd8","product_id":"9cb10775-b789-4f5b-82ef-62fe827446d5","stored":"55","ledger":"0","tx_count":4,"last_tx":"2026-03-18 14:57:18.204829+00","target":"0","add_opening":"0"},
    {"inv_id":"3d13a723-444b-4412-9d1e-c416fdd959d8","product_id":"ddf27cdc-3296-4e74-9805-21b301033d8f","stored":"290","ledger":"280","tx_count":4,"last_tx":"2026-04-16 18:24:30.82271+00","target":"280","add_opening":"0"},
    {"inv_id":"ac6b4862-40de-475c-8d46-1fbe306b47f0","product_id":"edae4256-b9b1-48d0-80e0-16aa67362a4a","stored":"25","ledger":"-70","tx_count":11,"last_tx":"2026-07-17 20:10:34.295591+00","target":"25","add_opening":"95"}
  ]
  $rows$::jsonb;
  -- Mason's admin profile; he approved this correction.
  v_actor constant uuid := '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f';
  -- PREBOOK_ONLY_ADJUSTMENT_TX_IDS in src/lib/reconciliation.ts.
  v_prebook_only constant uuid[] := '{14880dd6-9324-4a6e-a1fb-f951b87ad090,23a36a20-db16-42a1-8346-ba9bd97894eb,d6b92523-5bc2-43d5-a566-2b8399596a9b,86fc5133-776e-463c-ac6b-f67bbf1f76ae,386a1ce0-1cf7-422e-86f9-55cd105cc93f}'::uuid[];
  v_present int;
  v_bad int;
BEGIN
  SELECT count(*) INTO v_present
  FROM public.products p
  WHERE p.id IN (SELECT (r->>'product_id')::uuid FROM jsonb_array_elements(v_approved) r);

  IF v_present = 0 THEN
    RAISE NOTICE 'KI108: none of the five products exist; no-op';
    RETURN;
  END IF;

  -- Bind the approved state (a signature per product, see header).
  WITH a AS (
    SELECT (r->>'inv_id')::uuid inv_id, (r->>'product_id')::uuid product_id,
           (r->>'stored')::numeric stored, (r->>'ledger')::numeric ledger,
           (r->>'tx_count')::int tx_count, (r->>'last_tx')::timestamptz last_tx
    FROM jsonb_array_elements(v_approved) r
  ), l AS (
    SELECT t.product_id,
           sum(CASE
                 WHEN t.transaction_type IN ('received','returned','cancelled_delivery_reversal','void_delivery_reversal') THEN abs(t.quantity)
                 WHEN t.transaction_type IN ('delivered','job_applied') THEN -abs(t.quantity)
                 WHEN t.transaction_type IN ('adjusted','transferred','tote_fill_out','tote_fill_in') THEN t.quantity
                 ELSE 0 END) ledger,
           count(*) tx_count, max(t.created_at) last_tx
    FROM public.inventory_transactions t
    WHERE t.product_id IN (SELECT product_id FROM a)
      AND t.id NOT IN (SELECT unnest(v_prebook_only))
    GROUP BY t.product_id
  )
  SELECT count(*) INTO v_bad
  FROM a
  LEFT JOIN public.inventory i ON i.id = a.inv_id
  LEFT JOIN l ON l.product_id = a.product_id
  WHERE i.id IS NULL
     OR i.product_id IS DISTINCT FROM a.product_id
     OR i.location IS DISTINCT FROM 'Main Warehouse'
     OR i.quantity_available IS DISTINCT FROM a.stored
     OR i.quantity_prebooked IS DISTINCT FROM 0
     OR l.ledger IS DISTINCT FROM a.ledger
     OR l.tx_count IS DISTINCT FROM a.tx_count
     OR l.last_tx IS DISTINCT FROM a.last_tx
     OR (SELECT count(*) FROM public.inventory i2 WHERE i2.product_id = a.product_id) <> 1
     OR EXISTS (SELECT 1 FROM public.cycle_count_items ci JOIN public.cycle_counts c ON c.id = ci.cycle_count_id
                WHERE ci.product_id = a.product_id AND c.status = 'in_progress');

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'KI108_PREIMAGE_DRIFTED: % of 5 rows differ from the approved 2026-11-10 state', v_bad;
  END IF;

  -- Records who approved it (historical fact), not a current-permission check.
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor) THEN
    RAISE EXCEPTION 'KI108_ACTOR_MISSING: approving profile not found';
  END IF;

  -- The +95 reconciliation row (2, 4D Amine 4# - 2.5 Gal), Mason 2026-11-10.
  INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, to_location, performed_by, notes)
  SELECT (r->>'product_id')::uuid, 'adjusted', (r->>'add_opening')::numeric, 'Main Warehouse', v_actor,
         'KI-108 reconciliation (migration 20270102100000, approved by Mason 2026-11-10): the history was 95 '
         || 'below stored stock, most likely opening stock never recorded. Stored stock unchanged.'
  FROM jsonb_array_elements(v_approved) r
  WHERE (r->>'add_opening')::numeric <> 0;

  -- Stored stock set to the history for the other four.
  UPDATE public.inventory i
  SET quantity_available = (r->>'target')::numeric, updated_at = now()
  FROM jsonb_array_elements(v_approved) r
  WHERE i.id = (r->>'inv_id')::uuid
    AND i.quantity_available IS DISTINCT FROM (r->>'target')::numeric;

  -- Postcondition: stored equals history for all five.
  SELECT count(*) INTO v_bad
  FROM jsonb_array_elements(v_approved) r
  JOIN public.inventory i ON i.id = (r->>'inv_id')::uuid
  WHERE i.quantity_available IS DISTINCT FROM (r->>'target')::numeric
     OR i.quantity_available IS DISTINCT FROM (
          SELECT sum(CASE
                   WHEN t.transaction_type IN ('received','returned','cancelled_delivery_reversal','void_delivery_reversal') THEN abs(t.quantity)
                   WHEN t.transaction_type IN ('delivered','job_applied') THEN -abs(t.quantity)
                   WHEN t.transaction_type IN ('adjusted','transferred','tote_fill_out','tote_fill_in') THEN t.quantity
                   ELSE 0 END)
          FROM public.inventory_transactions t
          WHERE t.product_id = i.product_id
            AND t.id NOT IN (SELECT unnest(v_prebook_only)));

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'KI108_POSTCONDITION_FAILED: % of 5 rows still differ from history', v_bad;
  END IF;
END
$ki108$;
