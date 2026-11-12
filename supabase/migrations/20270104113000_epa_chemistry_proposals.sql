-- idempotency-body-check: exempt
-- (start_epa_lookup, commit_epa_proposal and reject_epa_proposal require p_idempotency_key and check it before any
--  write with PAR-1's _product_parent_replay(key, scope, fingerprint), then save their receipt with save_idempotency.
--  record_epa_lookup runs under the service role, where auth.uid() is empty, so it does the same steps by hand with
--  check_idempotency against p_actor. The hook only recognises check_idempotency.)
-- actor-binding-check: exempt
-- (record_epa_lookup's p_actor: the function is granted to service_role ONLY (postflight proves no authenticated or
--  anon EXECUTE), so no browser can call it, and under the service role auth.uid() is empty and cannot bind it.
--  The epa-lookup Edge Function passes the caller it verified from the JWT. The body still binds p_actor: it must be
--  the admin who started the lookup (epa_lookups.requested_by, written from auth.uid() by start_epa_lookup) and an
--  active admin, else EPA_LOOKUP_ACTOR.)
-- Written 2026-11-11. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270104113000_epa_chemistry_proposals.md.
-- Re-read the live ledger before applying.
--
-- WHY: Product Master DM-4, EPA auto-fill (docs/plans/2026-11-08-product-DM4-BUILD-SHEET.md, its section 13 for
--   what changed by 2026-11-11). An admin looks up one EPA number of a product parent; EPA's answer becomes a
--   proposal (chemistry items for the parent, label-fact items for the registration) or a failure listed by number.
--   Nothing is written to chemistry or a registration until an admin commits the proposal (D-I). Chemistry typed in
--   stays live when EPA disagrees: the difference is kept on the proposal and shown, never written (D-L).
--
-- WHAT:
--   - epa_lookups (one request), epa_lookup_failures (append-only), epa_chemistry_proposals. RLS on; admins read;
--     no client writes. epa_lookups is also readable by service_role (the epa-lookup Edge Function reads the row).
--   - start_epa_lookup, commit_epa_proposal, reject_epa_proposal: admin, granted to authenticated.
--   - record_epa_lookup: service_role ONLY. EPA's answer reaches the database only from the Edge Function, with the
--     verified caller as p_actor; a browser cannot submit a made-up "EPA result" (D-Z).
--   - Private helpers (no grants): the link finder, the result shape check, the result normalizer, the item sorter.
--   - _parent_chemistry_epa_refusal re-issued (same signature, owner and no grants): a number is excused only
--     when its newest non-abandoned lookup failed as not_found, bound to the registration's current version and a
--     link that still carries the number, and no proposal of any status (even rejected or superseded) exists for it.
--
-- NOT CHANGED: every DM-1 / DM-1b / REG-1 function other than the gate; every existing row and grant. The new
--   functions are called by nothing until the DM-4 screens PR and the epa-lookup record step ship.
--
-- LOCKS: the REG-1 advisory pair (20261210, hashtext('crx_epa_registration')), shared in start and record, exclusive
--   in commit; then the registration row; then the parent (commit: _lock_parent_chemistry); then the link row; then
--   DM-4's own rows. reject locks only its proposal.
--
-- ROLLBACK (its own reviewed migration): re-issue the gate from 20261209100000 (md5 pinned below) first, then revoke
--   EXECUTE on the four RPCs and SELECT on the three tables, then drop the four RPCs; keep the tables as history. Committed chemistry is
--   undone by a DM-1 correction, a committed label fact by set_epa_registration.
--
-- ORDERING: after 20270103160000_setup_workbook_chemistry_tabs (DM-1b, live) and every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE epa_chemistry_proposals_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.epa_chemistry_proposals_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.epa_chemistry_proposals_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'EPA_CHEMISTRY_PROPOSALS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regclass('public.epa_lookups') IS NOT NULL OR to_regclass('public.epa_chemistry_proposals') IS NOT NULL
     OR to_regclass('public.epa_lookup_failures') IS NOT NULL THEN
    RAISE EXCEPTION 'EPA_CHEMISTRY_PROPOSALS_PREFLIGHT: this file was already applied';
  END IF;
  IF to_regclass('public.epa_registration_seed_run') IS NULL
     OR to_regprocedure('public._epa_registration_update(text,jsonb)') IS NULL
     OR to_regprocedure('public._epa_registration_facts(jsonb,boolean)') IS NULL
     OR to_regprocedure('public._epa_registration_event(text,text,text,jsonb,jsonb,jsonb)') IS NULL
     OR to_regprocedure('public._epa_registration_lock(boolean)') IS NULL
     OR to_regprocedure('public._epa_registration_unrecorded_posted_lines(text)') IS NULL
     OR to_regprocedure('public._epa_registrations_seeded()') IS NULL THEN
    RAISE EXCEPTION 'EPA_CHEMISTRY_PROPOSALS_PREFLIGHT: apply REG-1 step 2 (20261231200000) first';
  END IF;
  IF to_regprocedure('public._apply_parent_chemistry(uuid,jsonb,text,text,text)') IS NULL
     OR to_regprocedure('public._lock_parent_chemistry(uuid,bigint)') IS NULL
     OR to_regprocedure('public._ingredient_cas_valid(text)') IS NULL
     OR to_regprocedure('public._product_parent_replay(text,text,text)') IS NULL
     OR to_regprocedure('public._product_parent_require_admin()') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regprocedure('public.check_idempotency(text,text)') IS NULL THEN
    RAISE EXCEPTION 'EPA_CHEMISTRY_PROPOSALS_PREFLIGHT: DM-1 or PAR-1 helpers missing';
  END IF;
  -- The replaced gate must still be DM-1's body (20261209100000), owned by postgres, SECURITY DEFINER, no app grant.
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._parent_chemistry_epa_refusal(uuid)')
         AND md5(replace(p.prosrc, chr(13), '')) = 'c64e2bee1c7499cf6ff509168885a0f9'
         AND p.proowner = 'postgres'::regrole AND p.prosecdef
         AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) <> 1 THEN
    RAISE EXCEPTION 'EPA_CHEMISTRY_PROPOSALS_PREFLIGHT: _parent_chemistry_epa_refusal drifted from the body this file was written from';
  END IF;
  -- DM-4 writes epa-sourced chemistry through DM-1's writer; its 'epa' mode must still be the one this file relies on.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public._apply_parent_chemistry(uuid,jsonb,text,text,text)')
                  AND prosrc LIKE '%CHEMISTRY_TYPED_ROW_KEPT%' AND prosrc LIKE '%p_mode <> ''epa''%') THEN
    RAISE EXCEPTION 'EPA_CHEMISTRY_PROPOSALS_PREFLIGHT: _apply_parent_chemistry has no EPA mode';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.epa_lookups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  epa_registration text NOT NULL REFERENCES public.epa_registrations(epa_registration) ON UPDATE RESTRICT ON DELETE RESTRICT,
  link_kind text NOT NULL CHECK (link_kind IN ('parent', 'size', 'parent_brand', 'legacy_brand')),
  link_id uuid NOT NULL,
  registration_version bigint NOT NULL CHECK (registration_version >= 1),
  chemistry_version bigint NOT NULL CHECK (chemistry_version >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'recorded', 'abandoned')),
  requested_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT epa_lookups_recorded_at CHECK ((status = 'recorded') = (recorded_at IS NOT NULL))
);
ALTER TABLE public.epa_lookups OWNER TO postgres;
CREATE INDEX epa_lookups_parent_number_idx ON public.epa_lookups (parent_id, epa_registration, requested_at DESC, id DESC);
COMMENT ON TABLE public.epa_lookups IS
  'DM-4: one EPA lookup request for one number of one product parent, bound to the parent link and the registration and chemistry versions at start. Written only by start_epa_lookup and record_epa_lookup.';

-- Append-only: whether a failure is still current is worked out by query (the gate), never by a flag.
CREATE TABLE public.epa_lookup_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lookup_id uuid NOT NULL UNIQUE REFERENCES public.epa_lookups(id) ON DELETE RESTRICT,
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  epa_registration text NOT NULL REFERENCES public.epa_registrations(epa_registration) ON UPDATE RESTRICT ON DELETE RESTRICT,
  link_kind text NOT NULL CHECK (link_kind IN ('parent', 'size', 'parent_brand', 'legacy_brand')),
  link_id uuid NOT NULL,
  registration_version bigint NOT NULL CHECK (registration_version >= 1),
  reason text NOT NULL CHECK (reason IN ('not_found', 'transferred', 'upstream_error', 'invalid_result')),
  transferred_to text CHECK (transferred_to IS NULL OR transferred_to ~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$'),
  detail text CHECK (detail IS NULL OR length(detail) <= 500),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT epa_lookup_failures_transferred CHECK ((reason = 'transferred') = (transferred_to IS NOT NULL))
);
ALTER TABLE public.epa_lookup_failures OWNER TO postgres;
CREATE INDEX epa_lookup_failures_number_idx ON public.epa_lookup_failures (epa_registration, created_at DESC);
COMMENT ON TABLE public.epa_lookup_failures IS
  'DM-4: a lookup that produced nothing usable, listed by number. Append-only; nothing is written for it.';

CREATE TABLE public.epa_chemistry_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lookup_id uuid NOT NULL UNIQUE REFERENCES public.epa_lookups(id) ON DELETE RESTRICT,
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  epa_registration text NOT NULL REFERENCES public.epa_registrations(epa_registration) ON UPDATE RESTRICT ON DELETE RESTRICT,
  link_kind text NOT NULL CHECK (link_kind IN ('parent', 'size', 'parent_brand', 'legacy_brand')),
  link_id uuid NOT NULL,
  -- the versions the items were sorted against (taken when the result was recorded)
  registration_version bigint NOT NULL CHECK (registration_version >= 1),
  chemistry_version bigint NOT NULL CHECK (chemistry_version >= 0),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'held', 'committed', 'rejected', 'superseded')),
  proposal_version bigint NOT NULL DEFAULT 1 CHECK (proposal_version >= 1),
  hold_reason text CHECK (hold_reason IS NULL OR hold_reason IN ('relinked', 'chemistry_changed', 'registration_changed')),
  epa_input jsonb NOT NULL,
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  epa_summary jsonb NOT NULL CHECK (jsonb_typeof(epa_summary) = 'object'),
  decided_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR (btrim(decision_reason) <> '' AND length(decision_reason) <= 500)),
  commit_result jsonb,
  superseded_by_lookup_id uuid REFERENCES public.epa_lookups(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT epa_chemistry_proposals_held CHECK ((status = 'held') = (hold_reason IS NOT NULL)),
  CONSTRAINT epa_chemistry_proposals_decided CHECK (status IN ('proposed', 'held', 'superseded') OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  CONSTRAINT epa_chemistry_proposals_rejected CHECK (status <> 'rejected' OR decision_reason IS NOT NULL),
  CONSTRAINT epa_chemistry_proposals_superseded CHECK ((status = 'superseded') = (superseded_by_lookup_id IS NOT NULL))
);
ALTER TABLE public.epa_chemistry_proposals OWNER TO postgres;
CREATE UNIQUE INDEX epa_chemistry_proposals_one_open ON public.epa_chemistry_proposals (epa_registration, parent_id)
  WHERE status IN ('proposed', 'held');
CREATE INDEX epa_chemistry_proposals_parent_idx ON public.epa_chemistry_proposals (parent_id, epa_registration, status);
COMMENT ON TABLE public.epa_chemistry_proposals IS
  'DM-4: what a successful EPA lookup suggests for a parent''s chemistry and its registration''s label facts. Written to chemistry and the registration only when an admin commits it (D-I); differences from typed values are kept here and shown, never written (D-L).';

-- Status changes and frozen columns (sheet 3.2).
CREATE FUNCTION public.refuse_epa_proposal_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'EPA_PROPOSAL_STATUS: proposals are never deleted'; END IF;
  IF NOT ((OLD.status = 'proposed' AND NEW.status IN ('held', 'committed', 'rejected', 'superseded'))
          OR (OLD.status = 'held' AND NEW.status IN ('rejected', 'superseded'))) THEN
    RAISE EXCEPTION 'EPA_PROPOSAL_STATUS: a % proposal cannot become %', OLD.status, NEW.status;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'proposal_version', 'hold_reason', 'decided_by', 'decided_at', 'decision_reason',
                            'commit_result', 'updated_at', 'superseded_by_lookup_id'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'proposal_version', 'hold_reason', 'decided_by', 'decided_at', 'decision_reason',
                            'commit_result', 'updated_at', 'superseded_by_lookup_id']) THEN
    RAISE EXCEPTION 'EPA_PROPOSAL_STATUS: a proposal''s items and binding never change';
  END IF;
  IF NEW.proposal_version <> OLD.proposal_version + 1 THEN
    RAISE EXCEPTION 'EPA_PROPOSAL_STATUS: every status change bumps the proposal version by one';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.refuse_epa_proposal_change() OWNER TO postgres;
CREATE TRIGGER epa_chemistry_proposals_status BEFORE UPDATE OR DELETE ON public.epa_chemistry_proposals
  FOR EACH ROW EXECUTE FUNCTION public.refuse_epa_proposal_change();

CREATE FUNCTION public.refuse_epa_lookup_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_TABLE_NAME = 'epa_lookup_failures' THEN
    RAISE EXCEPTION 'EPA_LOOKUP_FAILURE_APPEND_ONLY: lookup failures are never changed or deleted';
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'EPA_LOOKUP_STATUS: lookups are never deleted'; END IF;
  IF NOT (OLD.status = 'pending' AND NEW.status IN ('recorded', 'abandoned')) THEN
    RAISE EXCEPTION 'EPA_LOOKUP_STATUS: a % lookup cannot become %', OLD.status, NEW.status;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'recorded_at', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'recorded_at', 'updated_at']) THEN
    RAISE EXCEPTION 'EPA_LOOKUP_STATUS: a lookup''s binding never changes';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.refuse_epa_lookup_change() OWNER TO postgres;
CREATE TRIGGER epa_lookups_status BEFORE UPDATE OR DELETE ON public.epa_lookups
  FOR EACH ROW EXECUTE FUNCTION public.refuse_epa_lookup_change();
CREATE TRIGGER epa_lookup_failures_append_only BEFORE UPDATE OR DELETE ON public.epa_lookup_failures
  FOR EACH ROW EXECUTE FUNCTION public.refuse_epa_lookup_change();
-- TRUNCATE too, as REG-1's events table.
CREATE TRIGGER epa_chemistry_proposals_no_truncate BEFORE TRUNCATE ON public.epa_chemistry_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_epa_proposal_change();
CREATE TRIGGER epa_lookups_no_truncate BEFORE TRUNCATE ON public.epa_lookups
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_epa_lookup_change();
CREATE TRIGGER epa_lookup_failures_no_truncate BEFORE TRUNCATE ON public.epa_lookup_failures
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_epa_lookup_change();

ALTER TABLE public.epa_lookups ENABLE ROW LEVEL SECURITY;
CREATE POLICY epa_lookups_admin_read ON public.epa_lookups FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
REVOKE ALL ON TABLE public.epa_lookups FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.epa_lookups TO authenticated;

ALTER TABLE public.epa_lookup_failures ENABLE ROW LEVEL SECURITY;
CREATE POLICY epa_lookup_failures_admin_read ON public.epa_lookup_failures FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
REVOKE ALL ON TABLE public.epa_lookup_failures FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.epa_lookup_failures TO authenticated;

ALTER TABLE public.epa_chemistry_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY epa_chemistry_proposals_admin_read ON public.epa_chemistry_proposals FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
REVOKE ALL ON TABLE public.epa_chemistry_proposals FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.epa_chemistry_proposals TO authenticated;
-- The epa-lookup Edge Function reads the lookup row with its service-role client (sheet 4.B).
GRANT SELECT ON TABLE public.epa_lookups TO service_role;
REVOKE ALL ON FUNCTION public.refuse_epa_proposal_change() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON FUNCTION public.refuse_epa_lookup_change() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- ---------------------------------------------------------------------------------------------
-- 2. Helpers (no grants)
-- ---------------------------------------------------------------------------------------------

-- Does (p_kind, p_link_id) still carry p_number on p_parent_id? The same four places the gate reads.
CREATE FUNCTION public._epa_link_carries(p_parent_id uuid, p_number text, p_kind text, p_link_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT CASE p_kind
    WHEN 'parent' THEN EXISTS (SELECT 1 FROM public.product_parents pp
                                WHERE pp.id = p_parent_id AND p_link_id = p_parent_id
                                  AND public._normalize_epa_registration(pp.generic_epa_registration) = p_number)
    WHEN 'size' THEN EXISTS (SELECT 1 FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
                              WHERE m.parent_id = p_parent_id AND p.id = p_link_id
                                AND public._normalize_epa_registration(p.epa_registration) = p_number)
    WHEN 'parent_brand' THEN EXISTS (SELECT 1 FROM public.product_parent_brands b
                                      WHERE b.id = p_link_id AND b.parent_id = p_parent_id AND b.status = 'active'
                                        AND public._normalize_epa_registration(b.epa_registration) = p_number)
    WHEN 'legacy_brand' THEN EXISTS (SELECT 1 FROM public.product_brands lb
                                       JOIN public.product_parent_members m ON m.product_id = lb.product_id
                                      WHERE lb.id = p_link_id AND m.parent_id = p_parent_id
                                        AND public._normalize_epa_registration(lb.epa_registration) = p_number)
    ELSE false END;
$function$;

-- The first place p_number sits on the parent, in a fixed order (sheet 4.A step 5); NULL when it is on none.
CREATE FUNCTION public._epa_find_link(p_parent_id uuid, p_number text, OUT link_kind text, OUT link_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.product_parents pp WHERE pp.id = p_parent_id
              AND public._normalize_epa_registration(pp.generic_epa_registration) = p_number) THEN
    link_kind := 'parent'; link_id := p_parent_id; RETURN;
  END IF;
  SELECT 'size', p.id INTO link_kind, link_id
    FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
   WHERE m.parent_id = p_parent_id AND public._normalize_epa_registration(p.epa_registration) = p_number
   ORDER BY p.id LIMIT 1;
  IF link_id IS NOT NULL THEN RETURN; END IF;
  SELECT 'parent_brand', b.id INTO link_kind, link_id
    FROM public.product_parent_brands b
   WHERE b.parent_id = p_parent_id AND b.status = 'active' AND public._normalize_epa_registration(b.epa_registration) = p_number
   ORDER BY b.id LIMIT 1;
  IF link_id IS NOT NULL THEN RETURN; END IF;
  SELECT 'legacy_brand', lb.id INTO link_kind, link_id
    FROM public.product_parent_members m JOIN public.product_brands lb ON lb.product_id = m.product_id
   WHERE m.parent_id = p_parent_id AND public._normalize_epa_registration(lb.epa_registration) = p_number
   ORDER BY lb.id LIMIT 1;
END;
$function$;

-- A calendar date from EPA's acceptedDate (YYYY-MM-DD or MM/DD/YYYY), or NULL when it is not a real date.
CREATE FUNCTION public._epa_label_date(p text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_t text := btrim(COALESCE(p, ''));
  v_d date;
BEGIN
  IF v_t ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    v_d := to_date(v_t, 'YYYY-MM-DD');
    IF to_char(v_d, 'YYYY-MM-DD') = v_t THEN RETURN v_d; END IF;
  ELSIF v_t ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' THEN
    v_d := to_date(v_t, 'MM/DD/YYYY');
    IF to_char(v_d, 'MM/DD/YYYY') = v_t THEN RETURN v_d; END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$function$;

-- The first shape rule p_result breaks (sheet 4.B step 4), or NULL when it is a well-formed found/not-found result.
-- (An {error} result is handled by the caller before this runs.)
CREATE FUNCTION public._epa_lookup_shape_error(p_result jsonb, p_number text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_e jsonb;
  k text;
BEGIN
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' THEN RETURN 'the result is not an object'; END IF;
  IF jsonb_typeof(p_result->'found') IS DISTINCT FROM 'boolean' THEN RETURN 'found is not true or false'; END IF;
  IF COALESCE(p_result->>'regType', '') NOT IN ('section3', 'distributor') THEN RETURN 'regType is not section3 or distributor'; END IF;
  FOREACH k IN ARRAY ARRAY['eparegno', 'productname', 'manufacturer', 'productStatus', 'latestLabelPdfUrl'] LOOP
    IF COALESCE(jsonb_typeof(p_result->k), 'missing') NOT IN ('string', 'null') THEN RETURN k || ' is not text'; END IF;
  END LOOP;
  IF jsonb_typeof(p_result->'signalWordCanonical') IS DISTINCT FROM 'null'
     AND COALESCE(p_result->>'signalWordCanonical', '') NOT IN ('Danger', 'Warning', 'Caution') THEN
    RETURN 'signalWordCanonical is not Danger, Warning, Caution or null';
  END IF;
  IF jsonb_typeof(p_result->'needsManual') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_result->'isCancelled') IS DISTINCT FROM 'boolean' THEN
    RETURN 'needsManual or isCancelled is not true or false';
  END IF;
  IF jsonb_typeof(p_result->'rupYn') IS DISTINCT FROM 'null' AND COALESCE(p_result->>'rupYn', '') NOT IN ('Yes', 'No') THEN
    RETURN 'rupYn is not Yes, No or null';
  END IF;
  IF jsonb_typeof(p_result->'activeIngredients') IS DISTINCT FROM 'array' OR jsonb_array_length(p_result->'activeIngredients') > 50 THEN
    RETURN 'activeIngredients is not a list of at most 50';
  END IF;
  FOR v_e IN SELECT e FROM jsonb_array_elements(p_result->'activeIngredients') e LOOP
    IF jsonb_typeof(v_e) IS DISTINCT FROM 'object' OR jsonb_typeof(v_e->'name') IS DISTINCT FROM 'string'
       OR btrim(v_e->>'name') = '' OR char_length(btrim(v_e->>'name')) > 200 THEN
      RETURN 'an active ingredient has no name of at most 200 characters';
    END IF;
    IF jsonb_typeof(v_e->'percent') IS DISTINCT FROM 'null'
       AND (jsonb_typeof(v_e->'percent') IS DISTINCT FROM 'number' OR NOT ((v_e->>'percent')::numeric > 0 AND (v_e->>'percent')::numeric <= 100)) THEN
      RETURN 'an active ingredient percent is not above 0 and at most 100';
    END IF;
    IF COALESCE(jsonb_typeof(v_e->'pcCode'), 'missing') NOT IN ('string', 'null')
       OR COALESCE(jsonb_typeof(v_e->'casNumber'), 'missing') NOT IN ('string', 'null') THEN
      RETURN 'an active ingredient pcCode or casNumber is not text';
    END IF;
  END LOOP;
  IF jsonb_typeof(p_result->'labelPdfs') IS DISTINCT FROM 'array' OR jsonb_array_length(p_result->'labelPdfs') > 200 THEN
    RETURN 'labelPdfs is not a list of at most 200';
  END IF;
  FOR v_e IN SELECT e FROM jsonb_array_elements(p_result->'labelPdfs') e LOOP
    IF jsonb_typeof(v_e) IS DISTINCT FROM 'object' OR jsonb_typeof(v_e->'fileName') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_e->'url') IS DISTINCT FROM 'string'
       OR COALESCE(jsonb_typeof(v_e->'acceptedDate'), 'missing') NOT IN ('string', 'null') THEN
      RETURN 'a label PDF entry is not {fileName, acceptedDate, url}';
    END IF;
  END LOOP;
  IF p_result ? 'transferredTo' AND jsonb_typeof(p_result->'transferredTo') IS DISTINCT FROM 'null' THEN
    IF jsonb_typeof(p_result->'transferredTo') IS DISTINCT FROM 'string' OR (p_result->>'found')::boolean THEN
      RETURN 'transferredTo is set on a found result or is not text';
    END IF;
    IF COALESCE(public._normalize_epa_registration(p_result->>'transferredTo'), '') !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
      RETURN 'transferredTo is not an EPA registration number';
    END IF;
  END IF;
  IF jsonb_typeof(p_result->'latestLabelPdfUrl') = 'string' AND p_result->>'latestLabelPdfUrl' NOT LIKE 'https://www3.epa.gov/%' THEN
    RETURN 'latestLabelPdfUrl is not an EPA address';
  END IF;
  IF (p_result->>'found')::boolean AND public._normalize_epa_registration(p_result->>'eparegno') IS DISTINCT FROM p_number THEN
    RETURN 'eparegno is not the number looked up';
  END IF;
  RETURN NULL;
END;
$function$;

-- What the proposal keeps of a found result (sheet 3.4): ingredients merged within the result, and the label facts.
-- {ingredients: [{key, name, cas, cas_note, strength, conflict}], label: {signal_word, rup_status, is_cancelled,
--  label_accepted_on, label_url, date_note}}
CREATE FUNCTION public._epa_lookup_input(p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_ings jsonb;
  v_pick jsonb;
  v_url text;
  v_bad_dates integer;
BEGIN
  WITH raw AS (
    SELECT o, btrim(regexp_replace(e->>'name', '\s+', ' ', 'g')) AS name,
           CASE WHEN jsonb_typeof(e->'casNumber') = 'string' AND btrim(e->>'casNumber') ~ '^[0-9]{2,7}-[0-9]{2}-[0-9]$'
                     AND public._ingredient_cas_valid(btrim(e->>'casNumber')) THEN btrim(e->>'casNumber') END AS cas,
           jsonb_typeof(e->'casNumber') = 'string' AND btrim(e->>'casNumber') <> '' AS cas_given,
           CASE WHEN jsonb_typeof(e->'percent') = 'number' THEN round((e->>'percent')::numeric, 10) END AS strength
      FROM jsonb_array_elements(p_result->'activeIngredients') WITH ORDINALITY AS t(e, o)
  ), keyed AS (
    -- A name-only entry joins a same-name entry that has a CAS number, so one ingredient is never two rows (Sol, 2026-11-11).
    SELECT r.*, CASE WHEN r.cas IS NOT NULL THEN 'cas:' || r.cas
                     ELSE COALESCE((SELECT 'cas:' || min(r2.cas) FROM raw r2 WHERE lower(r2.name) = lower(r.name) AND r2.cas IS NOT NULL),
                                   'name:' || lower(r.name)) END AS key
      FROM raw r
  ), merged AS (
    SELECT key, min(o) AS first_o,
           (array_agg(name ORDER BY o))[1] AS name,
           (array_agg(cas ORDER BY o) FILTER (WHERE cas IS NOT NULL))[1] AS cas,
           bool_or(cas IS NULL AND cas_given) AS cas_dropped,
           (array_agg(strength ORDER BY o))[1] AS strength,
           count(DISTINCT COALESCE(strength::text, 'unknown')) > 1 AS conflict
      FROM keyed GROUP BY key
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('key', key, 'name', name, 'cas', cas,
           'cas_note', CASE WHEN cas_dropped THEN 'EPA''s CAS number is not valid, so it was left out' END,
           'strength', strength, 'conflict', conflict) ORDER BY first_o), '[]'::jsonb)
    INTO v_ings FROM merged;

  -- One labelPdfs entry gives both the date and the link: the newest valid date, ties to EPA's first.
  SELECT jsonb_build_object('date', public._epa_label_date(e->>'acceptedDate'), 'url', e->>'url') INTO v_pick
    FROM jsonb_array_elements(p_result->'labelPdfs') WITH ORDINALITY AS t(e, o)
   WHERE public._epa_label_date(e->>'acceptedDate') IS NOT NULL
   ORDER BY public._epa_label_date(e->>'acceptedDate') DESC, o LIMIT 1;
  SELECT count(*) INTO v_bad_dates FROM jsonb_array_elements(p_result->'labelPdfs') e
   WHERE jsonb_typeof(e->'acceptedDate') = 'string' AND btrim(e->>'acceptedDate') <> '' AND public._epa_label_date(e->>'acceptedDate') IS NULL;
  IF v_pick IS NOT NULL THEN
    v_url := v_pick->>'url';
  ELSE
    v_url := p_result->>'latestLabelPdfUrl';
  END IF;
  IF v_url IS NOT NULL AND (v_url NOT LIKE 'https://www3.epa.gov/%' OR v_url ~ '[[:space:]]' OR length(v_url) > 2000) THEN
    v_url := NULL;
  END IF;

  RETURN jsonb_build_object('ingredients', v_ings, 'label', jsonb_build_object(
    'signal_word', p_result->'signalWordCanonical',
    'rup_status', CASE p_result->>'rupYn' WHEN 'Yes' THEN 'yes' WHEN 'No' THEN 'no' END,
    'is_cancelled', p_result->'isCancelled',
    'label_accepted_on', v_pick->>'date',
    'label_url', v_url,
    'date_note', CASE WHEN v_bad_dates > 0 THEN v_bad_dates || ' label date(s) from EPA could not be read and were ignored' END));
END;
$function$;

-- Sort every item against the parent's current rows and the registration (sheet 3.4). Deterministic item IDs, so
-- commit can sort again under its locks and compare. Item: {item_id, kind, class, epa, current, accept_default, note,
-- change}; change is what commit passes on (chemistry entry or registration facts), only on writable classes
-- (add, add_name_only, fill, confirm, rup_upgrade). Every other class is shown, never written.
CREATE FUNCTION public._epa_proposal_items(p_parent_id uuid, p_number text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_items jsonb := '[]'::jsonb;
  v_reg public.epa_registrations;
  v_ing jsonb;
  v_row record;
  v_matched uuid[] := '{}';
  v_class text;
  v_s numeric;
  v_note text := 'EPA lookup of ' || p_number;
  v_label jsonb := p_input->'label';
  v_date date;
  v_url text;
  v_dclass text;
  v_change jsonb;
BEGIN
  -- Ingredients. CAS matches first, then names (lower case, spaces collapsed) against the parent's own rows only.
  FOR v_ing IN SELECT e FROM jsonb_array_elements(p_input->'ingredients') e ORDER BY (e->>'cas') IS NULL, e->>'key' LOOP
    v_s := (v_ing->>'strength')::numeric;
    IF v_ing->>'cas' IS NOT NULL THEN
      SELECT ppi.id, ppi.ingredient_id, ppi.strength_value, ppi.strength_unit, ppi.strength_basis, ppi.source, a.name, a.cas
        INTO v_row
        FROM public.product_parent_ingredients ppi JOIN public.active_ingredients a ON a.id = ppi.ingredient_id
       WHERE ppi.parent_id = p_parent_id AND ppi.status = 'active' AND a.cas = v_ing->>'cas';
      IF v_row.id IS NULL THEN
        -- A same-name row with no CAS would become a second row for one chemical: shown, not written.
        SELECT ppi.id, ppi.ingredient_id, ppi.strength_value, ppi.strength_unit, ppi.strength_basis, ppi.source, a.name, a.cas
          INTO v_row
          FROM public.product_parent_ingredients ppi JOIN public.active_ingredients a ON a.id = ppi.ingredient_id
         WHERE ppi.parent_id = p_parent_id AND ppi.status = 'active' AND a.cas IS NULL
           AND lower(regexp_replace(btrim(a.name), '\s+', ' ', 'g')) = lower(v_ing->>'name')
           AND ppi.id <> ALL (v_matched)
         ORDER BY ppi.id LIMIT 1;
        IF v_row.id IS NOT NULL THEN
          v_matched := v_matched || v_row.id;
          v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'ing:' || (v_ing->>'key'), 'kind', 'ingredient',
            'class', 'differs_identity', 'epa', v_ing, 'current', to_jsonb(v_row), 'accept_default', false,
            'note', 'Your ingredient has no CAS number; EPA gives ' || (v_ing->>'cas') || '. Correct the ingredient to link them.'));
          CONTINUE;
        END IF;
      END IF;
    ELSE
      SELECT ppi.id, ppi.ingredient_id, ppi.strength_value, ppi.strength_unit, ppi.strength_basis, ppi.source, a.name, a.cas
        INTO v_row
        FROM public.product_parent_ingredients ppi JOIN public.active_ingredients a ON a.id = ppi.ingredient_id
       WHERE ppi.parent_id = p_parent_id AND ppi.status = 'active'
         AND lower(regexp_replace(btrim(a.name), '\s+', ' ', 'g')) = lower(v_ing->>'name')
       ORDER BY ppi.id LIMIT 1;
    END IF;

    v_change := NULL;
    IF v_row.id IS NOT NULL AND v_row.id = ANY (v_matched) THEN
      v_class := 'epa_conflict';  -- two EPA entries land on one row
    ELSIF (v_ing->>'conflict')::boolean THEN
      v_class := 'epa_conflict';
    ELSIF v_row.id IS NULL THEN
      IF v_ing->>'cas' IS NOT NULL AND EXISTS (SELECT 1 FROM public.active_ingredients WHERE cas = v_ing->>'cas' AND status <> 'active') THEN
        v_class := 'ingredient_retired';
      ELSE
        v_class := CASE WHEN v_ing->>'cas' IS NOT NULL THEN 'add' ELSE 'add_name_only' END;
        v_change := jsonb_build_object('kind', 'ingredient', 'name', v_ing->>'name')
                 || CASE WHEN v_ing->>'cas' IS NOT NULL THEN jsonb_build_object('cas', v_ing->'cas') ELSE '{}'::jsonb END;
      END IF;
    ELSIF v_row.strength_value IS NOT DISTINCT FROM v_s AND v_row.strength_unit = 'pct_ww' AND v_row.strength_basis = 'active_ingredient' THEN
      v_class := 'confirm';
      v_change := jsonb_build_object('kind', 'ingredient', 'ingredient_id', v_row.ingredient_id);
    ELSIF v_row.source <> 'epa_lookup' THEN
      v_class := 'differs_typed';
    ELSIF v_row.strength_value IS NULL AND v_s IS NOT NULL THEN
      v_class := 'fill';
      v_change := jsonb_build_object('kind', 'ingredient', 'ingredient_id', v_row.ingredient_id);
    ELSE
      v_class := 'differs_epa';
    END IF;
    IF v_row.id IS NOT NULL THEN v_matched := v_matched || v_row.id; END IF;
    IF v_change IS NOT NULL THEN
      v_change := v_change || jsonb_build_object('strength_value', v_s, 'strength_unit', 'pct_ww',
        'strength_basis', 'active_ingredient', 'source', 'epa_lookup', 'source_note', v_note);
    END IF;
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'ing:' || (v_ing->>'key'), 'kind', 'ingredient',
      'class', v_class, 'epa', v_ing, 'current', CASE WHEN v_row.id IS NOT NULL THEN to_jsonb(v_row) END,
      'accept_default', v_class IN ('add', 'fill', 'confirm'), 'note', v_ing->>'cas_note', 'change', v_change));
  END LOOP;

  -- Every entry that lands on a row another entry also landed on is a conflict, the first one too (Codex App,
  -- 2026-11-11): nothing is written for that row.
  SELECT COALESCE(jsonb_agg(CASE WHEN e->'current'->>'id' IN (
             SELECT e2->'current'->>'id' FROM jsonb_array_elements(v_items) e2
              WHERE e2->'current'->>'id' IS NOT NULL GROUP BY 1 HAVING count(*) > 1)
           THEN e || jsonb_build_object('class', 'epa_conflict', 'accept_default', false, 'change', NULL)
           ELSE e END ORDER BY o), '[]'::jsonb)
    INTO v_items FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(e, o);

  -- Parent rows EPA does not list: shown only.
  FOR v_row IN
    SELECT ppi.id, ppi.ingredient_id, ppi.strength_value, ppi.strength_unit, ppi.strength_basis, ppi.source, a.name, a.cas
      FROM public.product_parent_ingredients ppi JOIN public.active_ingredients a ON a.id = ppi.ingredient_id
     WHERE ppi.parent_id = p_parent_id AND ppi.status = 'active' AND ppi.id <> ALL (v_matched)
     ORDER BY ppi.ingredient_id
  LOOP
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'missing:' || v_row.ingredient_id, 'kind', 'ingredient',
      'class', 'missing_from_epa', 'epa', NULL, 'current', to_jsonb(v_row), 'accept_default', false));
  END LOOP;

  -- Label facts, against the registration.
  SELECT * INTO v_reg FROM public.epa_registrations WHERE epa_registration = p_number;
  IF NOT FOUND THEN RAISE EXCEPTION 'EPA_REGISTRATION_MISSING: EPA registration % does not exist', p_number; END IF;

  IF jsonb_typeof(v_label->'signal_word') = 'string' THEN
    v_class := CASE WHEN v_reg.signal_word IS NULL THEN 'fill' WHEN v_reg.signal_word = v_label->>'signal_word' THEN 'confirm' ELSE 'differs' END;
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'label:signal_word', 'kind', 'label', 'class', v_class,
      'epa', v_label->'signal_word', 'current', to_jsonb(v_reg.signal_word), 'accept_default', v_class <> 'differs',
      'change', CASE WHEN v_class = 'fill' THEN jsonb_build_object('signal_word', v_label->'signal_word')
                     WHEN v_class = 'confirm' THEN '{}'::jsonb END));
  END IF;
  IF v_label->>'rup_status' IS NOT NULL THEN
    -- Mason 2026-11-11: EPA "yes" over our "no" may be ticked (unticked by default); "no" over "yes" is never written.
    v_class := CASE WHEN v_reg.rup_status = 'unknown' THEN 'fill' WHEN v_reg.rup_status = v_label->>'rup_status' THEN 'confirm'
                    WHEN v_reg.rup_status = 'no' AND v_label->>'rup_status' = 'yes' THEN 'rup_upgrade' ELSE 'differs' END;
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'label:rup_status', 'kind', 'label', 'class', v_class,
      'epa', v_label->'rup_status', 'current', to_jsonb(v_reg.rup_status), 'accept_default', v_class IN ('fill', 'confirm'),
      'note', CASE WHEN v_class = 'rup_upgrade' THEN 'EPA lists this product as restricted use; ticking records yes and lists past sales that need records.' END,
      'change', CASE WHEN v_class IN ('fill', 'rup_upgrade') THEN jsonb_build_object('rup_status', v_label->'rup_status')
                     WHEN v_class = 'confirm' THEN '{}'::jsonb END));
  END IF;
  -- Status is never written: the lookup has no cancellation date (D-T); shown as matches or differs.
  -- An unknown status never "matches" (Luna, 2026-11-11): EPA's answer is shown beside it as a difference.
  v_class := CASE WHEN v_reg.registration_status = 'unknown' THEN 'differs'
                  WHEN (v_label->>'is_cancelled')::boolean = (v_reg.registration_status = 'cancelled') THEN 'matches' ELSE 'differs' END;
  v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'label:registration_status', 'kind', 'label', 'class', v_class,
    'epa', v_label->'is_cancelled', 'current', to_jsonb(v_reg.registration_status), 'accept_default', false,
    'note', CASE WHEN v_class = 'matches' THEN NULL
                 WHEN (v_label->>'is_cancelled')::boolean
                 THEN 'EPA lists this registration as cancelled; record the date on the registration. Selling is not blocked.'
                 ELSE 'EPA lists this registration as active.' END));
  -- One tick box for the label date and its link (sheet 3.4).
  v_date := (v_label->>'label_accepted_on')::date;
  v_url := v_label->>'label_url';
  v_dclass := CASE WHEN v_date IS NULL THEN NULL
                   WHEN v_reg.label_accepted_on IS NULL OR v_date > v_reg.label_accepted_on THEN 'fill'
                   WHEN v_date = v_reg.label_accepted_on THEN 'confirm' ELSE 'differs' END;
  v_change := NULL;
  IF v_dclass = 'fill' THEN
    v_class := 'fill';
    v_change := jsonb_build_object('label_accepted_on', v_date::text)
             || CASE WHEN v_url IS NOT NULL THEN jsonb_build_object('label_url', v_url) ELSE '{}'::jsonb END;
  ELSIF v_dclass = 'differs' THEN
    v_class := 'differs';
  ELSIF v_url IS NULL THEN
    v_class := v_dclass;  -- confirm, or no item when EPA gave neither
  ELSIF v_reg.label_url IS NULL AND v_dclass IS NULL THEN
    v_class := 'fill';
    v_change := jsonb_build_object('label_url', v_url);
  ELSIF v_reg.label_url = v_url THEN
    v_class := 'confirm';
  ELSE
    v_class := 'differs';
  END IF;
  IF v_class IS NOT NULL THEN
    IF v_class = 'confirm' THEN v_change := '{}'::jsonb; END IF;
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'label:label_document', 'kind', 'label', 'class', v_class,
      'epa', jsonb_build_object('label_accepted_on', v_date, 'label_url', v_url),
      'current', jsonb_build_object('label_accepted_on', v_reg.label_accepted_on, 'label_url', v_reg.label_url),
      'accept_default', v_class <> 'differs', 'note', v_label->>'date_note', 'change', v_change));
  ELSIF v_label->>'date_note' IS NOT NULL THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object('item_id', 'label:label_document', 'kind', 'label', 'class', 'differs',
      'epa', NULL, 'current', jsonb_build_object('label_accepted_on', v_reg.label_accepted_on, 'label_url', v_reg.label_url),
      'accept_default', false, 'note', v_label->>'date_note'));
  END IF;
  RETURN v_items;
END;
$function$;

DO $helpers$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._epa_link_carries(uuid,text,text,uuid)', 'public._epa_find_link(uuid,text)', 'public._epa_label_date(text)',
    'public._epa_lookup_shape_error(jsonb,text)', 'public._epa_lookup_input(jsonb)', 'public._epa_proposal_items(uuid,text,jsonb)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role, metabase_ro', f);
  END LOOP;
END
$helpers$;

-- ---------------------------------------------------------------------------------------------
-- 3. start_epa_lookup (admin)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.start_epa_lookup(p_parent_id uuid, p_epa_registration text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_n text := public._normalize_epa_registration(p_epa_registration);
  v_fp text;
  v_existing jsonb;
  v_reg_version bigint;
  v_active boolean;
  v_link record;
  v_chem bigint;
  v_id uuid;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  v_fp := md5(jsonb_build_object('actor_id', v_actor, 'parent_id', p_parent_id, 'epa_registration', v_n)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'start_epa_lookup', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF NOT public._epa_registrations_seeded() THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_NOT_SEEDED: EPA registrations are not set up yet';
  END IF;
  IF v_n IS NULL OR v_n !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
    RAISE EXCEPTION 'EPA_NUMBER_INVALID: % is not an EPA registration number', COALESCE(p_epa_registration, '(blank)');
  END IF;

  PERFORM public._epa_registration_lock(false);
  SELECT registration_version INTO v_reg_version FROM public.epa_registrations WHERE epa_registration = v_n FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EPA_REGISTRATION_MISSING: EPA registration % does not exist yet; add it on the registration screen', v_n; END IF;
  SELECT is_active INTO v_active FROM public.product_parents WHERE id = p_parent_id FOR UPDATE;
  IF NOT FOUND OR NOT v_active THEN RAISE EXCEPTION 'PARENT_NOT_FOUND: that product is missing or inactive'; END IF;
  SELECT * INTO v_link FROM public._epa_find_link(p_parent_id, v_n);
  IF v_link.link_id IS NULL THEN RAISE EXCEPTION 'EPA_NUMBER_NOT_ON_PARENT: % is not an EPA number of this product', v_n; END IF;
  SELECT chemistry_version INTO v_chem FROM public.product_parent_chemistry_state WHERE parent_id = p_parent_id;

  UPDATE public.epa_lookups SET status = 'abandoned', updated_at = now()
   WHERE parent_id = p_parent_id AND epa_registration = v_n AND status = 'pending';
  -- clock_timestamp(), taken under the parent lock, so lookup order always matches lock order (Sol, 2026-11-11).
  INSERT INTO public.epa_lookups (parent_id, epa_registration, link_kind, link_id, registration_version, chemistry_version,
    requested_by, requested_at)
  VALUES (p_parent_id, v_n, v_link.link_kind, v_link.link_id, v_reg_version, COALESCE(v_chem, 0), v_actor, clock_timestamp())
  RETURNING id INTO v_id;

  v_result := jsonb_build_object('lookup_id', v_id, 'epa_registration', v_n, 'link_kind', v_link.link_kind,
    'link_id', v_link.link_id, 'registration_version', v_reg_version, 'chemistry_version', COALESCE(v_chem, 0));
  PERFORM public.save_idempotency(p_idempotency_key, 'start_epa_lookup',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 4. record_epa_lookup (service role only: the epa-lookup Edge Function)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.record_epa_lookup(p_lookup_id uuid, p_actor uuid, p_result jsonb, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  -- First answer wins: a retry with a different EPA answer replays the saved result (sheet 4.B step 1).
  v_fp text := md5(jsonb_build_object('lookup_id', p_lookup_id, 'actor_id', p_actor)::text);
  v_existing jsonb;
  v_lookup public.epa_lookups;
  v_reason text;
  v_detail text;
  v_transferred text;
  v_input jsonb;
  v_items jsonb;
  v_reg_version bigint;
  v_chem bigint;
  v_id uuid;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  -- _product_parent_replay compares against auth.uid(), which is empty under the service role: same steps, by hand.
  PERFORM pg_advisory_xact_lock(hashtext('crx.product_parent:record_epa_lookup:' || p_idempotency_key));
  v_existing := public.check_idempotency(p_idempotency_key, 'record_epa_lookup');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM p_actor::text OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  SELECT * INTO v_lookup FROM public.epa_lookups WHERE id = p_lookup_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'EPA_LOOKUP_NOT_FOUND'; END IF;
  PERFORM public._epa_registration_lock(false);
  PERFORM 1 FROM public.epa_registrations WHERE epa_registration = v_lookup.epa_registration FOR SHARE;
  PERFORM 1 FROM public.product_parents WHERE id = v_lookup.parent_id FOR UPDATE;
  SELECT * INTO v_lookup FROM public.epa_lookups WHERE id = p_lookup_id FOR UPDATE;

  -- Actor binding: only the admin who started this lookup (requested_by came from auth.uid()), still an active admin.
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM v_lookup.requested_by
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_actor AND role = 'admin' AND is_active) THEN
    RAISE EXCEPTION 'EPA_LOOKUP_ACTOR: only the admin who started this lookup can record it';
  END IF;
  -- A newer start abandoned this lookup; say so by name before the plain status check.
  IF EXISTS (SELECT 1 FROM public.epa_lookups l
              WHERE l.parent_id = v_lookup.parent_id AND l.epa_registration = v_lookup.epa_registration AND l.id <> v_lookup.id
                AND (l.requested_at, l.id) > (v_lookup.requested_at, v_lookup.id)) THEN
    RAISE EXCEPTION 'EPA_LOOKUP_SUPERSEDED: a newer lookup of this number was started';
  END IF;
  IF v_lookup.status <> 'pending' THEN RAISE EXCEPTION 'EPA_LOOKUP_NOT_PENDING: this lookup is %; start a new one', v_lookup.status; END IF;
  IF v_lookup.requested_at < now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'EPA_LOOKUP_EXPIRED: this lookup is more than 30 minutes old; start a new one';
  END IF;
  IF p_result IS NULL OR octet_length(p_result::text) > 262144 THEN
    RAISE EXCEPTION 'EPA_RESULT_TOO_LARGE: the EPA result is missing or larger than 256 KB';
  END IF;

  -- Classify. A bad shape is recorded as a failure, never raised.
  IF jsonb_typeof(p_result) = 'object' AND jsonb_typeof(p_result->'error') = 'string' AND btrim(p_result->>'error') <> '' THEN
    v_reason := 'upstream_error';
    v_detail := left(p_result->>'error', 500);
  ELSE
    v_detail := public._epa_lookup_shape_error(p_result, v_lookup.epa_registration);
    IF v_detail IS NOT NULL THEN
      v_reason := 'invalid_result';
    ELSIF NOT (p_result->>'found')::boolean THEN
      v_transferred := public._normalize_epa_registration(p_result->>'transferredTo');
      v_reason := CASE WHEN v_transferred IS NOT NULL THEN 'transferred' ELSE 'not_found' END;
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    -- An error, a bad shape or a not-found never removes an open proposal. A transfer does: EPA says the number
    -- moved, so the open proposal's facts are stale and must not be committed (Sol, 2026-11-11).
    IF v_reason = 'transferred' THEN
      UPDATE public.epa_chemistry_proposals
         SET status = 'superseded', superseded_by_lookup_id = v_lookup.id, proposal_version = proposal_version + 1,
             hold_reason = NULL, updated_at = now()
       WHERE parent_id = v_lookup.parent_id AND epa_registration = v_lookup.epa_registration AND status IN ('proposed', 'held');
    END IF;
    INSERT INTO public.epa_lookup_failures (lookup_id, parent_id, epa_registration, link_kind, link_id, registration_version,
      reason, transferred_to, detail, created_by)
    VALUES (v_lookup.id, v_lookup.parent_id, v_lookup.epa_registration, v_lookup.link_kind, v_lookup.link_id,
      v_lookup.registration_version, v_reason, v_transferred, v_detail, p_actor)
    RETURNING id INTO v_id;
    v_result := jsonb_build_object('lookup_id', v_lookup.id, 'outcome', 'failure', 'failure_id', v_id, 'reason', v_reason);
  ELSE
    v_input := public._epa_lookup_input(p_result);
    v_items := public._epa_proposal_items(v_lookup.parent_id, v_lookup.epa_registration, v_input);
    SELECT registration_version INTO v_reg_version FROM public.epa_registrations WHERE epa_registration = v_lookup.epa_registration;
    SELECT chemistry_version INTO v_chem FROM public.product_parent_chemistry_state WHERE parent_id = v_lookup.parent_id;
    UPDATE public.epa_chemistry_proposals
       SET status = 'superseded', superseded_by_lookup_id = v_lookup.id, proposal_version = proposal_version + 1,
           hold_reason = NULL, updated_at = now()
     WHERE parent_id = v_lookup.parent_id AND epa_registration = v_lookup.epa_registration AND status IN ('proposed', 'held');
    INSERT INTO public.epa_chemistry_proposals (lookup_id, parent_id, epa_registration, link_kind, link_id, registration_version,
      chemistry_version, epa_input, items, epa_summary, created_by)
    VALUES (v_lookup.id, v_lookup.parent_id, v_lookup.epa_registration, v_lookup.link_kind, v_lookup.link_id, v_reg_version,
      COALESCE(v_chem, 0), v_input, v_items,
      jsonb_build_object('productname', p_result->'productname', 'manufacturer', p_result->'manufacturer',
        'regType', p_result->'regType', 'productStatus', p_result->'productStatus', 'isCancelled', p_result->'isCancelled',
        'needsManual', p_result->'needsManual', 'latestLabelPdfUrl', p_result->'latestLabelPdfUrl',
        'newest_label_date', v_input->'label'->'label_accepted_on', 'base_label_note', p_result->>'regType' = 'distributor'),
      p_actor)
    RETURNING id INTO v_id;
    v_result := jsonb_build_object('lookup_id', v_lookup.id, 'outcome', 'proposal', 'proposal_id', v_id);
  END IF;

  UPDATE public.epa_lookups SET status = 'recorded', recorded_at = now(), updated_at = now() WHERE id = v_lookup.id;
  PERFORM public.save_idempotency(p_idempotency_key, 'record_epa_lookup',
    jsonb_build_object('actor_id', p_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 5. commit_epa_proposal (admin)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.commit_epa_proposal(p_proposal_id uuid, p_expected_proposal_version bigint, p_decisions jsonb,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text;
  v_existing jsonb;
  v_p public.epa_chemistry_proposals;
  v_reg public.epa_registrations;
  v_chem bigint;
  v_hold text;
  v_now jsonb;
  v_accept jsonb := '{}'::jsonb;
  v_d jsonb;
  v_item jsonb;
  v_new jsonb;
  v_ok boolean;
  v_changes jsonb := '[]'::jsonb;
  v_facts jsonb := '{}'::jsonb;
  v_label_touched boolean := false;
  v_was_yes boolean;
  v_posted jsonb := '[]'::jsonb;
  v_commit jsonb := '{}'::jsonb;
  v_chem_result jsonb;
  v_before jsonb;
  v_reg_version bigint;
  v_result jsonb;
  v_counts jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  v_fp := md5(jsonb_build_object('actor_id', v_actor, 'proposal_id', p_proposal_id,
    'expected_version', p_expected_proposal_version, 'decisions', p_decisions)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'commit_epa_proposal', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF p_decisions IS NULL OR jsonb_typeof(p_decisions) IS DISTINCT FROM 'array' OR jsonb_array_length(p_decisions) > 500 THEN
    RAISE EXCEPTION 'EPA_DECISION_INVALID: send the decisions as a list of {item_id, accept}';
  END IF;

  SELECT * INTO v_p FROM public.epa_chemistry_proposals WHERE id = p_proposal_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'EPA_PROPOSAL_NOT_FOUND'; END IF;

  -- Locks (sheet 3.3): exclusive REG-1 pair, registration, parent chemistry, link row, proposal.
  PERFORM public._epa_registration_lock(true);
  SELECT * INTO v_reg FROM public.epa_registrations WHERE epa_registration = v_p.epa_registration FOR UPDATE;
  -- The parent lock first (the chemistry writers' first lock), so a save in flight is waited out and then seen as
  -- chemistry_changed (a hold), not CHEMISTRY_STALE (Codex App, 2026-11-11).
  PERFORM 1 FROM public.product_parents WHERE id = v_p.parent_id FOR UPDATE;
  SELECT chemistry_version INTO v_chem FROM public.product_parent_chemistry_state WHERE parent_id = v_p.parent_id;
  v_chem := public._lock_parent_chemistry(v_p.parent_id, COALESCE(v_chem, 0));
  IF v_p.link_kind = 'parent_brand' THEN
    PERFORM 1 FROM public.product_parent_brands WHERE id = v_p.link_id FOR SHARE;
  ELSIF v_p.link_kind = 'legacy_brand' THEN
    PERFORM 1 FROM public.product_brands WHERE id = v_p.link_id FOR SHARE;
  END IF;
  SELECT * INTO v_p FROM public.epa_chemistry_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF v_p.proposal_version IS DISTINCT FROM p_expected_proposal_version THEN
    RAISE EXCEPTION 'EPA_PROPOSAL_STALE: this proposal changed since you opened it; reload and try again';
  END IF;
  IF v_p.status <> 'proposed' THEN RAISE EXCEPTION 'EPA_PROPOSAL_NOT_OPEN: this proposal is %', v_p.status; END IF;
  IF NOT (SELECT is_active FROM public.product_parents WHERE id = v_p.parent_id) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INACTIVE: this product is inactive; reject the proposal';
  END IF;

  -- Decisions: known items only; a difference can never be accepted; an unlisted item takes its default.
  FOR v_d IN SELECT e FROM jsonb_array_elements(p_decisions) e LOOP
    IF jsonb_typeof(v_d) IS DISTINCT FROM 'object' OR jsonb_typeof(v_d->'item_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_d->'accept') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'EPA_DECISION_INVALID: each decision is {item_id, accept}';
    END IF;
    IF v_accept ? (v_d->>'item_id') THEN RAISE EXCEPTION 'EPA_DECISION_INVALID: % is decided twice', v_d->>'item_id'; END IF;
    v_item := NULL;
    SELECT e INTO v_item FROM jsonb_array_elements(v_p.items) e WHERE e->>'item_id' = v_d->>'item_id';
    IF v_item IS NULL THEN RAISE EXCEPTION 'EPA_DECISION_UNKNOWN_ITEM: % is not on this proposal', v_d->>'item_id'; END IF;
    IF (v_d->>'accept')::boolean AND v_item->>'class' NOT IN ('add', 'add_name_only', 'fill', 'confirm', 'rup_upgrade') THEN
      RAISE EXCEPTION 'EPA_DECISION_NOT_WRITABLE: % is a difference; it is shown, never written', v_d->>'item_id';
    END IF;
    v_accept := v_accept || jsonb_build_object(v_d->>'item_id', v_d->'accept');
  END LOOP;

  -- Holds (sheet 4.C steps 5-6): returned, not raised, so the hold is kept.
  IF NOT public._epa_link_carries(v_p.parent_id, v_p.epa_registration, v_p.link_kind, v_p.link_id) THEN
    v_hold := 'relinked';
  ELSE
    -- Re-sort under the locks. Registration facts are compared by value, not by registration_version (Taha,
    -- 2026-11-11): another parent's commit of the same number bumps the version without changing a fact and must
    -- not hold this one. An accepted label item that now matches (confirm) is fine; any other change to it holds.
    v_now := public._epa_proposal_items(v_p.parent_id, v_p.epa_registration, v_p.epa_input);
    FOR v_item IN SELECT e FROM jsonb_array_elements(v_p.items) e WHERE e->>'kind' = 'label' LOOP
      IF COALESCE((v_accept->>(v_item->>'item_id'))::boolean, (v_item->>'accept_default')::boolean) THEN
        v_new := NULL;
        SELECT e INTO v_new FROM jsonb_array_elements(v_now) e WHERE e->>'item_id' = v_item->>'item_id';
        IF v_new IS NULL OR (v_new->>'class' IS DISTINCT FROM 'confirm'
            AND (v_new->>'class' IS DISTINCT FROM v_item->>'class' OR v_new->'change' IS DISTINCT FROM v_item->'change')) THEN
          v_hold := 'registration_changed';
          EXIT;
        END IF;
      END IF;
    END LOOP;
    IF v_hold IS NULL AND v_chem IS DISTINCT FROM v_p.chemistry_version THEN
      v_hold := 'chemistry_changed';
    ELSIF v_hold IS NULL THEN
      -- Same chemistry version, so the same rows; the re-sort also catches an ingredient retired or added elsewhere.
      FOR v_item IN SELECT e FROM jsonb_array_elements(v_p.items) e WHERE e->>'kind' = 'ingredient' LOOP
        IF COALESCE((v_accept->>(v_item->>'item_id'))::boolean, (v_item->>'accept_default')::boolean) THEN
          v_new := NULL;
          SELECT e INTO v_new FROM jsonb_array_elements(v_now) e WHERE e->>'item_id' = v_item->>'item_id';
          IF v_new IS NULL OR v_new->>'class' IS DISTINCT FROM v_item->>'class' OR v_new->'change' IS DISTINCT FROM v_item->'change' THEN
            v_hold := 'chemistry_changed';
            EXIT;
          END IF;
        END IF;
      END LOOP;
    END IF;
  END IF;
  IF v_hold IS NOT NULL THEN
    UPDATE public.epa_chemistry_proposals SET status = 'held', hold_reason = v_hold, proposal_version = proposal_version + 1,
           updated_at = now()
     WHERE id = v_p.id;
    v_result := jsonb_build_object('status', 'held', 'proposal_id', v_p.id, 'hold_reason', v_hold,
      'proposal_version', v_p.proposal_version + 1);
    PERFORM public.save_idempotency(p_idempotency_key, 'commit_epa_proposal',
      jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
    RETURN v_result;
  END IF;

  -- Build what is written: accepted add / add_name_only / fill / confirm / rup_upgrade only (D-L).
  FOR v_item IN SELECT e FROM jsonb_array_elements(v_p.items) e LOOP
    v_ok := v_item->>'class' IN ('add', 'add_name_only', 'fill', 'confirm', 'rup_upgrade')
            AND COALESCE((v_accept->>(v_item->>'item_id'))::boolean, (v_item->>'accept_default')::boolean);
    v_commit := v_commit || jsonb_build_object(v_item->>'item_id', CASE
      WHEN v_item->>'class' NOT IN ('add', 'add_name_only', 'fill', 'confirm', 'rup_upgrade') THEN 'kept_difference'
      WHEN NOT v_ok THEN 'skipped'
      WHEN v_item->>'class' = 'confirm' THEN 'confirmed'
      ELSE 'written' END);
    IF v_ok AND v_item->>'kind' = 'ingredient' THEN
      v_changes := v_changes || jsonb_build_array(v_item->'change');
    ELSIF v_ok AND v_item->>'kind' = 'label' THEN
      v_facts := v_facts || (v_item->'change');
      v_label_touched := true;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_changes) > 0 THEN
    v_chem_result := public._apply_parent_chemistry(v_p.parent_id, v_changes, 'epa', 'EPA lookup proposal ' || v_p.id,
      jsonb_build_object('proposal_id', v_p.id, 'lookup_id', v_p.lookup_id, 'epa_registration', v_p.epa_registration)::text);
    v_chem := (v_chem_result->>'chemistry_version')::bigint;
  END IF;

  v_reg_version := v_reg.registration_version;
  IF v_label_touched THEN
    v_facts := v_facts || jsonb_build_object('checked_at', now()::text, 'source', 'epa_lookup');
    PERFORM public._epa_registration_facts(v_facts, false);
    v_was_yes := v_reg.rup_status = 'yes';
    v_before := to_jsonb(v_reg);
    v_reg := public._epa_registration_update(v_p.epa_registration, v_facts);
    PERFORM public._epa_registration_event(v_p.epa_registration, 'updated', 'EPA lookup proposal ' || v_p.id, v_before,
      to_jsonb(v_reg), '[]'::jsonb);
    v_reg_version := v_reg.registration_version;
    -- As set_epa_registration: a label that turns restricted-use lists the posted sales that now need records.
    IF v_reg.rup_status = 'yes' AND NOT v_was_yes THEN
      v_posted := public._epa_registration_unrecorded_posted_lines(v_p.epa_registration);
    END IF;
  END IF;

  UPDATE public.epa_chemistry_proposals
     SET status = 'committed', decided_by = v_actor, decided_at = now(), commit_result = v_commit,
         proposal_version = proposal_version + 1, updated_at = now()
   WHERE id = v_p.id;

  SELECT jsonb_object_agg(v, n) INTO v_counts FROM (SELECT value AS v, count(*) AS n FROM jsonb_each_text(v_commit) GROUP BY value) c;
  v_result := jsonb_build_object('status', 'committed', 'proposal_id', v_p.id, 'chemistry_version', v_chem,
    'registration_version', v_reg_version, 'counts', COALESCE(v_counts, '{}'::jsonb), 'commit_result', v_commit,
    'posted_sales_to_record', v_posted);
  PERFORM public.save_idempotency(p_idempotency_key, 'commit_epa_proposal',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 6. reject_epa_proposal (admin)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.reject_epa_proposal(p_proposal_id uuid, p_expected_proposal_version bigint, p_reason text,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_reason text := btrim(p_reason);
  v_fp text;
  v_existing jsonb;
  v_p public.epa_chemistry_proposals;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  v_fp := md5(jsonb_build_object('actor_id', v_actor, 'proposal_id', p_proposal_id,
    'expected_version', p_expected_proposal_version, 'reason', v_reason)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'reject_epa_proposal', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF v_reason IS NULL OR v_reason = '' OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'EPA_REJECT_REASON_REQUIRED: say why (500 characters at most)';
  END IF;
  SELECT * INTO v_p FROM public.epa_chemistry_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EPA_PROPOSAL_NOT_FOUND'; END IF;
  IF v_p.proposal_version IS DISTINCT FROM p_expected_proposal_version THEN
    RAISE EXCEPTION 'EPA_PROPOSAL_STALE: this proposal changed since you opened it; reload and try again';
  END IF;
  IF v_p.status NOT IN ('proposed', 'held') THEN RAISE EXCEPTION 'EPA_PROPOSAL_NOT_OPEN: this proposal is %', v_p.status; END IF;
  UPDATE public.epa_chemistry_proposals
     SET status = 'rejected', hold_reason = NULL, decided_by = v_actor, decided_at = now(), decision_reason = v_reason,
         proposal_version = proposal_version + 1, updated_at = now()
   WHERE id = v_p.id;
  v_result := jsonb_build_object('status', 'rejected', 'proposal_id', v_p.id);
  PERFORM public.save_idempotency(p_idempotency_key, 'reject_epa_proposal',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 7. The typed-chemistry gate, re-issued (sheet 4.F). Same signature, owner, search_path and no grants.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._parent_chemistry_epa_refusal(p_parent_id uuid) RETURNS text
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
   WHERE s.n IS NOT NULL
     -- DM-4: a number EPA has no record of is excused, while that answer is current (sheet 4.F).
     AND NOT EXISTS (
       SELECT 1
         FROM (SELECT l.id FROM public.epa_lookups l
                WHERE l.parent_id = p_parent_id AND l.epa_registration = s.n AND l.status <> 'abandoned'
                  -- a pending lookup past record_epa_lookup's 30 minutes can never be recorded: ignore it
                  AND NOT (l.status = 'pending' AND l.requested_at < now() - interval '30 minutes')
                ORDER BY l.requested_at DESC, l.id DESC LIMIT 1) newest
         JOIN public.epa_lookup_failures f ON f.lookup_id = newest.id AND f.reason = 'not_found'
         JOIN public.epa_registrations r ON r.epa_registration = f.epa_registration
                                        AND r.registration_version = f.registration_version
        WHERE public._epa_link_carries(p_parent_id, s.n, f.link_kind, f.link_id)
          -- any proposal, even rejected or superseded: EPA has found this number before, so an empty answer
          -- now is treated as temporary and never excuses it (security review M2, the blocking side)
          AND NOT EXISTS (SELECT 1 FROM public.epa_chemistry_proposals cp
                           WHERE cp.parent_id = p_parent_id AND cp.epa_registration = s.n));
  IF v_numbers IS NULL THEN RETURN NULL; END IF;
  RETURN format('CHEMISTRY_FROM_EPA_ONLY: this product has EPA number(s) %s; its chemistry comes from the EPA auto-fill',
    array_to_string(v_numbers, ', '));
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 8. Owners and grants
-- ---------------------------------------------------------------------------------------------

DO $grants$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.start_epa_lookup(uuid,text,text)', 'public.record_epa_lookup(uuid,uuid,jsonb,text)',
    'public.commit_epa_proposal(uuid,bigint,jsonb,text)', 'public.reject_epa_proposal(uuid,bigint,text,text)',
    'public._parent_chemistry_epa_refusal(uuid)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role, metabase_ro', f);
  END LOOP;
END
$grants$;
GRANT EXECUTE ON FUNCTION public.start_epa_lookup(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_epa_proposal(uuid, bigint, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_epa_proposal(uuid, bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_epa_lookup(uuid, uuid, jsonb, text) TO service_role;

DO $postflight$
DECLARE
  v_bad text;
  t text;
BEGIN
  -- Browser RPCs: authenticated only. Record: service_role only.
  IF NOT has_function_privilege('authenticated', 'public.start_epa_lookup(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.commit_epa_proposal(uuid,bigint,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.reject_epa_proposal(uuid,bigint,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.start_epa_lookup(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.commit_epa_proposal(uuid,bigint,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reject_epa_proposal(uuid,bigint,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.record_epa_lookup(uuid,uuid,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_epa_lookup(uuid,uuid,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.record_epa_lookup(uuid,uuid,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._parent_chemistry_epa_refusal(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_EPA_PROPOSALS_FUNCTION_GRANTS_WRONG';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('_epa_link_carries', '_epa_find_link', '_epa_label_date', '_epa_lookup_shape_error', '_epa_lookup_input',
                       '_epa_proposal_items', 'refuse_epa_proposal_change', 'refuse_epa_lookup_change',
                       'start_epa_lookup', 'record_epa_lookup', 'commit_epa_proposal', 'reject_epa_proposal',
                       '_parent_chemistry_epa_refusal')
     AND (p.proowner <> 'postgres'::regrole
          OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
          OR (p.proname IN ('start_epa_lookup', 'record_epa_lookup', 'commit_epa_proposal', 'reject_epa_proposal',
                            '_parent_chemistry_epa_refusal', '_epa_link_carries', '_epa_find_link', '_epa_proposal_items')
              AND NOT p.prosecdef)
          OR (p.proname NOT IN ('start_epa_lookup', 'commit_epa_proposal', 'reject_epa_proposal')
              AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
          OR has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('metabase_ro', p.oid, 'EXECUTE')
          OR (p.proname <> 'record_epa_lookup' AND has_function_privilege('service_role', p.oid, 'EXECUTE')));
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'POSTFLIGHT_EPA_PROPOSALS_HELPER_GRANTS_WRONG: %', v_bad; END IF;
  FOREACH t IN ARRAY ARRAY['epa_lookups', 'epa_lookup_failures', 'epa_chemistry_proposals'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)
       OR (SELECT relowner FROM pg_class WHERE oid = ('public.' || t)::regclass) <> 'postgres'::regrole
       OR has_table_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('metabase_ro', 'public.' || t, 'SELECT')
       OR has_table_privilege('service_role', 'public.' || t, 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR NOT has_table_privilege('authenticated', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'POSTFLIGHT_EPA_PROPOSALS_TABLE_GRANTS_WRONG: %', t;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.epa_lookups', 'SELECT')
     OR has_table_privilege('service_role', 'public.epa_lookup_failures', 'SELECT')
     OR has_table_privilege('service_role', 'public.epa_chemistry_proposals', 'SELECT') THEN
    RAISE EXCEPTION 'POSTFLIGHT_EPA_PROPOSALS_SERVICE_READ_WRONG';
  END IF;
END
$postflight$;
