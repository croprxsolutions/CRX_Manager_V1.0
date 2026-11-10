-- idempotency-body-check: exempt
-- (Every public writer checks its retry key through _product_parent_replay, which refuses a missing
--  key and calls check_idempotency, and saves its receipt with save_idempotency last, in the same
--  transaction. The two private draft helpers have no key of their own: DM-1b wraps them in its own
--  admin-checked, keyed RPC. Trigger functions take no caller input.)
--
-- DM-2 (docs/plans/2026-11-06-product-DM2-BUILD-SHEET.md section 3): weight per gallon and dry net weight.
--
-- New tables (RLS on, SELECT only, no write grant to any role, owner postgres):
--   * product_parent_density_values: a liquid parent's weight per gallon (lb/gal), one approved and
--     one draft at most, with source, review and the basis (form and identity) it was entered for.
--   * product_size_net_weight_values: net pounds of ONE stock unit of a dry size stocked in a count
--     unit (Ea, Unit), same shape; basis is the size's pack fields.
--   * product_parent_density_state / product_size_net_weight_state: the version every writer checks,
--     plus change generations (identity, pack, member) that only the triggers below move.
--   * product_weight_events: append-only history, one event per subject per call.
--   * blend_ticket_product_weights: the weight a ticket first used per (ticket, product); never changed.
--   * blend_ticket_weight_basis: the unit factor map a ticket's header total is checked with.
--   * job_loader_worksheet_weights: the weight a saved worksheet captured per (worksheet, product),
--     used only while still valid (worksheet_weight_is_valid).
-- Reads: _weight_unit_factors(), _product_weight() (private); get_product_weights (any active user),
--   get_blend_ticket_weights and get_loader_worksheet_weights (caller's own policies), each with read_at.
-- Writes (admin, retry key): set_parent_density, set_size_net_weight, correct_parent_density,
--   correct_size_net_weight, approve_weights. Private for DM-1b: _save_parent_density_draft,
--   _save_size_net_weight_draft. Private for DM-1: _approved_parent_lb_per_gal (real body).
-- Seven triggers on existing tables (no grant, revoke or policy change on any existing table):
--   blend_tickets: trigger_capture_blend_ticket_weight_basis, trigger_delete_blend_ticket_weights;
--   blend_ticket_products: trigger_capture_blend_ticket_product_weight;
--   job_loader_worksheets: trigger_capture_loader_worksheet_weights;
--   products: trigger_return_net_weight_to_draft; product_parents: trigger_return_density_to_draft;
--   product_parent_members: trigger_bump_member_generation.
-- No existing row is changed. Live has 0 blend tickets (refused below otherwise) and 0 weight values.
--
-- DM-2's own objects (excluded from the rollback's dependency query):
--   tables: product_parent_density_values, product_size_net_weight_values, product_parent_density_state,
--     product_size_net_weight_state, product_weight_events, blend_ticket_product_weights,
--     blend_ticket_weight_basis, job_loader_worksheet_weights;
--   functions: _weight_unit_factors, _product_weight, _product_weight_trust_rank, _product_weight_event,
--     _write_parent_density, _write_size_net_weight, _approve_weight_item_ok, _approved_parent_lb_per_gal,
--     get_product_weights, get_blend_ticket_weights, get_loader_worksheet_weights, worksheet_weight_is_valid,
--     set_parent_density, set_size_net_weight, correct_parent_density, correct_size_net_weight,
--     approve_weights, _save_parent_density_draft, _save_size_net_weight_draft,
--     capture_blend_ticket_product_weight, capture_blend_ticket_weight_basis, delete_blend_ticket_weights,
--     capture_loader_worksheet_weights, return_net_weight_to_draft, return_density_to_draft,
--     bump_member_generation, refuse_product_weight_event_mutation;
--   policies: product_parent_density_values_select, product_size_net_weight_values_select,
--     product_parent_density_state_select, product_size_net_weight_state_select,
--     product_weight_events_select, blend_ticket_product_weights_office_select,
--     blend_ticket_weight_basis_office_select, job_loader_worksheet_weights_select;
--   triggers: the seven above, plus product_weight_events_append_only and product_weight_events_no_truncate.
--
-- Rollback (Mason, 2026-11-06: a rollback hides everything; sheet section 3.7):
--   1. Roll back every package that reads DM-2 first (DM-1 cost per lb, DM-1b Weights tab). Refuse
--      while pg_proc has a function whose body names any DM-2 table or function, other than DM-2's
--      own above, or pg_depend shows a view, policy or trigger on a DM-2 object other than DM-2's own.
--   2. Search src/, supabase/functions/, scripts/ for every DM-2 name; remove any live reader outside
--      the DM-2 screen PR (scripts/smoke/prove-product-weights-real-schema.mjs is an offline harness and
--      is kept); revert the screen PR and confirm the live bundle no longer calls the three getters.
--   3. One migration:
--      REVOKE ALL ON TABLE <the eight DM-2 tables> FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
--      DROP POLICY job_loader_worksheet_weights_select ON public.job_loader_worksheet_weights;
--      DROP TRIGGER trigger_capture_blend_ticket_weight_basis ON public.blend_tickets;
--      DROP TRIGGER trigger_delete_blend_ticket_weights ON public.blend_tickets;
--      DROP TRIGGER trigger_capture_blend_ticket_product_weight ON public.blend_ticket_products;
--      DROP TRIGGER trigger_capture_loader_worksheet_weights ON public.job_loader_worksheets;
--      DROP TRIGGER trigger_return_net_weight_to_draft ON public.products;
--      DROP TRIGGER trigger_return_density_to_draft ON public.product_parents;
--      DROP TRIGGER trigger_bump_member_generation ON public.product_parent_members;
--      then DROP every DM-2 function above except refuse_product_weight_event_mutation (and its two
--      triggers). The tables are kept, unreadable, as history. Turning DM-2 back on needs its own plan.

SET LOCAL lock_timeout = '5s';

-- Every table lock the migration needs, in one fixed order, before any other statement (sheet 3.4).
-- SHARE ROW EXCLUSIVE blocks writes, not reads, until commit. Parents before products before members
-- matches both PAR-1 writers; ticket header before lines matches create_blend_ticket.
LOCK TABLE public.product_parents IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.product_parent_members IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.blend_tickets IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.blend_ticket_products IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.job_loader_worksheets IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF to_regclass('public.product_parent_density_values') IS NOT NULL
     OR to_regclass('public.product_size_net_weight_values') IS NOT NULL
     OR to_regclass('public.product_parent_density_state') IS NOT NULL
     OR to_regclass('public.product_size_net_weight_state') IS NOT NULL
     OR to_regclass('public.product_weight_events') IS NOT NULL
     OR to_regclass('public.blend_ticket_product_weights') IS NOT NULL
     OR to_regclass('public.blend_ticket_weight_basis') IS NOT NULL
     OR to_regclass('public.job_loader_worksheet_weights') IS NOT NULL
     OR to_regprocedure('public._product_weight(uuid,jsonb)') IS NOT NULL
     OR to_regprocedure('public.get_product_weights(uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DM2_ALREADY_PRESENT';
  END IF;
  IF to_regprocedure('public._product_parent_replay(text,text,text)') IS NULL
     OR to_regprocedure('public._product_parent_require_admin()') IS NULL
     OR to_regprocedure('public._product_parent_reason(text,text,boolean)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regprocedure('public.is_active_profile()') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_sales_rep()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DM2_HELPERS_MISSING';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'unit_conversions'
        AND column_name IN ('unit', 'factor_oz', 'unit_type')) <> 3
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_parents'
        AND column_name IN ('product_form', 'formulation_type', 'safener', 'generic_epa_registration', 'is_active', 'name')) <> 6
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products'
        AND column_name IN ('product_form', 'inventory_unit', 'container_size', 'container_type', 'container_unit',
                            'unit_size', 'is_active', 'product_name')) <> 8
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_chemicals'
        AND column_name IN ('job_id', 'product_id', 'quantity', 'unit')) <> 4 THEN
    RAISE EXCEPTION 'PREFLIGHT_DM2_COLUMNS_CHANGED';
  END IF;
  -- A ticket saved before the apply would have no snapshot or basis; a back-fill needs its own reviewed migration.
  IF EXISTS (SELECT 1 FROM public.blend_tickets) OR EXISTS (SELECT 1 FROM public.blend_ticket_products) THEN
    RAISE EXCEPTION 'PREFLIGHT_DM2_BLEND_TICKETS_EXIST: blend tickets exist; this migration must be replaced by one that back-fills their weights (sheet 3.4)';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.product_parent_density_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  -- Typo guard, not physics: farm chemicals run about 8 to 12 lb/gal; 20 is the cap (Mason, 2026-11-07).
  lb_per_gal numeric(10,4) NOT NULL CHECK (lb_per_gal > 0 AND lb_per_gal <= 20),
  entered_value numeric NOT NULL,
  entered_unit text NOT NULL CHECK (entered_unit IN ('lb_per_gal', 'specific_gravity')),
  source text NOT NULL CHECK (source IN ('measured', 'sds', 'label', 'supplier')),
  source_note text CHECK (source_note IS NULL OR (source_note = btrim(source_note) AND btrim(source_note) <> '' AND length(source_note) <= 1000)),
  basis jsonb NOT NULL,
  review_state text NOT NULL CHECK (review_state IN ('draft', 'approved', 'superseded')),
  reason text CHECK (reason IS NULL OR length(reason) <= 1000),
  evidence text CHECK (evidence IS NULL OR length(evidence) <= 1000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  superseded_at timestamptz,
  CONSTRAINT product_parent_density_values_review_fields CHECK (
    (review_state = 'approved' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND superseded_at IS NULL)
    OR (review_state = 'draft' AND reviewed_by IS NULL AND reviewed_at IS NULL AND superseded_at IS NULL)
    OR (review_state = 'superseded' AND superseded_at IS NOT NULL))
);
ALTER TABLE public.product_parent_density_values OWNER TO postgres;
CREATE UNIQUE INDEX product_parent_density_values_one_approved ON public.product_parent_density_values (parent_id) WHERE review_state = 'approved';
CREATE UNIQUE INDEX product_parent_density_values_one_draft ON public.product_parent_density_values (parent_id) WHERE review_state = 'draft';
COMMENT ON TABLE public.product_parent_density_values IS
  'DM-2: a liquid parent''s weight per gallon. One approved and one draft at most. Written only by the DM-2 writers and the identity trigger.';

CREATE TABLE public.product_size_net_weight_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  -- Net pounds of ONE stock unit. Typo guard: the largest one-unit packs are about 1,000 to 2,500 lb.
  net_lb numeric(12,4) NOT NULL CHECK (net_lb > 0 AND net_lb <= 4000),
  entered_value numeric NOT NULL,
  source text NOT NULL CHECK (source IN ('measured', 'sds', 'label', 'supplier')),
  source_note text CHECK (source_note IS NULL OR (source_note = btrim(source_note) AND btrim(source_note) <> '' AND length(source_note) <= 1000)),
  basis jsonb NOT NULL,
  review_state text NOT NULL CHECK (review_state IN ('draft', 'approved', 'superseded')),
  reason text CHECK (reason IS NULL OR length(reason) <= 1000),
  evidence text CHECK (evidence IS NULL OR length(evidence) <= 1000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  superseded_at timestamptz,
  CONSTRAINT product_size_net_weight_values_review_fields CHECK (
    (review_state = 'approved' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND superseded_at IS NULL)
    OR (review_state = 'draft' AND reviewed_by IS NULL AND reviewed_at IS NULL AND superseded_at IS NULL)
    OR (review_state = 'superseded' AND superseded_at IS NOT NULL))
);
ALTER TABLE public.product_size_net_weight_values OWNER TO postgres;
CREATE UNIQUE INDEX product_size_net_weight_values_one_approved ON public.product_size_net_weight_values (product_id) WHERE review_state = 'approved';
CREATE UNIQUE INDEX product_size_net_weight_values_one_draft ON public.product_size_net_weight_values (product_id) WHERE review_state = 'draft';
COMMENT ON TABLE public.product_size_net_weight_values IS
  'DM-2: net pounds of one stock unit of a dry size stocked in a count unit. Written only by the DM-2 writers and the pack trigger.';

CREATE TABLE public.product_parent_density_state (
  parent_id uuid PRIMARY KEY REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  density_version bigint NOT NULL DEFAULT 0,
  identity_generation bigint NOT NULL DEFAULT 0
);
ALTER TABLE public.product_parent_density_state OWNER TO postgres;
COMMENT ON TABLE public.product_parent_density_state IS
  'DM-2: a parent''s density version (every writer checks and moves it) and identity generation (only the identity trigger moves it).';

CREATE TABLE public.product_size_net_weight_state (
  product_id uuid PRIMARY KEY REFERENCES public.products(id) ON DELETE RESTRICT,
  net_weight_version bigint NOT NULL DEFAULT 0,
  pack_generation bigint NOT NULL DEFAULT 0,
  member_generation bigint NOT NULL DEFAULT 0
);
ALTER TABLE public.product_size_net_weight_state OWNER TO postgres;
COMMENT ON TABLE public.product_size_net_weight_state IS
  'DM-2: a size''s net-weight version and its pack and member generations (moved only by the pack and member triggers).';

CREATE TABLE public.product_weight_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_kind text NOT NULL CHECK (subject_kind IN ('parent_density', 'size_net_weight')),
  parent_id uuid,
  product_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('draft_saved', 'draft_replaced', 'approved', 'corrected', 'returned_to_draft')),
  value_id uuid,
  before_value jsonb,
  after_value jsonb,
  reason text,
  evidence text,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'system')),
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((subject_kind = 'parent_density' AND parent_id IS NOT NULL AND product_id IS NULL)
      OR (subject_kind = 'size_net_weight' AND product_id IS NOT NULL AND parent_id IS NULL)),
  CHECK ((actor_kind = 'system' AND changed_by IS NULL AND changed_by_name IS NULL)
      OR (actor_kind = 'user' AND changed_by IS NOT NULL))
);
ALTER TABLE public.product_weight_events OWNER TO postgres;
CREATE INDEX product_weight_events_parent_idx ON public.product_weight_events (parent_id, changed_at DESC, id DESC) WHERE parent_id IS NOT NULL;
CREATE INDEX product_weight_events_product_idx ON public.product_weight_events (product_id, changed_at DESC, id DESC) WHERE product_id IS NOT NULL;
COMMENT ON TABLE public.product_weight_events IS
  'DM-2: append-only weight history, one event per subject per call; before_value/after_value list every row changed.';

-- No foreign keys on blend_ticket_id or product_id (deliberate, sheet 3.1): a capture must never wait
-- on a ticket header or product row its own statement does not already hold.
CREATE TABLE public.blend_ticket_product_weights (
  blend_ticket_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name text NOT NULL,
  product_form text CHECK (product_form IS NULL OR product_form IN ('liquid', 'dry', 'seed', 'each')),
  weight_kind text NOT NULL CHECK (weight_kind IN ('density', 'net_weight', 'unit_weight', 'none')),
  value_id uuid,
  value_reviewed_at timestamptz,
  value_reviewed_by uuid,
  lb_per_unit numeric CHECK (lb_per_unit IS NULL OR lb_per_unit > 0),
  per_unit text,
  unit_factors jsonb NOT NULL,
  source text,
  value_basis jsonb,
  none_reason text CHECK (none_reason IS NULL OR none_reason IN ('no_parent', 'no_approved_weight', 'seed_or_each', 'unit_not_convertible', 'unknown_form')),
  captured_how text NOT NULL DEFAULT 'at_save' CHECK (captured_how IN ('at_save', 'backfill_at_apply')),
  captured_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (blend_ticket_id, product_id),
  CONSTRAINT blend_ticket_product_weights_kind_fields CHECK (
    (weight_kind IN ('density', 'net_weight') AND value_id IS NOT NULL AND value_reviewed_at IS NOT NULL
      AND value_reviewed_by IS NOT NULL AND lb_per_unit IS NOT NULL AND per_unit IS NOT NULL
      AND source IN ('measured', 'sds', 'label', 'supplier') AND value_basis IS NOT NULL AND none_reason IS NULL)
    OR (weight_kind = 'unit_weight' AND lb_per_unit IS NOT NULL AND per_unit IS NOT NULL AND source = 'unit'
      AND value_id IS NULL AND value_reviewed_at IS NULL AND value_reviewed_by IS NULL AND value_basis IS NULL AND none_reason IS NULL)
    OR (weight_kind = 'none' AND none_reason IS NOT NULL AND value_id IS NULL AND value_reviewed_at IS NULL
      AND value_reviewed_by IS NULL AND lb_per_unit IS NULL AND per_unit IS NULL AND source IS NULL AND value_basis IS NULL))
);
ALTER TABLE public.blend_ticket_product_weights OWNER TO postgres;
COMMENT ON TABLE public.blend_ticket_product_weights IS
  'DM-2: the weight a blend ticket first used for each product, copied by trigger at save; never changed.';

CREATE TABLE public.blend_ticket_weight_basis (
  blend_ticket_id uuid PRIMARY KEY REFERENCES public.blend_tickets(id) ON DELETE CASCADE,
  unit_factors jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.blend_ticket_weight_basis OWNER TO postgres;
COMMENT ON TABLE public.blend_ticket_weight_basis IS
  'DM-2: the unit factor map a ticket''s header total is checked with; set at header insert, replaced when the header total or unit changes.';

CREATE TABLE public.job_loader_worksheet_weights (
  worksheet_id uuid NOT NULL REFERENCES public.job_loader_worksheets(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  job_id uuid NOT NULL,
  product_name text NOT NULL,
  product_form text CHECK (product_form IS NULL OR product_form IN ('liquid', 'dry', 'seed', 'each')),
  weight_kind text NOT NULL CHECK (weight_kind IN ('density', 'net_weight', 'unit_weight', 'none')),
  value_id uuid,
  value_reviewed_at timestamptz,
  value_reviewed_by uuid,
  lb_per_unit numeric CHECK (lb_per_unit IS NULL OR lb_per_unit > 0),
  per_unit text,
  unit_factors jsonb NOT NULL,
  source text,
  value_basis jsonb,
  none_reason text CHECK (none_reason IS NULL OR none_reason IN ('no_parent', 'no_approved_weight', 'seed_or_each', 'unit_not_convertible', 'unknown_form')),
  pack_generation bigint,
  member_generation bigint,
  identity_generation bigint,
  captured_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (worksheet_id, product_id),
  CONSTRAINT job_loader_worksheet_weights_kind_fields CHECK (
    (weight_kind IN ('density', 'net_weight') AND value_id IS NOT NULL AND value_reviewed_at IS NOT NULL
      AND value_reviewed_by IS NOT NULL AND lb_per_unit IS NOT NULL AND per_unit IS NOT NULL
      AND source IN ('measured', 'sds', 'label', 'supplier') AND value_basis IS NOT NULL AND none_reason IS NULL)
    OR (weight_kind = 'unit_weight' AND lb_per_unit IS NOT NULL AND per_unit IS NOT NULL AND source = 'unit'
      AND value_id IS NULL AND value_reviewed_at IS NULL AND value_reviewed_by IS NULL AND value_basis IS NULL AND none_reason IS NULL)
    OR (weight_kind = 'none' AND none_reason IS NOT NULL AND value_id IS NULL AND value_reviewed_at IS NULL
      AND value_reviewed_by IS NULL AND lb_per_unit IS NULL AND per_unit IS NULL AND source IS NULL AND value_basis IS NULL)),
  CONSTRAINT job_loader_worksheet_weights_generations CHECK (
    (weight_kind <> 'net_weight' OR pack_generation IS NOT NULL)
    AND (weight_kind <> 'density' OR (member_generation IS NOT NULL AND identity_generation IS NOT NULL)))
);
ALTER TABLE public.job_loader_worksheet_weights OWNER TO postgres;
COMMENT ON TABLE public.job_loader_worksheet_weights IS
  'DM-2: the weight a saved loader worksheet captured per product; used only while worksheet_weight_is_valid.';

ALTER TABLE public.product_parent_density_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_size_net_weight_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_parent_density_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_size_net_weight_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_weight_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blend_ticket_product_weights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blend_ticket_weight_basis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_loader_worksheet_weights ENABLE ROW LEVEL SECURITY;

CREATE POLICY product_parent_density_values_select ON public.product_parent_density_values
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY product_size_net_weight_values_select ON public.product_size_net_weight_values
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY product_parent_density_state_select ON public.product_parent_density_state
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY product_size_net_weight_state_select ON public.product_size_net_weight_state
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY product_weight_events_select ON public.product_weight_events
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
-- The ticket's own office-only test (blend_tickets_office_select, blend_ticket_products_office_all);
-- a row whose ticket is gone or hidden is unreadable.
CREATE POLICY blend_ticket_product_weights_office_select ON public.blend_ticket_product_weights
  FOR SELECT TO authenticated
  USING ((public.is_admin() OR public.is_sales_rep())
         AND EXISTS (SELECT 1 FROM public.blend_tickets t WHERE t.id = blend_ticket_product_weights.blend_ticket_id));
CREATE POLICY blend_ticket_weight_basis_office_select ON public.blend_ticket_weight_basis
  FOR SELECT TO authenticated
  USING ((public.is_admin() OR public.is_sales_rep())
         AND EXISTS (SELECT 1 FROM public.blend_tickets t WHERE t.id = blend_ticket_weight_basis.blend_ticket_id));

REVOKE ALL ON TABLE public.product_parent_density_values, public.product_size_net_weight_values,
  public.product_parent_density_state, public.product_size_net_weight_state, public.product_weight_events,
  public.blend_ticket_product_weights, public.blend_ticket_weight_basis, public.job_loader_worksheet_weights
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON SEQUENCE public.product_weight_events_id_seq FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_parent_density_values, public.product_size_net_weight_values,
  public.product_parent_density_state, public.product_size_net_weight_state, public.product_weight_events,
  public.blend_ticket_product_weights, public.blend_ticket_weight_basis, public.job_loader_worksheet_weights
  TO authenticated;

CREATE FUNCTION public.refuse_product_weight_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'PRODUCT_WEIGHT_EVENTS_ARE_APPEND_ONLY';
END;
$function$;
ALTER FUNCTION public.refuse_product_weight_event_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_product_weight_event_mutation() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER product_weight_events_append_only
  BEFORE UPDATE OR DELETE ON public.product_weight_events
  FOR EACH ROW EXECUTE FUNCTION public.refuse_product_weight_event_mutation();
CREATE TRIGGER product_weight_events_no_truncate
  BEFORE TRUNCATE ON public.product_weight_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_product_weight_event_mutation();

-- ---------------------------------------------------------------------------------------------
-- Reading the one approved weight (sheet 3.2)
-- ---------------------------------------------------------------------------------------------

-- The unit map every reader and capture uses: {factors: {lower(trim(unit)): {kind, factor}}, ambiguous: [..]}.
-- weight: pounds per unit (factor_oz / 16); volume: gallons per unit (factor_oz / 128); count: factor_oz.
-- A lower-cased name with more than one (type, factor) is left out and listed in ambiguous.
CREATE FUNCTION public._weight_unit_factors() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  WITH u AS (
    SELECT lower(btrim(unit)) AS k, unit_type, factor_oz
      FROM public.unit_conversions
     WHERE unit IS NOT NULL AND btrim(unit) <> '' AND unit_type IN ('dry', 'liquid', 'both')
       AND factor_oz IS NOT NULL AND factor_oz > 0
  ), g AS (
    SELECT k, count(DISTINCT (unit_type, factor_oz)) AS n, min(unit_type) AS unit_type, min(factor_oz) AS factor_oz
      FROM u GROUP BY k
  )
  SELECT jsonb_build_object(
    'factors', COALESCE((SELECT jsonb_object_agg(k, jsonb_build_object(
        'kind', CASE unit_type WHEN 'dry' THEN 'weight' WHEN 'liquid' THEN 'volume' ELSE 'count' END,
        'factor', trim_scale(CASE unit_type WHEN 'dry' THEN factor_oz / 16 WHEN 'liquid' THEN factor_oz / 128 ELSE factor_oz END)))
      FROM g WHERE n = 1), '{}'::jsonb),
    'ambiguous', COALESCE((SELECT jsonb_agg(k ORDER BY k) FROM g WHERE n > 1), '[]'::jsonb));
$function$;
ALTER FUNCTION public._weight_unit_factors() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._weight_unit_factors() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- The one place a size's weight is resolved. STABLE: one snapshot, one committed approved row.
CREATE FUNCTION public._product_weight(p_product_id uuid, p_units jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_units jsonb := COALESCE(p_units, public._weight_unit_factors());
  v_p record;
  v_form text;
  v_parent uuid;
  v_entry jsonb;
  v_pack bigint := 0;
  v_member bigint := 0;
  v_identity bigint := 0;
  v_d public.product_parent_density_values%ROWTYPE;
  v_n public.product_size_net_weight_values%ROWTYPE;
BEGIN
  SELECT id, product_form, inventory_unit INTO v_p FROM public.products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'none', 'none_reason', 'unknown_form', 'found', false);
  END IF;
  v_form := CASE WHEN v_p.product_form IN ('liquid', 'dry', 'seed', 'each') THEN v_p.product_form END;
  SELECT COALESCE(s.pack_generation, 0), COALESCE(s.member_generation, 0) INTO v_pack, v_member
    FROM public.product_size_net_weight_state s WHERE s.product_id = p_product_id;
  v_pack := COALESCE(v_pack, 0);
  v_member := COALESCE(v_member, 0);

  IF v_form IS NULL THEN
    RETURN jsonb_build_object('kind', 'none', 'none_reason', 'unknown_form');
  ELSIF v_form IN ('seed', 'each') THEN
    RETURN jsonb_build_object('kind', 'none', 'none_reason', 'seed_or_each', 'product_form', v_form);
  ELSIF v_form = 'liquid' THEN
    SELECT m.parent_id INTO v_parent FROM public.product_parent_members m WHERE m.product_id = p_product_id;
    IF v_parent IS NULL THEN
      RETURN jsonb_build_object('kind', 'none', 'none_reason', 'no_parent', 'product_form', v_form,
        'member_generation', v_member);
    END IF;
    v_identity := COALESCE((SELECT s.identity_generation FROM public.product_parent_density_state s
                             WHERE s.parent_id = v_parent), 0);
    SELECT * INTO v_d FROM public.product_parent_density_values d
     WHERE d.parent_id = v_parent AND d.review_state = 'approved';
    IF NOT FOUND THEN
      RETURN jsonb_build_object('kind', 'none', 'none_reason', 'no_approved_weight', 'product_form', v_form,
        'parent_id', v_parent, 'member_generation', v_member, 'identity_generation', v_identity);
    END IF;
    RETURN jsonb_build_object('kind', 'density', 'product_form', v_form, 'parent_id', v_parent,
      'lb_per_unit', v_d.lb_per_gal, 'per_unit', 'Gal', 'value_id', v_d.id, 'source', v_d.source,
      'value_basis', v_d.basis, 'reviewed_at', v_d.reviewed_at, 'reviewed_by', v_d.reviewed_by,
      'reviewed_by_name', (SELECT pr.full_name FROM public.profiles pr WHERE pr.id = v_d.reviewed_by),
      'member_generation', v_member, 'identity_generation', v_identity);
  END IF;

  -- dry
  v_entry := v_units->'factors'->lower(btrim(COALESCE(v_p.inventory_unit, '')));
  IF v_entry->>'kind' = 'weight' THEN
    RETURN jsonb_build_object('kind', 'unit_weight', 'product_form', v_form,
      'lb_per_unit', (v_entry->>'factor')::numeric, 'per_unit', v_p.inventory_unit, 'source', 'unit');
  ELSIF v_entry->>'kind' = 'count' THEN
    SELECT * INTO v_n FROM public.product_size_net_weight_values n
     WHERE n.product_id = p_product_id AND n.review_state = 'approved';
    IF NOT FOUND THEN
      RETURN jsonb_build_object('kind', 'none', 'none_reason', 'no_approved_weight', 'product_form', v_form,
        'pack_generation', v_pack);
    END IF;
    RETURN jsonb_build_object('kind', 'net_weight', 'product_form', v_form,
      'lb_per_unit', v_n.net_lb, 'per_unit', v_p.inventory_unit, 'value_id', v_n.id, 'source', v_n.source,
      'value_basis', v_n.basis, 'reviewed_at', v_n.reviewed_at, 'reviewed_by', v_n.reviewed_by,
      'reviewed_by_name', (SELECT pr.full_name FROM public.profiles pr WHERE pr.id = v_n.reviewed_by),
      'pack_generation', v_pack);
  END IF;
  RETURN jsonb_build_object('kind', 'none', 'none_reason', 'unit_not_convertible', 'product_form', v_form);
END;
$function$;
ALTER FUNCTION public._product_weight(uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_weight(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- DM-1's interface (DM1-to-DM2 note): the parent's one approved weight per gallon and its row ID.
CREATE OR REPLACE FUNCTION public._approved_parent_lb_per_gal(p_parent_id uuid, OUT lb_per_gal numeric, OUT weight_row_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT d.lb_per_gal::numeric, d.id
    FROM (SELECT 1) one
    LEFT JOIN public.product_parent_density_values d ON d.parent_id = p_parent_id AND d.review_state = 'approved';
$function$;
ALTER FUNCTION public._approved_parent_lb_per_gal(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._approved_parent_lb_per_gal(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE FUNCTION public.get_product_weights(p_product_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_ids uuid[];
  v_units jsonb;
BEGIN
  IF NOT public.is_active_profile() THEN RAISE EXCEPTION 'ACTIVE_PROFILE_REQUIRED'; END IF;
  v_ids := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_product_ids, '{}'::uuid[])) x WHERE x IS NOT NULL);
  IF cardinality(v_ids) > 500 THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_TOO_MANY: weigh at most 500 products at once';
  END IF;
  v_units := public._weight_unit_factors();
  RETURN jsonb_build_object(
    'read_at', statement_timestamp(),
    'units', v_units,
    'products', COALESCE((
      SELECT jsonb_object_agg(i.id::text, CASE WHEN p.id IS NULL THEN jsonb_build_object('product_id', i.id, 'found', false)
        ELSE jsonb_build_object(
          'product_id', p.id, 'found', true, 'product_name', p.product_name, 'product_form', p.product_form,
          'inventory_unit', p.inventory_unit,
          'weight', public._product_weight(p.id, v_units),
          'subject', subj.subject,
          'current_basis', subj.basis,
          'draft', subj.draft)
        END)
        FROM unnest(v_ids) i(id)
        LEFT JOIN public.products p ON p.id = i.id
        LEFT JOIN public.product_parent_members m ON m.product_id = p.id
        LEFT JOIN public.product_parents pp ON pp.id = m.parent_id
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN p.product_form = 'liquid' AND pp.id IS NOT NULL THEN jsonb_build_object(
              'subject', jsonb_build_object('kind', 'density', 'subject_id', pp.id, 'parent_name', pp.name,
                'version', COALESCE((SELECT s.density_version FROM public.product_parent_density_state s WHERE s.parent_id = pp.id), 0)),
              'basis', jsonb_build_object('product_form', pp.product_form, 'formulation_type', pp.formulation_type,
                'safener', pp.safener, 'generic_epa_registration', pp.generic_epa_registration),
              'draft', (SELECT jsonb_build_object('id', d.id, 'value', d.lb_per_gal, 'entered_value', d.entered_value,
                  'entered_unit', d.entered_unit, 'source', d.source, 'source_note', d.source_note, 'reason', d.reason,
                  'evidence', d.evidence, 'created_by', d.created_by,
                  'created_by_name', (SELECT pr.full_name FROM public.profiles pr WHERE pr.id = d.created_by),
                  'created_at', d.created_at, 'basis', d.basis)
                  FROM public.product_parent_density_values d WHERE d.parent_id = pp.id AND d.review_state = 'draft'))
            WHEN p.product_form = 'dry'
             AND v_units->'factors'->lower(btrim(COALESCE(p.inventory_unit, '')))->>'kind' = 'count' THEN jsonb_build_object(
              'subject', jsonb_build_object('kind', 'net_weight', 'subject_id', p.id,
                'version', COALESCE((SELECT s.net_weight_version FROM public.product_size_net_weight_state s WHERE s.product_id = p.id), 0)),
              'basis', jsonb_build_object('container_size', p.container_size, 'container_type', p.container_type,
                'container_unit', p.container_unit, 'inventory_unit', p.inventory_unit, 'unit_size', p.unit_size),
              'draft', (SELECT jsonb_build_object('id', n.id, 'value', n.net_lb, 'entered_value', n.entered_value,
                  'entered_unit', 'lb', 'source', n.source, 'source_note', n.source_note, 'reason', n.reason,
                  'evidence', n.evidence, 'created_by', n.created_by,
                  'created_by_name', (SELECT pr.full_name FROM public.profiles pr WHERE pr.id = n.created_by),
                  'created_at', n.created_at, 'basis', n.basis)
                  FROM public.product_size_net_weight_values n WHERE n.product_id = p.id AND n.review_state = 'draft'))
            ELSE jsonb_build_object('subject', NULL, 'basis', NULL, 'draft', NULL)
          END AS s
        ) x
        CROSS JOIN LATERAL (SELECT x.s->'subject' AS subject, x.s->'basis' AS basis, x.s->'draft' AS draft) subj
    ), '{}'::jsonb));
END;
$function$;
ALTER FUNCTION public.get_product_weights(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_product_weights(uuid[]) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.get_product_weights(uuid[]) TO authenticated;

-- A saved ticket's lines, header, snapshots and basis from one snapshot, under the caller's own policies.
CREATE FUNCTION public.get_blend_ticket_weights(p_blend_ticket_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE
  v_current jsonb;
BEGIN
  -- The current map only (an empty ID list still returns it); a line's preview weight is read separately.
  v_current := public.get_product_weights('{}'::uuid[])->'units';
  RETURN jsonb_build_object(
    'read_at', statement_timestamp(),
    'ticket', (SELECT to_jsonb(t) - 'raw_ocr_text' FROM public.blend_tickets t WHERE t.id = p_blend_ticket_id),
    'basis_unit_factors', (SELECT b.unit_factors FROM public.blend_ticket_weight_basis b WHERE b.blend_ticket_id = p_blend_ticket_id),
    'current_unit_factors', v_current,
    'lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
          'line_id', l.id, 'product_id', l.product_id, 'product_name', l.product_name, 'line', jsonb_build_object(  -- named columns: unit_cost_cents is admin-only (20261022101000)
            'id', l.id, 'blend_ticket_id', l.blend_ticket_id, 'product_id', l.product_id, 'product_name', l.product_name,
            'quantity', l.quantity, 'unit', l.unit, 'lot_number', l.lot_number, 'sequence_order', l.sequence_order,
            'confidence_score', l.confidence_score, 'manually_corrected', l.manually_corrected, 'created_at', l.created_at,
            'rate_per_acre', l.rate_per_acre, 'rate_per_acre_unit', l.rate_per_acre_unit, 'unit_price_cents', l.unit_price_cents),
          'weight', CASE
            WHEN l.product_id IS NULL THEN jsonb_build_object('weight_kind', 'none', 'none_reason', 'unlinked')
            WHEN s.product_id IS NULL THEN jsonb_build_object('weight_kind', 'none', 'none_reason', 'not_recorded')
            ELSE (to_jsonb(s) - 'product_name') || jsonb_build_object('captured_name', s.product_name)
          END)
          ORDER BY l.sequence_order NULLS LAST, l.created_at, l.id)
        FROM public.blend_ticket_products l
        LEFT JOIN public.blend_ticket_product_weights s
          ON s.blend_ticket_id = l.blend_ticket_id AND s.product_id = l.product_id
       WHERE l.blend_ticket_id = p_blend_ticket_id), '[]'::jsonb),
    'retained', COALESCE((
      SELECT jsonb_object_agg(s.product_id::text, (to_jsonb(s) - 'product_name') || jsonb_build_object('captured_name', s.product_name))
        FROM public.blend_ticket_product_weights s
       WHERE s.blend_ticket_id = p_blend_ticket_id
         AND NOT EXISTS (SELECT 1 FROM public.blend_ticket_products l
                          WHERE l.blend_ticket_id = p_blend_ticket_id AND l.product_id = s.product_id)), '{}'::jsonb));
END;
$function$;
ALTER FUNCTION public.get_blend_ticket_weights(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_blend_ticket_weights(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.get_blend_ticket_weights(uuid) TO authenticated;

-- A worksheet row is used only while nothing it depended on has changed since capture (sheet 3.4b).
-- SECURITY INVOKER: reads the worksheet and job lines under the caller's own policies.
-- unit_weight and none rows need no generation: guard_product_setup_fields (20261102102000) refuses
-- changing a set product_form, inventory_unit or container_unit; filling a blank unit bumps the pack
-- generation; a blank form gives a none row, kept for its unit map (accepted limit, sheet 7, 2026-11-07).
-- A removed then re-added product keeps its first capture by design (sheet 3.4b, with its own test).
CREATE FUNCTION public.worksheet_weight_is_valid(r public.job_loader_worksheet_weights) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $function$
  SELECT EXISTS (SELECT 1 FROM public.job_loader_worksheets w WHERE w.id = r.worksheet_id AND w.job_id = r.job_id)
     AND EXISTS (SELECT 1 FROM public.job_chemicals c WHERE c.job_id = r.job_id AND c.product_id = r.product_id)
     AND CASE r.weight_kind
           WHEN 'net_weight' THEN r.pack_generation = COALESCE(
             (SELECT s.pack_generation FROM public.product_size_net_weight_state s WHERE s.product_id = r.product_id), 0)
           WHEN 'density' THEN r.member_generation = COALESCE(
               (SELECT s.member_generation FROM public.product_size_net_weight_state s WHERE s.product_id = r.product_id), 0)
             AND r.identity_generation = COALESCE(
               (SELECT ds.identity_generation FROM public.product_parent_density_values d
                  JOIN public.product_parent_density_state ds ON ds.parent_id = d.parent_id
                 WHERE d.id = r.value_id), -1)
           ELSE true
         END;
$function$;
ALTER FUNCTION public.worksheet_weight_is_valid(public.job_loader_worksheet_weights) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.worksheet_weight_is_valid(public.job_loader_worksheet_weights) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.worksheet_weight_is_valid(public.job_loader_worksheet_weights) TO authenticated;

CREATE POLICY job_loader_worksheet_weights_select ON public.job_loader_worksheet_weights
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.job_loader_worksheets w
                  WHERE w.id = job_loader_worksheet_weights.worksheet_id AND w.job_id = job_loader_worksheet_weights.job_id)
         AND public.worksheet_weight_is_valid(job_loader_worksheet_weights));

-- Saved worksheets (by worksheet ID) or each job's selected worksheet (by job ID), with the job's lines,
-- acres, settings, valid snapshot rows and current weights, all from one snapshot.
CREATE FUNCTION public.get_loader_worksheet_weights(p_worksheet_ids uuid[] DEFAULT NULL, p_job_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $function$
DECLARE
  v_ids uuid[];
  v_jobs uuid[];
  v_pids uuid[];
  v_units jsonb;
  v_current jsonb := '{}'::jsonb;
  v_r jsonb;
  v_i int := 1;
BEGIN
  IF (p_worksheet_ids IS NULL) = (p_job_ids IS NULL) THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_REQUEST: send worksheet IDs or job IDs, exactly one';
  END IF;
  v_ids := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_worksheet_ids, p_job_ids)) x WHERE x IS NOT NULL);
  IF cardinality(v_ids) > 200 THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_TOO_MANY: at most 200 worksheets or jobs at once';
  END IF;
  IF p_worksheet_ids IS NOT NULL THEN
    v_jobs := ARRAY(SELECT DISTINCT w.job_id FROM public.job_loader_worksheets w WHERE w.id = ANY (v_ids));
  ELSE
    v_jobs := v_ids;
  END IF;
  v_pids := ARRAY(SELECT DISTINCT c.product_id FROM public.job_chemicals c
                   WHERE c.job_id = ANY (v_jobs) AND c.product_id IS NOT NULL ORDER BY 1);
  LOOP
    v_r := public.get_product_weights(COALESCE(v_pids[v_i:v_i + 499], '{}'::uuid[]));
    v_units := COALESCE(v_units, v_r->'units');
    v_current := v_current || COALESCE(v_r->'products', '{}'::jsonb);
    v_i := v_i + 500;
    EXIT WHEN v_i > COALESCE(cardinality(v_pids), 0);
  END LOOP;

  RETURN jsonb_build_object(
    'read_at', statement_timestamp(),
    'unit_factors', v_units,
    'worksheets', CASE WHEN p_worksheet_ids IS NULL THEN NULL ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
          'worksheet_id', w.id, 'job_id', w.job_id, 'worksheet', to_jsonb(w),
          'vehicle_name', CASE WHEN w.vehicle_id IS NULL THEN 'Manual'
                               ELSE COALESCE((SELECT v.vehicle_name FROM public.vehicles v WHERE v.id = w.vehicle_id), 'Manual') END,
          'acres', (SELECT COALESCE(sum(f.acres_to_treat), 0) FROM public.job_fields f WHERE f.job_id = w.job_id),
          'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'product_id', c.product_id,
                        'quantity', c.quantity, 'unit', c.unit,
                        'product_name', COALESCE(NULLIF(p.product_name, ''), 'Product'), 'product_form', p.product_form)
                      ORDER BY c.sort_order NULLS LAST, c.id), '[]'::jsonb)
                      FROM public.job_chemicals c LEFT JOIN public.products p ON p.id = c.product_id
                     WHERE c.job_id = w.job_id),
          'weights', (SELECT COALESCE(jsonb_object_agg(pc.product_id::text, jsonb_build_object(
                          'saved', (SELECT to_jsonb(s) FROM public.job_loader_worksheet_weights s
                                     WHERE s.worksheet_id = w.id AND s.product_id = pc.product_id
                                       AND public.worksheet_weight_is_valid(s)),
                          'current', v_current->(pc.product_id::text)->'weight')), '{}'::jsonb)
                        FROM (SELECT DISTINCT c.product_id FROM public.job_chemicals c
                               WHERE c.job_id = w.job_id AND c.product_id IS NOT NULL) pc))
          ORDER BY w.id)
        FROM public.job_loader_worksheets w WHERE w.id = ANY (v_ids)), '[]'::jsonb) END,
    'jobs', CASE WHEN p_job_ids IS NULL THEN NULL ELSE COALESCE((
      SELECT jsonb_agg(CASE WHEN j.id IS NULL THEN jsonb_build_object('job_id', i.id, 'found', false)
        ELSE jsonb_build_object(
          'job_id', j.id, 'found', true,
          'job', jsonb_build_object('job_number', j.job_number, 'carrier_rate_gpa', j.carrier_rate_gpa,
            'loader_tank_capacity', j.loader_tank_capacity, 'loader_comment', j.loader_comment,
            'vehicle', (SELECT jsonb_build_object('vehicle_name', v.vehicle_name, 'capacity_gallons', v.capacity_gallons,
                          'capacity_unit', v.capacity_unit) FROM public.vehicles v WHERE v.id = j.vehicle_id)),
          'acres', (SELECT COALESCE(sum(f.acres_to_treat), 0) FROM public.job_fields f WHERE f.job_id = j.id),
          'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'product_id', c.product_id,
                        'quantity', c.quantity, 'unit', c.unit,
                        'product_name', COALESCE(NULLIF(p.product_name, ''), 'Product'), 'product_form', p.product_form)
                      ORDER BY c.sort_order NULLS LAST, c.id), '[]'::jsonb)
                      FROM public.job_chemicals c LEFT JOIN public.products p ON p.id = c.product_id
                     WHERE c.job_id = j.id),
          'current', (SELECT COALESCE(jsonb_object_agg(pc.product_id::text, v_current->(pc.product_id::text)->'weight'), '{}'::jsonb)
                        FROM (SELECT DISTINCT c.product_id FROM public.job_chemicals c
                               WHERE c.job_id = j.id AND c.product_id IS NOT NULL) pc),
          'worksheet', (SELECT jsonb_build_object(
              'id', w.id, 'worksheet', to_jsonb(w),
              'vehicle_name', CASE WHEN w.vehicle_id IS NULL THEN 'Manual'
                                   ELSE COALESCE((SELECT v.vehicle_name FROM public.vehicles v WHERE v.id = w.vehicle_id), 'Manual') END,
              'saved', (SELECT COALESCE(jsonb_object_agg(s.product_id::text, to_jsonb(s)), '{}'::jsonb)
                          FROM public.job_loader_worksheet_weights s
                         WHERE s.worksheet_id = w.id AND public.worksheet_weight_is_valid(s)))
            FROM public.job_loader_worksheets w WHERE w.job_id = j.id AND w.is_selected))
        END ORDER BY i.ord)
        FROM unnest(v_ids) WITH ORDINALITY i(id, ord)
        LEFT JOIN public.jobs j ON j.id = i.id), '[]'::jsonb) END);
END;
$function$;
ALTER FUNCTION public.get_loader_worksheet_weights(uuid[], uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_loader_worksheet_weights(uuid[], uuid[]) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.get_loader_worksheet_weights(uuid[], uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Writers (sheet 3.3)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public._product_weight_trust_rank(p_source text) RETURNS int
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT CASE p_source WHEN 'measured' THEN 4 WHEN 'sds' THEN 3 WHEN 'label' THEN 2 WHEN 'supplier' THEN 1 END;
$function$;
ALTER FUNCTION public._product_weight_trust_rank(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_weight_trust_rank(text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- One event per subject per call. 'system' only when no user is signed in (a trigger reached outside the app).
CREATE FUNCTION public._product_weight_event(p_kind text, p_parent_id uuid, p_product_id uuid, p_type text,
  p_value_id uuid, p_before jsonb, p_after jsonb, p_reason text, p_evidence text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_id bigint;
BEGIN
  INSERT INTO public.product_weight_events (subject_kind, parent_id, product_id, event_type, value_id,
    before_value, after_value, reason, evidence, actor_kind, changed_by, changed_by_name)
  VALUES (p_kind, p_parent_id, p_product_id, p_type, p_value_id, p_before, p_after, p_reason, p_evidence,
    CASE WHEN v_uid IS NULL THEN 'system' ELSE 'user' END, v_uid,
    (SELECT pr.full_name FROM public.profiles pr WHERE v_uid IS NOT NULL AND pr.id = v_uid))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;
ALTER FUNCTION public._product_weight_event(text, uuid, uuid, text, uuid, jsonb, jsonb, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_weight_event(text, uuid, uuid, text, uuid, jsonb, jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Shared body of the density setter, corrector and draft helper. p_mode: 'set' | 'correct' | 'draft'.
-- Locks the parent row FOR NO KEY UPDATE, then its state row FOR UPDATE (sheet 3.5 order).
CREATE FUNCTION public._write_parent_density(p_mode text, p_parent_id uuid, p_expected bigint, p_value numeric,
  p_unit text, p_source text, p_note text, p_reason text, p_evidence text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_lb numeric;
  v_note text;
  v_reason text;
  v_evidence text;
  v_parent public.product_parents%ROWTYPE;
  v_version bigint;
  v_appr public.product_parent_density_values%ROWTYPE;
  v_draft public.product_parent_density_values%ROWTYPE;
  v_has_appr boolean;
  v_has_draft boolean;
  v_new public.product_parent_density_values%ROWTYPE;
  v_before jsonb := '[]'::jsonb;
  v_after jsonb := '[]'::jsonb;
  v_type text;
  v_event bigint;
BEGIN
  IF p_unit IS NULL OR p_unit NOT IN ('lb_per_gal', 'specific_gravity') THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_UNIT: enter the weight in lb_per_gal or specific_gravity';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('measured', 'sds', 'label', 'supplier') THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_SOURCE: the source must be measured, sds, label or supplier';
  END IF;
  IF p_value IS NULL OR p_value::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_VALUE: enter a number';
  END IF;
  -- Rounded first (half-up, 4 decimals), then range-checked, so a value that rounds to 0 is refused by name.
  v_lb := round(CASE p_unit WHEN 'specific_gravity' THEN p_value * 8.345404 ELSE p_value END, 4);
  IF v_lb <= 0 OR v_lb > 20 THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_OUT_OF_RANGE: weight per gallon must be above 0 and at most 20 lb/gal (this is % lb/gal)', v_lb;
  END IF;
  v_note := public._product_parent_reason(p_note, 'note', false);
  IF p_mode = 'correct' THEN
    v_reason := public._product_parent_reason(p_reason, 'reason', true);
    v_evidence := public._product_parent_reason(p_evidence, 'evidence', true);
  END IF;

  SELECT * INTO v_parent FROM public.product_parents WHERE id = p_parent_id FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT v_parent.is_active OR v_parent.product_form <> 'liquid' THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_NOT_LIQUID: weight per gallon is recorded only for an active liquid parent';
  END IF;
  INSERT INTO public.product_parent_density_state (parent_id) VALUES (p_parent_id) ON CONFLICT DO NOTHING;
  SELECT density_version INTO v_version FROM public.product_parent_density_state WHERE parent_id = p_parent_id FOR UPDATE;
  IF p_expected IS NULL OR v_version <> p_expected THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_STALE: the weight of "%" changed since you opened it; reload', v_parent.name;
  END IF;

  SELECT * INTO v_appr FROM public.product_parent_density_values
   WHERE parent_id = p_parent_id AND review_state = 'approved' FOR UPDATE;
  v_has_appr := FOUND;
  SELECT * INTO v_draft FROM public.product_parent_density_values
   WHERE parent_id = p_parent_id AND review_state = 'draft' FOR UPDATE;
  v_has_draft := FOUND;

  IF v_has_appr AND public._product_weight_trust_rank(p_source) < public._product_weight_trust_rank(v_appr.source) THEN
    IF p_mode = 'set' THEN
      RAISE EXCEPTION 'PRODUCT_WEIGHT_LOWER_TRUST: the approved value is from the %; use Correct weight with a reason and evidence', v_appr.source;
    ELSIF p_mode = 'draft' THEN
      v_reason := public._product_parent_reason(p_reason, 'reason', true);
      v_evidence := public._product_parent_reason(p_evidence, 'evidence', true);
    END IF;
  END IF;

  IF p_mode IN ('set', 'correct') AND v_has_appr THEN
    v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_appr.id, 'review_state', v_appr.review_state,
      'value', v_appr.lb_per_gal, 'basis', v_appr.basis, 'reviewed_by', v_appr.reviewed_by, 'reviewed_at', v_appr.reviewed_at));
    UPDATE public.product_parent_density_values SET review_state = 'superseded', superseded_at = now()
     WHERE id = v_appr.id RETURNING * INTO v_appr;
    v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_appr.id, 'review_state', v_appr.review_state,
      'value', v_appr.lb_per_gal, 'basis', v_appr.basis, 'reviewed_by', v_appr.reviewed_by, 'reviewed_at', v_appr.reviewed_at));
  END IF;
  IF v_has_draft THEN
    v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_draft.id, 'review_state', v_draft.review_state,
      'value', v_draft.lb_per_gal, 'basis', v_draft.basis, 'reviewed_by', v_draft.reviewed_by, 'reviewed_at', v_draft.reviewed_at));
    UPDATE public.product_parent_density_values SET review_state = 'superseded', superseded_at = now()
     WHERE id = v_draft.id RETURNING * INTO v_draft;
    v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_draft.id, 'review_state', v_draft.review_state,
      'value', v_draft.lb_per_gal, 'basis', v_draft.basis, 'reviewed_by', v_draft.reviewed_by, 'reviewed_at', v_draft.reviewed_at));
  END IF;

  INSERT INTO public.product_parent_density_values (parent_id, lb_per_gal, entered_value, entered_unit, source, source_note,
    basis, review_state, reason, evidence, created_by, reviewed_by, reviewed_at)
  VALUES (p_parent_id, v_lb, p_value, p_unit, p_source, v_note,
    jsonb_build_object('product_form', v_parent.product_form, 'formulation_type', v_parent.formulation_type,
      'safener', v_parent.safener, 'generic_epa_registration', v_parent.generic_epa_registration),
    CASE WHEN p_mode = 'draft' THEN 'draft' ELSE 'approved' END, v_reason, v_evidence, auth.uid(),
    CASE WHEN p_mode = 'draft' THEN NULL ELSE auth.uid() END, CASE WHEN p_mode = 'draft' THEN NULL ELSE now() END)
  RETURNING * INTO v_new;
  v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_new.id, 'review_state', v_new.review_state,
    'value', v_new.lb_per_gal, 'basis', v_new.basis, 'reviewed_by', v_new.reviewed_by, 'reviewed_at', v_new.reviewed_at));

  UPDATE public.product_parent_density_state SET density_version = density_version + 1
   WHERE parent_id = p_parent_id RETURNING density_version INTO v_version;
  v_type := CASE p_mode WHEN 'set' THEN 'approved' WHEN 'correct' THEN 'corrected'
                        ELSE CASE WHEN v_has_draft THEN 'draft_replaced' ELSE 'draft_saved' END END;
  v_event := public._product_weight_event('parent_density', p_parent_id, NULL, v_type, v_new.id,
    v_before, v_after, v_reason, v_evidence);
  RETURN jsonb_build_object('kind', 'density', 'subject_id', p_parent_id, 'value_id', v_new.id,
    'review_state', v_new.review_state, 'lb_per_gal', v_new.lb_per_gal, 'version', v_version, 'event_id', v_event);
END;
$function$;
ALTER FUNCTION public._write_parent_density(text, uuid, bigint, numeric, text, text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._write_parent_density(text, uuid, bigint, numeric, text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Shared body of the net-weight setter, corrector and draft helper. Locks the size's products row
-- FOR NO KEY UPDATE, then its state row FOR UPDATE.
CREATE FUNCTION public._write_size_net_weight(p_mode text, p_product_id uuid, p_expected bigint, p_net_lb numeric,
  p_source text, p_note text, p_reason text, p_evidence text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_lb numeric;
  v_note text;
  v_reason text;
  v_evidence text;
  v_p public.products%ROWTYPE;
  v_kind text;
  v_version bigint;
  v_appr public.product_size_net_weight_values%ROWTYPE;
  v_draft public.product_size_net_weight_values%ROWTYPE;
  v_has_appr boolean;
  v_has_draft boolean;
  v_new public.product_size_net_weight_values%ROWTYPE;
  v_before jsonb := '[]'::jsonb;
  v_after jsonb := '[]'::jsonb;
  v_type text;
  v_event bigint;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('measured', 'sds', 'label', 'supplier') THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_SOURCE: the source must be measured, sds, label or supplier';
  END IF;
  IF p_net_lb IS NULL OR p_net_lb::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_VALUE: enter a number';
  END IF;
  v_lb := round(p_net_lb, 4);
  IF v_lb <= 0 OR v_lb > 4000 THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_OUT_OF_RANGE: net weight must be above 0 and at most 4000 lb (this is % lb)', v_lb;
  END IF;
  v_note := public._product_parent_reason(p_note, 'note', false);
  IF p_mode = 'correct' THEN
    v_reason := public._product_parent_reason(p_reason, 'reason', true);
    v_evidence := public._product_parent_reason(p_evidence, 'evidence', true);
  END IF;

  SELECT * INTO v_p FROM public.products WHERE id = p_product_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_NOT_DRY: no such product';
  END IF;
  IF v_p.product_form IS DISTINCT FROM 'dry' THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_NOT_DRY: "%" is not a dry product', v_p.product_name;
  END IF;
  IF NOT COALESCE(v_p.is_active, false) THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_NOT_ELIGIBLE: "%" is not active', v_p.product_name;
  END IF;
  v_kind := public._weight_unit_factors()->'factors'->lower(btrim(COALESCE(v_p.inventory_unit, '')))->>'kind';
  IF v_kind = 'weight' THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_FROM_UNIT: "%" is stocked in %, so its weight comes from the unit', v_p.product_name, v_p.inventory_unit;
  ELSIF v_kind IS DISTINCT FROM 'count' THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_NO_COUNT_UNIT: "%" is not stocked in a count unit (Ea or Unit), so it has no pack weight', v_p.product_name;
  END IF;
  INSERT INTO public.product_size_net_weight_state (product_id) VALUES (p_product_id) ON CONFLICT DO NOTHING;
  SELECT net_weight_version INTO v_version FROM public.product_size_net_weight_state WHERE product_id = p_product_id FOR UPDATE;
  IF p_expected IS NULL OR v_version <> p_expected THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_STALE: the weight of "%" changed since you opened it; reload', v_p.product_name;
  END IF;

  SELECT * INTO v_appr FROM public.product_size_net_weight_values
   WHERE product_id = p_product_id AND review_state = 'approved' FOR UPDATE;
  v_has_appr := FOUND;
  SELECT * INTO v_draft FROM public.product_size_net_weight_values
   WHERE product_id = p_product_id AND review_state = 'draft' FOR UPDATE;
  v_has_draft := FOUND;

  IF v_has_appr AND public._product_weight_trust_rank(p_source) < public._product_weight_trust_rank(v_appr.source) THEN
    IF p_mode = 'set' THEN
      RAISE EXCEPTION 'PRODUCT_WEIGHT_LOWER_TRUST: the approved value is from the %; use Correct weight with a reason and evidence', v_appr.source;
    ELSIF p_mode = 'draft' THEN
      v_reason := public._product_parent_reason(p_reason, 'reason', true);
      v_evidence := public._product_parent_reason(p_evidence, 'evidence', true);
    END IF;
  END IF;

  IF p_mode IN ('set', 'correct') AND v_has_appr THEN
    v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_appr.id, 'review_state', v_appr.review_state,
      'value', v_appr.net_lb, 'basis', v_appr.basis, 'reviewed_by', v_appr.reviewed_by, 'reviewed_at', v_appr.reviewed_at));
    UPDATE public.product_size_net_weight_values SET review_state = 'superseded', superseded_at = now()
     WHERE id = v_appr.id RETURNING * INTO v_appr;
    v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_appr.id, 'review_state', v_appr.review_state,
      'value', v_appr.net_lb, 'basis', v_appr.basis, 'reviewed_by', v_appr.reviewed_by, 'reviewed_at', v_appr.reviewed_at));
  END IF;
  IF v_has_draft THEN
    v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_draft.id, 'review_state', v_draft.review_state,
      'value', v_draft.net_lb, 'basis', v_draft.basis, 'reviewed_by', v_draft.reviewed_by, 'reviewed_at', v_draft.reviewed_at));
    UPDATE public.product_size_net_weight_values SET review_state = 'superseded', superseded_at = now()
     WHERE id = v_draft.id RETURNING * INTO v_draft;
    v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_draft.id, 'review_state', v_draft.review_state,
      'value', v_draft.net_lb, 'basis', v_draft.basis, 'reviewed_by', v_draft.reviewed_by, 'reviewed_at', v_draft.reviewed_at));
  END IF;

  INSERT INTO public.product_size_net_weight_values (product_id, net_lb, entered_value, source, source_note, basis,
    review_state, reason, evidence, created_by, reviewed_by, reviewed_at)
  VALUES (p_product_id, v_lb, p_net_lb, p_source, v_note,
    jsonb_build_object('container_size', v_p.container_size, 'container_type', v_p.container_type,
      'container_unit', v_p.container_unit, 'inventory_unit', v_p.inventory_unit, 'unit_size', v_p.unit_size),
    CASE WHEN p_mode = 'draft' THEN 'draft' ELSE 'approved' END, v_reason, v_evidence, auth.uid(),
    CASE WHEN p_mode = 'draft' THEN NULL ELSE auth.uid() END, CASE WHEN p_mode = 'draft' THEN NULL ELSE now() END)
  RETURNING * INTO v_new;
  v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_new.id, 'review_state', v_new.review_state,
    'value', v_new.net_lb, 'basis', v_new.basis, 'reviewed_by', v_new.reviewed_by, 'reviewed_at', v_new.reviewed_at));

  UPDATE public.product_size_net_weight_state SET net_weight_version = net_weight_version + 1
   WHERE product_id = p_product_id RETURNING net_weight_version INTO v_version;
  v_type := CASE p_mode WHEN 'set' THEN 'approved' WHEN 'correct' THEN 'corrected'
                        ELSE CASE WHEN v_has_draft THEN 'draft_replaced' ELSE 'draft_saved' END END;
  v_event := public._product_weight_event('size_net_weight', NULL, p_product_id, v_type, v_new.id,
    v_before, v_after, v_reason, v_evidence);
  RETURN jsonb_build_object('kind', 'net_weight', 'subject_id', p_product_id, 'value_id', v_new.id,
    'review_state', v_new.review_state, 'net_lb', v_new.net_lb, 'version', v_version, 'event_id', v_event);
END;
$function$;
ALTER FUNCTION public._write_size_net_weight(text, uuid, bigint, numeric, text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._write_size_net_weight(text, uuid, bigint, numeric, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE FUNCTION public.set_parent_density(p_parent_id uuid, p_expected_density_version bigint, p_value numeric,
  p_unit text, p_source text, p_source_note text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', v_actor, 'parent_id', p_parent_id,
    'expected_version', p_expected_density_version, 'value', p_value::text, 'unit', p_unit, 'source', p_source,
    'source_note', p_source_note)::text);
  v_existing jsonb;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'set_parent_density', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_receipt := public._write_parent_density('set', p_parent_id, p_expected_density_version, p_value, p_unit,
    p_source, p_source_note, NULL, NULL);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_parent_density',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.set_parent_density(uuid, bigint, numeric, text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_parent_density(uuid, bigint, numeric, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.set_parent_density(uuid, bigint, numeric, text, text, text, text) TO authenticated;

CREATE FUNCTION public.correct_parent_density(p_parent_id uuid, p_expected_density_version bigint, p_value numeric,
  p_unit text, p_source text, p_source_note text, p_reason text, p_evidence text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', v_actor, 'parent_id', p_parent_id,
    'expected_version', p_expected_density_version, 'value', p_value::text, 'unit', p_unit, 'source', p_source,
    'source_note', p_source_note, 'reason', p_reason, 'evidence', p_evidence)::text);
  v_existing jsonb;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'correct_parent_density', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_receipt := public._write_parent_density('correct', p_parent_id, p_expected_density_version, p_value, p_unit,
    p_source, p_source_note, p_reason, p_evidence);
  PERFORM public.save_idempotency(p_idempotency_key, 'correct_parent_density',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.correct_parent_density(uuid, bigint, numeric, text, text, text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.correct_parent_density(uuid, bigint, numeric, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.correct_parent_density(uuid, bigint, numeric, text, text, text, text, text, text) TO authenticated;

CREATE FUNCTION public.set_size_net_weight(p_product_id uuid, p_expected_version bigint, p_net_lb numeric,
  p_source text, p_source_note text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', v_actor, 'product_id', p_product_id,
    'expected_version', p_expected_version, 'net_lb', p_net_lb::text, 'source', p_source,
    'source_note', p_source_note)::text);
  v_existing jsonb;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'set_size_net_weight', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_receipt := public._write_size_net_weight('set', p_product_id, p_expected_version, p_net_lb, p_source,
    p_source_note, NULL, NULL);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_size_net_weight',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.set_size_net_weight(uuid, bigint, numeric, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_size_net_weight(uuid, bigint, numeric, text, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.set_size_net_weight(uuid, bigint, numeric, text, text, text) TO authenticated;

CREATE FUNCTION public.correct_size_net_weight(p_product_id uuid, p_expected_version bigint, p_net_lb numeric,
  p_source text, p_source_note text, p_reason text, p_evidence text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', v_actor, 'product_id', p_product_id,
    'expected_version', p_expected_version, 'net_lb', p_net_lb::text, 'source', p_source,
    'source_note', p_source_note, 'reason', p_reason, 'evidence', p_evidence)::text);
  v_existing jsonb;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'correct_size_net_weight', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_receipt := public._write_size_net_weight('correct', p_product_id, p_expected_version, p_net_lb, p_source,
    p_source_note, p_reason, p_evidence);
  PERFORM public.save_idempotency(p_idempotency_key, 'correct_size_net_weight',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.correct_size_net_weight(uuid, bigint, numeric, text, text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.correct_size_net_weight(uuid, bigint, numeric, text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.correct_size_net_weight(uuid, bigint, numeric, text, text, text, text, text) TO authenticated;

-- Private helpers for DM-1b's Weights tab: save a DRAFT. Lower trust than the approved value needs a
-- reason and evidence. No admin check or key of their own; DM-1b's public RPC adds both.
CREATE FUNCTION public._save_parent_density_draft(p_parent_id uuid, p_expected_version bigint, p_value numeric,
  p_unit text, p_source text, p_source_note text, p_reason text, p_evidence text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  RETURN public._write_parent_density('draft', p_parent_id, p_expected_version, p_value, p_unit, p_source,
    p_source_note, p_reason, p_evidence);
END;
$function$;
ALTER FUNCTION public._save_parent_density_draft(uuid, bigint, numeric, text, text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._save_parent_density_draft(uuid, bigint, numeric, text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE FUNCTION public._save_size_net_weight_draft(p_product_id uuid, p_expected_version bigint, p_net_lb numeric,
  p_source text, p_source_note text, p_reason text, p_evidence text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  RETURN public._write_size_net_weight('draft', p_product_id, p_expected_version, p_net_lb, p_source,
    p_source_note, p_reason, p_evidence);
END;
$function$;
ALTER FUNCTION public._save_size_net_weight_draft(uuid, bigint, numeric, text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._save_size_net_weight_draft(uuid, bigint, numeric, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Shape of one approve_weights item: exactly {kind, subject_id, draft_id, expected_version}.
CREATE FUNCTION public._approve_weight_item_ok(p_item jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_version numeric;
BEGIN
  IF p_item IS NULL OR jsonb_typeof(p_item) <> 'object' THEN RETURN false; END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_item) k)
     IS DISTINCT FROM ARRAY['draft_id', 'expected_version', 'kind', 'subject_id'] THEN RETURN false; END IF;
  IF jsonb_typeof(p_item->'kind') <> 'string' OR p_item->>'kind' NOT IN ('density', 'net_weight') THEN RETURN false; END IF;
  IF jsonb_typeof(p_item->'subject_id') <> 'string' OR p_item->>'subject_id' !~ v_uuid THEN RETURN false; END IF;
  IF jsonb_typeof(p_item->'draft_id') <> 'string' OR p_item->>'draft_id' !~ v_uuid THEN RETURN false; END IF;
  IF jsonb_typeof(p_item->'expected_version') <> 'number' THEN RETURN false; END IF;
  -- Checked as an exact numeric before any cast, so 1.2 or 1e30 is refused, never rounded.
  v_version := (p_item->'expected_version')::numeric;
  IF v_version <> trunc(v_version) OR v_version < 0 OR v_version > 9223372036854775807 THEN RETURN false; END IF;
  RETURN true;
END;
$function$;
ALTER FUNCTION public._approve_weight_item_ok(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._approve_weight_item_ok(jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE FUNCTION public.approve_weights(p_items jsonb, p_idempotency_key text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', v_actor, 'items', p_items)::text);
  v_existing jsonb;
  v_n int;
  v_i int;
  v_it jsonb;
  v_id uuid;
  v_subject uuid;
  v_draft_id uuid;
  v_expected bigint;
  v_version bigint;
  v_parent public.product_parents%ROWTYPE;
  v_p public.products%ROWTYPE;
  v_basis jsonb;
  v_d_appr public.product_parent_density_values%ROWTYPE;
  v_d_draft public.product_parent_density_values%ROWTYPE;
  v_n_appr public.product_size_net_weight_values%ROWTYPE;
  v_n_draft public.product_size_net_weight_values%ROWTYPE;
  v_has_appr boolean;
  v_before jsonb;
  v_after jsonb;
  v_event bigint;
  v_done jsonb := '[]'::jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'approve_weights', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  -- Shape first, before any subject or version row is locked.
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_REQUEST: send a list of 1 to 200 items';
  END IF;
  v_n := jsonb_array_length(p_items);
  IF v_n < 1 OR v_n > 200 THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_REQUEST: send a list of 1 to 200 items';
  END IF;
  FOR v_i IN 0 .. v_n - 1 LOOP
    IF NOT public._approve_weight_item_ok(p_items->v_i) THEN
      RAISE EXCEPTION 'PRODUCT_WEIGHT_BAD_REQUEST: item % must be exactly {kind, subject_id, draft_id, expected_version}', v_i + 1;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) e
              GROUP BY e->>'kind', (e->>'subject_id')::uuid HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'PRODUCT_WEIGHT_DUPLICATE_ITEM: each weight may appear once per approval';
  END IF;

  -- Subject rows, all parents before all sizes, each in ID order; then version rows in the same order.
  FOR v_id IN SELECT (e->>'subject_id')::uuid FROM jsonb_array_elements(p_items) e WHERE e->>'kind' = 'density' ORDER BY 1 LOOP
    PERFORM 1 FROM public.product_parents WHERE id = v_id FOR NO KEY UPDATE;
  END LOOP;
  FOR v_id IN SELECT (e->>'subject_id')::uuid FROM jsonb_array_elements(p_items) e WHERE e->>'kind' = 'net_weight' ORDER BY 1 LOOP
    PERFORM 1 FROM public.products WHERE id = v_id FOR NO KEY UPDATE;
  END LOOP;
  FOR v_id IN SELECT (e->>'subject_id')::uuid FROM jsonb_array_elements(p_items) e WHERE e->>'kind' = 'density' ORDER BY 1 LOOP
    IF EXISTS (SELECT 1 FROM public.product_parents WHERE id = v_id) THEN
      INSERT INTO public.product_parent_density_state (parent_id) VALUES (v_id) ON CONFLICT DO NOTHING;
      PERFORM 1 FROM public.product_parent_density_state WHERE parent_id = v_id FOR UPDATE;
    END IF;
  END LOOP;
  FOR v_id IN SELECT (e->>'subject_id')::uuid FROM jsonb_array_elements(p_items) e WHERE e->>'kind' = 'net_weight' ORDER BY 1 LOOP
    IF EXISTS (SELECT 1 FROM public.products WHERE id = v_id) THEN
      INSERT INTO public.product_size_net_weight_state (product_id) VALUES (v_id) ON CONFLICT DO NOTHING;
      PERFORM 1 FROM public.product_size_net_weight_state WHERE product_id = v_id FOR UPDATE;
    END IF;
  END LOOP;

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_it := p_items->v_i;
    v_subject := (v_it->>'subject_id')::uuid;
    v_draft_id := (v_it->>'draft_id')::uuid;
    v_expected := (v_it->'expected_version')::numeric::bigint;
    v_before := '[]'::jsonb;
    v_after := '[]'::jsonb;
    IF v_it->>'kind' = 'density' THEN
      SELECT * INTO v_parent FROM public.product_parents WHERE id = v_subject;
      IF NOT FOUND OR NOT v_parent.is_active OR v_parent.product_form <> 'liquid' THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_NOT_ELIGIBLE: item % is not an active liquid parent', v_i + 1;
      END IF;
      SELECT density_version INTO v_version FROM public.product_parent_density_state WHERE parent_id = v_subject;
      IF v_version <> v_expected THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_STALE: the weight of "%" changed since you opened it; reload', v_parent.name;
      END IF;
      SELECT * INTO v_d_draft FROM public.product_parent_density_values
       WHERE id = v_draft_id AND parent_id = v_subject AND review_state = 'draft' FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_STALE: the draft weight of "%" was replaced; reload', v_parent.name;
      END IF;
      v_basis := jsonb_build_object('product_form', v_parent.product_form, 'formulation_type', v_parent.formulation_type,
        'safener', v_parent.safener, 'generic_epa_registration', v_parent.generic_epa_registration);
      IF v_d_draft.basis IS DISTINCT FROM v_basis THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_BASIS_CHANGED: the draft weight of "%" was entered for a different formulation; enter it again', v_parent.name;
      END IF;
      SELECT * INTO v_d_appr FROM public.product_parent_density_values
       WHERE parent_id = v_subject AND review_state = 'approved' FOR UPDATE;
      v_has_appr := FOUND;
      IF v_has_appr AND public._product_weight_trust_rank(v_d_draft.source) < public._product_weight_trust_rank(v_d_appr.source)
         AND (v_d_draft.reason IS NULL OR v_d_draft.evidence IS NULL) THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_LOWER_TRUST: the approved value of "%" is from the %; the draft needs a reason and evidence', v_parent.name, v_d_appr.source;
      END IF;
      IF v_has_appr THEN
        v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_d_appr.id, 'review_state', v_d_appr.review_state,
          'value', v_d_appr.lb_per_gal, 'basis', v_d_appr.basis, 'reviewed_by', v_d_appr.reviewed_by, 'reviewed_at', v_d_appr.reviewed_at));
        UPDATE public.product_parent_density_values SET review_state = 'superseded', superseded_at = now()
         WHERE id = v_d_appr.id RETURNING * INTO v_d_appr;
        v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_d_appr.id, 'review_state', v_d_appr.review_state,
          'value', v_d_appr.lb_per_gal, 'basis', v_d_appr.basis, 'reviewed_by', v_d_appr.reviewed_by, 'reviewed_at', v_d_appr.reviewed_at));
      END IF;
      v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_d_draft.id, 'review_state', v_d_draft.review_state,
        'value', v_d_draft.lb_per_gal, 'basis', v_d_draft.basis, 'reviewed_by', v_d_draft.reviewed_by, 'reviewed_at', v_d_draft.reviewed_at));
      UPDATE public.product_parent_density_values SET review_state = 'approved', reviewed_by = v_actor, reviewed_at = now()
       WHERE id = v_d_draft.id RETURNING * INTO v_d_draft;
      v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_d_draft.id, 'review_state', v_d_draft.review_state,
        'value', v_d_draft.lb_per_gal, 'basis', v_d_draft.basis, 'reviewed_by', v_d_draft.reviewed_by, 'reviewed_at', v_d_draft.reviewed_at));
      UPDATE public.product_parent_density_state SET density_version = density_version + 1
       WHERE parent_id = v_subject RETURNING density_version INTO v_version;
      v_event := public._product_weight_event('parent_density', v_subject, NULL, 'approved', v_d_draft.id,
        v_before, v_after, v_d_draft.reason, v_d_draft.evidence);
    ELSE
      SELECT * INTO v_p FROM public.products WHERE id = v_subject;
      IF NOT FOUND OR NOT COALESCE(v_p.is_active, false) OR v_p.product_form IS DISTINCT FROM 'dry'
         OR public._weight_unit_factors()->'factors'->lower(btrim(COALESCE(v_p.inventory_unit, '')))->>'kind' IS DISTINCT FROM 'count' THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_NOT_ELIGIBLE: item % is not an active dry size stocked in a count unit', v_i + 1;
      END IF;
      SELECT net_weight_version INTO v_version FROM public.product_size_net_weight_state WHERE product_id = v_subject;
      IF v_version <> v_expected THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_STALE: the weight of "%" changed since you opened it; reload', v_p.product_name;
      END IF;
      SELECT * INTO v_n_draft FROM public.product_size_net_weight_values
       WHERE id = v_draft_id AND product_id = v_subject AND review_state = 'draft' FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_STALE: the draft weight of "%" was replaced; reload', v_p.product_name;
      END IF;
      v_basis := jsonb_build_object('container_size', v_p.container_size, 'container_type', v_p.container_type,
        'container_unit', v_p.container_unit, 'inventory_unit', v_p.inventory_unit, 'unit_size', v_p.unit_size);
      IF v_n_draft.basis IS DISTINCT FROM v_basis THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_BASIS_CHANGED: the draft weight of "%" was entered for a different pack; enter it again', v_p.product_name;
      END IF;
      SELECT * INTO v_n_appr FROM public.product_size_net_weight_values
       WHERE product_id = v_subject AND review_state = 'approved' FOR UPDATE;
      v_has_appr := FOUND;
      IF v_has_appr AND public._product_weight_trust_rank(v_n_draft.source) < public._product_weight_trust_rank(v_n_appr.source)
         AND (v_n_draft.reason IS NULL OR v_n_draft.evidence IS NULL) THEN
        RAISE EXCEPTION 'PRODUCT_WEIGHT_LOWER_TRUST: the approved value of "%" is from the %; the draft needs a reason and evidence', v_p.product_name, v_n_appr.source;
      END IF;
      IF v_has_appr THEN
        v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_n_appr.id, 'review_state', v_n_appr.review_state,
          'value', v_n_appr.net_lb, 'basis', v_n_appr.basis, 'reviewed_by', v_n_appr.reviewed_by, 'reviewed_at', v_n_appr.reviewed_at));
        UPDATE public.product_size_net_weight_values SET review_state = 'superseded', superseded_at = now()
         WHERE id = v_n_appr.id RETURNING * INTO v_n_appr;
        v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_n_appr.id, 'review_state', v_n_appr.review_state,
          'value', v_n_appr.net_lb, 'basis', v_n_appr.basis, 'reviewed_by', v_n_appr.reviewed_by, 'reviewed_at', v_n_appr.reviewed_at));
      END IF;
      v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_n_draft.id, 'review_state', v_n_draft.review_state,
        'value', v_n_draft.net_lb, 'basis', v_n_draft.basis, 'reviewed_by', v_n_draft.reviewed_by, 'reviewed_at', v_n_draft.reviewed_at));
      UPDATE public.product_size_net_weight_values SET review_state = 'approved', reviewed_by = v_actor, reviewed_at = now()
       WHERE id = v_n_draft.id RETURNING * INTO v_n_draft;
      v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_n_draft.id, 'review_state', v_n_draft.review_state,
        'value', v_n_draft.net_lb, 'basis', v_n_draft.basis, 'reviewed_by', v_n_draft.reviewed_by, 'reviewed_at', v_n_draft.reviewed_at));
      UPDATE public.product_size_net_weight_state SET net_weight_version = net_weight_version + 1
       WHERE product_id = v_subject RETURNING net_weight_version INTO v_version;
      v_event := public._product_weight_event('size_net_weight', NULL, v_subject, 'approved', v_n_draft.id,
        v_before, v_after, v_n_draft.reason, v_n_draft.evidence);
    END IF;
    v_done := v_done || jsonb_build_array(jsonb_build_object('kind', v_it->>'kind', 'subject_id', v_subject,
      'value_id', v_draft_id, 'version', v_version, 'event_id', v_event));
  END LOOP;

  v_existing := jsonb_build_object('approved', v_done);
  PERFORM public.save_idempotency(p_idempotency_key, 'approve_weights',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_existing));
  RETURN v_existing;
END;
$function$;
ALTER FUNCTION public.approve_weights(jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.approve_weights(jsonb, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.approve_weights(jsonb, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Saved blend tickets keep their weight (sheet 3.4)
-- ---------------------------------------------------------------------------------------------

-- First weight per (ticket, product), never changed. No lock of its own, no foreign key, no raise for
-- a missing weight. VOLATILE (the trigger default): its one INSERT takes a fresh snapshot, and the
-- STABLE readers inside it read in that snapshot.
CREATE FUNCTION public.capture_blend_ticket_product_weight() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.blend_ticket_id IS NOT DISTINCT FROM OLD.blend_ticket_id AND NEW.unit IS NOT DISTINCT FROM OLD.unit THEN
    RETURN NULL;
  END IF;
  IF NEW.product_id IS NULL OR NEW.blend_ticket_id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.blend_ticket_product_weights (blend_ticket_id, product_id, product_name, product_form, weight_kind,
    value_id, value_reviewed_at, value_reviewed_by, lb_per_unit, per_unit, unit_factors, source, value_basis, none_reason)
  SELECT NEW.blend_ticket_id, NEW.product_id, COALESCE(p.product_name, NEW.product_name, ''), w->>'product_form', w->>'kind',
    (w->>'value_id')::uuid, (w->>'reviewed_at')::timestamptz, (w->>'reviewed_by')::uuid, (w->>'lb_per_unit')::numeric,
    w->>'per_unit', x.u, w->>'source', NULLIF(w->'value_basis', 'null'::jsonb), w->>'none_reason'
    FROM (SELECT public._weight_unit_factors() AS u) x
    CROSS JOIN LATERAL (SELECT public._product_weight(NEW.product_id, x.u) AS w) y
    LEFT JOIN public.products p ON p.id = NEW.product_id
  ON CONFLICT (blend_ticket_id, product_id) DO NOTHING;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.capture_blend_ticket_product_weight() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.capture_blend_ticket_product_weight() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trigger_capture_blend_ticket_product_weight
  AFTER INSERT OR UPDATE OF product_id, blend_ticket_id, unit ON public.blend_ticket_products
  FOR EACH ROW EXECUTE FUNCTION public.capture_blend_ticket_product_weight();

-- The ticket's header basis: written at header insert; replaced (with the edit's time) only when the
-- header total or its unit actually changes, since save_blend_ticket names both on every save.
CREATE FUNCTION public.capture_blend_ticket_weight_basis() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.blend_ticket_weight_basis (blend_ticket_id, unit_factors, captured_at)
    VALUES (NEW.id, public._weight_unit_factors(), statement_timestamp())
    ON CONFLICT (blend_ticket_id) DO NOTHING;
  ELSIF OLD.total_volume IS DISTINCT FROM NEW.total_volume OR OLD.total_volume_unit IS DISTINCT FROM NEW.total_volume_unit THEN
    INSERT INTO public.blend_ticket_weight_basis (blend_ticket_id, unit_factors, captured_at)
    VALUES (NEW.id, public._weight_unit_factors(), statement_timestamp())
    ON CONFLICT (blend_ticket_id) DO UPDATE SET unit_factors = EXCLUDED.unit_factors, captured_at = EXCLUDED.captured_at;
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.capture_blend_ticket_weight_basis() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.capture_blend_ticket_weight_basis() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trigger_capture_blend_ticket_weight_basis
  AFTER INSERT OR UPDATE OF total_volume, total_volume_unit ON public.blend_tickets
  FOR EACH ROW EXECUTE FUNCTION public.capture_blend_ticket_weight_basis();

-- A hard delete (table owner only; the app soft-deletes) removes the ticket's snapshot rows.
CREATE FUNCTION public.delete_blend_ticket_weights() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  DELETE FROM public.blend_ticket_product_weights WHERE blend_ticket_id = OLD.id;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.delete_blend_ticket_weights() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_blend_ticket_weights() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trigger_delete_blend_ticket_weights
  AFTER DELETE ON public.blend_tickets
  FOR EACH ROW EXECUTE FUNCTION public.delete_blend_ticket_weights();

-- ---------------------------------------------------------------------------------------------
-- Saved loader worksheets keep their weight (sheet 3.4b)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.capture_loader_worksheet_weights() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  -- A worksheet moved to another job is a new plan: every old row goes, even for a product on both jobs.
  IF TG_OP = 'UPDATE' AND NEW.job_id IS DISTINCT FROM OLD.job_id THEN
    DELETE FROM public.job_loader_worksheet_weights WHERE worksheet_id = NEW.id;
  END IF;
  -- One query, one map: a valid row (a none row included) is never changed; an invalid one is replaced.
  INSERT INTO public.job_loader_worksheet_weights AS s (worksheet_id, product_id, job_id, product_name, product_form,
    weight_kind, value_id, value_reviewed_at, value_reviewed_by, lb_per_unit, per_unit, unit_factors, source,
    value_basis, none_reason, pack_generation, member_generation, identity_generation, captured_at)
  SELECT NEW.id, c.product_id, NEW.job_id, COALESCE(p.product_name, ''), w->>'product_form', w->>'kind',
    (w->>'value_id')::uuid, (w->>'reviewed_at')::timestamptz, (w->>'reviewed_by')::uuid, (w->>'lb_per_unit')::numeric,
    w->>'per_unit', x.u, w->>'source', NULLIF(w->'value_basis', 'null'::jsonb), w->>'none_reason',
    (w->>'pack_generation')::bigint, (w->>'member_generation')::bigint, (w->>'identity_generation')::bigint,
    statement_timestamp()
    FROM (SELECT public._weight_unit_factors() AS u) x
    CROSS JOIN (SELECT DISTINCT jc.product_id FROM public.job_chemicals jc
                 WHERE jc.job_id = NEW.job_id AND jc.product_id IS NOT NULL) c
    LEFT JOIN public.products p ON p.id = c.product_id
    CROSS JOIN LATERAL (SELECT public._product_weight(c.product_id, x.u) AS w) y
  ON CONFLICT (worksheet_id, product_id) DO UPDATE SET
    job_id = EXCLUDED.job_id, product_name = EXCLUDED.product_name, product_form = EXCLUDED.product_form,
    weight_kind = EXCLUDED.weight_kind, value_id = EXCLUDED.value_id, value_reviewed_at = EXCLUDED.value_reviewed_at,
    value_reviewed_by = EXCLUDED.value_reviewed_by, lb_per_unit = EXCLUDED.lb_per_unit, per_unit = EXCLUDED.per_unit,
    unit_factors = EXCLUDED.unit_factors, source = EXCLUDED.source, value_basis = EXCLUDED.value_basis,
    none_reason = EXCLUDED.none_reason, pack_generation = EXCLUDED.pack_generation,
    member_generation = EXCLUDED.member_generation, identity_generation = EXCLUDED.identity_generation,
    captured_at = EXCLUDED.captured_at
  WHERE NOT public.worksheet_weight_is_valid(s);
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.capture_loader_worksheet_weights() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.capture_loader_worksheet_weights() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trigger_capture_loader_worksheet_weights
  AFTER INSERT OR UPDATE ON public.job_loader_worksheets
  FOR EACH ROW EXECUTE FUNCTION public.capture_loader_worksheet_weights();

-- ---------------------------------------------------------------------------------------------
-- A changed pack, identity or membership (sheet 3.5)
-- ---------------------------------------------------------------------------------------------

-- Fires inside the UPDATE of the products row, so the row is already held before the state row.
CREATE FUNCTION public.return_net_weight_to_draft() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_appr public.product_size_net_weight_values%ROWTYPE;
  v_draft public.product_size_net_weight_values%ROWTYPE;
  v_has_appr boolean;
  v_has_draft boolean;
  v_before jsonb := '[]'::jsonb;
  v_after jsonb := '[]'::jsonb;
BEGIN
  IF (OLD.container_size, OLD.container_type, OLD.container_unit, OLD.inventory_unit, OLD.unit_size)
     IS NOT DISTINCT FROM (NEW.container_size, NEW.container_type, NEW.container_unit, NEW.inventory_unit, NEW.unit_size) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.product_size_net_weight_state (product_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.product_size_net_weight_state WHERE product_id = NEW.id FOR UPDATE;
  SELECT * INTO v_draft FROM public.product_size_net_weight_values
   WHERE product_id = NEW.id AND review_state = 'draft' FOR UPDATE;
  v_has_draft := FOUND;
  SELECT * INTO v_appr FROM public.product_size_net_weight_values
   WHERE product_id = NEW.id AND review_state = 'approved' FOR UPDATE;
  v_has_appr := FOUND;
  IF v_has_draft THEN
    v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_draft.id, 'review_state', v_draft.review_state,
      'value', v_draft.net_lb, 'basis', v_draft.basis, 'reviewed_by', v_draft.reviewed_by, 'reviewed_at', v_draft.reviewed_at));
    UPDATE public.product_size_net_weight_values SET review_state = 'superseded', superseded_at = now()
     WHERE id = v_draft.id RETURNING * INTO v_draft;
    v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_draft.id, 'review_state', v_draft.review_state,
      'value', v_draft.net_lb, 'basis', v_draft.basis, 'reviewed_by', v_draft.reviewed_by, 'reviewed_at', v_draft.reviewed_at));
  END IF;
  IF v_has_appr THEN
    v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_appr.id, 'review_state', v_appr.review_state,
      'value', v_appr.net_lb, 'basis', v_appr.basis, 'reviewed_by', v_appr.reviewed_by, 'reviewed_at', v_appr.reviewed_at));
    UPDATE public.product_size_net_weight_values SET review_state = 'draft', reviewed_by = NULL, reviewed_at = NULL
     WHERE id = v_appr.id RETURNING * INTO v_appr;
    v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_appr.id, 'review_state', v_appr.review_state,
      'value', v_appr.net_lb, 'basis', v_appr.basis, 'reviewed_by', v_appr.reviewed_by, 'reviewed_at', v_appr.reviewed_at));
  END IF;
  UPDATE public.product_size_net_weight_state
     SET net_weight_version = net_weight_version + 1, pack_generation = pack_generation + 1
   WHERE product_id = NEW.id;
  IF v_has_draft OR v_has_appr THEN
    PERFORM public._product_weight_event('size_net_weight', NULL, NEW.id, 'returned_to_draft',
      CASE WHEN v_has_appr THEN v_appr.id END, v_before, v_after,
      format('pack changed from %s to %s',
        jsonb_build_object('container_size', OLD.container_size, 'container_type', OLD.container_type,
          'container_unit', OLD.container_unit, 'inventory_unit', OLD.inventory_unit, 'unit_size', OLD.unit_size),
        jsonb_build_object('container_size', NEW.container_size, 'container_type', NEW.container_type,
          'container_unit', NEW.container_unit, 'inventory_unit', NEW.inventory_unit, 'unit_size', NEW.unit_size)),
      NULL);
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.return_net_weight_to_draft() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.return_net_weight_to_draft() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trigger_return_net_weight_to_draft
  AFTER UPDATE OF container_size, container_type, container_unit, inventory_unit, unit_size ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.return_net_weight_to_draft();

CREATE FUNCTION public.return_density_to_draft() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_appr public.product_parent_density_values%ROWTYPE;
  v_draft public.product_parent_density_values%ROWTYPE;
  v_has_appr boolean;
  v_has_draft boolean;
  v_before jsonb := '[]'::jsonb;
  v_after jsonb := '[]'::jsonb;
BEGIN
  IF (OLD.product_form, OLD.formulation_type, OLD.safener, OLD.generic_epa_registration)
     IS NOT DISTINCT FROM (NEW.product_form, NEW.formulation_type, NEW.safener, NEW.generic_epa_registration) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.product_parent_density_state (parent_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.product_parent_density_state WHERE parent_id = NEW.id FOR UPDATE;
  SELECT * INTO v_draft FROM public.product_parent_density_values
   WHERE parent_id = NEW.id AND review_state = 'draft' FOR UPDATE;
  v_has_draft := FOUND;
  SELECT * INTO v_appr FROM public.product_parent_density_values
   WHERE parent_id = NEW.id AND review_state = 'approved' FOR UPDATE;
  v_has_appr := FOUND;
  IF v_has_draft THEN
    v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_draft.id, 'review_state', v_draft.review_state,
      'value', v_draft.lb_per_gal, 'basis', v_draft.basis, 'reviewed_by', v_draft.reviewed_by, 'reviewed_at', v_draft.reviewed_at));
    UPDATE public.product_parent_density_values SET review_state = 'superseded', superseded_at = now()
     WHERE id = v_draft.id RETURNING * INTO v_draft;
    v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_draft.id, 'review_state', v_draft.review_state,
      'value', v_draft.lb_per_gal, 'basis', v_draft.basis, 'reviewed_by', v_draft.reviewed_by, 'reviewed_at', v_draft.reviewed_at));
  END IF;
  IF v_has_appr THEN
    v_before := v_before || jsonb_build_array(jsonb_build_object('value_id', v_appr.id, 'review_state', v_appr.review_state,
      'value', v_appr.lb_per_gal, 'basis', v_appr.basis, 'reviewed_by', v_appr.reviewed_by, 'reviewed_at', v_appr.reviewed_at));
    UPDATE public.product_parent_density_values SET review_state = 'draft', reviewed_by = NULL, reviewed_at = NULL
     WHERE id = v_appr.id RETURNING * INTO v_appr;
    v_after := v_after || jsonb_build_array(jsonb_build_object('value_id', v_appr.id, 'review_state', v_appr.review_state,
      'value', v_appr.lb_per_gal, 'basis', v_appr.basis, 'reviewed_by', v_appr.reviewed_by, 'reviewed_at', v_appr.reviewed_at));
  END IF;
  UPDATE public.product_parent_density_state
     SET density_version = density_version + 1, identity_generation = identity_generation + 1
   WHERE parent_id = NEW.id;
  IF v_has_draft OR v_has_appr THEN
    PERFORM public._product_weight_event('parent_density', NEW.id, NULL, 'returned_to_draft',
      CASE WHEN v_has_appr THEN v_appr.id END, v_before, v_after,
      format('formulation changed from %s to %s',
        jsonb_build_object('product_form', OLD.product_form, 'formulation_type', OLD.formulation_type,
          'safener', OLD.safener, 'generic_epa_registration', OLD.generic_epa_registration),
        jsonb_build_object('product_form', NEW.product_form, 'formulation_type', NEW.formulation_type,
          'safener', NEW.safener, 'generic_epa_registration', NEW.generic_epa_registration)),
      NULL);
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.return_density_to_draft() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.return_density_to_draft() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trigger_return_density_to_draft
  AFTER UPDATE OF product_form, formulation_type, safener, generic_epa_registration ON public.product_parents
  FOR EACH ROW EXECUTE FUNCTION public.return_density_to_draft();

-- A size joining, leaving or moving parent moves its member generation. Locks the size's products row
-- first, then its state row (the 3.5 order), whatever its caller already holds.
CREATE FUNCTION public.bump_member_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_ids uuid[];
  v_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_ids := ARRAY[NEW.product_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_ids := ARRAY[OLD.product_id];
  ELSIF OLD.parent_id IS NOT DISTINCT FROM NEW.parent_id AND OLD.product_id IS NOT DISTINCT FROM NEW.product_id THEN
    RETURN NULL;
  ELSE
    v_ids := ARRAY[OLD.product_id, NEW.product_id];
  END IF;
  FOR v_id IN SELECT DISTINCT u FROM unnest(v_ids) u WHERE u IS NOT NULL ORDER BY 1 LOOP
    PERFORM 1 FROM public.products WHERE id = v_id FOR NO KEY UPDATE;
  END LOOP;
  FOR v_id IN SELECT DISTINCT u FROM unnest(v_ids) u WHERE u IS NOT NULL ORDER BY 1 LOOP
    INSERT INTO public.product_size_net_weight_state (product_id) VALUES (v_id) ON CONFLICT DO NOTHING;
    UPDATE public.product_size_net_weight_state SET member_generation = member_generation + 1 WHERE product_id = v_id;
  END LOOP;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.bump_member_generation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bump_member_generation() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trigger_bump_member_generation
  AFTER INSERT OR UPDATE OF parent_id, product_id OR DELETE ON public.product_parent_members
  FOR EACH ROW EXECUTE FUNCTION public.bump_member_generation();

-- ---------------------------------------------------------------------------------------------
-- Postflight read-backs
-- ---------------------------------------------------------------------------------------------

DO $postflight$
DECLARE
  v_public text[] := ARRAY['get_product_weights(uuid[])', 'get_blend_ticket_weights(uuid)',
    'get_loader_worksheet_weights(uuid[],uuid[])', 'worksheet_weight_is_valid(job_loader_worksheet_weights)',
    'set_parent_density(uuid,bigint,numeric,text,text,text,text)',
    'correct_parent_density(uuid,bigint,numeric,text,text,text,text,text,text)',
    'set_size_net_weight(uuid,bigint,numeric,text,text,text)',
    'correct_size_net_weight(uuid,bigint,numeric,text,text,text,text,text)', 'approve_weights(jsonb,text)'];
  v_private text[] := ARRAY['_weight_unit_factors()', '_product_weight(uuid,jsonb)', '_approved_parent_lb_per_gal(uuid)',
    '_product_weight_trust_rank(text)', '_product_weight_event(text,uuid,uuid,text,uuid,jsonb,jsonb,text,text)',
    '_write_parent_density(text,uuid,bigint,numeric,text,text,text,text,text)',
    '_write_size_net_weight(text,uuid,bigint,numeric,text,text,text,text)',
    '_save_parent_density_draft(uuid,bigint,numeric,text,text,text,text,text)',
    '_save_size_net_weight_draft(uuid,bigint,numeric,text,text,text,text)', '_approve_weight_item_ok(jsonb)',
    'capture_blend_ticket_product_weight()', 'capture_blend_ticket_weight_basis()', 'delete_blend_ticket_weights()',
    'capture_loader_worksheet_weights()', 'return_net_weight_to_draft()', 'return_density_to_draft()',
    'bump_member_generation()', 'refuse_product_weight_event_mutation()'];
  v_sig text;
  v_oid oid;
  v_role text;
  v_table text;
  v_bad int;
BEGIN
  FOREACH v_sig IN ARRAY v_public || v_private LOOP
    v_oid := to_regprocedure('public.' || v_sig);
    IF v_oid IS NULL THEN RAISE EXCEPTION 'POSTFLIGHT_DM2_FUNCTION_MISSING: %', v_sig; END IF;
    IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_oid) <> 'postgres'
       OR NOT ((SELECT proconfig FROM pg_proc WHERE oid = v_oid) @> ARRAY['search_path=public, pg_temp']) THEN
      RAISE EXCEPTION 'POSTFLIGHT_DM2_FUNCTION_SHAPE: %', v_sig;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc, aclexplode(COALESCE(proacl, acldefault('f', proowner))) a
                WHERE oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_DM2_PUBLIC_EXECUTE: %', v_sig;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'service_role', 'metabase_ro'] LOOP
      IF has_function_privilege(v_role, v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'POSTFLIGHT_DM2_ROLE_EXECUTE: % can execute %', v_role, v_sig;
      END IF;
    END LOOP;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') <> (v_sig = ANY (v_public)) THEN
      RAISE EXCEPTION 'POSTFLIGHT_DM2_AUTHENTICATED_EXECUTE: %', v_sig;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE oid IN (
        to_regprocedure('public.get_blend_ticket_weights(uuid)'),
        to_regprocedure('public.get_loader_worksheet_weights(uuid[],uuid[])'),
        to_regprocedure('public.worksheet_weight_is_valid(job_loader_worksheet_weights)')) AND NOT prosecdef) <> 3
     OR (SELECT count(*) FROM pg_proc WHERE oid IN (
        to_regprocedure('public._weight_unit_factors()'), to_regprocedure('public._product_weight(uuid,jsonb)'),
        to_regprocedure('public.get_product_weights(uuid[])'), to_regprocedure('public.get_blend_ticket_weights(uuid)'),
        to_regprocedure('public.get_loader_worksheet_weights(uuid[],uuid[])')) AND provolatile = 's') <> 5 THEN
    RAISE EXCEPTION 'POSTFLIGHT_DM2_READER_MODE';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['product_parent_density_values', 'product_size_net_weight_values',
      'product_parent_density_state', 'product_size_net_weight_state', 'product_weight_events',
      'blend_ticket_product_weights', 'blend_ticket_weight_basis', 'job_loader_worksheet_weights'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_table)::regclass) THEN
      RAISE EXCEPTION 'POSTFLIGHT_DM2_RLS_OFF: %', v_table;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro'] LOOP
      IF has_table_privilege(v_role, 'public.' || v_table, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
         OR (v_role <> 'authenticated' AND has_table_privilege(v_role, 'public.' || v_table, 'SELECT')) THEN
        RAISE EXCEPTION 'POSTFLIGHT_DM2_TABLE_PRIVILEGE: % on %', v_role, v_table;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_class, aclexplode(relacl) a WHERE oid = ('public.' || v_table)::regclass AND a.grantee = 0) THEN
      RAISE EXCEPTION 'POSTFLIGHT_DM2_PUBLIC_TABLE_GRANT: %', v_table;
    END IF;
  END LOOP;
  -- A direct line writer's foreign-key checks must run before the capture (name order, bytewise):
  -- both FKs (to blend_tickets and to products) and their INSERT and UPDATE check triggers.
  SELECT count(*) INTO v_bad FROM pg_constraint c
   WHERE c.conrelid = 'public.blend_ticket_products'::regclass AND c.contype = 'f'
     AND c.confrelid IN ('public.blend_tickets'::regclass, 'public.products'::regclass);
  IF v_bad <> 2 THEN RAISE EXCEPTION 'POSTFLIGHT_DM2_LINE_FKS: expected 2 foreign keys, found %', v_bad; END IF;
  SELECT count(*) INTO v_bad FROM pg_trigger t JOIN pg_constraint c ON c.oid = t.tgconstraint
   WHERE t.tgrelid = 'public.blend_ticket_products'::regclass AND c.contype = 'f'
     AND c.confrelid IN ('public.blend_tickets'::regclass, 'public.products'::regclass)
     AND t.tgname::text < ('trigger_capture_blend_ticket_product_weight' COLLATE "C");
  IF v_bad <> 4 THEN
    RAISE EXCEPTION 'POSTFLIGHT_DM2_TRIGGER_ORDER: % of 4 foreign-key check triggers sort before the capture', v_bad;
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trigger_capture_blend_ticket_weight_basis',
        'trigger_capture_blend_ticket_product_weight', 'trigger_capture_loader_worksheet_weights',
        'trigger_return_net_weight_to_draft', 'trigger_return_density_to_draft', 'trigger_delete_blend_ticket_weights',
        'trigger_bump_member_generation')) <> 7 THEN
    RAISE EXCEPTION 'POSTFLIGHT_DM2_TRIGGERS';
  END IF;
END;
$postflight$;
