-- Written 2026-11-05. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261107140000_save_field_refuses_missing_field.md.
-- Re-read the live ledger before applying.
--
-- WHAT (KI-31): save_field updated a field by id and reported success even when no field had that id.
--   The UPDATE changed nothing, the RPC wrote a 'field_saved' activity row for a field that does not exist
--   and returned the id as if the save had worked. Now an update whose id matches no field raises
--   FIELD_NOT_FOUND; nothing is written (no activity row, no billing defaults, no idempotency receipt).
--
-- NOT CHANGED: creating a field (p_field_id NULL), every other validation, the actor binding, the role gate,
--   the idempotency replay, the return value, SECURITY DEFINER, search_path and grants. CREATE OR REPLACE keeps
--   the existing ACL; this file changes no permissions. No table, column or row changes.
--
-- ROLLBACK (its own reviewed migration): re-emit save_field from 20260729222311_bind_save_field_actor.sql.
--
-- ORDERING: apply after 20260729222311 (the live body this file pins).

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_count integer;
  v_md5 text;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'save_field';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SAVE_FIELD_PREFLIGHT: expected one save_field overload, found %', v_count;
  END IF;

  SELECT md5(p.prosrc) INTO STRICT v_md5
  FROM pg_proc p
  WHERE p.oid = 'public.save_field(uuid,jsonb,jsonb,uuid,text)'::regprocedure;
  -- The body applied by 20260729222311, read live 2026-11-05.
  IF v_md5 IS DISTINCT FROM '4d27ca30b128d7ad1e666c61059599b7' THEN
    RAISE EXCEPTION 'SAVE_FIELD_PREFLIGHT: live body changed (md5 %); re-read it before applying', v_md5;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.save_field(
  p_field_id uuid,
  p_field_payload jsonb,
  p_billing_defaults jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_field_id uuid;
  v_total_pct numeric;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_field');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'field_id')::uuid; END IF;
  END IF;

  IF jsonb_array_length(p_billing_defaults) > 0 THEN
    SELECT COALESCE(SUM((elem->>'split_pct')::numeric), 0) INTO v_total_pct
    FROM jsonb_array_elements(p_billing_defaults) AS elem;
    IF ABS(v_total_pct - 100) > 0.01 THEN
      RAISE EXCEPTION 'Billing splits must total 100%% (got %.2f%%)', v_total_pct;
    END IF;
  END IF;

  IF p_field_id IS NULL THEN
    INSERT INTO fields (
      customer_id, field_name, legal_description, county, state,
      total_acres, fsa_farm_number, fsa_tract_number, fsa_field_number,
      crop_type, soil_type, irrigation, notes, is_active
    )
    SELECT
      (p_field_payload->>'customer_id')::uuid,
      p_field_payload->>'field_name',
      p_field_payload->>'legal_description',
      p_field_payload->>'county',
      COALESCE(p_field_payload->>'state', 'IL'),
      (p_field_payload->>'total_acres')::numeric,
      p_field_payload->>'fsa_farm_number',
      p_field_payload->>'fsa_tract_number',
      p_field_payload->>'fsa_field_number',
      p_field_payload->>'crop_type',
      p_field_payload->>'soil_type',
      COALESCE((p_field_payload->>'irrigation')::boolean, false),
      p_field_payload->>'notes',
      COALESCE((p_field_payload->>'is_active')::boolean, true)
    RETURNING id INTO v_field_id;
  ELSE
    UPDATE fields SET
      customer_id = (p_field_payload->>'customer_id')::uuid,
      field_name = p_field_payload->>'field_name',
      legal_description = p_field_payload->>'legal_description',
      county = p_field_payload->>'county',
      state = COALESCE(p_field_payload->>'state', 'IL'),
      total_acres = (p_field_payload->>'total_acres')::numeric,
      fsa_farm_number = p_field_payload->>'fsa_farm_number',
      fsa_tract_number = p_field_payload->>'fsa_tract_number',
      fsa_field_number = p_field_payload->>'fsa_field_number',
      crop_type = p_field_payload->>'crop_type',
      soil_type = p_field_payload->>'soil_type',
      irrigation = COALESCE((p_field_payload->>'irrigation')::boolean, false),
      notes = p_field_payload->>'notes',
      is_active = COALESCE((p_field_payload->>'is_active')::boolean, true)
    WHERE id = p_field_id;
    -- KI-31: an id that matches no field is an error, not a silent success.
    IF NOT FOUND THEN RAISE EXCEPTION 'FIELD_NOT_FOUND'; END IF;
    v_field_id := p_field_id;
  END IF;

  DELETE FROM field_billing_defaults WHERE field_id = v_field_id;
  IF jsonb_array_length(p_billing_defaults) > 0 THEN
    INSERT INTO field_billing_defaults (
      field_id, customer_id, split_pct, is_primary, notes,
      price_override_cents, pricing_note
    )
    SELECT
      v_field_id, (elem->>'customer_id')::uuid, (elem->>'split_pct')::numeric,
      COALESCE((elem->>'is_primary')::boolean, false), elem->>'notes',
      (elem->>'price_override_cents')::bigint, elem->>'pricing_note'
    FROM jsonb_array_elements(p_billing_defaults) AS elem;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    'field_saved', 'Field saved: ' || (p_field_payload->>'field_name'),
    v_actor, 'field', v_field_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field', jsonb_build_object('field_id', v_field_id));
  END IF;
  RETURN v_field_id;
END;
$$;

DO $postflight$
DECLARE
  v_fn oid := 'public.save_field(uuid,jsonb,jsonb,uuid,text)'::regprocedure::oid;
  v_source text;
BEGIN
  IF (SELECT count(*) FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'save_field') <> 1 THEN
    RAISE EXCEPTION 'SAVE_FIELD_OVERLOAD_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = v_fn
      AND p.prosecdef
      AND p.proconfig = ARRAY['search_path=public, pg_temp']
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND has_function_privilege('service_role', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT EXISTS (
        SELECT 1
        FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION 'SAVE_FIELD_SECURITY_CONTRACT_DRIFT';
  END IF;

  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p WHERE p.oid = v_fn;
  IF position('IF NOT FOUND THEN RAISE EXCEPTION ''FIELD_NOT_FOUND''; END IF;' IN v_source) = 0
     OR position('v_actor := auth.uid()' IN v_source) = 0
     OR position('ACTOR_MISMATCH' IN v_source) = 0
     OR position('v_actor, ''field'', v_field_id' IN v_source) = 0 THEN
    RAISE EXCEPTION 'SAVE_FIELD_POSTFLIGHT: new body markers missing';
  END IF;
END;
$postflight$;
