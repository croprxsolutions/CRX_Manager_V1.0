-- idempotency-body-check: exempt
-- (commit_rate_review checks its retry key through _product_parent_replay, which calls check_idempotency,
--  and saves its receipt with save_idempotency last, in the same transaction. Its row helpers take no key:
--  they have no grant and run only inside commit_rate_review / preview_rate_review.)
-- actor-binding-check: exempt
-- (p_actor on the _product_rate_review_* helpers is not caller-supplied: they have no EXECUTE grant to any
--  role, and their only callers pass v_actor from _product_parent_require_admin(), i.e. auth.uid() of a checked admin.)
--
-- RT-3 · Mason's rate review (grand plan Stage 4; contract docs/plans/2026-11-11-product-RT3-rate-review-CONTRACT.md).
--
-- WHY: RT-1's draft rates (product_rates) become live only in RT-4, and only after an admin has recorded a
--   decision on every row and an outcome on every parent. This adds that review. Nothing in the app reads
--   product_rates yet, so no quote, job, field-app screen or PDF changes.
--
-- WHAT:
--   * product_rate_draft_events.event_type also allows approved, reopened, outcome_set, outcome_cleared.
--   * _product_rates_guard_change (re-issued): an approved row may change only back to draft with every value
--     kept ("reopen"); every other change or delete of an approved row is still refused.
--   * product_parent_rate_outcomes: one decision per parent (approved_default, no_per_acre_default,
--     needs_label_data; NULL = undecided), who and when.
--   * _product_rates_clear_outcome (AFTER trigger on product_rates): any change to a parent's rate rows makes
--     its outcome undecided again and moves its outcome_version, so a recorded outcome always describes the
--     rows as they are now, and an outcome row downloaded before such a change is stale.
--   * trg_product_rates_check_unit (RT-1) now runs only when parent, basis or unit is written, so an approved
--     row whose parent changed form can still be sent back to draft. Both tables refuse a bulk wipe.
--   * get_rate_review_workbook(): the download. preview_rate_review(rates, outcomes): the whole save, always
--     rolled back. commit_rate_review(rates, outcomes, key): all or nothing. Corrections, adds and deletes go
--     through RT-1's save_draft_product_rate / delete_draft_product_rate unchanged.
--
-- RULES (contract R1 to R5):
--   approve: a draft at the expected version, active parent, basis confirmed, unit fits the parent's form and
--     basis, and not above a label maximum without a recorded reason. "Label maximum not checked" may be approved.
--   approved_default: no draft rows on the parent and its one quoting default approved.
--   no_per_acre_default: no draft rows and no quoting default (no rows at all is allowed).
--   Both re-check every approved row against the approval rules as the parent is now.
--   needs_label_data: any rows; the parent is held back.
--   RT-4 promotes only approved_default and no_per_acre_default parents.
--
-- LOCKS: REG-1's advisory pair SHARED, then every touched parent FOR NO KEY UPDATE in ID order, then rate rows
--   (RT-1's order). product_rate_lock is never read: drafts stay editable while it is on (overlap 11).
--
-- NOT CHANGED: every RT-1 RPC and helper except _product_rates_guard_change; products, product_parents,
--   every live rate column and every reader.
--
-- ROLLBACK (its own reviewed migration): drop the three RPCs, the helpers and the clear trigger; restore RT-1's
--   _product_rates_guard_change body (which refuses any change to an approved row); keep the outcomes table and
--   the wider CHECK as history (or set approved rows back to draft first, then narrow it).

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_temp;

CREATE TEMP TABLE product_rate_review_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_missing text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change (RT-1's check).
  IF to_regclass('pg_temp.product_rate_review_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.product_rate_review_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regclass('public.product_parent_rate_outcomes') IS NOT NULL
     OR to_regprocedure('public.get_rate_review_workbook()') IS NOT NULL
     OR to_regprocedure('public.preview_rate_review(jsonb,jsonb)') IS NOT NULL
     OR to_regprocedure('public.commit_rate_review(jsonb,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'RT3_ALREADY_APPLIED';
  END IF;
  SELECT string_agg(f, ', ') INTO v_missing FROM unnest(ARRAY[
    'public._product_parent_require_admin()', 'public._product_parent_replay(text,text,text)',
    'public.save_idempotency(text,text,jsonb)', 'public.is_admin()',
    'public._product_rate_unit_fits(text,text,text)',
    'public._product_rate_check_values(uuid,text,text,text,numeric,numeric,numeric,boolean,text)',
    'public._product_rates_guard_change()',
    'public.save_draft_product_rate(uuid,uuid,bigint,text,text,numeric,numeric,numeric,text,boolean,text,text)',
    'public.delete_draft_product_rate(uuid,bigint,text,text)']) f
   WHERE to_regprocedure(f) IS NULL;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'RT3_DEPENDENCY_MISSING: %', v_missing; END IF;
  IF to_regclass('public.product_rates') IS NULL OR to_regclass('public.product_rate_draft_events') IS NULL
     OR to_regclass('public.product_parent_members') IS NULL THEN
    RAISE EXCEPTION 'RT3_DEPENDENCY_MISSING: RT-1 tables';
  END IF;
  -- RT-1 shipped no approval path, so no row can be approved yet.
  IF EXISTS (SELECT 1 FROM public.product_rates WHERE status <> 'draft') THEN
    RAISE EXCEPTION 'RT3_BASELINE_DRIFT: product_rates already has approved rows';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.product_rate_draft_events'::regclass AND conname = 'product_rate_draft_events_event_type_check')
     IS DISTINCT FROM 'CHECK ((event_type = ANY (ARRAY[''derived''::text, ''derive_note''::text, ''saved''::text, ''deleted''::text])))' THEN
    RAISE EXCEPTION 'RT3_BASELINE_DRIFT: product_rate_draft_events_event_type_check is not RT-1''s';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Event types (superset of RT-1's four)
-- ---------------------------------------------------------------------------------------------

ALTER TABLE public.product_rate_draft_events DROP CONSTRAINT product_rate_draft_events_event_type_check;
ALTER TABLE public.product_rate_draft_events ADD CONSTRAINT product_rate_draft_events_event_type_check
  CHECK (event_type IN ('derived', 'derive_note', 'saved', 'deleted', 'approved', 'reopened', 'outcome_set', 'outcome_cleared'));

-- ---------------------------------------------------------------------------------------------
-- 2. Parent outcomes
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.product_parent_rate_outcomes (
  parent_id uuid PRIMARY KEY REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  -- NULL = undecided (never decided, cleared by an admin, or cleared because the parent's rates changed).
  outcome text CHECK (outcome IN ('approved_default', 'no_per_acre_default', 'needs_label_data')),
  note text CHECK (note IS NULL OR (note = btrim(note) AND note <> '' AND length(note) <= 500)),
  outcome_version bigint NOT NULL DEFAULT 1 CHECK (outcome_version >= 1),
  decided_by uuid,
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_parent_rate_outcomes_decision CHECK (
    (outcome IS NULL AND decided_by IS NULL AND decided_at IS NULL AND note IS NULL)
    OR (outcome IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
ALTER TABLE public.product_parent_rate_outcomes OWNER TO postgres;
COMMENT ON TABLE public.product_parent_rate_outcomes IS
  'RT-3: the rate review outcome of each product parent. Written only by the RT-3 functions and the product_rates clear trigger.';
ALTER TABLE public.product_parent_rate_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_parent_rate_outcomes_admin_select ON public.product_parent_rate_outcomes
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
REVOKE ALL ON TABLE public.product_parent_rate_outcomes FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_parent_rate_outcomes TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Row triggers
-- ---------------------------------------------------------------------------------------------

-- RT-1's body plus RT-3's one pass: approved -> draft with every value kept.
CREATE OR REPLACE FUNCTION public._product_rates_guard_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF OLD.status = 'approved' THEN
    -- Every column except the reopen's own is compared, so a column added later is kept too; the version
    -- must move forward, so an old download can never match again.
    IF TG_OP = 'UPDATE' AND NEW.status = 'draft' AND NEW.row_version > OLD.row_version
       AND to_jsonb(NEW) - ARRAY['status','approved_by','approved_at','row_version','updated_by','updated_at']
           = to_jsonb(OLD) - ARRAY['status','approved_by','approved_at','row_version','updated_by','updated_at'] THEN
      NEW.updated_at := now();
      RETURN NEW;
    END IF;
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

-- Any change to a parent's rate rows makes its outcome undecided and moves its outcome_version, decided or
-- not (contract R4): an outcome row downloaded before someone else changed the parent's rows is then stale,
-- so nobody decides a set of rows they never saw.
CREATE FUNCTION public._product_rates_clear_outcome() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_row public.product_rates%ROWTYPE;
  v_old public.product_parent_rate_outcomes%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
  SELECT * INTO v_old FROM public.product_parent_rate_outcomes WHERE parent_id = v_row.parent_id FOR UPDATE;
  INSERT INTO public.product_parent_rate_outcomes AS o (parent_id) VALUES (v_row.parent_id)
  ON CONFLICT (parent_id) DO UPDATE SET outcome = NULL, note = NULL, decided_by = NULL, decided_at = NULL,
    outcome_version = o.outcome_version + 1, updated_at = now();
  IF v_old.outcome IS NOT NULL THEN
    INSERT INTO public.product_rate_draft_events (parent_id, rate_id, event_type, before_values, reason, changed_by)
    VALUES (v_row.parent_id, v_row.id, 'outcome_cleared', to_jsonb(v_old), 'the parent''s rates changed',
      COALESCE(auth.uid(), v_row.updated_by));
  END IF;
  RETURN NULL;
END;
$function$;
CREATE TRIGGER trg_product_rates_clear_outcome AFTER INSERT OR UPDATE OR DELETE ON public.product_rates
  FOR EACH ROW EXECUTE FUNCTION public._product_rates_clear_outcome();

-- RT-1's unit check ran on every update, so an approved row whose parent later changed form could not even be
-- sent back to draft (and so never corrected or deleted). It now runs when the parent, basis or unit is written;
-- RT-1's save writes both basis and unit, and approval checks the unit itself.
DROP TRIGGER trg_product_rates_check_unit ON public.product_rates;
CREATE TRIGGER trg_product_rates_check_unit BEFORE INSERT OR UPDATE OF parent_id, basis, unit ON public.product_rates
  FOR EACH ROW EXECUTE FUNCTION public._product_rates_check_unit();

-- A TRUNCATE skips row triggers: it would drop approved rows and leave outcomes describing rows that are gone.
CREATE FUNCTION public._product_rate_review_no_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'PRODUCT_RATE_NO_TRUNCATE: % cannot be truncated; delete rows through the rate functions', TG_TABLE_NAME;
END;
$function$;
CREATE TRIGGER trg_product_rates_no_truncate BEFORE TRUNCATE ON public.product_rates
  FOR EACH STATEMENT EXECUTE FUNCTION public._product_rate_review_no_truncate();
CREATE TRIGGER trg_product_parent_rate_outcomes_no_truncate BEFORE TRUNCATE ON public.product_parent_rate_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION public._product_rate_review_no_truncate();

-- ---------------------------------------------------------------------------------------------
-- 4. Helpers (no grants)
-- ---------------------------------------------------------------------------------------------

-- Locks a rate's parent the RT-1 way and returns the row, locked. Refuses an inactive or missing parent.
CREATE FUNCTION public._product_rate_review_lock(p_rate_id uuid) RETURNS public.product_rates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent_id uuid;
  v_row public.product_rates%ROWTYPE;
BEGIN
  -- parent_id never changes (guard trigger), so this read names the parent to lock first.
  SELECT parent_id INTO v_parent_id FROM public.product_rates WHERE id = p_rate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_FOUND'; END IF;
  PERFORM pg_advisory_xact_lock_shared(20261210, hashtext('crx_epa_registration'));
  PERFORM 1 FROM public.product_parents WHERE id = v_parent_id AND is_active FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PARENT_NOT_FOUND: the rate''s parent is missing or inactive'; END IF;
  SELECT * INTO v_row FROM public.product_rates WHERE id = p_rate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_FOUND'; END IF;
  RETURN v_row;
END;
$function$;

-- Approve one draft (contract R1).
CREATE FUNCTION public._product_rate_review_approve(p_rate_id uuid, p_expected_row_version bigint, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_old public.product_rates%ROWTYPE;
  v_new public.product_rates%ROWTYPE;
  v_form text;
  v_kind text;
  v_check jsonb;
BEGIN
  v_old := public._product_rate_review_lock(p_rate_id);
  IF v_old.status <> 'draft' THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_DRAFT: this rate is already approved'; END IF;
  IF p_expected_row_version IS DISTINCT FROM v_old.row_version THEN
    RAISE EXCEPTION 'PRODUCT_RATE_STALE: this rate changed since you opened it; reload and try again';
  END IF;
  IF NOT v_old.basis_confirmed THEN
    RAISE EXCEPTION 'PRODUCT_RATE_BASIS_UNCONFIRMED: check its basis and save it before approving';
  END IF;
  SELECT pp.product_form INTO v_form FROM public.product_parents pp WHERE pp.id = v_old.parent_id;
  SELECT u.kind INTO v_kind FROM public.product_rate_units u WHERE u.code = v_old.unit;
  IF NOT public._product_rate_unit_fits(v_form, v_old.basis, v_kind) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_UNIT_NOT_FOR_BASIS: % is not allowed for % on a % product', v_old.unit, v_old.basis, v_form;
  END IF;
  v_check := public._product_rate_check_values(v_old.parent_id, v_old.source, v_old.basis, v_old.unit, v_old.low,
    v_old.recommended, v_old.high, v_old.basis_confirmed, v_old.over_label_reason);
  IF v_check->>'status' = 'above' AND v_old.over_label_reason IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED: above the label maximum on EPA %; save it with a reason or a lower rate first',
      v_check->'above'->0->>'epa_registration';
  END IF;
  UPDATE public.product_rates SET status = 'approved', approved_by = p_actor, approved_at = now(),
         row_version = row_version + 1, updated_by = p_actor
   WHERE id = p_rate_id
  RETURNING * INTO v_new;
  INSERT INTO public.product_rate_draft_events (parent_id, rate_id, event_type, before_values, after_values, changed_by)
  VALUES (v_new.parent_id, v_new.id, 'approved', to_jsonb(v_old),
    to_jsonb(v_new) || jsonb_build_object('label_check', v_check), p_actor);
  RETURN jsonb_build_object('rate_id', v_new.id, 'row_version', v_new.row_version, 'label_check', v_check);
END;
$function$;

-- Send an approved row back to draft (contract R2). Keeps its values; the old approval stays in the history.
CREATE FUNCTION public._product_rate_review_reopen(p_rate_id uuid, p_expected_row_version bigint, p_reason text,
  p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_reason text := btrim(COALESCE(p_reason, ''), E' \t\r\n ');
  v_old public.product_rates%ROWTYPE;
  v_new public.product_rates%ROWTYPE;
BEGIN
  IF v_reason = '' OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'PRODUCT_RATE_REASON_REQUIRED: say why, in 1 to 500 characters';
  END IF;
  v_old := public._product_rate_review_lock(p_rate_id);
  IF v_old.status <> 'approved' THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_APPROVED: this rate is already a draft'; END IF;
  IF p_expected_row_version IS DISTINCT FROM v_old.row_version THEN
    RAISE EXCEPTION 'PRODUCT_RATE_STALE: this rate changed since you opened it; reload and try again';
  END IF;
  UPDATE public.product_rates SET status = 'draft', approved_by = NULL, approved_at = NULL,
         row_version = row_version + 1, updated_by = p_actor
   WHERE id = p_rate_id
  RETURNING * INTO v_new;
  INSERT INTO public.product_rate_draft_events (parent_id, rate_id, event_type, before_values, after_values, reason, changed_by)
  VALUES (v_new.parent_id, v_new.id, 'reopened', to_jsonb(v_old), to_jsonb(v_new), v_reason, p_actor);
  RETURN jsonb_build_object('rate_id', v_new.id, 'row_version', v_new.row_version);
END;
$function$;

-- Set or clear one parent's outcome (contract R3). Returns {changed: false} when it already holds.
-- The approved rows of a parent that no longer pass R1 as the parent is now (form, basis, label maximum),
-- as one readable line, or NULL. Used by the outcome writer and shown on the download.
CREATE FUNCTION public._product_rate_review_row_problems(p_parent_id uuid, p_form text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT string_agg(r.source || ' ' || r.basis || ': ' || CASE
           WHEN NOT r.basis_confirmed THEN 'basis not confirmed'
           WHEN NOT public._product_rate_unit_fits(p_form, r.basis, u.kind) THEN r.unit || ' does not fit a ' || p_form || ' product'
           ELSE 'above the label maximum with no reason' END, '; ' ORDER BY r.id)
    FROM public.product_rates r JOIN public.product_rate_units u ON u.code = r.unit
   WHERE r.parent_id = p_parent_id AND r.status = 'approved'
     AND (NOT r.basis_confirmed OR NOT public._product_rate_unit_fits(p_form, r.basis, u.kind)
          OR (r.over_label_reason IS NULL AND public._product_rate_check_values(r.parent_id, r.source, r.basis, r.unit, r.low,
                r.recommended, r.high, r.basis_confirmed, r.over_label_reason)->>'status' = 'above'));
$function$;

CREATE FUNCTION public._product_rate_review_outcome(p_parent_id uuid, p_expected_version bigint, p_outcome text,
  p_note text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_note text := NULLIF(btrim(COALESCE(p_note, ''), E' \t\r\n '), '');
  v_name text;
  v_old public.product_parent_rate_outcomes%ROWTYPE;
  v_version bigint;
  v_drafts int;
  v_default public.product_rates%ROWTYPE;
  v_new public.product_parent_rate_outcomes%ROWTYPE;
  v_form text;
  v_bad text;
BEGIN
  IF p_outcome IS NOT NULL AND p_outcome NOT IN ('approved_default', 'no_per_acre_default', 'needs_label_data') THEN
    RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: the outcome is approved_default, no_per_acre_default, needs_label_data or blank';
  END IF;
  IF length(v_note) > 500 THEN RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: keep the note to 500 characters'; END IF;
  IF p_outcome IS NULL AND v_note IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: a note needs an outcome';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(20261210, hashtext('crx_epa_registration'));
  SELECT pp.name, pp.product_form INTO v_name, v_form FROM public.product_parents pp
   WHERE pp.id = p_parent_id AND pp.is_active FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PARENT_NOT_FOUND: the parent is missing or inactive'; END IF;
  PERFORM 1 FROM public.product_rates WHERE parent_id = p_parent_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_old FROM public.product_parent_rate_outcomes WHERE parent_id = p_parent_id FOR UPDATE;
  v_version := COALESCE(v_old.outcome_version, 0);
  IF p_expected_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_STALE: % changed since you opened it; reload and try again', v_name;
  END IF;
  IF p_outcome IN ('approved_default', 'no_per_acre_default') THEN
    SELECT count(*) INTO v_drafts FROM public.product_rates WHERE parent_id = p_parent_id AND status = 'draft';
    IF v_drafts > 0 THEN
      RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_DRAFTS_LEFT: % has % rate(s) not yet approved; approve or delete them first', v_name, v_drafts;
    END IF;
    SELECT * INTO v_default FROM public.product_rates WHERE parent_id = p_parent_id AND is_quoting_default;
    IF p_outcome = 'approved_default' AND v_default.id IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_NO_DEFAULT: % has no quoting default; mark one, or choose no_per_acre_default', v_name;
    END IF;
    IF p_outcome = 'no_per_acre_default' AND v_default.id IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_HAS_DEFAULT: % has a quoting default; clear it, or choose approved_default', v_name;
    END IF;
    -- Every approved row must still pass R1 now (the parent's form or label maximum may have changed since).
    v_bad := public._product_rate_review_row_problems(p_parent_id, v_form);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_ROW_INVALID: % no longer passes approval (%); reopen and fix it first', v_name, v_bad;
    END IF;
  END IF;
  -- Unchanged only after the re-check: an outcome that no longer holds is never re-confirmed silently.
  IF v_old.outcome IS NOT DISTINCT FROM p_outcome AND v_old.note IS NOT DISTINCT FROM v_note THEN
    RETURN jsonb_build_object('parent_id', p_parent_id, 'changed', false, 'outcome_version', v_version);
  END IF;

  INSERT INTO public.product_parent_rate_outcomes AS o (parent_id, outcome, note, decided_by, decided_at)
  VALUES (p_parent_id, p_outcome, CASE WHEN p_outcome IS NOT NULL THEN v_note END,
    CASE WHEN p_outcome IS NOT NULL THEN p_actor END, CASE WHEN p_outcome IS NOT NULL THEN now() END)
  ON CONFLICT (parent_id) DO UPDATE SET outcome = EXCLUDED.outcome, note = EXCLUDED.note,
    decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at,
    outcome_version = o.outcome_version + 1, updated_at = now()
  RETURNING * INTO v_new;
  -- The event names the exact rows the decision covers (a hold covers its drafts as they are now).
  INSERT INTO public.product_rate_draft_events (parent_id, event_type, before_values, after_values, reason, changed_by)
  VALUES (p_parent_id, CASE WHEN p_outcome IS NULL THEN 'outcome_cleared' ELSE 'outcome_set' END,
    CASE WHEN v_old.parent_id IS NOT NULL THEN to_jsonb(v_old) END,
    to_jsonb(v_new) || jsonb_build_object('rates', COALESCE((SELECT jsonb_agg(jsonb_build_object('rate_id', r.id,
      'status', r.status, 'row_version', r.row_version) ORDER BY r.id) FROM public.product_rates r WHERE r.parent_id = p_parent_id), '[]'::jsonb)),
    CASE WHEN p_outcome IS NULL THEN 'cleared by an admin' END, p_actor);
  RETURN jsonb_build_object('parent_id', p_parent_id, 'changed', true, 'outcome_version', v_new.outcome_version);
END;
$function$;

-- A rate value from the workbook: JSON null, "" or a decimal string of 0 to 999999999 with at most 6 decimals.
CREATE FUNCTION public._product_rate_review_number(p_row jsonb, p_key text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v text;
BEGIN
  IF COALESCE(jsonb_typeof(p_row->p_key), 'null') = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_row->p_key) <> 'string' THEN RAISE EXCEPTION 'PRODUCT_RATE_INVALID: % must be text', p_key; END IF;
  v := btrim(p_row->>p_key);
  IF v = '' THEN RETURN NULL; END IF;
  IF v !~ '^[0-9]{1,9}(\.[0-9]{1,6})?$' THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: % must be a number of 0 or more, up to 6 decimals', p_key;
  END IF;
  RETURN v::numeric;
END;
$function$;

-- Optional text: JSON null or "" is NULL; anything but a string is refused.
CREATE FUNCTION public._product_rate_review_text(p_row jsonb, p_key text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
BEGIN
  IF COALESCE(jsonb_typeof(p_row->p_key), 'null') = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_row->p_key) <> 'string' THEN RAISE EXCEPTION 'PRODUCT_RATE_INVALID: % must be text', p_key; END IF;
  RETURN NULLIF(btrim(p_row->>p_key, E' \t\r\n '), '');
END;
$function$;

-- A whole JSON number 0 or more (a version from the download), or NULL when absent.
CREATE FUNCTION public._product_rate_review_version(p_row jsonb, p_key text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v numeric;
BEGIN
  IF COALESCE(jsonb_typeof(p_row->p_key), 'null') = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_row->p_key) <> 'number' THEN RAISE EXCEPTION 'PRODUCT_RATE_INVALID: % must be the number from the download', p_key; END IF;
  v := (p_row->p_key)::numeric;
  IF v <> trunc(v) OR v < 0 OR v > 9223372036854775807 THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: % must be the number from the download', p_key;
  END IF;
  RETURN v::bigint;
END;
$function$;

-- The whole review save (contract R5). Every row's actions run in this order: reopen, delete, saves that end
-- with no quoting default, saves that end as the default, approve; then outcomes. Each action runs in its own
-- block so every row reports its own result; the callers decide whether to keep or roll back the lot.
-- Returns {rates: [...], outcomes: [...]}, each row with status unchanged / change / stale / invalid / not_found.
CREATE FUNCTION public._product_rate_review_run(p_rates jsonb, p_outcomes jsonb, p_key text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_rates jsonb := COALESCE(p_rates, '[]'::jsonb);
  v_outcomes jsonb := COALESCE(p_outcomes, '[]'::jsonb);
  v_n int;
  v_m int;
  v_row jsonb;
  v_plan jsonb := '[]'::jsonb;   -- one entry per rate row, in upload order
  v_p jsonb;
  v_cur public.product_rates%ROWTYPE;
  v_rate_id uuid;
  v_parent_id uuid;
  v_expected bigint;
  v_decision text;
  v_reason text;
  v_vals jsonb;
  v_changed boolean;
  v_seen uuid[] := '{}';
  v_parents uuid[] := '{}';
  v_phase int;
  v_i int;
  v_res jsonb;
  v_status text;
  v_out_rows jsonb := '[]'::jsonb;
  v_name text;
  v_o_parent uuid;
  v_o_version bigint;
  v_o_outcome text;
  v_o_note text;
  v_before_versions jsonb;
BEGIN
  IF jsonb_typeof(v_rates) <> 'array' OR jsonb_typeof(v_outcomes) <> 'array'
     OR jsonb_array_length(v_rates) > 3000 OR jsonb_array_length(v_outcomes) > 1000
     OR jsonb_array_length(v_rates) + jsonb_array_length(v_outcomes) = 0 THEN
    RAISE EXCEPTION 'RATE_REVIEW_ROWS_REQUIRED: send up to 3000 rate rows and 1000 outcome rows, at least one row';
  END IF;

  -- Plan each rate row (no writes).
  FOR v_n IN 0 .. jsonb_array_length(v_rates) - 1 LOOP
    v_row := v_rates->v_n;
    v_p := jsonb_build_object('index', v_n);
    BEGIN
      IF jsonb_typeof(v_row) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PRODUCT_RATE_INVALID: each row is an object'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_row) k WHERE k NOT IN ('rate_id', 'parent_id', 'expected_row_version',
                   'basis', 'source', 'low', 'recommended', 'high', 'unit', 'is_quoting_default', 'over_label_reason',
                   'decision', 'reason')) THEN
        RAISE EXCEPTION 'PRODUCT_RATE_INVALID: unexpected field';
      END IF;
      v_rate_id := public._product_rate_review_text(v_row, 'rate_id')::uuid;
      v_parent_id := public._product_rate_review_text(v_row, 'parent_id')::uuid;
      IF v_parent_id IS NULL THEN RAISE EXCEPTION 'PRODUCT_RATE_INVALID: parent_id is required'; END IF;
      v_p := v_p || jsonb_build_object('rate_id', v_rate_id, 'parent_id', v_parent_id);
      v_expected := public._product_rate_review_version(v_row, 'expected_row_version');
      v_decision := lower(public._product_rate_review_text(v_row, 'decision'));
      IF v_decision IS NOT NULL AND v_decision NOT IN ('approve', 'reopen', 'delete') THEN
        RAISE EXCEPTION 'PRODUCT_RATE_INVALID: decision is approve, reopen, delete or blank';
      END IF;
      v_reason := public._product_rate_review_text(v_row, 'reason');
      IF jsonb_typeof(v_row->'is_quoting_default') NOT IN ('boolean', 'null') THEN
        RAISE EXCEPTION 'PRODUCT_RATE_INVALID: is_quoting_default must be true or false';
      END IF;
      v_vals := jsonb_build_object(
        'basis', public._product_rate_review_text(v_row, 'basis'), 'source', public._product_rate_review_text(v_row, 'source'),
        'low', public._product_rate_review_number(v_row, 'low'),
        'recommended', public._product_rate_review_number(v_row, 'recommended'),
        'high', public._product_rate_review_number(v_row, 'high'), 'unit', public._product_rate_review_text(v_row, 'unit'),
        'is_quoting_default', COALESCE((v_row->>'is_quoting_default')::boolean, false),
        'over_label_reason', public._product_rate_review_text(v_row, 'over_label_reason'));
      v_p := v_p || jsonb_build_object('vals', v_vals, 'decision', v_decision, 'reason', v_reason);

      IF v_rate_id IS NULL THEN
        -- A new row; a row left blank is skipped.
        IF v_decision IS NULL AND v_vals->>'basis' IS NULL AND v_vals->>'source' IS NULL AND v_vals->>'unit' IS NULL
           AND v_vals->'low' = 'null' AND v_vals->'recommended' = 'null' AND v_vals->'high' = 'null' THEN
          v_p := v_p || jsonb_build_object('status', 'skip');
        ELSIF v_decision IN ('reopen', 'delete') THEN
          RAISE EXCEPTION 'PRODUCT_RATE_INVALID: a new rate can only be added, or added and approved';
        ELSE
          SELECT name INTO v_name FROM public.product_parents WHERE id = v_parent_id;
          IF NOT FOUND THEN
            v_p := v_p || jsonb_build_object('status', 'not_found', 'problem', 'no such parent');
          ELSE
            v_p := v_p || jsonb_build_object('name', v_name, 'status', 'change', 'actions',
              jsonb_build_array('save') || CASE WHEN v_decision = 'approve' THEN '["approve"]'::jsonb ELSE '[]'::jsonb END);
          END IF;
        END IF;
      ELSE
        IF v_rate_id = ANY (v_seen) THEN RAISE EXCEPTION 'PRODUCT_RATE_INVALID: this rate is on the tab twice'; END IF;
        v_seen := v_seen || v_rate_id;
        SELECT * INTO v_cur FROM public.product_rates WHERE id = v_rate_id;
        IF NOT FOUND THEN
          v_p := v_p || jsonb_build_object('status', 'not_found', 'problem', 'this rate no longer exists');
        ELSIF v_cur.parent_id <> v_parent_id THEN
          RAISE EXCEPTION 'PRODUCT_RATE_INVALID: this rate belongs to a different parent';
        ELSE
          SELECT name INTO v_name FROM public.product_parents WHERE id = v_cur.parent_id;
          v_p := v_p || jsonb_build_object('name', v_name, 'before', to_jsonb(v_cur));
          v_changed := (v_vals->>'basis', v_vals->>'source', (v_vals->>'low')::numeric, (v_vals->>'recommended')::numeric,
                        (v_vals->>'high')::numeric, v_vals->>'unit', (v_vals->>'is_quoting_default')::boolean, v_vals->>'over_label_reason')
            IS DISTINCT FROM (v_cur.basis, v_cur.source, v_cur.low, v_cur.recommended, v_cur.high, v_cur.unit,
                              v_cur.is_quoting_default, v_cur.over_label_reason);
          IF NOT v_changed AND (v_decision IS NULL OR (v_decision = 'approve' AND v_cur.status = 'approved')) THEN
            v_p := v_p || jsonb_build_object('status', 'unchanged');
          ELSIF v_expected IS DISTINCT FROM v_cur.row_version THEN
            v_p := v_p || jsonb_build_object('status', 'stale', 'problem', 'changed by someone else since you downloaded it');
          ELSIF v_cur.status = 'approved' THEN
            IF v_decision = 'reopen' THEN
              v_p := v_p || jsonb_build_object('status', 'change', 'actions',
                jsonb_build_array('reopen') || CASE WHEN v_changed THEN '["save"]'::jsonb ELSE '[]'::jsonb END);
            ELSE
              RAISE EXCEPTION 'PRODUCT_RATE_APPROVED: this rate is approved; put reopen in decision (with a reason) to change or delete it';
            END IF;
          ELSIF v_decision = 'reopen' THEN
            RAISE EXCEPTION 'PRODUCT_RATE_NOT_APPROVED: this rate is already a draft';
          ELSIF v_decision = 'delete' THEN
            v_p := v_p || jsonb_build_object('status', 'change', 'actions', '["delete"]'::jsonb);
          ELSE
            v_p := v_p || jsonb_build_object('status', 'change', 'actions',
              CASE WHEN v_changed THEN '["save"]'::jsonb ELSE '[]'::jsonb END
              || CASE WHEN v_decision = 'approve' THEN '["approve"]'::jsonb ELSE '[]'::jsonb END);
          END IF;
          v_p := v_p || jsonb_build_object('version', v_cur.row_version);
        END IF;
      END IF;
    EXCEPTION WHEN raise_exception OR invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
      v_p := v_p || jsonb_build_object('status', 'invalid', 'problem', SQLERRM);
    END;
    IF v_p->>'status' = 'change' THEN v_parents := v_parents || (v_p->>'parent_id')::uuid; END IF;
    v_plan := v_plan || jsonb_build_array(v_p);
  END LOOP;

  -- Outcome rows name their parents too: lock every touched parent once, in ID order (RT-1's order).
  FOR v_m IN 0 .. jsonb_array_length(v_outcomes) - 1 LOOP
    BEGIN
      v_parents := v_parents || public._product_rate_review_text(v_outcomes->v_m, 'parent_id')::uuid;
    EXCEPTION WHEN raise_exception OR invalid_text_representation OR data_exception THEN NULL;
    END;
  END LOOP;
  PERFORM pg_advisory_xact_lock_shared(20261210, hashtext('crx_epa_registration'));
  PERFORM 1 FROM public.product_parents WHERE id = ANY (v_parents) ORDER BY id FOR NO KEY UPDATE;
  -- Outcome versions under the lock, before this save's own rate changes clear any outcome (R4), so an outcome
  -- row downloaded at that version is not refused as stale because of this same upload.
  v_before_versions := COALESCE((SELECT jsonb_object_agg(o.parent_id::text, o.outcome_version)
                                   FROM public.product_parent_rate_outcomes o WHERE o.parent_id = ANY (v_parents)), '{}'::jsonb);

  -- Run the rate actions phase by phase (1 reopen, 2 delete, 3 save ending without default, 4 save ending as default, 5 approve).
  FOR v_phase IN 1 .. 5 LOOP
    FOR v_i IN SELECT i FROM generate_series(0, jsonb_array_length(v_plan) - 1) i
                WHERE v_plan->i->>'status' = 'change'
                ORDER BY (v_plan->i->>'parent_id'), (v_plan->i->>'rate_id') NULLS LAST, i LOOP
      v_p := v_plan->v_i;
      IF NOT (CASE v_phase
                WHEN 1 THEN v_p->'actions' ? 'reopen'
                WHEN 2 THEN v_p->'actions' ? 'delete'
                WHEN 3 THEN v_p->'actions' ? 'save' AND NOT (v_p->'vals'->>'is_quoting_default')::boolean
                WHEN 4 THEN v_p->'actions' ? 'save' AND (v_p->'vals'->>'is_quoting_default')::boolean
                ELSE v_p->'actions' ? 'approve' END) THEN
        CONTINUE;
      END IF;
      BEGIN
        IF v_phase = 1 THEN
          v_res := public._product_rate_review_reopen((v_p->>'rate_id')::uuid, (v_p->>'version')::bigint, v_p->>'reason', p_actor);
          v_p := v_p || jsonb_build_object('version', (v_res->>'row_version')::bigint);
        ELSIF v_phase = 2 THEN
          v_res := public.delete_draft_product_rate((v_p->>'rate_id')::uuid, (v_p->>'version')::bigint, v_p->>'reason',
            p_key || ':d:' || v_i);
        ELSIF v_phase IN (3, 4) THEN
          v_res := public.save_draft_product_rate((v_p->>'parent_id')::uuid, (v_p->>'rate_id')::uuid, (v_p->>'version')::bigint,
            v_p->'vals'->>'basis', v_p->'vals'->>'source', (v_p->'vals'->>'low')::numeric, (v_p->'vals'->>'recommended')::numeric,
            (v_p->'vals'->>'high')::numeric, v_p->'vals'->>'unit', (v_p->'vals'->>'is_quoting_default')::boolean,
            v_p->'vals'->>'over_label_reason', p_key || ':s:' || v_i);
          v_p := v_p || jsonb_build_object('rate_id', v_res->>'rate_id', 'version', (v_res->>'row_version')::bigint,
            'label_check', v_res->'label_check');
        ELSE
          v_res := public._product_rate_review_approve((v_p->>'rate_id')::uuid, (v_p->>'version')::bigint, p_actor);
          v_p := v_p || jsonb_build_object('version', (v_res->>'row_version')::bigint, 'label_check', v_res->'label_check');
        END IF;
      EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation
                     OR invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
        v_status := CASE WHEN SQLERRM LIKE 'PRODUCT_RATE_STALE%' THEN 'stale' ELSE 'invalid' END;
        v_p := v_p || jsonb_build_object('status', v_status, 'problem', SQLERRM);
      END;
      v_plan := jsonb_set(v_plan, ARRAY[v_i::text], v_p);
    END LOOP;
  END LOOP;

  -- Outcomes, after every rate action.
  FOR v_m IN 0 .. jsonb_array_length(v_outcomes) - 1 LOOP
    v_row := v_outcomes->v_m;
    v_o_parent := NULL;
    v_name := NULL;
    BEGIN
      IF jsonb_typeof(v_row) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: each row is an object'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_row) k WHERE k NOT IN ('parent_id', 'expected_outcome_version', 'outcome', 'note')) THEN
        RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: unexpected field';
      END IF;
      v_o_parent := public._product_rate_review_text(v_row, 'parent_id')::uuid;
      IF v_o_parent IS NULL THEN RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: parent_id is required'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_out_rows) o WHERE o->>'parent_id' = v_o_parent::text) THEN
        RAISE EXCEPTION 'PRODUCT_RATE_OUTCOME_INVALID: this parent is on the tab twice';
      END IF;
      SELECT name INTO v_name FROM public.product_parents WHERE id = v_o_parent;
      v_o_version := public._product_rate_review_version(v_row, 'expected_outcome_version');
      IF v_o_version IS NOT DISTINCT FROM COALESCE((v_before_versions->>v_o_parent::text)::bigint, 0) THEN
        SELECT COALESCE(max(o.outcome_version), 0) INTO v_o_version FROM public.product_parent_rate_outcomes o
         WHERE o.parent_id = v_o_parent;
      END IF;
      v_o_outcome := lower(public._product_rate_review_text(v_row, 'outcome'));
      v_o_note := public._product_rate_review_text(v_row, 'note');
      v_res := public._product_rate_review_outcome(v_o_parent, v_o_version, v_o_outcome, v_o_note, p_actor);
      v_out_rows := v_out_rows || jsonb_build_array(jsonb_build_object('index', v_m, 'parent_id', v_o_parent, 'name', v_name,
        'outcome', v_o_outcome, 'note', v_o_note,
        'status', CASE WHEN (v_res->>'changed')::boolean THEN 'change' ELSE 'unchanged' END));
    EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation
                   OR invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
      v_out_rows := v_out_rows || jsonb_build_array(jsonb_build_object('index', v_m, 'parent_id', v_o_parent, 'name', v_name,
        'status', CASE WHEN SQLERRM LIKE 'PRODUCT_RATE_OUTCOME_STALE%' THEN 'stale'
                       WHEN SQLERRM LIKE 'PARENT_NOT_FOUND%' THEN 'not_found' ELSE 'invalid' END,
        'problem', SQLERRM));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'rates', (SELECT COALESCE(jsonb_agg(p - 'vals' - 'before' - 'reason' - 'actions' - 'version'
                || jsonb_build_object('actions', p->'actions') ORDER BY (p->>'index')::int), '[]'::jsonb)
                FROM jsonb_array_elements(v_plan) p WHERE p->>'status' <> 'skip'),
    'outcomes', v_out_rows);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 5. Browser RPCs (admin only)
-- ---------------------------------------------------------------------------------------------

-- The download: every active parent, its sizes, outcome, rates (with label check) and latest derive notes; totals.
CREATE FUNCTION public.get_rate_review_workbook() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM public._product_parent_require_admin();
  RETURN jsonb_build_object(
    'parents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
          'parent_id', pp.id, 'parent_name', pp.name, 'product_form', pp.product_form,
          'sizes', COALESCE((SELECT jsonb_agg(p.product_name ORDER BY lower(p.product_name), p.id)
                               FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
                              WHERE m.parent_id = pp.id), '[]'::jsonb),
          'outcome', o.outcome, 'outcome_note', o.note, 'outcome_version', COALESCE(o.outcome_version, 0),
          'outcome_decided_by', (SELECT pr.full_name FROM public.profiles pr WHERE pr.id = o.decided_by),
          'outcome_decided_at', o.decided_at,
          -- A recorded promotable outcome whose approved rows no longer pass (form or label maximum changed since).
          'outcome_problem', CASE WHEN o.outcome IN ('approved_default', 'no_per_acre_default')
                                  THEN public._product_rate_review_row_problems(pp.id, pp.product_form) END,
          'rates', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('rate_id', r.id, 'basis', r.basis, 'source', r.source,
                'low', r.low::text, 'recommended', r.recommended::text, 'high', r.high::text, 'unit', r.unit,
                'unit_label', u.label, 'is_quoting_default', r.is_quoting_default, 'status', r.status,
                'origin', r.origin, 'basis_confirmed', r.basis_confirmed, 'source_text', r.source_text,
                'over_label_reason', r.over_label_reason, 'row_version', r.row_version,
                'approved_by', (SELECT pr.full_name FROM public.profiles pr WHERE pr.id = r.approved_by),
                'approved_at', r.approved_at,
                'label_check', public._product_rate_check_values(r.parent_id, r.source, r.basis, r.unit, r.low,
                  r.recommended, r.high, r.basis_confirmed, r.over_label_reason))
              ORDER BY r.source, r.basis, r.id)
              FROM public.product_rates r JOIN public.product_rate_units u ON u.code = r.unit
             WHERE r.parent_id = pp.id), '[]'::jsonb),
          -- Only the latest derivation's notes (one derivation is one transaction, so one changed_at).
          'notes', COALESCE((
            SELECT jsonb_agg(e.after_values ORDER BY e.id)
              FROM public.product_rate_draft_events e
             WHERE e.parent_id = pp.id AND e.event_type = 'derive_note'
               AND e.changed_at = (SELECT max(e2.changed_at) FROM public.product_rate_draft_events e2
                                    WHERE e2.parent_id = pp.id AND e2.event_type = 'derive_note')), '[]'::jsonb))
        ORDER BY lower(pp.name), pp.id)
        FROM public.product_parents pp
        LEFT JOIN public.product_parent_rate_outcomes o ON o.parent_id = pp.id
       WHERE pp.is_active), '[]'::jsonb),
    'units', (SELECT jsonb_agg(jsonb_build_object('code', u.code, 'label', u.label, 'kind', u.kind) ORDER BY u.kind, u.factor)
                FROM public.product_rate_units u),
    'totals', jsonb_build_object(
      'rates', (SELECT count(*) FROM public.product_rates r JOIN public.product_parents pp ON pp.id = r.parent_id WHERE pp.is_active),
      'drafts', (SELECT count(*) FROM public.product_rates r JOIN public.product_parents pp ON pp.id = r.parent_id
                  WHERE pp.is_active AND r.status = 'draft'),
      'approved', (SELECT count(*) FROM public.product_rates r JOIN public.product_parents pp ON pp.id = r.parent_id
                    WHERE pp.is_active AND r.status = 'approved'),
      'per_100_gal', (SELECT count(*) FROM public.product_rates r JOIN public.product_parents pp ON pp.id = r.parent_id
                       WHERE pp.is_active AND r.basis = 'per_100_gal'),
      'per_100_gal_approved', (SELECT count(*) FROM public.product_rates r JOIN public.product_parents pp ON pp.id = r.parent_id
                                WHERE pp.is_active AND r.basis = 'per_100_gal' AND r.status = 'approved'),
      'parents', (SELECT count(*) FROM public.product_parents WHERE is_active),
      'parents_undecided', (SELECT count(*) FROM public.product_parents pp
                              LEFT JOIN public.product_parent_rate_outcomes o ON o.parent_id = pp.id
                             WHERE pp.is_active AND o.outcome IS NULL),
      'approved_default', (SELECT count(*) FROM public.product_parent_rate_outcomes o JOIN public.product_parents pp ON pp.id = o.parent_id
                            WHERE pp.is_active AND o.outcome = 'approved_default'),
      'no_per_acre_default', (SELECT count(*) FROM public.product_parent_rate_outcomes o JOIN public.product_parents pp ON pp.id = o.parent_id
                               WHERE pp.is_active AND o.outcome = 'no_per_acre_default'),
      'needs_label_data', (SELECT count(*) FROM public.product_parent_rate_outcomes o JOIN public.product_parents pp ON pp.id = o.parent_id
                            WHERE pp.is_active AND o.outcome = 'needs_label_data'),
      'outcomes_no_longer_valid', (SELECT count(*) FROM public.product_parent_rate_outcomes o JOIN public.product_parents pp ON pp.id = o.parent_id
                            WHERE pp.is_active AND o.outcome IN ('approved_default', 'no_per_acre_default')
                              AND public._product_rate_review_row_problems(pp.id, pp.product_form) IS NOT NULL)));
END;
$function$;

-- Read-only: runs the whole save and always rolls it back. VOLATILE because of the rehearsal.
CREATE FUNCTION public.preview_rate_review(p_rates jsonb, p_outcomes jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_result jsonb;
BEGIN
  BEGIN
    v_result := public._product_rate_review_run(p_rates, p_outcomes, 'rt3-preview:' || gen_random_uuid()::text, v_actor);
    RAISE EXCEPTION 'CRX_PREVIEW_ROLLBACK' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RETURN v_result;
END;
$function$;

-- All or nothing: any row that is not unchanged or a change refuses the whole save.
CREATE FUNCTION public.commit_rate_review(p_rates jsonb, p_outcomes jsonb, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', v_actor, 'rates', p_rates, 'outcomes', p_outcomes)::text);
  v_existing jsonb;
  v_result jsonb;
  v_bad text;
  v_receipt jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'commit_rate_review', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_result := public._product_rate_review_run(p_rates, p_outcomes, 'rt3:' || p_idempotency_key, v_actor);
  SELECT string_agg(COALESCE(r->>'name', 'a row') || ': ' || COALESCE(r->>'problem', r->>'status'), '; ') INTO v_bad
    FROM (SELECT r FROM jsonb_array_elements(v_result->'rates') r
          UNION ALL SELECT r FROM jsonb_array_elements(v_result->'outcomes') r) x
   WHERE r->>'status' NOT IN ('unchanged', 'change');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'RATE_REVIEW_REFUSED: nothing was saved. %', left(v_bad, 4000); END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_result->'rates') r WHERE r->>'status' = 'change')
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_result->'outcomes') r WHERE r->>'status' = 'change') THEN
    RAISE EXCEPTION 'RATE_REVIEW_NOTHING_TO_SAVE: nothing in this upload differs from the database';
  END IF;
  v_receipt := jsonb_build_object(
    'rates_changed', (SELECT count(*) FROM jsonb_array_elements(v_result->'rates') r WHERE r->>'status' = 'change'),
    'outcomes_changed', (SELECT count(*) FROM jsonb_array_elements(v_result->'outcomes') r WHERE r->>'status' = 'change'),
    'rates', v_result->'rates', 'outcomes', v_result->'outcomes');
  PERFORM public.save_idempotency(p_idempotency_key, 'commit_rate_review',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 6. Owners and grants: owner postgres, no PUBLIC execute; only the three RPCs, to authenticated
--    (each refuses non-admins itself).
-- ---------------------------------------------------------------------------------------------

CREATE TEMP TABLE product_rate_review_fns ON COMMIT DROP AS
SELECT f, f NOT IN ('public.get_rate_review_workbook()', 'public.preview_rate_review(jsonb,jsonb)',
                    'public.commit_rate_review(jsonb,jsonb,text)') AS helper
  FROM unnest(ARRAY[
  'public._product_rates_clear_outcome()', 'public._product_rate_review_no_truncate()', 'public._product_rate_review_lock(uuid)',
  'public._product_rate_review_approve(uuid,bigint,uuid)', 'public._product_rate_review_reopen(uuid,bigint,text,uuid)',
  'public._product_rate_review_row_problems(uuid,text)', 'public._product_rate_review_outcome(uuid,bigint,text,text,uuid)', 'public._product_rate_review_number(jsonb,text)',
  'public._product_rate_review_text(jsonb,text)', 'public._product_rate_review_version(jsonb,text)',
  'public._product_rate_review_run(jsonb,jsonb,text,uuid)',
  'public.get_rate_review_workbook()', 'public.preview_rate_review(jsonb,jsonb)',
  'public.commit_rate_review(jsonb,jsonb,text)']) f;

DO $grants$
DECLARE
  v record;
BEGIN
  FOR v IN SELECT * FROM pg_temp.product_rate_review_fns LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', v.f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role, metabase_ro', v.f);
    IF NOT v.helper THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v.f); END IF;
  END LOOP;
END
$grants$;

-- ---------------------------------------------------------------------------------------------
-- 7. Postflight
-- ---------------------------------------------------------------------------------------------

DO $postflight$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(t.f, ', ') INTO v_bad
    FROM pg_temp.product_rate_review_fns t LEFT JOIN pg_proc p ON p.oid = to_regprocedure(t.f)
   WHERE p.oid IS NULL OR pg_get_userbyid(p.proowner) <> 'postgres'
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
      OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
                  WHERE x.grantee <> p.proowner AND (t.helper OR pg_get_userbyid(x.grantee) <> 'authenticated'))
      OR (NOT t.helper AND (NOT p.prosecdef OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')));
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'POSTFLIGHT_FAIL: function owner, mode, search_path or grants wrong on %', v_bad; END IF;
  -- The re-issued guard keeps RT-1's owner, mode, search_path and (no) grants.
  IF (SELECT pg_get_userbyid(p.proowner) <> 'postgres' OR NOT p.prosecdef
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
             OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee <> p.proowner)
        FROM pg_proc p WHERE p.oid = 'public._product_rates_guard_change()'::regprocedure) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: _product_rates_guard_change owner, mode or grants changed';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.product_parent_rate_outcomes'::regclass)
     OR has_table_privilege('anon', 'public.product_parent_rate_outcomes', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('service_role', 'public.product_parent_rate_outcomes', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('metabase_ro', 'public.product_parent_rate_outcomes', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('authenticated', 'public.product_parent_rate_outcomes', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.product_parent_rate_outcomes', 'SELECT')
     OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.product_parent_rate_outcomes'::regclass AND a.attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: product_parent_rate_outcomes grants or row security wrong';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.product_rates'::regclass AND NOT tgisinternal
        AND tgname IN ('trg_product_rates_check_unit', 'trg_product_rates_guard_change', 'trg_product_rates_clear_outcome',
                       'trg_product_rates_no_truncate')) <> 4
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.product_parent_rate_outcomes'::regclass
                     AND tgname = 'trg_product_parent_rate_outcomes_no_truncate') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: product_rates triggers missing';
  END IF;
  -- check_unit: BEFORE ROW, INSERT or UPDATE OF exactly parent_id, basis, unit; clear_outcome: AFTER ROW, all three events.
  IF (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.product_rates'::regclass
        AND tgname = 'trg_product_rates_check_unit')
       NOT LIKE '%BEFORE INSERT OR UPDATE OF parent_id, basis, unit ON public.product_rates FOR EACH ROW%'
     OR (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.product_rates'::regclass
        AND tgname = 'trg_product_rates_clear_outcome')
       NOT LIKE '%AFTER INSERT OR DELETE OR UPDATE ON public.product_rates FOR EACH ROW%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: product_rates trigger timing or columns wrong';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('get_rate_review_workbook', 'preview_rate_review', 'commit_rate_review')) <> 3 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: each of the three RPCs must have exactly one overload';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'product_rate_draft_events_event_type_check'
        AND conrelid = 'public.product_rate_draft_events'::regclass)) NOT LIKE '%outcome_cleared%'
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'product_parent_rate_outcomes'
                     AND cmd = 'SELECT' AND qual LIKE '%is_admin()%') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: event CHECK or outcomes read policy missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_parent_rate_outcomes) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: RT-3 writes no outcome rows';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: rate review in place; no reader changed';
END;
$postflight$;
