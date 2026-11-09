-- RT-2 step 1 RECOVERY (not a migration): put the 22 products moved by
-- supabase/migrations/20261227100000_unit_spellings_remap.sql back to their old spellings.
-- Proven by scripts/smoke/prove-unit-spellings-real-schema.mjs. To use it live, copy it into a new
-- migration and take it through the normal gates. Refuses (and changes nothing) unless every listed product
-- still holds its new spelling, the rate lock is off, no step-2 change has removed the old spellings, and no
-- listed product is in a family or has a net weight.
DO $rt2a_reverse$
DECLARE
  v_bad text;
  v_done integer;
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);
  LOCK TABLE public.products, public.product_parents, public.product_parent_members,
             public.product_size_net_weight_values, public.product_form_units IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.unit_conversions IN SHARE MODE;
  CREATE TEMP TABLE rt2a_rev (id uuid PRIMARY KEY, product_name text NOT NULL, kind text NOT NULL,
    old_unit text NOT NULL, new_unit text NOT NULL) ON COMMIT DROP;
  INSERT INTO rt2a_rev (id, product_name, kind, old_unit, new_unit) VALUES
    ('2317db27-438a-4821-8946-d24a3313bd56'::uuid, 'Armezon - 32 oz', 'stock', 'Oz', 'oz'),
    ('7d172b07-2974-4474-a5d5-7b36521fa6d0'::uuid, 'Drive XLR8 - 64 oz', 'stock', 'Oz', 'oz'),
    ('76cc1352-4de1-4d81-abaf-b712c8cf96d7'::uuid, 'Endura - 104 oz', 'stock', 'Oz', 'oz'),
    ('b5d42717-1626-4962-bd74-f69e671cc615'::uuid, 'Evito - 128 oz', 'stock', 'Oz', 'oz'),
    ('98602d58-b6a2-4666-abe1-fd124e427e09'::uuid, 'Impact - 128 oz', 'stock', 'Oz', 'oz'),
    ('43b22e56-3c51-4d4e-a5e4-0dea1f68c8f8'::uuid, 'Nurizma - 64 Oz', 'stock', 'Oz', 'oz'),
    ('2078bc12-86b9-4b83-aa8f-6eeae1997bf2'::uuid, 'Panoflex - 20 oz', 'stock', 'Oz', 'oz'),
    ('02a8036b-ff8d-4eca-a71c-7db0081bf16a'::uuid, 'Sefina - 140 oz', 'stock', 'Oz', 'oz'),
    ('3a81a72a-4a9c-4a7f-ad51-84587f8d7d8b'::uuid, 'Status - 125 oz', 'stock', 'Oz', 'oz'),
    ('567986e5-a8f4-4124-8750-64fd63ba94bd'::uuid, 'Steadfast Q - 60 oz', 'stock', 'Oz', 'oz'),
    ('eaf74d51-1714-49e7-9c50-7129e07c3a4f'::uuid, 'Trivence - 200 Oz', 'stock', 'Oz', 'oz'),
    ('a9de3015-425a-4e43-a669-2be592cf7935'::uuid, 'AIM 2EC - 1 Qt', 'stock', 'Qt', 'qt'),
    ('322ca15d-1273-4cbf-8ea2-76125df2c2a0'::uuid, 'Cadet - 1 Qt', 'stock', 'Qt', 'qt'),
    ('05b9f5d8-3305-4234-afaa-e7a63c3b46f9'::uuid, 'Effect-GC - 1 Qt', 'stock', 'Qt', 'qt'),
    ('e87cdf63-6e9b-4d3b-884d-6410fcca4723'::uuid, 'Elevore - 1 Qt', 'stock', 'Qt', 'qt'),
    ('3e0c3fc3-aff4-4fdc-ba7b-353b2093d44d'::uuid, 'Make Foam - 1 Qt', 'stock', 'Qt', 'qt'),
    ('30bd948b-f0c0-4d02-8cd5-89b729395262'::uuid, 'Milestone - 1 Qt', 'stock', 'Qt', 'qt'),
    ('e453fc17-c8b9-4e6c-89c1-7468b7875184'::uuid, 'Prevent Foam - 1  Qt', 'stock', 'Qt', 'qt'),
    ('28087f6b-e3f4-4caa-8d0f-3c25ea2cf8e5'::uuid, 'Tordon RTU - 1 Qt', 'stock', 'Qt', 'qt'),
    ('0294faa8-ab0b-488e-9efe-868071738625'::uuid, 'Imazuron Herbicide', 'rate', 'LB', 'Lb'),
    ('61ac0e28-bdbe-4197-a764-93aa33bf036a'::uuid, 'Autumn Super 51 WDG', 'rate', 'oz', 'Dry oz'),
    ('1ec38578-6eaa-4cff-acd5-0ee0ec8dceda'::uuid, 'Cimarron Plus - 10 oz', 'rate', 'oz', 'Dry oz');
  IF NOT EXISTS (SELECT 1 FROM public.product_rate_lock WHERE is_locked = false FOR SHARE) THEN
    RAISE EXCEPTION 'RT2A_REVERSE_RATE_LOCK_ON: unlock product rates first. Nothing was changed.';
  END IF;
  IF (SELECT count(*) FROM public.unit_conversions WHERE unit IN ('Oz', 'Qt', 'LB')) <> 3 THEN
    RAISE EXCEPTION 'RT2A_REVERSE_ALIASES_GONE: Oz, Qt or LB is no longer a unit; recover step 2 first. Nothing was changed.';
  END IF;
  SELECT string_agg(r.product_name, ', ' ORDER BY r.product_name) INTO v_bad
    FROM rt2a_rev r LEFT JOIN public.products p ON p.id = r.id
   WHERE p.id IS NULL
      OR (r.kind = 'stock' AND (p.inventory_unit IS DISTINCT FROM r.new_unit OR p.unit_size IS DISTINCT FROM r.new_unit))
      OR (r.kind = 'rate' AND p.rate_unit IS DISTINCT FROM r.new_unit)
      OR EXISTS (SELECT 1 FROM public.product_parent_members pm WHERE pm.product_id = r.id OR pm.fill_source_product_id = r.id)
      OR EXISTS (SELECT 1 FROM public.product_size_net_weight_values w WHERE w.product_id = r.id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'RT2A_REVERSE_ROW_MOVED: nothing was changed: %', v_bad;
  END IF;
  CREATE TEMP TABLE rt2a_rev_before ON COMMIT DROP AS
    SELECT id, rate_per_acre, tier1_price, tier2_price, tier3_price,
           tier1_price_per_acre, tier2_price_per_acre, tier3_price_per_acre, current_cost,
           inventory_unit, unit_size, rate_unit, container_unit, max_label_rate_unit
      FROM public.products;
  ALTER TABLE public.products DISABLE TRIGGER trg_validate_product_setup_fields;
  UPDATE public.products p SET inventory_unit = r.old_unit, unit_size = r.old_unit, updated_at = now()
    FROM rt2a_rev r WHERE r.kind = 'stock' AND p.id = r.id;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 19 THEN RAISE EXCEPTION 'RT2A_REVERSE_COUNT: % of 19 stock units', v_done; END IF;
  -- Putting the two dry products back on plain oz (a liquid unit) is a rate-unit change the rate guard
  -- refuses, although live held exactly that before step 1. The guard only refuses (the lock was checked
  -- above), so it is off for this one restore and on again before the block ends.
  ALTER TABLE public.products DISABLE TRIGGER trigger_zzz_guard_product_rate_lock;
  UPDATE public.products p SET rate_unit = r.old_unit, updated_at = now()
    FROM rt2a_rev r WHERE r.kind = 'rate' AND p.id = r.id;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> 3 THEN RAISE EXCEPTION 'RT2A_REVERSE_COUNT: % of 3 rate units', v_done; END IF;
  ALTER TABLE public.products ENABLE TRIGGER trigger_zzz_guard_product_rate_lock;
  ALTER TABLE public.products ENABLE TRIGGER trg_validate_product_setup_fields;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
              AND tgname IN ('trg_validate_product_setup_fields', 'trigger_zzz_guard_product_rate_lock')
              AND tgenabled <> 'O') THEN
    RAISE EXCEPTION 'RT2A_REVERSE_POSTFLIGHT: a product guard was left off';
  END IF;
  -- No money field moved, and only the listed unit columns changed, exactly back to the old spelling.
  SELECT string_agg(b.id::text, ', ') INTO v_bad
    FROM rt2a_rev_before b LEFT JOIN public.products p ON p.id = b.id LEFT JOIN rt2a_rev r ON r.id = b.id
   WHERE p.id IS NULL
      OR (b.rate_per_acre, b.tier1_price, b.tier2_price, b.tier3_price, b.tier1_price_per_acre,
          b.tier2_price_per_acre, b.tier3_price_per_acre, b.current_cost)
         IS DISTINCT FROM
         (p.rate_per_acre, p.tier1_price, p.tier2_price, p.tier3_price, p.tier1_price_per_acre,
          p.tier2_price_per_acre, p.tier3_price_per_acre, p.current_cost)
      OR (p.inventory_unit, p.unit_size, p.rate_unit, p.container_unit, p.max_label_rate_unit) IS DISTINCT FROM (
           CASE WHEN r.kind = 'stock' THEN r.old_unit ELSE b.inventory_unit END,
           CASE WHEN r.kind = 'stock' THEN r.old_unit ELSE b.unit_size END,
           CASE WHEN r.kind = 'rate' THEN r.old_unit ELSE b.rate_unit END,
           b.container_unit, b.max_label_rate_unit);
  IF v_bad IS NOT NULL OR (SELECT count(*) FROM public.products) <> (SELECT count(*) FROM rt2a_rev_before) THEN
    RAISE EXCEPTION 'RT2A_REVERSE_POSTFLIGHT: an unexpected product change: %', v_bad;
  END IF;
END;
$rt2a_reverse$;
