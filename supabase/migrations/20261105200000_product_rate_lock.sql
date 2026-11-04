-- WP-PM-11a-1: one rate writer, a "Lock rates" switch, and a locked-state correction.
--
-- Live rates are products.rate_per_acre, rate_unit and suggested_rate. A rate write reprices what
-- customers see: trigger_recalc_product_price_per_acre recalculates tier1/2/3_price_per_acre (legacy
-- dollar numeric, rounded half away from zero to the cent by product_price_per_acre) and quotes and
-- invoice PDFs read those columns. max_label_rate and its unit are label facts and stay editable.
--
-- New:
--   * product_rate_lock: one row saying whether live rates are locked, who switched it, when, why.
--     It starts unlocked, so nothing changes for any screen until an admin turns it on.
--   * product_rate_events: append-only log of every lock switch and every correction, with reason.
--   * A guard on products, last of the BEFORE triggers, that refuses any change to the three rate
--     columns while locked, whatever wrote it: a browser update or insert, a price workbook apply, an
--     import, any SECURITY DEFINER function. It takes the lock row FOR SHARE, so a switch and a rate
--     write take turns and an upload that started before a switch cannot save after it.
--   * set_product_rates(rows): the bulk rate writer the CSV import (WP-PM-10) and the setup workbook
--     (WP-PM-11a-2) will call (admin, retry key, all-or-nothing). Each row carries the rate values it
--     expects to replace; a row changed since is refused by product name. The product page still
--     writes rates directly while unlocked; the guard below covers it when locked.
--   * set_product_rate_lock(locked, reason): any admin, with a reason, logged.
--   * correct_product_rates(product, ..., expected pricing_version, reason): one product at a time,
--     admin, reason, retry key; the only write the guard lets through while locked. It is recognised
--     by a transaction-local setting only this function sets, holding the product id and the
--     transaction id, never by anything a client sends.
--   * Both writers refuse a changed rate unit that unit_conversions does not know for the product's
--     form (the price workbook's rule), since an unknown unit prices per acre as one ounce.
--   * The price workbook can no longer change rates: a rate change in its change rows is refused.
--   * tier1/2/3_price_per_acre get whole-cent CHECKs (live has none off the cent, read 2026-11-03).
-- Rate changes these functions make are logged in cost_history as product-page edits (the history
-- trigger's non-governed branch); the reason lives in product_rate_events.
-- No existing row is changed. Grants: SELECT on the two new tables and EXECUTE on the three public
-- functions to authenticated; every function body refuses non-admins.

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF to_regclass('public.product_rate_lock') IS NOT NULL
     OR to_regclass('public.product_rate_events') IS NOT NULL
     OR to_regprocedure('public.guard_product_rate_lock()') IS NOT NULL
     OR to_regprocedure('public.set_product_rates(jsonb,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_RATE_LOCK_ALREADY_EXISTS';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_active_profile()') IS NULL
     OR to_regprocedure('public.check_idempotency(text,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regclass('public.product_info_change_set_rows') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
                    AND tgname = 'trigger_recalc_product_price_per_acre') THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_RATE_LOCK_DEPENDENCY_MISSING';
  END IF;
END;
$preflight$;

CREATE TABLE public.product_rate_lock (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  is_locked boolean NOT NULL DEFAULT false,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text
);
ALTER TABLE public.product_rate_lock OWNER TO postgres;
INSERT INTO public.product_rate_lock (id, is_locked) VALUES (true, false);
COMMENT ON TABLE public.product_rate_lock IS
  'One row: whether live product rates are locked. Written only by set_product_rate_lock.';
ALTER TABLE public.product_rate_lock ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_rate_lock_select ON public.product_rate_lock
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
REVOKE ALL ON TABLE public.product_rate_lock FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_rate_lock TO authenticated;

CREATE TABLE public.product_rate_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('locked', 'unlocked', 'corrected')),
  product_id uuid REFERENCES public.products(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  before_values jsonb,
  after_values jsonb,
  changed_by uuid NOT NULL,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((event_type = 'corrected') = (product_id IS NOT NULL))
);
ALTER TABLE public.product_rate_events OWNER TO postgres;
CREATE INDEX product_rate_events_recent_idx ON public.product_rate_events(changed_at DESC, id DESC);
CREATE INDEX product_rate_events_product_idx ON public.product_rate_events(product_id, changed_at DESC)
  WHERE product_id IS NOT NULL;
COMMENT ON TABLE public.product_rate_events IS
  'Append-only log of rate lock switches and locked-state rate corrections, each with its reason.';
ALTER TABLE public.product_rate_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_rate_events_select ON public.product_rate_events
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
REVOKE ALL ON TABLE public.product_rate_events FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_rate_events TO authenticated;

CREATE FUNCTION public.refuse_product_rate_record_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'PRODUCT_RATE_RECORDS_CHANGE_ONLY_THROUGH_THEIR_FUNCTIONS';
END;
$function$;
ALTER FUNCTION public.refuse_product_rate_record_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_product_rate_record_mutation() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER product_rate_events_append_only
  BEFORE UPDATE OR DELETE ON public.product_rate_events
  FOR EACH ROW EXECUTE FUNCTION public.refuse_product_rate_record_mutation();
CREATE TRIGGER product_rate_events_no_truncate
  BEFORE TRUNCATE ON public.product_rate_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_product_rate_record_mutation();
CREATE TRIGGER product_rate_lock_keep_row
  BEFORE DELETE ON public.product_rate_lock
  FOR EACH ROW EXECUTE FUNCTION public.refuse_product_rate_record_mutation();
CREATE TRIGGER product_rate_lock_no_truncate
  BEFORE TRUNCATE ON public.product_rate_lock
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_product_rate_record_mutation();

-- The guard. SECURITY DEFINER so a browser writer can take the lock row FOR SHARE.
-- Blank and spaces are the same suggested rate (the price workbook saves trimmed text). rate_unit is
-- compared untrimmed, because product_price_per_acre reads it untrimmed. On INSERT of a seed or each
-- product validate_product_units copies the stock unit into rate_unit, so that copy is not a rate; on
-- UPDATE it is compared like any other unit, so a form or stock-unit change cannot move a locked rate.
CREATE FUNCTION public.guard_product_rate_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_locked boolean;
  v_new_unit text := NULLIF(NEW.rate_unit, '');
  v_derived boolean := TG_OP = 'INSERT' AND COALESCE(NEW.product_form IN ('seed', 'each'), false)
                       AND NEW.rate_unit IS NOT DISTINCT FROM NEW.inventory_unit;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.rate_per_acre IS NOT DISTINCT FROM NEW.rate_per_acre
     AND NULLIF(OLD.rate_unit, '') IS NOT DISTINCT FROM v_new_unit
     AND NULLIF(btrim(OLD.suggested_rate), '') IS NOT DISTINCT FROM NULLIF(btrim(NEW.suggested_rate), '') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.rate_per_acre IS NULL
     AND (v_derived OR v_new_unit IS NULL)
     AND NULLIF(btrim(NEW.suggested_rate), '') IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT is_locked INTO v_locked FROM public.product_rate_lock WHERE id FOR SHARE;
  IF COALESCE(v_locked, true)  -- a missing lock row counts as locked
     AND current_setting('crx.product_rate_correction', true)
         IS DISTINCT FROM NEW.id::text || ':' || txid_current()::text THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'PRODUCT_RATES_LOCKED: rates are locked; save the new product without rates, then an admin can correct its rates from its product page, with a reason'
        USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'PRODUCT_RATES_LOCKED: rates are locked; an admin can correct one product''s rates from its product page, with a reason'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_product_rate_lock() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_product_rate_lock() FROM PUBLIC, anon, authenticated, service_role;
-- Named to run after every other BEFORE trigger on products, so it sees the final row.
CREATE TRIGGER trigger_zzz_guard_product_rate_lock
  BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_rate_lock();

ALTER TABLE public.products
  ADD CONSTRAINT products_tier1_price_per_acre_whole_cents_chk CHECK (tier1_price_per_acre >= 0 AND tier1_price_per_acre < 'Infinity'::numeric AND tier1_price_per_acre = round(tier1_price_per_acre, 2)),
  ADD CONSTRAINT products_tier2_price_per_acre_whole_cents_chk CHECK (tier2_price_per_acre >= 0 AND tier2_price_per_acre < 'Infinity'::numeric AND tier2_price_per_acre = round(tier2_price_per_acre, 2)),
  ADD CONSTRAINT products_tier3_price_per_acre_whole_cents_chk CHECK (tier3_price_per_acre >= 0 AND tier3_price_per_acre < 'Infinity'::numeric AND tier3_price_per_acre = round(tier3_price_per_acre, 2));

-- Rates are read-only in the price workbook: its preview refuses a row that would change one.
CREATE FUNCTION public.refuse_price_workbook_rate_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  IF NEW.changes ?| ARRAY['rate_per_acre', 'rate_unit', 'suggested_rate'] THEN
    RAISE EXCEPTION 'PRODUCT_RATES_READ_ONLY_IN_PRICE_WORKBOOK: rates are read-only in the price workbook; change them on the product page'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.refuse_price_workbook_rate_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_price_workbook_rate_change() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER product_info_change_set_rows_rates_read_only
  BEFORE INSERT OR UPDATE ON public.product_info_change_set_rows
  FOR EACH ROW EXECUTE FUNCTION public.refuse_price_workbook_rate_change();

-- The shared write for one product (its row already locked by the caller). Returns the rate and
-- tier 1-3 per-acre values before and after.
CREATE FUNCTION public._write_product_rates(
  p_product_id uuid, p_rate_per_acre numeric, p_rate_unit text, p_suggested_rate text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  SELECT jsonb_build_object('rate_per_acre', rate_per_acre, 'rate_unit', rate_unit,
           'suggested_rate', suggested_rate, 'tier1_price_per_acre', tier1_price_per_acre,
           'tier2_price_per_acre', tier2_price_per_acre, 'tier3_price_per_acre', tier3_price_per_acre)
    INTO v_before FROM public.products WHERE id = p_product_id;
  UPDATE public.products
     SET rate_per_acre = p_rate_per_acre, rate_unit = p_rate_unit, suggested_rate = p_suggested_rate,
         updated_at = now()
   WHERE id = p_product_id
  RETURNING jsonb_build_object('rate_per_acre', rate_per_acre, 'rate_unit', rate_unit,
           'suggested_rate', suggested_rate, 'tier1_price_per_acre', tier1_price_per_acre,
           'tier2_price_per_acre', tier2_price_per_acre, 'tier3_price_per_acre', tier3_price_per_acre)
    INTO v_after;
  RETURN jsonb_build_object('before', v_before, 'after', v_after);
END;
$function$;
ALTER FUNCTION public._write_product_rates(uuid, numeric, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._write_product_rates(uuid, numeric, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Whether a JSON rate value is valid: NULL/blank, or a non-negative plain decimal (text or number)
-- with at most 12 whole digits and 6 decimals. Returns false instead of raising, so a 2000-row
-- upload is checked without a subtransaction per row.
CREATE FUNCTION public._product_rate_value_ok(p_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT p_value IS NULL OR jsonb_typeof(p_value) = 'null'
      OR (jsonb_typeof(p_value) IN ('number', 'string')
          AND btrim(p_value #>> '{}') ~ '^([0-9]{1,12}(\.[0-9]{1,6})?)?$');
$function$;
ALTER FUNCTION public._product_rate_value_ok(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_rate_value_ok(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- A rate value from a JSON row, once _product_rate_value_ok has accepted it.
CREATE FUNCTION public._product_rate_value(p_value jsonb) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
BEGIN
  IF NOT public._product_rate_value_ok(p_value) THEN RAISE EXCEPTION 'PRODUCT_RATE_INVALID'; END IF;
  RETURN NULLIF(btrim(p_value #>> '{}'), '')::numeric;
END;
$function$;
ALTER FUNCTION public._product_rate_value(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_rate_value(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- The price workbook's unit rule (20260722091359): an unchanged legacy unit is kept; a new one must be
-- a unit_conversions key for the product's form (or type both). A rate needs a unit, except on seed and
-- each products, where validate_product_units fills it from the stock unit.
CREATE FUNCTION public._product_rate_unit_ok(p_rate numeric, p_new_unit text, p_old_unit text, p_form text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $function$
  SELECT CASE WHEN p_new_unit IS NULL THEN p_rate IS NULL OR COALESCE(p_form IN ('seed', 'each'), false)
    ELSE p_new_unit IS NOT DISTINCT FROM NULLIF(btrim(p_old_unit), '')
      OR EXISTS (SELECT 1 FROM public.unit_conversions uc
                  WHERE lower(uc.unit) = lower(p_new_unit)
                    AND (p_form IS NULL OR uc.unit_type = p_form OR uc.unit_type = 'both'))
  END;
$function$;
ALTER FUNCTION public._product_rate_unit_ok(numeric, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_rate_unit_ok(numeric, text, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.set_product_rates(
  p_rows jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_row jsonb;
  v_product public.products%ROWTYPE;
  v_rate numeric;
  v_unit text;
  v_suggested text;
  v_stale text[] := ARRAY[]::text[];
  v_invalid text[] := ARRAY[]::text[];
  v_bad_unit text[] := ARRAY[]::text[];
  v_results jsonb := '[]'::jsonb;
  v_write jsonb;
  v_changed integer := 0;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0
     OR jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'PRODUCT_RATE_ROWS_REQUIRED: send 1 to 2000 rows';
  END IF;

  v_request_fp := md5(jsonb_build_object('actor_id', v_actor, 'rows', p_rows)::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'set_product_rates');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) r
    WHERE jsonb_typeof(r) <> 'object'
       OR NOT (r ? 'product_id' AND r ? 'rate_per_acre' AND r ? 'rate_unit' AND r ? 'suggested_rate'
               AND r ? 'expected')
       OR jsonb_typeof(r->'expected') <> 'object'
       OR NOT (r->'expected' ? 'rate_per_acre' AND r->'expected' ? 'rate_unit'
               AND r->'expected' ? 'suggested_rate')
       OR (r->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR jsonb_typeof(r->'rate_unit') NOT IN ('string', 'null')
       OR jsonb_typeof(r->'suggested_rate') NOT IN ('string', 'null')
       OR jsonb_typeof(r->'expected'->'rate_unit') NOT IN ('string', 'null')
       OR jsonb_typeof(r->'expected'->'suggested_rate') NOT IN ('string', 'null')
       OR length(r->>'rate_unit') > 40 OR length(r->>'suggested_rate') > 200
  ) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_ROW_SHAPE_INVALID: each row needs product_id, rate_per_acre, rate_unit, suggested_rate and expected';
  END IF;
  IF (SELECT count(DISTINCT lower(r->>'product_id')) FROM jsonb_array_elements(p_rows) r)
     <> jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_DUPLICATE_PRODUCT: each product may appear once';
  END IF;

  -- Takes turns with set_product_rate_lock: a switch made first is seen here; one made later waits.
  IF COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id FOR SHARE), true) THEN
    RAISE EXCEPTION 'PRODUCT_RATES_LOCKED: rates are locked; an admin can correct one product''s rates from its product page, with a reason'
      USING ERRCODE = 'check_violation';
  END IF;

  IF (SELECT count(*) FROM public.products p
      WHERE p.id IN (SELECT (r->>'product_id')::uuid FROM jsonb_array_elements(p_rows) r))
     <> jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;
  PERFORM 1 FROM public.products p
   WHERE p.id IN (SELECT (r->>'product_id')::uuid FROM jsonb_array_elements(p_rows) r)
   ORDER BY p.id FOR UPDATE;

  FOR v_row IN SELECT r FROM jsonb_array_elements(p_rows) r LOOP
    SELECT * INTO v_product FROM public.products WHERE id = (v_row->>'product_id')::uuid;
    IF NOT public._product_rate_value_ok(v_row->'expected'->'rate_per_acre') THEN
      RAISE EXCEPTION 'PRODUCT_RATE_ROW_SHAPE_INVALID: the expected rate per acre for % is not a number', v_product.product_name;
    END IF;
    IF NOT public._product_rate_value_ok(v_row->'rate_per_acre') THEN
      v_invalid := v_invalid || v_product.product_name;
    ELSIF NOT public._product_rate_unit_ok(public._product_rate_value(v_row->'rate_per_acre'),
                                            NULLIF(btrim(v_row->>'rate_unit'), ''), v_product.rate_unit, v_product.product_form) THEN
      v_bad_unit := v_bad_unit || v_product.product_name;
    ELSIF public._product_rate_value(v_row->'expected'->'rate_per_acre') IS DISTINCT FROM v_product.rate_per_acre
       OR NULLIF(btrim(v_row->'expected'->>'rate_unit'), '') IS DISTINCT FROM NULLIF(btrim(v_product.rate_unit), '')
       OR NULLIF(btrim(v_row->'expected'->>'suggested_rate'), '') IS DISTINCT FROM NULLIF(btrim(v_product.suggested_rate), '') THEN
      v_stale := v_stale || v_product.product_name;
    END IF;
  END LOOP;
  IF cardinality(v_invalid) > 0 THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: a rate per acre must be blank or a number of 0 or more with at most 6 decimals: %',
      array_to_string(v_invalid[1:20], ', ');
  END IF;
  IF cardinality(v_bad_unit) > 0 THEN
    RAISE EXCEPTION 'PRODUCT_RATE_UNIT_INVALID: the rate unit is missing or not a known unit for the product''s form: %',
      array_to_string(v_bad_unit[1:20], ', ');
  END IF;
  IF cardinality(v_stale) > 0 THEN
    RAISE EXCEPTION 'PRODUCT_RATES_STALE: changed by someone else since you downloaded them; download again: %',
      array_to_string(v_stale[1:20], ', ');
  END IF;

  FOR v_row IN SELECT r FROM jsonb_array_elements(p_rows) r LOOP
    SELECT * INTO v_product FROM public.products WHERE id = (v_row->>'product_id')::uuid;
    v_rate := public._product_rate_value(v_row->'rate_per_acre');
    v_unit := NULLIF(btrim(v_row->>'rate_unit'), '');
    v_suggested := NULLIF(btrim(v_row->>'suggested_rate'), '');
    IF v_rate IS DISTINCT FROM v_product.rate_per_acre
       OR v_unit IS DISTINCT FROM NULLIF(btrim(v_product.rate_unit), '')
       OR v_suggested IS DISTINCT FROM NULLIF(btrim(v_product.suggested_rate), '') THEN
      v_write := public._write_product_rates(v_product.id, v_rate, v_unit, v_suggested);
      v_changed := v_changed + 1;
      v_results := v_results || (jsonb_build_object('product_id', v_product.id,
        'product_name', v_product.product_name, 'changed', true) || v_write);
    ELSE
      v_results := v_results || (jsonb_build_object('product_id', v_product.id,
        'product_name', v_product.product_name, 'changed', false));
    END IF;
  END LOOP;

  v_result := jsonb_build_object('changed_count', v_changed, 'rows', v_results);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_product_rates',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_request_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.set_product_rates(jsonb, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_product_rates(jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_product_rates(jsonb, uuid, text) TO authenticated;

CREATE FUNCTION public.set_product_rate_lock(
  p_locked boolean,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_name text;
  v_lock public.product_rate_lock%ROWTYPE;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_locked IS NULL THEN RAISE EXCEPTION 'PRODUCT_RATE_LOCK_STATE_REQUIRED'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED: say why'; END IF;
  IF length(btrim(p_reason)) > 500 THEN RAISE EXCEPTION 'REASON_TOO_LONG: keep the reason to 500 characters'; END IF;

  v_request_fp := md5(jsonb_build_object('actor_id', v_actor, 'locked', p_locked, 'reason', btrim(p_reason))::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'set_product_rate_lock');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  SELECT * INTO v_lock FROM public.product_rate_lock WHERE id FOR UPDATE;
  IF v_lock.is_locked = p_locked THEN
    RAISE EXCEPTION 'PRODUCT_RATE_LOCK_UNCHANGED: rates are already %',
      CASE WHEN p_locked THEN 'locked' ELSE 'unlocked' END;
  END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_actor;
  UPDATE public.product_rate_lock
     SET is_locked = p_locked, changed_by = v_actor, changed_by_name = v_name,
         changed_at = now(), reason = btrim(p_reason)
   WHERE id
  RETURNING * INTO v_lock;
  INSERT INTO public.product_rate_events (event_type, reason, changed_by, changed_by_name)
  VALUES (CASE WHEN p_locked THEN 'locked' ELSE 'unlocked' END, btrim(p_reason), v_actor, v_name);

  v_result := jsonb_build_object('is_locked', v_lock.is_locked, 'changed_by_name', v_lock.changed_by_name,
    'changed_at', v_lock.changed_at, 'reason', v_lock.reason);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_product_rate_lock',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_request_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.set_product_rate_lock(boolean, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_product_rate_lock(boolean, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_product_rate_lock(boolean, text, uuid, text) TO authenticated;

CREATE FUNCTION public.correct_product_rates(
  p_product_id uuid,
  p_rate_per_acre numeric,
  p_rate_unit text,
  p_suggested_rate text,
  p_expected_pricing_version bigint,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_name text;
  v_product public.products%ROWTYPE;
  v_unit text := NULLIF(btrim(p_rate_unit), '');
  v_suggested text := NULLIF(btrim(p_suggested_rate), '');
  v_write jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_product_id IS NULL OR p_expected_pricing_version IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_AND_EXPECTED_VERSION_REQUIRED';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED: say why'; END IF;
  IF length(btrim(p_reason)) > 500 THEN RAISE EXCEPTION 'REASON_TOO_LONG: keep the reason to 500 characters'; END IF;
  IF NOT public._product_rate_value_ok(to_jsonb(p_rate_per_acre::text)) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: a rate per acre must be blank or a number of 0 or more with at most 6 decimals';
  END IF;
  IF length(v_unit) > 40 OR length(v_suggested) > 200 THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: the rate unit or suggested rate is too long';
  END IF;

  v_request_fp := md5(jsonb_build_object('actor_id', v_actor, 'product_id', p_product_id,
    'rate_per_acre', p_rate_per_acre, 'rate_unit', v_unit, 'suggested_rate', v_suggested,
    'expected_pricing_version', p_expected_pricing_version, 'reason', btrim(p_reason))::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'correct_product_rates');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  IF NOT COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id FOR SHARE), true) THEN
    RAISE EXCEPTION 'PRODUCT_RATES_NOT_LOCKED: rates are open; change them on the product page'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_product FROM public.products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND'; END IF;
  IF v_product.pricing_version IS DISTINCT FROM p_expected_pricing_version THEN
    RAISE EXCEPTION 'PRODUCT_RATES_STALE: % changed since you opened it; reload and try again', v_product.product_name;
  END IF;
  IF p_rate_per_acre IS NOT DISTINCT FROM v_product.rate_per_acre
     AND v_unit IS NOT DISTINCT FROM NULLIF(btrim(v_product.rate_unit), '')
     AND v_suggested IS NOT DISTINCT FROM NULLIF(btrim(v_product.suggested_rate), '') THEN
    RAISE EXCEPTION 'PRODUCT_RATE_CORRECTION_NO_CHANGE: the new rates match the current ones';
  END IF;
  IF NOT public._product_rate_unit_ok(p_rate_per_acre, v_unit, v_product.rate_unit, v_product.product_form) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_UNIT_INVALID: the rate unit is missing or not a known unit for this product''s form';
  END IF;

  PERFORM set_config('crx.product_rate_correction', p_product_id::text || ':' || txid_current()::text, true);
  v_write := public._write_product_rates(p_product_id, p_rate_per_acre, v_unit, v_suggested);
  PERFORM set_config('crx.product_rate_correction', '', true);

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_actor;
  INSERT INTO public.product_rate_events
    (event_type, product_id, reason, before_values, after_values, changed_by, changed_by_name)
  VALUES ('corrected', p_product_id, btrim(p_reason), v_write->'before', v_write->'after', v_actor, v_name);

  v_result := jsonb_build_object('product_id', p_product_id, 'product_name', v_product.product_name,
    'pricing_version', (SELECT pricing_version FROM public.products WHERE id = p_product_id)) || v_write;
  PERFORM public.save_idempotency(p_idempotency_key, 'correct_product_rates',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_request_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.correct_product_rates(uuid, numeric, text, text, bigint, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.correct_product_rates(uuid, numeric, text, text, bigint, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.correct_product_rates(uuid, numeric, text, text, bigint, text, uuid, text)
  TO authenticated;

-- Read-only: the tier 1-3 per-acre prices a correction would save, shown before the admin confirms it.
-- Worked out as recalc_product_price_per_acre does; the proof checks the preview equals the saved result.
CREATE FUNCTION public.preview_product_rate_correction(
  p_product_id uuid, p_rate_per_acre numeric, p_rate_unit text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_product public.products%ROWTYPE;
  v_unit text := NULLIF(btrim(p_rate_unit), '');
  v_t1 numeric;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF NOT public._product_rate_value_ok(to_jsonb(p_rate_per_acre::text)) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: a rate per acre must be blank or a number of 0 or more with at most 6 decimals';
  END IF;
  SELECT * INTO v_product FROM public.products WHERE id = p_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND'; END IF;
  IF length(v_unit) > 40
     OR NOT public._product_rate_unit_ok(p_rate_per_acre, v_unit, v_product.rate_unit, v_product.product_form) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_UNIT_INVALID: the rate unit is missing or not a known unit for this product''s form';
  END IF;
  -- validate_product_units stores a seed or each product's stock unit as its rate unit.
  IF v_product.product_form IN ('seed', 'each') THEN v_unit := v_product.inventory_unit; END IF;
  v_t1 := COALESCE(v_product.tier1_price, 0);
  RETURN jsonb_build_object(
    'before', jsonb_build_object('tier1_price_per_acre', v_product.tier1_price_per_acre,
      'tier2_price_per_acre', v_product.tier2_price_per_acre, 'tier3_price_per_acre', v_product.tier3_price_per_acre),
    'after', jsonb_build_object(
      'tier1_price_per_acre', public.product_price_per_acre(v_t1, p_rate_per_acre, v_unit,
        v_product.inventory_unit, v_product.unit_size),
      'tier2_price_per_acre', public.product_price_per_acre(COALESCE(NULLIF(v_product.tier2_price, 0), v_t1),
        p_rate_per_acre, v_unit, v_product.inventory_unit, v_product.unit_size),
      'tier3_price_per_acre', public.product_price_per_acre(COALESCE(NULLIF(v_product.tier3_price, 0), v_t1),
        p_rate_per_acre, v_unit, v_product.inventory_unit, v_product.unit_size)));
END;
$function$;
ALTER FUNCTION public.preview_product_rate_correction(uuid, numeric, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_product_rate_correction(uuid, numeric, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_product_rate_correction(uuid, numeric, text) TO authenticated;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM public.product_rate_lock) <> 1
     OR (SELECT is_locked FROM public.product_rate_lock) THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_RATE_LOCK_NOT_UNLOCKED_SINGLE_ROW';
  END IF;
  IF has_function_privilege('anon', 'public.set_product_rates(jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.correct_product_rates(uuid,numeric,text,text,bigint,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_product_rate_lock(boolean,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.preview_product_rate_correction(uuid,numeric,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._write_product_rates(uuid,numeric,text,text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.product_rate_lock', 'UPDATE')
     OR has_function_privilege('anon', 'public._write_product_rates(uuid,numeric,text,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._write_product_rates(uuid,numeric,text,text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.product_rate_events', 'INSERT')
     OR has_table_privilege('metabase_ro', 'public.product_rate_lock', 'SELECT')
     OR has_table_privilege('metabase_ro', 'public.product_rate_events', 'SELECT') THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_RATE_LOCK_GRANTS_WRONG';
  END IF;
END;
$postflight$;
