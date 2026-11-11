-- idempotency-body-check: exempt
-- (set_delivery_brands, correct_delivery_brands and review_typed_brand require p_idempotency_key and check it before
--  any write with PAR-1's _product_parent_replay(key, scope, fingerprint), which refuses a key reused for another
--  operation, actor or payload, then save their receipt with save_idempotency (REG-1's pattern). edit_delivery keeps
--  its live check_idempotency_intent + bound-receipt pair; its body writes the receipt. The hook only recognises
--  check_idempotency.)
--
-- Written 2026-11-11. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270104120000_delivery_brands.md. Re-read the live ledger before applying.
--
-- WHY (Brand PR B, part B-1a; build sheet docs/plans/2026-11-08-product-BRAND-PRB-BUILD-SHEET.md, sections 14.2
--   and 15): a delivery records which brand of a product actually went off the truck on each line (a listed brand,
--   a split of several, or a brand typed from the jug), with an append-only history of every change. Nothing about
--   brands ever refuses a completion (Mason, 2026-11-09: "do not be strict on RUP license don't ever block just
--   warn"); problems are listed for the office. B-1b (a later migration) carries the brands onto invoice lines and
--   restricted-use records off the delivery_brand_events written here.
--
-- WHAT:
--   1. delivery_brand_events (append-only history; seq orders each delivery's changes) and delivery_item_brands
--      (one row per pick, with its snapshot); app roles may only SELECT them, under the delivery read rule.
--   2. Writers: set_delivery_brands (before completion), correct_delivery_brands (admin, after completion),
--      review_typed_brand (admin). Readers: get_delivery_brands, get_typed_brands_for_review,
--      get_deliveries_missing_brands.
--   3. Completion: _complete_delivery_aggregate_impl (the only caller of _complete_delivery_authorized_impl, the
--      only function that sets a delivery completed, reached only by a fresh completion) checks an optional brand
--      base seq, runs the unchanged completion body, then the completion rule (zero delivered drops picks; one pick
--      above delivered is trimmed; a legacy pick whose size was grouped is re-pointed to its parent brand) and writes
--      one 'completed' event with each line's delivered amount and brand-list size.
--   4. complete_delivery and start_and_complete_delivery gain a trailing p_brand_base_seq bigint DEFAULT NULL: the
--      reviewed bodies are renamed (unchanged) and called by thin wrappers that pass the value down in the
--      transaction-local setting crx.brand_base_seq.
--   5. edit_delivery's wrapper carries picks across the body's delete-and-recreate of lines (a line whose order item,
--      product, quantity and unit size are unchanged, and unambiguous, keeps its picks) and writes one 'edited' event.
--   6. The receipt snapshot is NOT changed here: brands on the customer receipt ship with B-3, together with the
--      sender that prints them and the resend after a correction (Sol round 2).
--
-- NOT CHANGED: _complete_delivery_authorized_impl, _edit_delivery_replay_impl_20261015, _enqueue_delivery_receipt, every invoice, RUP, stock and
--   money function and column. No existing row is written.
--
-- ROLLBACK (its own reviewed migration, a forward repair): restore the four re-issued function bodies (md5-pinned
--   below) and the two original signatures, and drop the new functions. The two tables and their rows STAY: every
--   completion after this apply writes a 'completed' event, and any picks saved are history; they are dropped only
--   by a separate, explicitly approved migration.
--
-- ORDERING: after 20270104110000 (RT-3). Independent of DM-4 and RT-3 (they touch no delivery function).
--
-- caller-analysis: complete_delivery :: the app (DeliveryDetail, FieldStop, Deliveries, offlineSync), start_and_complete_delivery and process_offline_action call it by name; the new wrapper keeps the name, the first eleven parameters and their defaults, and the grants (authenticated, service_role); only the renamed body loses EXECUTE
-- caller-analysis: start_and_complete_delivery :: the app calls it by name; the new wrapper keeps the name, the first ten parameters and the grant (authenticated); only the renamed body loses EXECUTE
-- caller-analysis: _complete_delivery_evidence_impl_20270104 :: called only by the new complete_delivery wrapper (SECURITY DEFINER, owner postgres)
-- caller-analysis: _start_and_complete_delivery_impl_20270104 :: called only by the new start_and_complete_delivery wrapper (SECURITY DEFINER, owner postgres)
-- caller-analysis: all-functions :: every new _-prefixed helper is internal (EXECUTE revoked from PUBLIC, anon, authenticated, service_role); every new public RPC is granted to authenticated only

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE delivery_brands_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_expected constant text[][] := ARRAY[
    ['_complete_delivery_aggregate_impl', 'b888901587accbee7f7fe4aeb512e683'],
    ['complete_delivery', 'eed8da07fedbec14a198ca4f6e26c213'],
    ['start_and_complete_delivery', '640603e6dce34abc1fe18d4dad6adc56'],
    ['edit_delivery', '99d606e01caacc135c9469eedba11491'],
    ['_edit_delivery_replay_impl_20261015', '942011a2bf15b83269e74830fa057377']];
  v_i integer;
BEGIN
  IF to_regclass('pg_temp.delivery_brands_tx') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_BRANDS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.delivery_brands_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'DELIVERY_BRANDS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  -- Each re-issued or wrapped function is exactly the reviewed live body (one overload each).
  FOR v_i IN 1 .. array_length(v_expected, 1) LOOP
    IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = v_expected[v_i][1]) <> 1
       OR (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = v_expected[v_i][1])
          IS DISTINCT FROM v_expected[v_i][2] THEN
      RAISE EXCEPTION 'PREFLIGHT_DELIVERY_BRANDS_DRIFT: % is not the reviewed live body', v_expected[v_i][1];
    END IF;
  END LOOP;
  IF to_regprocedure('public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean)') IS NULL
     OR to_regprocedure('public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text)') IS NULL
     OR to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)') IS NULL
     OR to_regprocedure('public._product_parent_replay(text,text,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regprocedure('public._normalize_epa_registration(text)') IS NULL
     OR to_regprocedure('public._product_parent_grouping_open()') IS NULL
     OR to_regprocedure('public.update_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DELIVERY_BRANDS_DRIFT: a function this file relies on is missing or changed signature';
  END IF;
  -- Only the completion body sets a delivery completed, so the completion rule below sees every completion.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
               AND proname <> '_complete_delivery_authorized_impl'
               AND prosrc ~* 'update\s+(public\.)?deliveries\s+set[^;]*status\s*=\s*''completed''') THEN
    RAISE EXCEPTION 'PREFLIGHT_DELIVERY_BRANDS_DRIFT: another function now completes deliveries';
  END IF;
  IF to_regclass('public.delivery_item_brands') IS NOT NULL OR to_regclass('public.delivery_brand_events') IS NOT NULL
     OR to_regprocedure('public._complete_delivery_evidence_impl_20270104(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DELIVERY_BRANDS_ALREADY_APPLIED';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Keys the picks bind to (non-destructive: both are already unique by id).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.delivery_items
  ADD CONSTRAINT delivery_items_id_delivery_product_key UNIQUE (id, delivery_id, product_id);
ALTER TABLE public.product_parent_brands
  ADD CONSTRAINT product_parent_brands_parent_id_id_key UNIQUE (parent_id, id);

-- ---------------------------------------------------------------------------------------------
-- 2. Tables.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.delivery_brand_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('set', 'edited', 'completed', 'corrected', 'reviewed', 'line_removed')),
  delivery_id uuid NOT NULL REFERENCES public.deliveries(id) ON DELETE RESTRICT,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 1000),
  invoice_ids uuid[] NOT NULL DEFAULT '{}',
  before_rows jsonb NOT NULL DEFAULT '[]',
  after_rows jsonb NOT NULL DEFAULT '[]',
  details jsonb NOT NULL DEFAULT '{}',
  actor uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  actor_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_brand_events_delivery_idx ON public.delivery_brand_events (delivery_id, seq);

COMMENT ON TABLE public.delivery_brand_events IS
  'Brand PR B (20270104120000): append-only history of every change to a delivery''s brand picks. The highest seq per delivery, line_removed aside, is the stale-save base. Written only by the delivery brand functions and the delivery_items delete trigger; B-1b re-copies invoice drafts off its inserts. details: completed {picks_confirmed (true, false = completed from an out-of-date screen, or null = no seq sent), lines[{delivery_item_id, product_id, quantity_delivered, brand_list_size, pick_count, picked_quantity}]}; edited {kept[{old_delivery_item_id, delivery_item_id}], dropped[{old_delivery_item_id, order_item_id, product_id}]}; reviewed {action, brand_id}; line_removed {delivery_item_id, order_item_id, product_id}.';

CREATE TABLE public.delivery_item_brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_item_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  product_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('parent', 'size', 'typed')),
  parent_id uuid,
  parent_brand_id uuid,
  legacy_brand_id uuid,
  brand_name text NOT NULL CHECK (btrim(brand_name) <> '' AND brand_name = btrim(brand_name) AND char_length(brand_name) <= 200),
  epa_registration text CHECK (epa_registration IS NULL
    OR epa_registration ~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$'),
  manufacturer text CHECK (manufacturer IS NULL
    OR (btrim(manufacturer) <> '' AND manufacturer = btrim(manufacturer) AND char_length(manufacturer) <= 200)),
  signal_word text CHECK (signal_word IS NULL OR signal_word IN ('Danger', 'Warning', 'Caution')),
  quantity numeric NOT NULL CHECK (quantity > 0 AND quantity <> 'NaN'::numeric AND quantity = round(quantity, 4)),
  review_state text CHECK (review_state IN ('pending', 'added', 'dismissed')),
  review_note text CHECK (review_note IS NULL OR review_note = 'number_differs_from_list'),
  review_brand_ref uuid,
  review_reason text CHECK (review_reason IS NULL OR char_length(review_reason) <= 1000),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  entered_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  entered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  superseded_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  supersede_reason text CHECK (supersede_reason IS NULL OR char_length(supersede_reason) <= 1000),
  superseded_by_event_seq bigint REFERENCES public.delivery_brand_events(seq) ON DELETE RESTRICT,
  -- The pick's copies can never disagree with its line. CASCADE: a line delete is recorded first (section 3,
  -- _delivery_brands_on_line_delete), or by edit_delivery's own 'edited' event when it re-creates lines.
  CONSTRAINT delivery_item_brands_line_fkey FOREIGN KEY (delivery_item_id, delivery_id, product_id)
    REFERENCES public.delivery_items (id, delivery_id, product_id) ON DELETE CASCADE,
  CONSTRAINT delivery_item_brands_parent_brand_fkey FOREIGN KEY (parent_id, parent_brand_id)
    REFERENCES public.product_parent_brands (parent_id, id) ON DELETE RESTRICT,
  -- A size's brand belongs to that size: a line can never carry another size's brand.
  CONSTRAINT delivery_item_brands_size_brand_fkey FOREIGN KEY (product_id, legacy_brand_id)
    REFERENCES public.product_brands (product_id, id) ON DELETE RESTRICT,
  CONSTRAINT delivery_item_brands_source_shape CHECK (
    (source = 'parent' AND parent_id IS NOT NULL AND parent_brand_id IS NOT NULL AND legacy_brand_id IS NULL)
    OR (source = 'size' AND legacy_brand_id IS NOT NULL AND parent_id IS NULL AND parent_brand_id IS NULL)
    OR (source = 'typed' AND parent_id IS NULL AND parent_brand_id IS NULL AND legacy_brand_id IS NULL)),
  CONSTRAINT delivery_item_brands_review_shape CHECK (
    (source = 'typed') = (review_state IS NOT NULL)
    AND (review_note IS NULL OR source = 'typed')
    AND (review_state IS NULL OR (review_state = 'pending') = (reviewed_at IS NULL))),
  CONSTRAINT delivery_item_brands_supersede_shape CHECK (
    (superseded_at IS NULL) = (superseded_by_event_seq IS NULL))
);
CREATE UNIQUE INDEX delivery_item_brands_one_current ON public.delivery_item_brands
  (delivery_item_id, lower(brand_name), COALESCE(epa_registration, '')) WHERE superseded_at IS NULL;
CREATE INDEX delivery_item_brands_delivery_idx ON public.delivery_item_brands (delivery_id) WHERE superseded_at IS NULL;
CREATE INDEX delivery_item_brands_pending_idx ON public.delivery_item_brands (entered_at)
  WHERE review_state = 'pending' AND superseded_at IS NULL;

CREATE TRIGGER set_delivery_item_brands_updated_at BEFORE UPDATE ON public.delivery_item_brands
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.delivery_item_brands IS
  'Brand PR B (20270104120000): the brands recorded on a delivery line (one row per pick), with a snapshot of name, EPA number, manufacturer and signal word. Current when superseded_at IS NULL. Written only by set_delivery_brands, completion, edit_delivery, correct_delivery_brands and review_typed_brand.';

-- Append-only history.
CREATE FUNCTION public._delivery_brand_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'DELIVERY_BRAND_EVENTS_APPEND_ONLY: brand history cannot be changed or removed';
END;
$function$;
ALTER FUNCTION public._delivery_brand_events_append_only() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._delivery_brand_events_append_only() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER delivery_brand_events_no_change BEFORE UPDATE OR DELETE ON public.delivery_brand_events
  FOR EACH ROW EXECUTE FUNCTION public._delivery_brand_events_append_only();
CREATE TRIGGER delivery_brand_events_no_truncate BEFORE TRUNCATE ON public.delivery_brand_events
  FOR EACH STATEMENT EXECUTE FUNCTION public._delivery_brand_events_append_only();

-- Grants and read rule (del_items_select's rule, with the driver also active). Supabase's default privileges give
-- new tables write and TRUNCATE to app roles; RLS does not cover TRUNCATE, so everything is revoked first.
ALTER TABLE public.delivery_brand_events OWNER TO postgres;
ALTER TABLE public.delivery_item_brands OWNER TO postgres;
ALTER TABLE public.delivery_brand_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_item_brands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.delivery_brand_events FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON TABLE public.delivery_item_brands FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
DO $seq$
BEGIN
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role, metabase_ro',
    pg_get_serial_sequence('public.delivery_brand_events', 'seq'));
END
$seq$;
GRANT SELECT ON TABLE public.delivery_brand_events TO authenticated;
GRANT SELECT ON TABLE public.delivery_item_brands TO authenticated;
CREATE POLICY delivery_brand_events_select ON public.delivery_brand_events FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()) OR (SELECT public.is_sales_rep())
         OR EXISTS (SELECT 1 FROM public.deliveries d JOIN public.profiles p ON p.id = d.assigned_driver
                     WHERE d.id = delivery_brand_events.delivery_id AND p.id = (SELECT auth.uid()) AND p.is_active));
CREATE POLICY delivery_item_brands_select ON public.delivery_item_brands FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()) OR (SELECT public.is_sales_rep())
         OR EXISTS (SELECT 1 FROM public.deliveries d JOIN public.profiles p ON p.id = d.assigned_driver
                     WHERE d.id = delivery_item_brands.delivery_id AND p.id = (SELECT auth.uid()) AND p.is_active));

-- ---------------------------------------------------------------------------------------------
-- 3. Internal helpers.
-- ---------------------------------------------------------------------------------------------

-- A size's brand list: its parent's active brands when grouped and the grouping switch is on, otherwise its own
-- legacy brands (get_product_brands' rule).
CREATE FUNCTION public._delivery_line_brand_list(p_product_id uuid)
RETURNS TABLE(source text, parent_id uuid, brand_id uuid, brand_name text, epa_registration text, manufacturer text,
              is_currently_sourced boolean, is_rup boolean, signal_word text, row_version integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  WITH grouped AS (
    SELECT m.parent_id FROM public.product_parent_members m
     WHERE m.product_id = p_product_id AND public._product_parent_grouping_open()
  )
  SELECT 'parent'::text, b.parent_id, b.id, b.brand_name, b.epa_registration, b.manufacturer, b.is_currently_sourced,
         b.is_rup, b.signal_word, b.row_version
    FROM public.product_parent_brands b JOIN grouped g ON g.parent_id = b.parent_id
   WHERE b.status = 'active'
  UNION ALL
  SELECT 'size'::text, NULL::uuid, b.id, b.brand_name, b.epa_registration, b.manufacturer, b.is_currently_sourced,
         b.is_rup, b.signal_word, b.row_version
    FROM public.product_brands b
   WHERE b.product_id = p_product_id AND NOT EXISTS (SELECT 1 FROM grouped);
$function$;

CREATE FUNCTION public._delivery_brand_max_seq(p_delivery_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  -- A line_removed event (written by a trigger that takes no delivery lock) is history only: a save naming a deleted
  -- line is refused as not on the delivery, so the removal need not move the stale-save base.
  SELECT COALESCE(max(e.seq), 0) FROM public.delivery_brand_events e
   WHERE e.delivery_id = p_delivery_id AND e.event_type <> 'line_removed';
$function$;

-- The current picks of a delivery (or of some of its lines), as stored.
CREATE FUNCTION public._delivery_brand_rows(p_delivery_id uuid, p_line_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', b.id, 'delivery_item_id', b.delivery_item_id, 'product_id', b.product_id, 'source', b.source,
           'parent_id', b.parent_id, 'parent_brand_id', b.parent_brand_id, 'legacy_brand_id', b.legacy_brand_id,
           'brand_name', b.brand_name, 'epa_registration', b.epa_registration, 'manufacturer', b.manufacturer,
           'signal_word', b.signal_word, 'quantity', b.quantity, 'review_state', b.review_state,
           'review_note', b.review_note, 'review_brand_ref', b.review_brand_ref, 'review_reason', b.review_reason,
           'reviewed_by', b.reviewed_by, 'reviewed_at', b.reviewed_at, 'entered_by', b.entered_by,
           'entered_at', b.entered_at)
           ORDER BY b.delivery_item_id, lower(b.brand_name), COALESCE(b.epa_registration, ''), b.id), '[]'::jsonb)
    FROM public.delivery_item_brands b
   WHERE b.delivery_id = p_delivery_id AND b.superseded_at IS NULL
     AND (p_line_ids IS NULL OR b.delivery_item_id = ANY (p_line_ids));
$function$;

CREATE FUNCTION public._delivery_brand_event(
  p_delivery_id uuid, p_type text, p_reason text, p_invoice_ids uuid[], p_before jsonb, p_after jsonb, p_details jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_seq bigint;
BEGIN
  INSERT INTO public.delivery_brand_events
    (event_type, delivery_id, reason, invoice_ids, before_rows, after_rows, details, actor, actor_name)
  VALUES (p_type, p_delivery_id, p_reason, COALESCE(p_invoice_ids, '{}'), COALESCE(p_before, '[]'),
          COALESCE(p_after, '[]'), COALESCE(p_details, '{}'), v_actor,
          (SELECT NULLIF(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = v_actor))
  RETURNING seq INTO v_seq;
  RETURN v_seq;
END;
$function$;

-- Turns one line's requested picks into validated rows (snapshots from the brand row for a listed pick, from the
-- typed values for a typed one). Never trusts a client snapshot for a listed brand. Each row gets its new pick id.
CREATE FUNCTION public._delivery_brand_resolve_picks(p_product_id uuid, p_picks jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_pick jsonb;
  v_out jsonb := '[]'::jsonb;
  v_qty numeric;
  v_brand_id uuid;
  v_brand record;
  v_matches integer;
  v_name text;
  v_epa text;
  v_mfr text;
  v_row jsonb;
BEGIN
  IF p_picks IS NULL OR jsonb_typeof(p_picks) <> 'array' THEN
    RAISE EXCEPTION 'BRAND_PICKS_INVALID: picks must be a list' USING ERRCODE = '22023';
  END IF;
  FOR v_pick IN SELECT value FROM jsonb_array_elements(p_picks) LOOP
    IF jsonb_typeof(v_pick) <> 'object' THEN
      RAISE EXCEPTION 'BRAND_PICKS_INVALID: each pick must be an object' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_pick -> 'quantity') IS DISTINCT FROM 'number' OR (v_pick ->> 'quantity')::numeric <= 0
       OR (v_pick ->> 'quantity')::numeric <> round((v_pick ->> 'quantity')::numeric, 4) THEN
      RAISE EXCEPTION 'BRAND_PICK_QUANTITY_INVALID: each brand needs an amount above zero, to at most 4 decimals'
        USING ERRCODE = '22023';
    END IF;
    v_qty := (v_pick ->> 'quantity')::numeric;
    v_brand := NULL;
    IF NULLIF(btrim(COALESCE(v_pick ->> 'brand_id', '')), '') IS NOT NULL THEN
      BEGIN
        v_brand_id := (v_pick ->> 'brand_id')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'BRAND_NOT_FOR_PRODUCT: that brand is not on this product''s brand list' USING ERRCODE = '22023';
      END;
      SELECT * INTO v_brand FROM public._delivery_line_brand_list(p_product_id) l WHERE l.brand_id = v_brand_id;
      IF v_brand.brand_id IS NULL THEN
        RAISE EXCEPTION 'BRAND_NOT_FOR_PRODUCT: that brand is not on this product''s brand list' USING ERRCODE = '22023';
      END IF;
      v_row := jsonb_build_object('source', v_brand.source, 'parent_id', v_brand.parent_id,
        'parent_brand_id', CASE WHEN v_brand.source = 'parent' THEN v_brand.brand_id END,
        'legacy_brand_id', CASE WHEN v_brand.source = 'size' THEN v_brand.brand_id END,
        'brand_name', v_brand.brand_name, 'epa_registration', v_brand.epa_registration,
        'manufacturer', v_brand.manufacturer, 'signal_word', v_brand.signal_word,
        'review_state', NULL, 'review_note', NULL);
    ELSE
      v_name := btrim(regexp_replace(COALESCE(v_pick ->> 'typed_name', ''), '[[:space:]]+', ' ', 'g'));
      IF v_name = '' THEN
        RAISE EXCEPTION 'BRAND_TYPED_NAME_REQUIRED: name the brand on the jug' USING ERRCODE = '22023';
      END IF;
      IF char_length(v_name) > 200 THEN
        RAISE EXCEPTION 'BRAND_TYPED_NAME_TOO_LONG: keep the brand name to 200 characters' USING ERRCODE = '22023';
      END IF;
      v_epa := NULL;
      IF NULLIF(btrim(COALESCE(v_pick ->> 'typed_epa', '')), '') IS NOT NULL THEN
        v_epa := public._normalize_epa_registration(v_pick ->> 'typed_epa');
        IF v_epa IS NULL OR v_epa !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
          RAISE EXCEPTION 'BRAND_EPA_NUMBER_INVALID: % is not an EPA registration number', v_pick ->> 'typed_epa'
            USING ERRCODE = '22023';
        END IF;
      END IF;
      v_mfr := NULLIF(btrim(regexp_replace(COALESCE(v_pick ->> 'typed_manufacturer', ''), '[[:space:]]+', ' ', 'g')), '');
      IF char_length(v_mfr) > 200 THEN
        RAISE EXCEPTION 'BRAND_TYPED_MANUFACTURER_TOO_LONG: keep the manufacturer to 200 characters' USING ERRCODE = '22023';
      END IF;
      -- A typed name that is exactly one listed brand is that listed pick when the numbers agree (or none was
      -- typed). Two listed brands sharing the name with no number typed is ambiguous: it stays typed, for review.
      SELECT count(*) INTO v_matches FROM public._delivery_line_brand_list(p_product_id) l
       WHERE lower(l.brand_name) = lower(v_name)
         AND (v_epa IS NULL OR l.epa_registration IS NOT DISTINCT FROM v_epa);
      IF v_matches = 1 THEN
        SELECT * INTO v_brand FROM public._delivery_line_brand_list(p_product_id) l
         WHERE lower(l.brand_name) = lower(v_name)
           AND (v_epa IS NULL OR l.epa_registration IS NOT DISTINCT FROM v_epa);
        v_row := jsonb_build_object('source', v_brand.source, 'parent_id', v_brand.parent_id,
          'parent_brand_id', CASE WHEN v_brand.source = 'parent' THEN v_brand.brand_id END,
          'legacy_brand_id', CASE WHEN v_brand.source = 'size' THEN v_brand.brand_id END,
          'brand_name', v_brand.brand_name, 'epa_registration', v_brand.epa_registration,
          'manufacturer', v_brand.manufacturer, 'signal_word', v_brand.signal_word,
          'review_state', NULL, 'review_note', NULL);
      ELSE
        v_row := jsonb_build_object('source', 'typed', 'parent_id', NULL, 'parent_brand_id', NULL,
          'legacy_brand_id', NULL, 'brand_name', v_name, 'epa_registration', v_epa, 'manufacturer', v_mfr,
          'signal_word', NULL, 'review_state', 'pending',
          'review_note', CASE WHEN v_matches = 0 AND v_epa IS NOT NULL
                                   AND EXISTS (SELECT 1 FROM public._delivery_line_brand_list(p_product_id) l
                                                WHERE lower(l.brand_name) = lower(v_name))
                              THEN 'number_differs_from_list' END);
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_out) o
                WHERE lower(o.value ->> 'brand_name') = lower(v_row ->> 'brand_name')
                  AND COALESCE(o.value ->> 'epa_registration', '') = COALESCE(v_row ->> 'epa_registration', '')) THEN
      RAISE EXCEPTION 'BRAND_PICK_DUPLICATE: % is picked twice on one line', v_row ->> 'brand_name' USING ERRCODE = '22023';
    END IF;
    v_out := v_out || jsonb_build_array(v_row || jsonb_build_object('id', gen_random_uuid(), 'quantity', v_qty));
  END LOOP;
  RETURN v_out;
END;
$function$;

-- Inserts resolved picks for one line, under the ids _delivery_brand_resolve_picks gave them.
CREATE FUNCTION public._delivery_brand_insert(p_line_id uuid, p_delivery_id uuid, p_product_id uuid, p_rows jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  INSERT INTO public.delivery_item_brands
    (id, delivery_item_id, delivery_id, product_id, source, parent_id, parent_brand_id, legacy_brand_id, brand_name,
     epa_registration, manufacturer, signal_word, quantity, review_state, review_note, entered_by)
  SELECT (r ->> 'id')::uuid, p_line_id, p_delivery_id, p_product_id, r ->> 'source', (r ->> 'parent_id')::uuid,
         (r ->> 'parent_brand_id')::uuid, (r ->> 'legacy_brand_id')::uuid, r ->> 'brand_name',
         r ->> 'epa_registration', r ->> 'manufacturer', r ->> 'signal_word', (r ->> 'quantity')::numeric,
         r ->> 'review_state', r ->> 'review_note', auth.uid()
    FROM jsonb_array_elements(p_rows) r;
$function$;

-- The completion rule (build sheet 4.C steps 1, 2 and 5; 14.3 removed step 6). Called once per fresh completion by
-- _complete_delivery_aggregate_impl, after the delivered amounts are final, with the delivery row locked.
CREATE FUNCTION public._delivery_brands_on_complete(p_delivery_id uuid, p_picks_confirmed boolean)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_before jsonb := public._delivery_brand_rows(p_delivery_id);
  v_line record;
  v_lines jsonb := '[]'::jsonb;
  v_pick record;
  v_parent_id uuid;
  v_target uuid;
BEGIN
  FOR v_line IN
    SELECT di.id, di.product_id, COALESCE(di.quantity_delivered, di.quantity) AS delivered
      FROM public.delivery_items di WHERE di.delivery_id = p_delivery_id ORDER BY di.id
  LOOP
    IF v_line.delivered <= 0 THEN
      -- Step 1: nothing went off the truck on this line; the event keeps the old picks.
      DELETE FROM public.delivery_item_brands WHERE delivery_item_id = v_line.id AND superseded_at IS NULL;
    ELSE
      -- Step 5: a size's brand whose size has since been grouped follows its parent brand; the snapshot stays.
      v_parent_id := (SELECT m.parent_id FROM public.product_parent_members m
                       WHERE m.product_id = v_line.product_id AND public._product_parent_grouping_open());
      IF v_parent_id IS NOT NULL THEN
        FOR v_pick IN
          SELECT b.id, b.legacy_brand_id FROM public.delivery_item_brands b
           WHERE b.delivery_item_id = v_line.id AND b.superseded_at IS NULL AND b.source = 'size'
           ORDER BY b.id
        LOOP
          v_target := (SELECT s.parent_brand_id FROM public.product_parent_brand_sources s
                         JOIN public.product_parent_brands pb ON pb.id = s.parent_brand_id
                        WHERE s.legacy_brand_id = v_pick.legacy_brand_id AND pb.parent_id = v_parent_id);
          IF v_target IS NOT NULL THEN
            UPDATE public.delivery_item_brands
               SET source = 'parent', parent_id = v_parent_id, parent_brand_id = v_target, legacy_brand_id = NULL
             WHERE id = v_pick.id;
          END IF;
        END LOOP;
      END IF;
      -- Step 2: one pick covering at least the delivered amount is that amount (same brand, nothing guessed).
      -- A delivered amount finer than a pick may hold (4 places) is left alone and listed as a mismatch:
      -- the trim must never fail the pick CHECK and so block the completion.
      UPDATE public.delivery_item_brands b SET quantity = v_line.delivered
       WHERE b.delivery_item_id = v_line.id AND b.superseded_at IS NULL AND b.quantity > v_line.delivered
         AND v_line.delivered = round(v_line.delivered, 4)
         AND (SELECT count(*) FROM public.delivery_item_brands c
               WHERE c.delivery_item_id = v_line.id AND c.superseded_at IS NULL) = 1;
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'delivery_item_id', v_line.id, 'product_id', v_line.product_id, 'quantity_delivered', v_line.delivered,
      'brand_list_size', (SELECT count(*) FROM public._delivery_line_brand_list(v_line.product_id)),
      'pick_count', (SELECT count(*) FROM public.delivery_item_brands b
                      WHERE b.delivery_item_id = v_line.id AND b.superseded_at IS NULL),
      'picked_quantity', (SELECT COALESCE(sum(b.quantity), 0) FROM public.delivery_item_brands b
                           WHERE b.delivery_item_id = v_line.id AND b.superseded_at IS NULL)));
  END LOOP;
  RETURN public._delivery_brand_event(p_delivery_id, 'completed', NULL, NULL, v_before,
    public._delivery_brand_rows(p_delivery_id),
    jsonb_build_object('picks_confirmed', p_picks_confirmed, 'lines', v_lines));
END;
$function$;

-- Whether the caller may read or set a delivery's brands (the del_items_select rule, active profiles only).
CREATE FUNCTION public._delivery_brand_may_read(p_delivery_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.deliveries d ON d.id = p_delivery_id AND d.deleted_at IS NULL
     WHERE p.id = auth.uid() AND p.is_active = true
       AND (p.role IN ('admin', 'sales_rep') OR (p.role = 'driver' AND d.assigned_driver = p.id)));
$function$;

DO $helper_grants$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public._delivery_line_brand_list(uuid)', 'public._delivery_brand_max_seq(uuid)',
    'public._delivery_brand_rows(uuid,uuid[])', 'public._delivery_brand_event(uuid,text,text,uuid[],jsonb,jsonb,jsonb)',
    'public._delivery_brand_resolve_picks(uuid,jsonb)', 'public._delivery_brand_insert(uuid,uuid,uuid,jsonb)',
    'public._delivery_brands_on_complete(uuid,boolean)', 'public._delivery_brand_may_read(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_sig);
  END LOOP;
END
$helper_grants$;

-- A delivery line deleted outside edit_delivery (a direct delete of a scheduled line, or the order clean-up of a
-- cancelled or voided delivery) takes its picks with it (the pick key cascades): record them first as one
-- 'line_removed' event. History only: it does not move the stale-save base and takes no FOR UPDATE on the delivery,
-- but the event's delivery foreign key takes a key-share lock on it. So a completion holding the delivery while it
-- waits on a line being deleted can still deadlock; Postgres cancels one and it is retried (rare, accepted, 15.10).
-- edit_delivery's re-create records its own 'edited'
-- event and sets crx.delivery_brand_edit around its body, so it is not recorded twice.
CREATE FUNCTION public._delivery_brands_on_line_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF COALESCE(current_setting('crx.delivery_brand_edit', true), '') = 'on' THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_item_brands b
                  WHERE b.delivery_item_id = OLD.id AND b.superseded_at IS NULL) THEN
    PERFORM public._delivery_brand_event(OLD.delivery_id, 'line_removed', NULL, NULL,
      public._delivery_brand_rows(OLD.delivery_id, ARRAY[OLD.id]), '[]'::jsonb,
      jsonb_build_object('delivery_item_id', OLD.id, 'order_item_id', OLD.order_item_id, 'product_id', OLD.product_id));
  END IF;
  RETURN OLD;
END;
$function$;
ALTER FUNCTION public._delivery_brands_on_line_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._delivery_brands_on_line_delete() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER delivery_items_brand_line_removed BEFORE DELETE ON public.delivery_items
  FOR EACH ROW EXECUTE FUNCTION public._delivery_brands_on_line_delete();

-- ---------------------------------------------------------------------------------------------
-- 4. set_delivery_brands: record picks before completion. Order: lock the delivery, authorize, replay, then the
--    checks that can change after a first success (status, base seq, catalog).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.set_delivery_brands(
  p_delivery_id uuid, p_lines jsonb, p_base_event_seq bigint, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_delivery record;
  v_fp text;
  v_existing jsonb;
  v_line jsonb;
  v_item record;
  v_rows jsonb;
  v_line_ids uuid[] := '{}';
  v_before jsonb;
  v_seq bigint;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT id, status INTO v_delivery FROM public.deliveries
   WHERE id = p_delivery_id AND deleted_at IS NULL FOR UPDATE;
  IF v_delivery.id IS NULL THEN RAISE EXCEPTION 'DELIVERY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- Checked with the delivery locked, so a reassignment cannot slip between this check and the write.
  IF NOT public._delivery_brand_may_read(p_delivery_id) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: you cannot record brands on this delivery' USING ERRCODE = '42501';
  END IF;
  v_fp := md5(jsonb_build_array(p_delivery_id, p_lines, p_base_event_seq)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'set_delivery_brands', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'DELIVERY_BRANDS_LOCKED: this delivery is %; brands after completion are corrected by an admin', v_delivery.status;
  END IF;
  IF p_base_event_seq IS NULL THEN RAISE EXCEPTION 'BRAND_BASE_SEQ_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_base_event_seq IS DISTINCT FROM public._delivery_brand_max_seq(p_delivery_id) THEN
    RAISE EXCEPTION 'BRAND_PICKS_CHANGED: someone else changed this delivery''s brands; reload and try again';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'BRAND_LINES_REQUIRED: name at least one delivery line' USING ERRCODE = '22023';
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT di.id INTO v_item FROM public.delivery_items di
     WHERE di.delivery_id = p_delivery_id AND di.id::text = (v_line ->> 'delivery_item_id');
    IF v_item.id IS NULL THEN
      RAISE EXCEPTION 'DELIVERY_ITEM_NOT_ON_DELIVERY: % is not a line of this delivery', v_line ->> 'delivery_item_id'
        USING ERRCODE = '22023';
    END IF;
    IF v_item.id = ANY (v_line_ids) THEN
      RAISE EXCEPTION 'BRAND_LINE_DUPLICATE: a line is named twice' USING ERRCODE = '22023';
    END IF;
    v_line_ids := v_line_ids || v_item.id;
  END LOOP;

  v_before := public._delivery_brand_rows(p_delivery_id, v_line_ids);
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT di.id, di.product_id, di.quantity INTO v_item FROM public.delivery_items di
     WHERE di.delivery_id = p_delivery_id AND di.id::text = (v_line ->> 'delivery_item_id');
    v_rows := public._delivery_brand_resolve_picks(v_item.product_id, v_line -> 'picks');
    IF (SELECT COALESCE(sum((r ->> 'quantity')::numeric), 0) FROM jsonb_array_elements(v_rows) r) > v_item.quantity THEN
      RAISE EXCEPTION 'BRAND_SPLIT_OVER_LOADED: the brand amounts add up to more than was loaded on this line'
        USING ERRCODE = '22023';
    END IF;
    -- Nothing has been issued before completion, so replaced picks are removed; the event keeps them. An empty
    -- list clears the line.
    DELETE FROM public.delivery_item_brands WHERE delivery_item_id = v_item.id AND superseded_at IS NULL;
    PERFORM public._delivery_brand_insert(v_item.id, p_delivery_id, v_item.product_id, v_rows);
  END LOOP;

  v_seq := public._delivery_brand_event(p_delivery_id, 'set', NULL, NULL, v_before,
    public._delivery_brand_rows(p_delivery_id, v_line_ids), '{}'::jsonb);
  v_result := jsonb_build_object('delivery_id', p_delivery_id, 'event_seq', v_seq,
    'picks', public._delivery_brand_rows(p_delivery_id));
  PERFORM public.save_idempotency(p_idempotency_key, 'set_delivery_brands',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 5. correct_delivery_brands: an admin fixes a completed delivery's brands (never overwrites a pick). A line's new
--    picks add up to what was delivered, or are empty (the brand is not known: the line goes back on the list).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.correct_delivery_brands(
  p_delivery_id uuid, p_lines jsonb, p_reason text, p_base_event_seq bigint, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_delivery record;
  v_fp text;
  v_existing jsonb;
  v_reason text;
  v_line jsonb;
  v_item record;
  v_rows jsonb;
  v_plan jsonb := '[]'::jsonb;
  v_after jsonb := '[]'::jsonb;
  v_step jsonb;
  v_line_ids uuid[] := '{}';
  v_order_items uuid[] := '{}';
  v_invoice record;
  v_invoice_ids uuid[] := '{}';
  v_before jsonb;
  v_seq bigint;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT id, status INTO v_delivery FROM public.deliveries
   WHERE id = p_delivery_id AND deleted_at IS NULL FOR UPDATE;
  IF v_delivery.id IS NULL THEN RAISE EXCEPTION 'DELIVERY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED: only an admin can correct delivered brands' USING ERRCODE = '42501';
  END IF;
  v_fp := md5(jsonb_build_array(p_delivery_id, p_lines, p_reason, p_base_event_seq)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'correct_delivery_brands', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  IF v_delivery.status <> 'completed' THEN
    RAISE EXCEPTION 'DELIVERY_NOT_COMPLETED: brands are corrected only on a completed delivery (this one is %)', v_delivery.status;
  END IF;
  v_reason := btrim(regexp_replace(COALESCE(p_reason, ''), '[[:space:]]+', ' ', 'g'));
  IF v_reason = '' THEN RAISE EXCEPTION 'BRAND_CORRECTION_REASON_REQUIRED: say why the brands are being corrected' USING ERRCODE = '22023'; END IF;
  IF char_length(v_reason) > 1000 THEN RAISE EXCEPTION 'BRAND_CORRECTION_REASON_TOO_LONG: keep the reason to 1,000 characters' USING ERRCODE = '22023'; END IF;
  IF p_base_event_seq IS NULL THEN RAISE EXCEPTION 'BRAND_BASE_SEQ_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_base_event_seq IS DISTINCT FROM public._delivery_brand_max_seq(p_delivery_id) THEN
    RAISE EXCEPTION 'BRAND_PICKS_CHANGED: someone else changed this delivery''s brands; reload and try again';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'BRAND_LINES_REQUIRED: name at least one delivery line' USING ERRCODE = '22023';
  END IF;

  -- Validate every line and resolve its picks before anything is written.
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT di.id, di.order_item_id, di.product_id, COALESCE(di.quantity_delivered, di.quantity) AS delivered
      INTO v_item FROM public.delivery_items di
     WHERE di.delivery_id = p_delivery_id AND di.id::text = (v_line ->> 'delivery_item_id');
    IF v_item.id IS NULL THEN
      RAISE EXCEPTION 'DELIVERY_ITEM_NOT_ON_DELIVERY: % is not a line of this delivery', v_line ->> 'delivery_item_id'
        USING ERRCODE = '22023';
    END IF;
    IF v_item.id = ANY (v_line_ids) THEN RAISE EXCEPTION 'BRAND_LINE_DUPLICATE: a line is named twice' USING ERRCODE = '22023'; END IF;
    v_line_ids := v_line_ids || v_item.id;
    IF v_item.order_item_id IS NOT NULL THEN v_order_items := v_order_items || v_item.order_item_id; END IF;
    v_rows := public._delivery_brand_resolve_picks(v_item.product_id, v_line -> 'picks');
    IF jsonb_array_length(v_rows) > 0
       AND (SELECT sum((r ->> 'quantity')::numeric) FROM jsonb_array_elements(v_rows) r) IS DISTINCT FROM round(v_item.delivered, 4) THEN
      RAISE EXCEPTION 'BRAND_SPLIT_NOT_DELIVERED: the corrected brand amounts must add up to the % delivered', v_item.delivered
        USING ERRCODE = '22023';
    END IF;
    v_plan := v_plan || jsonb_build_array(jsonb_build_object('line_id', v_item.id, 'product_id', v_item.product_id,
      'rows', v_rows));
    SELECT v_after || COALESCE(jsonb_agg(r || jsonb_build_object('delivery_item_id', v_item.id,
             'product_id', v_item.product_id)), '[]'::jsonb)
      INTO v_after FROM jsonb_array_elements(v_rows) r;
  END LOOP;

  -- Posted invoices are never changed (REG-1): every live invoice that carries these lines is locked after the
  -- delivery row, in id order, and re-read. Posting never locks a delivery, so this order cannot cycle with it.
  FOR v_invoice IN
    SELECT i.id, i.status, i.invoice_number FROM public.invoices i
     WHERE i.deleted_at IS NULL AND i.invoice_type <> 'credit_memo' AND i.status NOT IN ('voided', 'cancelled')
       AND (i.delivery_id = p_delivery_id
            OR (i.delivery_id IS NULL AND EXISTS (SELECT 1 FROM public.invoice_items ii
                                                   WHERE ii.invoice_id = i.id AND ii.order_item_id = ANY (v_order_items))))
     ORDER BY i.id
     FOR UPDATE OF i
  LOOP
    IF v_invoice.status IN ('posted', 'overdue', 'paid') THEN
      RAISE EXCEPTION 'INVOICE_POSTED: void % and reissue it first', COALESCE(v_invoice.invoice_number, v_invoice.id::text);
    END IF;
    v_invoice_ids := v_invoice_ids || v_invoice.id;
  END LOOP;

  -- The event first, so the superseded picks can point at it; its after_rows carry the new picks' ids. Nothing
  -- else can read the unfinished state: the delivery row is locked until commit.
  v_before := public._delivery_brand_rows(p_delivery_id, v_line_ids);
  v_seq := public._delivery_brand_event(p_delivery_id, 'corrected', v_reason, v_invoice_ids, v_before, v_after,
    '{}'::jsonb);
  UPDATE public.delivery_item_brands
     SET superseded_at = now(), superseded_by = v_actor, supersede_reason = v_reason, superseded_by_event_seq = v_seq
   WHERE delivery_item_id = ANY (v_line_ids) AND superseded_at IS NULL;
  FOR v_step IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    PERFORM public._delivery_brand_insert((v_step ->> 'line_id')::uuid, p_delivery_id, (v_step ->> 'product_id')::uuid,
      v_step -> 'rows');
  END LOOP;

  v_result := jsonb_build_object('delivery_id', p_delivery_id, 'event_seq', v_seq, 'invoice_ids', to_jsonb(v_invoice_ids),
    'picks', public._delivery_brand_rows(p_delivery_id));
  PERFORM public.save_idempotency(p_idempotency_key, 'correct_delivery_brands',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 6. review_typed_brand: an admin links a typed pick to a listed brand, or dismisses it. Never changes the snapshot.
--    A second review of the same pick is refused (BRAND_REVIEW_NOT_PENDING).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.review_typed_brand(
  p_pick_id uuid, p_action text, p_brand_id uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_delivery_id uuid;
  v_pick public.delivery_item_brands;
  v_fp text;
  v_existing jsonb;
  v_reason text := NULLIF(btrim(regexp_replace(COALESCE(p_reason, ''), '[[:space:]]+', ' ', 'g')), '');
  v_seq bigint;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED: only an admin can review typed brands' USING ERRCODE = '42501';
  END IF;
  SELECT delivery_id INTO v_delivery_id FROM public.delivery_item_brands WHERE id = p_pick_id;
  IF v_delivery_id IS NULL THEN RAISE EXCEPTION 'BRAND_PICK_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM public.deliveries WHERE id = v_delivery_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BRAND_PICK_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v_fp := md5(jsonb_build_array(p_pick_id, p_action, p_brand_id, p_reason)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'review_typed_brand', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  -- Re-read under the delivery lock: a correction or edit may have replaced the pick meanwhile.
  SELECT * INTO v_pick FROM public.delivery_item_brands WHERE id = p_pick_id FOR UPDATE;
  IF v_pick.id IS NULL OR v_pick.source <> 'typed' OR v_pick.superseded_at IS NOT NULL
     OR v_pick.review_state IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'BRAND_REVIEW_NOT_PENDING: this brand is not waiting for review';
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'BRAND_REVIEW_REASON_TOO_LONG: keep the reason to 1,000 characters' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'link' THEN
    IF p_brand_id IS NULL OR NOT EXISTS (SELECT 1 FROM public._delivery_line_brand_list(v_pick.product_id) l
                                          WHERE l.brand_id = p_brand_id) THEN
      RAISE EXCEPTION 'BRAND_NOT_FOR_PRODUCT: that brand is not on this product''s brand list' USING ERRCODE = '22023';
    END IF;
    UPDATE public.delivery_item_brands
       SET review_state = 'added', review_brand_ref = p_brand_id, review_reason = v_reason,
           reviewed_by = v_actor, reviewed_at = now()
     WHERE id = p_pick_id;
  ELSIF p_action = 'dismiss' THEN
    UPDATE public.delivery_item_brands
       SET review_state = 'dismissed', review_reason = v_reason, reviewed_by = v_actor, reviewed_at = now()
     WHERE id = p_pick_id;
  ELSE
    RAISE EXCEPTION 'BRAND_REVIEW_ACTION_INVALID: use link or dismiss' USING ERRCODE = '22023';
  END IF;
  v_seq := public._delivery_brand_event(v_delivery_id, 'reviewed', v_reason, NULL, jsonb_build_array(to_jsonb(v_pick)),
    (SELECT jsonb_build_array(to_jsonb(b)) FROM public.delivery_item_brands b WHERE b.id = p_pick_id),
    jsonb_build_object('action', p_action, 'brand_id', p_brand_id));
  v_result := jsonb_build_object('pick_id', p_pick_id, 'delivery_id', v_delivery_id, 'event_seq', v_seq,
    'review_state', CASE WHEN p_action = 'link' THEN 'added' ELSE 'dismissed' END);
  PERFORM public.save_idempotency(p_idempotency_key, 'review_typed_brand',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 7. Reads. Each returns one statement's snapshot, so picks and event_seq always match.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.get_delivery_brands(p_delivery_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public._delivery_brand_may_read(p_delivery_id) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
  RETURN (
    SELECT jsonb_build_object('delivery_id', d.id, 'status', d.status,
      'event_seq', public._delivery_brand_max_seq(d.id),
      'lines', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'delivery_item_id', di.id, 'order_item_id', di.order_item_id, 'product_id', di.product_id,
          'product_name', p.product_name, 'quantity', di.quantity, 'quantity_delivered', di.quantity_delivered,
          'unit_size', di.unit_size,
          'brand_list', (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY NOT l.is_currently_sourced, lower(l.brand_name), l.brand_id), '[]'::jsonb)
                           FROM public._delivery_line_brand_list(di.product_id) l),
          'picks', public._delivery_brand_rows(d.id, ARRAY[di.id]))
          ORDER BY p.product_name, di.id)
          FROM public.delivery_items di LEFT JOIN public.products p ON p.id = di.product_id
         WHERE di.delivery_id = d.id), '[]'::jsonb))
      FROM public.deliveries d WHERE d.id = p_delivery_id);
END;
$function$;

CREATE FUNCTION public.get_typed_brands_for_review()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'pick_id', b.id, 'delivery_id', b.delivery_id, 'delivery_number', d.delivery_number, 'delivery_status', d.status,
      'delivery_item_id', b.delivery_item_id, 'product_id', b.product_id, 'product_name', p.product_name,
      'brand_name', b.brand_name, 'epa_registration', b.epa_registration, 'manufacturer', b.manufacturer,
      'quantity', b.quantity, 'review_note', b.review_note, 'entered_by', b.entered_by, 'entered_at', b.entered_at)
      ORDER BY b.entered_at, b.id)
      FROM public.delivery_item_brands b
      JOIN public.deliveries d ON d.id = b.delivery_id
      LEFT JOIN public.products p ON p.id = b.product_id
     WHERE b.review_state = 'pending' AND b.superseded_at IS NULL AND d.deleted_at IS NULL), '[]'::jsonb);
END;
$function$;

-- The office's follow-up list of delivery-side brand gaps on completed deliveries, by Chicago completion date. It
-- never blocks anything. A delivery completed before this apply is judged against today's brand list.
CREATE FUNCTION public.get_deliveries_missing_brands(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'DATE_RANGE_INVALID: give a from date on or before the to date' USING ERRCODE = '22023';
  END IF;
  RETURN COALESCE((
    WITH lines AS (
      SELECT d.id AS delivery_id, d.delivery_number, (d.completed_at AT TIME ZONE 'America/Chicago')::date AS delivered_on,
             di.id AS delivery_item_id, di.product_id, p.product_name,
             COALESCE(di.quantity_delivered, di.quantity) AS delivered,
             ev.details AS completed_details,
             -- Completed from a screen whose picks were out of date, and this line not corrected since.
             (ev.details ->> 'picks_confirmed' = 'false'
              AND NOT EXISTS (SELECT 1 FROM public.delivery_brand_events c
                               WHERE c.delivery_id = d.id AND c.event_type = 'corrected' AND c.seq > ev.seq
                                 AND (c.before_rows || c.after_rows) @> jsonb_build_array(jsonb_build_object('delivery_item_id', di.id))))
               AS unconfirmed,
             (SELECT (l.value ->> 'brand_list_size')::integer FROM jsonb_array_elements(ev.details -> 'lines') l
               WHERE l.value ->> 'delivery_item_id' = di.id::text) AS list_size_at_completion,
             (SELECT count(*) FROM public.delivery_item_brands b
               WHERE b.delivery_item_id = di.id AND b.superseded_at IS NULL) AS pick_count,
             (SELECT COALESCE(sum(b.quantity), 0) FROM public.delivery_item_brands b
               WHERE b.delivery_item_id = di.id AND b.superseded_at IS NULL) AS picked,
             EXISTS (SELECT 1 FROM public.delivery_item_brands b
                      WHERE b.delivery_item_id = di.id AND b.superseded_at IS NULL AND b.epa_registration IS NULL) AS any_no_epa,
             EXISTS (SELECT 1 FROM public.delivery_item_brands b
                      WHERE b.delivery_item_id = di.id AND b.superseded_at IS NULL AND b.source <> 'typed'
                        AND NOT EXISTS (SELECT 1 FROM public._delivery_line_brand_list(di.product_id) l
                                         WHERE l.brand_id = COALESCE(b.parent_brand_id, b.legacy_brand_id))) AS any_unlisted
        FROM public.deliveries d
        JOIN public.delivery_items di ON di.delivery_id = d.id
        LEFT JOIN public.products p ON p.id = di.product_id
        LEFT JOIN LATERAL (SELECT e.seq, e.details FROM public.delivery_brand_events e
                            WHERE e.delivery_id = d.id AND e.event_type = 'completed'
                            ORDER BY e.seq DESC LIMIT 1) ev ON true
       WHERE d.status = 'completed' AND d.deleted_at IS NULL
         AND (d.completed_at AT TIME ZONE 'America/Chicago')::date BETWEEN p_from AND p_to
         AND COALESCE(di.quantity_delivered, di.quantity) > 0
    ), flagged AS (
      SELECT l.*, array_remove(ARRAY[
          CASE WHEN l.completed_details IS NULL AND l.pick_count = 0
                    AND EXISTS (SELECT 1 FROM public._delivery_line_brand_list(l.product_id))
               THEN 'completed_before_brand_capture' END,
          CASE WHEN l.completed_details IS NOT NULL AND COALESCE(l.list_size_at_completion, 0) > 0 AND l.pick_count = 0
               THEN 'brand_not_recorded' END,
          CASE WHEN l.pick_count > 0 AND l.picked <> round(l.delivered, 4) THEN 'split_does_not_match_delivered' END,
          CASE WHEN l.any_no_epa THEN 'epa_number_not_recorded' END,
          CASE WHEN l.any_unlisted THEN 'brand_no_longer_listed' END,
          CASE WHEN l.pick_count > 0 AND l.unconfirmed THEN 'picks_not_confirmed' END], NULL) AS reasons
        FROM lines l
    )
    SELECT jsonb_agg(jsonb_build_object(
      'delivery_id', f.delivery_id, 'delivery_number', f.delivery_number, 'delivered_on', f.delivered_on,
      'delivery_item_id', f.delivery_item_id, 'product_id', f.product_id, 'product_name', f.product_name,
      'quantity_delivered', f.delivered, 'picked_quantity', f.picked, 'reasons', to_jsonb(f.reasons),
      'picks', public._delivery_brand_rows(f.delivery_id, ARRAY[f.delivery_item_id]))
      ORDER BY f.delivered_on, f.delivery_number, f.delivery_item_id)
      FROM flagged f WHERE cardinality(f.reasons) > 0), '[]'::jsonb);
END;
$function$;

DO $public_grants$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.set_delivery_brands(uuid,jsonb,bigint,text)', 'public.correct_delivery_brands(uuid,jsonb,text,bigint,text)',
    'public.review_typed_brand(uuid,text,uuid,text,text)', 'public.get_delivery_brands(uuid)',
    'public.get_typed_brands_for_review()', 'public.get_deliveries_missing_brands(date,date)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_sig);
  END LOOP;
END
$public_grants$;

-- ---------------------------------------------------------------------------------------------
-- 8. Completion: the stale-picks check and the completion rule around the unchanged body.
--    The 20260716191000 body, with three marked additions.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._complete_delivery_aggregate_impl(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_quantities jsonb DEFAULT NULL::jsonb,
  p_issue_type text DEFAULT NULL::text,
  p_issue_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_delivery record;
  v_base_seq text := NULLIF(current_setting('crx.brand_base_seq', true), '');  -- 20270104120000
  v_picks_confirmed boolean;  -- 20270104120000
  v_result jsonb;  -- 20270104120000
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT id, assigned_driver, status
    INTO v_delivery
    FROM public.deliveries
   WHERE id = p_delivery_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;

  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  -- 20270104120000 (Brand PR B): brands never refuse a completion (Mason 2026-11-09). A screen that sent the
  -- brand seq it loaded confirms the picks only if they have not changed since; otherwise the completion still
  -- goes through and the 'completed' event records picks_confirmed false, which puts its picked lines on the
  -- office list. A caller that sent no seq (the app before B-2) records NULL: not stated, not flagged.
  PERFORM set_config('crx.brand_base_seq', '', true);
  -- Only the wrappers set the value; anything that is not a plain number reads as not confirmed, never an error.
  v_picks_confirmed := CASE WHEN v_base_seq IS NULL THEN NULL
    WHEN v_base_seq ~ '^[0-9]{1,18}$' THEN v_base_seq::bigint = public._delivery_brand_max_seq(p_delivery_id)
    ELSE false END;

  v_result := public._complete_delivery_authorized_impl(
    p_delivery_id,
    p_signed_by,
    p_performed_by,
    p_quantities,
    p_issue_type,
    p_issue_notes,
    p_idempotency_key,
    p_completed_at
  );

  -- 20270104120000: the brand completion rule, once, for a delivery this call completed. Outside the body's Bill
  -- Split fallback, so an error here fails the completion instead of changing the billing.
  IF v_delivery.status = 'in_progress'
     AND (SELECT d.status FROM public.deliveries d WHERE d.id = p_delivery_id) = 'completed' THEN
    PERFORM public._delivery_brands_on_complete(p_delivery_id, v_picks_confirmed);
  END IF;
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 9. complete_delivery and start_and_complete_delivery gain p_brand_base_seq: the reviewed bodies are renamed
--    (unchanged) behind thin wrappers that keep the names, parameters, defaults and grants.
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean)
  RENAME TO _complete_delivery_evidence_impl_20270104;
REVOKE ALL ON FUNCTION public._complete_delivery_evidence_impl_20270104(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_quantities jsonb DEFAULT NULL::jsonb,
  p_issue_type text DEFAULT NULL::text,
  p_issue_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_evidence text DEFAULT NULL::text,
  p_evidence_ref text DEFAULT NULL::text,
  p_email_receipt boolean DEFAULT NULL::boolean,
  p_brand_base_seq bigint DEFAULT NULL::bigint  -- 20270104120000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  -- Read once by the completion step (fresh completions only); a replay never reaches it, so the seq is not part of
  -- the request fingerprint: the same key is the same completion. A nested call with NULL (start_and_complete's
  -- body calling this) leaves the outer value for that step; every return clears it.
  IF p_brand_base_seq IS NOT NULL THEN
    PERFORM set_config('crx.brand_base_seq', p_brand_base_seq::text, true);
  END IF;
  v_result := public._complete_delivery_evidence_impl_20270104(p_delivery_id, p_signed_by, p_performed_by,
    p_quantities, p_issue_type, p_issue_notes, p_idempotency_key, p_completed_at, p_evidence, p_evidence_ref,
    p_email_receipt);
  PERFORM set_config('crx.brand_base_seq', '', true);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean, bigint) TO authenticated, service_role;
COMMENT ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz, text, text, boolean, bigint) IS
  'Completes a delivery (body: _complete_delivery_evidence_impl_20270104). p_brand_base_seq (20270104120000, Brand PR B): when given and still current, the completion records the picks as confirmed; stale or NULL still completes against the current picks and records that they were not confirmed. Brands never refuse a completion.';

ALTER FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text)
  RENAME TO _start_and_complete_delivery_impl_20270104;
REVOKE ALL ON FUNCTION public._start_and_complete_delivery_impl_20270104(uuid, text, date, uuid, jsonb, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.start_and_complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_delivered_on date,
  p_performed_by uuid DEFAULT NULL,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_evidence text DEFAULT NULL,
  p_evidence_ref text DEFAULT NULL,
  p_brand_base_seq bigint DEFAULT NULL  -- 20270104120000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF p_brand_base_seq IS NOT NULL THEN
    PERFORM set_config('crx.brand_base_seq', p_brand_base_seq::text, true);
  END IF;
  v_result := public._start_and_complete_delivery_impl_20270104(p_delivery_id, p_signed_by, p_delivered_on,
    p_performed_by, p_quantities, p_issue_type, p_issue_notes, p_idempotency_key, p_evidence, p_evidence_ref);
  PERFORM set_config('crx.brand_base_seq', '', true);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text, bigint) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text, bigint) TO authenticated;
COMMENT ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text, text, text, bigint) IS
  'Starts and completes a delivery in one call (body: _start_and_complete_delivery_impl_20270104). p_brand_base_seq as on complete_delivery (20270104120000).';

-- ---------------------------------------------------------------------------------------------
-- 10. edit_delivery: the 20261110160000 wrapper, plus carrying picks across the body's delete-and-recreate.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.edit_delivery(
  p_delivery_id uuid,
  p_assigned_driver uuid DEFAULT NULL::uuid,
  p_scheduled_date date DEFAULT NULL::date,
  p_scheduled_time text DEFAULT NULL::text,
  p_delivery_window_start text DEFAULT NULL::text,
  p_delivery_window_end text DEFAULT NULL::text,
  p_delivery_address_id uuid DEFAULT NULL::uuid,
  p_delivery_notes text DEFAULT NULL::text,
  p_priority text DEFAULT NULL::text,
  p_items jsonb DEFAULT NULL::jsonb,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
  v_old_lines jsonb;   -- 20270104120000
  v_before jsonb;      -- 20270104120000
  v_old record;        -- 20270104120000
  v_new_id uuid;       -- 20270104120000
  v_kept jsonb := '[]'::jsonb;     -- 20270104120000
  v_dropped jsonb := '[]'::jsonb;  -- 20270104120000
  v_seq bigint;        -- 20270104120000
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: edit_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'delivery_id', p_delivery_id,
    'assigned_driver', p_assigned_driver, 'scheduled_date', p_scheduled_date,
    'scheduled_time', p_scheduled_time, 'delivery_window_start', p_delivery_window_start,
    'delivery_window_end', p_delivery_window_end, 'delivery_address_id', p_delivery_address_id,
    'delivery_notes', p_delivery_notes, 'priority', p_priority, 'items', p_items));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'edit_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  -- 20270104120000 (Brand PR B): lock the delivery, then copy its lines and picks before the body may delete them
  -- (the pick key cascades), so no save can slip between the copy and the delete.
  IF v_replay IS NULL THEN
    PERFORM 1 FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
    v_before := public._delivery_brand_rows(p_delivery_id);
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', di.id, 'order_item_id', di.order_item_id,
             'product_id', di.product_id, 'quantity', di.quantity, 'unit_size', di.unit_size,
             'picks', public._delivery_brand_rows(p_delivery_id, ARRAY[di.id])) ORDER BY di.id), '[]'::jsonb)
      INTO v_old_lines
      FROM public.delivery_items di WHERE di.delivery_id = p_delivery_id;
  END IF;
  PERFORM set_config('crx.delivery_brand_edit', 'on', true);  -- 20270104120000: this wrapper records the edit
  v_result := public._edit_delivery_replay_impl_20261015(
    p_delivery_id, p_assigned_driver, p_scheduled_date, p_scheduled_time, p_delivery_window_start,
    p_delivery_window_end, p_delivery_address_id, p_delivery_notes, p_priority, p_items,
    p_performed_by, p_idempotency_key);
  PERFORM set_config('crx.delivery_brand_edit', '', true);
  -- 20270104120000: a line whose order item, product, quantity and unit size are unchanged keeps its picks (with
  -- their entry and review history) under its new id, when exactly one old line and one new line share those four
  -- values; otherwise its picks are dropped and listed, never guessed. One 'edited' event either way.
  IF v_replay IS NULL AND (v_result ->> 'items_changed')::boolean IS TRUE THEN
    FOR v_old IN
      SELECT (o ->> 'id')::uuid AS id, (o ->> 'order_item_id')::uuid AS order_item_id,
             (o ->> 'product_id')::uuid AS product_id, (o ->> 'quantity')::numeric AS quantity,
             o ->> 'unit_size' AS unit_size, o -> 'picks' AS picks
        FROM jsonb_array_elements(v_old_lines) o
       WHERE jsonb_array_length(o -> 'picks') > 0
       ORDER BY (o ->> 'id')
    LOOP
      v_new_id := NULL;
      IF (SELECT count(*) FROM jsonb_array_elements(v_old_lines) x
           WHERE (x ->> 'order_item_id') IS NOT DISTINCT FROM v_old.order_item_id::text
             AND (x ->> 'product_id')::uuid = v_old.product_id AND (x ->> 'quantity')::numeric = v_old.quantity
             AND (x ->> 'unit_size') IS NOT DISTINCT FROM v_old.unit_size) = 1
         AND (SELECT count(*) FROM public.delivery_items di
               WHERE di.delivery_id = p_delivery_id AND di.order_item_id IS NOT DISTINCT FROM v_old.order_item_id
                 AND di.product_id = v_old.product_id AND di.quantity = v_old.quantity
                 AND di.unit_size IS NOT DISTINCT FROM v_old.unit_size) = 1 THEN
        v_new_id := (SELECT di.id FROM public.delivery_items di
                      WHERE di.delivery_id = p_delivery_id AND di.order_item_id IS NOT DISTINCT FROM v_old.order_item_id
                        AND di.product_id = v_old.product_id AND di.quantity = v_old.quantity
                        AND di.unit_size IS NOT DISTINCT FROM v_old.unit_size);
      END IF;
      IF v_new_id IS NULL THEN
        v_dropped := v_dropped || jsonb_build_array(jsonb_build_object('old_delivery_item_id', v_old.id,
          'order_item_id', v_old.order_item_id, 'product_id', v_old.product_id));
      ELSE
        INSERT INTO public.delivery_item_brands
          (delivery_item_id, delivery_id, product_id, source, parent_id, parent_brand_id, legacy_brand_id, brand_name,
           epa_registration, manufacturer, signal_word, quantity, review_state, review_note, review_brand_ref,
           review_reason, reviewed_by, reviewed_at, entered_by, entered_at)
        SELECT v_new_id, p_delivery_id, v_old.product_id, r ->> 'source', (r ->> 'parent_id')::uuid,
               (r ->> 'parent_brand_id')::uuid, (r ->> 'legacy_brand_id')::uuid, r ->> 'brand_name',
               r ->> 'epa_registration', r ->> 'manufacturer', r ->> 'signal_word', (r ->> 'quantity')::numeric,
               r ->> 'review_state', r ->> 'review_note', (r ->> 'review_brand_ref')::uuid, r ->> 'review_reason',
               (r ->> 'reviewed_by')::uuid, (r ->> 'reviewed_at')::timestamptz,
               (r ->> 'entered_by')::uuid, (r ->> 'entered_at')::timestamptz
          FROM jsonb_array_elements(v_old.picks) r;
        v_kept := v_kept || jsonb_build_array(jsonb_build_object('old_delivery_item_id', v_old.id,
          'delivery_item_id', v_new_id));
      END IF;
    END LOOP;
    v_seq := public._delivery_brand_event(p_delivery_id, 'edited', NULL, NULL, v_before,
      public._delivery_brand_rows(p_delivery_id), jsonb_build_object('kept', v_kept, 'dropped', v_dropped));
    v_result := v_result || jsonb_build_object('brand_picks_kept', v_kept, 'brand_lines_dropped', v_dropped,
      'brand_event_seq', v_seq);
    -- A replay returns the same answer: the body's receipt (written above, bound below) carries the brand fields.
    UPDATE public.idempotency_keys SET result = v_result
     WHERE idempotency_key = p_idempotency_key AND operation = 'edit_delivery'
       AND request_actor_id IS NULL AND request_fingerprint IS NULL;
  END IF;
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'edit_delivery', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 11. Postflight.
-- ---------------------------------------------------------------------------------------------
DO $postflight$
DECLARE
  v_bad text;
BEGIN
  -- One signature each for the two completion entry points.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'complete_delivery') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'start_and_complete_delivery') <> 1
     OR to_regprocedure('public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean,bigint)') IS NULL
     OR to_regprocedure('public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text,bigint)') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_BRANDS: completion entry points are not one signature each';
  END IF;
  -- The renamed bodies are unchanged.
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._complete_delivery_evidence_impl_20270104(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean)'::regprocedure)
       IS DISTINCT FROM 'eed8da07fedbec14a198ca4f6e26c213'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._start_and_complete_delivery_impl_20270104(uuid,text,date,uuid,jsonb,text,text,text,text,text)'::regprocedure)
       IS DISTINCT FROM '640603e6dce34abc1fe18d4dad6adc56' THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_BRANDS: a renamed body changed';
  END IF;
  -- No app role can execute an internal function this file made or renamed.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('_delivery_line_brand_list', '_delivery_brand_max_seq', '_delivery_brand_rows',
                       '_delivery_brand_event', '_delivery_brand_resolve_picks', '_delivery_brand_insert',
                       '_delivery_brands_on_complete', '_delivery_brand_may_read', '_delivery_brand_events_append_only',
                       '_delivery_brands_on_line_delete',
                       '_complete_delivery_evidence_impl_20270104', '_start_and_complete_delivery_impl_20270104',
                       '_complete_delivery_aggregate_impl')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
          OR has_function_privilege('service_role', p.oid, 'EXECUTE')
          OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'));
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_BRANDS: app roles can execute %', v_bad; END IF;
  -- Every SECURITY DEFINER function this file made or re-issued pins its search_path.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
     AND (p.proname LIKE '\_delivery\_brand%' OR p.proname LIKE '\_delivery\_line\_brand%'
          OR p.proname IN ('set_delivery_brands', 'correct_delivery_brands', 'review_typed_brand', 'get_delivery_brands',
                           'get_typed_brands_for_review', 'get_deliveries_missing_brands', 'complete_delivery',
                           'start_and_complete_delivery', 'edit_delivery', '_complete_delivery_aggregate_impl'))
     AND NOT (COALESCE(p.proconfig, '{}') @> ARRAY['search_path=public, pg_temp']);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_BRANDS: search_path not pinned on %', v_bad; END IF;
  -- App roles only read the new tables (effective privileges, including through PUBLIC).
  IF has_table_privilege('anon', 'public.delivery_item_brands', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('anon', 'public.delivery_brand_events', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.delivery_item_brands', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.delivery_brand_events', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role', 'public.delivery_item_brands', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role', 'public.delivery_brand_events', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('metabase_ro', 'public.delivery_item_brands', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('metabase_ro', 'public.delivery_brand_events', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_sequence_privilege('authenticated', pg_get_serial_sequence('public.delivery_brand_events', 'seq'), 'USAGE,SELECT,UPDATE')
     OR has_sequence_privilege('metabase_ro', pg_get_serial_sequence('public.delivery_brand_events', 'seq'), 'USAGE,SELECT,UPDATE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_BRANDS: an app role can write a brand table';
  END IF;
END
$postflight$;
