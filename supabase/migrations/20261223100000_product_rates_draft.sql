-- idempotency-body-check: exempt
-- (Every writer checks its retry key through _product_parent_replay, which calls check_idempotency,
--  and saves its receipt with save_idempotency last, in the same transaction.)
-- actor-binding-check: exempt
-- (p_actor on _product_rate_note, _product_rate_insert_derived and _product_rate_derive_parent is not
--  caller-supplied: these helpers have no EXECUTE grant to any role, and their only callers are the RPCs
--  below, which pass v_actor from _product_parent_require_admin(), i.e. auth.uid() of a checked admin.)
--
-- Written 2026-11-09. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261223100000_product_rates_draft.md.
--
-- WHY (Product Master Stage 4, RT-1; build sheet docs/plans/2026-11-08-product-RT1-BUILD-SHEET.md):
--   house and label rates move from one number per size to low / recommended / high rows per parent.
--   RT-1 is the safe first step: it builds the new rate table and its rules, holding UNAPPROVED DRAFTS
--   that nothing in the app reads. Drafts become live only in RT-4, after Mason's review (RT-3).
--
-- HOW:
--   * product_rate_units: nine fixed units, each with one kind (volume / weight / each) and one exact
--     factor (fluid ounces; milligrams for weight; 1 for each). The postflight proves every factor equals
--     today's unit_conversions factor, so a unit can never silently mean "1 oz".
--   * product_rates: one row per parent, source (label / house_standard) and basis, with low /
--     recommended / high, the unit, a quoting-default flag (per acre only, one per parent) and draft status.
--     Its rules are CHECKs, a unique key, a partial unique index and two row triggers.
--   * product_rate_draft_events: append-only history of every draft save, delete and derivation note.
--   * save_draft_product_rate, delete_draft_product_rate, derive_draft_product_rates (copies today's
--     parent rates into drafts; reports what it could not read) and get_parent_draft_rates (read).
--     Admin only; the idempotency key is required and bound to the caller and request.
--   * _product_rate_label_check: compares a house rate with every linked EPA registration's label maximum
--     (same basis and kind only, exact numeric, never converted between bases). Above a maximum needs a
--     reason to save; it warns, never blocks.
--
-- LOCKS (sheet 3.6): REG-1's advisory pair SHARED (save, derive, and each label check a read runs), then the
--   parent FOR NO KEY UPDATE (still waits for PAR-1's FOR UPDATE and parent UPDATEs), then
--   member sizes FOR SHARE in ID order (derive only), then the parent's product_rates rows FOR UPDATE.
--   Drafts never read or take product_rate_lock and never bump product_parents.parent_version.
--
-- REG-1 STEP 2: _epa_registrations_seeded() may not exist yet (PR #1688). The label check looks it up
--   with to_regprocedure on every call: missing or false reads "registrations_not_seeded".
--
-- NOT CHANGED: no products / product_parents column, trigger or function; unit_conversions,
--   normalize_rate_unit, product_price_per_acre, validate_product_units, guard_product_rate_lock,
--   _apply_parent_rates (the postflight compares their definitions), the rate lock, and every reader.
--   The only rows written are the nine unit rows.
--
-- ROLLBACK (its own reviewed migration): drop the four RPCs, the helpers and the three tables. Nothing
--   else references them.

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_temp;

-- The five functions RT-1 must not touch, fingerprinted from their catalog rows (body, settings, owner,
-- grants), compared again by the postflight.
CREATE TEMP TABLE product_rates_draft_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
  (SELECT jsonb_object_agg(f, md5(row(p.prosrc, p.proconfig, p.prosecdef, p.provolatile, p.proowner, p.proacl,
            p.proargtypes, p.prorettype)::text))
     FROM unnest(ARRAY[
       'public.product_price_per_acre(numeric,numeric,text,text,text)',
       'public.normalize_rate_unit(text)',
       'public.validate_product_units()',
       'public.guard_product_rate_lock()',
       'public._apply_parent_rates(uuid,bigint,numeric,text,text,jsonb,boolean,text)']) f
     JOIN pg_proc p ON p.oid = to_regprocedure(f)) AS bodies;

DO $preflight$
DECLARE
  v_missing text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  -- Two statements: PL/pgSQL plans the whole IF, so the read must not share one with the existence test.
  IF to_regclass('pg_temp.product_rates_draft_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.product_rates_draft_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regclass('public.product_rates') IS NOT NULL OR to_regclass('public.product_rate_units') IS NOT NULL
     OR to_regclass('public.product_rate_draft_events') IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_RATES_BASELINE_DRIFT: the product_rates tables already exist (already applied?)';
  END IF;
  SELECT string_agg(o, ', ') INTO v_missing FROM unnest(ARRAY[
    'public.product_parents', 'public.product_parent_members', 'public.product_parent_brands',
    'public.product_brands', 'public.epa_registrations', 'public.unit_conversions', 'public.products']) o
   WHERE to_regclass(o) IS NULL;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PRODUCT_RATES_BASELINE_DRIFT: missing table(s) %', v_missing; END IF;
  SELECT string_agg(f, ', ') INTO v_missing FROM unnest(ARRAY[
    'public._product_parent_require_admin()', 'public._product_parent_replay(text,text,text)',
    'public.save_idempotency(text,text,jsonb)', 'public.normalize_rate_unit(text)',
    'public._normalize_epa_registration(text)', 'public.is_admin()',
    'public.product_price_per_acre(numeric,numeric,text,text,text)', 'public.validate_product_units()',
    'public.guard_product_rate_lock()', 'public._apply_parent_rates(uuid,bigint,numeric,text,text,jsonb,boolean,text)']) f
   WHERE to_regprocedure(f) IS NULL;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'PRODUCT_RATES_BASELINE_DRIFT: missing function(s) %', v_missing; END IF;
  -- The fourteen unit_conversions rows exactly as live has them (2026-11-09).
  SELECT string_agg(e.unit, ', ') INTO v_missing
    FROM (VALUES ('fl oz', 1::numeric), ('oz', 1), ('Oz', 1), ('Pt', 16), ('qt', 32), ('Qt', 32), ('Gal', 128),
                 ('Dry oz', 1), ('Lb', 16), ('LB', 16), ('g', 0.03527396), ('MG', 0.00003527396), ('Ea', 1), ('Unit', 1)) e(unit, factor)
   WHERE (SELECT count(*) FROM public.unit_conversions u WHERE u.unit = e.unit AND u.factor_oz = e.factor) <> 1;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_RATES_BASELINE_DRIFT: unit_conversions differs from the pinned factors for %', v_missing;
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys((SELECT bodies FROM pg_temp.product_rates_draft_tx))) <> 5 THEN
    RAISE EXCEPTION 'PRODUCT_RATES_BASELINE_DRIFT: could not read the five unchanged functions';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.product_rate_units (
  code text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('volume', 'weight', 'each')),
  -- Fluid ounces per unit (volume), milligrams per unit (weight, exact: 1 oz = 28.349523125 g), 1 (each).
  factor numeric NOT NULL CHECK (factor > 0),
  label text NOT NULL,
  legacy_spellings text[] NOT NULL
);
ALTER TABLE public.product_rate_units OWNER TO postgres;
COMMENT ON TABLE public.product_rate_units IS
  'RT-1: the fixed rate units for product_rates (one kind and exact factor each). Seeded by its migration; never edited by the app.';

INSERT INTO public.product_rate_units (code, kind, factor, label, legacy_spellings) VALUES
  ('fl_oz', 'volume', 1, 'fl oz', ARRAY['fl oz', 'oz', 'Oz']),
  ('pt', 'volume', 16, 'pt', ARRAY['Pt']),
  ('qt', 'volume', 32, 'qt', ARRAY['qt', 'Qt']),
  ('gal', 'volume', 128, 'gal', ARRAY['Gal']),
  ('dry_oz', 'weight', 28349.523125, 'dry oz', ARRAY['Dry oz']),
  ('lb', 'weight', 453592.37, 'lb', ARRAY['Lb', 'LB']),
  ('g', 'weight', 1000, 'g', ARRAY['g']),
  ('mg', 'weight', 1, 'mg', ARRAY['MG']),
  ('each', 'each', 1, 'each', ARRAY['Ea', 'Unit']);

CREATE TABLE public.product_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  basis text NOT NULL CHECK (basis IN ('per_acre', 'per_100_gal', 'per_unit', 'per_cwt_seed', 'per_seed_unit')),
  source text NOT NULL CHECK (source IN ('label', 'house_standard')),
  -- Unconstrained numeric: a numeric(18,6) column would round a seventh decimal before any CHECK saw it.
  low numeric CHECK (low IS NULL OR (low >= 0 AND low < 1e9 AND low = round(low, 6))),
  recommended numeric CHECK (recommended IS NULL OR (recommended >= 0 AND recommended < 1e9 AND recommended = round(recommended, 6))),
  high numeric CHECK (high IS NULL OR (high >= 0 AND high < 1e9 AND high = round(high, 6))),
  unit text NOT NULL REFERENCES public.product_rate_units(code) ON UPDATE RESTRICT ON DELETE RESTRICT,
  is_quoting_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  approved_by uuid,
  approved_at timestamptz,
  origin text NOT NULL CHECK (origin IN ('derived_house', 'derived_text', 'manual')),
  -- False only on a derived house row whose basis is in doubt; the label check never compares it.
  basis_confirmed boolean NOT NULL DEFAULT true,
  source_text text CHECK (source_text IS NULL OR length(source_text) <= 200),
  over_label_reason text CHECK (over_label_reason IS NULL
    OR (btrim(over_label_reason) <> '' AND over_label_reason = btrim(over_label_reason) AND length(over_label_reason) <= 500)),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_rates_approval_fields CHECK (
    (status = 'draft' AND approved_by IS NULL AND approved_at IS NULL)
    OR (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT product_rates_one_value CHECK (low IS NOT NULL OR recommended IS NOT NULL OR high IS NOT NULL),
  CONSTRAINT product_rates_low_le_high CHECK (low IS NULL OR high IS NULL OR low <= high),
  CONSTRAINT product_rates_low_le_recommended CHECK (recommended IS NULL OR low IS NULL OR low <= recommended),
  CONSTRAINT product_rates_recommended_le_high CHECK (recommended IS NULL OR high IS NULL OR recommended <= high),
  CONSTRAINT product_rates_default_per_acre CHECK (NOT is_quoting_default OR basis = 'per_acre'),
  CONSTRAINT product_rates_default_recommended CHECK (NOT is_quoting_default OR recommended IS NOT NULL),
  -- Room for crops: a later optional crop column widens this key and the default index.
  CONSTRAINT product_rates_one_per_source_basis UNIQUE (parent_id, source, basis)
);
ALTER TABLE public.product_rates OWNER TO postgres;
CREATE UNIQUE INDEX uq_product_rates_one_default ON public.product_rates (parent_id) WHERE is_quoting_default;
COMMENT ON TABLE public.product_rates IS
  'RT-1: draft low / recommended / high rates per product parent. Read by nothing in the app until RT-4; written only by the RT-1 functions.';

CREATE TABLE public.product_rate_draft_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  rate_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('derived', 'derive_note', 'saved', 'deleted')),
  before_values jsonb,
  after_values jsonb,
  note_code text CHECK (note_code IS NULL OR note_code IN ('no_rate', 'unit_unknown', 'unit_not_for_form',
    'basis_suspect', 'basis_from_text', 'text_unparsed', 'sizes_disagree', 'stock_units_differ', 'above_label',
    'value_invalid')),
  reason text,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((event_type = 'derive_note') = (note_code IS NOT NULL))
);
ALTER TABLE public.product_rate_draft_events OWNER TO postgres;
CREATE INDEX product_rate_draft_events_parent_idx ON public.product_rate_draft_events (parent_id, id);
COMMENT ON TABLE public.product_rate_draft_events IS
  'RT-1: append-only history of every draft rate save, delete and derivation note.';

ALTER TABLE public.product_rate_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_rate_draft_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_rate_units_select ON public.product_rate_units FOR SELECT TO authenticated USING (true);
CREATE POLICY product_rates_admin_select ON public.product_rates FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
CREATE POLICY product_rate_draft_events_admin_select ON public.product_rate_draft_events FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));
REVOKE ALL ON TABLE public.product_rate_units, public.product_rates, public.product_rate_draft_events
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_rate_units, public.product_rates, public.product_rate_draft_events TO authenticated;
DO $seq$
BEGIN
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role, metabase_ro',
    pg_get_serial_sequence('public.product_rate_draft_events', 'id'));
END
$seq$;

-- ---------------------------------------------------------------------------------------------
-- 2. Row triggers
-- ---------------------------------------------------------------------------------------------

-- Sheet 3.3: which unit kinds a basis allows on a parent of each form.
CREATE FUNCTION public._product_rate_unit_fits(p_form text, p_basis text, p_kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(CASE
    WHEN p_basis IN ('per_acre', 'per_unit') THEN
      (p_form = 'liquid' AND p_kind = 'volume') OR (p_form = 'dry' AND p_kind = 'weight')
      OR (p_form = 'each' AND p_kind = 'each') OR (p_form = 'seed' AND p_kind IN ('each', 'weight'))
    WHEN p_basis IN ('per_100_gal', 'per_cwt_seed') THEN
      (p_form = 'liquid' AND p_kind = 'volume') OR (p_form = 'dry' AND p_kind = 'weight')
    WHEN p_basis = 'per_seed_unit' THEN
      (p_form = 'liquid' AND p_kind = 'volume') OR (p_form = 'dry' AND p_kind = 'weight') OR (p_form = 'each' AND p_kind = 'each')
  END, false);
$function$;

CREATE FUNCTION public._product_rates_check_unit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_form text;
  v_kind text;
BEGIN
  SELECT pp.product_form INTO v_form FROM public.product_parents pp WHERE pp.id = NEW.parent_id;
  SELECT u.kind INTO v_kind FROM public.product_rate_units u WHERE u.code = NEW.unit;
  -- An unknown unit or parent is left to the foreign keys.
  IF v_form IS NOT NULL AND v_kind IS NOT NULL AND NOT public._product_rate_unit_fits(v_form, NEW.basis, v_kind) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_UNIT_NOT_FOR_BASIS: % is not allowed for % on a % product', NEW.unit, NEW.basis, v_form;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_product_rates_check_unit BEFORE INSERT OR UPDATE ON public.product_rates
  FOR EACH ROW EXECUTE FUNCTION public._product_rates_check_unit();

-- Moves updated_at; refuses changing parent, origin or creator; refuses any change to an approved row
-- (RT-3 adds its own pass; RT-1 ships none, so an approved row cannot change or be deleted yet).
CREATE FUNCTION public._product_rates_guard_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'PRODUCT_RATE_APPROVED: send it back to draft first';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: a rate row keeps its parent, origin and creator';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_product_rates_guard_change BEFORE UPDATE OR DELETE ON public.product_rates
  FOR EACH ROW EXECUTE FUNCTION public._product_rates_guard_change();

CREATE FUNCTION public._product_rate_draft_events_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'PRODUCT_RATE_EVENTS_APPEND_ONLY: rate draft history cannot be changed or deleted';
END;
$function$;
CREATE TRIGGER trg_product_rate_draft_events_append_only BEFORE UPDATE OR DELETE ON public.product_rate_draft_events
  FOR EACH ROW EXECUTE FUNCTION public._product_rate_draft_events_append_only();
CREATE TRIGGER trg_product_rate_draft_events_no_truncate BEFORE TRUNCATE ON public.product_rate_draft_events
  FOR EACH STATEMENT EXECUTE FUNCTION public._product_rate_draft_events_append_only();

-- ---------------------------------------------------------------------------------------------
-- 3. Helpers (no grants)
-- ---------------------------------------------------------------------------------------------

-- The 3.1 value rule (not negative, below 1e9, at most 6 decimals: 15 digits, so a JavaScript number keeps it exactly), tested before any write.
CREATE FUNCTION public._product_rate_number_ok(p numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT p IS NULL OR (p >= 0 AND p < 1e9 AND p = round(p, 6));
$function$;

-- A rate denominator (sheet 3.5 and section 5): acre forms -> per_acre, '100 gal' -> per_100_gal,
-- 'cwt' -> per_cwt_seed, 'unit' -> per_seed_unit; anything else NULL. Input: lower case, spaces collapsed.
CREATE FUNCTION public._product_rate_denominator(p text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT CASE
    WHEN p IN ('acre', 'acres', 'ac', 'a') THEN 'per_acre'
    WHEN p ~ '^100 ?gal$' THEN 'per_100_gal'
    WHEN p = 'cwt' THEN 'per_cwt_seed'
    WHEN p = 'unit' THEN 'per_seed_unit'
  END;
$function$;

-- A unit word in rate text -> product_rate_units code. 'oz' is dry ounces on a dry parent, fluid otherwise.
CREATE FUNCTION public._product_rate_text_unit(p_word text, p_form text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT CASE
    WHEN p_word = 'oz' THEN CASE WHEN p_form = 'dry' THEN 'dry_oz' ELSE 'fl_oz' END
    WHEN p_word = 'fl oz' THEN 'fl_oz'
    WHEN p_word = 'dry oz' THEN 'dry_oz'
    WHEN p_word IN ('pt', 'pint', 'pints') THEN 'pt'
    WHEN p_word IN ('qt', 'quart', 'quarts') THEN 'qt'
    WHEN p_word IN ('gal', 'gallon', 'gallons') THEN 'gal'
    WHEN p_word IN ('lb', 'lbs', 'pound', 'pounds') THEN 'lb'
    WHEN p_word IN ('g', 'gram', 'grams') THEN 'g'
    WHEN p_word = 'mg' THEN 'mg'
    WHEN p_word IN ('ea', 'unit') THEN 'each'
  END;
$function$;

-- The strict suggested-rate parser (sheet section 5, Row 2). Returns {parsed: false} or
-- {parsed: true, basis, unit, low, recommended, high} (numbers as text; the caller checks them).
CREATE FUNCTION public._product_rate_parse_text(p_text text, p_form text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  c_num constant text := '([0-9]+(?:\.[0-9]*)?|\.[0-9]+)';
  c_unit constant text := '(fl oz|dry oz|oz|pints|pint|pt|quarts|quart|qt|gallons|gallon|gal|pounds|pound|lbs|lb|grams|gram|mg|g|ea|unit)';
  v text := lower(regexp_replace(btrim(COALESCE(p_text, '')), '\s+', ' ', 'g'));
  v_left text;
  v_basis text;
  m text[];
BEGIN
  IF v = '' THEN RETURN jsonb_build_object('parsed', false); END IF;
  m := regexp_match(v, '^' || c_num || '(?: ?(?:-|to) ?' || c_num || ')? ?gpa$');
  IF m IS NOT NULL THEN
    RETURN jsonb_build_object('parsed', true, 'basis', 'per_acre', 'unit', 'gal',
      'low', CASE WHEN m[2] IS NOT NULL THEN m[1] END,
      'recommended', CASE WHEN m[2] IS NULL THEN m[1] END,
      'high', m[2]);
  END IF;
  IF position('/' IN v) > 0 THEN
    v_left := btrim(split_part(v, '/', 1));
    v_basis := public._product_rate_denominator(btrim(substr(v, position('/' IN v) + 1)));
  ELSIF v ~ ' per acre$' THEN
    v_left := btrim(regexp_replace(v, ' per acre$', ''));
    v_basis := 'per_acre';
  END IF;
  IF v_basis IS NULL THEN RETURN jsonb_build_object('parsed', false); END IF;
  m := regexp_match(v_left, '^' || c_num || ' ?' || c_unit || '? ?(?:-|to) ?' || c_num || ' ?' || c_unit || '$');
  IF m IS NOT NULL THEN
    IF m[2] IS NOT NULL
       AND public._product_rate_text_unit(m[2], p_form) IS DISTINCT FROM public._product_rate_text_unit(m[4], p_form) THEN
      RETURN jsonb_build_object('parsed', false);
    END IF;
    RETURN jsonb_build_object('parsed', true, 'basis', v_basis, 'unit', public._product_rate_text_unit(m[4], p_form),
      'low', m[1], 'recommended', NULL, 'high', m[3]);
  END IF;
  m := regexp_match(v_left, '^' || c_num || ' ?' || c_unit || '$');
  IF m IS NOT NULL THEN
    RETURN jsonb_build_object('parsed', true, 'basis', v_basis, 'unit', public._product_rate_text_unit(m[2], p_form),
      'low', NULL, 'recommended', m[1], 'high', NULL);
  END IF;
  RETURN jsonb_build_object('parsed', false);
END;
$function$;

-- A label maximum's unit (free text, up to 40 characters) -> {basis, unit} for a row of p_kind; unit is
-- NULL when it cannot be compared. A bare unit reads as per acre, as compareToMaxRate does.
CREATE FUNCTION public._product_rate_max_unit(p_max_unit text, p_kind text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v text := lower(regexp_replace(btrim(COALESCE(p_max_unit, '')), '\s+', ' ', 'g'));
  v_base text;
  v_basis text;
  v_code text;
BEGIN
  IF position('/' IN v) > 0 THEN
    v_base := btrim(split_part(v, '/', 1));
    v_basis := public._product_rate_denominator(btrim(substr(v, position('/' IN v) + 1)));
  ELSIF v ~ ' per acre$' THEN
    v_base := btrim(regexp_replace(v, ' per acre$', ''));
    v_basis := 'per_acre';
  ELSE
    v_base := v;
    v_basis := 'per_acre';
  END IF;
  -- "dry oz" and "fl oz" name their kind; normalize_rate_unit would drop "fl" and keep "dry oz" unknown.
  v_code := CASE
    WHEN v_base ~ '^dry\.? ?oz\.?$' THEN 'dry_oz'
    WHEN v_base ~ '^fl\.? ?oz\.?$' THEN 'fl_oz'
  END;
  v_base := public.normalize_rate_unit(v_base);
  v_code := CASE
    WHEN v_code IS NOT NULL THEN v_code
    WHEN v_base = 'oz' THEN CASE p_kind WHEN 'volume' THEN 'fl_oz' WHEN 'weight' THEN 'dry_oz' END
    WHEN v_base IN ('pt', 'qt', 'gal', 'lb', 'g', 'mg') THEN v_base
  END;
  IF v_code IS NOT NULL AND (SELECT u.kind FROM public.product_rate_units u WHERE u.code = v_code) IS DISTINCT FROM p_kind THEN
    v_code := NULL;
  END IF;
  RETURN jsonb_build_object('basis', v_basis, 'unit', v_code);
END;
$function$;

-- The parent's EPA numbers from the four places _parent_chemistry_epa_refusal reads.
CREATE FUNCTION public._product_rate_epa_numbers(p_parent_id uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(array_agg(DISTINCT s.n ORDER BY s.n), '{}')
    FROM (
      SELECT public._normalize_epa_registration(pp.generic_epa_registration) AS n
        FROM public.product_parents pp WHERE pp.id = p_parent_id
      UNION ALL
      SELECT public._normalize_epa_registration(p.epa_registration)
        FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
       WHERE m.parent_id = p_parent_id
      UNION ALL
      SELECT public._normalize_epa_registration(b.epa_registration)
        FROM public.product_parent_brands b WHERE b.parent_id = p_parent_id AND b.status = 'active'
      UNION ALL
      SELECT public._normalize_epa_registration(lb.epa_registration)
        FROM public.product_parent_members m JOIN public.product_brands lb ON lb.product_id = m.product_id
       WHERE m.parent_id = p_parent_id
    ) s
   WHERE s.n IS NOT NULL;
$function$;

-- Sheet 3.5 on given values: {status: not_applicable | not_checked | within | above, ...}.
-- Takes the REG-1 advisory pair shared before reading registrations.
CREATE FUNCTION public._product_rate_check_values(p_parent_id uuid, p_source text, p_basis text, p_unit text,
  p_low numeric, p_recommended numeric, p_high numeric, p_basis_confirmed boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_numbers text[];
  v_seeded boolean := false;
  v_unit public.product_rate_units%ROWTYPE;
  v_highest numeric := greatest(p_low, p_recommended, p_high);
  v_number text;
  v_reg record;
  v_max jsonb;
  v_max_factor numeric;
  v_above jsonb := '[]';
  v_unchecked jsonb := '[]';
BEGIN
  IF p_source = 'label' THEN RETURN jsonb_build_object('status', 'not_applicable'); END IF;
  IF p_basis = 'per_unit' THEN RETURN jsonb_build_object('status', 'not_checked', 'why', 'basis_has_no_label_max'); END IF;
  IF NOT COALESCE(p_basis_confirmed, false) THEN RETURN jsonb_build_object('status', 'not_checked', 'why', 'basis_unconfirmed'); END IF;
  PERFORM pg_advisory_xact_lock_shared(20261210, hashtext('crx_epa_registration'));
  v_numbers := public._product_rate_epa_numbers(p_parent_id);
  IF cardinality(v_numbers) = 0 THEN RETURN jsonb_build_object('status', 'not_checked', 'why', 'no_registration'); END IF;
  -- REG-1 step 2 may not be applied yet; look its seed check up on every call.
  -- Only a postgres-owned function of that name is run (this check runs with the owner's rights).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.oid = to_regprocedure('public._epa_registrations_seeded()') AND p.proowner = 'postgres'::regrole) THEN
    EXECUTE 'SELECT public._epa_registrations_seeded()' INTO v_seeded;
  END IF;
  IF NOT COALESCE(v_seeded, false) THEN
    RETURN jsonb_build_object('status', 'not_checked', 'why', 'registrations_not_seeded');
  END IF;
  SELECT * INTO v_unit FROM public.product_rate_units u WHERE u.code = p_unit;
  FOREACH v_number IN ARRAY v_numbers LOOP
    SELECT r.max_label_rate, r.max_label_rate_unit INTO v_reg FROM public.epa_registrations r WHERE r.epa_registration = v_number;
    IF NOT FOUND THEN
      v_unchecked := v_unchecked || jsonb_build_object('epa_registration', v_number, 'why', 'registration_missing');
      CONTINUE;
    END IF;
    IF v_reg.max_label_rate IS NULL THEN
      v_unchecked := v_unchecked || jsonb_build_object('epa_registration', v_number, 'why', 'no_label_max');
      CONTINUE;
    END IF;
    v_max := public._product_rate_max_unit(v_reg.max_label_rate_unit, v_unit.kind);
    IF v_max->>'basis' IS DISTINCT FROM p_basis THEN
      v_unchecked := v_unchecked || jsonb_build_object('epa_registration', v_number, 'why', 'max_basis_differs',
        'max_label_rate', v_reg.max_label_rate, 'max_label_rate_unit', v_reg.max_label_rate_unit);
      CONTINUE;
    END IF;
    SELECT u.factor INTO v_max_factor FROM public.product_rate_units u WHERE u.code = v_max->>'unit';
    IF NOT FOUND THEN
      v_unchecked := v_unchecked || jsonb_build_object('epa_registration', v_number, 'why', 'max_unit_not_comparable',
        'max_label_rate', v_reg.max_label_rate, 'max_label_rate_unit', v_reg.max_label_rate_unit);
      CONTINUE;
    END IF;
    -- Exact numeric, no rounding: equal is not above.
    IF v_highest * v_unit.factor > v_reg.max_label_rate * v_max_factor THEN
      v_above := v_above || jsonb_build_object('epa_registration', v_number,
        'max_label_rate', v_reg.max_label_rate, 'max_label_rate_unit', v_reg.max_label_rate_unit);
    END IF;
  END LOOP;
  IF jsonb_array_length(v_above) > 0 THEN
    RETURN jsonb_build_object('status', 'above', 'above', v_above, 'not_checked', v_unchecked,
      'reason_missing', p_reason IS NULL);
  ELSIF jsonb_array_length(v_unchecked) > 0 THEN
    RETURN jsonb_build_object('status', 'not_checked', 'why', 'max_not_comparable', 'not_checked', v_unchecked);
  END IF;
  RETURN jsonb_build_object('status', 'within');
END;
$function$;

-- The label check of a stored row (RT-4's readers will call this).
CREATE FUNCTION public._product_rate_label_check(p_rate_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  r public.product_rates%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.product_rates WHERE id = p_rate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_FOUND'; END IF;
  RETURN public._product_rate_check_values(r.parent_id, r.source, r.basis, r.unit, r.low, r.recommended, r.high,
    r.basis_confirmed, r.over_label_reason);
END;
$function$;

-- One derivation note: a derive_note event, returned for the report.
CREATE FUNCTION public._product_rate_note(p_parent_id uuid, p_rate_id uuid, p_code text, p_text text, p_detail jsonb,
  p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_note jsonb := jsonb_build_object('note_code', p_code, 'rate_id', p_rate_id, 'text', left(p_text, 200), 'detail', p_detail);
BEGIN
  INSERT INTO public.product_rate_draft_events (parent_id, rate_id, event_type, after_values, note_code, changed_by)
  VALUES (p_parent_id, p_rate_id, 'derive_note', v_note, p_code, p_actor);
  RETURN v_note;
END;
$function$;

-- Inserts one derived draft and its 'derived' event; returns the row.
CREATE FUNCTION public._product_rate_insert_derived(p_parent_id uuid, p_source text, p_basis text, p_unit text,
  p_low numeric, p_recommended numeric, p_high numeric, p_default boolean, p_basis_confirmed boolean, p_origin text,
  p_source_text text, p_actor uuid) RETURNS public.product_rates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  r public.product_rates%ROWTYPE;
BEGIN
  INSERT INTO public.product_rates (parent_id, basis, source, low, recommended, high, unit, is_quoting_default,
    origin, basis_confirmed, source_text, created_by, updated_by)
  VALUES (p_parent_id, p_basis, p_source, p_low, p_recommended, p_high, p_unit, p_default,
    p_origin, p_basis_confirmed, p_source_text, p_actor, p_actor)
  RETURNING * INTO r;
  INSERT INTO public.product_rate_draft_events (parent_id, rate_id, event_type, after_values, changed_by)
  VALUES (p_parent_id, r.id, 'derived', to_jsonb(r), p_actor);
  RETURN r;
END;
$function$;

-- Sheet section 5 for one parent, under the 3.6 locks (the caller holds the REG-1 pair shared).
CREATE FUNCTION public._product_rate_derive_parent(p_parent_id uuid, p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent public.product_parents%ROWTYPE;
  v_rate numeric;
  v_rate_unit text;
  v_text text;
  v_members jsonb;
  v_disagree jsonb;
  v_stock text[];
  v_house_unit text;
  v_house_text text;
  v_mixed_stock boolean := false;
  v_code text;
  v_kind text;
  v_parse jsonb;
  v_parsed boolean;
  v_doubt boolean;
  v_low numeric;
  v_rec numeric;
  v_high numeric;
  r public.product_rates%ROWTYPE;
  v_check jsonb;
  v_rows jsonb := '[]';
  v_notes jsonb := '[]';
BEGIN
  SELECT * INTO v_parent FROM public.product_parents WHERE id = p_parent_id AND is_active FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PARENT_NOT_FOUND: %', p_parent_id; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', s.id, 'product_name', s.product_name,
           'rate_per_acre', s.rate_per_acre, 'rate_unit', s.rate_unit, 'suggested_rate', s.suggested_rate,
           'inventory_unit', s.inventory_unit) ORDER BY s.id), '[]')
    INTO v_members
    FROM (SELECT p.id, p.product_name, p.rate_per_acre, p.rate_unit, p.suggested_rate, p.inventory_unit
            FROM public.products p JOIN public.product_parent_members m ON m.product_id = p.id
           WHERE m.parent_id = p_parent_id ORDER BY p.id FOR SHARE OF p) s;
  PERFORM 1 FROM public.product_rates WHERE parent_id = p_parent_id ORDER BY id FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('parent_id', p_parent_id, 'outcome', 'skipped_has_rows', 'rows', '[]'::jsonb, 'notes', '[]'::jsonb);
  END IF;

  v_rate := v_parent.rate_per_acre;
  v_rate_unit := NULLIF(btrim(v_parent.rate_unit), '');
  v_text := NULLIF(btrim(v_parent.suggested_rate), '');

  -- Safety check (form-aware): every size carries the parent's values.
  SELECT COALESCE(jsonb_agg(e), '[]') INTO v_disagree FROM jsonb_array_elements(v_members) e
   WHERE (e->>'rate_per_acre')::numeric IS DISTINCT FROM v_rate
      OR NULLIF(btrim(e->>'suggested_rate'), '') IS DISTINCT FROM v_text
      OR CASE WHEN v_parent.product_form IN ('liquid', 'dry')
              THEN NULLIF(btrim(e->>'rate_unit'), '') IS DISTINCT FROM v_rate_unit
              ELSE NULLIF(btrim(e->>'rate_unit'), '') IS DISTINCT FROM NULLIF(btrim(e->>'inventory_unit'), '') END;
  IF jsonb_array_length(v_disagree) > 0 THEN
    v_notes := v_notes || public._product_rate_note(p_parent_id, NULL, 'sizes_disagree', NULL,
      jsonb_build_object('parent', jsonb_build_object('rate_per_acre', v_rate, 'rate_unit', v_parent.rate_unit,
        'suggested_rate', v_parent.suggested_rate), 'sizes', v_disagree), p_actor);
    RETURN jsonb_build_object('parent_id', p_parent_id, 'outcome', 'skipped_sizes_disagree', 'rows', '[]'::jsonb, 'notes', v_notes);
  END IF;

  v_parse := public._product_rate_parse_text(v_text, v_parent.product_form);
  v_parsed := v_text IS NOT NULL AND length(v_parent.suggested_rate) <= 200 AND (v_parse->>'parsed')::boolean;
  -- A basis doubt: text present that does not read as per acre or per 100 gal.
  v_doubt := v_text IS NOT NULL AND NOT (v_parsed AND v_parse->>'basis' IN ('per_acre', 'per_100_gal'));

  -- Row 1: the house row.
  IF v_rate IS NULL THEN
    v_notes := v_notes || public._product_rate_note(p_parent_id, NULL, 'no_rate', NULL, NULL, p_actor);
  ELSE
    IF v_parent.product_form IN ('liquid', 'dry') THEN
      v_house_unit := v_rate_unit;
    ELSE
      -- Each and seed sizes keep their stock unit as rate unit; the parent's rate_unit is NULL by design.
      SELECT array_agg(DISTINCT COALESCE(NULLIF(btrim(e->>'inventory_unit'), ''), '')) INTO v_stock
        FROM jsonb_array_elements(v_members) e;
      IF cardinality(v_stock) > 1 THEN
        v_mixed_stock := true;
        v_notes := v_notes || public._product_rate_note(p_parent_id, NULL, 'stock_units_differ', NULL,
          (SELECT jsonb_agg(jsonb_build_object('product_id', e->'product_id', 'product_name', e->'product_name',
             'inventory_unit', e->'inventory_unit') ORDER BY e->>'product_id') FROM jsonb_array_elements(v_members) e), p_actor);
      ELSE
        v_house_unit := NULLIF(v_stock[1], '');
      END IF;
    END IF;
    IF NOT v_mixed_stock THEN
      v_house_text := concat_ws(' ', v_rate::text, v_house_unit);
      SELECT u.code, u.kind INTO v_code, v_kind FROM public.product_rate_units u WHERE v_house_unit = ANY (u.legacy_spellings);
      IF NOT public._product_rate_number_ok(v_rate) THEN
        v_notes := v_notes || public._product_rate_note(p_parent_id, NULL, 'value_invalid', v_house_text, NULL, p_actor);
      ELSIF v_code IS NULL THEN
        v_notes := v_notes || public._product_rate_note(p_parent_id, NULL, 'unit_unknown', v_house_text,
          jsonb_build_object('unit', v_house_unit), p_actor);
      ELSIF NOT public._product_rate_unit_fits(v_parent.product_form, 'per_acre', v_kind) THEN
        v_notes := v_notes || public._product_rate_note(p_parent_id, NULL, 'unit_not_for_form', v_house_text,
          jsonb_build_object('unit', v_house_unit, 'form', v_parent.product_form), p_actor);
      ELSE
        r := public._product_rate_insert_derived(p_parent_id, 'house_standard', 'per_acre', v_code, NULL, v_rate, NULL,
          NOT v_doubt, NOT v_doubt, 'derived_house', v_house_text, p_actor);
        v_rows := v_rows || jsonb_build_object('rate_id', r.id, 'source', r.source, 'basis', r.basis, 'unit', r.unit,
          'low', r.low, 'recommended', r.recommended, 'high', r.high, 'is_quoting_default', r.is_quoting_default,
          'basis_confirmed', r.basis_confirmed);
        IF v_doubt THEN
          v_notes := v_notes || public._product_rate_note(p_parent_id, r.id, 'basis_suspect', v_parent.suggested_rate,
            jsonb_build_object('text_basis', CASE WHEN v_parsed THEN v_parse->'basis' END), p_actor);
        END IF;
        -- An above-label house row is still written (it is today's real rate), with no reason; RT-3 must
        -- not approve it until an admin saves it with a reason or a lower rate (sheet 4.C).
        v_check := public._product_rate_label_check(r.id);
        IF v_check->>'status' = 'above' THEN
          v_notes := v_notes || public._product_rate_note(p_parent_id, r.id, 'above_label', v_house_text,
            v_check->'above', p_actor);
        END IF;
      END IF;
    END IF;
  END IF;

  -- Row 2: the text row (the label rate, Mason's answer 1, 2026-11-09). Never a quoting default.
  IF v_text IS NOT NULL THEN
    IF NOT v_parsed THEN
      v_notes := v_notes || public._product_rate_note(p_parent_id, NULL, 'text_unparsed', v_parent.suggested_rate, NULL, p_actor);
    ELSE
      v_low := (v_parse->>'low')::numeric;
      v_rec := (v_parse->>'recommended')::numeric;
      v_high := (v_parse->>'high')::numeric;
      SELECT u.kind INTO v_kind FROM public.product_rate_units u WHERE u.code = v_parse->>'unit';
      IF NOT (public._product_rate_number_ok(v_low) AND public._product_rate_number_ok(v_rec)
              AND public._product_rate_number_ok(v_high) AND (v_low IS NULL OR v_high IS NULL OR v_low <= v_high)) THEN
        v_notes := v_notes || public._product_rate_note(p_parent_id, NULL, 'value_invalid', v_parent.suggested_rate, NULL, p_actor);
      ELSIF NOT public._product_rate_unit_fits(v_parent.product_form, v_parse->>'basis', v_kind) THEN
        v_notes := v_notes || public._product_rate_note(p_parent_id, NULL, 'unit_not_for_form', v_parent.suggested_rate,
          jsonb_build_object('unit', v_parse->'unit', 'basis', v_parse->'basis', 'form', v_parent.product_form), p_actor);
      ELSE
        r := public._product_rate_insert_derived(p_parent_id, 'label', v_parse->>'basis', v_parse->>'unit',
          v_low, v_rec, v_high, false, true, 'derived_text', v_parent.suggested_rate, p_actor);
        v_rows := v_rows || jsonb_build_object('rate_id', r.id, 'source', r.source, 'basis', r.basis, 'unit', r.unit,
          'low', r.low, 'recommended', r.recommended, 'high', r.high, 'is_quoting_default', r.is_quoting_default,
          'basis_confirmed', r.basis_confirmed);
        IF r.basis = 'per_seed_unit' THEN
          v_notes := v_notes || public._product_rate_note(p_parent_id, r.id, 'basis_from_text', v_parent.suggested_rate, NULL, p_actor);
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('parent_id', p_parent_id,
    'outcome', CASE WHEN jsonb_array_length(v_rows) > 0 THEN 'derived' ELSE 'nothing_to_derive' END,
    'rows', v_rows, 'notes', v_notes);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 4. Browser RPCs (admin only)
-- ---------------------------------------------------------------------------------------------

-- 4.A Insert a draft (p_rate_id NULL) or edit one.
CREATE FUNCTION public.save_draft_product_rate(p_parent_id uuid, p_rate_id uuid, p_expected_row_version bigint,
  p_basis text, p_source text, p_low numeric, p_recommended numeric, p_high numeric, p_unit text,
  p_is_quoting_default boolean, p_over_label_reason text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid;
  v_fp text;
  v_existing jsonb;
  v_unit public.product_rate_units%ROWTYPE;
  v_unit_text text := btrim(COALESCE(p_unit, ''));
  v_reason text := NULLIF(btrim(COALESCE(p_over_label_reason, '')), '');
  v_default boolean := COALESCE(p_is_quoting_default, false);
  v_parent public.product_parents%ROWTYPE;
  v_old public.product_rates%ROWTYPE;
  v_new public.product_rates%ROWTYPE;
  v_other uuid;
  v_check jsonb;
  v_result jsonb;
BEGIN
  v_actor := public._product_parent_require_admin();
  v_fp := md5(jsonb_build_object('actor_id', v_actor, 'parent_id', p_parent_id, 'rate_id', p_rate_id,
    'expected_row_version', p_expected_row_version, 'basis', p_basis, 'source', p_source, 'low', p_low,
    'recommended', p_recommended, 'high', p_high, 'unit', p_unit, 'is_quoting_default', p_is_quoting_default,
    'over_label_reason', p_over_label_reason)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'save_draft_product_rate', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  -- Shapes. A negative value passes here and is refused as a range below (sheet 3.4 and R6).
  IF p_basis IS NULL OR p_basis NOT IN ('per_acre', 'per_100_gal', 'per_unit', 'per_cwt_seed', 'per_seed_unit') THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: basis must be per_acre, per_100_gal, per_unit, per_cwt_seed or per_seed_unit';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('label', 'house_standard') THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: source must be label or house_standard';
  END IF;
  IF NOT (public._product_rate_number_ok(abs(p_low)) AND public._product_rate_number_ok(abs(p_recommended))
          AND public._product_rate_number_ok(abs(p_high))) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: a rate must be a number below 1000000000 with at most 6 decimals';
  END IF;
  SELECT * INTO v_unit FROM public.product_rate_units u WHERE u.code = v_unit_text;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_RATE_UNIT_UNKNOWN: "%" is not a rate unit', v_unit_text; END IF;
  IF length(v_reason) > 500 THEN RAISE EXCEPTION 'PRODUCT_RATE_INVALID: keep the over-label reason to 500 characters'; END IF;

  -- Locks (sheet 3.6): REG-1 pair shared, the parent, the parent's rate rows.
  PERFORM pg_advisory_xact_lock_shared(20261210, hashtext('crx_epa_registration'));
  SELECT * INTO v_parent FROM public.product_parents WHERE id = p_parent_id AND is_active FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PARENT_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.product_rates WHERE parent_id = p_parent_id ORDER BY id FOR UPDATE;

  IF p_rate_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.product_rates WHERE id = p_rate_id AND parent_id = p_parent_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_FOUND'; END IF;
    IF v_old.status <> 'draft' THEN RAISE EXCEPTION 'PRODUCT_RATE_APPROVED: send it back to draft first'; END IF;
    IF p_expected_row_version IS DISTINCT FROM v_old.row_version THEN
      RAISE EXCEPTION 'PRODUCT_RATE_STALE: this rate changed since you opened it; reload and try again';
    END IF;
  END IF;

  -- Sheet 3.4, in table order (the unit's existence was checked above).
  IF v_default THEN
    SELECT id INTO v_other FROM public.product_rates
     WHERE parent_id = p_parent_id AND is_quoting_default AND id IS DISTINCT FROM p_rate_id;
    IF FOUND THEN
      RAISE EXCEPTION 'PRODUCT_RATE_DEFAULT_EXISTS: % already has a quoting default (rate %); clear it first', v_parent.name, v_other;
    END IF;
    IF p_basis <> 'per_acre' THEN RAISE EXCEPTION 'PRODUCT_RATE_DEFAULT_NOT_PER_ACRE: only a per-acre rate can be the quoting default'; END IF;
    IF p_recommended IS NULL THEN RAISE EXCEPTION 'PRODUCT_RATE_DEFAULT_NEEDS_RECOMMENDED: the quoting default needs a recommended rate'; END IF;
  END IF;
  IF NOT public._product_rate_unit_fits(v_parent.product_form, p_basis, v_unit.kind) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_UNIT_NOT_FOR_BASIS: % is not allowed for % on a % product', v_unit.code, p_basis, v_parent.product_form;
  END IF;
  IF (p_low IS NULL AND p_recommended IS NULL AND p_high IS NULL)
     OR p_low < 0 OR p_recommended < 0 OR p_high < 0
     OR p_low > p_high OR p_low > p_recommended OR p_recommended > p_high THEN
    RAISE EXCEPTION 'PRODUCT_RATE_RANGE_INVALID: give at least one rate, none below 0, with low <= recommended <= high';
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_rates WHERE parent_id = p_parent_id AND source = p_source AND basis = p_basis
              AND id IS DISTINCT FROM p_rate_id) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_DUPLICATE: % already has a % % rate', v_parent.name, p_source, p_basis;
  END IF;

  -- Label check on the proposed values (a save confirms the basis). Warns, never blocks, once a reason is given.
  v_check := public._product_rate_check_values(p_parent_id, p_source, p_basis, v_unit.code, p_low, p_recommended, p_high,
    true, v_reason);
  IF v_check->>'status' = 'above' AND v_reason IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED: % % is above the label maximum % % on EPA %; give a reason to save it',
      greatest(p_low, p_recommended, p_high), v_unit.label, v_check->'above'->0->>'max_label_rate',
      v_check->'above'->0->>'max_label_rate_unit', v_check->'above'->0->>'epa_registration';
  END IF;

  IF p_rate_id IS NULL THEN
    INSERT INTO public.product_rates (parent_id, basis, source, low, recommended, high, unit, is_quoting_default,
      origin, basis_confirmed, over_label_reason, created_by, updated_by)
    VALUES (p_parent_id, p_basis, p_source, p_low, p_recommended, p_high, v_unit.code, v_default,
      'manual', true, v_reason, v_actor, v_actor)
    RETURNING * INTO v_new;
  ELSE
    UPDATE public.product_rates SET basis = p_basis, source = p_source, low = p_low, recommended = p_recommended,
      high = p_high, unit = v_unit.code, is_quoting_default = v_default, basis_confirmed = true,
      over_label_reason = v_reason, row_version = row_version + 1, updated_by = v_actor
     WHERE id = p_rate_id
    RETURNING * INTO v_new;
  END IF;
  INSERT INTO public.product_rate_draft_events (parent_id, rate_id, event_type, before_values, after_values, changed_by)
  VALUES (p_parent_id, v_new.id, 'saved', CASE WHEN p_rate_id IS NOT NULL THEN to_jsonb(v_old) END, to_jsonb(v_new), v_actor);

  v_result := jsonb_build_object('rate_id', v_new.id, 'row_version', v_new.row_version, 'label_check', v_check);
  PERFORM public.save_idempotency(p_idempotency_key, 'save_draft_product_rate',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- 4.B Delete a wrongly derived (or wrongly saved) draft.
CREATE FUNCTION public.delete_draft_product_rate(p_rate_id uuid, p_expected_row_version bigint, p_reason text,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid;
  v_fp text;
  v_existing jsonb;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_parent_id uuid;
  v_old public.product_rates%ROWTYPE;
  v_result jsonb;
BEGIN
  v_actor := public._product_parent_require_admin();
  v_fp := md5(jsonb_build_object('actor_id', v_actor, 'rate_id', p_rate_id,
    'expected_row_version', p_expected_row_version, 'reason', p_reason)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'delete_draft_product_rate', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF v_reason = '' OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'PRODUCT_RATE_REASON_REQUIRED: say why, in 1 to 500 characters';
  END IF;

  -- parent_id never changes (trigger), so this read names the parent to lock first.
  SELECT parent_id INTO v_parent_id FROM public.product_rates WHERE id = p_rate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.product_parents WHERE id = v_parent_id FOR NO KEY UPDATE;
  SELECT * INTO v_old FROM public.product_rates WHERE id = p_rate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_FOUND'; END IF;
  IF v_old.status <> 'draft' THEN RAISE EXCEPTION 'PRODUCT_RATE_APPROVED: send it back to draft first'; END IF;
  IF p_expected_row_version IS DISTINCT FROM v_old.row_version THEN
    RAISE EXCEPTION 'PRODUCT_RATE_STALE: this rate changed since you opened it; reload and try again';
  END IF;

  DELETE FROM public.product_rates WHERE id = p_rate_id;
  INSERT INTO public.product_rate_draft_events (parent_id, rate_id, event_type, before_values, reason, changed_by)
  VALUES (v_old.parent_id, v_old.id, 'deleted', to_jsonb(v_old), v_reason, v_actor);

  v_result := jsonb_build_object('rate_id', p_rate_id, 'deleted', true);
  PERFORM public.save_idempotency(p_idempotency_key, 'delete_draft_product_rate',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- 4.C Copy today's parent rates into drafts (sheet section 5). 1 to 500 distinct parents, in ID order.
CREATE FUNCTION public.derive_draft_product_rates(p_parent_ids uuid[], p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid;
  v_fp text;
  v_existing jsonb;
  v_id uuid;
  v_parents jsonb := '[]';
  v_result jsonb;
BEGIN
  v_actor := public._product_parent_require_admin();
  v_fp := md5(jsonb_build_object('actor_id', v_actor, 'parent_ids', to_jsonb(p_parent_ids))::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'derive_draft_product_rates', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF p_parent_ids IS NULL OR cardinality(p_parent_ids) NOT BETWEEN 1 AND 500
     OR array_position(p_parent_ids, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT x) FROM unnest(p_parent_ids) x) <> cardinality(p_parent_ids) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_DERIVE_BATCH: send 1 to 500 different parent IDs';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(20261210, hashtext('crx_epa_registration'));
  FOR v_id IN SELECT x FROM unnest(p_parent_ids) x ORDER BY x LOOP
    v_parents := v_parents || public._product_rate_derive_parent(v_id, v_actor);
  END LOOP;

  v_result := jsonb_build_object('parents', v_parents, 'totals', jsonb_build_object(
    'parents', jsonb_array_length(v_parents),
    'derived', (SELECT count(*) FROM jsonb_array_elements(v_parents) e WHERE e->>'outcome' = 'derived'),
    'skipped_has_rows', (SELECT count(*) FROM jsonb_array_elements(v_parents) e WHERE e->>'outcome' = 'skipped_has_rows'),
    'skipped_sizes_disagree', (SELECT count(*) FROM jsonb_array_elements(v_parents) e WHERE e->>'outcome' = 'skipped_sizes_disagree'),
    'nothing_to_derive', (SELECT count(*) FROM jsonb_array_elements(v_parents) e WHERE e->>'outcome' = 'nothing_to_derive'),
    'rows', (SELECT COALESCE(sum(jsonb_array_length(e->'rows')), 0) FROM jsonb_array_elements(v_parents) e),
    'notes', (SELECT COALESCE(sum(jsonb_array_length(e->'notes')), 0) FROM jsonb_array_elements(v_parents) e)));
  PERFORM public.save_idempotency(p_idempotency_key, 'derive_draft_product_rates',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- 4.D Read a parent's drafts with their label checks and derivation notes. Writes nothing.
CREATE FUNCTION public.get_parent_draft_rates(p_parent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid;
BEGIN
  v_actor := public._product_parent_require_admin();
  IF NOT EXISTS (SELECT 1 FROM public.product_parents WHERE id = p_parent_id) THEN RAISE EXCEPTION 'PARENT_NOT_FOUND'; END IF;
  RETURN jsonb_build_object('parent_id', p_parent_id,
    'rates', COALESCE((SELECT jsonb_agg(to_jsonb(r) || jsonb_build_object('unit_label', u.label, 'unit_kind', u.kind,
                 'label_check', public._product_rate_label_check(r.id)) ORDER BY r.source, r.basis)
               FROM public.product_rates r JOIN public.product_rate_units u ON u.code = r.unit
              WHERE r.parent_id = p_parent_id), '[]'::jsonb),
    'notes', COALESCE((SELECT jsonb_agg(e.after_values || jsonb_build_object('event_id', e.id, 'changed_at', e.changed_at) ORDER BY e.id)
               FROM public.product_rate_draft_events e
              WHERE e.parent_id = p_parent_id AND e.event_type = 'derive_note'), '[]'::jsonb));
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 5. Owners and grants: every new function is owned by postgres with no PUBLIC execute; only the four
--    browser RPCs are executable, by authenticated (each refuses non-admins itself).
-- ---------------------------------------------------------------------------------------------

CREATE TEMP TABLE product_rates_draft_fns ON COMMIT DROP AS
SELECT f, f LIKE 'public.\_%' AS helper FROM unnest(ARRAY[
  'public._product_rate_unit_fits(text,text,text)', 'public._product_rates_check_unit()',
  'public._product_rates_guard_change()', 'public._product_rate_draft_events_append_only()',
  'public._product_rate_number_ok(numeric)', 'public._product_rate_denominator(text)',
  'public._product_rate_text_unit(text,text)', 'public._product_rate_parse_text(text,text)',
  'public._product_rate_max_unit(text,text)', 'public._product_rate_epa_numbers(uuid)',
  'public._product_rate_check_values(uuid,text,text,text,numeric,numeric,numeric,boolean,text)',
  'public._product_rate_label_check(uuid)', 'public._product_rate_note(uuid,uuid,text,text,jsonb,uuid)',
  'public._product_rate_insert_derived(uuid,text,text,text,numeric,numeric,numeric,boolean,boolean,text,text,uuid)',
  'public._product_rate_derive_parent(uuid,uuid)',
  'public.save_draft_product_rate(uuid,uuid,bigint,text,text,numeric,numeric,numeric,text,boolean,text,text)',
  'public.delete_draft_product_rate(uuid,bigint,text,text)', 'public.derive_draft_product_rates(uuid[],text)',
  'public.get_parent_draft_rates(uuid)']) f;

DO $grants$
DECLARE
  v record;
BEGIN
  FOR v IN SELECT * FROM pg_temp.product_rates_draft_fns LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', v.f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role, metabase_ro', v.f);
    IF NOT v.helper THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v.f); END IF;
  END LOOP;
END
$grants$;

-- ---------------------------------------------------------------------------------------------
-- 6. Postflight (sheet 4.G)
-- ---------------------------------------------------------------------------------------------

DO $postflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('pg_temp.product_rates_draft_tx') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.product_rates_draft_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;

  -- Tables: RLS on, exactly the named policies, SELECT to authenticated only, no column or sequence grants.
  SELECT string_agg(c.relname, ', ') INTO v_bad FROM pg_class c
   WHERE c.oid IN ('public.product_rate_units'::regclass, 'public.product_rates'::regclass, 'public.product_rate_draft_events'::regclass)
     AND NOT c.relrowsecurity;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'POSTFLIGHT_FAIL: row security is off on %', v_bad; END IF;
  SELECT string_agg(tablename || '.' || policyname || ':' || cmd || ':' || permissive || ':' || roles::text || ':' || qual
           || ':' || COALESCE(with_check, '-'), ' | ' ORDER BY tablename) INTO v_bad
    FROM pg_policies WHERE schemaname = 'public'
     AND tablename IN ('product_rate_units', 'product_rates', 'product_rate_draft_events');
  IF v_bad IS DISTINCT FROM
       'product_rate_draft_events.product_rate_draft_events_admin_select:SELECT:PERMISSIVE:{authenticated}:( SELECT is_admin() AS is_admin):-'
       || ' | product_rate_units.product_rate_units_select:SELECT:PERMISSIVE:{authenticated}:true:-'
       || ' | product_rates.product_rates_admin_select:SELECT:PERMISSIVE:{authenticated}:( SELECT is_admin() AS is_admin):-' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: the product_rates policies are not the expected ones: %', v_bad;
  END IF;
  SELECT string_agg(DISTINCT g.table_name || ':' || g.grantee || ':' || g.privilege_type, ', ') INTO v_bad
    FROM information_schema.role_table_grants g
   WHERE g.table_schema = 'public' AND g.table_name IN ('product_rate_units', 'product_rates', 'product_rate_draft_events')
     AND g.grantee <> 'postgres' AND NOT (g.grantee = 'authenticated' AND g.privilege_type = 'SELECT');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'POSTFLIGHT_FAIL: unexpected table grants %', v_bad; END IF;
  IF (SELECT count(DISTINCT g.table_name) FROM information_schema.role_table_grants g
       WHERE g.table_schema = 'public' AND g.table_name IN ('product_rate_units', 'product_rates', 'product_rate_draft_events')
         AND g.grantee = 'authenticated' AND g.privilege_type = 'SELECT') <> 3 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: authenticated must read the three product_rates tables';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid IN ('public.product_rate_units'::regclass,
               'public.product_rates'::regclass, 'public.product_rate_draft_events'::regclass) AND a.attacl IS NOT NULL)
     OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) x
                 WHERE c.oid = pg_get_serial_sequence('public.product_rate_draft_events', 'id')::regclass
                   AND pg_get_userbyid(x.grantee) <> 'postgres') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: unexpected column or sequence grants on the product_rates tables';
  END IF;

  -- Functions: owner postgres, SECURITY DEFINER, fixed search_path; EXECUTE only on the four RPCs, to authenticated.
  SELECT string_agg(t.f, ', ') INTO v_bad
    FROM pg_temp.product_rates_draft_fns t LEFT JOIN pg_proc p ON p.oid = to_regprocedure(t.f)
   WHERE p.oid IS NULL OR pg_get_userbyid(p.proowner) <> 'postgres' OR NOT p.prosecdef
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
      OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
                  WHERE x.grantee <> p.proowner AND (t.helper OR pg_get_userbyid(x.grantee) <> 'authenticated'))
      OR (NOT t.helper AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'POSTFLIGHT_FAIL: function owner, mode, search_path or grants wrong on %', v_bad; END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('save_draft_product_rate', 'delete_draft_product_rate', 'derive_draft_product_rates', 'get_parent_draft_rates')) <> 4 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: each of the four RPCs must have exactly one overload';
  END IF;

  -- Units: each legacy spelling is in unit_conversions with the same factor (weight: milligrams -> dry ounces,
  -- rounded to the unit_conversions factor's own decimals), and every products.rate_unit spelling maps once.
  IF (SELECT count(*) FROM public.product_rate_units) <> 9 THEN RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected nine rate units'; END IF;
  SELECT string_agg(r.code || '/' || s, ', ') INTO v_bad
    FROM public.product_rate_units r CROSS JOIN LATERAL unnest(r.legacy_spellings) s
   WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions u WHERE u.unit = s
     AND CASE WHEN r.kind = 'weight' THEN round(r.factor / 28349.523125, scale(u.factor_oz)) = u.factor_oz
              ELSE r.factor = u.factor_oz END);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'POSTFLIGHT_FAIL: rate unit factors differ from unit_conversions for %', v_bad; END IF;
  SELECT string_agg(DISTINCT btrim(p.rate_unit), ', ') INTO v_bad FROM public.products p
   WHERE btrim(COALESCE(p.rate_unit, '')) <> ''
     AND (SELECT count(*) FROM public.product_rate_units r WHERE btrim(p.rate_unit) = ANY (r.legacy_spellings)) <> 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'POSTFLIGHT_FAIL: products.rate_unit spelling(s) not in exactly one rate unit: %', v_bad; END IF;

  -- Nothing else changed.
  IF (SELECT bodies FROM pg_temp.product_rates_draft_tx) IS DISTINCT FROM
     (SELECT jsonb_object_agg(f, md5(row(p.prosrc, p.proconfig, p.prosecdef, p.provolatile, p.proowner, p.proacl,
               p.proargtypes, p.prorettype)::text))
        FROM jsonb_object_keys((SELECT bodies FROM pg_temp.product_rates_draft_tx)) f
        JOIN pg_proc p ON p.oid = to_regprocedure(f)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a function RT-1 must not touch changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_rates) OR EXISTS (SELECT 1 FROM public.product_rate_draft_events) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: RT-1 writes no rate rows';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: product_rates draft tables, rules and functions are in place; no reader changed';
END;
$postflight$;
