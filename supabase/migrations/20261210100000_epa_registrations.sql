-- idempotency-body-check: exempt
-- (set_epa_registration and assign_epa_registration require p_idempotency_key but, in this file, always
--  refuse with EPA_REGISTRATION_NOT_SEEDED after the admin and key checks: they write nothing, so there is
--  no receipt to save. Their working bodies, with _product_parent_replay and save_idempotency, ship with
--  the seed and the guards. create_label_draft and bulk_create_label_drafts keep their 2026-10-15 wrappers.)
--
-- Written 2026-11-07. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261210100000_epa_registrations.md.
-- Re-read the live ledger before applying.
--
-- WHY: REG-1 (docs/plans/2026-11-06-product-REG1-BUILD-SHEET.md, Mason's answers in 11.1) keeps one
--   registration per EPA number, holding the facts printed on that label, so every size and brand that
--   carries the number reads the same facts. This is REG-1's first database step: storage only. No
--   registration can exist yet: the seed that creates them ships in the same later PR as the guards and
--   the invoice-line sale capture (the sheet's rule: guards exist before any registration does).
--
-- WHAT:
--   - epa_registrations: one row per normalized EPA number (strict format), status, label link, and the
--     label facts (signal word, RUP as yes/no/unknown, REI, PHI, label max rate and unit, adjuvants).
--     Read by any active user; no write grant.
--   - epa_registration_events: append-only log. Read by any active user; no write grant.
--   - label_draft_targets: private (no grants). One row per label draft created from now on: the draft's
--     number, the product's number and label fingerprint at that moment, the registration version (NULL
--     while none exists) and the values the draft was created with. The draft commit (later PR) checks
--     against it instead of the client-editable draft row.
--   - create_label_draft and bulk_create_label_drafts implementations re-issued from their live bodies
--     with one addition each: write that target row. Public wrappers unchanged.
--   - get_epa_registrations (any active user), and set_epa_registration, preview_epa_assignment and
--     assign_epa_registration (admin) at their final signatures; the admin ones refuse
--     EPA_REGISTRATION_NOT_SEEDED until the seed ships.
--
-- NOT CHANGED: products, brands, invoices, invoice lines, label-draft wrappers, grants on existing tables.
--   No live row is written by this file (0 label drafts exist live, 2026-11-06).
--
-- LOCKS: the draft-create functions take pg_advisory_xact_lock_shared(20261210, hashtext('crx_epa_registration'))
--   (two-key form, so no single-key lock hashed from a client's retry key can collide with it; every later
--   holder of the REG-1 lock uses the same pair)
--   before reading the product's number (sheet 3.2); nothing takes it exclusively yet.
--
-- ROLLBACK (its own reviewed migration): re-emit the two _replay_impl_20261015 bodies from their previous
--   live definitions (md5 pinned below), drop the four new public functions, the helpers, and the three tables.
--
-- ORDERING: apply after 20261209100000_product_chemistry and every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE epa_registrations_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.epa_registrations_tx') IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATIONS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.epa_registrations_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'EPA_REGISTRATIONS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regclass('public.epa_registrations') IS NOT NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATIONS_PREFLIGHT: this file was already applied';
  END IF;
  IF to_regprocedure('public._product_parent_require_admin()') IS NULL
     OR to_regprocedure('public._normalize_epa_registration(text)') IS NULL
     OR to_regprocedure('public.is_active_profile()') IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATIONS_PREFLIGHT: PAR-1 helpers missing';
  END IF;
  -- The two re-emitted implementations must still be the bodies this file was written from.
  IF (SELECT count(*) FROM pg_proc p
       WHERE (p.oid, md5(replace(p.prosrc, chr(13), ''))) IN (
         (to_regprocedure('public._create_label_draft_replay_impl_20261015(uuid,text,integer,integer,text,numeric,text,text,text,text,text)'),
          'd045cb53cc7e121aedc454d9e306cffc'),
         (to_regprocedure('public._bulk_create_label_drafts_replay_impl_20261015(jsonb,text)'),
          '95975e8bb75dfd5d89c15922fa194c31'))
         AND p.proowner = 'postgres'::regrole AND p.prosecdef) <> 2 THEN
    RAISE EXCEPTION 'EPA_REGISTRATIONS_PREFLIGHT: a re-emitted function drifted from the body this file was written from';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
              AND proname IN ('set_epa_registration', 'assign_epa_registration', 'preview_epa_assignment',
                              'get_epa_registrations')) THEN
    RAISE EXCEPTION 'EPA_REGISTRATIONS_PREFLIGHT: a REG-1 function already exists';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------

-- NULL = adjuvants not reviewed; '[]' = reviewed, none on the label.
CREATE FUNCTION public._epa_label_adjuvants_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT p IS NULL OR (
    jsonb_typeof(p) = 'array' AND jsonb_array_length(p) <= 50
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p) e
       WHERE jsonb_typeof(e) <> 'object'
          OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('kind', 'adjuvant_type', 'note'))
          OR jsonb_typeof(e->'kind') IS DISTINCT FROM 'string'
          OR e->>'kind' NOT IN ('required', 'recommended')
          OR jsonb_typeof(e->'adjuvant_type') IS DISTINCT FROM 'string'
          OR btrim(e->>'adjuvant_type') = '' OR length(e->>'adjuvant_type') > 100
          OR (e ? 'note' AND jsonb_typeof(e->'note') NOT IN ('string', 'null'))
          OR length(COALESCE(e->>'note', '')) > 500));
$function$;
ALTER FUNCTION public._epa_label_adjuvants_valid(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._epa_label_adjuvants_valid(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.epa_registrations (
  epa_registration text PRIMARY KEY
    CHECK (epa_registration ~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$'),
  registration_status text NOT NULL DEFAULT 'unknown' CHECK (registration_status IN ('active', 'cancelled', 'unknown')),
  cancelled_on date,
  label_url text CHECK (label_url IS NULL OR (label_url ~ '^https://[^[:space:]]+$' AND length(label_url) <= 2000)),
  label_accepted_on date,
  source text CHECK (source IS NULL OR (btrim(source) <> '' AND length(source) <= 500)),
  checked_at timestamptz,
  signal_word text CHECK (signal_word IS NULL OR signal_word IN ('Danger', 'Warning', 'Caution')),
  rup_status text NOT NULL DEFAULT 'unknown' CHECK (rup_status IN ('yes', 'no', 'unknown')),
  rei_hours integer CHECK (rei_hours IS NULL OR rei_hours >= 0),
  phi_days integer CHECK (phi_days IS NULL OR phi_days >= 0),
  -- NaN sorts above every number in PostgreSQL, so >= 0 alone would admit it and Infinity.
  max_label_rate numeric CHECK (max_label_rate IS NULL OR (max_label_rate >= 0 AND max_label_rate < 'Infinity'::numeric)),
  max_label_rate_unit text CHECK (max_label_rate_unit IS NULL OR (btrim(max_label_rate_unit) <> '' AND length(max_label_rate_unit) <= 40)),
  label_adjuvants jsonb DEFAULT NULL CHECK (public._epa_label_adjuvants_valid(label_adjuvants)),
  registration_version bigint NOT NULL DEFAULT 1 CHECK (registration_version >= 1),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set by every writer (no updated_at trigger), with registration_version, in the same statement.
  updated_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((registration_status = 'cancelled') = (cancelled_on IS NOT NULL)),
  -- A label rate means nothing without its unit, and a unit nothing without its rate.
  CONSTRAINT epa_registrations_rate_unit_pair CHECK ((max_label_rate IS NULL) = (max_label_rate_unit IS NULL))
);
ALTER TABLE public.epa_registrations OWNER TO postgres;
COMMENT ON TABLE public.epa_registrations IS
  'REG-1: one row per EPA registration number with the facts printed on that label. Written only by the REG-1 functions.';

CREATE TABLE public.epa_registration_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  epa_registration text NOT NULL REFERENCES public.epa_registrations(epa_registration) ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('seeded', 'created', 'updated', 'assigned', 'draft_committed')),
  reason text,
  before_values jsonb,
  after_values jsonb,
  affected jsonb NOT NULL DEFAULT '[]'::jsonb,
  changed_by uuid NOT NULL,  -- no foreign key, as product_parent_events: the log outlives a profile
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.epa_registration_events OWNER TO postgres;
CREATE INDEX epa_registration_events_number_idx ON public.epa_registration_events (epa_registration, changed_at DESC, id DESC);
COMMENT ON TABLE public.epa_registration_events IS
  'REG-1: append-only log of registration changes; affected holds each parent, size or brand written.';

-- Private: what a label draft was checked against when it was created. Read only by the draft commit.
CREATE TABLE public.label_draft_targets (
  draft_id uuid PRIMARY KEY REFERENCES public.product_label_drafts(id) ON DELETE CASCADE,
  epa_registration text,
  product_epa_registration text,
  product_id uuid NOT NULL,
  product_label_fingerprint text NOT NULL,
  registration_version bigint,
  proposed_values jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.label_draft_targets OWNER TO postgres;
COMMENT ON TABLE public.label_draft_targets IS
  'Internal (REG-1): a label draft''s numbers, product fingerprint, registration version and proposed values at creation. No API role can read or write it.';

ALTER TABLE public.epa_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.epa_registration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.label_draft_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY epa_registrations_select ON public.epa_registrations
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY epa_registration_events_select ON public.epa_registration_events
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY label_draft_targets_none ON public.label_draft_targets
  FOR ALL TO authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.epa_registrations, public.epa_registration_events, public.label_draft_targets
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON SEQUENCE public.epa_registration_events_id_seq FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.epa_registrations, public.epa_registration_events TO authenticated;

CREATE FUNCTION public.refuse_epa_registration_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'EPA_REGISTRATION_EVENTS_ARE_APPEND_ONLY';
END;
$function$;
ALTER FUNCTION public.refuse_epa_registration_event_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_epa_registration_event_mutation() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER epa_registration_events_append_only
  BEFORE UPDATE OR DELETE ON public.epa_registration_events
  FOR EACH ROW EXECUTE FUNCTION public.refuse_epa_registration_event_mutation();
CREATE TRIGGER epa_registration_events_no_truncate
  BEFORE TRUNCATE ON public.epa_registration_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_epa_registration_event_mutation();

-- ---------------------------------------------------------------------------------------------
-- 2. Draft targets: written when a label draft is created
-- ---------------------------------------------------------------------------------------------

-- The product's label facts and number as one value; the draft commit compares it later.
CREATE FUNCTION public._product_label_fingerprint(p_product_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT md5(jsonb_build_object('epa_registration', public._normalize_epa_registration(p.epa_registration),
    'signal_word', p.signal_word, 'is_rup', p.is_rup, 'rei_hours', p.rei_hours, 'phi_days', p.phi_days,
    'max_label_rate', p.max_label_rate, 'max_label_rate_unit', p.max_label_rate_unit)::text)
  FROM public.products p WHERE p.id = p_product_id;
$function$;
ALTER FUNCTION public._product_label_fingerprint(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_label_fingerprint(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Records the target of a draft just inserted in this transaction (values read from the row itself,
-- which no client can have edited yet). Takes the registration lock in shared mode first (sheet 3.2).
CREATE FUNCTION public._record_label_draft_target(p_draft_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_draft public.product_label_drafts%ROWTYPE;
  v_product_epa text;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(20261210, hashtext('crx_epa_registration'));
  SELECT * INTO STRICT v_draft FROM public.product_label_drafts WHERE id = p_draft_id;
  SELECT public._normalize_epa_registration(p.epa_registration) INTO STRICT v_product_epa
    FROM public.products p WHERE p.id = v_draft.product_id;
  INSERT INTO public.label_draft_targets (draft_id, epa_registration, product_epa_registration, product_id,
    product_label_fingerprint, registration_version, proposed_values)
  VALUES (v_draft.id, public._normalize_epa_registration(v_draft.epa_registration), v_product_epa, v_draft.product_id,
    public._product_label_fingerprint(v_draft.product_id),
    (SELECT r.registration_version FROM public.epa_registrations r WHERE r.epa_registration = v_product_epa),
    jsonb_build_object('signal_word', v_draft.signal_word, 'rei_hours', v_draft.rei_hours, 'phi_days', v_draft.phi_days,
      'epa_registration', v_draft.epa_registration, 'max_label_rate', v_draft.max_label_rate,
      'max_label_rate_unit', v_draft.max_label_rate_unit));
END;
$function$;
ALTER FUNCTION public._record_label_draft_target(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._record_label_draft_target(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Live body (md5 d045cb53cc7e121aedc454d9e306cffc) plus the target row after the insert.
CREATE OR REPLACE FUNCTION public._create_label_draft_replay_impl_20261015(p_product_id uuid, p_signal_word text DEFAULT NULL::text, p_rei_hours integer DEFAULT NULL::integer, p_phi_days integer DEFAULT NULL::integer, p_epa_registration text DEFAULT NULL::text, p_max_label_rate numeric DEFAULT NULL::numeric, p_max_label_rate_unit text DEFAULT NULL::text, p_source_note text DEFAULT ''::text, p_confidence text DEFAULT 'low'::text, p_status text DEFAULT 'pending'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id   uuid := auth.uid();
  v_draft_id  uuid;
  v_cached    jsonb;
BEGIN
  -- Auth gate: admin only
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: admin role required';
  END IF;

  -- A new draft is never created already-decided: clamp to a reviewable status so a row can't
  -- enter the queue as accepted/edited/rejected (which would bypass human review).
  IF p_status NOT IN ('pending', 'needs_manual') THEN
    p_status := 'pending';
  END IF;

  -- Non-negativity guard: regulatory intervals/rates can never be negative.
  -- (Reject at staging so an impossible value can't even be drafted.)
  IF p_rei_hours IS NOT NULL AND p_rei_hours < 0 THEN
    RAISE EXCEPTION 'INVALID_LABEL_VALUE: rei_hours must be >= 0 (got %)', p_rei_hours;
  END IF;
  IF p_phi_days IS NOT NULL AND p_phi_days < 0 THEN
    RAISE EXCEPTION 'INVALID_LABEL_VALUE: phi_days must be >= 0 (got %)', p_phi_days;
  END IF;
  IF p_max_label_rate IS NOT NULL AND p_max_label_rate < 0 THEN
    RAISE EXCEPTION 'INVALID_LABEL_VALUE: max_label_rate must be >= 0 (got %)', p_max_label_rate;
  END IF;

  -- Idempotency: return cached result if same key already processed
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached
    FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key
      AND operation       = 'create_label_draft';
    IF FOUND THEN
      RETURN (v_cached->>'draft_id')::uuid;
    END IF;
  END IF;

  -- Insert the draft
  INSERT INTO product_label_drafts (
    product_id, signal_word, rei_hours, phi_days, epa_registration,
    max_label_rate, max_label_rate_unit,
    source_note, confidence, status, created_by, run_idempotency_key
  ) VALUES (
    p_product_id, p_signal_word, p_rei_hours, p_phi_days, p_epa_registration,
    p_max_label_rate, p_max_label_rate_unit,
    p_source_note, p_confidence, p_status, v_user_id, p_idempotency_key
  )
  RETURNING id INTO v_draft_id;

  -- REG-1: record what the draft is checked against at commit.
  PERFORM public._record_label_draft_target(v_draft_id);

  -- Store idempotency result
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_label_draft', jsonb_build_object('draft_id', v_draft_id))
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_draft_id;
END;
$function$;
REVOKE ALL ON FUNCTION public._create_label_draft_replay_impl_20261015(uuid,text,integer,integer,text,numeric,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Live body (md5 95975e8bb75dfd5d89c15922fa194c31) plus the target row after each insert.
CREATE OR REPLACE FUNCTION public._bulk_create_label_drafts_replay_impl_20261015(p_drafts jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id  uuid := auth.uid();
  v_cached   jsonb;
  v_item     jsonb;
  v_ids      uuid[] := '{}';
  v_draft_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: admin role required';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached
    FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key
      AND operation       = 'bulk_create_label_drafts';
    IF FOUND THEN RETURN v_cached; END IF;
  END IF;

  FOR v_item IN SELECT jsonb_array_elements(p_drafts)
  LOOP
    -- Non-negativity guard: reject impossible regulatory values per element.
    IF (v_item->>'rei_hours') IS NOT NULL AND (v_item->>'rei_hours')::integer < 0 THEN
      RAISE EXCEPTION 'INVALID_LABEL_VALUE: rei_hours must be >= 0 (got %)', v_item->>'rei_hours';
    END IF;
    IF (v_item->>'phi_days') IS NOT NULL AND (v_item->>'phi_days')::integer < 0 THEN
      RAISE EXCEPTION 'INVALID_LABEL_VALUE: phi_days must be >= 0 (got %)', v_item->>'phi_days';
    END IF;
    IF (v_item->>'max_label_rate') IS NOT NULL AND (v_item->>'max_label_rate')::numeric < 0 THEN
      RAISE EXCEPTION 'INVALID_LABEL_VALUE: max_label_rate must be >= 0 (got %)', v_item->>'max_label_rate';
    END IF;

    INSERT INTO product_label_drafts (
      product_id, signal_word, rei_hours, phi_days, epa_registration,
      max_label_rate, max_label_rate_unit,
      source_note, confidence, status, created_by, run_idempotency_key
    ) VALUES (
      (v_item->>'product_id')::uuid,
      v_item->>'signal_word',
      (v_item->>'rei_hours')::integer,
      (v_item->>'phi_days')::integer,
      v_item->>'epa_registration',
      (v_item->>'max_label_rate')::numeric,
      v_item->>'max_label_rate_unit',
      COALESCE(v_item->>'source_note', ''),
      COALESCE(v_item->>'confidence', 'low'),
      -- clamp to a reviewable status: a bulk-created row never enters the queue already-decided
      CASE WHEN v_item->>'status' IN ('pending','needs_manual') THEN v_item->>'status' ELSE 'pending' END,
      v_user_id,
      p_idempotency_key
    )
    RETURNING id INTO v_draft_id;
    -- REG-1: record what the draft is checked against at commit.
    PERFORM public._record_label_draft_target(v_draft_id);
    v_ids := array_append(v_ids, v_draft_id);
  END LOOP;

  DECLARE
    v_result jsonb := jsonb_build_object('draft_ids', to_jsonb(v_ids), 'count', array_length(v_ids, 1));
  BEGIN
    IF p_idempotency_key IS NOT NULL THEN
      INSERT INTO idempotency_keys (idempotency_key, operation, result)
      VALUES (p_idempotency_key, 'bulk_create_label_drafts', v_result)
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
    RETURN v_result;
  END;
END;
$function$;
REVOKE ALL ON FUNCTION public._bulk_create_label_drafts_replay_impl_20261015(jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Registration functions
-- ---------------------------------------------------------------------------------------------

-- Registrations for the given numbers (normalized; all when NULL). Any active user; no cost or price.
CREATE FUNCTION public.get_epa_registrations(p_numbers text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_profile() THEN RAISE EXCEPTION 'ACTIVE_USER_REQUIRED'; END IF;
  IF cardinality(p_numbers) > 5000 THEN RAISE EXCEPTION 'EPA_REGISTRATION_TOO_MANY: ask for at most 5000 numbers'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(r) ORDER BY r.epa_registration)
      FROM public.epa_registrations r
     WHERE p_numbers IS NULL
        OR r.epa_registration IN (SELECT public._normalize_epa_registration(n) FROM unnest(p_numbers) n)), '[]'::jsonb);
END;
$function$;
ALTER FUNCTION public.get_epa_registrations(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_epa_registrations(text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_epa_registrations(text[]) TO authenticated;

-- The admin registration tools at their final signatures. Until the seed (a later PR, together with the
-- guards and the invoice-line sale capture) no registration exists, so each refuses after the admin and
-- request checks. The later PR replaces these bodies.
CREATE FUNCTION public._epa_registration_target_table(p_target_table text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
BEGIN
  IF p_target_table IS NULL OR p_target_table NOT IN ('products', 'product_brands', 'product_parent_brands') THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_TARGET_TABLE: target must be products, product_brands or product_parent_brands';
  END IF;
END;
$function$;
ALTER FUNCTION public._epa_registration_target_table(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._epa_registration_target_table(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.set_epa_registration(p_epa_registration text, p_expected_version bigint, p_changes jsonb,
  p_reason text, p_label_draft_id uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  RAISE EXCEPTION 'EPA_REGISTRATION_NOT_SEEDED: EPA registrations are not set up yet';
END;
$function$;
ALTER FUNCTION public.set_epa_registration(text, bigint, jsonb, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_epa_registration(text, bigint, jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_epa_registration(text, bigint, jsonb, text, uuid, text) TO authenticated;

CREATE FUNCTION public.preview_epa_assignment(p_target_table text, p_target_id uuid, p_new_number text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
BEGIN
  PERFORM public._epa_registration_target_table(p_target_table);
  RAISE EXCEPTION 'EPA_REGISTRATION_NOT_SEEDED: EPA registrations are not set up yet';
END;
$function$;
ALTER FUNCTION public.preview_epa_assignment(text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_epa_assignment(text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_epa_assignment(text, uuid, text) TO authenticated;

CREATE FUNCTION public.assign_epa_registration(p_target_table text, p_target_id uuid, p_new_number text,
  p_new_registration jsonb, p_expected_target_fingerprint text, p_expected_new_version bigint, p_reason text,
  p_label_draft_id uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
BEGIN
  PERFORM public._epa_registration_target_table(p_target_table);
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  RAISE EXCEPTION 'EPA_REGISTRATION_NOT_SEEDED: EPA registrations are not set up yet';
END;
$function$;
ALTER FUNCTION public.assign_epa_registration(text, uuid, text, jsonb, text, bigint, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assign_epa_registration(text, uuid, text, jsonb, text, bigint, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assign_epa_registration(text, uuid, text, jsonb, text, bigint, text, uuid, text) TO authenticated;

DO $postflight$
BEGIN
  IF has_table_privilege('authenticated', 'public.label_draft_targets', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon', 'public.epa_registrations', 'SELECT')
     OR has_table_privilege('anon', 'public.epa_registration_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.epa_registrations', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.epa_registration_events', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_function_privilege('authenticated', 'public._record_label_draft_target(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._product_label_fingerprint(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._create_label_draft_replay_impl_20261015(uuid,text,integer,integer,text,numeric,text,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._bulk_create_label_drafts_replay_impl_20261015(jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_epa_registrations(text[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.assign_epa_registration(text,uuid,text,jsonb,text,bigint,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_epa_registrations(text[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_epa_registration(text,bigint,jsonb,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_label_draft(uuid,text,integer,integer,text,numeric,text,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_EPA_REGISTRATIONS_GRANTS_WRONG';
  END IF;
END;
$postflight$;
