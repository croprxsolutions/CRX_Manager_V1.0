-- Written 2026-11-08. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261218110000_epa_registration_draft_setup.md.
-- Re-read the live ledger before applying.
--
-- WHY: REG-1 Step 2 part B (docs/plans/2026-11-06-product-REG1-BUILD-SHEET.md 4.B, Mason's answers (a) to (e)):
--   once the seed has run, a label draft commit, a setup-workbook insert and a brand save go through the
--   registration of the EPA number instead of writing label facts onto one size.
--
-- WHAT:
--   - _commit_label_draft_replay_impl_20261015 re-issued from its live body (md5 pinned). Before the seed it
--     runs today's path unchanged (it now takes the REG-1 lock first). After the seed: checks the private
--     label_draft_targets row (LABEL_DRAFT_TARGET_MISMATCH), takes an accepted draft's values from the
--     private snapshot (LABEL_DRAFT_CHANGED when sent values differ), refuses a stale product or registration
--     (LABEL_DRAFT_STALE unless forced), refuses a different number (LABEL_DRAFT_EPA_CHANGE) and a number
--     with no registration (LABEL_DRAFT_NO_REGISTRATION), and writes a numbered product's facts on its
--     registration (one draft_committed event, copied to every size and brand). A numberless product is
--     written directly, as today. The public wrapper commit_label_draft is unchanged.
--   - apply_product_setup: the live function is renamed _apply_product_setup_reg1_impl (no grants) and a
--     wrapper with the same signature takes the exclusive REG-1 lock first. After the seed, an insert row
--     whose EPA number has no registration creates it from that row's label columns, which must include
--     is_rup (EPA_REGISTRATION_FACTS_REQUIRED otherwise). create_product_with_parent and add_product_size
--     insert their size through apply_product_setup (_insert_parent_size), so they are covered too.
--   - upsert_product_brand, upsert_parent_brand: the live functions are renamed _..._reg1_impl (no grants);
--     new public functions with p_new_registration jsonb DEFAULT NULL added last take the exclusive lock
--     and, after the seed, create the registration for a brand number that has none from
--     p_new_registration (EPA_REGISTRATION_FACTS_REQUIRED otherwise). Old-signature callers resolve to the
--     new function through the default. The brand guards (20261218130000) take the facts from the
--     registration and refuse a number change.
--
-- NOT CHANGED: label-draft wrappers, product and brand tables. No live row is written by this file.
--
-- LOCKS: every function here takes the REG-1 lock exclusively before any row lock (sheet 3.2).
--
-- ROLLBACK (its own reviewed migration): drop the three wrappers, rename the three _reg1_impl functions back
--   with their old grants (EXECUTE to authenticated), and re-emit the commit impl from its pinned body.
--
-- ORDERING: after 20261218100000_epa_registration_tools; before 20261218120000.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE epa_registration_draft_setup_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.epa_registration_draft_setup_tx') IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_DRAFT_SETUP_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.epa_registration_draft_setup_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_DRAFT_SETUP_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._epa_registration_insert(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_DRAFT_SETUP_PREFLIGHT: apply 20261218100000_epa_registration_tools first';
  END IF;
  IF to_regprocedure('public._apply_product_setup_reg1_impl(jsonb,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_DRAFT_SETUP_PREFLIGHT: this file was already applied';
  END IF;
  IF (SELECT count(*) FROM pg_proc p
       WHERE (p.oid, md5(replace(p.prosrc, chr(13), ''))) IN (
         (to_regprocedure('public._commit_label_draft_replay_impl_20261015(uuid,text,text,integer,integer,text,numeric,text,boolean,text)'),
          'dee9e34de43295efc9b7aa1bf6a8d809'),
         (to_regprocedure('public.apply_product_setup(jsonb,uuid,text)'), '3d1f5d5d1fc8c8d046a388a23ee3f408'),
         (to_regprocedure('public.upsert_product_brand(uuid,text,text,text,boolean,boolean,text,uuid,integer,text)'),
          '7cf9cf1ebf7e77f3cedba8ed7456b2bd'),
         (to_regprocedure('public.upsert_parent_brand(uuid,uuid,text,text,text,boolean,boolean,text,uuid,integer,boolean,text,text)'),
          'f18b13871f36097d515c8c6860ab48b1'))
         AND p.proowner = 'postgres'::regrole AND p.prosecdef) <> 4 THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_DRAFT_SETUP_PREFLIGHT: a re-issued or wrapped function drifted from the body this file was written from';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
              AND proname IN ('apply_product_setup', 'upsert_product_brand', 'upsert_parent_brand')
            GROUP BY proname HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_DRAFT_SETUP_PREFLIGHT: an overload already exists';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Shared helper: make sure a number a caller is about to write has a registration
-- ---------------------------------------------------------------------------------------------

-- After the seed: a valid number with no registration is created from p_new_registration (admin only),
-- else refused. Before the seed, or for a blank or malformed number (the table CHECKs refuse that), nothing.
CREATE FUNCTION public._epa_registration_ensure(p_number text, p_new_registration jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_n text := public._normalize_epa_registration(p_number);
  v_reg public.epa_registrations;
BEGIN
  IF NOT public._epa_registrations_seeded() OR v_n IS NULL
     OR v_n !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$'
     OR EXISTS (SELECT 1 FROM public.epa_registrations WHERE epa_registration = v_n) THEN
    RETURN;
  END IF;
  PERFORM public._product_parent_require_admin();
  IF p_new_registration IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_FACTS_REQUIRED: EPA number % has no registration yet; enter its label facts', v_n;
  END IF;
  PERFORM public._epa_registration_facts(p_new_registration, true);
  v_reg := public._epa_registration_insert(v_n, p_new_registration);
  PERFORM public._epa_registration_event(v_n, 'created', p_reason, NULL, to_jsonb(v_reg), '[]'::jsonb);
END;
$function$;
ALTER FUNCTION public._epa_registration_ensure(text, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._epa_registration_ensure(text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Label draft commit (impl re-issued; public wrapper unchanged)
-- ---------------------------------------------------------------------------------------------

-- Live body (md5 dee9e34de43295efc9b7aa1bf6a8d809) plus: the REG-1 lock first, and the seeded branches
-- marked "REG-1". Unseeded, every statement runs as before.
CREATE OR REPLACE FUNCTION public._commit_label_draft_replay_impl_20261015(p_draft_id uuid, p_decision text, p_signal_word text DEFAULT NULL::text, p_rei_hours integer DEFAULT NULL::integer, p_phi_days integer DEFAULT NULL::integer, p_epa_registration text DEFAULT NULL::text, p_max_label_rate numeric DEFAULT NULL::numeric, p_max_label_rate_unit text DEFAULT NULL::text, p_force_overwrite boolean DEFAULT false, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_user_id  uuid := auth.uid();
  v_cached   jsonb;
  v_draft    product_label_drafts%ROWTYPE;
  v_product  products%ROWTYPE;
  v_new_sw   text;
  v_new_rei  integer;
  v_new_phi  integer;
  v_new_epa  text;
  v_new_mlr  numeric;
  v_new_mlru text;
  v_skipped  text[] := '{}';
  v_applied  text[] := '{}';
  v_result   jsonb;
  -- REG-1
  v_seeded   boolean;
  v_target   label_draft_targets%ROWTYPE;
  v_prop     jsonb;
  v_reg_version bigint;
  v_changes  jsonb := '{}'::jsonb;
  v_reg      epa_registrations%ROWTYPE;
  v_aff      jsonb;
BEGIN
  -- Auth gate
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: admin role required';
  END IF;

  -- Validate decision
  IF p_decision NOT IN ('accepted', 'edited', 'rejected') THEN
    RAISE EXCEPTION 'INVALID_DECISION: must be accepted, edited, or rejected';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached
    FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key
      AND operation       = 'commit_label_draft';
    IF FOUND THEN
      RETURN v_cached;
    END IF;
  END IF;

  -- REG-1: nothing changes a number or a label fact while this commit runs (sheet 3.2).
  PERFORM public._epa_registration_lock(true);
  v_seeded := public._epa_registrations_seeded();

  -- Load draft (with lock for safety)
  SELECT * INTO v_draft FROM product_label_drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_NOT_FOUND: %', p_draft_id;
  END IF;

  -- Don't re-commit already-decided drafts (unless idempotency key matched above)
  IF v_draft.status IN ('accepted', 'edited', 'rejected') THEN
    RAISE EXCEPTION 'DRAFT_ALREADY_DECIDED: draft % has status %', p_draft_id, v_draft.status;
  END IF;

  -- Load product
  SELECT * INTO v_product FROM products WHERE id = v_draft.product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND: %', v_draft.product_id;
  END IF;

  -- REG-1: the draft must still point where it pointed when it was created.
  IF v_seeded AND p_decision IN ('accepted', 'edited') THEN
    SELECT * INTO v_target FROM label_draft_targets WHERE draft_id = p_draft_id;
    IF NOT FOUND OR v_target.product_id IS DISTINCT FROM v_draft.product_id
       OR v_target.epa_registration IS DISTINCT FROM public._normalize_epa_registration(v_draft.epa_registration)
       OR v_target.product_epa_registration IS DISTINCT FROM public._normalize_epa_registration(v_product.epa_registration) THEN
      RAISE EXCEPTION 'LABEL_DRAFT_TARGET_MISMATCH: this draft no longer matches its product''s EPA number; create a new draft';
    END IF;
  END IF;

  -- For accepted/edited: resolve which values to write
  IF p_decision IN ('accepted', 'edited') THEN
    -- Use edited override if provided, else draft value
    IF p_decision = 'edited' THEN
      v_new_sw   := p_signal_word;
      v_new_rei  := p_rei_hours;
      v_new_phi  := p_phi_days;
      v_new_epa  := p_epa_registration;
      v_new_mlr  := p_max_label_rate;
      v_new_mlru := p_max_label_rate_unit;
    ELSIF v_seeded THEN
      -- REG-1: accepted means the values the draft was created with (private snapshot), never the
      -- client-editable draft row. Sent values, when any, must equal the snapshot (Mason's (b)).
      v_prop := v_target.proposed_values;
      IF (p_signal_word IS NOT NULL AND p_signal_word IS DISTINCT FROM v_prop->>'signal_word')
         OR (p_rei_hours IS NOT NULL AND p_rei_hours IS DISTINCT FROM (v_prop->>'rei_hours')::integer)
         OR (p_phi_days IS NOT NULL AND p_phi_days IS DISTINCT FROM (v_prop->>'phi_days')::integer)
         OR (p_epa_registration IS NOT NULL AND public._normalize_epa_registration(p_epa_registration)
               IS DISTINCT FROM public._normalize_epa_registration(v_prop->>'epa_registration'))
         OR (p_max_label_rate IS NOT NULL AND p_max_label_rate IS DISTINCT FROM (v_prop->>'max_label_rate')::numeric)
         OR (p_max_label_rate_unit IS NOT NULL AND p_max_label_rate_unit IS DISTINCT FROM v_prop->>'max_label_rate_unit') THEN
        RAISE EXCEPTION 'LABEL_DRAFT_CHANGED: these values differ from the draft as created; save them as an edit';
      END IF;
      v_new_sw   := v_prop->>'signal_word';
      v_new_rei  := (v_prop->>'rei_hours')::integer;
      v_new_phi  := (v_prop->>'phi_days')::integer;
      v_new_epa  := v_prop->>'epa_registration';
      v_new_mlr  := (v_prop->>'max_label_rate')::numeric;
      v_new_mlru := v_prop->>'max_label_rate_unit';
    ELSE
      v_new_sw   := v_draft.signal_word;
      v_new_rei  := v_draft.rei_hours;
      v_new_phi  := v_draft.phi_days;
      v_new_epa  := v_draft.epa_registration;
      v_new_mlr  := v_draft.max_label_rate;
      v_new_mlru := v_draft.max_label_rate_unit;
    END IF;

    -- Non-negativity guard on the RESOLVED values (authoritative — runs before any
    -- write to products). A negative regulatory interval/rate is a safety-impossible
    -- value and must never reach the products table, even via the 'edited' path.
    IF v_new_rei IS NOT NULL AND v_new_rei < 0 THEN
      RAISE EXCEPTION 'INVALID_LABEL_VALUE: rei_hours must be >= 0 (got %)', v_new_rei;
    END IF;
    IF v_new_phi IS NOT NULL AND v_new_phi < 0 THEN
      RAISE EXCEPTION 'INVALID_LABEL_VALUE: phi_days must be >= 0 (got %)', v_new_phi;
    END IF;
    IF v_new_mlr IS NOT NULL AND v_new_mlr < 0 THEN
      RAISE EXCEPTION 'INVALID_LABEL_VALUE: max_label_rate must be >= 0 (got %)', v_new_mlr;
    END IF;

    -- Normalize blank text to NULL so an empty string is treated as "no value" everywhere below
    -- (skip decision, empty/no-values guards, and what we store). The UI already sends '' as null,
    -- but this also covers OCR/bulk-created drafts and products carrying a blank string.
    v_new_sw   := NULLIF(btrim(v_new_sw), '');
    v_new_epa  := NULLIF(btrim(v_new_epa), '');
    v_new_mlru := NULLIF(btrim(v_new_mlru), '');

    -- Empty-decision guard: an accept/edit with NO resolved values is a no-op that
    -- would mark the draft 'decided' while writing nothing. Reject it so a value-less
    -- draft (e.g. a fresh "New Draft" or a needs_manual row) can't leave the queue
    -- without the admin actually entering values first.
    IF v_new_sw IS NULL AND v_new_rei IS NULL AND v_new_phi IS NULL
       AND v_new_epa IS NULL AND v_new_mlr IS NULL AND v_new_mlru IS NULL THEN
      RAISE EXCEPTION 'NO_VALUES_TO_APPLY: % decision has no values to write — enter values before accepting', p_decision;
    END IF;

    -- REG-1: route by number (sheet 4.B steps 3 to 7).
    IF v_seeded THEN
      IF public._normalize_epa_registration(v_new_epa) IS NOT NULL
         AND public._normalize_epa_registration(v_new_epa) IS DISTINCT FROM v_target.product_epa_registration THEN
        RAISE EXCEPTION 'LABEL_DRAFT_EPA_CHANGE: this draft proposes EPA number % for a product on %; use Change EPA number',
          public._normalize_epa_registration(v_new_epa), COALESCE(v_target.product_epa_registration, 'no number');
      END IF;
      SELECT registration_version INTO v_reg_version FROM epa_registrations
       WHERE epa_registration = v_target.product_epa_registration;
      IF NOT p_force_overwrite
         AND (public._product_label_fingerprint(v_product.id) IS DISTINCT FROM v_target.product_label_fingerprint
              OR v_reg_version IS DISTINCT FROM v_target.registration_version) THEN
        RAISE EXCEPTION 'LABEL_DRAFT_STALE: the product''s label facts changed since this draft was created; review again';
      END IF;
      IF v_target.product_epa_registration IS NOT NULL AND v_reg_version IS NULL THEN
        RAISE EXCEPTION 'LABEL_DRAFT_NO_REGISTRATION: EPA number % has no registration yet; create it first',
          v_target.product_epa_registration;
      END IF;
    END IF;

    -- No-overwrite guard: if product field is non-empty and p_force_overwrite=false → skip that field
    -- signal_word
    IF v_new_sw IS NOT NULL THEN
      IF NULLIF(btrim(v_product.signal_word), '') IS NULL OR p_force_overwrite THEN
        v_applied := array_append(v_applied, 'signal_word');
      ELSE
        v_skipped := array_append(v_skipped, 'signal_word');
        v_new_sw  := v_product.signal_word; -- keep existing
      END IF;
    END IF;
    -- rei_hours
    IF v_new_rei IS NOT NULL THEN
      IF v_product.rei_hours IS NULL OR p_force_overwrite THEN
        v_applied := array_append(v_applied, 'rei_hours');
      ELSE
        v_skipped := array_append(v_skipped, 'rei_hours');
        v_new_rei := v_product.rei_hours;
      END IF;
    END IF;
    -- phi_days
    IF v_new_phi IS NOT NULL THEN
      IF v_product.phi_days IS NULL OR p_force_overwrite THEN
        v_applied := array_append(v_applied, 'phi_days');
      ELSE
        v_skipped := array_append(v_skipped, 'phi_days');
        v_new_phi := v_product.phi_days;
      END IF;
    END IF;
    -- epa_registration
    IF v_new_epa IS NOT NULL THEN
      IF NULLIF(btrim(v_product.epa_registration), '') IS NULL OR p_force_overwrite THEN
        v_applied := array_append(v_applied, 'epa_registration');
      ELSE
        v_skipped := array_append(v_skipped, 'epa_registration');
        v_new_epa := v_product.epa_registration;
      END IF;
    END IF;
    -- max_label_rate + max_label_rate_unit (ATOMIC PAIR — only ever written TOGETHER, from ONE source.
    -- A one-sided draft (rate without unit, or unit without rate) is never partially applied, so a new
    -- unit can never glue onto an old rate (or vice versa), even under force-overwrite.)
    IF v_new_mlr IS NOT NULL OR v_new_mlru IS NOT NULL THEN
      IF v_new_mlr IS NOT NULL AND v_new_mlru IS NOT NULL
         AND ((v_product.max_label_rate IS NULL AND v_product.max_label_rate_unit IS NULL) OR p_force_overwrite) THEN
        -- both sides present AND (target pair empty OR explicit force): apply the pair together
        v_applied := array_append(v_applied, 'max_label_rate');
        v_applied := array_append(v_applied, 'max_label_rate_unit');
      ELSE
        -- one-sided draft, OR target pair non-empty without force: skip the pair, keep the existing pair intact
        IF v_new_mlr  IS NOT NULL THEN v_skipped := array_append(v_skipped, 'max_label_rate'); END IF;
        IF v_new_mlru IS NOT NULL THEN v_skipped := array_append(v_skipped, 'max_label_rate_unit'); END IF;
        v_new_mlr  := v_product.max_label_rate;       -- revert BOTH to existing so the stored pair stays consistent
        v_new_mlru := v_product.max_label_rate_unit;
      END IF;
    END IF;

    -- Nothing was actually applied (every proposed field was skipped as already-filled, or only a
    -- one-sided max-rate pair was supplied) -> reject so the draft is NOT closed without writing anything.
    -- (The earlier empty-decision guard catches a value-less draft; this catches a draft that HAD values
    -- but where all of them ended up skipped — e.g. a lone rate without a unit.)
    IF array_length(v_applied, 1) IS NULL THEN
      RAISE EXCEPTION 'NO_VALUES_TO_APPLY: nothing was applied (all proposed fields were skipped as already-filled, or formed a one-sided max-rate pair) — nothing to accept';
    END IF;

    IF v_seeded AND v_target.product_epa_registration IS NOT NULL THEN
      -- REG-1: a numbered product's label facts live on its registration (the number itself is unchanged).
      IF 'signal_word' = ANY(v_applied) THEN v_changes := v_changes || jsonb_build_object('signal_word', v_new_sw); END IF;
      IF 'rei_hours' = ANY(v_applied) THEN v_changes := v_changes || jsonb_build_object('rei_hours', v_new_rei); END IF;
      IF 'phi_days' = ANY(v_applied) THEN v_changes := v_changes || jsonb_build_object('phi_days', v_new_phi); END IF;
      IF 'max_label_rate' = ANY(v_applied) THEN
        v_changes := v_changes || jsonb_build_object('max_label_rate', v_new_mlr, 'max_label_rate_unit', v_new_mlru);
      END IF;
      IF v_changes <> '{}'::jsonb THEN
        SELECT * INTO v_reg FROM epa_registrations WHERE epa_registration = v_target.product_epa_registration FOR UPDATE;
        v_prop := to_jsonb(v_reg);
        v_reg := public._epa_registration_update(v_target.product_epa_registration, v_changes);
        v_aff := public._epa_registration_copy_to_targets(v_target.product_epa_registration);
        PERFORM public._epa_registration_event(v_target.product_epa_registration, 'draft_committed',
          'label draft ' || p_draft_id::text, v_prop, to_jsonb(v_reg), v_aff);
      END IF;
    ELSE
    -- Write to products
    UPDATE products
    SET
      signal_word         = COALESCE(v_new_sw,   signal_word),
      rei_hours           = COALESCE(v_new_rei,  rei_hours),
      phi_days            = COALESCE(v_new_phi,  phi_days),
      epa_registration    = COALESCE(v_new_epa,  epa_registration),
      max_label_rate      = COALESCE(v_new_mlr,  max_label_rate),
      max_label_rate_unit = COALESCE(v_new_mlru, max_label_rate_unit),
      updated_at          = now()
    WHERE id = v_draft.product_id;
    END IF;
  END IF;

  -- Mark draft as decided. For accept/edit store the FINAL resolved values (v_new_*) that reflect what
  -- the product actually holds now (applied fields = the written value; skipped fields = the existing
  -- product value) — NEVER the raw proposed edits, so the queue can't display a value as saved when it
  -- was actually skipped. For 'rejected', leave the drafted values untouched.
  UPDATE product_label_drafts
  SET status      = p_decision,
      reviewed_by  = v_user_id,
      reviewed_at  = now(),
      signal_word          = CASE WHEN p_decision = 'rejected' THEN signal_word         ELSE v_new_sw   END,
      rei_hours            = CASE WHEN p_decision = 'rejected' THEN rei_hours            ELSE v_new_rei  END,
      phi_days             = CASE WHEN p_decision = 'rejected' THEN phi_days             ELSE v_new_phi  END,
      epa_registration     = CASE WHEN p_decision = 'rejected' THEN epa_registration     ELSE v_new_epa  END,
      max_label_rate       = CASE WHEN p_decision = 'rejected' THEN max_label_rate       ELSE v_new_mlr  END,
      max_label_rate_unit  = CASE WHEN p_decision = 'rejected' THEN max_label_rate_unit  ELSE v_new_mlru END
  WHERE id = p_draft_id;

  v_result := jsonb_build_object(
    'draft_id',   p_draft_id,
    'product_id', v_draft.product_id,
    'decision',   p_decision,
    'applied',    to_jsonb(v_applied),
    'skipped',    to_jsonb(v_skipped)
  );

  -- Store idempotency
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'commit_label_draft', v_result)
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;
ALTER FUNCTION public._commit_label_draft_replay_impl_20261015(uuid, text, text, integer, integer, text, numeric, text, boolean, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._commit_label_draft_replay_impl_20261015(uuid, text, text, integer, integer, text, numeric, text, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Setup workbook, product create and add-size (one wrapper; all insert through it)
-- ---------------------------------------------------------------------------------------------

ALTER FUNCTION public.apply_product_setup(jsonb, uuid, text) RENAME TO _apply_product_setup_reg1_impl;
REVOKE ALL ON FUNCTION public._apply_product_setup_reg1_impl(jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.apply_product_setup(p_rows jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_f jsonb;
  v_n text;
  v_facts jsonb;
  v_reg public.epa_registrations;
BEGIN
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  -- Admin before the company-wide lock, so a refused caller never queues invoicing behind it (the impl's own check).
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  PERFORM public._epa_registration_lock(true);
  IF public._epa_registrations_seeded() AND jsonb_typeof(p_rows) = 'array' THEN
    FOR v_f IN SELECT r->'insert' FROM jsonb_array_elements(p_rows) r
                WHERE jsonb_typeof(r) = 'object' AND jsonb_typeof(r->'insert') = 'object' LOOP
      v_n := public._normalize_epa_registration(v_f->>'epa_registration');
      CONTINUE WHEN v_n IS NULL OR v_n !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$'
                OR EXISTS (SELECT 1 FROM public.epa_registrations WHERE epa_registration = v_n);
      PERFORM public._product_parent_require_admin();
      IF jsonb_typeof(v_f->'is_rup') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'EPA_REGISTRATION_FACTS_REQUIRED: EPA number % has no registration yet; fill its label columns, including restricted use', v_n;
      END IF;
      -- A new number's registration comes from this row's label columns (sheet 4.B); RUP Yes when ticked,
      -- else Mason's Q1 default.
      v_facts := jsonb_build_object('rup_status', CASE WHEN (v_f->>'is_rup')::boolean THEN 'yes' ELSE public._epa_rup_default() END)
        || jsonb_strip_nulls(jsonb_build_object(
             'signal_word', to_jsonb(NULLIF(btrim(v_f->>'signal_word'), '')),
             'rei_hours', v_f->'rei_hours', 'phi_days', v_f->'phi_days',
             'max_label_rate', to_jsonb(NULLIF(btrim(v_f->>'max_label_rate'), '')),
             'max_label_rate_unit', to_jsonb(NULLIF(btrim(v_f->>'max_label_rate_unit'), ''))));
      PERFORM public._epa_registration_facts(v_facts, true);
      v_reg := public._epa_registration_insert(v_n, v_facts);
      PERFORM public._epa_registration_event(v_n, 'created', 'new product', NULL, to_jsonb(v_reg), '[]'::jsonb);
    END LOOP;
  END IF;
  RETURN public._apply_product_setup_reg1_impl(p_rows, p_performed_by, p_idempotency_key);
END;
$function$;
ALTER FUNCTION public.apply_product_setup(jsonb, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_product_setup(jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_product_setup(jsonb, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Brand saves: p_new_registration added last
-- ---------------------------------------------------------------------------------------------

ALTER FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text)
  RENAME TO _upsert_product_brand_reg1_impl;
REVOKE ALL ON FUNCTION public._upsert_product_brand_reg1_impl(uuid, text, text, text, boolean, boolean, text, uuid, integer, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.upsert_product_brand(p_product_id uuid, p_brand_name text, p_epa_registration text,
  p_manufacturer text, p_is_currently_sourced boolean, p_is_rup boolean, p_signal_word text,
  p_brand_id uuid DEFAULT NULL::uuid, p_expected_row_version integer DEFAULT NULL::integer,
  p_idempotency_key text DEFAULT NULL::text, p_new_registration jsonb DEFAULT NULL::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  -- Admin before the company-wide lock (the impl's own check and message).
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only an admin can change a product''s brands' USING ERRCODE = '42501';
  END IF;
  PERFORM public._epa_registration_lock(true);
  PERFORM public._epa_registration_ensure(p_epa_registration, p_new_registration, 'new brand number');
  RETURN public._upsert_product_brand_reg1_impl(p_product_id, p_brand_name, p_epa_registration, p_manufacturer,
    p_is_currently_sourced, p_is_rup, p_signal_word, p_brand_id, p_expected_row_version, p_idempotency_key);
END;
$function$;
ALTER FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text, jsonb) TO authenticated;

ALTER FUNCTION public.upsert_parent_brand(uuid, uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text)
  RENAME TO _upsert_parent_brand_reg1_impl;
REVOKE ALL ON FUNCTION public._upsert_parent_brand_reg1_impl(uuid, uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.upsert_parent_brand(p_parent_id uuid, p_product_id uuid, p_brand_name text,
  p_epa_registration text, p_manufacturer text, p_is_currently_sourced boolean, p_is_rup boolean,
  p_signal_word text, p_brand_id uuid DEFAULT NULL::uuid, p_expected_row_version integer DEFAULT NULL::integer,
  p_retire boolean DEFAULT false, p_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text,
  p_new_registration jsonb DEFAULT NULL::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM public._product_parent_require_admin();  -- before the company-wide lock (the impl's own check)
  PERFORM public._epa_registration_lock(true);
  PERFORM public._epa_registration_ensure(p_epa_registration, p_new_registration, 'new brand number');
  RETURN public._upsert_parent_brand_reg1_impl(p_parent_id, p_product_id, p_brand_name, p_epa_registration,
    p_manufacturer, p_is_currently_sourced, p_is_rup, p_signal_word, p_brand_id, p_expected_row_version,
    p_retire, p_reason, p_idempotency_key);
END;
$function$;
ALTER FUNCTION public.upsert_parent_brand(uuid, uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.upsert_parent_brand(uuid, uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_parent_brand(uuid, uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text, jsonb) TO authenticated;

DO $postflight$
BEGIN
  IF has_function_privilege('authenticated', 'public._apply_product_setup_reg1_impl(jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._upsert_product_brand_reg1_impl(uuid,text,text,text,boolean,boolean,text,uuid,integer,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._upsert_parent_brand_reg1_impl(uuid,uuid,text,text,text,boolean,boolean,text,uuid,integer,boolean,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._epa_registration_ensure(text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._commit_label_draft_replay_impl_20261015(uuid,text,text,integer,integer,text,numeric,text,boolean,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.apply_product_setup(jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.upsert_product_brand(uuid,text,text,text,boolean,boolean,text,uuid,integer,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.upsert_parent_brand(uuid,uuid,text,text,text,boolean,boolean,text,uuid,integer,boolean,text,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.apply_product_setup(jsonb,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.upsert_product_brand(uuid,text,text,text,boolean,boolean,text,uuid,integer,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.upsert_parent_brand(uuid,uuid,text,text,text,boolean,boolean,text,uuid,integer,boolean,text,text,jsonb)', 'EXECUTE')
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
           AND proname IN ('apply_product_setup', 'upsert_product_brand', 'upsert_parent_brand')) <> 3 THEN
    RAISE EXCEPTION 'POSTFLIGHT_EPA_REGISTRATION_DRAFT_SETUP_GRANTS_WRONG';
  END IF;
END;
$postflight$;
