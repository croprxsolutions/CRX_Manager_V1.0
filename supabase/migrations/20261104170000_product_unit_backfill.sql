-- Written 2026-11-03. STATUS: NOT APPLIED.
-- DATA (WP-PM-6a): sets products.unit_size to the product's inventory_unit on the nine rows the
-- owner approved one by one on 2026-11-03 (private review list): one 'LB' spelled 'Lb' to match,
-- and eight stored as '' (empty text), and stamps their updated_at. Rows are named by id only.
-- It also adds one trigger (below) so a Unit that matches its inventory unit cannot be changed
-- on its own (its function's EXECUTE is revoked from every API role). No other row, column,
-- grant or function changes.
-- Order, quote, job, invoice, delivery and PO lines keep their own stored unit and amounts; no
-- trigger copies a product's unit into them. The per-acre prices read inventory_unit first, so
-- every other column (prices, per-acre prices, pricing_version, use timings) must stay as it was;
-- the statement below refuses if any column but unit_size and updated_at moves.
-- A database without these products (a fresh rebuild) changes no rows. On a database that has
-- any of them, all nine must still hold exactly the approved old values, or nothing changes.
-- write_product_change_history records each row's unit_size change (actor NULL: no signed-in user).
-- ROLLBACK (a reviewed migration): drop trg_keep_product_unit and its function first, then set
-- each id below back to its old_unit.

SET LOCAL lock_timeout = '5s';

DO $unit_backfill$
DECLARE
  v_present integer;
  v_updated integer;
  v_other_moved integer;
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
    SELECT p.id, to_jsonb(p) - 'unit_size' - 'updated_at' AS rest
      FROM public.products p JOIN approved a ON a.id = p.id
  ),
  changed AS (
    UPDATE public.products p
       SET unit_size = a.new_unit, updated_at = now()
      FROM approved a
     WHERE p.id = a.id
       AND p.unit_size = a.old_unit
       AND p.inventory_unit = a.new_unit
    RETURNING p.id, to_jsonb(p) - 'unit_size' - 'updated_at' AS rest
  )
  SELECT (SELECT count(*) FROM before),
         (SELECT count(*) FROM changed),
         (SELECT count(*) FROM changed c JOIN before b ON b.id = c.id
           WHERE c.rest IS DISTINCT FROM b.rest)
    INTO v_present, v_updated, v_other_moved;

  IF v_present = 0 THEN
    RAISE NOTICE 'PRODUCT_UNIT_BACKFILL: none of the approved products exist here; nothing changed';
    RETURN;
  END IF;
  IF v_present <> 9 OR v_updated <> 9 THEN
    RAISE EXCEPTION 'PRODUCT_UNIT_BACKFILL_DRIFT: % of 9 approved products present, % still held the approved values; re-review the list', v_present, v_updated;
  END IF;
  IF v_other_moved <> 0 THEN
    RAISE EXCEPTION 'PRODUCT_UNIT_BACKFILL_OTHER_COLUMN_MOVED: % products changed a column other than unit_size', v_other_moved;
  END IF;
END;
$unit_backfill$;

-- Keep a matching Unit matching. The product page re-sends the stored Unit on every save and
-- checks only pricing_version, so a page opened before this file would write the old blank back.
-- No screen edits the Unit and no database function writes it, so once it equals the inventory
-- unit it may change only in the same update that changes the inventory unit.
CREATE FUNCTION public.guard_product_unit_matches_inventory_unit() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  IF OLD.unit_size = OLD.inventory_unit
     AND NEW.unit_size IS DISTINCT FROM OLD.unit_size
     AND NEW.inventory_unit IS NOT DISTINCT FROM OLD.inventory_unit THEN
    RAISE EXCEPTION 'PRODUCT_UNIT_STALE: this product''s Unit was updated; reload the page and save again'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_product_unit_matches_inventory_unit() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_product_unit_matches_inventory_unit()
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trg_keep_product_unit BEFORE UPDATE OF unit_size, inventory_unit ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_unit_matches_inventory_unit();
