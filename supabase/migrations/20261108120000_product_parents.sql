-- idempotency-body-check: exempt
-- (Every writer checks its retry key through _product_parent_replay, which calls check_idempotency,
--  and saves its receipt with save_idempotency last, in the same transaction.)
--
-- PAR-1 (Stage 2 build sheet §4.1): a parent record per formulation, plus nickname.
--
-- One parent holds what is the same for every size of a formulation. Each size stays an ordinary
-- products row with its own ID, price, SKU, stock, vendor links and notes. The parent COPIES its
-- category, use timings and rates onto every size in the same step, so every existing screen keeps
-- reading them from the size row, and a guard refuses changing those copies on one size alone.
--
-- New (all RLS on, SELECT for active users, no write grant for any role):
--   * product_parents: name, nickname, identity (form, formulation type, safener, generic EPA number),
--     the copied values, parent_version (moved by every parent function).
--   * product_parent_members: which parent a size belongs to (one at most), its role (package, bulk,
--     fixed_tote) and, for a shop-filled tote, its bulk fill source (set by PAR-2; a trigger keeps it
--     pointing at the same parent's bulk size).
--   * product_parent_events: append-only log of every parent change, with each size's before/after.
--   * product_parent_copy_passes: private, no grants. A parent function inserts a pass for one size
--     right before its one copy write and deletes it right after (the rate lock's pattern).
-- Guards on products (fire only for a size that has a parent; no product has one until a parent
-- function creates it, so applying this changes nothing for any existing product or open browser):
--   * trg_b_guard_product_parent_timings (second BEFORE trigger, ahead of the category alias and the
--     use-timing sync, which can raise their own errors first): refuses a change to use_timings,
--     use_timing or the normalized category without a pass.
--   * trigger_zz_guard_product_parent_values (after every trg_* trigger, before the rate lock guard):
--     refuses a change to category, use timings, rates or the normalized EPA number without a pass.
--     An update that resends unchanged values passes, so an old screen keeps working.
--   Both name the parent and tell the user to reload. set_product_rates, correct_product_rates, the
--   Setup tab, the price workbook and label-draft commits reach a grouped size through these guards.
-- Changed:
--   * normalize_product_category reads its alias table from the new _normalized_category_timing, so the
--     early guard and the trigger share one table (behaviour unchanged).
--   * product_change_history: new nullable parent_event_id; change_type adds 'parent_copy'. Every size
--     entry a parent write causes is 'parent_copy' and carries the parent event's ID.
--   * _product_setup_fingerprint adds the size's parent (only when it has one), so a Setup-tab row
--     downloaded before its size joined or moved parent is refused as stale. Ungrouped rows keep
--     their exact fingerprint, so no open download goes stale at apply.
-- Functions (SECURITY DEFINER, search_path public, pg_temp; writers admin-only with a retry key):
--   create_product_with_parent, add_product_size (insert through apply_product_setup's insert mode,
--   the one setup insert path), update_product_parent, preview_parent_rates, set_parent_rates
--   (unlocked), correct_parent_rates (locked, one parent, reason), preview_move_product_size,
--   move_product_size, preview_product_parent_identity_correction, correct_product_parent_identity
--   (formulation type and safener; the EPA number is refused until REG-1), get_product_parents and
--   search_product_parents (any active user; no cost or price).
-- No existing row is changed; no grant, revoke or policy on an existing table.
--
-- Rollback (nothing to restore on products: every size still holds correct copied values):
--   DROP TRIGGER trg_b_guard_product_parent_timings ON public.products;
--   DROP TRIGGER trigger_zz_guard_product_parent_values ON public.products;
--   then drop the new functions; re-issue normalize_product_category, write_product_change_history
--   and _product_setup_fingerprint from 20260702170000 / 20261102100000 / 20261107080000; keep the
--   new tables (and history rows with parent_event_id) for a re-apply.

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF to_regclass('public.product_parents') IS NOT NULL
     OR to_regclass('public.product_parent_members') IS NOT NULL
     OR to_regclass('public.product_parent_events') IS NOT NULL
     OR to_regclass('public.product_parent_copy_passes') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_PARENTS_ALREADY_EXIST';
  END IF;
  IF to_regprocedure('public.apply_product_setup(jsonb,uuid,text)') IS NULL
     OR to_regprocedure('public._apply_product_setup_update(jsonb,uuid,text)') IS NULL
     OR to_regprocedure('public._product_setup_fingerprint(public.products)') IS NULL
     OR to_regprocedure('public.preview_product_rate_correction(uuid,numeric,text)') IS NULL
     OR to_regprocedure('public._product_rate_value_ok(jsonb)') IS NULL
     OR to_regprocedure('public._product_rate_unit_ok(numeric,text,text,text,text)') IS NULL
     OR to_regprocedure('public.normalize_product_category()') IS NULL
     OR to_regprocedure('public.write_product_change_history()') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_active_profile()') IS NULL
     OR to_regprocedure('public.check_idempotency(text,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regclass('public.product_rate_correction_passes') IS NULL
     OR to_regclass('public.product_use_timing_options') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_PARENTS_DEPENDENCY_MISSING';
  END IF;
  -- The guards' place in the BEFORE-trigger order (name order) is part of the design.
  IF (SELECT array_agg(tgname::text ORDER BY tgname::text) FROM pg_trigger
       WHERE tgrelid = 'public.products'::regclass AND NOT tgisinternal
         AND tgname::text < 'trg_keep_product_unit') IS DISTINCT FROM ARRAY['trg_a_share_product_rate_lock']
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
                    AND tgname = 'trigger_zzz_guard_product_rate_lock') THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_TRIGGER_ORDER_CHANGED';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conname = 'product_change_history_change_type_check'
         AND conrelid = 'public.product_change_history'::regclass)
     IS DISTINCT FROM 'CHECK ((change_type = ANY (ARRAY[''created''::text, ''updated''::text])))' THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_CHANGE_HISTORY_CHECK_CHANGED';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.product_parents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> '' AND name = btrim(name) AND length(name) <= 200),
  nickname text CHECK (nickname IS NULL OR (btrim(nickname) <> '' AND nickname = btrim(nickname) AND length(nickname) <= 200)),
  product_form text NOT NULL CHECK (product_form IN ('liquid', 'dry', 'seed', 'each')),
  -- Blank means unknown; never guessed.
  formulation_type text CHECK (formulation_type IS NULL OR (btrim(formulation_type) <> '' AND length(formulation_type) <= 100)),
  safener text CHECK (safener IS NULL OR (btrim(safener) <> '' AND length(safener) <= 200)),
  generic_epa_registration text CHECK (generic_epa_registration IS NULL
    OR (generic_epa_registration ~ '^[A-Z0-9-]+$' AND length(generic_epa_registration) <= 40)),
  category text REFERENCES public.product_categories(name) ON UPDATE RESTRICT ON DELETE RESTRICT,
  use_timings text[] NOT NULL DEFAULT '{}',
  rate_per_acre numeric,
  rate_unit text,
  suggested_rate text,
  parent_version bigint NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_parents OWNER TO postgres;
CREATE UNIQUE INDEX product_parents_active_name_unique ON public.product_parents (lower(name)) WHERE is_active;
COMMENT ON TABLE public.product_parents IS
  'PAR-1: one row per formulation. Category, use timings and rates are copied onto every size. Written only by the parent functions.';

CREATE TABLE public.product_parent_members (
  product_id uuid PRIMARY KEY REFERENCES public.products(id) ON DELETE RESTRICT,
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  size_role text NOT NULL DEFAULT 'package' CHECK (size_role IN ('package', 'bulk', 'fixed_tote')),
  fill_source_product_id uuid REFERENCES public.products(id) ON DELETE RESTRICT,
  added_by uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (fill_source_product_id IS NULL OR size_role = 'fixed_tote')
);
ALTER TABLE public.product_parent_members OWNER TO postgres;
CREATE INDEX product_parent_members_parent_idx ON public.product_parent_members (parent_id);
CREATE UNIQUE INDEX product_parent_members_one_bulk ON public.product_parent_members (parent_id) WHERE size_role = 'bulk';
COMMENT ON TABLE public.product_parent_members IS
  'PAR-1: the parent each size belongs to (one at most). Written only by the parent functions.';

CREATE TABLE public.product_parent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('created', 'updated', 'size_added', 'size_moved',
    'identity_corrected', 'rates_set', 'rates_corrected')),
  reason text,
  evidence text,
  before_values jsonb,
  after_values jsonb,
  affected jsonb NOT NULL DEFAULT '[]'::jsonb,
  changed_by uuid NOT NULL,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_parent_events OWNER TO postgres;
CREATE INDEX product_parent_events_parent_idx ON public.product_parent_events (parent_id, changed_at DESC, id DESC);
COMMENT ON TABLE public.product_parent_events IS
  'PAR-1: append-only log of parent changes; affected holds each size''s before and after.';

-- A parent write's one-size pass. No API role can read or write it, so no session can forge one.
CREATE TABLE public.product_parent_copy_passes (
  txid bigint NOT NULL,
  product_id uuid NOT NULL,
  parent_event_id bigint NOT NULL,
  PRIMARY KEY (txid, product_id)
);
ALTER TABLE public.product_parent_copy_passes OWNER TO postgres;
COMMENT ON TABLE public.product_parent_copy_passes IS
  'Internal: the parent copy in progress, one row for the life of one write. Only the parent functions write it.';

ALTER TABLE public.product_parents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_parent_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_parent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_parent_copy_passes ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_parents_select ON public.product_parents
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY product_parent_members_select ON public.product_parent_members
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY product_parent_events_select ON public.product_parent_events
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY product_parent_copy_passes_none ON public.product_parent_copy_passes
  FOR ALL TO authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.product_parents, public.product_parent_members, public.product_parent_events,
  public.product_parent_copy_passes FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON SEQUENCE public.product_parent_events_id_seq FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_parents, public.product_parent_members, public.product_parent_events TO authenticated;

CREATE FUNCTION public.refuse_product_parent_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'PRODUCT_PARENT_EVENTS_ARE_APPEND_ONLY';
END;
$function$;
ALTER FUNCTION public.refuse_product_parent_event_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_product_parent_event_mutation() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER product_parent_events_append_only
  BEFORE UPDATE OR DELETE ON public.product_parent_events
  FOR EACH ROW EXECUTE FUNCTION public.refuse_product_parent_event_mutation();
CREATE TRIGGER product_parent_events_no_truncate
  BEFORE TRUNCATE ON public.product_parent_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_product_parent_event_mutation();

-- A tote's fill source is the bulk size of the same parent; a bulk size that is a fill source cannot
-- leave its parent or its bulk role until the tote's source is cleared or replaced.
CREATE FUNCTION public.guard_product_parent_fill_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.fill_source_product_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.product_parent_members b
                      WHERE b.product_id = NEW.fill_source_product_id AND b.parent_id = NEW.parent_id
                        AND b.size_role = 'bulk') THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_FILL_SOURCE_INVALID: a tote''s fill source must be the bulk size of the same parent'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.size_role = 'bulk'
     AND (TG_OP = 'DELETE' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.size_role <> 'bulk')
     AND EXISTS (SELECT 1 FROM public.product_parent_members t WHERE t.fill_source_product_id = OLD.product_id) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_FILL_SOURCE_IN_USE: a tote is filled from this bulk size; change the tote''s fill source first'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_product_parent_fill_source() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_product_parent_fill_source() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER product_parent_members_fill_source
  BEFORE INSERT OR UPDATE OR DELETE ON public.product_parent_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_parent_fill_source();

-- ---------------------------------------------------------------------------------------------
-- Change history: a parent copy is recorded as 'parent_copy' with the parent event's ID
-- ---------------------------------------------------------------------------------------------

-- Deferred: a parent write numbers its log entry first, copies to each size (writing these history
-- rows), then appends the one complete log entry, so the log is never updated.
ALTER TABLE public.product_change_history ADD COLUMN parent_event_id bigint
  REFERENCES public.product_parent_events(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.product_change_history DROP CONSTRAINT product_change_history_change_type_check;
ALTER TABLE public.product_change_history ADD CONSTRAINT product_change_history_change_type_check
  CHECK (change_type IN ('created', 'updated', 'parent_copy'));
ALTER TABLE public.product_change_history DROP CONSTRAINT product_change_history_check;
ALTER TABLE public.product_change_history ADD CONSTRAINT product_change_history_check
  CHECK ((change_type = 'created' AND field_name IS NULL)
      OR (change_type IN ('updated', 'parent_copy') AND field_name IS NOT NULL));
ALTER TABLE public.product_change_history ADD CONSTRAINT product_change_history_parent_event_chk
  CHECK ((change_type = 'parent_copy') = (parent_event_id IS NOT NULL));

-- Re-issued from 20261102100000 with one change: an entry written while a parent pass exists for the
-- size is 'parent_copy' and carries the pass's parent event ID (the pass lives until the statement's
-- AFTER triggers have run).
CREATE OR REPLACE FUNCTION public.write_product_change_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_change record;
  v_parent_event bigint;
BEGIN
  SELECT full_name INTO v_actor_name FROM public.profiles WHERE id = v_actor;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.product_change_history(product_id, change_type, changed_by, changed_by_name)
    VALUES (NEW.id, 'created', v_actor, v_actor_name);
    RETURN NEW;
  END IF;
  SELECT parent_event_id INTO v_parent_event FROM public.product_parent_copy_passes
   WHERE txid = txid_current() AND product_id = NEW.id;

  -- Explicit setup allow-list: a future product column is not watched until added here.
  -- Notes and product_family_id record only the changed field, never either value.
  FOR v_change IN
    SELECT field_name, old_value, new_value FROM (VALUES
      ('product_name', NULLIF(OLD.product_name::text, ''), NULLIF(NEW.product_name::text, '')),
      ('sku', NULLIF(OLD.sku::text, ''), NULLIF(NEW.sku::text, '')),
      ('category', NULLIF(OLD.category::text, ''), NULLIF(NEW.category::text, '')),
      ('vendor', NULLIF(OLD.vendor::text, ''), NULLIF(NEW.vendor::text, '')),
      ('manufacturer', NULLIF(OLD.manufacturer::text, ''), NULLIF(NEW.manufacturer::text, '')),
      ('container_size', trim_scale(OLD.container_size)::text, trim_scale(NEW.container_size)::text),
      ('container_unit', NULLIF(OLD.container_unit::text, ''), NULLIF(NEW.container_unit::text, '')),
      ('container_type', NULLIF(OLD.container_type::text, ''), NULLIF(NEW.container_type::text, '')),
      ('unit_size', NULLIF(OLD.unit_size::text, ''), NULLIF(NEW.unit_size::text, '')),
      ('inventory_unit', NULLIF(OLD.inventory_unit::text, ''), NULLIF(NEW.inventory_unit::text, '')),
      ('product_form', NULLIF(OLD.product_form::text, ''), NULLIF(NEW.product_form::text, '')),
      ('suggested_rate', NULLIF(OLD.suggested_rate::text, ''), NULLIF(NEW.suggested_rate::text, '')),
      ('rate_per_acre', trim_scale(OLD.rate_per_acre)::text, trim_scale(NEW.rate_per_acre)::text),
      ('rate_unit', NULLIF(OLD.rate_unit::text, ''), NULLIF(NEW.rate_unit::text, '')),
      ('notes', NULLIF(OLD.notes::text, ''), NULLIF(NEW.notes::text, '')),
      ('internal_notes', NULLIF(OLD.internal_notes::text, ''), NULLIF(NEW.internal_notes::text, '')),
      ('quoting_notes', NULLIF(OLD.quoting_notes::text, ''), NULLIF(NEW.quoting_notes::text, '')),
      ('is_active', OLD.is_active::text, NEW.is_active::text),
      ('epa_registration', NULLIF(OLD.epa_registration::text, ''), NULLIF(NEW.epa_registration::text, '')),
      ('is_rup', OLD.is_rup::text, NEW.is_rup::text),
      ('signal_word', NULLIF(OLD.signal_word::text, ''), NULLIF(NEW.signal_word::text, '')),
      ('rei_hours', OLD.rei_hours::text, NEW.rei_hours::text),
      ('phi_days', OLD.phi_days::text, NEW.phi_days::text),
      ('max_label_rate', trim_scale(OLD.max_label_rate)::text, trim_scale(NEW.max_label_rate)::text),
      ('max_label_rate_unit', NULLIF(OLD.max_label_rate_unit::text, ''), NULLIF(NEW.max_label_rate_unit::text, '')),
      ('use_timing', NULLIF(OLD.use_timing::text, ''), NULLIF(NEW.use_timing::text, '')),
      ('product_family_id', OLD.product_family_id::text, NEW.product_family_id::text),
      ('return_policy', NULLIF(OLD.return_policy::text, ''), NULLIF(NEW.return_policy::text, '')),
      ('packaging_variant', NULLIF(OLD.packaging_variant::text, ''), NULLIF(NEW.packaging_variant::text, '')),
      ('is_full_tote_only', OLD.is_full_tote_only::text, NEW.is_full_tote_only::text)
    ) AS fields(field_name, old_value, new_value)
    WHERE old_value IS DISTINCT FROM new_value
  LOOP
    INSERT INTO public.product_change_history
      (product_id, change_type, field_name, old_value, new_value, changed_by, changed_by_name, parent_event_id)
    VALUES (NEW.id, CASE WHEN v_parent_event IS NULL THEN 'updated' ELSE 'parent_copy' END, v_change.field_name,
            CASE WHEN v_change.field_name IN ('notes', 'internal_notes', 'quoting_notes', 'product_family_id')
              THEN NULL ELSE v_change.old_value END,
            CASE WHEN v_change.field_name IN ('notes', 'internal_notes', 'quoting_notes', 'product_family_id')
              THEN NULL ELSE v_change.new_value END,
            v_actor, v_actor_name, v_parent_event);
  END LOOP;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Category aliases in one place, and the guards
-- ---------------------------------------------------------------------------------------------

-- The canonical category for a (possibly deprecated) category name, and the use timing the alias sets
-- (NULL when it sets none). The alias table from 20260702170000.
CREATE FUNCTION public._normalized_category_timing(p_category text, OUT category text, OUT use_timing text)
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT CASE
           WHEN p_category IN ('Post Emergence', 'Pre-Emerge Soybean', 'Pre-Emerge Corn', 'Volunteer Corn',
                               'Range Pasture Turf') THEN 'Herbicide'
           WHEN p_category IN ('Foliar Nutrition', 'Foliar Nutrition & Liquid Fertilizer') THEN 'Foliar Fertilizer'
           WHEN p_category = 'Utility' THEN 'Other'
           ELSE p_category END,
         CASE p_category
           WHEN 'Post Emergence' THEN 'Post-Emergence'
           WHEN 'Pre-Emerge Soybean' THEN 'Pre-Emerge Soybean'
           WHEN 'Pre-Emerge Corn' THEN 'Pre-Emerge Corn'
           WHEN 'Volunteer Corn' THEN 'Volunteer Corn'
           WHEN 'Range Pasture Turf' THEN 'Range/Pasture/Turf'
           WHEN 'Foliar Nutrition' THEN 'Foliar'
           WHEN 'Foliar Nutrition & Liquid Fertilizer' THEN 'Foliar'
         END;
$function$;
ALTER FUNCTION public._normalized_category_timing(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._normalized_category_timing(text) FROM PUBLIC, anon, authenticated, service_role;
-- normalize_product_category runs as the signed-in user (an admin's direct product save or insert).
GRANT EXECUTE ON FUNCTION public._normalized_category_timing(text) TO authenticated, service_role;

-- Same behaviour as before; the table now lives in _normalized_category_timing.
CREATE OR REPLACE FUNCTION public.normalize_product_category()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v record;
BEGIN
  -- Keep the DEPRECATED timing-category aliases from re-entering products.category. The alias's
  -- canonical timing is authoritative; use_timing is otherwise left as typed (see 20260702170000).
  SELECT * INTO v FROM public._normalized_category_timing(NEW.category);
  IF v.category IS DISTINCT FROM NEW.category THEN
    NEW.category := v.category;
    IF v.use_timing IS NOT NULL THEN NEW.use_timing := v.use_timing; END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public._normalize_epa_registration(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT NULLIF(upper(regexp_replace(COALESCE(p, ''), '\s', '', 'g')), '');
$function$;
ALTER FUNCTION public._normalize_epa_registration(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._normalize_epa_registration(text) FROM PUBLIC, anon, authenticated, service_role;

-- The parent message. The reload hint is in the database text because an already-open old page
-- shows the error text as it is.
CREATE FUNCTION public._product_parent_refusal(p_parent_name text, p_column text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT format('PRODUCT_PARENT_VALUE: %s belongs to parent "%s"; edit it on the parent (reload the app if you do not see a Parent panel)',
                p_column, p_parent_name);
$function$;
ALTER FUNCTION public._product_parent_refusal(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_refusal(text, text) FROM PUBLIC, anon, authenticated, service_role;

-- Runs second (after trg_a_share_product_rate_lock), before the alias trigger and the use-timing sync,
-- either of which can refuse a legacy edit with its own message first.
CREATE FUNCTION public.guard_product_parent_timings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent text;
  v_norm record;
BEGIN
  IF NEW.use_timings IS NOT DISTINCT FROM OLD.use_timings AND NEW.use_timing IS NOT DISTINCT FROM OLD.use_timing
     AND NEW.category IS NOT DISTINCT FROM OLD.category THEN
    RETURN NEW;
  END IF;
  SELECT pp.name INTO v_parent FROM public.product_parent_members m
    JOIN public.product_parents pp ON pp.id = m.parent_id WHERE m.product_id = NEW.id;
  IF v_parent IS NULL OR EXISTS (SELECT 1 FROM public.product_parent_copy_passes
                                  WHERE txid = txid_current() AND product_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_norm FROM public._normalized_category_timing(NEW.category);
  IF NEW.use_timings IS DISTINCT FROM OLD.use_timings OR NEW.use_timing IS DISTINCT FROM OLD.use_timing
     OR (v_norm.use_timing IS NOT NULL AND v_norm.use_timing IS DISTINCT FROM OLD.use_timing) THEN
    RAISE EXCEPTION '%', public._product_parent_refusal(v_parent, 'use timing') USING ERRCODE = 'check_violation';
  END IF;
  IF v_norm.category IS DISTINCT FROM OLD.category THEN
    RAISE EXCEPTION '%', public._product_parent_refusal(v_parent, 'category') USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_product_parent_timings() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_product_parent_timings() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_b_guard_product_parent_timings
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_parent_timings();

-- Runs after every trg_* trigger (so it sees the normalized category and synced timings) and before
-- trigger_zzz_guard_product_rate_lock (so a grouped size gets the parent message, not the lock's).
CREATE FUNCTION public.guard_product_parent_values() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent text;
  v_column text;
BEGIN
  v_column := CASE
    WHEN NEW.category IS DISTINCT FROM OLD.category THEN 'category'
    WHEN NEW.use_timings IS DISTINCT FROM OLD.use_timings OR NEW.use_timing IS DISTINCT FROM OLD.use_timing THEN 'use timing'
    WHEN NEW.rate_per_acre IS DISTINCT FROM OLD.rate_per_acre THEN 'rate per acre'
    WHEN NULLIF(NEW.rate_unit, '') IS DISTINCT FROM NULLIF(OLD.rate_unit, '') THEN 'rate unit'
    WHEN NULLIF(btrim(NEW.suggested_rate), '') IS DISTINCT FROM NULLIF(btrim(OLD.suggested_rate), '') THEN 'suggested rate'
    WHEN public._normalize_epa_registration(NEW.epa_registration)
         IS DISTINCT FROM public._normalize_epa_registration(OLD.epa_registration) THEN 'EPA number'
  END;
  IF v_column IS NULL THEN RETURN NEW; END IF;
  SELECT pp.name INTO v_parent FROM public.product_parent_members m
    JOIN public.product_parents pp ON pp.id = m.parent_id WHERE m.product_id = NEW.id;
  IF v_parent IS NULL OR EXISTS (SELECT 1 FROM public.product_parent_copy_passes
                                  WHERE txid = txid_current() AND product_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%', public._product_parent_refusal(v_parent, v_column) USING ERRCODE = 'check_violation';
END;
$function$;
ALTER FUNCTION public.guard_product_parent_values() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_product_parent_values() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trigger_zz_guard_product_parent_values
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_parent_values();

-- Re-issued from 20261107080000: a grouped size's fingerprint also covers its parent, so a Setup-tab
-- row downloaded before the size joined or changed parent is refused as stale. An ungrouped size's
-- fingerprint is byte-for-byte what it was.
CREATE OR REPLACE FUNCTION public._product_setup_fingerprint(p public.products) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $function$
  SELECT md5((jsonb_build_object(
    'product_name', p.product_name, 'sku', p.sku, 'category', p.category,
    'manufacturer', p.manufacturer, 'container_size', p.container_size,
    'container_type', p.container_type, 'epa_registration', p.epa_registration,
    'is_rup', p.is_rup, 'signal_word', p.signal_word, 'rei_hours', p.rei_hours,
    'phi_days', p.phi_days, 'max_label_rate', p.max_label_rate,
    'max_label_rate_unit', p.max_label_rate_unit, 'use_timings', to_jsonb(p.use_timings),
    'notes', p.notes, 'internal_notes', p.internal_notes, 'quoting_notes', p.quoting_notes)
    || COALESCE((SELECT jsonb_build_object('parent_id', m.parent_id)
                   FROM public.product_parent_members m WHERE m.product_id = p.id), '{}'::jsonb))::text);
$function$;

-- ---------------------------------------------------------------------------------------------
-- Private helpers (no grants)
-- ---------------------------------------------------------------------------------------------

-- Retry receipt lookup: refuses a missing key; returns the saved response, or NULL for a new request.
CREATE FUNCTION public._product_parent_replay(p_key text, p_scope text, p_fp text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_existing jsonb;
BEGIN
  IF p_key IS NULL OR btrim(p_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  -- An identical retry sent while the first is still running waits here, then finds its receipt.
  PERFORM pg_advisory_xact_lock(hashtext('crx.product_parent:' || p_scope || ':' || p_key));
  v_existing := public.check_idempotency(p_key, p_scope);
  IF v_existing IS NULL THEN RETURN NULL; END IF;
  IF v_existing->>'actor_id' IS DISTINCT FROM auth.uid()::text
     OR v_existing->>'request_fingerprint' IS DISTINCT FROM p_fp THEN
    RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
  END IF;
  RETURN v_existing->'response';
END;
$function$;
ALTER FUNCTION public._product_parent_replay(text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_replay(text, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._product_parent_require_admin() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  RETURN auth.uid();
END;
$function$;
ALTER FUNCTION public._product_parent_require_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_require_admin() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._product_parent_reason(p_text text, p_label text, p_required boolean) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
BEGIN
  IF p_text IS NULL OR p_text !~ '[^[:space:]]' THEN
    IF p_required THEN RAISE EXCEPTION '%_REQUIRED: say %', upper(p_label), CASE p_label WHEN 'evidence' THEN 'what shows it' ELSE 'why' END; END IF;
    RETURN NULL;
  END IF;
  IF length(btrim(p_text)) > 1000 THEN RAISE EXCEPTION '%_TOO_LONG: keep it to 1000 characters', upper(p_label); END IF;
  RETURN btrim(p_text);
END;
$function$;
ALTER FUNCTION public._product_parent_reason(text, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_reason(text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- Use timing codes in the sync trigger's stored order; refuses an unknown code or one that is not a
-- timing of p_category (each option belongs to one category).
CREATE FUNCTION public._product_parent_timings(p_codes jsonb, p_category text) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_codes text[];
BEGIN
  IF p_codes IS NULL OR jsonb_typeof(p_codes) = 'null' THEN RETURN '{}'; END IF;
  IF jsonb_typeof(p_codes) <> 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_codes) t WHERE jsonb_typeof(t) <> 'string') THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: use_timings must be a list of use timing codes';
  END IF;
  v_codes := ARRAY(SELECT DISTINCT jsonb_array_elements_text(p_codes));
  IF EXISTS (SELECT 1 FROM unnest(v_codes) c WHERE NOT EXISTS (SELECT 1 FROM public.product_use_timing_options o WHERE o.code = c)) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: unknown use timing; pick from the list';
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_use_timing_options o
              WHERE o.code = ANY(v_codes) AND o.category IS DISTINCT FROM p_category) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_TIMING_CATEGORY: % does not take use timing %', COALESCE(p_category, 'no category'),
      (SELECT string_agg(o.label, ', ' ORDER BY o.sort_order) FROM public.product_use_timing_options o
        WHERE o.code = ANY(v_codes) AND o.category IS DISTINCT FROM p_category);
  END IF;
  RETURN COALESCE((SELECT array_agg(o.code ORDER BY o.sort_order, o.code)
                     FROM public.product_use_timing_options o WHERE o.code = ANY(v_codes)), '{}');
END;
$function$;
ALTER FUNCTION public._product_parent_timings(jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_timings(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

-- A size's copied values, as the event log and the history record them.
CREATE FUNCTION public._product_size_values(p_product_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $function$
  SELECT jsonb_build_object('product_id', p.id, 'product_name', p.product_name, 'category', p.category,
    'use_timings', to_jsonb(p.use_timings), 'rate_per_acre', p.rate_per_acre::text, 'rate_unit', p.rate_unit,
    'suggested_rate', p.suggested_rate, 'epa_registration', p.epa_registration,
    'pricing_version', p.pricing_version, 'tier1_price_per_acre', p.tier1_price_per_acre,
    'tier2_price_per_acre', p.tier2_price_per_acre, 'tier3_price_per_acre', p.tier3_price_per_acre)
  FROM public.products p WHERE p.id = p_product_id;
$function$;
ALTER FUNCTION public._product_size_values(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_size_values(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- What a move preview binds: everything a move would read or change on the size.
CREATE FUNCTION public._product_size_fingerprint(p_product_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $function$
  SELECT md5(jsonb_build_object('pricing_version', p.pricing_version, 'rate_per_acre', p.rate_per_acre::text,
    'rate_unit', p.rate_unit, 'suggested_rate', p.suggested_rate, 'category', p.category,
    'use_timings', to_jsonb(p.use_timings), 'epa_registration', p.epa_registration,
    'product_form', p.product_form, 'inventory_unit', p.inventory_unit, 'unit_size', p.unit_size,
    'parent_id', (SELECT m.parent_id FROM public.product_parent_members m WHERE m.product_id = p.id))::text)
  FROM public.products p WHERE p.id = p_product_id;
$function$;
ALTER FUNCTION public._product_size_fingerprint(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_size_fingerprint(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._product_parent_values(p public.product_parents) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT jsonb_build_object('name', p.name, 'nickname', p.nickname, 'product_form', p.product_form,
    'formulation_type', p.formulation_type, 'safener', p.safener,
    'generic_epa_registration', p.generic_epa_registration, 'category', p.category,
    'use_timings', to_jsonb(p.use_timings), 'rate_per_acre', p.rate_per_acre::text,
    'rate_unit', p.rate_unit, 'suggested_rate', p.suggested_rate, 'parent_version', p.parent_version,
    'is_active', p.is_active);
$function$;
ALTER FUNCTION public._product_parent_values(public.product_parents) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_values(public.product_parents) FROM PUBLIC, anon, authenticated, service_role;

-- The next log entry's number, taken before the size copies that reference it.
CREATE FUNCTION public._next_product_parent_event_id() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT nextval(pg_get_serial_sequence('public.product_parent_events', 'id'));
$function$;
ALTER FUNCTION public._next_product_parent_event_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._next_product_parent_event_id() FROM PUBLIC, anon, authenticated, service_role;

-- Appends one complete log entry (with every size's before and after) under a number from
-- _next_product_parent_event_id (or a new one when p_id is NULL).
CREATE FUNCTION public._product_parent_event(p_id bigint, p_parent_id uuid, p_type text, p_reason text, p_evidence text,
  p_before jsonb, p_after jsonb, p_affected jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_id bigint := COALESCE(p_id, public._next_product_parent_event_id());
BEGIN
  INSERT INTO public.product_parent_events (id, parent_id, event_type, reason, evidence, before_values, after_values,
    affected, changed_by, changed_by_name)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, p_parent_id, p_type, p_reason, p_evidence, p_before, p_after, COALESCE(p_affected, '[]'::jsonb),
    auth.uid(), (SELECT full_name FROM public.profiles WHERE id = auth.uid()));
  RETURN v_id;
END;
$function$;
ALTER FUNCTION public._product_parent_event(bigint, uuid, text, text, text, jsonb, jsonb, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_event(bigint, uuid, text, text, text, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- The one governed write: copy the parent's category and use timings (and, with p_rates, its rates;
-- with p_epa, its generic EPA number) onto one size, under a pass that exists only for this statement.
-- p_rate_pass also lets the write through the rate lock (correction and add-a-size only).
-- Returns the size's before and after; the caller appends it to the event.
CREATE FUNCTION public._copy_parent_to_size(p_parent_id uuid, p_product_id uuid, p_event_id bigint,
  p_rates boolean, p_rate_pass boolean, p_epa boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent public.product_parents%ROWTYPE;
  v_before jsonb;
BEGIN
  SELECT * INTO v_parent FROM public.product_parents WHERE id = p_parent_id;
  v_before := public._product_size_values(p_product_id);
  INSERT INTO public.product_parent_copy_passes (txid, product_id, parent_event_id)
  VALUES (txid_current(), p_product_id, p_event_id);
  IF p_rate_pass THEN
    INSERT INTO public.product_rate_correction_passes (txid, product_id) VALUES (txid_current(), p_product_id);
  END IF;
  UPDATE public.products p SET
    category = v_parent.category,
    use_timings = v_parent.use_timings,
    rate_per_acre = CASE WHEN p_rates THEN v_parent.rate_per_acre ELSE p.rate_per_acre END,
    -- Seed and each sizes keep their stock unit as rate unit (validate_product_units).
    rate_unit = CASE WHEN NOT p_rates THEN p.rate_unit
                     WHEN p.product_form IN ('seed', 'each') THEN p.inventory_unit
                     ELSE v_parent.rate_unit END,
    suggested_rate = CASE WHEN p_rates THEN v_parent.suggested_rate ELSE p.suggested_rate END,
    epa_registration = CASE WHEN p_epa THEN v_parent.generic_epa_registration ELSE p.epa_registration END,
    updated_at = now()
  WHERE p.id = p_product_id;
  DELETE FROM public.product_parent_copy_passes WHERE txid = txid_current() AND product_id = p_product_id;
  IF p_rate_pass THEN
    DELETE FROM public.product_rate_correction_passes WHERE txid = txid_current() AND product_id = p_product_id;
  END IF;
  RETURN jsonb_build_object('product_id', p_product_id, 'before', v_before,
    'after', public._product_size_values(p_product_id));
END;
$function$;
ALTER FUNCTION public._copy_parent_to_size(uuid, uuid, bigint, boolean, boolean, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._copy_parent_to_size(uuid, uuid, bigint, boolean, boolean, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- Lock a parent, then its member sizes in product-ID order. Returns the member IDs.
CREATE FUNCTION public._lock_product_parent(p_parent_id uuid, p_expected_version bigint) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_version bigint;
  v_name text;
BEGIN
  SELECT parent_version, name INTO v_version, v_name FROM public.product_parents WHERE id = p_parent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  IF p_expected_version IS NULL OR v_version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_STALE: parent "%" changed since you opened it; reload and try again', v_name;
  END IF;
  PERFORM 1 FROM public.products p WHERE p.id IN (SELECT m.product_id FROM public.product_parent_members m
                                                   WHERE m.parent_id = p_parent_id)
   ORDER BY p.id FOR UPDATE;
  RETURN ARRAY(SELECT m.product_id FROM public.product_parent_members m WHERE m.parent_id = p_parent_id ORDER BY m.product_id);
END;
$function$;
ALTER FUNCTION public._lock_product_parent(uuid, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._lock_product_parent(uuid, bigint) FROM PUBLIC, anon, authenticated, service_role;

-- Insert one size through apply_product_setup's insert mode (the one setup insert path), with the
-- parent's form, category and (when the size gives none) generic EPA number. Copied values other
-- than category, and rates, are refused in p_size: they come from the parent afterwards.
CREATE FUNCTION public._insert_parent_size(p_parent public.product_parents, p_size jsonb, p_key text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_fields jsonb;
  v_saved jsonb;
BEGIN
  IF p_size IS NULL OR jsonb_typeof(p_size) <> 'object' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_SIZE_REQUIRED: send the new size''s fields';
  END IF;
  IF p_size ?| ARRAY['category', 'use_timing', 'use_timings', 'rate_per_acre', 'rate_unit', 'suggested_rate', 'rates'] THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_SIZE_COPIED_VALUE: category, use timing and rates come from the parent; leave them off the size';
  END IF;
  IF p_size ? 'product_form' AND (p_size->>'product_form') IS DISTINCT FROM p_parent.product_form THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_FORM_MISMATCH: every size of "%" is %', p_parent.name, p_parent.product_form;
  END IF;
  -- Every size carries its parent's EPA number, or none does (build sheet §4.1).
  IF public._normalize_epa_registration(p_size->>'epa_registration') IS DISTINCT FROM p_parent.generic_epa_registration
     AND public._normalize_epa_registration(p_size->>'epa_registration') IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_EPA_MISMATCH: "%" has %', p_parent.name,
      COALESCE('EPA number ' || p_parent.generic_epa_registration, 'no EPA number; set it on the parent first');
  END IF;
  v_fields := (p_size - 'size_role') || jsonb_build_object('product_form', p_parent.product_form, 'category', p_parent.category);
  -- The size stores the parent's normalized number, never a spaced or lower-case spelling of it.
  IF p_parent.generic_epa_registration IS NOT NULL THEN
    v_fields := v_fields || jsonb_build_object('epa_registration', p_parent.generic_epa_registration);
  END IF;
  -- A fresh key: a retry is answered by the caller's own receipt before it gets here, so no setup
  -- receipt (for example one an admin saved under '<key>:insert') can hand back an existing product.
  v_saved := public.apply_product_setup(jsonb_build_array(jsonb_build_object('insert', v_fields)), auth.uid(),
    'product_parent_size:' || gen_random_uuid()::text);
  RETURN (v_saved->'rows'->0->>'product_id')::uuid;
END;
$function$;
ALTER FUNCTION public._insert_parent_size(public.product_parents, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._insert_parent_size(public.product_parents, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._product_parent_size_role(p_size jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
BEGIN
  IF NOT (p_size ? 'size_role') OR jsonb_typeof(p_size->'size_role') = 'null' THEN RETURN 'package'; END IF;
  IF (p_size->>'size_role') NOT IN ('package', 'bulk', 'fixed_tote') THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: size_role is package, bulk or fixed_tote';
  END IF;
  RETURN p_size->>'size_role';
END;
$function$;
ALTER FUNCTION public._product_parent_size_role(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_size_role(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- New product / Add a size / Edit parent
-- ---------------------------------------------------------------------------------------------

-- "New product": a new parent and its first size, in one transaction. Rates are set afterwards on the
-- parent (set_parent_rates, or correct_parent_rates while locked).
CREATE FUNCTION public.create_product_with_parent(p_parent jsonb, p_size jsonb, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_receipt jsonb;
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'parent', p_parent, 'size', p_size)::text);
  v_existing jsonb;
  v_parent public.product_parents%ROWTYPE;
  v_product uuid;
  v_event bigint;
  v_copy jsonb;
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'create_product_with_parent', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF p_parent IS NULL OR jsonb_typeof(p_parent) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_parent) k
                WHERE k NOT IN ('name', 'nickname', 'product_form', 'formulation_type', 'safener',
                                'generic_epa_registration', 'category', 'use_timings'))
     OR EXISTS (SELECT 1 FROM jsonb_each(p_parent) e WHERE e.key <> 'use_timings' AND jsonb_typeof(e.value) NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: the parent takes name, nickname, product_form, formulation_type, safener, generic_epa_registration, category and use_timings';
  END IF;
  IF NULLIF(btrim(p_parent->>'category'), '') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.product_categories c WHERE c.name = btrim(p_parent->>'category') AND c.is_active) THEN
    RAISE EXCEPTION 'PRODUCT_CATEGORY_RETIRED: choose an active category';
  END IF;

  INSERT INTO public.product_parents (name, nickname, product_form, formulation_type, safener,
    generic_epa_registration, category, use_timings, created_by, updated_by)
  VALUES (NULLIF(btrim(p_parent->>'name'), ''), NULLIF(btrim(p_parent->>'nickname'), ''),
    NULLIF(btrim(p_parent->>'product_form'), ''), NULLIF(btrim(p_parent->>'formulation_type'), ''),
    NULLIF(btrim(p_parent->>'safener'), ''), public._normalize_epa_registration(p_parent->>'generic_epa_registration'),
    NULLIF(btrim(p_parent->>'category'), ''), public._product_parent_timings(p_parent->'use_timings', NULLIF(btrim(p_parent->>'category'), '')), v_actor, v_actor)
  RETURNING * INTO v_parent;

  v_product := public._insert_parent_size(v_parent, p_size, p_idempotency_key);
  INSERT INTO public.product_parent_members (product_id, parent_id, size_role, added_by)
  VALUES (v_product, v_parent.id, public._product_parent_size_role(p_size), v_actor);
  v_event := public._next_product_parent_event_id();
  v_copy := public._copy_parent_to_size(v_parent.id, v_product, v_event, false, false, false);
  PERFORM public._product_parent_event(v_event, v_parent.id, 'created', NULL, NULL, NULL,
    public._product_parent_values(v_parent), jsonb_build_array(v_copy));

  v_result := jsonb_build_object('parent_id', v_parent.id, 'parent_version', v_parent.parent_version,
    'product_id', v_product, 'event_id', v_event);
  v_receipt := v_result;
  PERFORM public.save_idempotency(p_idempotency_key, 'create_product_with_parent',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
EXCEPTION WHEN unique_violation THEN
  IF SQLERRM LIKE '%product_parents_active_name_unique%' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_NAME_TAKEN: another parent is named "%"', btrim(p_parent->>'name');
  END IF;
  RAISE;
END;
$function$;
ALTER FUNCTION public.create_product_with_parent(jsonb, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_product_with_parent(jsonb, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_product_with_parent(jsonb, jsonb, text) TO authenticated;

-- "Add a size": a new product under an existing parent, taking the parent's category, use timings and
-- rates (through the rate lock, since the new size takes exactly the parent's unchanged rate).
CREATE FUNCTION public.add_product_size(p_parent_id uuid, p_expected_parent_version bigint, p_size jsonb,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_receipt jsonb;
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'parent_id', p_parent_id,
    'expected_parent_version', p_expected_parent_version, 'size', p_size)::text);
  v_existing jsonb;
  v_parent public.product_parents%ROWTYPE;
  v_product uuid;
  v_event bigint;
  v_copy jsonb;
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'add_product_size', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  PERFORM public._lock_product_parent(p_parent_id, p_expected_parent_version);
  SELECT * INTO v_parent FROM public.product_parents WHERE id = p_parent_id;
  IF NOT v_parent.is_active THEN RAISE EXCEPTION 'PRODUCT_PARENT_INACTIVE: "%" is inactive', v_parent.name; END IF;

  v_product := public._insert_parent_size(v_parent, p_size, p_idempotency_key);
  INSERT INTO public.product_parent_members (product_id, parent_id, size_role, added_by)
  VALUES (v_product, v_parent.id, public._product_parent_size_role(p_size), v_actor);
  UPDATE public.product_parents SET parent_version = parent_version + 1, updated_by = v_actor, updated_at = now()
   WHERE id = p_parent_id RETURNING * INTO v_parent;
  v_event := public._next_product_parent_event_id();
  v_copy := public._copy_parent_to_size(v_parent.id, v_product, v_event, true, true, false);
  PERFORM public._product_parent_event(v_event, v_parent.id, 'size_added', NULL, NULL, NULL,
    public._product_parent_values(v_parent), jsonb_build_array(v_copy));

  v_result := jsonb_build_object('parent_id', v_parent.id, 'parent_version', v_parent.parent_version,
    'product_id', v_product, 'event_id', v_event);
  v_receipt := v_result;
  PERFORM public.save_idempotency(p_idempotency_key, 'add_product_size',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
EXCEPTION WHEN unique_violation THEN
  IF SQLERRM LIKE '%product_parent_members_one_bulk%' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_ONE_BULK: "%" already has a bulk size', v_parent.name;
  END IF;
  RAISE;
END;
$function$;
ALTER FUNCTION public.add_product_size(uuid, bigint, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_product_size(uuid, bigint, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_product_size(uuid, bigint, jsonb, text) TO authenticated;

-- Name, nickname, category and use timings. Identity uses the correction; rates use set/correct.
CREATE FUNCTION public.update_product_parent(p_parent_id uuid, p_expected_parent_version bigint, p_changes jsonb,
  p_reason text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_receipt jsonb;
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'parent_id', p_parent_id,
    'expected_parent_version', p_expected_parent_version, 'changes', p_changes, 'reason', btrim(p_reason))::text);
  v_existing jsonb;
  v_reason text;
  v_before public.product_parents%ROWTYPE;
  v_parent public.product_parents%ROWTYPE;
  v_category text;
  v_timings text[];
  v_sizes uuid[];
  v_size uuid;
  v_event bigint;
  v_affected jsonb := '[]'::jsonb;
  v_copies boolean;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'update_product_parent', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', true);
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes)) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: send at least one change';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes) k
             WHERE k IN ('product_form', 'formulation_type', 'safener', 'generic_epa_registration')) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_IDENTITY: form, formulation type, safener and EPA number change only through the identity correction';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k IN ('rate_per_acre', 'rate_unit', 'suggested_rate')) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_RATES: rates change through the parent''s rate edit';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN ('name', 'nickname', 'category', 'use_timings'))
     OR EXISTS (SELECT 1 FROM jsonb_each(p_changes) e WHERE e.key <> 'use_timings' AND jsonb_typeof(e.value) NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: a parent edit takes name, nickname, category and use_timings';
  END IF;

  v_sizes := public._lock_product_parent(p_parent_id, p_expected_parent_version);
  SELECT * INTO v_before FROM public.product_parents WHERE id = p_parent_id;
  v_category := CASE WHEN p_changes ? 'category' THEN NULLIF(btrim(p_changes->>'category'), '') ELSE v_before.category END;
  v_timings := CASE WHEN p_changes ? 'use_timings' THEN public._product_parent_timings(p_changes->'use_timings', v_category) ELSE v_before.use_timings END;
  IF v_category IS DISTINCT FROM v_before.category THEN
    IF v_category IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.product_categories c WHERE c.name = v_category AND c.is_active) THEN
      RAISE EXCEPTION 'PRODUCT_CATEGORY_RETIRED: choose an active category';
    END IF;
    -- Each timing belongs to one category: the screen confirms clearing the old ones first.
    IF NOT (p_changes ? 'use_timings') AND EXISTS (SELECT 1 FROM public.product_use_timing_options o
         WHERE o.code = ANY(v_timings) AND o.category IS DISTINCT FROM v_category) THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_TIMINGS_MUST_CLEAR: % does not take use timings; confirm clearing them (send use_timings: [])',
        COALESCE(v_category, 'no category');
    END IF;
  END IF;
  -- An edit that changes nothing would only bump the version and stale every open preview.
  IF (NOT (p_changes ? 'name') OR NULLIF(btrim(p_changes->>'name'), '') IS NOT DISTINCT FROM v_before.name)
     AND (NOT (p_changes ? 'nickname') OR NULLIF(btrim(p_changes->>'nickname'), '') IS NOT DISTINCT FROM v_before.nickname)
     AND v_category IS NOT DISTINCT FROM v_before.category AND v_timings IS NOT DISTINCT FROM v_before.use_timings THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_NO_CHANGE: nothing to save; "%" already has these values', v_before.name;
  END IF;

  UPDATE public.product_parents SET
    name = CASE WHEN p_changes ? 'name' THEN NULLIF(btrim(p_changes->>'name'), '') ELSE name END,
    nickname = CASE WHEN p_changes ? 'nickname' THEN NULLIF(btrim(p_changes->>'nickname'), '') ELSE nickname END,
    category = v_category, use_timings = v_timings,
    parent_version = parent_version + 1, updated_by = v_actor, updated_at = now()
  WHERE id = p_parent_id RETURNING * INTO v_parent;
  v_event := public._next_product_parent_event_id();
  v_copies := v_parent.category IS DISTINCT FROM v_before.category OR v_parent.use_timings IS DISTINCT FROM v_before.use_timings;
  IF v_copies THEN
    FOREACH v_size IN ARRAY v_sizes LOOP
      v_affected := v_affected || public._copy_parent_to_size(p_parent_id, v_size, v_event, false, false, false);
    END LOOP;
  END IF;
  PERFORM public._product_parent_event(v_event, p_parent_id, 'updated', v_reason, NULL,
    public._product_parent_values(v_before), public._product_parent_values(v_parent), v_affected);
  v_receipt := jsonb_build_object('parent_id', p_parent_id, 'parent_version', v_parent.parent_version, 'event_id', v_event,
      'sizes', v_affected);
  PERFORM public.save_idempotency(p_idempotency_key, 'update_product_parent',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
EXCEPTION WHEN unique_violation THEN
  IF SQLERRM LIKE '%product_parents_active_name_unique%' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_NAME_TAKEN: another parent is named "%"', btrim(p_changes->>'name');
  END IF;
  RAISE;
END;
$function$;
ALTER FUNCTION public.update_product_parent(uuid, bigint, jsonb, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_product_parent(uuid, bigint, jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_product_parent(uuid, bigint, jsonb, text, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Parent rates
-- ---------------------------------------------------------------------------------------------

-- Read-only: for each size, the snapshot set/correct_parent_rates must carry back, and the per-acre
-- prices the new rate would save (preview_product_rate_correction, the same math the save checks).
CREATE FUNCTION public.preview_parent_rates(p_parent_id uuid, p_rate_per_acre numeric, p_rate_unit text,
  p_suggested_rate text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent public.product_parents%ROWTYPE;
  v_sizes jsonb := '[]'::jsonb;
  v_size record;
BEGIN
  PERFORM public._product_parent_require_admin();
  SELECT * INTO v_parent FROM public.product_parents WHERE id = p_parent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  FOR v_size IN SELECT p.id, p.product_name, p.pricing_version, p.unit_size, p.inventory_unit, p.product_form,
                       p.rate_per_acre, p.rate_unit, p.suggested_rate
                  FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
                 WHERE m.parent_id = p_parent_id ORDER BY p.id LOOP
    v_sizes := v_sizes || (jsonb_build_object('product_id', v_size.id, 'product_name', v_size.product_name,
      'pricing_version', v_size.pricing_version, 'unit_size', v_size.unit_size,
      'inventory_unit', v_size.inventory_unit, 'product_form', v_size.product_form,
      'rate_per_acre', v_size.rate_per_acre::text, 'rate_unit', v_size.rate_unit,
      'suggested_rate', v_size.suggested_rate)
      || (SELECT jsonb_build_object('prices', c->'after', 'before_prices', c->'before')
            -- Seed and each sizes save their stock unit as rate unit, so preview with it too.
            FROM public.preview_product_rate_correction(v_size.id, p_rate_per_acre,
                   CASE WHEN v_size.product_form IN ('seed', 'each') THEN v_size.inventory_unit ELSE p_rate_unit END) c));
  END LOOP;
  RETURN jsonb_build_object('parent_id', p_parent_id, 'parent_version', v_parent.parent_version,
    'rates_locked', COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id), true),
    'before', jsonb_build_object('rate_per_acre', v_parent.rate_per_acre::text, 'rate_unit', v_parent.rate_unit,
      'suggested_rate', v_parent.suggested_rate),
    'after', jsonb_build_object('rate_per_acre', p_rate_per_acre::text,
      'rate_unit', CASE WHEN v_parent.product_form IN ('seed', 'each') THEN NULL ELSE NULLIF(btrim(p_rate_unit), '') END,
      'suggested_rate', NULLIF(btrim(p_suggested_rate), '')),
    'sizes', v_sizes);
END;
$function$;
ALTER FUNCTION public.preview_parent_rates(uuid, numeric, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_parent_rates(uuid, numeric, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_parent_rates(uuid, numeric, text, text) TO authenticated;

-- The shared rate write for one parent (set and correct). Locks the parent and its sizes, checks the
-- preview snapshot of every size, writes the parent and each size under its pass, and refuses any
-- size whose saved per-acre prices differ from the preview. Raising undoes everything.
CREATE FUNCTION public._apply_parent_rates(p_parent_id uuid, p_expected_parent_version bigint,
  p_rate_per_acre numeric, p_rate_unit text, p_suggested_rate text, p_expected_sizes jsonb,
  p_correction boolean, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_sizes uuid[];
  v_before public.product_parents%ROWTYPE;
  v_parent public.product_parents%ROWTYPE;
  v_unit text := NULLIF(btrim(p_rate_unit), '');
  v_suggested text := NULLIF(btrim(p_suggested_rate), '');
  v_size record;
  v_exp jsonb;
  v_event bigint;
  v_copy jsonb;
  v_affected jsonb := '[]'::jsonb;
  v_tier text;
  v_name text;
  v_pid uuid;
  v_any_change boolean := false;
BEGIN
  IF NOT public._product_rate_value_ok(to_jsonb(p_rate_per_acre::text)) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: a rate per acre must be blank or a number of 0 or more with at most 6 decimals';
  END IF;
  IF length(v_unit) > 40 OR length(v_suggested) > 200 THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: the rate unit or suggested rate is too long';
  END IF;
  IF p_expected_sizes IS NULL OR jsonb_typeof(p_expected_sizes) <> 'array' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_RATES_PREVIEW_REQUIRED: send every size''s preview snapshot';
  END IF;
  v_sizes := public._lock_product_parent(p_parent_id, p_expected_parent_version);
  SELECT * INTO v_before FROM public.product_parents WHERE id = p_parent_id;
  IF v_before.product_form IN ('seed', 'each') THEN v_unit := NULL; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_expected_sizes)) <> cardinality(v_sizes)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_expected_sizes) e
                WHERE jsonb_typeof(e) <> 'object' OR NOT ((e->>'product_id') = ANY(v_sizes::text[]))
                   OR jsonb_typeof(e->'pricing_version') <> 'number' OR jsonb_typeof(e->'prices') <> 'object')
     OR (SELECT count(DISTINCT e->>'product_id') FROM jsonb_array_elements(p_expected_sizes) e) <> cardinality(v_sizes) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_RATES_STALE: the sizes of "%" changed since the preview; preview again', v_before.name;
  END IF;

  FOR v_size IN SELECT p.id, p.product_name, p.pricing_version, p.unit_size, p.inventory_unit, p.product_form,
                       p.rate_per_acre, p.rate_unit, p.suggested_rate
                  FROM public.products p WHERE p.id = ANY(v_sizes) ORDER BY p.id LOOP
    SELECT e INTO v_exp FROM jsonb_array_elements(p_expected_sizes) e WHERE e->>'product_id' = v_size.id::text;
    IF (v_exp->>'pricing_version')::numeric IS DISTINCT FROM v_size.pricing_version
       OR (v_exp->>'unit_size') IS DISTINCT FROM v_size.unit_size
       OR (v_exp->>'inventory_unit') IS DISTINCT FROM v_size.inventory_unit
       OR (v_exp->>'product_form') IS DISTINCT FROM v_size.product_form
       OR (v_exp->>'rate_per_acre')::numeric IS DISTINCT FROM v_size.rate_per_acre
       OR NULLIF(v_exp->>'rate_unit', '') IS DISTINCT FROM NULLIF(v_size.rate_unit, '')
       OR NULLIF(btrim(v_exp->>'suggested_rate'), '') IS DISTINCT FROM NULLIF(btrim(v_size.suggested_rate), '') THEN
      RAISE EXCEPTION 'PRODUCT_RATES_STALE: % changed since the preview; preview again', v_size.product_name;
    END IF;
    IF NOT public._product_rate_unit_ok(p_rate_per_acre,
             CASE WHEN v_size.product_form IN ('seed', 'each') THEN v_size.inventory_unit ELSE v_unit END,
             v_size.rate_unit, v_size.product_form, COALESCE(NULLIF(v_size.inventory_unit, ''), v_size.unit_size)) THEN
      RAISE EXCEPTION 'PRODUCT_RATE_UNIT_INVALID: the rate unit is missing or not a known unit for %', v_size.product_name;
    END IF;
    v_any_change := v_any_change OR p_rate_per_acre IS DISTINCT FROM v_size.rate_per_acre
      OR v_suggested IS DISTINCT FROM NULLIF(btrim(v_size.suggested_rate), '')
      OR (v_size.product_form NOT IN ('seed', 'each') AND v_unit IS DISTINCT FROM NULLIF(v_size.rate_unit, ''));
  END LOOP;
  -- Nothing to do only when the parent and every size already hold these rates.
  IF NOT v_any_change AND p_rate_per_acre IS NOT DISTINCT FROM v_before.rate_per_acre
     AND v_unit IS NOT DISTINCT FROM v_before.rate_unit AND v_suggested IS NOT DISTINCT FROM v_before.suggested_rate THEN
    RAISE EXCEPTION 'PRODUCT_RATE_CORRECTION_NO_CHANGE: the parent and every size already have these rates';
  END IF;

  UPDATE public.product_parents SET rate_per_acre = p_rate_per_acre, rate_unit = v_unit, suggested_rate = v_suggested,
    parent_version = parent_version + 1, updated_by = auth.uid(), updated_at = now()
  WHERE id = p_parent_id RETURNING * INTO v_parent;
  v_event := public._next_product_parent_event_id();
  SELECT full_name INTO v_name FROM public.profiles WHERE id = auth.uid();
  FOREACH v_pid IN ARRAY v_sizes LOOP
    SELECT e INTO v_exp FROM jsonb_array_elements(p_expected_sizes) e WHERE e->>'product_id' = v_pid::text;
    v_copy := public._copy_parent_to_size(p_parent_id, v_pid, v_event, true, p_correction, false);
    -- A unit conversion changed since the preview moves the prices but no version.
    FOREACH v_tier IN ARRAY ARRAY['tier1_price_per_acre', 'tier2_price_per_acre', 'tier3_price_per_acre'] LOOP
      IF NOT (v_exp->'prices' ? v_tier) OR (v_copy->'after'->v_tier) IS DISTINCT FROM (v_exp->'prices'->v_tier) THEN
        RAISE EXCEPTION 'PRODUCT_RATE_PREVIEW_CHANGED: the per-acre prices changed since the preview; preview again: %',
          v_copy->'after'->>'product_name' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    IF p_correction THEN
      INSERT INTO public.product_rate_events
        (event_type, product_id, reason, before_values, after_values, changed_by, changed_by_name)
      VALUES ('corrected', v_pid, p_reason, v_copy->'before', v_copy->'after', auth.uid(), v_name);
    END IF;
    v_affected := v_affected || v_copy;
  END LOOP;
  PERFORM public._product_parent_event(v_event, p_parent_id, CASE WHEN p_correction THEN 'rates_corrected' ELSE 'rates_set' END,
    p_reason, NULL, public._product_parent_values(v_before), public._product_parent_values(v_parent), v_affected);
  RETURN jsonb_build_object('parent_id', p_parent_id, 'parent_version', v_parent.parent_version,
    'event_id', v_event, 'sizes', v_affected);
END;
$function$;
ALTER FUNCTION public._apply_parent_rates(uuid, bigint, numeric, text, text, jsonb, boolean, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._apply_parent_rates(uuid, bigint, numeric, text, text, jsonb, boolean, text) FROM PUBLIC, anon, authenticated, service_role;

-- Rates unlocked: one or more parents (the Rates tab), all or nothing.
-- Each row: parent_id, expected_parent_version, rate_per_acre, rate_unit, suggested_rate, sizes (the preview).
CREATE FUNCTION public.set_parent_rates(p_rows jsonb, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_receipt jsonb;
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'rows', p_rows)::text);
  v_existing jsonb;
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'set_parent_rates', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 500
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r
                WHERE jsonb_typeof(r) <> 'object'
                   OR NOT (r ? 'parent_id' AND r ? 'expected_parent_version' AND r ? 'rate_per_acre' AND r ? 'rate_unit'
                           AND r ? 'suggested_rate' AND r ? 'sizes')
                   OR (r->>'parent_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   OR jsonb_typeof(r->'expected_parent_version') <> 'number'
                   OR NOT public._product_rate_value_ok(r->'rate_per_acre')
                   OR jsonb_typeof(r->'rate_unit') NOT IN ('string', 'null')
                   OR jsonb_typeof(r->'suggested_rate') NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_RATE_ROW_SHAPE_INVALID: each row needs parent_id, expected_parent_version, rate_per_acre, rate_unit, suggested_rate and sizes';
  END IF;
  IF (SELECT count(DISTINCT lower(r->>'parent_id')) FROM jsonb_array_elements(p_rows) r) <> jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_RATE_DUPLICATE: each parent may appear once';
  END IF;
  -- Takes turns with set_product_rate_lock, as set_product_rates does.
  IF COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id FOR SHARE), true) THEN
    RAISE EXCEPTION 'PRODUCT_RATES_LOCKED: rates are locked; an admin can correct one parent''s rates, with a reason'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Parents in ID order, so two uploads lock them in the same order.
  FOR v_row IN SELECT r FROM jsonb_array_elements(p_rows) r ORDER BY (r->>'parent_id')::uuid LOOP
    v_results := v_results || public._apply_parent_rates((v_row->>'parent_id')::uuid,
      (v_row->>'expected_parent_version')::bigint, public._product_rate_value(v_row->'rate_per_acre'),
      v_row->>'rate_unit', v_row->>'suggested_rate', v_row->'sizes', false, NULL);
  END LOOP;
  v_receipt := jsonb_build_object('changed_count', jsonb_array_length(v_results), 'rows', v_results);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_parent_rates',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.set_parent_rates(jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_parent_rates(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_parent_rates(jsonb, text) TO authenticated;

-- Rates locked: one parent, with a reason; one 'corrected' rate event per size.
CREATE FUNCTION public.correct_parent_rates(p_parent_id uuid, p_rate_per_acre numeric, p_rate_unit text,
  p_suggested_rate text, p_expected_parent_version bigint, p_expected_sizes jsonb, p_reason text,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_receipt jsonb;
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'parent_id', p_parent_id, 'rate_per_acre', p_rate_per_acre,
    'rate_unit', p_rate_unit, 'suggested_rate', p_suggested_rate, 'expected_parent_version', p_expected_parent_version,
    'expected_sizes', p_expected_sizes, 'reason', btrim(p_reason))::text);
  v_existing jsonb;
  v_reason text;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'correct_parent_rates', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', true);
  IF NOT COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id FOR SHARE), true) THEN
    RAISE EXCEPTION 'PRODUCT_RATES_NOT_LOCKED: rates are open; change them with the parent''s rate edit'
      USING ERRCODE = 'check_violation';
  END IF;
  v_receipt := public._apply_parent_rates(p_parent_id, p_expected_parent_version, p_rate_per_acre, p_rate_unit,
      p_suggested_rate, p_expected_sizes, true, v_reason);
  PERFORM public.save_idempotency(p_idempotency_key, 'correct_parent_rates',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.correct_parent_rates(uuid, numeric, text, text, bigint, jsonb, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.correct_parent_rates(uuid, numeric, text, text, bigint, jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.correct_parent_rates(uuid, numeric, text, text, bigint, jsonb, text, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Move a misgrouped size
-- ---------------------------------------------------------------------------------------------

-- Why a size cannot move to a parent, or NULL when it can.
CREATE FUNCTION public._product_size_move_refusal(p_product_id uuid, p_to_parent_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_member public.product_parent_members%ROWTYPE;
  v_to public.product_parents%ROWTYPE;
  v_size record;
BEGIN
  SELECT * INTO v_member FROM public.product_parent_members WHERE product_id = p_product_id;
  IF NOT FOUND THEN RETURN 'PRODUCT_PARENT_NOT_GROUPED: this size has no parent'; END IF;
  SELECT * INTO v_to FROM public.product_parents WHERE id = p_to_parent_id;
  IF NOT FOUND THEN RETURN 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  IF v_member.parent_id = p_to_parent_id THEN RETURN 'PRODUCT_PARENT_SAME: the size already belongs to this parent'; END IF;
  IF NOT v_to.is_active THEN RETURN format('PRODUCT_PARENT_INACTIVE: "%s" is inactive', v_to.name); END IF;
  SELECT p.product_form, p.epa_registration, p.rate_per_acre, p.rate_unit, p.suggested_rate, p.inventory_unit
    INTO v_size FROM public.products p WHERE p.id = p_product_id;
  IF v_size.product_form IS DISTINCT FROM v_to.product_form THEN
    RETURN format('PRODUCT_PARENT_FORM_MISMATCH: every size of "%s" is %s', v_to.name, v_to.product_form);
  END IF;
  IF public._normalize_epa_registration(v_size.epa_registration) IS DISTINCT FROM v_to.generic_epa_registration
     AND public._normalize_epa_registration(v_size.epa_registration) IS NOT NULL THEN
    RETURN format('PRODUCT_PARENT_EPA_MISMATCH: "%s" has %s', v_to.name,
      COALESCE('EPA number ' || v_to.generic_epa_registration, 'no EPA number; set it on the parent first'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_parent_members t WHERE t.fill_source_product_id = p_product_id) THEN
    RETURN 'PRODUCT_PARENT_FILL_SOURCE_IN_USE: a tote is filled from this bulk size; change the tote''s fill source first';
  END IF;
  IF v_member.fill_source_product_id IS NOT NULL THEN
    RETURN 'PRODUCT_PARENT_FILL_SOURCE_STAYS: this tote is filled from its parent''s bulk size; clear its fill source first';
  END IF;
  IF v_member.size_role = 'bulk' AND EXISTS (SELECT 1 FROM public.product_parent_members b
                                              WHERE b.parent_id = p_to_parent_id AND b.size_role = 'bulk') THEN
    RETURN format('PRODUCT_PARENT_ONE_BULK: "%s" already has a bulk size', v_to.name);
  END IF;
  IF COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id), true)
     AND (v_size.rate_per_acre IS DISTINCT FROM v_to.rate_per_acre
          OR NULLIF(btrim(v_size.suggested_rate), '') IS DISTINCT FROM v_to.suggested_rate
          OR (v_size.product_form NOT IN ('seed', 'each') AND NULLIF(v_size.rate_unit, '') IS DISTINCT FROM v_to.rate_unit)) THEN
    RETURN 'PRODUCT_RATES_LOCKED: the move would change this size''s live rate; correct its rate to match the parent first, or unlock rates';
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public._product_size_move_refusal(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_size_move_refusal(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.preview_move_product_size(p_product_id uuid, p_to_parent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_from uuid;
  v_to public.product_parents%ROWTYPE;
  v_refusal text;
  v_prices jsonb;
BEGIN
  PERFORM public._product_parent_require_admin();
  SELECT parent_id INTO v_from FROM public.product_parent_members WHERE product_id = p_product_id;
  SELECT * INTO v_to FROM public.product_parents WHERE id = p_to_parent_id;
  v_refusal := public._product_size_move_refusal(p_product_id, p_to_parent_id);
  -- The per-acre prices the destination's rates would save (only for an allowed move).
  IF v_refusal IS NULL THEN
    v_prices := public.preview_product_rate_correction(p_product_id, v_to.rate_per_acre,
      (SELECT CASE WHEN p.product_form IN ('seed', 'each') THEN p.inventory_unit ELSE v_to.rate_unit END
         FROM public.products p WHERE p.id = p_product_id));
  END IF;
  RETURN jsonb_build_object(
    'refusal', v_refusal,
    'prices', v_prices->'after', 'before_prices', v_prices->'before',
    'from_parent_id', v_from,
    'from_parent_version', (SELECT parent_version FROM public.product_parents WHERE id = v_from),
    'to_parent_id', p_to_parent_id, 'to_parent_version', v_to.parent_version,
    'size_fingerprint', public._product_size_fingerprint(p_product_id),
    'before', public._product_size_values(p_product_id),
    'after', jsonb_build_object('category', v_to.category, 'use_timings', to_jsonb(v_to.use_timings),
      'rate_per_acre', v_to.rate_per_acre::text, 'rate_unit', v_to.rate_unit, 'suggested_rate', v_to.suggested_rate,
      'epa_registration', COALESCE((SELECT public._normalize_epa_registration(p.epa_registration) FROM public.products p
                                     WHERE p.id = p_product_id), v_to.generic_epa_registration)),
    'rates_locked', COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id), true));
END;
$function$;
ALTER FUNCTION public.preview_move_product_size(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_move_product_size(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_move_product_size(uuid, uuid) TO authenticated;

CREATE FUNCTION public.move_product_size(p_product_id uuid, p_to_parent_id uuid, p_expected_from_version bigint,
  p_expected_to_version bigint, p_expected_size_fingerprint text, p_reason text, p_evidence text,
  p_expected_prices jsonb, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_receipt jsonb;
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'product_id', p_product_id, 'to_parent_id', p_to_parent_id,
    'from_version', p_expected_from_version, 'to_version', p_expected_to_version,
    'size_fingerprint', p_expected_size_fingerprint, 'reason', btrim(p_reason), 'evidence', btrim(p_evidence),
    'expected_prices', p_expected_prices)::text);
  v_tier text;
  v_existing jsonb;
  v_reason text;
  v_evidence text;
  v_from uuid;
  v_refusal text;
  v_event bigint;
  v_copy jsonb;
  v_to_version bigint;
  v_from_left integer;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'move_product_size', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', true);
  v_evidence := public._product_parent_reason(p_evidence, 'evidence', true);
  IF p_expected_prices IS NULL OR jsonb_typeof(p_expected_prices) <> 'object' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: send the preview''s prices';
  END IF;
  SELECT parent_id INTO v_from FROM public.product_parent_members WHERE product_id = p_product_id;
  IF v_from IS NULL THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_GROUPED: this size has no parent'; END IF;
  -- Both parents in ID order, then the size.
  PERFORM 1 FROM public.product_parents WHERE id IN (v_from, p_to_parent_id) ORDER BY id FOR UPDATE;
  IF (SELECT parent_version FROM public.product_parents WHERE id = v_from) IS DISTINCT FROM p_expected_from_version
     OR (SELECT parent_version FROM public.product_parents WHERE id = p_to_parent_id) IS DISTINCT FROM p_expected_to_version
     OR (SELECT parent_id FROM public.product_parent_members WHERE product_id = p_product_id) IS DISTINCT FROM v_from THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_STALE: a parent changed since the preview; preview again';
  END IF;
  PERFORM 1 FROM public.products WHERE id = p_product_id FOR UPDATE;
  IF public._product_size_fingerprint(p_product_id) IS DISTINCT FROM p_expected_size_fingerprint THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_SIZE_STALE: the size changed since the preview; preview again';
  END IF;
  v_refusal := public._product_size_move_refusal(p_product_id, p_to_parent_id);
  IF v_refusal IS NOT NULL THEN RAISE EXCEPTION '%', v_refusal; END IF;

  UPDATE public.product_parent_members SET parent_id = p_to_parent_id, updated_at = now() WHERE product_id = p_product_id;
  UPDATE public.product_parents SET parent_version = parent_version + 1, updated_by = v_actor, updated_at = now()
   WHERE id IN (v_from, p_to_parent_id);
  SELECT count(*) INTO v_from_left FROM public.product_parent_members WHERE parent_id = v_from;
  -- A parent left with no sizes is kept, inactive.
  IF v_from_left = 0 THEN UPDATE public.product_parents SET is_active = false WHERE id = v_from; END IF;
  v_event := public._next_product_parent_event_id();
  -- A size with no EPA number takes the new parent's, as an added size does.
  v_copy := public._copy_parent_to_size(p_to_parent_id, p_product_id, v_event, true, false,
    (SELECT public._normalize_epa_registration(p.epa_registration) IS NULL AND pp.generic_epa_registration IS NOT NULL
       FROM public.products p, public.product_parents pp WHERE p.id = p_product_id AND pp.id = p_to_parent_id));
  -- A unit conversion changed since the preview moves the prices but no version or fingerprint.
  FOREACH v_tier IN ARRAY ARRAY['tier1_price_per_acre', 'tier2_price_per_acre', 'tier3_price_per_acre'] LOOP
    IF NOT (p_expected_prices ? v_tier) OR (v_copy->'after'->v_tier) IS DISTINCT FROM (p_expected_prices->v_tier) THEN
      RAISE EXCEPTION 'PRODUCT_RATE_PREVIEW_CHANGED: the per-acre prices changed since the preview; preview again: %',
        v_copy->'after'->>'product_name' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  PERFORM public._product_parent_event(v_event, p_to_parent_id, 'size_moved', v_reason, v_evidence,
    jsonb_build_object('from_parent_id', v_from), jsonb_build_object('to_parent_id', p_to_parent_id), jsonb_build_array(v_copy));
  -- The old parent's log records the move too.
  PERFORM public._product_parent_event(NULL, v_from, 'size_moved', v_reason, v_evidence,
    jsonb_build_object('from_parent_id', v_from, 'product_id', p_product_id, 'is_active', true),
    jsonb_build_object('to_parent_id', p_to_parent_id, 'is_active', v_from_left > 0),
    jsonb_build_array(v_copy));
  SELECT parent_version INTO v_to_version FROM public.product_parents WHERE id = p_to_parent_id;
  v_receipt := jsonb_build_object('product_id', p_product_id, 'from_parent_id', v_from, 'to_parent_id', p_to_parent_id,
      'to_parent_version', v_to_version, 'from_parent_inactive', v_from_left = 0, 'event_id', v_event, 'size', v_copy);
  PERFORM public.save_idempotency(p_idempotency_key, 'move_product_size',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.move_product_size(uuid, uuid, bigint, bigint, text, text, text, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.move_product_size(uuid, uuid, bigint, bigint, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.move_product_size(uuid, uuid, bigint, bigint, text, text, text, jsonb, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Identity correction (DECISION_LOG 2026-10-30)
-- ---------------------------------------------------------------------------------------------

-- Checks p_changes; returns the parent's identity after the change. The EPA number is switched off
-- until the old-record readers are traced (REG-1, build sheet §7.7), whose migration re-issues this.
CREATE FUNCTION public._product_parent_identity_after(p_parent public.product_parents, p_changes jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $function$
BEGIN
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN ('formulation_type', 'safener', 'generic_epa_registration'))
     OR EXISTS (SELECT 1 FROM jsonb_each(p_changes) e WHERE jsonb_typeof(e.value) NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: the identity correction takes formulation_type, safener and generic_epa_registration';
  END IF;
  IF p_changes ? 'generic_epa_registration'
     AND public._normalize_epa_registration(p_changes->>'generic_epa_registration') IS DISTINCT FROM p_parent.generic_epa_registration THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_EPA_CORRECTION_OFF: EPA number correction is switched off until registrations (REG-1) are built';
  END IF;
  RETURN jsonb_build_object(
    'formulation_type', CASE WHEN p_changes ? 'formulation_type' THEN NULLIF(btrim(p_changes->>'formulation_type'), '') ELSE p_parent.formulation_type END,
    'safener', CASE WHEN p_changes ? 'safener' THEN NULLIF(btrim(p_changes->>'safener'), '') ELSE p_parent.safener END,
    'generic_epa_registration', p_parent.generic_epa_registration);
END;
$function$;
ALTER FUNCTION public._product_parent_identity_after(public.product_parents, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_identity_after(public.product_parents, jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.preview_product_parent_identity_correction(p_parent_id uuid, p_changes jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent public.product_parents%ROWTYPE;
BEGIN
  PERFORM public._product_parent_require_admin();
  SELECT * INTO v_parent FROM public.product_parents WHERE id = p_parent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  RETURN jsonb_build_object('parent_id', p_parent_id, 'parent_version', v_parent.parent_version,
    'before', jsonb_build_object('formulation_type', v_parent.formulation_type, 'safener', v_parent.safener,
      'generic_epa_registration', v_parent.generic_epa_registration),
    'after', public._product_parent_identity_after(v_parent, p_changes),
    'sizes', COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', p.id, 'product_name', p.product_name,
                 'epa_registration', p.epa_registration) ORDER BY p.id)
               FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
              WHERE m.parent_id = p_parent_id), '[]'::jsonb));
END;
$function$;
ALTER FUNCTION public.preview_product_parent_identity_correction(uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_product_parent_identity_correction(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_product_parent_identity_correction(uuid, jsonb) TO authenticated;

CREATE FUNCTION public.correct_product_parent_identity(p_parent_id uuid, p_expected_parent_version bigint,
  p_changes jsonb, p_reason text, p_evidence text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_receipt jsonb;
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'parent_id', p_parent_id,
    'expected_parent_version', p_expected_parent_version, 'changes', p_changes,
    'reason', btrim(p_reason), 'evidence', btrim(p_evidence))::text);
  v_existing jsonb;
  v_reason text;
  v_evidence text;
  v_before public.product_parents%ROWTYPE;
  v_parent public.product_parents%ROWTYPE;
  v_after jsonb;
  v_event bigint;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'correct_product_parent_identity', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', true);
  v_evidence := public._product_parent_reason(p_evidence, 'evidence', true);
  PERFORM public._lock_product_parent(p_parent_id, p_expected_parent_version);
  SELECT * INTO v_before FROM public.product_parents WHERE id = p_parent_id;
  v_after := public._product_parent_identity_after(v_before, p_changes);
  IF v_after->>'formulation_type' IS NOT DISTINCT FROM v_before.formulation_type
     AND v_after->>'safener' IS NOT DISTINCT FROM v_before.safener THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_NO_CHANGE: the correction matches the current values';
  END IF;
  UPDATE public.product_parents SET formulation_type = v_after->>'formulation_type', safener = v_after->>'safener',
    parent_version = parent_version + 1, updated_by = v_actor, updated_at = now()
  WHERE id = p_parent_id RETURNING * INTO v_parent;
  v_event := public._product_parent_event(NULL, p_parent_id, 'identity_corrected', v_reason, v_evidence,
    public._product_parent_values(v_before), public._product_parent_values(v_parent), NULL);
  v_receipt := jsonb_build_object('parent_id', p_parent_id, 'parent_version', v_parent.parent_version, 'event_id', v_event);
  PERFORM public.save_idempotency(p_idempotency_key, 'correct_product_parent_identity',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.correct_product_parent_identity(uuid, bigint, jsonb, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.correct_product_parent_identity(uuid, bigint, jsonb, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.correct_product_parent_identity(uuid, bigint, jsonb, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Reads (any active user; no cost or price)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public._product_parent_read(p_parent_ids uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(jsonb_agg(public._product_parent_values(pp) || jsonb_build_object('id', pp.id,
      'sizes', COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', p.id, 'product_name', p.product_name,
                  'sku', p.sku, 'size_role', m.size_role, 'fill_source_product_id', m.fill_source_product_id,
                  'is_active', p.is_active) ORDER BY lower(p.product_name), p.id)
                FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
               WHERE m.parent_id = pp.id), '[]'::jsonb))
    ORDER BY lower(pp.name), pp.id), '[]'::jsonb)
  FROM public.product_parents pp WHERE pp.id = ANY(p_parent_ids);
$function$;
ALTER FUNCTION public._product_parent_read(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_read(uuid[]) FROM PUBLIC, anon, authenticated, service_role;

-- The parents of the given products (all parents when NULL), each with its sizes.
CREATE FUNCTION public.get_product_parents(p_product_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_profile() THEN RAISE EXCEPTION 'ACTIVE_USER_REQUIRED'; END IF;
  IF cardinality(p_product_ids) > 5000 THEN RAISE EXCEPTION 'PRODUCT_PARENT_TOO_MANY: ask for at most 5000 products'; END IF;
  RETURN public._product_parent_read(ARRAY(
    SELECT pp.id FROM public.product_parents pp
     WHERE p_product_ids IS NULL
        OR pp.id IN (SELECT m.parent_id FROM public.product_parent_members m WHERE m.product_id = ANY(p_product_ids))));
END;
$function$;
ALTER FUNCTION public.get_product_parents(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_product_parents(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_product_parents(uuid[]) TO authenticated;

-- Parents whose name or nickname contains the text (case ignored; no wildcards), each with its sizes.
CREATE FUNCTION public.search_product_parents(p_text text, p_active_only boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_profile() THEN RAISE EXCEPTION 'ACTIVE_USER_REQUIRED'; END IF;
  IF p_text IS NULL OR btrim(p_text) = '' THEN RETURN '[]'::jsonb; END IF;
  RETURN public._product_parent_read(ARRAY(
    SELECT pp.id FROM public.product_parents pp
     WHERE (NOT COALESCE(p_active_only, true) OR pp.is_active)
       AND (strpos(lower(pp.name), lower(btrim(p_text))) > 0
            OR strpos(lower(COALESCE(pp.nickname, '')), lower(btrim(p_text))) > 0)
     ORDER BY lower(pp.name) LIMIT 50));
END;
$function$;
ALTER FUNCTION public.search_product_parents(text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.search_product_parents(text, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_product_parents(text, boolean) TO authenticated;

DO $postflight$
DECLARE
  v_order text[];
BEGIN
  SELECT array_agg(tgname::text ORDER BY tgname::text) INTO v_order FROM pg_trigger
   WHERE tgrelid = 'public.products'::regclass AND NOT tgisinternal
     AND tgname IN ('trg_a_share_product_rate_lock', 'trg_b_guard_product_parent_timings', 'trg_normalize_product_category',
                    'trg_sync_product_use_timings', 'trigger_zz_guard_product_parent_values', 'trigger_zzz_guard_product_rate_lock');
  IF v_order IS DISTINCT FROM ARRAY['trg_a_share_product_rate_lock', 'trg_b_guard_product_parent_timings',
       'trg_normalize_product_category', 'trg_sync_product_use_timings', 'trigger_zz_guard_product_parent_values',
       'trigger_zzz_guard_product_rate_lock'] THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_TRIGGER_ORDER_WRONG: %', v_order;
  END IF;
  IF has_table_privilege('authenticated', 'public.product_parent_copy_passes', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon', 'public.product_parents', 'SELECT')
     OR has_table_privilege('authenticated', 'public.product_parents', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.product_parent_members', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.product_parent_events', 'INSERT,UPDATE,DELETE')
     OR has_function_privilege('authenticated', 'public._copy_parent_to_size(uuid,uuid,bigint,boolean,boolean,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._apply_parent_rates(uuid,bigint,numeric,text,text,jsonb,boolean,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.create_product_with_parent(jsonb,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_product_parents(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_product_with_parent(jsonb,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.search_product_parents(text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_GRANTS_WRONG';
  END IF;
END;
$postflight$;
