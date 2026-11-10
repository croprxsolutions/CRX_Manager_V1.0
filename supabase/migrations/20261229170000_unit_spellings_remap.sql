-- RT-2 step 1 (RT-2a, Product Master Stage 4): move 20 products onto one spelling per unit (data only).
--
-- WHY: unit_conversions spells three units two ways (oz/Oz, qt/Qt, Lb/LB). validate_product_units matches a
-- product's stock and container unit EXACTLY, so the alias rows cannot be deleted (step 2) while products still
-- use them. Mason chose the winners on 2026-11-09 ("Yes, all three"): oz, qt and Lb stay; Unit and Ea stay
-- separate. The two dry products whose rate unit is the liquid "oz" (Autumn Super 51 WDG, Cimarron Plus) are NOT
-- moved here: refresh_watchdog_flags compares a saved job's rate unit with the product's, so "oz" against
-- "Dry oz" would drop an over-rate warning. They move in step 2 with a watchdog fix (Mason, 2026-11-09).
-- Build sheet: docs/plans/2026-11-09-product-RT2-BUILD-SHEET.md, section 4 (PR #1703).
--
-- WHAT: exactly these 20 rows change, each pinned by id, name, form and its current spelling:
--   11 stock units Oz -> oz and 8 stock units Qt -> qt (inventory_unit and unit_size together),
--   1 rate unit LB -> Lb (Imazuron Herbicide).
-- The stock rows' inventory.unit_size snapshots move with them (the product stock card totals only rows whose
-- units match exactly); their count is pinned (0 live 2026-11-09).
-- Every factor is unchanged (oz = Oz = 1, qt = Qt = 32, Lb = LB = 16), so no price moves.
-- unit_conversions is NOT changed: both spellings keep working until step 2.
-- guard_product_setup_fields refuses any change to a saved product's stock unit ("it waits for the reviewed unit
-- change"); this migration is that reviewed change, so it disables that one trigger for its own UPDATE and
-- enables it again in the same transaction. Every other product trigger runs: validate_product_units checks
-- each new spelling, the rate-lock and pricing guards see the rate change (pricing_version +1 on the one rate
-- row), and write_product_change_history records old and new values (actor null, as in any migration).
-- No schema, function, grant or policy change.
--
-- REFUSES (and changes nothing) if: the rate lock is on; unit_conversions is not exactly its 14 reviewed rows;
-- any listed product moved (id, name, form or current spelling); any other product or family uses Oz, Qt or LB;
-- a listed product is in a product family or has a net weight; the stock rows' old-spelling inventory snapshots
-- are not the pinned count.
--
-- ROLLBACK: scripts/smoke/rt2a-unit-spellings-remap-reverse.sql puts each listed product back to its old
-- spelling with the same trigger handling (proven by scripts/smoke/prove-unit-spellings-real-schema.mjs).
-- To use it live, copy it into a new migration through the normal gates.

DO $rt2a$
DECLARE
  v_bad text;
  v_done integer;
  v_fn_before text;
  v_fn_after text;
  -- inventory rows of the 19 stock products still on the old spelling (read live 2026-11-09).
  v_inv_expected constant integer := 0;
BEGIN
  -- Set here, not with SET LOCAL above the block, so it holds however the file is run.
  PERFORM set_config('lock_timeout', '10s', true);
  -- Product tables first, then the units table (the same order as step 2, so the two never deadlock). This
  -- waits for any product save in flight and holds new ones until commit, so no save can add an Oz, Qt or LB
  -- product, join a family, gain a net weight or add an inventory snapshot between the checks below and the update.
  LOCK TABLE public.products, public.product_parents, public.product_parent_members,
             public.product_size_net_weight_values, public.product_form_units,
             public.inventory IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.unit_conversions IN SHARE MODE;

  CREATE TEMP TABLE rt2a_map (id uuid PRIMARY KEY, product_name text NOT NULL, product_form text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('stock', 'rate')), old_unit text NOT NULL, new_unit text NOT NULL) ON COMMIT DROP;
  INSERT INTO rt2a_map (id, product_name, product_form, kind, old_unit, new_unit) VALUES
    ('2317db27-438a-4821-8946-d24a3313bd56'::uuid, 'Armezon - 32 oz', 'liquid', 'stock', 'Oz', 'oz'),
    ('7d172b07-2974-4474-a5d5-7b36521fa6d0'::uuid, 'Drive XLR8 - 64 oz', 'liquid', 'stock', 'Oz', 'oz'),
    ('76cc1352-4de1-4d81-abaf-b712c8cf96d7'::uuid, 'Endura - 104 oz', 'liquid', 'stock', 'Oz', 'oz'),
    ('b5d42717-1626-4962-bd74-f69e671cc615'::uuid, 'Evito - 128 oz', 'liquid', 'stock', 'Oz', 'oz'),
    ('98602d58-b6a2-4666-abe1-fd124e427e09'::uuid, 'Impact - 128 oz', 'liquid', 'stock', 'Oz', 'oz'),
    ('43b22e56-3c51-4d4e-a5e4-0dea1f68c8f8'::uuid, 'Nurizma - 64 Oz', 'liquid', 'stock', 'Oz', 'oz'),
    ('2078bc12-86b9-4b83-aa8f-6eeae1997bf2'::uuid, 'Panoflex - 20 oz', 'liquid', 'stock', 'Oz', 'oz'),
    ('02a8036b-ff8d-4eca-a71c-7db0081bf16a'::uuid, 'Sefina - 140 oz', 'liquid', 'stock', 'Oz', 'oz'),
    ('3a81a72a-4a9c-4a7f-ad51-84587f8d7d8b'::uuid, 'Status - 125 oz', 'liquid', 'stock', 'Oz', 'oz'),
    ('567986e5-a8f4-4124-8750-64fd63ba94bd'::uuid, 'Steadfast Q - 60 oz', 'liquid', 'stock', 'Oz', 'oz'),
    ('eaf74d51-1714-49e7-9c50-7129e07c3a4f'::uuid, 'Trivence - 200 Oz', 'liquid', 'stock', 'Oz', 'oz'),
    ('a9de3015-425a-4e43-a669-2be592cf7935'::uuid, 'AIM 2EC - 1 Qt', 'liquid', 'stock', 'Qt', 'qt'),
    ('322ca15d-1273-4cbf-8ea2-76125df2c2a0'::uuid, 'Cadet - 1 Qt', 'liquid', 'stock', 'Qt', 'qt'),
    ('05b9f5d8-3305-4234-afaa-e7a63c3b46f9'::uuid, 'Effect-GC - 1 Qt', 'liquid', 'stock', 'Qt', 'qt'),
    ('e87cdf63-6e9b-4d3b-884d-6410fcca4723'::uuid, 'Elevore - 1 Qt', 'liquid', 'stock', 'Qt', 'qt'),
    ('3e0c3fc3-aff4-4fdc-ba7b-353b2093d44d'::uuid, 'Make Foam - 1 Qt', 'liquid', 'stock', 'Qt', 'qt'),
    ('30bd948b-f0c0-4d02-8cd5-89b729395262'::uuid, 'Milestone - 1 Qt', 'liquid', 'stock', 'Qt', 'qt'),
    ('e453fc17-c8b9-4e6c-89c1-7468b7875184'::uuid, 'Prevent Foam - 1  Qt', 'liquid', 'stock', 'Qt', 'qt'),
    ('28087f6b-e3f4-4caa-8d0f-3c25ea2cf8e5'::uuid, 'Tordon RTU - 1 Qt', 'liquid', 'stock', 'Qt', 'qt'),
    ('0294faa8-ab0b-488e-9efe-868071738625'::uuid, 'Imazuron Herbicide', 'dry', 'rate', 'LB', 'Lb');

  -- The rate lock must be off: the rate change and the stock-unit changes of rated products pass
  -- guard_product_rate_lock only while it is.
  -- FOR SHARE holds the lock state until commit, so nobody can lock rates halfway through.
  IF NOT EXISTS (SELECT 1 FROM public.product_rate_lock WHERE is_locked = false FOR SHARE) THEN
    RAISE EXCEPTION 'RT2A_RATE_LOCK_ON: product rates are locked; unlock them with a reason, apply, then lock again. Nothing was changed.';
  END IF;

  -- unit_conversions must be exactly the 14 reviewed rows (read live 2026-11-09).
  CREATE TEMP TABLE rt2a_units (id uuid, unit text, factor_oz numeric, unit_type text, notes text) ON COMMIT DROP;
  INSERT INTO rt2a_units VALUES
    ('3f5c3827-8523-4b42-9913-ad479588ff95', 'Dry oz', 1, 'dry', '1 dry ounce'),
    ('5ed18e4b-c4d9-42fc-b85e-22babd3fc098', 'Ea', 1, 'both', 'Each / unit'),
    ('f9e10e66-5027-464e-bb9e-ed9800875256', 'fl oz', 1, 'liquid', '1 fluid ounce'),
    ('4406cacd-a7fe-42db-8c84-694e61bb937b', 'g', 0.03527396, 'dry', '1 gram = 0.03527396 dry ounces (1000 mg)'),
    ('29d05e43-cb40-461b-a969-88ee299faca8', 'Gal', 128, 'liquid', '1 gallon = 128 fluid ounces'),
    ('53997e31-d152-4ab6-b768-d1aa81b657bf', 'Lb', 16, 'dry', '1 pound = 16 dry ounces'),
    ('fc5d349f-b58c-48f1-991d-fa0161fd3d01', 'LB', 16, 'dry', '1 pound (capitalized alias)'),
    ('ddde7daf-8090-492b-aed9-c0b7f8ecfd34', 'MG', 0.00003527396, 'dry', '1 milligram = 0.00003527396 dry ounces'),
    ('438d5f7b-f015-4319-b2b7-4f9a672cb350', 'oz', 1, 'liquid', '1 fluid ounce (alias for fl oz)'),
    ('b69ddac6-68ed-4f1d-8e09-e63a7fa6635a', 'Oz', 1, 'liquid', '1 fluid ounce (capitalized alias)'),
    ('a31f95a0-df80-4025-977f-f1fb4e5c8d53', 'Pt', 16, 'liquid', '1 pint = 16 fluid ounces'),
    ('35532f45-2fd0-4400-87d8-3509a58377c0', 'qt', 32, 'liquid', '1 quart lowercase (alias for Qt)'),
    ('915f25ff-8876-4a49-a375-940047e38313', 'Qt', 32, 'liquid', '1 quart = 32 fluid ounces'),
    ('722e8d86-8e68-47d8-a940-209fad38c70e', 'Unit', 1, 'both', 'Each / unit (alias for Ea)');
  IF EXISTS (SELECT id, unit, factor_oz, unit_type, notes FROM public.unit_conversions
             EXCEPT SELECT id, unit, factor_oz, unit_type, notes FROM rt2a_units)
     OR EXISTS (SELECT id, unit, factor_oz, unit_type, notes FROM rt2a_units
             EXCEPT SELECT id, unit, factor_oz, unit_type, notes FROM public.unit_conversions) THEN
    RAISE EXCEPTION 'RT2A_UNITS_DRIFT: unit_conversions is not the 14 reviewed rows. Nothing was changed.';
  END IF;

  -- Every listed product must still be exactly as reviewed.
  SELECT string_agg(m.product_name, ', ' ORDER BY m.product_name) INTO v_bad
    FROM rt2a_map m LEFT JOIN public.products p ON p.id = m.id
   WHERE p.id IS NULL
      OR p.product_name IS DISTINCT FROM m.product_name
      OR p.product_form IS DISTINCT FROM m.product_form
      OR (m.kind = 'stock' AND (p.inventory_unit IS DISTINCT FROM m.old_unit OR p.unit_size IS DISTINCT FROM m.old_unit))
      OR (m.kind = 'rate' AND p.rate_unit IS DISTINCT FROM m.old_unit);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'RT2A_ROW_MOVED: these products no longer match the reviewed list, nothing was changed: %', v_bad;
  END IF;

  -- No product or family outside the list may use a losing spelling (it would be left behind for step 2).
  SELECT string_agg(p.product_name, ', ' ORDER BY p.product_name) INTO v_bad
    FROM public.products p
   WHERE (p.inventory_unit IN ('Oz', 'Qt', 'LB') OR p.unit_size IN ('Oz', 'Qt', 'LB')
          OR p.rate_unit IN ('Oz', 'Qt', 'LB') OR p.container_unit IN ('Oz', 'Qt', 'LB')
          OR p.max_label_rate_unit IN ('Oz', 'Qt', 'LB'))
     AND NOT EXISTS (SELECT 1 FROM rt2a_map m WHERE m.id = p.id);
  IF v_bad IS NULL THEN
    SELECT string_agg(pp.name, ', ' ORDER BY pp.name) INTO v_bad
      FROM public.product_parents pp WHERE pp.rate_unit IN ('Oz', 'Qt', 'LB');
  END IF;
  IF v_bad IS NULL THEN
    -- A form-unit entry would keep a losing spelling valid for new products after step 2.
    SELECT string_agg(f.product_form || ' ' || f.unit, ', ' ORDER BY f.product_form, f.unit) INTO v_bad
      FROM public.product_form_units f WHERE f.unit IN ('Oz', 'Qt', 'LB');
  END IF;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'RT2A_UNLISTED_SPELLING: these products, families or form units use Oz, Qt or LB but are not in the reviewed list, nothing was changed: %', v_bad;
  END IF;

  -- A rate-unit move must not split a product's label maximum from its rate (the label check compares unit
  -- names, so a maximum in "LB" against an "Lb" rate would stop being checked). Live 2026-11-09: Imazuron has none.
  SELECT string_agg(m.product_name, ', ' ORDER BY m.product_name) INTO v_bad
    FROM rt2a_map m JOIN public.products p ON p.id = m.id
   WHERE m.kind = 'rate' AND (p.max_label_rate IS NOT NULL OR NULLIF(btrim(p.max_label_rate_unit), '') IS NOT NULL);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'RT2A_LABEL_RATE: these products have a label maximum, nothing was changed: %', v_bad;
  END IF;

  -- No listed product may be in a family (its rate is the family's) or carry a net weight (a stock-unit change
  -- would send it back to draft).
  SELECT string_agg(m.product_name, ', ' ORDER BY m.product_name) INTO v_bad
    FROM rt2a_map m
   WHERE EXISTS (SELECT 1 FROM public.product_parent_members pm WHERE pm.product_id = m.id OR pm.fill_source_product_id = m.id)
      OR EXISTS (SELECT 1 FROM public.product_size_net_weight_values w WHERE w.product_id = m.id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'RT2A_FAMILY_OR_WEIGHT: these listed products are in a product family or have a net weight, nothing was changed: %', v_bad;
  END IF;

  -- The stock rows' inventory snapshots on the old spelling must be the reviewed count.
  SELECT count(*) INTO v_done FROM public.inventory i JOIN rt2a_map m ON m.id = i.product_id
   WHERE m.kind = 'stock' AND i.unit_size = m.old_unit;
  IF v_done <> v_inv_expected THEN
    RAISE EXCEPTION 'RT2A_INVENTORY_DRIFT: % inventory rows of the listed products are on the old spelling, % reviewed. Nothing was changed.', v_done, v_inv_expected;
  END IF;

  -- Before-images: money fields of every product (no unit column, so an approved unit change cannot fail it),
  -- every product's unit columns, and the bodies of the functions that read unit_conversions (14 today).
  CREATE TEMP TABLE rt2a_before ON COMMIT DROP AS
    SELECT id, rate_per_acre, tier1_price, tier2_price, tier3_price,
           tier1_price_per_acre, tier2_price_per_acre, tier3_price_per_acre, current_cost,
           inventory_unit, unit_size, rate_unit, container_unit, max_label_rate_unit
      FROM public.products;
  SELECT string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), ';' ORDER BY p.oid::regprocedure::text)
    INTO v_fn_before
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosrc ILIKE '%unit_conversions%';

  -- The remap. Only the setup guard is switched off, and only for these two statements.
  IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
        AND tgname = 'trg_validate_product_setup_fields') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'RT2A_SETUP_GUARD_STATE: the setup guard is not in its normal on state. Nothing was changed.';
  END IF;
  ALTER TABLE public.products DISABLE TRIGGER trg_validate_product_setup_fields;
  UPDATE public.products p
     SET inventory_unit = m.new_unit, unit_size = m.new_unit, updated_at = now()
    FROM rt2a_map m
   WHERE m.kind = 'stock' AND p.id = m.id AND p.inventory_unit = m.old_unit AND p.unit_size = m.old_unit;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 19 THEN
    RAISE EXCEPTION 'RT2A_UPDATE_COUNT: moved % of 19 stock units', v_done;
  END IF;
  UPDATE public.products p
     SET rate_unit = m.new_unit, updated_at = now()
    FROM rt2a_map m
   WHERE m.kind = 'rate' AND p.id = m.id AND p.rate_unit = m.old_unit;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 1 THEN
    RAISE EXCEPTION 'RT2A_UPDATE_COUNT: moved % of 1 rate unit', v_done;
  END IF;
  ALTER TABLE public.products ENABLE TRIGGER trg_validate_product_setup_fields;
  -- Their inventory snapshots follow (no inventory trigger watches unit_size).
  UPDATE public.inventory i
     SET unit_size = m.new_unit
    FROM rt2a_map m
   WHERE m.kind = 'stock' AND i.product_id = m.id AND i.unit_size = m.old_unit;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> v_inv_expected THEN
    RAISE EXCEPTION 'RT2A_UPDATE_COUNT: moved % of % inventory snapshots', v_done, v_inv_expected;
  END IF;

  -- Postflight.
  IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
        AND tgname = 'trg_validate_product_setup_fields') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'RT2A_POSTFLIGHT: the setup guard is not enabled again';
  END IF;
  IF EXISTS (SELECT 1 FROM public.products
              WHERE inventory_unit IN ('Oz', 'Qt', 'LB') OR unit_size IN ('Oz', 'Qt', 'LB')
                 OR rate_unit IN ('Oz', 'Qt', 'LB') OR container_unit IN ('Oz', 'Qt', 'LB')
                 OR max_label_rate_unit IN ('Oz', 'Qt', 'LB')) THEN
    RAISE EXCEPTION 'RT2A_POSTFLIGHT: a product still uses Oz, Qt or LB';
  END IF;
  IF EXISTS (SELECT 1 FROM public.inventory i JOIN rt2a_map m ON m.id = i.product_id
              WHERE m.kind = 'stock' AND i.unit_size = m.old_unit) THEN
    RAISE EXCEPTION 'RT2A_POSTFLIGHT: an inventory snapshot of a listed product is still on the old spelling';
  END IF;
  -- validate_product_units' rule, for every product: stock and container units match a row of the form exactly.
  SELECT string_agg(p.product_name, ', ' ORDER BY p.product_name) INTO v_bad
    FROM public.products p, LATERAL (VALUES (p.inventory_unit), (p.container_unit)) u(unit)
   WHERE p.product_form IS NOT NULL AND u.unit IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.unit_conversions c WHERE c.unit = u.unit
                       AND (c.unit_type = p.product_form OR c.unit_type = 'both') AND p.product_form NOT IN ('seed', 'each'))
     AND NOT EXISTS (SELECT 1 FROM public.product_form_units f WHERE f.product_form = p.product_form AND f.unit = u.unit);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'RT2A_POSTFLIGHT: these products fail the unit check: %', v_bad;
  END IF;
  -- No money field moved on any product.
  IF EXISTS (SELECT b.id FROM rt2a_before b JOIN public.products p ON p.id = b.id
              WHERE (b.rate_per_acre, b.tier1_price, b.tier2_price, b.tier3_price, b.tier1_price_per_acre,
                     b.tier2_price_per_acre, b.tier3_price_per_acre, b.current_cost)
                    IS DISTINCT FROM
                    (p.rate_per_acre, p.tier1_price, p.tier2_price, p.tier3_price, p.tier1_price_per_acre,
                     p.tier2_price_per_acre, p.tier3_price_per_acre, p.current_cost))
     OR (SELECT count(*) FROM public.products) <> (SELECT count(*) FROM rt2a_before) THEN
    RAISE EXCEPTION 'RT2A_POSTFLIGHT: a product price or rate changed';
  END IF;
  -- Unit columns: exactly the listed changes, nothing else.
  SELECT string_agg(p.product_name, ', ' ORDER BY p.product_name) INTO v_bad
    FROM rt2a_before b JOIN public.products p ON p.id = b.id LEFT JOIN rt2a_map m ON m.id = b.id
   WHERE (p.inventory_unit, p.unit_size, p.rate_unit, p.container_unit, p.max_label_rate_unit) IS DISTINCT FROM (
           CASE WHEN m.kind = 'stock' THEN m.new_unit ELSE b.inventory_unit END,
           CASE WHEN m.kind = 'stock' THEN m.new_unit ELSE b.unit_size END,
           CASE WHEN m.kind = 'rate' THEN m.new_unit ELSE b.rate_unit END,
           b.container_unit, b.max_label_rate_unit);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'RT2A_POSTFLIGHT: unexpected unit change on: %', v_bad;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), ';' ORDER BY p.oid::regprocedure::text)
    INTO v_fn_after
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosrc ILIKE '%unit_conversions%';
  IF v_fn_after IS DISTINCT FROM v_fn_before THEN
    RAISE EXCEPTION 'RT2A_POSTFLIGHT: a function that reads unit_conversions changed';
  END IF;
  IF EXISTS (SELECT id, unit, factor_oz, unit_type, notes FROM public.unit_conversions
             EXCEPT SELECT id, unit, factor_oz, unit_type, notes FROM rt2a_units)
     OR (SELECT count(*) FROM public.unit_conversions) <> 14 THEN
    RAISE EXCEPTION 'RT2A_POSTFLIGHT: unit_conversions changed';
  END IF;
END;
$rt2a$;
