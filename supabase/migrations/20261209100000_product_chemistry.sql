-- idempotency-body-check: exempt
-- (Every writer checks its retry key through _product_parent_replay, which calls check_idempotency,
--  and saves its receipt with save_idempotency last, in the same transaction.)
--
-- DM-1 (docs/plans/2026-11-06-product-DM1-BUILD-SHEET.md): active ingredients per parent, plus CMP-1
-- cost per lb of active.
--
-- New tables (owned by postgres; RLS on; SELECT for active users through policies; no write grant
-- for any role; every reference ON DELETE RESTRICT):
--   * active_ingredients: one row per specific chemical form (name, CAS unique across all rows,
--     canonical parent acid, canonical fraction, is_parent_form, status). No merge or alias: a
--     duplicate is replaced on each parent by a correction, then retired (Mason, 2026-11-06).
--   * active_ingredient_events (append-only).
--   * product_parent_ingredients, product_parent_modes_of_action, product_parent_fertilizer_analysis:
--     a parent's chemistry. Non-admins see active rows only.
--   * product_parent_chemistry_state: chemistry_version per parent; every chemistry write is bound to it.
--   * product_chemistry_events (append-only).
--   * product_parent_cost_reference: the size a parent's cost figures come from when it has no active
--     bulk size. Admins only.
-- Changed: ingredient_map (the Brand vs Generic list, 0 rows) is frozen by a row trigger and a TRUNCATE
--   trigger. Its grants and policies are unchanged. Apply only after the read-only
--   Brand vs Generic page (PR #1622) is live, or that page refuses its saves.
-- Functions (SECURITY DEFINER, search_path public, pg_temp; writers admin-only with a retry key):
--   set_parent_chemistry (add rows and fill unknown values only), preview_parent_chemistry_correction,
--   correct_parent_chemistry (change, retire, swap, consolidate; reason and evidence),
--   preview_active_ingredient_change, save_active_ingredient, retire_active_ingredient,
--   reactivate_active_ingredient, set_parent_cost_reference; reads get_parent_chemistry and
--   search_active_ingredients (active users), get_active_ingredient_worklist and get_parent_active_costs
--   (admins). The EPA gate (D-Z) refuses typed chemistry on any parent with a usable EPA number.
-- DM-2 interface: _approved_parent_lb_per_gal is created here as a NULL-returning stub only when it does
--   not exist; when it exists (DM-2 applied first), its contract is checked and it is left alone.
-- No existing row is changed; no grant, revoke or policy on an existing table. New foreign keys add the
--   usual RESTRICT checks on products and product_parents (nothing deletes those rows today).
--
-- Rollback (no existing row changes, so nothing is restored):
--   1. Revert the chemistry screen PR first if it is live, so no screen calls a dropped function.
--   2. KEEP the two ingredient_map triggers and refuse_ingredient_map_write(): the read-only Brand vs
--      Generic page stays, so the list stays frozen.
--   3. DROP (never CASCADE) the public RPCs: set_parent_chemistry, preview_parent_chemistry_correction,
--      correct_parent_chemistry, preview_active_ingredient_change, save_active_ingredient,
--      retire_active_ingredient, reactivate_active_ingredient, set_parent_cost_reference,
--      get_parent_chemistry, search_active_ingredients, get_active_ingredient_worklist,
--      get_parent_active_costs; then the private helpers except _ingredient_cas_valid (the CAS CHECK
--      needs it), refuse_chemistry_event_mutation (the append-only triggers need it) and
--      _approved_parent_lb_per_gal when DM-2 is live.
--   4. Keep the new tables. A later restore is a new reviewed migration over the kept tables; this one
--      is never re-run (its "no DM-1 table exists" preflight stays).

SET LOCAL lock_timeout = '10s';

-- No old page can insert between the empty check and the freeze triggers.
LOCK TABLE public.ingredient_map IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_fn regprocedure := to_regprocedure('public._approved_parent_lb_per_gal(uuid)');
  v_role text;
BEGIN
  IF to_regclass('public.active_ingredients') IS NOT NULL
     OR to_regclass('public.active_ingredient_events') IS NOT NULL
     OR to_regclass('public.product_parent_ingredients') IS NOT NULL
     OR to_regclass('public.product_parent_modes_of_action') IS NOT NULL
     OR to_regclass('public.product_parent_fertilizer_analysis') IS NOT NULL
     OR to_regclass('public.product_parent_chemistry_state') IS NOT NULL
     OR to_regclass('public.product_chemistry_events') IS NOT NULL
     OR to_regclass('public.product_parent_cost_reference') IS NOT NULL
     OR to_regprocedure('public.set_parent_chemistry(uuid,bigint,jsonb,text)') IS NOT NULL
     OR to_regprocedure('public.refuse_ingredient_map_write()') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DM1_ALREADY_PRESENT';
  END IF;
  IF to_regprocedure('public._product_parent_replay(text,text,text)') IS NULL
     OR to_regprocedure('public._product_parent_require_admin()') IS NULL
     OR to_regprocedure('public._product_parent_reason(text,text,boolean)') IS NULL
     OR to_regprocedure('public._normalize_epa_registration(text)') IS NULL
     OR to_regprocedure('public.check_idempotency(text,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_active_profile()') IS NULL
     OR to_regclass('public.product_parents') IS NULL
     OR to_regclass('public.product_parent_members') IS NULL
     OR to_regclass('public.product_parent_brands') IS NULL
     OR to_regclass('public.product_brands') IS NULL
     OR to_regclass('public.unit_conversions') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DM1_DEPENDENCY_MISSING';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_parents'
        AND column_name IN ('id', 'name', 'product_form', 'generic_epa_registration', 'is_active')) <> 5
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_parent_members'
        AND column_name IN ('product_id', 'parent_id', 'size_role')) <> 3
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_parent_brands'
        AND column_name IN ('parent_id', 'epa_registration', 'status')) <> 3
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_brands'
        AND column_name IN ('product_id', 'epa_registration')) <> 2
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products'
        AND column_name IN ('id', 'product_name', 'product_form', 'inventory_unit', 'current_cost', 'is_active',
                            'epa_registration')) <> 7
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'unit_conversions'
        AND column_name IN ('unit', 'unit_type', 'factor_oz')) <> 3 THEN
    RAISE EXCEPTION 'PREFLIGHT_DM1_COLUMNS_CHANGED';
  END IF;
  -- The cost read trusts these two live constraints (whole cents, finite; zero or more) and checks again on read.
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.products'::regclass AND convalidated
        AND conname IN ('products_current_cost_cent_scale_chk', 'chk_product_cost')) <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT_DM1_PRODUCT_COST_CHECKS_MISSING';
  END IF;
  -- Fail closed: a row saved by an old Brand vs Generic tab is Mason's call before a retry.
  IF EXISTS (SELECT 1 FROM public.ingredient_map) THEN
    RAISE EXCEPTION 'PREFLIGHT_DM1_INGREDIENT_MAP_NOT_EMPTY: read the row(s), record them in the PR, and ask Mason';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ingredient_map'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'PREFLIGHT_DM1_INGREDIENT_MAP_HAS_TRIGGERS';
  END IF;
  -- DM-2 applied first: its weight function must match the interface exactly.
  IF v_fn IS NOT NULL THEN
    IF (SELECT p.proargnames IS DISTINCT FROM ARRAY['p_parent_id', 'lb_per_gal', 'weight_row_id']
            OR p.proargmodes IS DISTINCT FROM ARRAY['i', 'o', 'o']::"char"[]
            OR p.proallargtypes IS DISTINCT FROM ARRAY['uuid'::regtype, 'numeric'::regtype, 'uuid'::regtype]::oid[]
            OR p.provolatile <> 's'
            OR NOT p.prosecdef
            OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
            OR p.proowner <> 'postgres'::regrole
            OR p.proacl IS NULL
          FROM pg_proc p WHERE p.oid = v_fn) THEN
      RAISE EXCEPTION 'PREFLIGHT_DM1_DENSITY_INTERFACE_CHANGED: _approved_parent_lb_per_gal does not match the DM-1/DM-2 contract';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                WHERE p.oid = v_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'PREFLIGHT_DM1_DENSITY_INTERFACE_CHANGED: PUBLIC can run _approved_parent_lb_per_gal';
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role)
         AND has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'PREFLIGHT_DM1_DENSITY_INTERFACE_CHANGED: % can run _approved_parent_lb_per_gal', v_role;
      END IF;
    END LOOP;
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- ingredient_map freeze (grants and policies unchanged)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.refuse_ingredient_map_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'INGREDIENT_MAP_RETIRED: the Brand vs Generic list is read-only; record ingredients on the product''s Chemistry section';
END;
$function$;
ALTER FUNCTION public.refuse_ingredient_map_write() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_ingredient_map_write() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER ingredient_map_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.ingredient_map
  FOR EACH ROW EXECUTE FUNCTION public.refuse_ingredient_map_write();
CREATE TRIGGER ingredient_map_no_truncate
  BEFORE TRUNCATE ON public.ingredient_map
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_ingredient_map_write();

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

-- CAS format and check digit: digits before the last, weighted 1, 2, 3 ... from the right, sum mod 10.
CREATE FUNCTION public._ingredient_cas_valid(p_cas text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_digits text;
  v_sum integer := 0;
  v_n integer;
BEGIN
  IF p_cas IS NULL OR p_cas !~ '^[1-9][0-9]{1,6}-[0-9]{2}-[0-9]$' THEN RETURN false; END IF;
  v_digits := replace(left(p_cas, length(p_cas) - 2), '-', '');
  v_n := length(v_digits);
  FOR i IN 1..v_n LOOP
    v_sum := v_sum + (v_n - i + 1) * substr(v_digits, i, 1)::integer;
  END LOOP;
  RETURN v_sum % 10 = right(p_cas, 1)::integer;
END;
$function$;
ALTER FUNCTION public._ingredient_cas_valid(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._ingredient_cas_valid(text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE TABLE public.active_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> '' AND name = btrim(name) AND char_length(name) <= 200),
  name_key text GENERATED ALWAYS AS (lower(regexp_replace(name, '\s+', ' ', 'g'))) STORED,
  cas text CHECK (cas IS NULL OR public._ingredient_cas_valid(cas)),
  canonical_ingredient_id uuid REFERENCES public.active_ingredients(id) ON DELETE RESTRICT,
  -- 'NaN' > 0 is true in PostgreSQL but 'NaN' <= 1 is false, so these refuse NaN and infinity.
  canonical_fraction numeric CHECK (canonical_fraction IS NULL OR (canonical_fraction > 0 AND canonical_fraction <= 1
    AND scale(canonical_fraction) <= 10)),
  fraction_basis text CHECK (fraction_basis IS NULL OR fraction_basis = 'acid_equivalent'),
  is_parent_form boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  retire_reason text CHECK (retire_reason IS NULL OR (btrim(retire_reason) <> '' AND length(retire_reason) <= 1000)),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT active_ingredients_fraction_has_basis CHECK ((canonical_fraction IS NULL) = (fraction_basis IS NULL)),
  CONSTRAINT active_ingredients_fraction_needs_canonical CHECK (canonical_fraction IS NULL OR canonical_ingredient_id IS NOT NULL),
  CONSTRAINT active_ingredients_parent_form_shape CHECK (NOT is_parent_form OR (canonical_ingredient_id IS NULL AND canonical_fraction IS NULL)),
  CONSTRAINT active_ingredients_not_own_parent CHECK (canonical_ingredient_id IS DISTINCT FROM id),
  CONSTRAINT active_ingredients_retire_reason CHECK ((status = 'retired') = (retire_reason IS NOT NULL))
);
ALTER TABLE public.active_ingredients OWNER TO postgres;
CREATE UNIQUE INDEX active_ingredients_cas ON public.active_ingredients (cas);
CREATE INDEX active_ingredients_name_key_idx ON public.active_ingredients (name_key);
CREATE INDEX active_ingredients_canonical_idx ON public.active_ingredients (canonical_ingredient_id);
COMMENT ON TABLE public.active_ingredients IS
  'DM-1: one row per specific chemical form. CAS unique across all rows; no merge or alias. Written only by the DM-1 functions.';

CREATE TABLE public.active_ingredient_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ingredient_id uuid NOT NULL REFERENCES public.active_ingredients(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('created', 'updated', 'retired', 'reactivated')),
  reason text,
  evidence text,
  before_values jsonb,
  after_values jsonb,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.active_ingredient_events OWNER TO postgres;
CREATE INDEX active_ingredient_events_ingredient_idx ON public.active_ingredient_events (ingredient_id, id DESC);

CREATE TABLE public.product_parent_chemistry_state (
  parent_id uuid PRIMARY KEY REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  chemistry_version bigint NOT NULL DEFAULT 0 CHECK (chemistry_version >= 0),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_parent_chemistry_state OWNER TO postgres;

CREATE TABLE public.product_parent_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  ingredient_id uuid NOT NULL REFERENCES public.active_ingredients(id) ON DELETE RESTRICT,
  strength_value numeric,
  strength_unknown boolean NOT NULL DEFAULT false,
  strength_unit text NOT NULL CHECK (strength_unit IN ('pct_ww', 'lb_per_gal')),
  strength_basis text NOT NULL CHECK (strength_basis IN ('active_ingredient', 'acid_equivalent')),
  source text NOT NULL CHECK (source IN ('label', 'sds', 'supplier', 'other', 'epa_lookup')),
  source_note text CHECK (source_note IS NULL OR (source_note = btrim(source_note) AND source_note <> '' AND length(source_note) <= 1000)),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_parent_ingredients_unknown CHECK ((strength_value IS NULL) = strength_unknown),
  CONSTRAINT product_parent_ingredients_strength CHECK (strength_value IS NULL OR (strength_value > 0
    AND strength_value <= CASE strength_unit WHEN 'pct_ww' THEN 100 ELSE 20 END AND scale(strength_value) <= 10))
);
ALTER TABLE public.product_parent_ingredients OWNER TO postgres;
CREATE UNIQUE INDEX product_parent_ingredients_one_active ON public.product_parent_ingredients (parent_id, ingredient_id)
  WHERE status = 'active';
CREATE INDEX product_parent_ingredients_ingredient_idx ON public.product_parent_ingredients (ingredient_id);

CREATE TABLE public.product_parent_modes_of_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  ingredient_id uuid NOT NULL REFERENCES public.active_ingredients(id) ON DELETE RESTRICT,
  scheme text NOT NULL CHECK (scheme IN ('HRAC', 'FRAC', 'IRAC')),
  group_code text NOT NULL CHECK (group_code = upper(btrim(group_code)) AND group_code <> '' AND char_length(group_code) <= 10),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_parent_modes_of_action OWNER TO postgres;
CREATE UNIQUE INDEX product_parent_modes_of_action_one_active
  ON public.product_parent_modes_of_action (parent_id, ingredient_id, scheme, group_code) WHERE status = 'active';
CREATE INDEX product_parent_modes_of_action_ingredient_idx ON public.product_parent_modes_of_action (ingredient_id);

CREATE TABLE public.product_parent_fertilizer_analysis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  nutrient text NOT NULL CHECK (nutrient IN ('N', 'P', 'K', 'S', 'Ca', 'Mg', 'B', 'Cl', 'Co', 'Cu', 'Fe', 'Mn', 'Mo', 'Ni', 'Zn')),
  basis text NOT NULL CHECK (basis IN ('elemental', 'oxide')),
  percent numeric,
  percent_unknown boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source IN ('label', 'sds', 'supplier', 'other', 'epa_lookup')),
  source_note text CHECK (source_note IS NULL OR (source_note = btrim(source_note) AND source_note <> '' AND length(source_note) <= 1000)),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_parent_fertilizer_oxide_p_k CHECK (basis = 'elemental' OR nutrient IN ('P', 'K')),
  CONSTRAINT product_parent_fertilizer_unknown CHECK ((percent IS NULL) = percent_unknown),
  CONSTRAINT product_parent_fertilizer_percent CHECK (percent IS NULL OR (percent > 0 AND percent <= 100 AND scale(percent) <= 10))
);
ALTER TABLE public.product_parent_fertilizer_analysis OWNER TO postgres;
CREATE UNIQUE INDEX product_parent_fertilizer_one_active ON public.product_parent_fertilizer_analysis (parent_id, nutrient)
  WHERE status = 'active';

CREATE TABLE public.product_chemistry_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('set', 'corrected')),
  chemistry_version bigint NOT NULL CHECK (chemistry_version >= 1),
  reason text,
  evidence text,
  before_values jsonb,
  after_values jsonb,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_chemistry_events OWNER TO postgres;
CREATE INDEX product_chemistry_events_parent_idx ON public.product_chemistry_events (parent_id, id DESC);

CREATE TABLE public.product_parent_cost_reference (
  parent_id uuid PRIMARY KEY REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  reference_product_id uuid REFERENCES public.products(id) ON DELETE RESTRICT,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_parent_cost_reference OWNER TO postgres;
CREATE INDEX product_parent_cost_reference_product_idx ON public.product_parent_cost_reference (reference_product_id);

ALTER TABLE public.active_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.active_ingredient_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_parent_chemistry_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_parent_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_parent_modes_of_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_parent_fertilizer_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_chemistry_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_parent_cost_reference ENABLE ROW LEVEL SECURITY;
CREATE POLICY active_ingredients_select ON public.active_ingredients
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY active_ingredient_events_select ON public.active_ingredient_events
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY product_parent_chemistry_state_select ON public.product_parent_chemistry_state
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY product_chemistry_events_select ON public.product_chemistry_events
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY product_parent_ingredients_select ON public.product_parent_ingredients
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()) AND (status = 'active' OR (SELECT public.is_admin())));
CREATE POLICY product_parent_modes_of_action_select ON public.product_parent_modes_of_action
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()) AND (status = 'active' OR (SELECT public.is_admin())));
CREATE POLICY product_parent_fertilizer_analysis_select ON public.product_parent_fertilizer_analysis
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()) AND (status = 'active' OR (SELECT public.is_admin())));
CREATE POLICY product_parent_cost_reference_select ON public.product_parent_cost_reference
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()) AND (SELECT public.is_admin()));
REVOKE ALL ON TABLE public.active_ingredients, public.active_ingredient_events, public.product_parent_chemistry_state,
  public.product_parent_ingredients, public.product_parent_modes_of_action, public.product_parent_fertilizer_analysis,
  public.product_chemistry_events, public.product_parent_cost_reference
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON SEQUENCE public.active_ingredient_events_id_seq, public.product_chemistry_events_id_seq
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.active_ingredients, public.active_ingredient_events, public.product_parent_chemistry_state,
  public.product_parent_ingredients, public.product_parent_modes_of_action, public.product_parent_fertilizer_analysis,
  public.product_chemistry_events, public.product_parent_cost_reference TO authenticated;

CREATE FUNCTION public.refuse_chemistry_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'CHEMISTRY_EVENTS_ARE_APPEND_ONLY';
END;
$function$;
ALTER FUNCTION public.refuse_chemistry_event_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_chemistry_event_mutation() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER active_ingredient_events_append_only
  BEFORE UPDATE OR DELETE ON public.active_ingredient_events
  FOR EACH ROW EXECUTE FUNCTION public.refuse_chemistry_event_mutation();
CREATE TRIGGER active_ingredient_events_no_truncate
  BEFORE TRUNCATE ON public.active_ingredient_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_chemistry_event_mutation();
CREATE TRIGGER product_chemistry_events_append_only
  BEFORE UPDATE OR DELETE ON public.product_chemistry_events
  FOR EACH ROW EXECUTE FUNCTION public.refuse_chemistry_event_mutation();
CREATE TRIGGER product_chemistry_events_no_truncate
  BEFORE TRUNCATE ON public.product_chemistry_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_chemistry_event_mutation();

-- ---------------------------------------------------------------------------------------------
-- Private helpers (no grants: only the DM-1 functions reach them)
-- ---------------------------------------------------------------------------------------------

-- DM-2 interface (sheet section 4): the parent's one approved weight per gallon and its row ID, or NULL
-- for both. Created as a stub only when DM-2 has not applied first; DM-2 CREATE OR REPLACEs the body.
DO $density_stub$
BEGIN
  IF to_regprocedure('public._approved_parent_lb_per_gal(uuid)') IS NULL THEN
    EXECUTE $stub$
      CREATE FUNCTION public._approved_parent_lb_per_gal(p_parent_id uuid, OUT lb_per_gal numeric, OUT weight_row_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $body$
        SELECT NULL::numeric, NULL::uuid;
      $body$
    $stub$;
    ALTER FUNCTION public._approved_parent_lb_per_gal(uuid) OWNER TO postgres;
    REVOKE ALL ON FUNCTION public._approved_parent_lb_per_gal(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
  END IF;
END;
$density_stub$;

-- Ounces per unit of one unit type, BLK-1a's rule (_tote_fill_liquid_oz): case ignored, that type only,
-- 0 < factor < infinity, NULL when spellings disagree.
CREATE FUNCTION public._unit_factor_oz(p_unit text, p_unit_type text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT CASE WHEN count(DISTINCT u.factor_oz) = 1 THEN min(u.factor_oz) END
    FROM public.unit_conversions u
   WHERE lower(u.unit) = lower(btrim(p_unit)) AND u.unit_type = p_unit_type
     AND u.factor_oz > 0 AND u.factor_oz < 'Infinity'::numeric;
$function$;
ALTER FUNCTION public._unit_factor_oz(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._unit_factor_oz(text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- One exact half-up rounding to whole cents of num / den (both > 0). Returns a whole-number string.
CREATE FUNCTION public._cents_half_up(p_num numeric, p_den numeric) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_q numeric;
BEGIN
  IF p_num IS NULL OR p_den IS NULL OR NOT (p_num > 0 AND p_num < 'Infinity'::numeric)
     OR NOT (p_den > 0 AND p_den < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'COST_MATH_INVALID';
  END IF;
  v_q := div(p_num, p_den);
  IF 2 * (p_num - v_q * p_den) >= p_den THEN v_q := v_q + 1; END IF;
  RETURN trim_scale(v_q)::text;
END;
$function$;
ALTER FUNCTION public._cents_half_up(numeric, numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._cents_half_up(numeric, numeric) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- A size's cost per gallon (liquid) or per lb (dry) as an exact fraction {base, num, den, cents},
-- or {reason}. current_cost is dollars per inventory_unit (a legacy numeric-dollar column with live
-- whole-cent and zero-or-more constraints); checked again here, never rounded into shape.
-- shortcut: count units (Ea, Unit) are refused because no liquid or dry product is priced per count today;
-- a count unit needs a net weight per unit, a new interface to add when one appears.
CREATE FUNCTION public._size_cost_per_base(p_current_cost numeric, p_unit text, p_unit_type text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_unit text := lower(btrim(p_unit));
  v_factor numeric;
  v_num numeric;
BEGIN
  IF p_unit_type IS NULL OR p_unit_type NOT IN ('liquid', 'dry') THEN
    RETURN jsonb_build_object('reason', 'FORM_NOT_COSTED');
  END IF;
  IF p_current_cost IS NULL THEN RETURN jsonb_build_object('reason', 'COST_MISSING'); END IF;
  IF p_current_cost = 'NaN'::numeric OR p_current_cost IN ('Infinity'::numeric, '-Infinity'::numeric) OR p_current_cost < 0 THEN
    RETURN jsonb_build_object('reason', 'COST_INVALID');
  END IF;
  IF p_current_cost = 0 THEN RETURN jsonb_build_object('reason', 'COST_MISSING'); END IF;
  IF p_current_cost <> round(p_current_cost, 2) THEN RETURN jsonb_build_object('reason', 'COST_NOT_CENTS'); END IF;
  IF v_unit IS NULL OR v_unit = '' THEN RETURN jsonb_build_object('reason', 'UNIT_UNKNOWN'); END IF;
  -- Metric factors in unit_conversions are truncated (g 0.03527396); metric needs exact factors first (sheet section 4).
  IF v_unit IN ('g', 'mg', 'kg', 'l', 'ml', 'liter', 'litre') THEN RETURN jsonb_build_object('reason', 'UNIT_NOT_SUPPORTED'); END IF;
  IF v_unit IN ('ea', 'each', 'unit')
     OR EXISTS (SELECT 1 FROM public.unit_conversions u WHERE lower(u.unit) = v_unit AND u.unit_type = 'both') THEN
    RETURN jsonb_build_object('reason', 'UNIT_IS_COUNT');
  END IF;
  v_factor := public._unit_factor_oz(p_unit, p_unit_type);
  IF v_factor IS NULL THEN RETURN jsonb_build_object('reason', 'UNIT_UNKNOWN'); END IF;
  -- cost per gal = cost x 128 / oz per unit; cost per lb = cost x 16 / oz per unit.
  v_num := p_current_cost * CASE p_unit_type WHEN 'liquid' THEN 128 ELSE 16 END;
  RETURN jsonb_build_object('base', CASE p_unit_type WHEN 'liquid' THEN 'gal' ELSE 'lb' END,
    'num', v_num, 'den', v_factor, 'cents', public._cents_half_up(v_num * 100, v_factor));
END;
$function$;
ALTER FUNCTION public._size_cost_per_base(numeric, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._size_cost_per_base(numeric, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Oxide to elemental, exact atomic-weight ratios (never rounded decimals):
--   P2O5 -> P = (2 x 30.973762) / (2 x 30.973762 + 5 x 15.999);  K2O -> K = (2 x 39.0983) / (2 x 39.0983 + 15.999).
CREATE FUNCTION public._oxide_factor(p_nutrient text, OUT num numeric, OUT den numeric)
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT CASE p_nutrient WHEN 'P' THEN 2 * 30.973762 WHEN 'K' THEN 2 * 39.0983 END,
         CASE p_nutrient WHEN 'P' THEN 2 * 30.973762 + 5 * 15.999 WHEN 'K' THEN 2 * 39.0983 + 15.999 END;
$function$;
ALTER FUNCTION public._oxide_factor(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._oxide_factor(text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- One-way conversion of an amount of active (num / den): active_ingredient -> acid_equivalent for an
-- ingredient, oxide -> elemental for a nutrient. Returns {basis, num, den}, {basis, reason}, or NULL when
-- no conversion applies. Never the reverse, never across forms, and a missing fraction is a refusal.
CREATE FUNCTION public._chemistry_convert(p_num numeric, p_den numeric, p_from_basis text, p_ingredient_id uuid,
  p_nutrient text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_ing public.active_ingredients;
  v_f record;
BEGIN
  IF p_ingredient_id IS NOT NULL THEN
    IF p_from_basis IS DISTINCT FROM 'active_ingredient' THEN RETURN NULL; END IF;
    SELECT * INTO v_ing FROM public.active_ingredients WHERE id = p_ingredient_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    -- The form IS the acid: its ae figure equals its ai figure by that explicit flag.
    IF v_ing.is_parent_form THEN
      RETURN jsonb_build_object('basis', 'acid_equivalent', 'num', p_num, 'den', p_den);
    END IF;
    IF v_ing.canonical_ingredient_id IS NULL THEN RETURN NULL; END IF;
    IF v_ing.canonical_fraction IS NULL OR v_ing.fraction_basis IS DISTINCT FROM 'acid_equivalent' THEN
      RETURN jsonb_build_object('basis', 'acid_equivalent', 'reason', 'FRACTION_UNKNOWN');
    END IF;
    RETURN jsonb_build_object('basis', 'acid_equivalent', 'num', p_num * v_ing.canonical_fraction, 'den', p_den);
  END IF;
  IF p_from_basis IS DISTINCT FROM 'oxide' THEN RETURN NULL; END IF;
  SELECT * INTO v_f FROM public._oxide_factor(p_nutrient);
  IF v_f.num IS NULL THEN RETURN jsonb_build_object('basis', 'elemental', 'reason', 'NUTRIENT_NOT_OXIDE'); END IF;
  RETURN jsonb_build_object('basis', 'elemental', 'num', p_num * v_f.num, 'den', p_den * v_f.den);
END;
$function$;
ALTER FUNCTION public._chemistry_convert(numeric, numeric, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._chemistry_convert(numeric, numeric, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- The mass of a row's own chemical form, as a lower bound (sheet section 3): an active_ingredient row at its
-- value; an acid_equivalent row at value / fraction (at its value when the form is the acid, or when no
-- fraction is known, since a fraction is never above 1); unknown counts 0. Truncated, never rounded up,
-- so a refusal only ever follows from numbers that prove the total impossible.
CREATE FUNCTION public._chemistry_form_mass(p_value numeric, p_basis text, p_ingredient_id uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT CASE
    WHEN p_value IS NULL THEN 0::numeric
    WHEN p_basis = 'active_ingredient' OR a.is_parent_form OR a.canonical_fraction IS NULL THEN p_value
    ELSE trunc(p_value::numeric(1000, 40) / a.canonical_fraction, 30)
  END
  FROM public.active_ingredients a WHERE a.id = p_ingredient_id;
$function$;
ALTER FUNCTION public._chemistry_form_mass(numeric, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._chemistry_form_mass(numeric, text, uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- D-Z, one gate for every typed chemistry path: NULL when the parent may take typed chemistry, else the
-- refusal listing each usable EPA number (generic, member sizes, active parent brands, members' legacy brands).
-- DM-4 re-issues this helper for its failed-lookup exception.
CREATE FUNCTION public._parent_chemistry_epa_refusal(p_parent_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_numbers text[];
BEGIN
  SELECT array_agg(DISTINCT s.n ORDER BY s.n) INTO v_numbers
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
  IF v_numbers IS NULL THEN RETURN NULL; END IF;
  RETURN format('CHEMISTRY_FROM_EPA_ONLY: this product has EPA number(s) %s; its chemistry comes from the EPA auto-fill',
    array_to_string(v_numbers, ', '));
END;
$function$;
ALTER FUNCTION public._parent_chemistry_epa_refusal(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._parent_chemistry_epa_refusal(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- The lock order every chemistry writer uses (sheet section 3): parent FOR UPDATE (also blocks any concurrent
-- foreign-key insert of a brand or size on it, so the EPA gate never relies on the other writers); member products
-- FOR SHARE in ID order; the chemistry state row (created at version 0 if missing, then FOR UPDATE); then
-- the ingredient-list lock. Refuses a stale expected version. Returns the current version.
CREATE FUNCTION public._lock_parent_chemistry(p_parent_id uuid, p_expected_version bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_name text;
  v_version bigint;
BEGIN
  SELECT name INTO v_name FROM public.product_parents WHERE id = p_parent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.products p
   WHERE p.id IN (SELECT m.product_id FROM public.product_parent_members m WHERE m.parent_id = p_parent_id)
   ORDER BY p.id FOR SHARE;
  INSERT INTO public.product_parent_chemistry_state (parent_id, chemistry_version, updated_by)
  VALUES (p_parent_id, 0, auth.uid()) ON CONFLICT (parent_id) DO NOTHING;
  SELECT chemistry_version INTO v_version FROM public.product_parent_chemistry_state WHERE parent_id = p_parent_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('crx.active_ingredients'));
  IF p_expected_version IS NULL OR v_version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'CHEMISTRY_STALE: the chemistry of "%" changed since you opened it; reload and try again', v_name;
  END IF;
  RETURN v_version;
END;
$function$;
ALTER FUNCTION public._lock_parent_chemistry(uuid, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._lock_parent_chemistry(uuid, bigint) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE FUNCTION public._active_ingredient_values(p public.active_ingredients) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT jsonb_build_object('id', p.id, 'name', p.name, 'cas', p.cas,
    'canonical_ingredient_id', p.canonical_ingredient_id,
    'canonical_name', (SELECT c.name FROM public.active_ingredients c WHERE c.id = p.canonical_ingredient_id),
    'canonical_fraction', p.canonical_fraction, 'fraction_basis', p.fraction_basis,
    'is_parent_form', p.is_parent_form, 'provisional', p.cas IS NULL, 'status', p.status,
    'retire_reason', p.retire_reason, 'row_version', p.row_version);
$function$;
ALTER FUNCTION public._active_ingredient_values(public.active_ingredients) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._active_ingredient_values(public.active_ingredients) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE FUNCTION public._active_ingredient_event(p_ingredient_id uuid, p_type text, p_reason text, p_evidence text,
  p_before jsonb, p_after jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO public.active_ingredient_events (ingredient_id, event_type, reason, evidence, before_values, after_values, changed_by)
  VALUES (p_ingredient_id, p_type, p_reason, p_evidence, p_before, p_after, auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;
ALTER FUNCTION public._active_ingredient_event(uuid, text, text, text, jsonb, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._active_ingredient_event(uuid, text, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- A JSON value that must be a UUID string.
CREATE FUNCTION public._chemistry_uuid(p jsonb, p_label text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'string' OR (p #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'CHEMISTRY_CHANGE_INVALID: % must be an ID', p_label;
  END IF;
  RETURN (p #>> '{}')::uuid;
END;
$function$;
ALTER FUNCTION public._chemistry_uuid(jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._chemistry_uuid(jsonb, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Resolve one ingredient entry to an ingredient ID (D-AA). The entry names an existing ingredient by
-- ingredient_id, or describes a form: name, cas, canonical_ingredient_id, canonical_fraction, fraction_basis,
-- is_parent_form (a JSON null or a missing key means "not stated"). A CAS match reuses that ingredient;
-- name only creates a provisional row (never joined to a same-name row); a stated identity that differs
-- from the match is refused. Takes the ingredient-list lock (re-entrant for chemistry writers).
CREATE FUNCTION public._resolve_active_ingredient(p_entry jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_row public.active_ingredients;
  v_id uuid;
  v_name text;
  v_name_key text;
  v_cas text;
  -- Any non-null value counts as stated, so _chemistry_uuid refuses a non-string by name.
  v_has_canon boolean := COALESCE(jsonb_typeof(p_entry->'canonical_ingredient_id'), 'null') <> 'null';
  v_has_fraction boolean := jsonb_typeof(p_entry->'canonical_fraction') IS NOT NULL AND jsonb_typeof(p_entry->'canonical_fraction') IS DISTINCT FROM 'null';
  v_has_basis boolean := jsonb_typeof(p_entry->'fraction_basis') IS NOT NULL AND jsonb_typeof(p_entry->'fraction_basis') IS DISTINCT FROM 'null';
  v_has_pf boolean := jsonb_typeof(p_entry->'is_parent_form') IS NOT NULL AND jsonb_typeof(p_entry->'is_parent_form') IS DISTINCT FROM 'null';
  v_canon uuid;
  v_fraction numeric;
  v_basis text;
  v_pf boolean := false;
  v_conflict text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('crx.active_ingredients'));
  IF p_entry IS NULL OR jsonb_typeof(p_entry) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INGREDIENT_ENTRY_INVALID: name an ingredient or describe a new one';
  END IF;
  IF p_entry ? 'ingredient_id' AND jsonb_typeof(p_entry->'ingredient_id') IS DISTINCT FROM 'null' THEN
    IF p_entry ?| ARRAY['name', 'cas', 'canonical_ingredient_id', 'canonical_fraction', 'fraction_basis', 'is_parent_form'] THEN
      RAISE EXCEPTION 'INGREDIENT_ENTRY_INVALID: name an existing ingredient by ID or describe a new one, not both';
    END IF;
    v_id := public._chemistry_uuid(p_entry->'ingredient_id', 'ingredient_id');
    SELECT * INTO v_row FROM public.active_ingredients WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'INGREDIENT_NOT_FOUND'; END IF;
    IF v_row.status <> 'active' THEN RAISE EXCEPTION 'INGREDIENT_RETIRED: % was retired; reactivate it', v_row.name; END IF;
    RETURN jsonb_build_object('ingredient_id', v_id, 'reused', true, 'created', false);
  END IF;

  IF jsonb_typeof(p_entry->'name') IS DISTINCT FROM 'string' OR btrim(p_entry->>'name') = '' OR char_length(btrim(p_entry->>'name')) > 200 THEN
    RAISE EXCEPTION 'INGREDIENT_NAME_REQUIRED: give the ingredient''s name (200 characters at most)';
  END IF;
  v_name := btrim(p_entry->>'name');
  v_name_key := lower(regexp_replace(v_name, '\s+', ' ', 'g'));
  IF jsonb_typeof(p_entry->'cas') = 'string' AND btrim(p_entry->>'cas') <> '' THEN
    v_cas := btrim(p_entry->>'cas');
    IF NOT public._ingredient_cas_valid(v_cas) THEN
      RAISE EXCEPTION 'INGREDIENT_CAS_INVALID: % is not a valid CAS number (format or check digit)', v_cas;
    END IF;
  ELSIF p_entry ? 'cas' AND COALESCE(jsonb_typeof(p_entry->'cas'), 'missing') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'INGREDIENT_CAS_INVALID: CAS must be text';
  END IF;
  IF v_has_canon THEN v_canon := public._chemistry_uuid(p_entry->'canonical_ingredient_id', 'canonical_ingredient_id'); END IF;
  IF v_has_fraction THEN
    IF jsonb_typeof(p_entry->'canonical_fraction') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: the fraction must be a number';
    END IF;
    v_fraction := (p_entry->>'canonical_fraction')::numeric;
  END IF;
  IF v_has_basis THEN v_basis := p_entry->>'fraction_basis'; END IF;
  IF v_has_pf THEN
    IF jsonb_typeof(p_entry->'is_parent_form') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: is_parent_form must be true or false';
    END IF;
    v_pf := (p_entry->>'is_parent_form')::boolean;
  END IF;
  -- Shape of what the entry states (the table CHECKs again).
  IF v_has_basis AND v_basis IS DISTINCT FROM 'acid_equivalent' THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: the fraction basis can only be acid_equivalent';
  END IF;
  IF v_has_fraction <> v_has_basis THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: a fraction needs its basis (acid_equivalent), and the basis needs a fraction';
  END IF;
  IF v_has_fraction AND NOT (v_fraction > 0 AND v_fraction <= 1) THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: the fraction must be above 0 and at most 1';
  END IF;
  IF v_has_fraction AND NOT v_has_canon THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: a fraction needs the acid it is measured as';
  END IF;
  IF v_pf AND (v_has_canon OR v_has_fraction) THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: an acid (parent form) has no acid of its own and no fraction';
  END IF;
  IF v_has_canon AND NOT EXISTS (SELECT 1 FROM public.active_ingredients c
                                  WHERE c.id = v_canon AND c.status = 'active' AND c.is_parent_form) THEN
    RAISE EXCEPTION 'INGREDIENT_CANONICAL_INVALID: the acid named must be an active ingredient marked as the acid';
  END IF;

  -- D-AA-1: a CAS match is the same chemical.
  IF v_cas IS NOT NULL THEN
    SELECT * INTO v_row FROM public.active_ingredients WHERE cas = v_cas;
    IF FOUND THEN
      IF v_row.status <> 'active' THEN RAISE EXCEPTION 'INGREDIENT_RETIRED: % was retired; reactivate it', v_row.name; END IF;
      IF v_has_canon AND v_canon IS DISTINCT FROM v_row.canonical_ingredient_id THEN
        RAISE EXCEPTION 'INGREDIENT_PARENT_CONFLICT: CAS % is %, which names a different acid; correct the ingredient instead', v_cas, v_row.name;
      END IF;
      IF (v_has_fraction AND v_fraction IS DISTINCT FROM v_row.canonical_fraction)
         OR (v_has_basis AND v_basis IS DISTINCT FROM v_row.fraction_basis)
         OR (v_has_pf AND v_pf IS DISTINCT FROM v_row.is_parent_form) THEN
        RAISE EXCEPTION 'INGREDIENT_FRACTION_CONFLICT: CAS % is %, whose fraction or acid flag differs; correct the ingredient instead', v_cas, v_row.name;
      END IF;
      RETURN jsonb_build_object('ingredient_id', v_row.id, 'reused', true, 'created', false);
    END IF;
  END IF;

  -- D-AA-3: a same-name ingredient that claims a different acid refuses the entry.
  IF v_has_canon THEN
    SELECT string_agg(a.name, ', ' ORDER BY a.name) INTO v_conflict
      FROM public.active_ingredients a
     WHERE a.status = 'active' AND a.name_key = v_name_key AND a.canonical_ingredient_id IS DISTINCT FROM v_canon;
    IF v_conflict IS NOT NULL THEN
      RAISE EXCEPTION 'INGREDIENT_PARENT_CONFLICT: % already exists with a different acid; correct that ingredient instead', v_conflict;
    END IF;
  END IF;

  INSERT INTO public.active_ingredients (name, cas, canonical_ingredient_id, canonical_fraction, fraction_basis,
    is_parent_form, created_by, updated_by)
  VALUES (v_name, v_cas, v_canon, v_fraction, v_basis, v_pf, auth.uid(), auth.uid())
  RETURNING * INTO v_row;
  PERFORM public._active_ingredient_event(v_row.id, 'created', NULL, NULL, NULL, public._active_ingredient_values(v_row));
  RETURN jsonb_build_object('ingredient_id', v_row.id, 'reused', false, 'created', true);
END;
$function$;
ALTER FUNCTION public._resolve_active_ingredient(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._resolve_active_ingredient(jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- The parent's full live chemistry, as reads and the event log show it (active rows only).
CREATE FUNCTION public._parent_chemistry_values(p_parent_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT jsonb_build_object(
    'ingredients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('row_id', r.id, 'ingredient_id', r.ingredient_id, 'name', a.name, 'cas', a.cas,
          'provisional', a.cas IS NULL, 'is_parent_form', a.is_parent_form,
          'canonical_ingredient_id', a.canonical_ingredient_id,
          'canonical_name', (SELECT c.name FROM public.active_ingredients c WHERE c.id = a.canonical_ingredient_id),
          'canonical_fraction', a.canonical_fraction,
          'strength_value', r.strength_value, 'strength_unknown', r.strength_unknown, 'strength_unit', r.strength_unit,
          'strength_basis', r.strength_basis, 'source', r.source, 'source_note', r.source_note, 'row_version', r.row_version)
        ORDER BY a.name, r.id)
        FROM public.product_parent_ingredients r JOIN public.active_ingredients a ON a.id = r.ingredient_id
       WHERE r.parent_id = p_parent_id AND r.status = 'active'), '[]'::jsonb),
    'modes_of_action', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('row_id', m.id, 'ingredient_id', m.ingredient_id, 'name', a.name,
          'scheme', m.scheme, 'group_code', m.group_code, 'row_version', m.row_version)
        ORDER BY a.name, m.scheme, m.group_code, m.id)
        FROM public.product_parent_modes_of_action m JOIN public.active_ingredients a ON a.id = m.ingredient_id
       WHERE m.parent_id = p_parent_id AND m.status = 'active'), '[]'::jsonb),
    'fertilizer', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('row_id', f.id, 'nutrient', f.nutrient, 'basis', f.basis, 'percent', f.percent,
          'percent_unknown', f.percent_unknown, 'source', f.source, 'source_note', f.source_note, 'row_version', f.row_version)
        ORDER BY f.nutrient, f.id)
        FROM public.product_parent_fertilizer_analysis f
       WHERE f.parent_id = p_parent_id AND f.status = 'active'), '[]'::jsonb));
$function$;
ALTER FUNCTION public._parent_chemistry_values(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._parent_chemistry_values(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- The parent's final state, checked by every writer before it saves (sheet section 3).
CREATE FUNCTION public._check_parent_chemistry(p_parent_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_form text;
  v_names text;
  v_total numeric;
BEGIN
  SELECT product_form INTO v_form FROM public.product_parents WHERE id = p_parent_id;
  SELECT string_agg(a.name, ', ' ORDER BY a.name) INTO v_names
    FROM public.product_parent_ingredients r JOIN public.active_ingredients a ON a.id = r.ingredient_id
   WHERE r.parent_id = p_parent_id AND r.status = 'active' AND r.strength_unit = 'lb_per_gal'
     AND v_form IS DISTINCT FROM 'liquid';
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'CHEMISTRY_UNIT_NOT_FOR_FORM: lb/gal is for liquid products; enter % as %% w/w', v_names;
  END IF;
  SELECT string_agg(a.name, ', ' ORDER BY a.name) INTO v_names
    FROM public.product_parent_ingredients r JOIN public.active_ingredients a ON a.id = r.ingredient_id
   WHERE r.parent_id = p_parent_id AND r.status = 'active' AND r.strength_basis = 'acid_equivalent'
     AND a.canonical_ingredient_id IS NULL AND NOT a.is_parent_form;
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'CHEMISTRY_AE_NEEDS_CANONICAL: % has no acid named, so an acid-equivalent strength cannot be stored', v_names;
  END IF;
  SELECT COALESCE(sum(public._chemistry_form_mass(r.strength_value, r.strength_basis, r.ingredient_id)), 0) INTO v_total
    FROM public.product_parent_ingredients r
   WHERE r.parent_id = p_parent_id AND r.status = 'active' AND r.strength_unit = 'pct_ww';
  IF v_total > 100 THEN
    RAISE EXCEPTION 'CHEMISTRY_TOTAL_IMPOSSIBLE: the ingredients add up to more than 100%% w/w';
  END IF;
  SELECT COALESCE(sum(public._chemistry_form_mass(r.strength_value, r.strength_basis, r.ingredient_id)), 0) INTO v_total
    FROM public.product_parent_ingredients r
   WHERE r.parent_id = p_parent_id AND r.status = 'active' AND r.strength_unit = 'lb_per_gal';
  IF v_total > 20 THEN
    RAISE EXCEPTION 'CHEMISTRY_TOTAL_IMPOSSIBLE: the ingredients add up to more than 20 lb/gal';
  END IF;
  SELECT COALESCE(sum(CASE WHEN f.basis = 'oxide'
                           THEN trunc(f.percent::numeric(1000, 40) * x.num / x.den, 30) ELSE f.percent END), 0) INTO v_total
    FROM public.product_parent_fertilizer_analysis f
    LEFT JOIN LATERAL public._oxide_factor(f.nutrient) x ON true
   WHERE f.parent_id = p_parent_id AND f.status = 'active' AND f.percent IS NOT NULL;
  IF v_total > 100 THEN
    RAISE EXCEPTION 'CHEMISTRY_TOTAL_IMPOSSIBLE: the nutrients add up to more than 100%% (elemental)';
  END IF;
  SELECT string_agg(DISTINCT a.name, ', ') INTO v_names
    FROM public.product_parent_modes_of_action m JOIN public.active_ingredients a ON a.id = m.ingredient_id
   WHERE m.parent_id = p_parent_id AND m.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM public.product_parent_ingredients r
                      WHERE r.parent_id = p_parent_id AND r.ingredient_id = m.ingredient_id AND r.status = 'active');
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'CHEMISTRY_MOA_NEEDS_INGREDIENT: % must be an ingredient of this product before it gets a mode of action', v_names;
  END IF;
END;
$function$;
ALTER FUNCTION public._check_parent_chemistry(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._check_parent_chemistry(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- One ingredient strength statement from an entry: {value, unknown, unit, basis, source, note}.
CREATE FUNCTION public._chemistry_strength(p_entry jsonb, p_mode text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_value numeric;
  v_unit text := p_entry->>'strength_unit';
  v_basis text := p_entry->>'strength_basis';
  v_source text := p_entry->>'source';
  v_note text;
BEGIN
  IF NOT (p_entry ? 'strength_value' AND p_entry ? 'strength_unit' AND p_entry ? 'strength_basis' AND p_entry ? 'source') THEN
    RAISE EXCEPTION 'CHEMISTRY_STRENGTH_INVALID: give strength_value (or null for unknown), strength_unit, strength_basis and source';
  END IF;
  IF jsonb_typeof(p_entry->'strength_value') = 'number' THEN
    v_value := (p_entry->>'strength_value')::numeric;
  ELSIF jsonb_typeof(p_entry->'strength_value') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'CHEMISTRY_STRENGTH_INVALID: the strength must be a number, or null when the label gives none';
  END IF;
  IF v_unit IS NULL OR v_unit NOT IN ('pct_ww', 'lb_per_gal') THEN
    RAISE EXCEPTION 'CHEMISTRY_STRENGTH_INVALID: the strength unit is pct_ww or lb_per_gal';
  END IF;
  IF v_basis IS NULL OR v_basis NOT IN ('active_ingredient', 'acid_equivalent') THEN
    RAISE EXCEPTION 'CHEMISTRY_STRENGTH_INVALID: the strength basis is active_ingredient or acid_equivalent';
  END IF;
  IF v_value IS NOT NULL AND NOT (v_value > 0) THEN
    RAISE EXCEPTION 'CHEMISTRY_STRENGTH_INVALID: a strength must be above 0 (use unknown when the label gives none)';
  END IF;
  IF v_value > (CASE v_unit WHEN 'pct_ww' THEN 100 ELSE 20 END) THEN
    RAISE EXCEPTION 'CHEMISTRY_STRENGTH_INVALID: at most 100%% w/w or 20 lb/gal';
  END IF;
  IF p_mode = 'epa' THEN
    v_source := 'epa_lookup';
  ELSIF v_source IS NULL OR v_source NOT IN ('label', 'sds', 'supplier', 'other') THEN
    RAISE EXCEPTION 'CHEMISTRY_SOURCE_INVALID: the source is label, sds, supplier or other';
  END IF;
  IF COALESCE(jsonb_typeof(p_entry->'source_note'), 'null') NOT IN ('null', 'string') THEN
    RAISE EXCEPTION 'CHEMISTRY_SOURCE_INVALID: the source note must be text';
  END IF;
  IF jsonb_typeof(p_entry->'source_note') = 'string' AND btrim(p_entry->>'source_note') <> '' THEN
    v_note := btrim(p_entry->>'source_note');
    IF length(v_note) > 1000 THEN RAISE EXCEPTION 'CHEMISTRY_SOURCE_INVALID: keep the source note to 1000 characters'; END IF;
  END IF;
  RETURN jsonb_build_object('value', v_value, 'unknown', v_value IS NULL, 'unit', v_unit, 'basis', v_basis,
    'source', v_source, 'note', v_note);
END;
$function$;
ALTER FUNCTION public._chemistry_strength(jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._chemistry_strength(jsonb, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- One fertilizer statement from an entry: {basis, percent, unknown, source, note}.
CREATE FUNCTION public._chemistry_nutrient(p_entry jsonb, p_nutrient text, p_mode text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_percent numeric;
  v_basis text := p_entry->>'basis';
  v_source text := p_entry->>'source';
  v_note text;
BEGIN
  IF NOT (p_entry ? 'percent' AND p_entry ? 'basis' AND p_entry ? 'source') THEN
    RAISE EXCEPTION 'CHEMISTRY_FERTILIZER_INVALID: give percent (or null for unknown), basis and source';
  END IF;
  IF jsonb_typeof(p_entry->'percent') = 'number' THEN
    v_percent := (p_entry->>'percent')::numeric;
  ELSIF jsonb_typeof(p_entry->'percent') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'CHEMISTRY_FERTILIZER_INVALID: the percent must be a number, or null when the label gives none';
  END IF;
  IF v_basis IS NULL OR v_basis NOT IN ('elemental', 'oxide') OR (v_basis = 'oxide' AND p_nutrient NOT IN ('P', 'K')) THEN
    RAISE EXCEPTION 'CHEMISTRY_FERTILIZER_INVALID: the basis is elemental, or oxide for P (P2O5) and K (K2O) only';
  END IF;
  IF v_percent IS NOT NULL AND NOT (v_percent > 0 AND v_percent <= 100) THEN
    RAISE EXCEPTION 'CHEMISTRY_FERTILIZER_INVALID: a percent must be above 0 and at most 100';
  END IF;
  IF p_mode = 'epa' THEN
    v_source := 'epa_lookup';
  ELSIF v_source IS NULL OR v_source NOT IN ('label', 'sds', 'supplier', 'other') THEN
    RAISE EXCEPTION 'CHEMISTRY_SOURCE_INVALID: the source is label, sds, supplier or other';
  END IF;
  IF COALESCE(jsonb_typeof(p_entry->'source_note'), 'null') NOT IN ('null', 'string') THEN
    RAISE EXCEPTION 'CHEMISTRY_SOURCE_INVALID: the source note must be text';
  END IF;
  IF jsonb_typeof(p_entry->'source_note') = 'string' AND btrim(p_entry->>'source_note') <> '' THEN
    v_note := btrim(p_entry->>'source_note');
    IF length(v_note) > 1000 THEN RAISE EXCEPTION 'CHEMISTRY_SOURCE_INVALID: keep the source note to 1000 characters'; END IF;
  END IF;
  RETURN jsonb_build_object('percent', v_percent, 'unknown', v_percent IS NULL, 'basis', v_basis, 'source', v_source, 'note', v_note);
END;
$function$;
ALTER FUNCTION public._chemistry_nutrient(jsonb, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._chemistry_nutrient(jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- The one chemistry writer. Every public chemistry RPC, and later DM-4 and DM-1b, call it inside their own
-- transaction AFTER _lock_parent_chemistry; it has no retry key of its own.
--   p_mode 'set':     add rows and fill unknown values only (action absent or 'add').
--   p_mode 'correct': change, retire, swap, consolidate (reason and evidence come from the caller).
--   p_mode 'epa':     DM-4's commit of a successful lookup: adds and fills with source epa_lookup, never
--                     changes or retires a typed row (CHEMISTRY_TYPED_ROW_KEPT, D-L). No EPA gate.
-- The EPA gate (D-Z) and the inactive-parent rule are applied here for 'set' and 'correct'.
CREATE FUNCTION public._apply_parent_chemistry(p_parent_id uuid, p_changes jsonb, p_mode text, p_reason text, p_evidence text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_parent record;
  v_version bigint;
  v_gate text;
  v_before jsonb;
  v_after jsonb;
  v_entry jsonb;
  v_ord bigint;
  v_kind text;
  v_action text;
  v_refs jsonb := '{}'::jsonb;
  v_resolved jsonb := '{}'::jsonb;
  v_created jsonb := '[]'::jsonb;
  v_res jsonb;
  v_touched text[] := '{}';
  v_keys text[];
  v_ing uuid;
  v_row public.product_parent_ingredients;
  v_into public.product_parent_ingredients;
  v_moa public.product_parent_modes_of_action;
  v_fert public.product_parent_fertilizer_analysis;
  v_s jsonb;
  v_scheme text;
  v_code text;
  v_nutrient text;
  v_changed boolean := false;
  v_event bigint;
  c_identity CONSTANT text[] := ARRAY['ingredient_id', 'ref', 'name', 'cas', 'canonical_ingredient_id',
    'canonical_fraction', 'fraction_basis', 'is_parent_form'];
  c_strength CONSTANT text[] := ARRAY['strength_value', 'strength_unit', 'strength_basis', 'source', 'source_note'];
  c_nutrient CONSTANT text[] := ARRAY['basis', 'percent', 'source', 'source_note'];
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_mode NOT IN ('set', 'correct', 'epa') THEN RAISE EXCEPTION 'CHEMISTRY_MODE_INVALID'; END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_changes) = 0 THEN
    RAISE EXCEPTION 'CHEMISTRY_EMPTY: nothing to save';
  END IF;
  IF jsonb_array_length(p_changes) > 200 THEN RAISE EXCEPTION 'CHEMISTRY_CHANGE_INVALID: at most 200 changes in one save'; END IF;
  SELECT id, name, product_form, is_active INTO v_parent FROM public.product_parents WHERE id = p_parent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  SELECT chemistry_version INTO v_version FROM public.product_parent_chemistry_state WHERE parent_id = p_parent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHEMISTRY_NOT_LOCKED: lock the parent''s chemistry first'; END IF;
  v_before := public._parent_chemistry_values(p_parent_id);
  IF p_mode <> 'epa' THEN v_gate := public._parent_chemistry_epa_refusal(p_parent_id); END IF;

  -- Shape, actions, refs: all checked before any write.
  FOR v_entry, v_ord IN SELECT e, o FROM jsonb_array_elements(p_changes) WITH ORDINALITY AS t(e, o) LOOP
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'CHEMISTRY_CHANGE_INVALID: each change is an object'; END IF;
    v_kind := v_entry->>'kind';
    v_action := COALESCE(v_entry->>'action', 'add');
    IF v_kind IS NULL OR v_kind NOT IN ('ingredient', 'mode_of_action', 'fertilizer') THEN
      RAISE EXCEPTION 'CHEMISTRY_CHANGE_INVALID: kind is ingredient, mode_of_action or fertilizer';
    END IF;
    IF p_mode IN ('set', 'epa') AND v_action <> 'add' THEN
      RAISE EXCEPTION 'CHEMISTRY_CHANGE_NEEDS_CORRECTION: changing, retiring or swapping a row needs a correction with reason and evidence';
    END IF;
    IF p_mode = 'correct' AND (v_action NOT IN ('change', 'retire', 'swap', 'consolidate')
        OR (v_kind = 'mode_of_action' AND v_action <> 'retire')
        OR (v_kind = 'fertilizer' AND v_action NOT IN ('change', 'retire'))) THEN
      RAISE EXCEPTION 'CHEMISTRY_CHANGE_INVALID: a correction changes, retires, swaps or consolidates rows; add new rows with fast entry';
    END IF;
    v_keys := CASE
      WHEN v_kind = 'ingredient' AND v_action = 'add' THEN c_identity || c_strength
      WHEN v_kind = 'ingredient' AND v_action = 'change' THEN ARRAY['row_id'] || c_strength
      WHEN v_action = 'retire' THEN ARRAY['row_id']
      WHEN v_kind = 'ingredient' AND v_action = 'swap' THEN ARRAY['row_id'] || c_identity
      WHEN v_kind = 'ingredient' AND v_action = 'consolidate' THEN ARRAY['row_id', 'into_row_id'] || c_strength
      WHEN v_kind = 'mode_of_action' THEN ARRAY['ingredient_id', 'ingredient_ref', 'scheme', 'group_code']
      WHEN v_kind = 'fertilizer' AND v_action = 'add' THEN ARRAY['nutrient'] || c_nutrient
      ELSE ARRAY['row_id'] || c_nutrient END;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_entry) k WHERE k NOT IN ('kind', 'action') AND k <> ALL (v_keys)) THEN
      RAISE EXCEPTION 'CHEMISTRY_CHANGE_INVALID: unexpected field(s) % on a % % change',
        (SELECT string_agg(k, ', ') FROM jsonb_object_keys(v_entry) k WHERE k NOT IN ('kind', 'action') AND k <> ALL (v_keys)),
        v_kind, v_action;
    END IF;
    IF v_entry ? 'ref' THEN
      IF jsonb_typeof(v_entry->'ref') IS DISTINCT FROM 'string' OR btrim(v_entry->>'ref') = '' OR v_entry ? 'ingredient_id' THEN
        RAISE EXCEPTION 'CHEMISTRY_REF_INVALID: ref is a short label on a new ingredient';
      END IF;
      IF v_refs ? (v_entry->>'ref') THEN RAISE EXCEPTION 'CHEMISTRY_REF_DUPLICATE: ref "%" is used twice', v_entry->>'ref'; END IF;
      v_refs := v_refs || jsonb_build_object(v_entry->>'ref', v_ord);
    END IF;
    -- D-Z: on a gated parent only a typed row may be retired; on an inactive parent nothing new or changed.
    IF v_gate IS NOT NULL AND NOT (p_mode = 'correct' AND v_action = 'retire' AND v_kind <> 'mode_of_action') THEN
      RAISE EXCEPTION '%', v_gate;
    END IF;
    IF NOT v_parent.is_active AND NOT (p_mode = 'correct' AND v_action IN ('retire', 'swap', 'consolidate')) THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_INACTIVE: "%" is inactive; only swaps, consolidations and retirements are allowed', v_parent.name;
    END IF;
  END LOOP;
  FOR v_entry IN SELECT e FROM jsonb_array_elements(p_changes) e WHERE e ? 'ingredient_ref' LOOP
    IF jsonb_typeof(v_entry->'ingredient_ref') IS DISTINCT FROM 'string' OR NOT v_refs ? (v_entry->>'ingredient_ref') OR v_entry ? 'ingredient_id' THEN
      RAISE EXCEPTION 'CHEMISTRY_REF_UNKNOWN: ingredient_ref "%" names no new ingredient in this save', v_entry->>'ingredient_ref';
    END IF;
  END LOOP;

  -- Resolve every ingredient named on an add or swap, new forms in sorted (CAS, then name) order (D-AA-4).
  FOR v_entry, v_ord IN
    SELECT e, o FROM jsonb_array_elements(p_changes) WITH ORDINALITY AS t(e, o)
     WHERE e->>'kind' = 'ingredient' AND COALESCE(e->>'action', 'add') IN ('add', 'swap')
     ORDER BY (e ? 'ingredient_id') DESC, btrim(e->>'cas') NULLS LAST,
              lower(regexp_replace(btrim(e->>'name'), '\s+', ' ', 'g')), o
  LOOP
    v_res := public._resolve_active_ingredient(v_entry - ARRAY['kind', 'action', 'row_id', 'ref'] - c_strength);
    v_resolved := v_resolved || jsonb_build_object(v_ord::text, v_res->'ingredient_id');
    IF (v_res->>'created')::boolean THEN
      v_created := v_created || jsonb_build_array(jsonb_build_object('ref', v_entry->>'ref', 'ingredient_id', v_res->'ingredient_id'));
    END IF;
    IF v_entry ? 'ref' THEN v_refs := v_refs || jsonb_build_object(v_entry->>'ref', v_res->'ingredient_id'); END IF;
  END LOOP;

  FOR v_entry, v_ord IN SELECT e, o FROM jsonb_array_elements(p_changes) WITH ORDINALITY AS t(e, o) LOOP
    v_kind := v_entry->>'kind';
    v_action := COALESCE(v_entry->>'action', 'add');

    IF v_kind = 'ingredient' AND v_action IN ('change', 'retire', 'swap', 'consolidate') THEN
      SELECT * INTO v_row FROM public.product_parent_ingredients
       WHERE id = public._chemistry_uuid(v_entry->'row_id', 'row_id') AND parent_id = p_parent_id AND status = 'active' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'CHEMISTRY_ROW_NOT_FOUND: that ingredient row is not active on this product; reload'; END IF;
      IF v_gate IS NOT NULL AND v_row.source = 'epa_lookup' THEN RAISE EXCEPTION '%', v_gate; END IF;
      v_touched := v_touched || ('row:' || v_row.id) || ('ing:' || v_row.ingredient_id);
    END IF;

    IF v_kind = 'ingredient' AND v_action = 'add' THEN
      v_ing := (v_resolved->>(v_ord::text))::uuid;
      v_touched := v_touched || ('ing:' || v_ing);
      v_s := public._chemistry_strength(v_entry, p_mode);
      SELECT * INTO v_row FROM public.product_parent_ingredients
       WHERE parent_id = p_parent_id AND ingredient_id = v_ing AND status = 'active' FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO public.product_parent_ingredients (parent_id, ingredient_id, strength_value, strength_unknown, strength_unit,
          strength_basis, source, source_note, created_by, updated_by)
        VALUES (p_parent_id, v_ing, (v_s->>'value')::numeric, (v_s->>'unknown')::boolean, v_s->>'unit', v_s->>'basis',
          v_s->>'source', v_s->>'note', v_actor, v_actor);
        v_changed := true;
      ELSIF v_row.strength_unknown AND (v_s->>'value') IS NOT NULL THEN
        IF p_mode = 'epa' AND v_row.source <> 'epa_lookup' THEN
          RAISE EXCEPTION 'CHEMISTRY_TYPED_ROW_KEPT: % was typed in; the EPA value goes to review', (SELECT name FROM public.active_ingredients WHERE id = v_ing);
        END IF;
        -- A typed fill sets the value only: a different unit, basis, source or note is a correction (sheet section 3).
        IF p_mode <> 'epa' AND (v_row.strength_unit IS DISTINCT FROM v_s->>'unit' OR v_row.strength_basis IS DISTINCT FROM v_s->>'basis'
            OR v_row.source IS DISTINCT FROM v_s->>'source' OR (v_s->>'note' IS NOT NULL AND v_row.source_note IS DISTINCT FROM v_s->>'note')) THEN
          RAISE EXCEPTION 'CHEMISTRY_CHANGE_NEEDS_CORRECTION: filling the unknown strength of % keeps its unit, basis and source; change those with a correction',
            (SELECT name FROM public.active_ingredients WHERE id = v_ing);
        END IF;
        UPDATE public.product_parent_ingredients
           SET strength_value = (v_s->>'value')::numeric, strength_unknown = false, strength_unit = v_s->>'unit',
               strength_basis = v_s->>'basis', source = v_s->>'source',
               source_note = CASE WHEN p_mode = 'epa' THEN v_s->>'note' ELSE COALESCE(v_s->>'note', source_note) END,
               row_version = row_version + 1, updated_by = v_actor, updated_at = now()
         WHERE id = v_row.id;
        v_changed := true;
      ELSIF p_mode = 'epa' AND v_row.strength_value IS NOT DISTINCT FROM (v_s->>'value')::numeric
            AND v_row.strength_unit = v_s->>'unit' AND v_row.strength_basis = v_s->>'basis' THEN
        NULL; -- the lookup agrees with what is stored
      ELSIF p_mode = 'epa' AND v_row.source <> 'epa_lookup' THEN
        RAISE EXCEPTION 'CHEMISTRY_TYPED_ROW_KEPT: % was typed in; the EPA value goes to review', (SELECT name FROM public.active_ingredients WHERE id = v_ing);
      ELSE
        RAISE EXCEPTION 'CHEMISTRY_CHANGE_NEEDS_CORRECTION: % is already on this product; change it with a correction',
          (SELECT name FROM public.active_ingredients WHERE id = v_ing);
      END IF;

    ELSIF v_kind = 'ingredient' AND v_action = 'change' THEN
      v_s := public._chemistry_strength(v_entry, p_mode);
      IF v_row.strength_value IS NOT DISTINCT FROM (v_s->>'value')::numeric AND v_row.strength_unit = v_s->>'unit'
         AND v_row.strength_basis = v_s->>'basis' AND v_row.source = v_s->>'source'
         AND v_row.source_note IS NOT DISTINCT FROM v_s->>'note' THEN
        RAISE EXCEPTION 'CHEMISTRY_NO_CHANGE: nothing differs on that ingredient row';
      END IF;
      UPDATE public.product_parent_ingredients
         SET strength_value = (v_s->>'value')::numeric, strength_unknown = (v_s->>'unknown')::boolean, strength_unit = v_s->>'unit',
             strength_basis = v_s->>'basis', source = v_s->>'source', source_note = v_s->>'note',
             row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE id = v_row.id;
      v_changed := true;

    ELSIF v_kind = 'ingredient' AND v_action = 'retire' THEN
      UPDATE public.product_parent_ingredients SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE id = v_row.id;
      UPDATE public.product_parent_modes_of_action SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE parent_id = p_parent_id AND ingredient_id = v_row.ingredient_id AND status = 'active';
      v_changed := true;

    ELSIF v_kind = 'ingredient' AND v_action = 'swap' THEN
      v_ing := (v_resolved->>(v_ord::text))::uuid;
      IF v_ing = v_row.ingredient_id THEN RAISE EXCEPTION 'CHEMISTRY_NO_CHANGE: that row already uses this ingredient'; END IF;
      IF EXISTS (SELECT 1 FROM public.product_parent_ingredients WHERE parent_id = p_parent_id AND ingredient_id = v_ing AND status = 'active') THEN
        RAISE EXCEPTION 'INGREDIENT_ALREADY_ON_PARENT: % is already on this product; consolidate the two rows instead',
          (SELECT name FROM public.active_ingredients WHERE id = v_ing);
      END IF;
      v_touched := v_touched || ('ing:' || v_ing);
      UPDATE public.product_parent_ingredients SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE id = v_row.id;
      INSERT INTO public.product_parent_ingredients (parent_id, ingredient_id, strength_value, strength_unknown, strength_unit,
        strength_basis, source, source_note, created_by, updated_by)
      VALUES (p_parent_id, v_ing, v_row.strength_value, v_row.strength_unknown, v_row.strength_unit, v_row.strength_basis,
        v_row.source, v_row.source_note, v_actor, v_actor);
      -- The swap carries the row's modes of action to the new ingredient.
      FOR v_moa IN SELECT * FROM public.product_parent_modes_of_action
                    WHERE parent_id = p_parent_id AND ingredient_id = v_row.ingredient_id AND status = 'active' ORDER BY id FOR UPDATE LOOP
        UPDATE public.product_parent_modes_of_action SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
         WHERE id = v_moa.id;
        INSERT INTO public.product_parent_modes_of_action (parent_id, ingredient_id, scheme, group_code, created_by, updated_by)
        VALUES (p_parent_id, v_ing, v_moa.scheme, v_moa.group_code, v_actor, v_actor)
        ON CONFLICT (parent_id, ingredient_id, scheme, group_code) WHERE status = 'active' DO NOTHING;
      END LOOP;
      v_changed := true;

    ELSIF v_kind = 'ingredient' AND v_action = 'consolidate' THEN
      SELECT * INTO v_into FROM public.product_parent_ingredients
       WHERE id = public._chemistry_uuid(v_entry->'into_row_id', 'into_row_id') AND parent_id = p_parent_id AND status = 'active' FOR UPDATE;
      IF NOT FOUND OR v_into.id = v_row.id THEN
        RAISE EXCEPTION 'CHEMISTRY_ROW_NOT_FOUND: the row to keep must be another active ingredient row of this product; reload';
      END IF;
      IF v_gate IS NOT NULL THEN RAISE EXCEPTION '%', v_gate; END IF;
      v_touched := v_touched || ('row:' || v_into.id) || ('ing:' || v_into.ingredient_id);
      v_s := public._chemistry_strength(v_entry, p_mode);
      UPDATE public.product_parent_ingredients SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE id = v_row.id;
      UPDATE public.product_parent_ingredients
         SET strength_value = (v_s->>'value')::numeric, strength_unknown = (v_s->>'unknown')::boolean, strength_unit = v_s->>'unit',
             strength_basis = v_s->>'basis', source = v_s->>'source', source_note = v_s->>'note',
             row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE id = v_into.id;
      -- Every mode of action of the duplicate moves to the kept ingredient (one already there is not doubled).
      FOR v_moa IN SELECT * FROM public.product_parent_modes_of_action
                    WHERE parent_id = p_parent_id AND ingredient_id = v_row.ingredient_id AND status = 'active' ORDER BY id FOR UPDATE LOOP
        UPDATE public.product_parent_modes_of_action SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
         WHERE id = v_moa.id;
        INSERT INTO public.product_parent_modes_of_action (parent_id, ingredient_id, scheme, group_code, created_by, updated_by)
        VALUES (p_parent_id, v_into.ingredient_id, v_moa.scheme, v_moa.group_code, v_actor, v_actor)
        ON CONFLICT (parent_id, ingredient_id, scheme, group_code) WHERE status = 'active' DO NOTHING;
      END LOOP;
      v_changed := true;

    ELSIF v_kind = 'mode_of_action' AND v_action = 'add' THEN
      IF v_entry ? 'ingredient_ref' THEN
        v_ing := (v_refs->>(v_entry->>'ingredient_ref'))::uuid;
      ELSE
        v_ing := public._chemistry_uuid(v_entry->'ingredient_id', 'ingredient_id');
      END IF;
      v_scheme := v_entry->>'scheme';
      v_code := upper(btrim(v_entry->>'group_code'));
      IF v_scheme IS NULL OR v_scheme NOT IN ('HRAC', 'FRAC', 'IRAC') OR v_code IS NULL OR v_code = '' OR char_length(v_code) > 10 THEN
        RAISE EXCEPTION 'CHEMISTRY_MOA_INVALID: scheme is HRAC, FRAC or IRAC and the group code is 1 to 10 characters';
      END IF;
      v_touched := v_touched || ('moa:' || v_ing || ':' || v_scheme || ':' || v_code);
      IF EXISTS (SELECT 1 FROM public.product_parent_modes_of_action WHERE parent_id = p_parent_id AND ingredient_id = v_ing
                  AND scheme = v_scheme AND group_code = v_code AND status = 'active') THEN
        IF p_mode <> 'epa' THEN RAISE EXCEPTION 'CHEMISTRY_ROW_EXISTS: that mode of action is already recorded'; END IF;
      ELSE
        INSERT INTO public.product_parent_modes_of_action (parent_id, ingredient_id, scheme, group_code, created_by, updated_by)
        VALUES (p_parent_id, v_ing, v_scheme, v_code, v_actor, v_actor);
        v_changed := true;
      END IF;

    ELSIF v_kind = 'mode_of_action' AND v_action = 'retire' THEN
      SELECT * INTO v_moa FROM public.product_parent_modes_of_action
       WHERE id = public._chemistry_uuid(v_entry->'row_id', 'row_id') AND parent_id = p_parent_id AND status = 'active' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'CHEMISTRY_ROW_NOT_FOUND: that mode of action is not active on this product; reload'; END IF;
      v_touched := v_touched || ('moa:' || v_moa.ingredient_id || ':' || v_moa.scheme || ':' || v_moa.group_code);
      UPDATE public.product_parent_modes_of_action SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
       WHERE id = v_moa.id;
      v_changed := true;

    ELSIF v_kind = 'fertilizer' AND v_action = 'add' THEN
      v_nutrient := v_entry->>'nutrient';
      IF v_nutrient IS NULL OR v_nutrient NOT IN ('N', 'P', 'K', 'S', 'Ca', 'Mg', 'B', 'Cl', 'Co', 'Cu', 'Fe', 'Mn', 'Mo', 'Ni', 'Zn') THEN
        RAISE EXCEPTION 'CHEMISTRY_FERTILIZER_INVALID: nutrient is one of N, P, K, S, Ca, Mg, B, Cl, Co, Cu, Fe, Mn, Mo, Ni, Zn';
      END IF;
      v_touched := v_touched || ('fert:' || v_nutrient);
      v_s := public._chemistry_nutrient(v_entry, v_nutrient, p_mode);
      SELECT * INTO v_fert FROM public.product_parent_fertilizer_analysis
       WHERE parent_id = p_parent_id AND nutrient = v_nutrient AND status = 'active' FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO public.product_parent_fertilizer_analysis (parent_id, nutrient, basis, percent, percent_unknown, source,
          source_note, created_by, updated_by)
        VALUES (p_parent_id, v_nutrient, v_s->>'basis', (v_s->>'percent')::numeric, (v_s->>'unknown')::boolean, v_s->>'source',
          v_s->>'note', v_actor, v_actor);
        v_changed := true;
      ELSIF v_fert.percent_unknown AND (v_s->>'percent') IS NOT NULL THEN
        IF p_mode = 'epa' AND v_fert.source <> 'epa_lookup' THEN
          RAISE EXCEPTION 'CHEMISTRY_TYPED_ROW_KEPT: % was typed in; the EPA value goes to review', v_nutrient;
        END IF;
        IF p_mode <> 'epa' AND (v_fert.basis IS DISTINCT FROM v_s->>'basis' OR v_fert.source IS DISTINCT FROM v_s->>'source'
            OR (v_s->>'note' IS NOT NULL AND v_fert.source_note IS DISTINCT FROM v_s->>'note')) THEN
          RAISE EXCEPTION 'CHEMISTRY_CHANGE_NEEDS_CORRECTION: filling the unknown % keeps its basis and source; change those with a correction', v_nutrient;
        END IF;
        UPDATE public.product_parent_fertilizer_analysis
           SET basis = v_s->>'basis', percent = (v_s->>'percent')::numeric, percent_unknown = false, source = v_s->>'source',
               source_note = CASE WHEN p_mode = 'epa' THEN v_s->>'note' ELSE COALESCE(v_s->>'note', source_note) END, row_version = row_version + 1, updated_by = v_actor, updated_at = now()
         WHERE id = v_fert.id;
        v_changed := true;
      ELSIF p_mode = 'epa' AND v_fert.percent IS NOT DISTINCT FROM (v_s->>'percent')::numeric AND v_fert.basis = v_s->>'basis' THEN
        NULL;
      ELSIF p_mode = 'epa' AND v_fert.source <> 'epa_lookup' THEN
        RAISE EXCEPTION 'CHEMISTRY_TYPED_ROW_KEPT: % was typed in; the EPA value goes to review', v_nutrient;
      ELSE
        RAISE EXCEPTION 'CHEMISTRY_CHANGE_NEEDS_CORRECTION: % is already recorded; change it with a correction', v_nutrient;
      END IF;

    ELSE -- fertilizer change or retire
      SELECT * INTO v_fert FROM public.product_parent_fertilizer_analysis
       WHERE id = public._chemistry_uuid(v_entry->'row_id', 'row_id') AND parent_id = p_parent_id AND status = 'active' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'CHEMISTRY_ROW_NOT_FOUND: that nutrient row is not active on this product; reload'; END IF;
      IF v_gate IS NOT NULL AND v_fert.source = 'epa_lookup' THEN RAISE EXCEPTION '%', v_gate; END IF;
      v_touched := v_touched || ('fert:' || v_fert.nutrient);
      IF v_action = 'retire' THEN
        UPDATE public.product_parent_fertilizer_analysis SET status = 'retired', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
         WHERE id = v_fert.id;
      ELSE
        v_s := public._chemistry_nutrient(v_entry, v_fert.nutrient, p_mode);
        IF v_fert.percent IS NOT DISTINCT FROM (v_s->>'percent')::numeric AND v_fert.basis = v_s->>'basis'
           AND v_fert.source = v_s->>'source' AND v_fert.source_note IS NOT DISTINCT FROM v_s->>'note' THEN
          RAISE EXCEPTION 'CHEMISTRY_NO_CHANGE: nothing differs on that nutrient row';
        END IF;
        UPDATE public.product_parent_fertilizer_analysis
           SET basis = v_s->>'basis', percent = (v_s->>'percent')::numeric, percent_unknown = (v_s->>'unknown')::boolean,
               source = v_s->>'source', source_note = v_s->>'note', row_version = row_version + 1, updated_by = v_actor, updated_at = now()
         WHERE id = v_fert.id;
      END IF;
      v_changed := true;
    END IF;

    IF (SELECT count(*) <> count(DISTINCT t) FROM unnest(v_touched) t) THEN
      RAISE EXCEPTION 'CHEMISTRY_DUPLICATE_CHANGE: two changes in this save touch the same row or ingredient';
    END IF;
  END LOOP;

  IF NOT v_changed THEN
    RETURN jsonb_build_object('parent_id', p_parent_id, 'changed', false, 'chemistry_version', v_version,
      'created_ingredients', v_created);
  END IF;
  PERFORM public._check_parent_chemistry(p_parent_id);
  v_after := public._parent_chemistry_values(p_parent_id);
  UPDATE public.product_parent_chemistry_state
     SET chemistry_version = v_version + 1, updated_by = v_actor, updated_at = now()
   WHERE parent_id = p_parent_id;
  INSERT INTO public.product_chemistry_events (parent_id, event_type, chemistry_version, reason, evidence, before_values,
    after_values, changed_by)
  VALUES (p_parent_id, CASE p_mode WHEN 'correct' THEN 'corrected' ELSE 'set' END, v_version + 1, p_reason, p_evidence,
    v_before, v_after || jsonb_build_object('source_path', p_mode), v_actor)
  RETURNING id INTO v_event;
  RETURN jsonb_build_object('parent_id', p_parent_id, 'changed', true, 'chemistry_version', v_version + 1,
    'event_id', v_event, 'created_ingredients', v_created, 'chemistry', v_after);
END;
$function$;
ALTER FUNCTION public._apply_parent_chemistry(uuid, jsonb, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._apply_parent_chemistry(uuid, jsonb, text, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- CMP-1 (sheet section 4): the parent's cost per lb of active, per size and for the reference size.
-- Exact numeric fractions throughout; one half-up rounding to whole cents on each final figure; cents are
-- whole-number strings. STABLE, so every read inside sees one snapshot.
CREATE FUNCTION public._parent_active_cost_rows(p_parent_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent record;
  v_version bigint;
  v_lb_per_gal numeric;
  v_weight_row uuid;
  v_density_reason text;
  v_exceeds boolean := false;
  v_ref uuid;
  v_ref_source text;
  v_ref_reason text;
  v_ref_row record;
  v_size record;
  v_form text;
  v_cost jsonb;
  v_figures jsonb;
  v_sizes jsonb := '[]'::jsonb;
  v_parent_figures jsonb;
  v_r record;
  v_reason text;
  v_num numeric;
  v_den numeric;
  v_used_weight uuid;
  v_conv jsonb;
  v_fig jsonb;
BEGIN
  SELECT id, name, product_form, is_active INTO v_parent FROM public.product_parents WHERE id = p_parent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  v_version := COALESCE((SELECT chemistry_version FROM public.product_parent_chemistry_state WHERE parent_id = p_parent_id), 0);

  -- DM-2's approved weight per gallon, used only when finite, above 0, at most 20 and with its row ID.
  SELECT d.lb_per_gal, d.weight_row_id INTO v_lb_per_gal, v_weight_row FROM public._approved_parent_lb_per_gal(p_parent_id) d;
  IF v_lb_per_gal IS NULL AND v_weight_row IS NULL THEN
    v_density_reason := 'DENSITY_NOT_APPROVED';
  ELSIF v_lb_per_gal IS NULL OR v_weight_row IS NULL OR v_lb_per_gal = 'NaN'::numeric
        OR NOT (v_lb_per_gal > 0 AND v_lb_per_gal <= 20) THEN
    v_density_reason := 'DENSITY_INVALID';
  ELSE
    -- The form mass of every ingredient row (lower bounds included) may not exceed the product's weight.
    v_exceeds := (SELECT COALESCE(sum(CASE r.strength_unit
                     WHEN 'lb_per_gal' THEN public._chemistry_form_mass(r.strength_value, r.strength_basis, r.ingredient_id)
                     ELSE public._chemistry_form_mass(r.strength_value, r.strength_basis, r.ingredient_id) * v_lb_per_gal * 0.01 END), 0)
                    FROM public.product_parent_ingredients r
                   WHERE r.parent_id = p_parent_id AND r.status = 'active') > v_lb_per_gal;
  END IF;

  -- Reference size: the active bulk member, else the size an admin picked.
  SELECT m.product_id INTO v_ref FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
   WHERE m.parent_id = p_parent_id AND m.size_role = 'bulk' AND p.is_active;
  IF v_ref IS NOT NULL THEN
    v_ref_source := 'bulk';
  ELSE
    SELECT c.reference_product_id, m.parent_id AS member_of, p.is_active INTO v_ref_row
      FROM public.product_parent_cost_reference c
      LEFT JOIN public.product_parent_members m ON m.product_id = c.reference_product_id AND m.parent_id = p_parent_id
      LEFT JOIN public.products p ON p.id = c.reference_product_id
     WHERE c.parent_id = p_parent_id;
    IF v_ref_row.reference_product_id IS NULL THEN
      v_ref_reason := 'REFERENCE_UNSET';
    ELSIF v_ref_row.member_of IS NULL THEN
      v_ref_reason := 'REFERENCE_NOT_MEMBER';
    ELSIF NOT v_ref_row.is_active THEN
      v_ref_reason := 'REFERENCE_INACTIVE';
    ELSE
      v_ref := v_ref_row.reference_product_id;
      v_ref_source := 'picked';
    END IF;
  END IF;

  FOR v_size IN
    SELECT p.id, p.product_name, p.product_form, p.inventory_unit, p.current_cost, p.is_active, m.size_role
      FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
     WHERE m.parent_id = p_parent_id
     ORDER BY p.product_name, p.id
  LOOP
    v_form := CASE WHEN v_parent.product_form IN ('seed', 'each') THEN v_parent.product_form
                   ELSE COALESCE(v_size.product_form, v_parent.product_form) END;
    v_cost := public._size_cost_per_base(v_size.current_cost, v_size.inventory_unit, v_form);
    v_figures := '[]'::jsonb;

    FOR v_r IN
      SELECT 'ingredient' AS kind, r.id AS row_id, r.ingredient_id, a.name, NULL::text AS nutrient,
             r.strength_value AS value, r.strength_unit AS unit, r.strength_basis AS basis
        FROM public.product_parent_ingredients r JOIN public.active_ingredients a ON a.id = r.ingredient_id
       WHERE r.parent_id = p_parent_id AND r.status = 'active'
      UNION ALL
      SELECT 'fertilizer', f.id, NULL::uuid, f.nutrient, f.nutrient, f.percent, 'pct_ww', f.basis
        FROM public.product_parent_fertilizer_analysis f
       WHERE f.parent_id = p_parent_id AND f.status = 'active'
      ORDER BY 1 DESC, 4, 2
    LOOP
      v_reason := NULL;
      v_used_weight := NULL;
      IF v_cost ? 'reason' THEN
        v_reason := v_cost->>'reason';
      ELSIF v_r.value IS NULL THEN
        v_reason := 'STRENGTH_UNKNOWN';
      ELSIF v_r.unit = 'lb_per_gal' AND v_form <> 'liquid' THEN
        v_reason := 'STRENGTH_UNIT_MISMATCH';
      -- Every figure of the parent, fertilizer rows included, is refused when the actives outweigh the product (sheet section 4).
      ELSIF v_form = 'liquid' AND v_exceeds THEN
        v_reason := 'STRENGTH_EXCEEDS_DENSITY';
      ELSIF v_form = 'liquid' AND v_r.unit = 'pct_ww' AND v_density_reason IS NOT NULL THEN
        v_reason := v_density_reason;
      END IF;
      -- Pounds of active per gallon (liquid) or per lb (dry), as num / den.
      IF v_reason IS NULL THEN
        IF v_r.unit = 'lb_per_gal' THEN
          v_num := v_r.value; v_den := 1;
        ELSIF v_form = 'liquid' THEN
          v_num := v_r.value * v_lb_per_gal; v_den := 100; v_used_weight := v_weight_row;
        ELSE
          v_num := v_r.value; v_den := 100;
        END IF;
        -- cost per lb of active = (cost num / cost den) / (num / den), in cents.
        v_fig := jsonb_build_object('basis', v_r.basis,
          'cents', public._cents_half_up((v_cost->>'num')::numeric * 100 * v_den, (v_cost->>'den')::numeric * v_num));
        v_conv := public._chemistry_convert(v_num, v_den, v_r.basis, v_r.ingredient_id, v_r.nutrient);
        IF v_conv ? 'num' THEN
          v_conv := jsonb_build_object('basis', v_conv->>'basis',
            'cents', public._cents_half_up((v_cost->>'num')::numeric * 100 * (v_conv->>'den')::numeric,
                                           (v_cost->>'den')::numeric * (v_conv->>'num')::numeric));
        END IF;
      ELSE
        v_fig := jsonb_build_object('basis', v_r.basis, 'reason', v_reason);
        v_conv := public._chemistry_convert(1, 1, v_r.basis, v_r.ingredient_id, v_r.nutrient);
        IF v_conv IS NOT NULL THEN
          v_conv := jsonb_build_object('basis', v_conv->>'basis', 'reason', COALESCE(v_conv->>'reason', v_reason));
        END IF;
      END IF;
      v_figures := v_figures || jsonb_build_array(jsonb_build_object('kind', v_r.kind, 'row_id', v_r.row_id,
        'ingredient_id', v_r.ingredient_id, 'name', v_r.name, 'nutrient', v_r.nutrient,
        'strength_value', v_r.value, 'strength_unit', v_r.unit, 'figure', v_fig, 'converted', v_conv,
        'weight_row_id', v_used_weight, 'label', 'from catalog cost'));
    END LOOP;

    v_sizes := v_sizes || jsonb_build_array(jsonb_build_object('product_id', v_size.id, 'product_name', v_size.product_name,
      'is_active', v_size.is_active, 'size_role', v_size.size_role, 'product_form', v_form,
      'priced_unit', v_size.inventory_unit,
      'cost_per_base', CASE WHEN v_cost ? 'reason' THEN NULL
                            ELSE jsonb_build_object('base', v_cost->>'base', 'cents', v_cost->>'cents') END,
      'cost_reason', v_cost->>'reason', 'figures', v_figures));
    IF v_size.id = v_ref THEN v_parent_figures := v_figures; END IF;
  END LOOP;

  RETURN jsonb_build_object('parent_id', p_parent_id, 'parent_name', v_parent.name, 'chemistry_version', v_version,
    'label', 'from catalog cost',
    'density', CASE WHEN v_density_reason IS NULL
                    THEN jsonb_build_object('lb_per_gal', v_lb_per_gal, 'weight_row_id', v_weight_row)
                    ELSE jsonb_build_object('reason', v_density_reason) END,
    'reference', jsonb_build_object('product_id', v_ref, 'source', v_ref_source, 'reason', v_ref_reason),
    'parent_figures', CASE WHEN v_ref_reason IS NULL THEN COALESCE(v_parent_figures, '[]'::jsonb) END,
    'sizes', v_sizes);
END;
$function$;
ALTER FUNCTION public._parent_active_cost_rows(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._parent_active_cost_rows(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

-- Parents using an ingredient directly, or through a form that names it as its acid.
CREATE FUNCTION public._ingredient_usage_parents(p_ingredient_id uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(array_agg(DISTINCT r.parent_id ORDER BY r.parent_id), '{}'::uuid[])
    FROM public.product_parent_ingredients r
   WHERE r.status = 'active'
     AND (r.ingredient_id = p_ingredient_id
          OR r.ingredient_id IN (SELECT f.id FROM public.active_ingredients f
                                  WHERE f.canonical_ingredient_id = p_ingredient_id AND f.status = 'active'));
$function$;
ALTER FUNCTION public._ingredient_usage_parents(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._ingredient_usage_parents(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Who uses an ingredient: parents with an active row of it (with its mode-of-action count) and active forms naming it.
CREATE FUNCTION public._ingredient_users(p_ingredient_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT jsonb_build_object(
    'parents', COALESCE((SELECT jsonb_agg(jsonb_build_object('parent_id', pp.id, 'name', pp.name, 'is_active', pp.is_active)
                          ORDER BY pp.name, pp.id)
                          FROM public.product_parents pp
                         WHERE pp.id IN (SELECT r.parent_id FROM public.product_parent_ingredients r
                                          WHERE r.ingredient_id = p_ingredient_id AND r.status = 'active'
                                         UNION
                                         SELECT m.parent_id FROM public.product_parent_modes_of_action m
                                          WHERE m.ingredient_id = p_ingredient_id AND m.status = 'active')), '[]'::jsonb),
    'forms', COALESCE((SELECT jsonb_agg(jsonb_build_object('ingredient_id', f.id, 'name', f.name) ORDER BY f.name, f.id)
                        FROM public.active_ingredients f
                       WHERE f.canonical_ingredient_id = p_ingredient_id AND f.status = 'active'), '[]'::jsonb));
$function$;
ALTER FUNCTION public._ingredient_users(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._ingredient_users(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE FUNCTION public.get_parent_chemistry(p_parent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent record;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_profile() THEN RAISE EXCEPTION 'ACTIVE_USER_REQUIRED'; END IF;
  SELECT id, name, product_form, is_active INTO v_parent FROM public.product_parents WHERE id = p_parent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  RETURN jsonb_build_object('parent_id', v_parent.id, 'parent_name', v_parent.name, 'product_form', v_parent.product_form,
    'is_active', v_parent.is_active,
    'chemistry_version', COALESCE((SELECT chemistry_version FROM public.product_parent_chemistry_state WHERE parent_id = p_parent_id), 0),
    'chemistry', public._parent_chemistry_values(p_parent_id),
    'epa_refusal', public._parent_chemistry_epa_refusal(p_parent_id),
    'sizes', COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', p.id, 'product_name', p.product_name,
                         'size_role', m.size_role, 'is_active', p.is_active) ORDER BY p.product_name, p.id)
                        FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
                       WHERE m.parent_id = p_parent_id), '[]'::jsonb));
END;
$function$;
ALTER FUNCTION public.get_parent_chemistry(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_parent_chemistry(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.get_parent_chemistry(uuid) TO authenticated;

-- Active ingredients whose name contains the text (case and inner spaces ignored; no wildcards) or whose CAS is the text.
CREATE FUNCTION public.search_active_ingredients(p_text text, p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_text text := lower(regexp_replace(btrim(COALESCE(p_text, '')), '\s+', ' ', 'g'));
  v_like text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_profile() THEN RAISE EXCEPTION 'ACTIVE_USER_REQUIRED'; END IF;
  v_like := '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  RETURN COALESCE((
    SELECT jsonb_agg(public._active_ingredient_values(a) ORDER BY a.name, a.id)
      FROM (SELECT * FROM public.active_ingredients a
             WHERE a.status = 'active' AND (a.name_key LIKE v_like OR a.cas = btrim(p_text))
             ORDER BY a.name, a.id
             LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) a), '[]'::jsonb);
END;
$function$;
ALTER FUNCTION public.search_active_ingredients(text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.search_active_ingredients(text, integer) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.search_active_ingredients(text, integer) TO authenticated;

-- Admin: "needs CAS", possible duplicates side by side (D-AA-2, computed), and retired ingredients.
CREATE FUNCTION public.get_active_ingredient_worklist()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
BEGIN
  RETURN jsonb_build_object(
    'needs_cas', COALESCE((
      SELECT jsonb_agg(public._active_ingredient_values(a) || public._ingredient_users(a.id) ORDER BY a.name, a.id)
        FROM public.active_ingredients a WHERE a.status = 'active' AND a.cas IS NULL), '[]'::jsonb),
    'possible_duplicates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'provisional', public._active_ingredient_values(p) || public._ingredient_users(p.id),
               'other', public._active_ingredient_values(o) || public._ingredient_users(o.id))
             ORDER BY p.name_key, p.id, o.id)
        FROM public.active_ingredients p
        JOIN public.active_ingredients o ON o.name_key = p.name_key AND o.id <> p.id AND o.status = 'active'
       WHERE p.status = 'active' AND p.cas IS NULL
         AND (o.cas IS NOT NULL OR p.id < o.id)), '[]'::jsonb),
    'retired', COALESCE((
      SELECT jsonb_agg(public._active_ingredient_values(a) ORDER BY a.name, a.id)
        FROM public.active_ingredients a WHERE a.status = 'retired'), '[]'::jsonb));
END;
$function$;
ALTER FUNCTION public.get_active_ingredient_worklist() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_active_ingredient_worklist() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.get_active_ingredient_worklist() TO authenticated;

-- Admin only: cost per lb of active (no cost or price ever reaches a non-admin).
CREATE FUNCTION public.get_parent_active_costs(p_parent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
BEGIN
  RETURN public._parent_active_cost_rows(p_parent_id);
END;
$function$;
ALTER FUNCTION public.get_parent_active_costs(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_parent_active_costs(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.get_parent_active_costs(uuid) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Fingerprints (what a preview showed, so the save refuses if it moved)
-- ---------------------------------------------------------------------------------------------

-- Chemistry correction: the requested changes, the chemistry and parent versions (an EPA change moves it), the sorted member size IDs, and the
-- row_version of every ingredient on the parent or named by the changes.
CREATE FUNCTION public._chemistry_preview_fingerprint(p_parent_id uuid, p_changes jsonb) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT md5(jsonb_build_object(
    'changes', p_changes,
    'version', COALESCE((SELECT chemistry_version FROM public.product_parent_chemistry_state WHERE parent_id = p_parent_id), 0),
    'parent', (SELECT parent_version FROM public.product_parents WHERE id = p_parent_id),
    'members', COALESCE((SELECT jsonb_agg(m.product_id ORDER BY m.product_id)
                           FROM public.product_parent_members m WHERE m.parent_id = p_parent_id), '[]'::jsonb),
    'ingredients', COALESCE((SELECT jsonb_agg(jsonb_build_array(a.id, a.row_version) ORDER BY a.id)
                               FROM public.active_ingredients a
                              WHERE a.id IN (SELECT r.ingredient_id FROM public.product_parent_ingredients r
                                              WHERE r.parent_id = p_parent_id)
                                 OR a.id::text IN (SELECT e.value->>k
                                                     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_changes) = 'array'
                                                                                    THEN p_changes ELSE '[]'::jsonb END) e,
                                                          unnest(ARRAY['ingredient_id', 'canonical_ingredient_id']) k
                                                    WHERE jsonb_typeof(e.value) = 'object')
                                 OR a.cas IN (SELECT btrim(e.value->>'cas')
                                                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_changes) = 'array'
                                                                               THEN p_changes ELSE '[]'::jsonb END) e
                                               WHERE jsonb_typeof(e.value) = 'object')), '[]'::jsonb))::text);
$function$;
ALTER FUNCTION public._chemistry_preview_fingerprint(uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._chemistry_preview_fingerprint(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Ingredient edit: the requested fields, the ingredient itself, every active form naming it, every parent
-- row using it or those forms (with mode-of-action rows), and each affected parent's sorted member size IDs.
CREATE FUNCTION public._ingredient_usage_fingerprint(p_ingredient_id uuid, p_fields jsonb) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  WITH forms AS (
    SELECT f.id, f.row_version FROM public.active_ingredients f
     WHERE f.canonical_ingredient_id = p_ingredient_id AND f.status = 'active'
  ), parents AS (
    SELECT unnest(public._ingredient_usage_parents(p_ingredient_id)) AS parent_id
  )
  SELECT md5(jsonb_build_object(
    'fields', p_fields,
    'ingredient', (SELECT public._active_ingredient_values(a) FROM public.active_ingredients a WHERE a.id = p_ingredient_id),
    'forms', COALESCE((SELECT jsonb_agg(jsonb_build_array(id, row_version) ORDER BY id) FROM forms), '[]'::jsonb),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_array(r.id, r.row_version) ORDER BY r.id)
                        FROM public.product_parent_ingredients r
                       WHERE r.status = 'active'
                         AND (r.ingredient_id = p_ingredient_id OR r.ingredient_id IN (SELECT id FROM forms))), '[]'::jsonb),
    'moa', COALESCE((SELECT jsonb_agg(jsonb_build_array(m.id, m.row_version) ORDER BY m.id)
                       FROM public.product_parent_modes_of_action m
                      WHERE m.status = 'active' AND m.ingredient_id = p_ingredient_id), '[]'::jsonb),
    'members', COALESCE((SELECT jsonb_agg(jsonb_build_array(m.parent_id, m.product_id) ORDER BY m.parent_id, m.product_id)
                           FROM public.product_parent_members m WHERE m.parent_id IN (SELECT parent_id FROM parents)), '[]'::jsonb)
  )::text);
$function$;
ALTER FUNCTION public._ingredient_usage_fingerprint(uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._ingredient_usage_fingerprint(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- ---------------------------------------------------------------------------------------------
-- Parent chemistry writers
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.set_parent_chemistry(p_parent_id uuid, p_expected_chemistry_version bigint, p_changes jsonb,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'parent_id', p_parent_id,
    'expected_chemistry_version', p_expected_chemistry_version, 'changes', p_changes)::text);
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'set_parent_chemistry', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  PERFORM public._lock_parent_chemistry(p_parent_id, p_expected_chemistry_version);
  v_result := public._apply_parent_chemistry(p_parent_id, p_changes, 'set', NULL, NULL);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_parent_chemistry',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.set_parent_chemistry(uuid, bigint, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_parent_chemistry(uuid, bigint, jsonb, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.set_parent_chemistry(uuid, bigint, jsonb, text) TO authenticated;

-- Admin, read-only: runs the real correction in a subtransaction that is always rolled back, so the preview
-- shows exactly what the save would do (or the refusal it would give); IDs of ingredients it would create are
-- rehearsal-only (the save makes its own, matched by CAS or name). VOLATILE because of that rehearsal;
-- nothing it writes survives.
CREATE FUNCTION public.preview_parent_chemistry_correction(p_parent_id uuid, p_changes jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_parent record;
  v_version bigint;
  v_fingerprint text;
  v_before jsonb;
  v_result jsonb;
  v_refusal text;
BEGIN
  SELECT id, name, is_active INTO v_parent FROM public.product_parents WHERE id = p_parent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  v_version := COALESCE((SELECT chemistry_version FROM public.product_parent_chemistry_state WHERE parent_id = p_parent_id), 0);
  v_fingerprint := public._chemistry_preview_fingerprint(p_parent_id, p_changes);
  v_before := public._parent_chemistry_values(p_parent_id);
  BEGIN
    PERFORM public._lock_parent_chemistry(p_parent_id, v_version);
    -- Re-read under the lock so the fingerprint and "before" match what the save will see (a size can join first).
    v_fingerprint := public._chemistry_preview_fingerprint(p_parent_id, p_changes);
    v_before := public._parent_chemistry_values(p_parent_id);
    v_result := public._apply_parent_chemistry(p_parent_id, p_changes, 'correct', NULL, NULL);
    RAISE EXCEPTION 'CRX_PREVIEW_ROLLBACK' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN NULL;
    WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation
         OR invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
      v_result := NULL;
      v_refusal := SQLERRM;
  END;
  RETURN jsonb_build_object('parent_id', p_parent_id, 'parent_name', v_parent.name, 'is_active', v_parent.is_active,
    -- A refused preview hands back no fingerprint, so it can never authorize a save.
    'chemistry_version', v_version, 'preview_fingerprint', CASE WHEN v_refusal IS NULL THEN v_fingerprint END,
    'epa_refusal', public._parent_chemistry_epa_refusal(p_parent_id),
    'before', v_before, 'after', v_result->'chemistry', 'changed', COALESCE((v_result->>'changed')::boolean, false),
    'created_ingredients', v_result->'created_ingredients', 'refusal', v_refusal,
    'sizes', COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', p.id, 'product_name', p.product_name,
                         'size_role', m.size_role, 'is_active', p.is_active) ORDER BY p.product_name, p.id)
                        FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
                       WHERE m.parent_id = p_parent_id), '[]'::jsonb));
END;
$function$;
ALTER FUNCTION public.preview_parent_chemistry_correction(uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_parent_chemistry_correction(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.preview_parent_chemistry_correction(uuid, jsonb) TO authenticated;

CREATE FUNCTION public.correct_parent_chemistry(p_parent_id uuid, p_expected_chemistry_version bigint,
  p_expected_preview_fingerprint text, p_changes jsonb, p_reason text, p_evidence text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'parent_id', p_parent_id,
    'expected_chemistry_version', p_expected_chemistry_version, 'expected_preview_fingerprint', p_expected_preview_fingerprint,
    'changes', p_changes, 'reason', p_reason, 'evidence', p_evidence)::text);
  v_existing jsonb;
  v_reason text;
  v_evidence text;
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'correct_parent_chemistry', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', true);
  v_evidence := public._product_parent_reason(p_evidence, 'evidence', true);
  PERFORM public._lock_parent_chemistry(p_parent_id, p_expected_chemistry_version);
  IF p_expected_preview_fingerprint IS DISTINCT FROM public._chemistry_preview_fingerprint(p_parent_id, p_changes) THEN
    RAISE EXCEPTION 'CHEMISTRY_PREVIEW_CHANGED: a size or ingredient changed since the preview; preview again';
  END IF;
  v_result := public._apply_parent_chemistry(p_parent_id, p_changes, 'correct', v_reason, v_evidence);
  PERFORM public.save_idempotency(p_idempotency_key, 'correct_parent_chemistry',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.correct_parent_chemistry(uuid, bigint, text, jsonb, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.correct_parent_chemistry(uuid, bigint, text, jsonb, text, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.correct_parent_chemistry(uuid, bigint, text, jsonb, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Ingredient writers
-- ---------------------------------------------------------------------------------------------

-- Lock every parent an identity edit can change (section 3 order: parents in ID order, then their members).
CREATE FUNCTION public._lock_ingredient_parents(p_parent_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM 1 FROM public.product_parents WHERE id = ANY(p_parent_ids) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.products p
   WHERE p.id IN (SELECT m.product_id FROM public.product_parent_members m WHERE m.parent_id = ANY(p_parent_ids))
   ORDER BY p.id FOR SHARE;
END;
$function$;
ALTER FUNCTION public._lock_ingredient_parents(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._lock_ingredient_parents(uuid[]) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- The one ingredient edit (identity fields only; the name never changes). The caller holds the parent locks
-- and the ingredient-list lock. Checks the final state of everything depending on the ingredient, bumps each
-- affected parent's chemistry version with a 'corrected' event, and logs the ingredient event.
-- p_preview: the reason and evidence rule is reported (needs_reason), not enforced; the caller rolls back.
CREATE FUNCTION public._edit_active_ingredient(p_ingredient_id uuid, p_fields jsonb, p_reason text, p_evidence text,
  p_preview boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_old public.active_ingredients;
  v_new public.active_ingredients;
  v_key text;
  v_changed text[] := '{}';
  v_established boolean := false;
  v_parents uuid[];
  v_needs_reason boolean;
  v_reason text;
  v_evidence text;
  v_names text;
  v_conflict text;
  v_gate text;
  v_parent uuid;
  v_before jsonb := '{}'::jsonb;
  v_version bigint;
  v_event bigint;
BEGIN
  IF p_fields IS NULL OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INGREDIENT_ENTRY_INVALID: say which fields change';
  END IF;
  IF p_fields ? 'name' THEN
    RAISE EXCEPTION 'INGREDIENT_NAME_FIXED: an ingredient''s name never changes; add the right ingredient and swap it in';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_fields) LOOP
    IF v_key NOT IN ('cas', 'canonical_ingredient_id', 'canonical_fraction', 'fraction_basis', 'is_parent_form') THEN
      RAISE EXCEPTION 'INGREDIENT_ENTRY_INVALID: % cannot be changed here', v_key;
    END IF;
  END LOOP;
  SELECT * INTO v_old FROM public.active_ingredients WHERE id = p_ingredient_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INGREDIENT_NOT_FOUND'; END IF;
  IF v_old.status <> 'active' THEN RAISE EXCEPTION 'INGREDIENT_RETIRED: % was retired; reactivate it', v_old.name; END IF;
  v_new := v_old;

  IF p_fields ? 'cas' THEN
    IF jsonb_typeof(p_fields->'cas') = 'null' OR (jsonb_typeof(p_fields->'cas') = 'string' AND btrim(p_fields->>'cas') = '') THEN
      v_new.cas := NULL;
    ELSIF jsonb_typeof(p_fields->'cas') IS DISTINCT FROM 'string' OR NOT public._ingredient_cas_valid(btrim(p_fields->>'cas')) THEN
      RAISE EXCEPTION 'INGREDIENT_CAS_INVALID: % is not a valid CAS number (format or check digit)', p_fields->>'cas';
    ELSE
      v_new.cas := btrim(p_fields->>'cas');
    END IF;
  END IF;
  IF p_fields ? 'canonical_ingredient_id' THEN
    v_new.canonical_ingredient_id := CASE WHEN jsonb_typeof(p_fields->'canonical_ingredient_id') = 'null' THEN NULL
      ELSE public._chemistry_uuid(p_fields->'canonical_ingredient_id', 'canonical_ingredient_id') END;
  END IF;
  IF p_fields ? 'canonical_fraction' THEN
    IF jsonb_typeof(p_fields->'canonical_fraction') = 'null' THEN
      v_new.canonical_fraction := NULL;
    ELSIF jsonb_typeof(p_fields->'canonical_fraction') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: the fraction must be a number';
    ELSE
      v_new.canonical_fraction := (p_fields->>'canonical_fraction')::numeric;
    END IF;
  END IF;
  IF p_fields ? 'fraction_basis' THEN
    IF COALESCE(jsonb_typeof(p_fields->'fraction_basis'), 'missing') NOT IN ('null', 'string') THEN
      RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: the fraction basis can only be acid_equivalent';
    END IF;
    v_new.fraction_basis := p_fields->>'fraction_basis';
  END IF;
  IF p_fields ? 'is_parent_form' THEN
    IF jsonb_typeof(p_fields->'is_parent_form') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: is_parent_form must be true or false';
    END IF;
    v_new.is_parent_form := (p_fields->>'is_parent_form')::boolean;
  END IF;

  -- Final shape (the table CHECKs again).
  IF v_new.fraction_basis IS NOT NULL AND v_new.fraction_basis <> 'acid_equivalent' THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: the fraction basis can only be acid_equivalent';
  END IF;
  IF (v_new.canonical_fraction IS NULL) <> (v_new.fraction_basis IS NULL) THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: a fraction needs its basis (acid_equivalent), and the basis needs a fraction';
  END IF;
  IF v_new.canonical_fraction IS NOT NULL AND NOT (v_new.canonical_fraction > 0 AND v_new.canonical_fraction <= 1) THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: the fraction must be above 0 and at most 1';
  END IF;
  IF v_new.canonical_fraction IS NOT NULL AND v_new.canonical_ingredient_id IS NULL THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: a fraction needs the acid it is measured as';
  END IF;
  IF v_new.is_parent_form AND (v_new.canonical_ingredient_id IS NOT NULL OR v_new.canonical_fraction IS NOT NULL) THEN
    RAISE EXCEPTION 'INGREDIENT_FRACTION_INVALID: an acid (parent form) has no acid of its own and no fraction';
  END IF;
  IF v_new.canonical_ingredient_id IS DISTINCT FROM v_old.canonical_ingredient_id AND v_new.canonical_ingredient_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.active_ingredients c WHERE c.id = v_new.canonical_ingredient_id
                        AND c.id <> p_ingredient_id AND c.status = 'active' AND c.is_parent_form) THEN
    RAISE EXCEPTION 'INGREDIENT_CANONICAL_INVALID: the acid named must be another active ingredient marked as the acid';
  END IF;
  -- D-AA-3, as _resolve_active_ingredient: a same-name ingredient that claims a different acid refuses the edit.
  IF v_new.canonical_ingredient_id IS DISTINCT FROM v_old.canonical_ingredient_id AND v_new.canonical_ingredient_id IS NOT NULL THEN
    SELECT string_agg(a.name, ', ' ORDER BY a.name) INTO v_conflict
      FROM public.active_ingredients a
     WHERE a.status = 'active' AND a.id <> p_ingredient_id AND a.name_key = v_old.name_key
       AND a.canonical_ingredient_id IS DISTINCT FROM v_new.canonical_ingredient_id;
    IF v_conflict IS NOT NULL THEN
      RAISE EXCEPTION 'INGREDIENT_PARENT_CONFLICT: % already exists with a different acid; correct that ingredient first', v_conflict;
    END IF;
  END IF;

  IF v_new.cas IS DISTINCT FROM v_old.cas THEN v_changed := v_changed || 'cas'::text; END IF;
  IF v_new.canonical_ingredient_id IS DISTINCT FROM v_old.canonical_ingredient_id THEN v_changed := v_changed || 'canonical_ingredient_id'::text; END IF;
  IF v_new.canonical_fraction IS DISTINCT FROM v_old.canonical_fraction THEN v_changed := v_changed || 'canonical_fraction'::text; END IF;
  IF v_new.fraction_basis IS DISTINCT FROM v_old.fraction_basis THEN v_changed := v_changed || 'fraction_basis'::text; END IF;
  IF v_new.is_parent_form IS DISTINCT FROM v_old.is_parent_form THEN v_changed := v_changed || 'is_parent_form'::text; END IF;
  IF cardinality(v_changed) = 0 THEN RAISE EXCEPTION 'INGREDIENT_NO_CHANGE: nothing differs on %', v_old.name; END IF;
  v_established := ('cas' = ANY(v_changed) AND v_old.cas IS NOT NULL)
    OR ('canonical_ingredient_id' = ANY(v_changed) AND v_old.canonical_ingredient_id IS NOT NULL)
    OR ('canonical_fraction' = ANY(v_changed) AND v_old.canonical_fraction IS NOT NULL)
    OR ('fraction_basis' = ANY(v_changed) AND v_old.fraction_basis IS NOT NULL)
    OR ('is_parent_form' = ANY(v_changed) AND v_old.is_parent_form);

  IF v_new.cas IS NOT NULL AND v_new.cas IS DISTINCT FROM v_old.cas THEN
    SELECT name INTO v_names FROM public.active_ingredients WHERE cas = v_new.cas AND id <> p_ingredient_id;
    IF FOUND THEN
      RAISE EXCEPTION 'INGREDIENT_CAS_TAKEN: this CAS belongs to %; swap this ingredient to % on its products, then retire it',
        v_names, v_names;
    END IF;
  END IF;

  -- What depends on it, in its final state.
  IF v_old.is_parent_form AND NOT v_new.is_parent_form THEN
    SELECT string_agg(f.name, ', ' ORDER BY f.name) INTO v_names FROM public.active_ingredients f
     WHERE f.canonical_ingredient_id = p_ingredient_id AND f.status = 'active';
    IF v_names IS NOT NULL THEN
      RAISE EXCEPTION 'INGREDIENT_IN_USE: % name % as their acid; correct those first', v_names, v_old.name;
    END IF;
  END IF;
  IF NOT v_new.is_parent_form AND v_new.canonical_ingredient_id IS NULL THEN
    SELECT string_agg(DISTINCT pp.name, ', ') INTO v_names
      FROM public.product_parent_ingredients r JOIN public.product_parents pp ON pp.id = r.parent_id
     WHERE r.ingredient_id = p_ingredient_id AND r.status = 'active' AND r.strength_basis = 'acid_equivalent';
    IF v_names IS NOT NULL THEN
      RAISE EXCEPTION 'INGREDIENT_IN_USE: % state % as acid equivalent, which needs its acid; correct those first', v_names, v_old.name;
    END IF;
  END IF;

  v_parents := public._ingredient_usage_parents(p_ingredient_id);
  v_needs_reason := v_established OR cardinality(v_parents) > 0;
  IF NOT p_preview THEN
    v_reason := public._product_parent_reason(p_reason, 'reason', v_needs_reason);
    v_evidence := public._product_parent_reason(p_evidence, 'evidence', v_needs_reason);
  END IF;
  FOREACH v_parent IN ARRAY v_parents LOOP
    v_gate := public._parent_chemistry_epa_refusal(v_parent);
    IF v_gate IS NOT NULL THEN
      RAISE EXCEPTION '%', v_gate || format(' (product "%s" uses %s; DM-4 will update it)',
        (SELECT name FROM public.product_parents WHERE id = v_parent), v_old.name);
    END IF;
    v_before := v_before || jsonb_build_object(v_parent::text, public._parent_chemistry_values(v_parent));
  END LOOP;

  UPDATE public.active_ingredients
     SET cas = v_new.cas, canonical_ingredient_id = v_new.canonical_ingredient_id,
         canonical_fraction = v_new.canonical_fraction, fraction_basis = v_new.fraction_basis,
         is_parent_form = v_new.is_parent_form, row_version = row_version + 1, updated_by = auth.uid(), updated_at = now()
   WHERE id = p_ingredient_id
  RETURNING * INTO v_new;
  v_event := public._active_ingredient_event(p_ingredient_id, 'updated', v_reason, v_evidence,
    public._active_ingredient_values(v_old), public._active_ingredient_values(v_new));

  FOREACH v_parent IN ARRAY v_parents LOOP
    PERFORM public._check_parent_chemistry(v_parent);
    INSERT INTO public.product_parent_chemistry_state (parent_id, chemistry_version, updated_by)
    VALUES (v_parent, 0, auth.uid()) ON CONFLICT (parent_id) DO NOTHING;
    UPDATE public.product_parent_chemistry_state
       SET chemistry_version = chemistry_version + 1, updated_by = auth.uid(), updated_at = now()
     WHERE parent_id = v_parent
    RETURNING chemistry_version INTO v_version;
    INSERT INTO public.product_chemistry_events (parent_id, event_type, chemistry_version, reason, evidence,
      before_values, after_values, changed_by)
    VALUES (v_parent, 'corrected', v_version, v_reason, v_evidence, v_before->v_parent::text,
      public._parent_chemistry_values(v_parent) || jsonb_build_object('source_path', 'ingredient_edit',
        'ingredient_id', p_ingredient_id, 'ingredient_event_id', v_event, 'changed_fields', to_jsonb(v_changed)),
      auth.uid());
  END LOOP;

  RETURN jsonb_build_object('ingredient', public._active_ingredient_values(v_new), 'before', public._active_ingredient_values(v_old),
    'changed_fields', to_jsonb(v_changed), 'needs_reason', v_needs_reason, 'affected_parents', to_jsonb(v_parents),
    'event_id', v_event);
END;
$function$;
ALTER FUNCTION public._edit_active_ingredient(uuid, jsonb, text, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._edit_active_ingredient(uuid, jsonb, text, text, boolean) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Admin, read-only: what an ingredient edit would do (rehearsed and rolled back), who it affects, and the
-- fingerprint the save must send back.
CREATE FUNCTION public.preview_active_ingredient_change(p_ingredient_id uuid, p_fields jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_row public.active_ingredients;
  v_fingerprint text;
  v_parents uuid[];
  v_result jsonb;
  v_refusal text;
BEGIN
  -- Lock first (as the writer does), so "before", the fingerprint and the rehearsal all read one state.
  v_parents := public._ingredient_usage_parents(p_ingredient_id);
  PERFORM public._lock_ingredient_parents(v_parents);
  PERFORM pg_advisory_xact_lock(hashtext('crx.active_ingredients'));
  SELECT * INTO v_row FROM public.active_ingredients WHERE id = p_ingredient_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'INGREDIENT_NOT_FOUND'; END IF;
  IF public._ingredient_usage_parents(p_ingredient_id) IS DISTINCT FROM v_parents THEN
    RAISE EXCEPTION 'INGREDIENT_USAGE_CHANGED: the products using % changed while previewing; preview again', v_row.name;
  END IF;
  v_fingerprint := public._ingredient_usage_fingerprint(p_ingredient_id, p_fields);
  BEGIN
    v_result := public._edit_active_ingredient(p_ingredient_id, p_fields, NULL, NULL, true);
    RAISE EXCEPTION 'CRX_PREVIEW_ROLLBACK' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN NULL;
    WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation
         OR invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
      v_result := NULL;
      v_refusal := SQLERRM;
  END;
  RETURN jsonb_build_object('ingredient', public._active_ingredient_values(v_row), 'usage_fingerprint', v_fingerprint,
    'users', public._ingredient_users(p_ingredient_id),
    'affected_parents', COALESCE((SELECT jsonb_agg(jsonb_build_object('parent_id', pp.id, 'name', pp.name,
                                    'is_active', pp.is_active,
                                    'epa_refusal', public._parent_chemistry_epa_refusal(pp.id),
                                    'sizes', COALESCE((SELECT jsonb_agg(m.product_id ORDER BY m.product_id)
                                                         FROM public.product_parent_members m WHERE m.parent_id = pp.id), '[]'::jsonb))
                                   ORDER BY pp.name, pp.id)
                                    FROM public.product_parents pp WHERE pp.id = ANY(v_parents)), '[]'::jsonb),
    'after', v_result->'ingredient', 'changed_fields', v_result->'changed_fields',
    'needs_reason', v_result->'needs_reason', 'refusal', v_refusal);
END;
$function$;
ALTER FUNCTION public.preview_active_ingredient_change(uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_active_ingredient_change(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.preview_active_ingredient_change(uuid, jsonb) TO authenticated;

-- Create (p_ingredient_id NULL: resolved like any entry, so a known CAS returns that ingredient, reused) or
-- edit one ingredient's identity fields.
CREATE FUNCTION public.save_active_ingredient(p_ingredient_id uuid, p_expected_row_version integer,
  p_expected_usage_fingerprint text, p_fields jsonb, p_reason text, p_evidence text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'ingredient_id', p_ingredient_id,
    'expected_row_version', p_expected_row_version, 'expected_usage_fingerprint', p_expected_usage_fingerprint,
    'fields', p_fields, 'reason', p_reason, 'evidence', p_evidence)::text);
  v_existing jsonb;
  v_res jsonb;
  v_row public.active_ingredients;
  v_parents uuid[];
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'save_active_ingredient', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF p_ingredient_id IS NULL THEN
    IF p_fields IS NULL OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object' OR p_fields ? 'ingredient_id' THEN
      RAISE EXCEPTION 'INGREDIENT_ENTRY_INVALID: describe the new ingredient';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_fields) k(key)
                WHERE k.key NOT IN ('name', 'cas', 'canonical_ingredient_id', 'canonical_fraction', 'fraction_basis', 'is_parent_form')) THEN
      RAISE EXCEPTION 'INGREDIENT_ENTRY_INVALID: % is not an ingredient field',
        (SELECT string_agg(k.key, ', ' ORDER BY k.key) FROM jsonb_object_keys(p_fields) k(key)
          WHERE k.key NOT IN ('name', 'cas', 'canonical_ingredient_id', 'canonical_fraction', 'fraction_basis', 'is_parent_form'));
    END IF;
    v_res := public._resolve_active_ingredient(p_fields);
    SELECT * INTO v_row FROM public.active_ingredients WHERE id = (v_res->>'ingredient_id')::uuid;
    v_result := jsonb_build_object('ingredient', public._active_ingredient_values(v_row),
      'reused', v_res->'reused', 'created', v_res->'created');
  ELSE
    v_parents := public._ingredient_usage_parents(p_ingredient_id);
    PERFORM public._lock_ingredient_parents(v_parents);
    PERFORM pg_advisory_xact_lock(hashtext('crx.active_ingredients'));
    SELECT * INTO v_row FROM public.active_ingredients WHERE id = p_ingredient_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INGREDIENT_NOT_FOUND'; END IF;
    IF p_expected_row_version IS NULL OR v_row.row_version <> p_expected_row_version THEN
      RAISE EXCEPTION 'INGREDIENT_STALE: % changed since you opened it; reload and try again', v_row.name;
    END IF;
    -- Under the locks: the set of affected parents and everything the preview showed must be unchanged.
    IF public._ingredient_usage_parents(p_ingredient_id) IS DISTINCT FROM v_parents
       OR p_expected_usage_fingerprint IS DISTINCT FROM public._ingredient_usage_fingerprint(p_ingredient_id, p_fields) THEN
      RAISE EXCEPTION 'INGREDIENT_USAGE_CHANGED: the products using % changed since the preview; preview again', v_row.name;
    END IF;
    v_result := public._edit_active_ingredient(p_ingredient_id, p_fields, p_reason, p_evidence, false);
  END IF;
  PERFORM public.save_idempotency(p_idempotency_key, 'save_active_ingredient',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.save_active_ingredient(uuid, integer, text, jsonb, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.save_active_ingredient(uuid, integer, text, jsonb, text, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.save_active_ingredient(uuid, integer, text, jsonb, text, text, text) TO authenticated;

CREATE FUNCTION public.retire_active_ingredient(p_ingredient_id uuid, p_expected_row_version integer, p_reason text,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'ingredient_id', p_ingredient_id,
    'expected_row_version', p_expected_row_version, 'reason', p_reason)::text);
  v_existing jsonb;
  v_reason text;
  v_old public.active_ingredients;
  v_new public.active_ingredients;
  v_users jsonb;
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'retire_active_ingredient', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', true);
  PERFORM pg_advisory_xact_lock(hashtext('crx.active_ingredients'));
  SELECT * INTO v_old FROM public.active_ingredients WHERE id = p_ingredient_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INGREDIENT_NOT_FOUND'; END IF;
  IF p_expected_row_version IS NULL OR v_old.row_version <> p_expected_row_version THEN
    RAISE EXCEPTION 'INGREDIENT_STALE: % changed since you opened it; reload and try again', v_old.name;
  END IF;
  IF v_old.status = 'retired' THEN RAISE EXCEPTION 'INGREDIENT_ALREADY_RETIRED: % is already retired', v_old.name; END IF;
  v_users := public._ingredient_users(p_ingredient_id);
  IF jsonb_array_length(v_users->'parents') > 0 OR jsonb_array_length(v_users->'forms') > 0 THEN
    RAISE EXCEPTION 'INGREDIENT_IN_USE: % is still used by products (%) or named as the acid of (%); swap it out first',
      v_old.name,
      COALESCE((SELECT string_agg(e->>'name', ', ') FROM jsonb_array_elements(v_users->'parents') e), 'none'),
      COALESCE((SELECT string_agg(e->>'name', ', ') FROM jsonb_array_elements(v_users->'forms') e), 'none');
  END IF;
  UPDATE public.active_ingredients
     SET status = 'retired', retire_reason = v_reason, row_version = row_version + 1, updated_by = auth.uid(), updated_at = now()
   WHERE id = p_ingredient_id
  RETURNING * INTO v_new;
  PERFORM public._active_ingredient_event(p_ingredient_id, 'retired', v_reason, NULL,
    public._active_ingredient_values(v_old), public._active_ingredient_values(v_new));
  v_result := public._active_ingredient_values(v_new);
  PERFORM public.save_idempotency(p_idempotency_key, 'retire_active_ingredient',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.retire_active_ingredient(uuid, integer, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.retire_active_ingredient(uuid, integer, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.retire_active_ingredient(uuid, integer, text, text) TO authenticated;

CREATE FUNCTION public.reactivate_active_ingredient(p_ingredient_id uuid, p_expected_row_version integer, p_reason text,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'ingredient_id', p_ingredient_id,
    'expected_row_version', p_expected_row_version, 'reason', p_reason)::text);
  v_existing jsonb;
  v_reason text;
  v_old public.active_ingredients;
  v_new public.active_ingredients;
  v_conflict text;
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'reactivate_active_ingredient', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', true);
  PERFORM pg_advisory_xact_lock(hashtext('crx.active_ingredients'));
  SELECT * INTO v_old FROM public.active_ingredients WHERE id = p_ingredient_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INGREDIENT_NOT_FOUND'; END IF;
  IF p_expected_row_version IS NULL OR v_old.row_version <> p_expected_row_version THEN
    RAISE EXCEPTION 'INGREDIENT_STALE: % changed since you opened it; reload and try again', v_old.name;
  END IF;
  IF v_old.status <> 'retired' THEN RAISE EXCEPTION 'INGREDIENT_NOT_RETIRED: % is active', v_old.name; END IF;
  -- The same identity checks as a new entry (D-AA-3).
  IF v_old.canonical_ingredient_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.active_ingredients c
        WHERE c.id = v_old.canonical_ingredient_id AND c.status = 'active' AND c.is_parent_form) THEN
    RAISE EXCEPTION 'INGREDIENT_CANONICAL_INVALID: the acid % names is no longer an active acid; reactivate or correct it first', v_old.name;
  END IF;
  SELECT string_agg(a.name, ', ' ORDER BY a.name) INTO v_conflict
    FROM public.active_ingredients a
   WHERE a.status = 'active' AND a.id <> p_ingredient_id AND a.name_key = v_old.name_key
     AND a.canonical_ingredient_id IS DISTINCT FROM v_old.canonical_ingredient_id;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'INGREDIENT_PARENT_CONFLICT: % already exists with a different acid; correct that ingredient first', v_conflict;
  END IF;
  UPDATE public.active_ingredients
     SET status = 'active', retire_reason = NULL, row_version = row_version + 1, updated_by = auth.uid(), updated_at = now()
   WHERE id = p_ingredient_id
  RETURNING * INTO v_new;
  PERFORM public._active_ingredient_event(p_ingredient_id, 'reactivated', v_reason, NULL,
    public._active_ingredient_values(v_old), public._active_ingredient_values(v_new));
  v_result := public._active_ingredient_values(v_new);
  PERFORM public.save_idempotency(p_idempotency_key, 'reactivate_active_ingredient',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.reactivate_active_ingredient(uuid, integer, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reactivate_active_ingredient(uuid, integer, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.reactivate_active_ingredient(uuid, integer, text, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Cost reference (CMP-1)
-- ---------------------------------------------------------------------------------------------

-- p_expected_row_version is 0 when the parent has no reference row yet. NULL p_reference_product_id clears it.
CREATE FUNCTION public.set_parent_cost_reference(p_parent_id uuid, p_reference_product_id uuid,
  p_expected_row_version integer, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'parent_id', p_parent_id,
    'reference_product_id', p_reference_product_id, 'expected_row_version', p_expected_row_version)::text);
  v_existing jsonb;
  v_name text;
  v_row public.product_parent_cost_reference;
  v_version integer;
  v_member record;
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'set_parent_cost_reference', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  SELECT name INTO v_name FROM public.product_parents WHERE id = p_parent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.products p
   WHERE p.id IN (SELECT m.product_id FROM public.product_parent_members m WHERE m.parent_id = p_parent_id)
   ORDER BY p.id FOR SHARE;
  SELECT * INTO v_row FROM public.product_parent_cost_reference WHERE parent_id = p_parent_id FOR UPDATE;
  v_version := COALESCE(v_row.row_version, 0);
  IF p_expected_row_version IS NULL OR v_version <> p_expected_row_version THEN
    RAISE EXCEPTION 'COST_REFERENCE_STALE: the reference size of "%" changed since you opened it; reload and try again', v_name;
  END IF;
  IF p_reference_product_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
                WHERE m.parent_id = p_parent_id AND m.size_role = 'bulk' AND p.is_active) THEN
      RAISE EXCEPTION 'COST_REFERENCE_BULK_WINS: "%" has an active bulk size, which is always its reference', v_name;
    END IF;
    SELECT m.parent_id, p.is_active INTO v_member
      FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
     WHERE m.product_id = p_reference_product_id AND m.parent_id = p_parent_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'COST_REFERENCE_NOT_MEMBER: that size is not a size of "%"', v_name; END IF;
    IF NOT v_member.is_active THEN RAISE EXCEPTION 'COST_REFERENCE_INACTIVE: that size is inactive; pick an active size'; END IF;
  END IF;
  IF v_row.parent_id IS NULL THEN
    IF p_reference_product_id IS NULL THEN
      v_result := jsonb_build_object('parent_id', p_parent_id, 'reference_product_id', NULL, 'row_version', 0, 'changed', false);
    ELSE
      INSERT INTO public.product_parent_cost_reference (parent_id, reference_product_id, row_version, set_by)
      VALUES (p_parent_id, p_reference_product_id, 1, auth.uid()) RETURNING * INTO v_row;
      v_result := to_jsonb(v_row) || jsonb_build_object('changed', true);
    END IF;
  ELSIF v_row.reference_product_id IS NOT DISTINCT FROM p_reference_product_id THEN
    v_result := to_jsonb(v_row) || jsonb_build_object('changed', false);
  ELSE
    UPDATE public.product_parent_cost_reference
       SET reference_product_id = p_reference_product_id, row_version = row_version + 1, set_by = auth.uid(), set_at = now()
     WHERE parent_id = p_parent_id
    RETURNING * INTO v_row;
    v_result := to_jsonb(v_row) || jsonb_build_object('changed', true);
  END IF;
  PERFORM public.save_idempotency(p_idempotency_key, 'set_parent_cost_reference',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.set_parent_cost_reference(uuid, uuid, integer, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_parent_cost_reference(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.set_parent_cost_reference(uuid, uuid, integer, text) TO authenticated;

-- Postflight: every DM-1 function is owned by postgres with a pinned search_path; only the public RPCs are
-- executable, and only by authenticated; every new table has RLS on and exactly one SELECT policy.
DO $postflight$
DECLARE
  c_public CONSTANT text[] := ARRAY['correct_parent_chemistry', 'get_active_ingredient_worklist', 'get_parent_active_costs',
    'get_parent_chemistry', 'preview_active_ingredient_change', 'preview_parent_chemistry_correction',
    'reactivate_active_ingredient', 'retire_active_ingredient', 'save_active_ingredient', 'search_active_ingredients',
    'set_parent_chemistry', 'set_parent_cost_reference'];
  c_private CONSTANT text[] := ARRAY['_active_ingredient_event', '_active_ingredient_values', '_apply_parent_chemistry',
    '_cents_half_up', '_check_parent_chemistry', '_chemistry_convert', '_chemistry_form_mass', '_chemistry_nutrient',
    '_chemistry_preview_fingerprint', '_chemistry_strength', '_chemistry_uuid', '_edit_active_ingredient',
    '_ingredient_cas_valid', '_ingredient_usage_fingerprint', '_ingredient_usage_parents', '_ingredient_users',
    '_lock_ingredient_parents', '_lock_parent_chemistry', '_oxide_factor', '_parent_active_cost_rows',
    '_parent_chemistry_epa_refusal', '_parent_chemistry_values', '_resolve_active_ingredient', '_size_cost_per_base',
    '_unit_factor_oz', 'refuse_chemistry_event_mutation', 'refuse_ingredient_map_write'];
  c_tables CONSTANT text[] := ARRAY['active_ingredients', 'active_ingredient_events', 'product_chemistry_events',
    'product_parent_ingredients', 'product_parent_modes_of_action', 'product_parent_fertilizer_analysis',
    'product_parent_chemistry_state', 'product_parent_cost_reference'];
  r record;
  v_table text;
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (c_public || c_private);
  IF v_count <> cardinality(c_public) + cardinality(c_private) THEN
    RAISE EXCEPTION 'DM-1 postflight: expected % functions, found %', cardinality(c_public) + cardinality(c_private), v_count;
  END IF;
  FOR r IN SELECT p.oid, p.proname, p.proowner, p.proconfig FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (c_public || c_private) LOOP
    IF r.proowner <> 'postgres'::regrole THEN RAISE EXCEPTION 'DM-1 postflight: % is not owned by postgres', r.proname; END IF;
    IF r.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
      RAISE EXCEPTION 'DM-1 postflight: % search_path is %', r.proname, r.proconfig;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') OR has_function_privilege('service_role', r.oid, 'EXECUTE')
       OR (SELECT proacl FROM pg_proc WHERE oid = r.oid) IS NULL
       OR EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = r.oid)) a WHERE a.grantee = 0) THEN
      RAISE EXCEPTION 'DM-1 postflight: % is executable by PUBLIC, anon or service_role', r.proname;
    END IF;
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE') <> (r.proname = ANY (c_public)) THEN
      RAISE EXCEPTION 'DM-1 postflight: % has the wrong authenticated EXECUTE', r.proname;
    END IF;
  END LOOP;
  FOREACH v_table IN ARRAY c_tables LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass('public.' || v_table)
                     AND c.relrowsecurity AND c.relowner = 'postgres'::regrole) THEN
      RAISE EXCEPTION 'DM-1 postflight: % lacks RLS or is not owned by postgres', v_table;
    END IF;
    SELECT count(*) INTO v_count FROM pg_policy pol WHERE pol.polrelid = to_regclass('public.' || v_table);
    IF v_count <> 1 OR EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = to_regclass('public.' || v_table)
                                  AND pol.polcmd <> 'r') THEN
      RAISE EXCEPTION 'DM-1 postflight: % must have exactly one SELECT policy', v_table;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || v_table, 'INSERT, UPDATE, DELETE, TRUNCATE')
       OR has_table_privilege('anon', 'public.' || v_table, 'SELECT') THEN
      RAISE EXCEPTION 'DM-1 postflight: % has a write grant or an anon read', v_table;
    END IF;
  END LOOP;
END;
$postflight$;
