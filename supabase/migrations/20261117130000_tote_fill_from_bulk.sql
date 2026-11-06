-- idempotency-body-check: exempt
-- (fill_tote_from_bulk and reverse_tote_fill check their retry key through _product_parent_replay, which
--  calls check_idempotency and compares the saved actor and request fingerprint, and save their receipt
--  with save_idempotency last, in the same transaction.)
--
-- BLK-1a (Stage 2 build sheet §6.1): fill a fertilizer tote from Bulk stock, quantities only.
--
-- One recorded, repeat-safe step takes a tote's volume out of the Bulk row's stock and adds the totes to
-- the tote row's stock, warning (and flagging the Bulk ledger row for review) when Bulk is short. No
-- purchase cost is recorded (BLK-1b is parked with inventory costing, D12). Only a fertilizer parent's
-- fixed tote whose fill source is that parent's bulk size can be filled (PAR-1's
-- product_parent_members.fill_source_product_id, set by PAR-2), so nothing can be filled until PAR-2's
-- data step sets a source.
--
-- New:
--   * inventory_transactions.transaction_type adds tote_fill_out (the Bulk row; negative on a fill,
--     positive on its undo) and tote_fill_in (the tote row; positive on a fill, negative on its undo).
--     Both are stored signed. Existing values unchanged (superset, checked against the live list).
--   * tote_fills (RLS on, SELECT for active users, no write grant; append-only): one row per fill and
--     one per undo. Quantities are in each row's own stock unit: bulk_quantity, bulk_before/after and
--     shortfall_quantity are in bulk_unit (quarts when Bulk is stocked in quarts); gallons is the totes'
--     volume. An undo row names the fill it reverses (reverses_fill_id, unique, so a fill is undone at
--     most once); "reversed by" is that row, read through the unique key.
--   * preview_tote_fill(tote, totes): admin, read-only. Bulk source, units, both rows' stock before and
--     after, the converted amount, the shortfall, both rows' catalog costs in cents and a catalog
--     estimate of value before and after (cents, rounded once), with cost_check 'equal', 'differ' or
--     'missing' (per-gallon catalog costs). It never writes a cost.
--   * fill_tote_from_bulk(tote, totes, expected, key): admin, retry key. Under lock it recomputes the
--     preview and refuses TOTE_FILL_PREVIEW_CHANGED unless it equals `expected` exactly, so an admin
--     never confirms a shortfall, a no-shortfall fill or an estimate they were not shown.
--   * reverse_tote_fill(fill, reason, key): admin, retry key. Allowed only when neither product's stock
--     has moved since the fill (no other ledger row on either product since, and both stock counts still
--     equal the fill's after-values) and the fill is not already undone; otherwise "adjust stock
--     instead" (the reviewed adjust_inventory).
-- Rules checked under lock on every fill (named refusals): the tote is a fixed_tote member whose fill
-- source is its parent's current bulk member; the parent's category is Liquid Fertilizer, Foliar
-- Fertilizer or Dry Water Soluble Fertilizer; parent, tote and Bulk are active; the tote is stocked in a
-- count unit (Ea or Unit, never a volume or weight) and its container size converts to gallons; the
-- Bulk row is stocked in a volume. Volumes convert through unit_conversions (liquid factors), so one
-- 265 Gal tote takes 1,060 from Bulk stocked in quarts. Bulk may go below zero.
-- Lock order: the parent row (FOR SHARE, as PAR-1's writers lock parents first), the two member rows,
-- the two products rows (FOR SHARE, so a deactivation, unit or cost edit cannot commit mid-fill), then
-- the two Main Warehouse inventory rows in product-ID order (each created at zero first if missing,
-- ON CONFLICT on inventory's (product_id, location) key). unit_conversions is locked in SHARE mode
-- (after the products rows) so no factor changes mid-fill. A cycle count locking both rows by inventory id may deadlock with a fill; Postgres
-- aborts one, nothing is saved, and the same key retries cleanly.
-- Bulk amounts are rounded to 4 decimal places, so a preview survives a round trip through the browser.
-- No existing row is changed; no grant, revoke or policy on an existing table. The only change to an
-- existing object is the CHECK superset.
--
-- Rollback (forward migration):
--   DROP FUNCTION public.fill_tote_from_bulk(uuid, integer, jsonb, text), public.reverse_tote_fill(uuid, text, text),
--     public.preview_tote_fill(uuid, integer), public._tote_fill_preview(uuid, integer), public._tote_fill_liquid_oz(text);
--   Keep tote_fills and the CHECK superset while any tote_fill_* ledger row exists (the ledger is append-only).
--   With none: DROP TABLE public.tote_fills; DROP FUNCTION public.refuse_tote_fill_mutation();
--   and re-add the twelve-value CHECK pinned in the preflight below.

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF to_regclass('public.tote_fills') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_TOTE_FILLS_ALREADY_EXIST';
  END IF;
  IF to_regclass('public.product_parents') IS NULL
     OR to_regclass('public.product_parent_members') IS NULL
     OR to_regprocedure('public._product_parent_replay(text,text,text)') IS NULL
     OR to_regprocedure('public._product_parent_require_admin()') IS NULL
     OR to_regprocedure('public._product_parent_reason(text,text,boolean)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regprocedure('public.is_active_profile()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_TOTE_FILL_DEPENDENCY_MISSING: PAR-1 (20261108120000) must be applied first';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conname = 'inventory_transactions_transaction_type_check'
         AND conrelid = 'public.inventory_transactions'::regclass)
     IS DISTINCT FROM 'CHECK ((transaction_type = ANY (ARRAY[''received''::text, ''booked''::text, ''delivered''::text, ''returned''::text, ''adjusted''::text, ''transferred''::text, ''job_applied''::text, ''cancelled_delivery_reversal''::text, ''void_delivery_reversal''::text, ''prebooked''::text, ''released''::text, ''prebook_reconciliation''::text])))' THEN
    RAISE EXCEPTION 'PREFLIGHT_TRANSACTION_TYPE_CHECK_CHANGED: re-base the superset on the live list';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.inventory'::regclass AND contype = 'u'
                    AND pg_get_constraintdef(oid) = 'UNIQUE (product_id, location)') THEN
    RAISE EXCEPTION 'PREFLIGHT_INVENTORY_PRODUCT_LOCATION_KEY_MISSING';
  END IF;
  -- The tote count-unit allow-list must name real units.
  IF (SELECT count(*) FROM public.unit_conversions WHERE unit IN ('Ea', 'Unit')) <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT_COUNT_UNITS_MISSING: Ea and Unit must be in unit_conversions';
  END IF;
  -- The fertilizer categories this file names must exist.
  IF (SELECT count(*) FROM public.product_categories
       WHERE name IN ('Liquid Fertilizer', 'Foliar Fertilizer', 'Dry Water Soluble Fertilizer')) <> 3 THEN
    RAISE EXCEPTION 'PREFLIGHT_FERTILIZER_CATEGORIES_MISSING';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- Ledger types (superset)
-- ---------------------------------------------------------------------------------------------

ALTER TABLE public.inventory_transactions DROP CONSTRAINT inventory_transactions_transaction_type_check;
ALTER TABLE public.inventory_transactions ADD CONSTRAINT inventory_transactions_transaction_type_check
  CHECK (transaction_type IN ('received', 'booked', 'delivered', 'returned', 'adjusted', 'transferred', 'job_applied',
    'cancelled_delivery_reversal', 'void_delivery_reversal', 'prebooked', 'released', 'prebook_reconciliation',
    'tote_fill_out', 'tote_fill_in'));

-- ---------------------------------------------------------------------------------------------
-- tote_fills
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.tote_fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tote_product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  bulk_product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  totes integer NOT NULL CHECK (totes >= 1),
  gallons numeric NOT NULL CHECK (gallons > 0),
  bulk_unit text NOT NULL,
  bulk_quantity numeric NOT NULL CHECK (bulk_quantity > 0),
  bulk_before numeric NOT NULL,
  bulk_after numeric NOT NULL,
  tote_before numeric NOT NULL,
  tote_after numeric NOT NULL,
  shortfall_quantity numeric NOT NULL DEFAULT 0 CHECK (shortfall_quantity >= 0),
  -- Ledger rows on each product once this row's own pair was written (under the stock locks). The
  -- ledger is append-only, so a higher count later means stock moved, whatever its timestamps.
  bulk_ledger_rows bigint NOT NULL,
  tote_ledger_rows bigint NOT NULL,
  out_transaction_id uuid NOT NULL UNIQUE REFERENCES public.inventory_transactions(id) ON DELETE RESTRICT,
  in_transaction_id uuid NOT NULL UNIQUE REFERENCES public.inventory_transactions(id) ON DELETE RESTRICT,
  reverses_fill_id uuid UNIQUE REFERENCES public.tote_fills(id) ON DELETE RESTRICT,
  reason text,
  performed_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (tote_product_id <> bulk_product_id),
  CHECK ((reverses_fill_id IS NULL) = (reason IS NULL)),
  CHECK (reverses_fill_id IS NULL OR shortfall_quantity = 0)
);
ALTER TABLE public.tote_fills OWNER TO postgres;
CREATE INDEX tote_fills_tote_idx ON public.tote_fills (tote_product_id, created_at DESC);
CREATE INDEX tote_fills_bulk_idx ON public.tote_fills (bulk_product_id, created_at DESC);
COMMENT ON TABLE public.tote_fills IS
  'BLK-1a: one row per tote fill from bulk and one per undo (reverses_fill_id). Quantities in each row''s stock unit. Written only by fill_tote_from_bulk and reverse_tote_fill.';

ALTER TABLE public.tote_fills ENABLE ROW LEVEL SECURITY;
CREATE POLICY tote_fills_select ON public.tote_fills
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
REVOKE ALL ON TABLE public.tote_fills FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.tote_fills TO authenticated;

CREATE FUNCTION public.refuse_tote_fill_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'TOTE_FILLS_ARE_APPEND_ONLY';
END;
$function$;
ALTER FUNCTION public.refuse_tote_fill_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_tote_fill_mutation() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER tote_fills_append_only
  BEFORE UPDATE OR DELETE ON public.tote_fills
  FOR EACH ROW EXECUTE FUNCTION public.refuse_tote_fill_mutation();
CREATE TRIGGER tote_fills_no_truncate
  BEFORE TRUNCATE ON public.tote_fills
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_tote_fill_mutation();

-- ---------------------------------------------------------------------------------------------
-- Private helpers (no grants)
-- ---------------------------------------------------------------------------------------------

-- Fluid ounces in one p_unit, from unit_conversions' liquid rows (case ignored); NULL when the unit is
-- not a volume, or when two spellings disagree.
CREATE FUNCTION public._tote_fill_liquid_oz(p_unit text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT CASE WHEN count(DISTINCT u.factor_oz) = 1 THEN min(u.factor_oz) END
    FROM public.unit_conversions u
   WHERE lower(u.unit) = lower(btrim(p_unit)) AND u.unit_type = 'liquid' AND u.factor_oz > 0
     AND u.factor_oz < 'Infinity'::numeric;
$function$;
ALTER FUNCTION public._tote_fill_liquid_oz(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._tote_fill_liquid_oz(text) FROM PUBLIC, anon, authenticated, service_role;

-- The fill as it would be recorded now; raises a named refusal for anything that may not be filled.
-- The fill compares this, under its locks, with what the admin was shown.
CREATE FUNCTION public._tote_fill_preview(p_tote_product_id uuid, p_totes integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_member public.product_parent_members%ROWTYPE;
  v_parent public.product_parents%ROWTYPE;
  v_tote public.products%ROWTYPE;
  v_bulk public.products%ROWTYPE;
  v_size_oz numeric;
  v_bulk_oz numeric;
  v_gallons numeric;
  v_bulk_qty numeric;
  v_bulk_before numeric;
  v_tote_before numeric;
  v_shortfall numeric;
  v_cost_check text;
  v_before_cents bigint;
  v_after_cents bigint;
BEGIN
  IF p_totes IS NULL OR p_totes < 1 THEN
    RAISE EXCEPTION 'TOTE_FILL_TOTES_INVALID: fill one or more whole totes';
  END IF;
  SELECT * INTO v_member FROM public.product_parent_members WHERE product_id = p_tote_product_id;
  IF NOT FOUND OR v_member.size_role <> 'fixed_tote' THEN
    RAISE EXCEPTION 'TOTE_FILL_NOT_A_TOTE: only a parent''s fixed tote size can be filled from bulk';
  END IF;
  SELECT * INTO v_parent FROM public.product_parents WHERE id = v_member.parent_id;
  IF v_member.fill_source_product_id IS NULL THEN
    RAISE EXCEPTION 'TOTE_FILL_NO_SOURCE: "%" has no bulk fill source; set one when grouping the product', v_parent.name;
  END IF;
  -- Rechecked here, not trusted from when the source was set.
  IF NOT EXISTS (SELECT 1 FROM public.product_parent_members b
                  WHERE b.product_id = v_member.fill_source_product_id AND b.parent_id = v_member.parent_id
                    AND b.size_role = 'bulk') THEN
    RAISE EXCEPTION 'TOTE_FILL_SOURCE_INVALID: the tote''s fill source is not "%"''s bulk size; fix the fill source first', v_parent.name;
  END IF;
  -- Shop-filled totes are fertilizer only (DECISION_LOG 2026-11-04); a parent's category can change.
  IF v_parent.category IS NULL
     OR v_parent.category NOT IN ('Liquid Fertilizer', 'Foliar Fertilizer', 'Dry Water Soluble Fertilizer') THEN
    RAISE EXCEPTION 'TOTE_FILL_NOT_FERTILIZER: "%" is %; only fertilizer totes are filled from bulk',
      v_parent.name, COALESCE(v_parent.category, 'uncategorized');
  END IF;
  SELECT * INTO v_tote FROM public.products WHERE id = p_tote_product_id;
  SELECT * INTO v_bulk FROM public.products WHERE id = v_member.fill_source_product_id;
  IF NOT v_parent.is_active OR NOT COALESCE(v_tote.is_active, false) OR NOT COALESCE(v_bulk.is_active, false) THEN
    RAISE EXCEPTION 'TOTE_FILL_INACTIVE: "%", its tote or its bulk size is inactive', v_parent.name;
  END IF;
  -- Units are checked, never assumed.
  IF lower(btrim(COALESCE(v_tote.inventory_unit, ''))) NOT IN ('ea', 'unit') THEN
    RAISE EXCEPTION 'TOTE_FILL_TOTE_UNIT: "%" is stocked in %; a tote must be stocked as Ea or Unit (correct its stock unit first)',
      v_tote.product_name, COALESCE(v_tote.inventory_unit, 'no unit');
  END IF;
  v_size_oz := public._tote_fill_liquid_oz(v_tote.container_unit);
  IF v_size_oz IS NULL OR v_tote.container_size IS NULL OR v_tote.container_size <= 0
     OR NOT (v_tote.container_size < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'TOTE_FILL_TOTE_SIZE: "%"''s container size (% %) is not a volume',
      v_tote.product_name, COALESCE(v_tote.container_size::text, 'none'), COALESCE(v_tote.container_unit, '');
  END IF;
  v_bulk_oz := public._tote_fill_liquid_oz(v_bulk.inventory_unit);
  IF v_bulk_oz IS NULL THEN
    RAISE EXCEPTION 'TOTE_FILL_BULK_UNIT: "%" is stocked in %, not a volume',
      v_bulk.product_name, COALESCE(v_bulk.inventory_unit, 'no unit');
  END IF;

  v_gallons := trim_scale(round(p_totes * v_tote.container_size * v_size_oz / 128, 4));
  v_bulk_qty := trim_scale(round(p_totes * v_tote.container_size * v_size_oz / v_bulk_oz, 4));
  IF v_gallons <= 0 OR v_bulk_qty <= 0 THEN
    RAISE EXCEPTION 'TOTE_FILL_TOTE_SIZE: "%"''s container size (% %) is too small to fill',
      v_tote.product_name, v_tote.container_size, v_tote.container_unit;
  END IF;
  v_bulk_before := COALESCE((SELECT quantity_available FROM public.inventory
                              WHERE product_id = v_bulk.id AND location = 'Main Warehouse'), 0);
  v_tote_before := COALESCE((SELECT quantity_available FROM public.inventory
                              WHERE product_id = v_tote.id AND location = 'Main Warehouse'), 0);
  v_shortfall := LEAST(v_bulk_qty, GREATEST(0, v_bulk_qty - v_bulk_before));

  -- Catalog estimate: each row's quantity x its catalog cost (dollars per stock unit), in cents,
  -- rounded once. Per-gallon costs compare exactly: bulk cost x 128 x tote gallons = tote cost x bulk oz.
  IF v_bulk.current_cost IS NULL OR v_tote.current_cost IS NULL THEN
    v_cost_check := 'missing';
  ELSE
    v_cost_check := CASE WHEN v_bulk.current_cost * v_tote.container_size * v_size_oz = v_tote.current_cost * v_bulk_oz
                         THEN 'equal' ELSE 'differ' END;
    v_before_cents := round((v_bulk_before * v_bulk.current_cost + v_tote_before * v_tote.current_cost) * 100);
    v_after_cents := round(((v_bulk_before - v_bulk_qty) * v_bulk.current_cost
                            + (v_tote_before + p_totes) * v_tote.current_cost) * 100);
  END IF;

  RETURN jsonb_build_object(
    'tote_product_id', v_tote.id, 'bulk_product_id', v_bulk.id, 'parent_id', v_parent.id,
    'totes', p_totes, 'tote_unit', v_tote.inventory_unit,
    'tote_size', trim_scale(v_tote.container_size), 'tote_size_unit', v_tote.container_unit,
    'gallons', v_gallons,
    'bulk_unit', v_bulk.inventory_unit, 'bulk_quantity', v_bulk_qty,
    'bulk_before', trim_scale(v_bulk_before), 'bulk_after', trim_scale(v_bulk_before - v_bulk_qty),
    'tote_before', trim_scale(v_tote_before), 'tote_after', trim_scale(v_tote_before + p_totes),
    'shortfall', trim_scale(v_shortfall),
    'bulk_cost_cents', round(v_bulk.current_cost * 100)::bigint,
    'tote_cost_cents', round(v_tote.current_cost * 100)::bigint,
    'estimate_before_cents', v_before_cents, 'estimate_after_cents', v_after_cents,
    'cost_check', v_cost_check);
END;
$function$;
ALTER FUNCTION public._tote_fill_preview(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._tote_fill_preview(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Public functions
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.preview_tote_fill(p_tote_product_id uuid, p_totes integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM public._product_parent_require_admin();
  RETURN public._tote_fill_preview(p_tote_product_id, p_totes);
END;
$function$;
ALTER FUNCTION public.preview_tote_fill(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_tote_fill(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_tote_fill(uuid, integer) TO authenticated;

CREATE FUNCTION public.fill_tote_from_bulk(p_tote_product_id uuid, p_totes integer, p_expected jsonb,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'tote_product_id', p_tote_product_id,
    'totes', p_totes, 'expected', p_expected)::text);
  v_existing jsonb;
  v_member public.product_parent_members%ROWTYPE;
  v_parent_id uuid;
  v_bulk uuid;
  v_now jsonb;
  v_qty numeric;
  v_short numeric;
  v_out uuid;
  v_in uuid;
  v_fill uuid;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'fill_tote_from_bulk', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object' THEN
    RAISE EXCEPTION 'TOTE_FILL_PREVIEW_REQUIRED: send the preview you confirmed';
  END IF;
  IF p_totes IS NULL OR p_totes < 1 THEN
    RAISE EXCEPTION 'TOTE_FILL_TOTES_INVALID: fill one or more whole totes';
  END IF;

  -- Parent first (PAR-1's writers lock parents first), then the member rows, then stock.
  SELECT parent_id INTO v_parent_id FROM public.product_parent_members WHERE product_id = p_tote_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOTE_FILL_NOT_A_TOTE: only a parent''s fixed tote size can be filled from bulk';
  END IF;
  PERFORM 1 FROM public.product_parents WHERE id = v_parent_id FOR SHARE;
  SELECT * INTO v_member FROM public.product_parent_members WHERE product_id = p_tote_product_id FOR SHARE;
  IF v_member.parent_id IS DISTINCT FROM v_parent_id THEN
    RAISE EXCEPTION 'TOTE_FILL_PREVIEW_CHANGED: the tote moved to another parent; preview again';
  END IF;
  v_bulk := v_member.fill_source_product_id;
  IF v_bulk IS NOT NULL THEN
    PERFORM 1 FROM public.product_parent_members WHERE product_id = v_bulk FOR SHARE;
    PERFORM 1 FROM public.products WHERE id IN (p_tote_product_id, v_bulk) ORDER BY id FOR SHARE;
    -- Conversion factors may not change between the preview check below and the stock write.
    LOCK TABLE public.unit_conversions IN SHARE MODE;
    INSERT INTO public.inventory (product_id, location, quantity_available)
      SELECT x, 'Main Warehouse', 0 FROM unnest(ARRAY[p_tote_product_id, v_bulk]) x ORDER BY x
      ON CONFLICT (product_id, location) DO NOTHING;
    PERFORM 1 FROM public.inventory WHERE product_id IN (p_tote_product_id, v_bulk) AND location = 'Main Warehouse'
      ORDER BY product_id FOR UPDATE;
  END IF;

  v_now := public._tote_fill_preview(p_tote_product_id, p_totes);
  IF v_now IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'TOTE_FILL_PREVIEW_CHANGED: stock, units, source or catalog cost changed since the preview; preview again'
      USING DETAIL = v_now::text;
  END IF;
  v_qty := (v_now->>'bulk_quantity')::numeric;
  v_short := (v_now->>'shortfall')::numeric;

  UPDATE public.inventory SET quantity_available = quantity_available - v_qty, updated_at = now()
   WHERE product_id = v_bulk AND location = 'Main Warehouse';
  UPDATE public.inventory SET quantity_available = quantity_available + p_totes, updated_at = now()
   WHERE product_id = p_tote_product_id AND location = 'Main Warehouse';
  INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, from_location, performed_by, notes, requires_review)
  VALUES (v_bulk, 'tote_fill_out', -v_qty, 'Main Warehouse', v_actor,
          format('Tote fill: %s %s into %s tote(s)', v_qty, v_now->>'bulk_unit', p_totes)
            || CASE WHEN v_short > 0 THEN format(' [SHORT STOCK %s %s - review at next count]', v_short, v_now->>'bulk_unit') ELSE '' END,
          v_short > 0)
  RETURNING id INTO v_out;
  INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, to_location, performed_by, notes)
  VALUES (p_tote_product_id, 'tote_fill_in', p_totes, 'Main Warehouse', v_actor,
          format('Tote fill: %s tote(s) from %s %s of bulk', p_totes, v_qty, v_now->>'bulk_unit'))
  RETURNING id INTO v_in;
  INSERT INTO public.tote_fills (tote_product_id, bulk_product_id, totes, gallons, bulk_unit, bulk_quantity,
    bulk_before, bulk_after, tote_before, tote_after, shortfall_quantity, bulk_ledger_rows, tote_ledger_rows,
    out_transaction_id, in_transaction_id, performed_by)
  VALUES (p_tote_product_id, v_bulk, p_totes, (v_now->>'gallons')::numeric, v_now->>'bulk_unit', v_qty,
    (v_now->>'bulk_before')::numeric, (v_now->>'bulk_after')::numeric,
    (v_now->>'tote_before')::numeric, (v_now->>'tote_after')::numeric, v_short,
    (SELECT count(*) FROM public.inventory_transactions WHERE product_id = v_bulk),
    (SELECT count(*) FROM public.inventory_transactions WHERE product_id = p_tote_product_id),
    v_out, v_in, v_actor)
  RETURNING id INTO v_fill;

  v_receipt := jsonb_build_object('fill_id', v_fill, 'out_transaction_id', v_out, 'in_transaction_id', v_in,
    'bulk_unit', v_now->'bulk_unit', 'bulk_quantity', v_now->'bulk_quantity', 'bulk_after', v_now->'bulk_after',
    'tote_after', v_now->'tote_after', 'shortfall', v_now->'shortfall', 'requires_review', v_short > 0);
  PERFORM public.save_idempotency(p_idempotency_key, 'fill_tote_from_bulk',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.fill_tote_from_bulk(uuid, integer, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fill_tote_from_bulk(uuid, integer, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fill_tote_from_bulk(uuid, integer, jsonb, text) TO authenticated;

CREATE FUNCTION public.reverse_tote_fill(p_fill_id uuid, p_reason text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'fill_id', p_fill_id, 'reason', btrim(p_reason))::text);
  v_existing jsonb;
  v_reason text;
  v_fill public.tote_fills%ROWTYPE;
  v_bulk_now numeric;
  v_tote_now numeric;
  v_out uuid;
  v_in uuid;
  v_undo uuid;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'reverse_tote_fill', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', true);
  SELECT * INTO v_fill FROM public.tote_fills WHERE id = p_fill_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TOTE_FILL_NOT_FOUND'; END IF;
  IF v_fill.reverses_fill_id IS NOT NULL THEN
    RAISE EXCEPTION 'TOTE_FILL_IS_AN_UNDO: an undo cannot be undone; adjust stock instead';
  END IF;

  -- The same lock order as a fill; every stock writer waits here, so the checks below see the latest stock.
  PERFORM 1 FROM public.inventory WHERE product_id IN (v_fill.tote_product_id, v_fill.bulk_product_id)
     AND location = 'Main Warehouse' ORDER BY product_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.tote_fills WHERE reverses_fill_id = p_fill_id) THEN
    RAISE EXCEPTION 'TOTE_FILL_ALREADY_REVERSED: this fill was already undone';
  END IF;
  SELECT quantity_available INTO v_bulk_now FROM public.inventory
   WHERE product_id = v_fill.bulk_product_id AND location = 'Main Warehouse';
  SELECT quantity_available INTO v_tote_now FROM public.inventory
   WHERE product_id = v_fill.tote_product_id AND location = 'Main Warehouse';
  -- Conservative: nothing else may have touched either product since the fill. Ledger rows are counted,
  -- not dated: a writer that started before the fill but committed after it has an earlier created_at,
  -- and two such writers can cancel out in stock.
  IF v_bulk_now IS DISTINCT FROM v_fill.bulk_after OR v_tote_now IS DISTINCT FROM v_fill.tote_after
     OR (SELECT count(*) FROM public.inventory_transactions WHERE product_id = v_fill.bulk_product_id)
          <> v_fill.bulk_ledger_rows
     OR (SELECT count(*) FROM public.inventory_transactions WHERE product_id = v_fill.tote_product_id)
          <> v_fill.tote_ledger_rows THEN
    RAISE EXCEPTION 'TOTE_FILL_STOCK_MOVED: stock of the tote or its bulk has moved since this fill; adjust stock instead';
  END IF;

  UPDATE public.inventory SET quantity_available = quantity_available + v_fill.bulk_quantity, updated_at = now()
   WHERE product_id = v_fill.bulk_product_id AND location = 'Main Warehouse';
  UPDATE public.inventory SET quantity_available = quantity_available - v_fill.totes, updated_at = now()
   WHERE product_id = v_fill.tote_product_id AND location = 'Main Warehouse';
  INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, to_location, performed_by, notes)
  VALUES (v_fill.bulk_product_id, 'tote_fill_out', v_fill.bulk_quantity, 'Main Warehouse', v_actor,
          format('Undo tote fill: %s %s back to bulk. Reason: %s', v_fill.bulk_quantity, v_fill.bulk_unit, v_reason))
  RETURNING id INTO v_out;
  INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, from_location, performed_by, notes)
  VALUES (v_fill.tote_product_id, 'tote_fill_in', -v_fill.totes, 'Main Warehouse', v_actor,
          format('Undo tote fill: %s tote(s) removed. Reason: %s', v_fill.totes, v_reason))
  RETURNING id INTO v_in;
  INSERT INTO public.tote_fills (tote_product_id, bulk_product_id, totes, gallons, bulk_unit, bulk_quantity,
    bulk_before, bulk_after, tote_before, tote_after, shortfall_quantity, bulk_ledger_rows, tote_ledger_rows,
    out_transaction_id, in_transaction_id, reverses_fill_id, reason, performed_by)
  VALUES (v_fill.tote_product_id, v_fill.bulk_product_id, v_fill.totes, v_fill.gallons, v_fill.bulk_unit,
    v_fill.bulk_quantity, v_bulk_now, v_bulk_now + v_fill.bulk_quantity, v_tote_now, v_tote_now - v_fill.totes,
    0, v_fill.bulk_ledger_rows + 1, v_fill.tote_ledger_rows + 1, v_out, v_in, p_fill_id, v_reason, v_actor)
  RETURNING id INTO v_undo;

  v_receipt := jsonb_build_object('undo_fill_id', v_undo, 'fill_id', p_fill_id, 'out_transaction_id', v_out,
    'in_transaction_id', v_in, 'bulk_after', v_bulk_now + v_fill.bulk_quantity, 'tote_after', v_tote_now - v_fill.totes);
  PERFORM public.save_idempotency(p_idempotency_key, 'reverse_tote_fill',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.reverse_tote_fill(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reverse_tote_fill(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reverse_tote_fill(uuid, text, text) TO authenticated;

DO $postflight$
BEGIN
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conname = 'inventory_transactions_transaction_type_check'
         AND conrelid = 'public.inventory_transactions'::regclass)
       NOT LIKE '%''prebook_reconciliation''::text, ''tote_fill_out''::text, ''tote_fill_in''::text]%'
     OR has_function_privilege('anon', 'public.fill_tote_from_bulk(uuid,integer,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.preview_tote_fill(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reverse_tote_fill(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._tote_fill_liquid_oz(text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.tote_fills', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.tote_fills', 'DELETE')
     OR has_function_privilege('authenticated', 'public._tote_fill_preview(uuid,integer)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.tote_fills', 'INSERT')
     OR NOT has_function_privilege('authenticated', 'public.reverse_tote_fill(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_TOTE_FILL_FAILED';
  END IF;
END;
$postflight$;
