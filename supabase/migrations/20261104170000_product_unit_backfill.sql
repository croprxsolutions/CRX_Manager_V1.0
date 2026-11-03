-- Written 2026-11-03. STATUS: NOT APPLIED.
-- DATA (WP-PM-6a): sets products.unit_size to the product's inventory_unit on the nine rows the
-- owner approved one by one on 2026-11-03 (private review list): one 'LB' spelled 'Lb' to match,
-- and eight stored as '' (empty text). Rows are named by id only; no other row, column, grant or
-- function changes.
-- Order, quote, job, invoice, delivery and PO lines keep their own stored unit and amounts; no
-- trigger copies a product's unit into them. The per-acre prices read inventory_unit first, so
-- they and pricing_version must stay unchanged; the statement below refuses if they move.
-- A database without these products (a fresh rebuild) changes nothing. On a database that has
-- any of them, all nine must still hold exactly the approved old values, or nothing changes.
-- write_product_change_history records each row's unit_size change (actor NULL: no signed-in user).
-- ROLLBACK: for each id below, set unit_size back to its old_unit (a reviewed migration).

SET LOCAL lock_timeout = '5s';

DO $unit_backfill$
DECLARE
  v_present integer;
  v_updated integer;
  v_price_moved integer;
BEGIN
  WITH approved(id, old_unit, new_unit) AS (VALUES
    ('0294faa8-ab0b-488e-9efe-868071738625'::uuid, 'LB', 'Lb'),
    ('8b9c7b32-3257-4609-9a01-59e9413cd983'::uuid, '', 'Gal'),
    ('47d6e393-a133-425a-8706-8807f1657425'::uuid, '', 'Gal'),
    ('9a1716a2-8ac3-42e6-887b-64795fca3a57'::uuid, '', 'MG'),
    ('4ea8df3a-66cf-4eed-8171-c36e88a00b7d'::uuid, '', 'Gal'),
    ('4983d7c2-45cc-4acd-b915-45e92184c563'::uuid, '', 'Gal'),
    ('0c4d06e2-7cdb-4d75-855a-155199e23b8b'::uuid, '', 'Gal'),
    ('3ba6df61-b644-4f25-97a9-33a9dfda88b5'::uuid, '', 'Gal'),
    ('7ff61807-b0f9-4983-a7a8-3c2d0b2876b2'::uuid, '', 'Gal')
  ),
  -- Every sub-statement reads the same pre-update snapshot, so "before" is the old row.
  before AS (
    SELECT p.id, p.tier1_price_per_acre, p.tier2_price_per_acre, p.tier3_price_per_acre,
           p.pricing_version
      FROM public.products p JOIN approved a ON a.id = p.id
  ),
  changed AS (
    UPDATE public.products p
       SET unit_size = a.new_unit
      FROM approved a
     WHERE p.id = a.id
       AND p.unit_size = a.old_unit
       AND p.inventory_unit = a.new_unit
    RETURNING p.id, p.tier1_price_per_acre, p.tier2_price_per_acre, p.tier3_price_per_acre,
              p.pricing_version
  )
  SELECT (SELECT count(*) FROM before),
         (SELECT count(*) FROM changed),
         (SELECT count(*) FROM changed c JOIN before b ON b.id = c.id
           WHERE (c.tier1_price_per_acre, c.tier2_price_per_acre, c.tier3_price_per_acre, c.pricing_version)
                 IS DISTINCT FROM
                 (b.tier1_price_per_acre, b.tier2_price_per_acre, b.tier3_price_per_acre, b.pricing_version))
    INTO v_present, v_updated, v_price_moved;

  IF v_present = 0 THEN
    RAISE NOTICE 'PRODUCT_UNIT_BACKFILL: none of the approved products exist here; nothing changed';
    RETURN;
  END IF;
  IF v_present <> 9 OR v_updated <> 9 THEN
    RAISE EXCEPTION 'PRODUCT_UNIT_BACKFILL_DRIFT: % of 9 approved products present, % still held the approved values; re-review the list', v_present, v_updated;
  END IF;
  IF v_price_moved <> 0 THEN
    RAISE EXCEPTION 'PRODUCT_UNIT_BACKFILL_PRICE_MOVED: % products changed a per-acre price or pricing version', v_price_moved;
  END IF;
END;
$unit_backfill$;
