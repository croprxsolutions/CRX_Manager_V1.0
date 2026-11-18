-- idempotency-body-check: exempt
-- (commit_parent_rate_cutover checks its retry key through _product_parent_replay, which calls check_idempotency,
--  and saves its receipt with save_idempotency last, in the same transaction, as correct_parent_rates does.)
--
-- RT-4a: switch a product parent from its old (legacy) rate to the rate Mason approved in RT-3, one parent per
-- call, with a one-step way back. Contract: docs/plans/2026-11-17-product-RT4-cutover-CONTRACT.md.
--
-- * product_parents.rate_source ('legacy' | 'approved') and rate_source_event_id (the rates_promoted event holding
--   the snapshot of the old values). Every parent starts 'legacy'; readers keep reading products.rate_per_acre /
--   rate_unit, which this writes through the existing PAR-1 path (_apply_parent_rates -> _copy_parent_to_size).
-- * preview_parent_rate_cutover / commit_parent_rate_cutover, admin only.
-- * An approved parent is frozen until it is switched back: its rate columns (trigger on product_parents), its
--   RT-3 rows and outcome (triggers on product_rates / product_parent_rate_outcomes). Sizes already follow their
--   parent (guard_product_parent_values), and the rate lock cannot be turned off while any parent is approved.
-- Nothing on live changes when this applies: no parent is switched until an admin calls commit.

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  PERFORM 'public._lock_product_parent(uuid,bigint)'::regprocedure,
    'public._apply_parent_rates(uuid,bigint,numeric,text,text,jsonb,boolean,text)'::regprocedure,
    'public.preview_parent_rates(uuid,numeric,text,text)'::regprocedure,
    'public.preview_product_rate_correction(uuid,numeric,text)'::regprocedure,
    'public._product_parent_event(bigint,uuid,text,text,text,jsonb,jsonb,jsonb)'::regprocedure,
    'public._product_parent_replay(text,text,text)'::regprocedure,
    'public._product_parent_reason(text,text,boolean)'::regprocedure,
    'public._product_parent_require_admin()'::regprocedure,
    'public._product_parent_values(public.product_parents)'::regprocedure,
    'public._product_rate_value_ok(jsonb)'::regprocedure,
    'public.save_idempotency(text,text,jsonb)'::regprocedure;
  -- The event-type list this file replaces (read live, 2026-11-17); anything else stops the file.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conname = 'product_parent_events_event_type_check' AND conrelid = 'public.product_parent_events'::regclass)
     IS DISTINCT FROM 'CHECK ((event_type = ANY (ARRAY[''created''::text, ''updated''::text, ''size_added''::text, ''size_moved''::text, ''identity_corrected''::text, ''rates_set''::text, ''rates_corrected''::text])))' THEN
    RAISE EXCEPTION 'PREFLIGHT_RATE_CUTOVER_EVENT_TYPES_CHANGED';
  END IF;
  -- Hold list (Mason, 2026-11-17: "Keep both on today's values"): each ID must still name its Piksi parent, and no
  -- other parent may carry that name. A database without either (staging's test data) passes.
  IF EXISTS (SELECT 1 FROM (VALUES ('afdae5f9-3410-4f17-975b-07a1650089ae'::uuid, 'Piksi Dust Plus'),
                                   ('c9933638-612a-407a-a4a8-6422b5e38c9c'::uuid, 'Piksi Dust Infurrow')) h(id, name)
               JOIN public.product_parents p ON (p.id = h.id) <> (p.name = h.name)) THEN
    RAISE EXCEPTION 'PREFLIGHT_RATE_CUTOVER_HOLD_LIST_CHANGED: a held Piksi parent moved or was renamed';
  END IF;
END;
$preflight$;

ALTER TABLE public.product_parents
  ADD COLUMN rate_source text NOT NULL DEFAULT 'legacy'
    CONSTRAINT product_parents_rate_source_check CHECK (rate_source IN ('legacy', 'approved')),
  ADD COLUMN rate_source_event_id bigint
    CONSTRAINT product_parents_rate_source_event_fk REFERENCES public.product_parent_events(id) ON DELETE RESTRICT,
  ADD CONSTRAINT product_parents_rate_source_event_pair
    CHECK ((rate_source = 'approved') = (rate_source_event_id IS NOT NULL));
COMMENT ON COLUMN public.product_parents.rate_source IS
  'RT-4a: legacy = the rate from before RT-3; approved = the RT-3 approved rate, switched by commit_parent_rate_cutover.';
COMMENT ON COLUMN public.product_parents.rate_source_event_id IS
  'RT-4a: the rates_promoted event holding the old values a switch back restores; NULL while legacy.';

ALTER TABLE public.product_parent_events DROP CONSTRAINT product_parent_events_event_type_check;
ALTER TABLE public.product_parent_events ADD CONSTRAINT product_parent_events_event_type_check
  CHECK (event_type IN ('created', 'updated', 'size_added', 'size_moved', 'identity_corrected', 'rates_set',
                        'rates_corrected', 'rates_promoted', 'rates_restored'));

CREATE TABLE public.product_rate_cutover_passes (
  txid bigint NOT NULL,
  parent_id uuid NOT NULL,
  PRIMARY KEY (txid, parent_id)
);
ALTER TABLE public.product_rate_cutover_passes OWNER TO postgres;
COMMENT ON TABLE public.product_rate_cutover_passes IS
  'Internal: the rate switch in progress, one row for the life of its transaction. Only commit_parent_rate_cutover writes it.';
ALTER TABLE public.product_rate_cutover_passes ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_rate_cutover_passes_none ON public.product_rate_cutover_passes
  FOR ALL TO authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.product_rate_cutover_passes FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- An approved parent's rate, unit, suggested text and form, and any parent's rate source, change only inside
-- commit_parent_rate_cutover. correct_parent_rates and set_parent_rates on an approved parent are refused here.
CREATE FUNCTION public.guard_product_parent_rate_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.rate_source IS DISTINCT FROM 'legacy' OR NEW.rate_source_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_RATE_SOURCE_NEW: a new parent starts on its own rate' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.rate_source IS DISTINCT FROM OLD.rate_source
      OR NEW.rate_source_event_id IS DISTINCT FROM OLD.rate_source_event_id
      OR (OLD.rate_source = 'approved'
          AND (NEW.rate_per_acre IS DISTINCT FROM OLD.rate_per_acre OR NEW.rate_unit IS DISTINCT FROM OLD.rate_unit
               OR NEW.suggested_rate IS DISTINCT FROM OLD.suggested_rate OR NEW.product_form IS DISTINCT FROM OLD.product_form)))
     AND NOT EXISTS (SELECT 1 FROM public.product_rate_cutover_passes c
                      WHERE c.txid = txid_current() AND c.parent_id = OLD.id) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_RATE_APPROVED: "%" uses its approved rate; switch it back to the old rate first', OLD.name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_product_parent_rate_source() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_product_parent_rate_source() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_guard_product_parent_rate_source BEFORE INSERT OR UPDATE ON public.product_parents
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_parent_rate_source();

-- RT-3 rows and outcome of an approved parent are frozen (drafts, saves, deletes, reopen, outcome changes, derive).
CREATE FUNCTION public.guard_product_rate_review_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_ids uuid[] := CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.parent_id] WHEN 'DELETE' THEN ARRAY[OLD.parent_id]
                                ELSE ARRAY[OLD.parent_id, NEW.parent_id] END;
  v_name text;
BEGIN
  -- Wait for a switch in progress on the parent, then read its committed source (a fresh statement snapshot).
  PERFORM 1 FROM public.product_parents WHERE id = ANY(v_ids) ORDER BY id FOR SHARE;
  SELECT name INTO v_name FROM public.product_parents WHERE id = ANY(v_ids) AND rate_source = 'approved' ORDER BY id LIMIT 1;
  IF v_name IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_RATE_APPROVED: "%" uses its approved rate; switch it back to the old rate first', v_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
ALTER FUNCTION public.guard_product_rate_review_source() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_product_rate_review_source() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_product_rates_guard_rate_source BEFORE INSERT OR UPDATE OR DELETE ON public.product_rates
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_rate_review_source();
CREATE TRIGGER trg_product_parent_rate_outcomes_guard_rate_source BEFORE INSERT OR UPDATE OR DELETE
  ON public.product_parent_rate_outcomes FOR EACH ROW EXECUTE FUNCTION public.guard_product_rate_review_source();

-- A size cannot move into or out of an approved parent: an emptied parent could not switch back (and rates could
-- not unlock), and a size moved in would take the old rate on a switch back. New sizes still join (they copy).
CREATE FUNCTION public.guard_product_parent_member_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_ids uuid[] := CASE TG_OP WHEN 'DELETE' THEN ARRAY[OLD.parent_id] ELSE ARRAY[OLD.parent_id, NEW.parent_id] END;
  v_name text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.product_parents WHERE id = ANY(v_ids) ORDER BY id FOR SHARE;
  SELECT name INTO v_name FROM public.product_parents WHERE id = ANY(v_ids) AND rate_source = 'approved' ORDER BY id LIMIT 1;
  IF v_name IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_RATE_APPROVED: "%" uses its approved rate; switch it back to the old rate before moving sizes', v_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
ALTER FUNCTION public.guard_product_parent_member_source() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_product_parent_member_source() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_product_parent_members_guard_rate_source BEFORE UPDATE OF parent_id OR DELETE
  ON public.product_parent_members FOR EACH ROW EXECUTE FUNCTION public.guard_product_parent_member_source();

-- While an approved parent's unit differs from its old one, no blend recipe line and no blank-unit blend ticket line
-- may start using one of its sizes: those lines re-read the product's unit, so a switch back (and so a rate unlock)
-- would be refused. Ordering: _rate_cutover_plan holds SHARE on both blend tables until commit, so a blend write
-- either finishes first (and the switch sees it) or waits and then reads the committed source here.
CREATE FUNCTION public.guard_blend_line_rate_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_name text;
BEGIN
  IF TG_TABLE_NAME = 'blend_recipe_items' THEN
    IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.recipe_id IS NOT DISTINCT FROM OLD.recipe_id THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NULLIF(btrim(NEW.rate_per_acre_unit), '') IS NOT NULL
       OR (TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
           AND NULLIF(btrim(OLD.rate_per_acre_unit), '') IS NULL) THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT pp.name INTO v_name
    FROM public.product_parent_members m
    JOIN public.product_parents pp ON pp.id = m.parent_id AND pp.rate_source = 'approved'
    JOIN public.product_parent_events e ON e.id = pp.rate_source_event_id
   WHERE m.product_id = NEW.product_id
     AND NULLIF(btrim(e.after_values->'legacy'->>'rate_unit'), '') IS DISTINCT FROM NULLIF(btrim(pp.rate_unit), '');
  IF v_name IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_RATE_APPROVED_BLEND: "%" uses its approved rate in a new unit; give the blend line its own rate unit or switch "%" back first',
      v_name, v_name USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_blend_line_rate_source() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_blend_line_rate_source() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_blend_recipe_items_guard_rate_source BEFORE INSERT OR UPDATE OF product_id, recipe_id
  ON public.blend_recipe_items FOR EACH ROW EXECUTE FUNCTION public.guard_blend_line_rate_source();
CREATE TRIGGER trg_blend_ticket_products_guard_rate_source BEFORE INSERT OR UPDATE OF product_id, rate_per_acre_unit
  ON public.blend_ticket_products FOR EACH ROW EXECUTE FUNCTION public.guard_blend_line_rate_source();

-- Mason, 2026-11-17 (decision 3): rates stay locked while any parent uses its approved rate.
CREATE FUNCTION public.guard_product_rate_unlock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_count bigint;
BEGIN
  IF OLD.is_locked AND NOT NEW.is_locked THEN
    SELECT count(*) INTO v_count FROM public.product_parents WHERE rate_source = 'approved';
    IF v_count > 0 THEN
      RAISE EXCEPTION 'PRODUCT_RATES_APPROVED_PARENTS: % parents use their approved rate; switch them back before unlocking rates', v_count
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_product_rate_unlock() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_product_rate_unlock() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_product_rate_lock_guard_unlock BEFORE UPDATE ON public.product_rate_lock
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_rate_unlock();

-- Locks, checks and the target for one parent. Raises a PRODUCT_PARENT_CUTOVER_* refusal; returns the plan,
-- whose "expected" object commit must receive back unchanged.
CREATE FUNCTION public._rate_cutover_plan(p_parent_id uuid, p_direction text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_locked boolean;
  v_version bigint;
  v_sizes uuid[];
  v_parent public.product_parents%ROWTYPE;
  v_outcome public.product_parent_rate_outcomes%ROWTYPE;
  v_rate public.product_rates%ROWTYPE;
  v_spellings text[];
  v_event public.product_parent_events%ROWTYPE;
  v_cur_unit text;
  v_target_rate numeric;
  v_target_unit text;
  v_target_text text;
  v_changes boolean;
  v_expected jsonb;
  v_approved jsonb;
  v_preview jsonb;
BEGIN
  IF p_direction IS NULL OR p_direction NOT IN ('promote', 'restore') THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_DIRECTION: say promote or restore';
  END IF;
  -- 1. The lock row, held to commit so an unlock waits. 2. Parent, then sizes. 3. RT-3 rows. 4. Checks.
  SELECT is_locked INTO v_locked FROM public.product_rate_lock WHERE id FOR SHARE;
  IF v_locked IS NOT TRUE THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_LOCK_OFF: turn the rate lock on first';
  END IF;
  -- Blend lines re-read a size's unit, so no blend line may be added or edited (a unit blanked) while the
  -- check below runs and until commit. Taken before the size locks, the order blend writers use.
  LOCK TABLE public.blend_recipe_items, public.blend_ticket_products IN SHARE MODE;
  SELECT parent_version INTO v_version FROM public.product_parents WHERE id = p_parent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  v_sizes := public._lock_product_parent(p_parent_id, v_version);
  SELECT * INTO v_parent FROM public.product_parents WHERE id = p_parent_id;
  PERFORM 1 FROM public.product_rates WHERE parent_id = p_parent_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_outcome FROM public.product_parent_rate_outcomes WHERE parent_id = p_parent_id FOR UPDATE;
  v_cur_unit := NULLIF(btrim(v_parent.rate_unit), '');

  IF cardinality(v_sizes) = 0 THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_NO_SIZES: "%" has no sizes', v_parent.name;
  END IF;
  -- Only rate fields may move, and the copy also writes category and timings: every size must already match.
  IF EXISTS (SELECT 1 FROM public.products p WHERE p.id = ANY(v_sizes) AND (
       p.rate_per_acre IS DISTINCT FROM v_parent.rate_per_acre
       OR NULLIF(btrim(p.suggested_rate), '') IS DISTINCT FROM NULLIF(btrim(v_parent.suggested_rate), '')
       OR p.category IS DISTINCT FROM v_parent.category
       OR p.use_timings IS DISTINCT FROM v_parent.use_timings
       OR CASE WHEN p.product_form IN ('seed', 'each')
               THEN lower(NULLIF(btrim(p.rate_unit), '')) IS DISTINCT FROM lower(NULLIF(btrim(p.inventory_unit), ''))
               ELSE NULLIF(btrim(p.rate_unit), '') IS DISTINCT FROM v_cur_unit END)) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_SIZES_DIFFER: a size of "%" differs from the parent on rate, unit, suggested rate, category or timings; fix that first',
      v_parent.name;
  END IF;

  IF p_direction = 'promote' THEN
    IF v_parent.rate_source <> 'legacy' THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_ALREADY_APPROVED: "%" already uses its approved rate', v_parent.name;
    END IF;
    IF NOT v_parent.is_active THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_INACTIVE: "%" is inactive', v_parent.name;
    END IF;
    IF p_parent_id IN ('afdae5f9-3410-4f17-975b-07a1650089ae'::uuid, 'c9933638-612a-407a-a4a8-6422b5e38c9c'::uuid) THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_HELD: "%" stays on today''s rate (Mason, 2026-11-17)', v_parent.name;
    END IF;
    IF EXISTS (SELECT 1 FROM public.product_rates WHERE parent_id = p_parent_id AND status <> 'approved') THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_DRAFTS: "%" still has draft rates', v_parent.name;
    END IF;
    IF v_outcome.outcome = 'approved_default' THEN
      IF v_parent.product_form IN ('seed', 'each') THEN
        RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_FORM: "%" is seed or each; an approved per-acre default for it is not supported yet', v_parent.name;
      END IF;
      IF (SELECT count(*) FROM public.product_rates WHERE parent_id = p_parent_id AND is_quoting_default) <> 1 THEN
        RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_DEFAULT_INVALID: "%" needs exactly one approved quoting default', v_parent.name;
      END IF;
      SELECT * INTO v_rate FROM public.product_rates WHERE parent_id = p_parent_id AND is_quoting_default;
      IF v_rate.basis <> 'per_acre' OR NOT v_rate.basis_confirmed OR v_rate.recommended IS NULL OR v_rate.recommended <= 0
         OR NOT public._product_rate_value_ok(to_jsonb(v_rate.recommended::text)) THEN
        RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_DEFAULT_INVALID: "%" needs a confirmed per-acre default above zero', v_parent.name;
      END IF;
      SELECT legacy_spellings INTO v_spellings FROM public.product_rate_units WHERE code = v_rate.unit;
      v_target_rate := v_rate.recommended;
      -- Keep the parent's own spelling when it is one of the unit's; otherwise the unit's first spelling (lb -> Lb).
      v_target_unit := CASE WHEN v_cur_unit = ANY(v_spellings) THEN v_cur_unit ELSE v_spellings[1] END;
      IF v_target_unit IS NULL THEN
        RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_DEFAULT_INVALID: unit % of "%" has no spelling', v_rate.unit, v_parent.name;
      END IF;
      v_expected := jsonb_build_object('parent_version', v_parent.parent_version, 'outcome_version', v_outcome.outcome_version,
        'rate_id', v_rate.id, 'rate_row_version', v_rate.row_version);
      v_approved := jsonb_build_object('rate_id', v_rate.id, 'row_version', v_rate.row_version, 'outcome', v_outcome.outcome,
        'outcome_version', v_outcome.outcome_version, 'recommended', v_rate.recommended::text, 'unit_code', v_rate.unit,
        'written_unit', v_target_unit);
    ELSIF v_outcome.outcome = 'no_per_acre_default' THEN
      IF EXISTS (SELECT 1 FROM public.product_rates WHERE parent_id = p_parent_id AND is_quoting_default) THEN
        RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_DEFAULT_INVALID: "%" is marked no per-acre default but has one', v_parent.name;
      END IF;
      v_target_rate := NULL;
      v_target_unit := NULL;
      v_expected := jsonb_build_object('parent_version', v_parent.parent_version, 'outcome_version', v_outcome.outcome_version,
        'rates', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'row_version', r.row_version) ORDER BY r.id)
                             FROM public.product_rates r WHERE r.parent_id = p_parent_id), '[]'::jsonb));
      v_approved := jsonb_build_object('rate_id', NULL, 'row_version', NULL, 'outcome', v_outcome.outcome,
        'outcome_version', v_outcome.outcome_version, 'recommended', NULL, 'unit_code', NULL, 'written_unit', NULL);
    ELSE
      RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_NOT_DECIDED: "%" has no approved rate decision (%)', v_parent.name,
        COALESCE(v_outcome.outcome, 'undecided');
    END IF;
  ELSE
    IF v_parent.rate_source <> 'approved' THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_ALREADY_LEGACY: "%" already uses its old rate', v_parent.name;
    END IF;
    SELECT * INTO v_event FROM public.product_parent_events WHERE id = v_parent.rate_source_event_id;
    IF v_event.event_type IS DISTINCT FROM 'rates_promoted' OR v_event.parent_id IS DISTINCT FROM p_parent_id
       OR v_event.after_values->>'v' IS DISTINCT FROM '1' OR jsonb_typeof(v_event.after_values->'legacy') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_SNAPSHOT_MISSING: the old values of "%" cannot be read', v_parent.name;
    END IF;
    v_target_rate := (v_event.after_values->'legacy'->>'rate_per_acre')::numeric;
    v_target_unit := NULLIF(btrim(v_event.after_values->'legacy'->>'rate_unit'), '');
    v_target_text := v_event.after_values->'legacy'->>'suggested_rate';
    v_expected := jsonb_build_object('parent_version', v_parent.parent_version, 'event_id', v_event.id);
  END IF;
  IF v_parent.product_form IN ('seed', 'each') THEN v_target_unit := NULL; END IF;
  -- Suggested text (Mason, 2026-11-18, "Rewrite from approved"): a promote that moves the rate or unit rewrites it
  -- from the approved row (blank with no per-acre default); restore puts the snapshot's text back.
  IF p_direction = 'promote' THEN
    v_target_text := CASE
      WHEN v_target_rate IS NOT DISTINCT FROM v_parent.rate_per_acre AND v_target_unit IS NOT DISTINCT FROM v_cur_unit
        THEN v_parent.suggested_rate
      WHEN v_target_rate IS NULL THEN NULL
      ELSE trim_scale(v_target_rate)::text || ' ' || v_target_unit || '/acre' END;
  END IF;

  -- Blend recipes and blank-unit blend lines re-read the product's current unit; a unit change under them is refused.
  -- A switch back skips lines of deleted recipes (the app soft-deletes); a promote counts them, since an undelete
  -- would bring them back under the new unit.
  IF v_target_unit IS DISTINCT FROM v_cur_unit
     AND (EXISTS (SELECT 1 FROM public.blend_recipe_items i JOIN public.blend_recipes br ON br.id = i.recipe_id
                   WHERE i.product_id = ANY(v_sizes) AND (p_direction = 'promote' OR br.deleted_at IS NULL))
          OR EXISTS (SELECT 1 FROM public.blend_ticket_products b WHERE b.product_id = ANY(v_sizes)
                       AND NULLIF(btrim(b.rate_per_acre_unit), '') IS NULL)) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_BLEND_UNIT: a blend recipe or blend ticket line uses "%" without its own unit; the unit cannot change',
      v_parent.name;
  END IF;

  v_changes := v_target_rate IS DISTINCT FROM v_parent.rate_per_acre OR v_target_unit IS DISTINCT FROM v_cur_unit
    OR NULLIF(btrim(v_target_text), '') IS DISTINCT FROM NULLIF(btrim(v_parent.suggested_rate), '');
  -- Each size's snapshot and its per-acre prices at the target, in the shape _apply_parent_rates checks. An old
  -- unit that no longer passes for a size refuses here (PRODUCT_RATE_UNIT_INVALID) and the parent stays as it is.
  v_preview := public.preview_parent_rates(p_parent_id, v_target_rate, v_target_unit, v_target_text);
  v_expected := v_expected || jsonb_build_object('sizes', v_preview->'sizes');
  -- An unchanged promote writes no prices, so every size's saved per-acre prices must already be right. (Restore
  -- is not refused here: switching back must stay possible.)
  IF p_direction = 'promote' AND NOT v_changes
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_preview->'sizes') s WHERE s->'prices' IS DISTINCT FROM s->'before_prices') THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_PRICES_STALE: a size of "%" has saved per-acre prices that do not match its rate; correct them first',
      v_parent.name;
  END IF;

  RETURN jsonb_build_object('parent_id', p_parent_id, 'name', v_parent.name, 'direction', p_direction,
    'rate_source', v_parent.rate_source, 'outcome', v_outcome.outcome, 'changes', v_changes,
    'current', jsonb_build_object('rate_per_acre', v_parent.rate_per_acre::text, 'rate_unit', v_parent.rate_unit),
    'target', jsonb_build_object('rate_per_acre', v_target_rate::text, 'rate_unit', v_target_unit,
                                 'suggested_rate', v_target_text),
    'expected', v_expected,
    'snapshot', CASE WHEN p_direction = 'promote' THEN jsonb_build_object('v', 1,
      'legacy', jsonb_build_object('rate_per_acre', v_parent.rate_per_acre::text, 'rate_unit', v_parent.rate_unit,
                                   'suggested_rate', v_parent.suggested_rate),
      'sizes', (SELECT jsonb_agg(jsonb_build_object('product_id', p.id, 'rate_per_acre', p.rate_per_acre::text,
                                                    'rate_unit', p.rate_unit, 'suggested_rate', p.suggested_rate) ORDER BY p.id)
                  FROM public.products p WHERE p.id = ANY(v_sizes)),
      'approved', v_approved) END);
END;
$function$;
ALTER FUNCTION public._rate_cutover_plan(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._rate_cutover_plan(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- Advisory: what commit would do, or why it is refused. Takes the same row locks for the length of the call.
CREATE FUNCTION public.preview_parent_rate_cutover(p_parent_id uuid, p_direction text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_plan jsonb;
BEGIN
  PERFORM public._product_parent_require_admin();
  BEGIN
    v_plan := public._rate_cutover_plan(p_parent_id, p_direction);
  EXCEPTION WHEN raise_exception OR check_violation THEN
    RETURN jsonb_build_object('parent_id', p_parent_id, 'direction', p_direction, 'eligible', false, 'refusal', SQLERRM);
  END;
  RETURN v_plan || jsonb_build_object('eligible', true);
END;
$function$;
ALTER FUNCTION public.preview_parent_rate_cutover(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_parent_rate_cutover(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_parent_rate_cutover(uuid, text) TO authenticated;

CREATE FUNCTION public.commit_parent_rate_cutover(p_parent_id uuid, p_direction text, p_expected jsonb, p_reason text,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'parent_id', p_parent_id, 'direction', p_direction,
    'expected', p_expected, 'reason', btrim(p_reason))::text);
  v_existing jsonb;
  v_reason text;
  v_plan jsonb;
  v_before public.product_parents%ROWTYPE;
  v_parent public.product_parents%ROWTYPE;
  v_apply jsonb;
  v_event bigint;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'commit_parent_rate_cutover', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', true);
  v_plan := public._rate_cutover_plan(p_parent_id, p_direction);
  -- Strict: the whole expected object (versions, RT-3 rows, every size's snapshot and prices) must equal today's.
  IF p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object' OR p_expected IS DISTINCT FROM v_plan->'expected' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_CUTOVER_STALE: "%" changed since the preview; preview again', v_plan->>'name';
  END IF;

  INSERT INTO public.product_rate_cutover_passes (txid, parent_id) VALUES (txid_current(), p_parent_id);
  SELECT * INTO v_before FROM public.product_parents WHERE id = p_parent_id;
  IF (v_plan->>'changes')::boolean THEN
    v_apply := public._apply_parent_rates(p_parent_id, v_before.parent_version,
      (v_plan->'target'->>'rate_per_acre')::numeric, v_plan->'target'->>'rate_unit', v_plan->'target'->>'suggested_rate',
      v_plan->'expected'->'sizes', true, v_reason);
  END IF;
  IF p_direction = 'promote' THEN
    v_event := public._product_parent_event(NULL, p_parent_id, 'rates_promoted', v_reason, NULL,
      public._product_parent_values(v_before), v_plan->'snapshot', COALESCE(v_apply->'sizes', '[]'::jsonb));
    UPDATE public.product_parents SET rate_source = 'approved', rate_source_event_id = v_event,
      parent_version = parent_version + 1, updated_by = v_actor, updated_at = now()
    WHERE id = p_parent_id RETURNING * INTO v_parent;
  ELSE
    v_event := public._product_parent_event(NULL, p_parent_id, 'rates_restored', v_reason, NULL,
      public._product_parent_values(v_before),
      jsonb_build_object('v', 1, 'promoted_event_id', v_before.rate_source_event_id, 'restored', v_plan->'target'),
      COALESCE(v_apply->'sizes', '[]'::jsonb));
    UPDATE public.product_parents SET rate_source = 'legacy', rate_source_event_id = NULL,
      parent_version = parent_version + 1, updated_by = v_actor, updated_at = now()
    WHERE id = p_parent_id RETURNING * INTO v_parent;
  END IF;
  DELETE FROM public.product_rate_cutover_passes WHERE txid = txid_current() AND parent_id = p_parent_id;

  v_receipt := jsonb_build_object('parent_id', p_parent_id, 'name', v_parent.name, 'direction', p_direction,
    'rate_source', v_parent.rate_source, 'parent_version', v_parent.parent_version, 'event_id', v_event,
    'changed', (v_plan->>'changes')::boolean, 'rate_per_acre', v_parent.rate_per_acre::text,
    'rate_unit', v_parent.rate_unit, 'sizes', COALESCE(v_apply->'sizes', '[]'::jsonb), 'done_at', now());
  PERFORM public.save_idempotency(p_idempotency_key, 'commit_parent_rate_cutover',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.commit_parent_rate_cutover(uuid, text, jsonb, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.commit_parent_rate_cutover(uuid, text, jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commit_parent_rate_cutover(uuid, text, jsonb, text, text) TO authenticated;

DO $postflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public.product_parents WHERE rate_source <> 'legacy' OR rate_source_event_id IS NOT NULL) THEN
    RAISE EXCEPTION 'POSTFLIGHT_RATE_CUTOVER_NOT_ALL_LEGACY';
  END IF;
  IF has_function_privilege('authenticated', 'public._rate_cutover_plan(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_product_parent_rate_source()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_product_rate_review_source()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_product_rate_unlock()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_product_parent_member_source()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_blend_line_rate_source()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.preview_parent_rate_cutover(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.commit_parent_rate_cutover(uuid,text,jsonb,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.preview_parent_rate_cutover(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.commit_parent_rate_cutover(uuid,text,jsonb,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._rate_cutover_plan(uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._rate_cutover_plan(uuid,text)', 'EXECUTE')
     -- A pass row unfreezes an approved parent, so no API role may touch the table.
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r(role)
                 WHERE has_table_privilege(r.role, 'public.product_rate_cutover_passes', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) THEN
    RAISE EXCEPTION 'POSTFLIGHT_RATE_CUTOVER_GRANTS_WRONG';
  END IF;
END;
$postflight$;
