-- idempotency-body-check: exempt
-- (Keys are checked by public._product_parent_replay at the top of the body and saved by save_idempotency at
--  the end, the same pattern as 20261123120000 and 20261201110000.)
-- Written 2026-11-06. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261203110000_parent_brand_save_checks_size.md. Re-read the live ledger before applying.
--
-- WHY (PAR-2 screens Sol rounds 1 and 2, HIGH): a size's product page edits its parent's shared brand
--   list through upsert_parent_brand, which takes only the parent id. If the size was moved to another
--   parent (move_product_size) after the page loaded, the edit lands on the OLD parent's list. A client
--   re-check before saving leaves a gap between the read and the write; only the database can close it.
--
-- WHAT: upsert_parent_brand gains a required p_product_id (the size whose page is saving). After it takes
--   the parent row FOR SHARE (move_product_size takes the same row FOR UPDATE first, so the two take
--   turns), a separate statement refuses with PRODUCT_BRANDS_PARENT_CHANGED unless that size is still a
--   member of p_parent_id. p_product_id is part of the retry fingerprint. Everything else is the live body
--   unchanged (pinned below by md5).
--
-- WHY DROP + CREATE: adding a parameter is a new signature; keeping the old one would leave the unchecked
--   path callable. No released screen calls upsert_parent_brand (the PAR-2 screens are unreleased) and the
--   live function refuses every call while grouping is switched off, so nothing live breaks. No data changes.
--
-- ROLLBACK (its own reviewed migration): drop this signature and re-create the 12-argument function from
--   20261123120000_product_parent_proposals.sql with the same owner and grants.
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.upsert_parent_brand(uuid,text,text,text,boolean,boolean,text,uuid,integer,boolean,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PARENT_BRAND_SIZE_CHECK_PREFLIGHT: the 12-argument upsert_parent_brand is missing';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.upsert_parent_brand(uuid,text,text,text,boolean,boolean,text,uuid,integer,boolean,text,text)'::regprocedure)
       IS DISTINCT FROM 'be06cf9efe8f4d47ad78ec53c027e996' THEN
    RAISE EXCEPTION 'PARENT_BRAND_SIZE_CHECK_PREFLIGHT: upsert_parent_brand changed since this was written; re-base on the installed body';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'upsert_parent_brand' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'PARENT_BRAND_SIZE_CHECK_PREFLIGHT: expected exactly one upsert_parent_brand';
  END IF;
END
$preflight$;

DROP FUNCTION public.upsert_parent_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text);

CREATE FUNCTION public.upsert_parent_brand(p_parent_id uuid, p_product_id uuid, p_brand_name text,
  p_epa_registration text, p_manufacturer text, p_is_currently_sourced boolean, p_is_rup boolean, p_signal_word text,
  p_brand_id uuid DEFAULT NULL::uuid, p_expected_row_version integer DEFAULT NULL::integer,
  p_retire boolean DEFAULT false, p_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'parent_id', p_parent_id, 'product_id', p_product_id,
    'brand_id', p_brand_id,
    'brand_name', p_brand_name, 'epa_registration', p_epa_registration, 'manufacturer', p_manufacturer,
    'is_currently_sourced', p_is_currently_sourced, 'is_rup', p_is_rup, 'signal_word', p_signal_word,
    'expected_row_version', p_expected_row_version, 'retire', p_retire, 'reason', p_reason)::text);
  v_brand_name text := btrim(p_brand_name);
  v_epa text := NULLIF(btrim(p_epa_registration), '');
  v_manufacturer text := NULLIF(btrim(p_manufacturer), '');
  v_reason text;
  v_existing jsonb;
  v_old public.product_parent_brands%ROWTYPE;
  v_saved public.product_parent_brands%ROWTYPE;
  v_parent_active boolean;
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'upsert_parent_brand', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF NOT public._product_parent_grouping_open() THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_GROUPING_NOT_OPEN: parent brand lists open when the new product screens are live'
      USING ERRCODE = '55000';
  END IF;
  IF p_product_id IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_ID_REQUIRED: name the size whose page is saving this brand' USING ERRCODE = '22023';
  END IF;
  IF v_brand_name IS NULL OR v_brand_name = '' THEN
    RAISE EXCEPTION 'BRAND_NAME_REQUIRED: enter the brand name' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_brand_name) > 200 OR char_length(v_manufacturer) > 200 THEN
    RAISE EXCEPTION 'BRAND_TEXT_TOO_LONG: brand and manufacturer names are limited to 200 characters' USING ERRCODE = '22023';
  END IF;
  IF v_epa IS NOT NULL AND v_epa !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_INVALID: % is not an EPA registration number (like 524-475 or 100-1234-5905)', v_epa
      USING ERRCODE = '22023';
  END IF;
  IF p_is_currently_sourced IS NULL THEN RAISE EXCEPTION 'CURRENTLY_SOURCED_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_signal_word IS NOT NULL AND p_signal_word NOT IN ('Danger', 'Warning', 'Caution') THEN
    RAISE EXCEPTION 'SIGNAL_WORD_INVALID: %', p_signal_word USING ERRCODE = '22023';
  END IF;
  IF p_brand_id IS NULL AND (p_expected_row_version IS NOT NULL OR COALESCE(p_retire, false)) THEN
    RAISE EXCEPTION 'ROW_VERSION_UNEXPECTED: a new brand has no version yet and cannot be retired' USING ERRCODE = '22023';
  END IF;
  IF p_brand_id IS NOT NULL AND p_expected_row_version IS NULL THEN
    RAISE EXCEPTION 'ROW_VERSION_REQUIRED: an edit must name the version it read' USING ERRCODE = '22023';
  END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', COALESCE(p_retire, false));

  SELECT is_active INTO v_parent_active FROM public.product_parents WHERE id = p_parent_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  IF NOT v_parent_active THEN RAISE EXCEPTION 'PRODUCT_PARENT_INACTIVE: reactivate this product before changing its brands'; END IF;
  -- A separate statement after the parent lock, so a move_product_size that held the parent first is seen.
  IF NOT EXISTS (SELECT 1 FROM public.product_parent_members m WHERE m.product_id = p_product_id AND m.parent_id = p_parent_id) THEN
    RAISE EXCEPTION 'PRODUCT_BRANDS_PARENT_CHANGED: this size is no longer under that parent; reload the page'
      USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.products p WHERE p.id IN (SELECT m.product_id FROM public.product_parent_members m
                                                   WHERE m.parent_id = p_parent_id)
   ORDER BY p.id FOR NO KEY UPDATE;

  IF p_brand_id IS NULL THEN
    BEGIN
      INSERT INTO public.product_parent_brands (parent_id, brand_name, epa_registration, manufacturer,
        is_currently_sourced, is_rup, signal_word, created_by, updated_by)
      VALUES (p_parent_id, v_brand_name, v_epa, v_manufacturer, p_is_currently_sourced, p_is_rup, p_signal_word,
        v_actor, v_actor)
      RETURNING * INTO v_saved;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'BRAND_NAME_TAKEN: this product already lists a brand named %', v_brand_name USING ERRCODE = '23505';
    END;
    PERFORM public._parent_brand_event(v_saved.id, p_parent_id, 'created', v_reason, NULL, to_jsonb(v_saved));
  ELSE
    SELECT * INTO v_old FROM public.product_parent_brands WHERE id = p_brand_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BRAND_NOT_FOUND: %', p_brand_id USING ERRCODE = 'P0002'; END IF;
    IF v_old.parent_id IS DISTINCT FROM p_parent_id THEN
      RAISE EXCEPTION 'BRAND_PRODUCT_MISMATCH: brand % belongs to another product', p_brand_id USING ERRCODE = '22023';
    END IF;
    IF v_old.status = 'retired' THEN
      RAISE EXCEPTION 'BRAND_RETIRED: this brand was retired and cannot be changed' USING ERRCODE = '22023';
    END IF;
    IF v_old.row_version IS DISTINCT FROM p_expected_row_version THEN
      RAISE EXCEPTION 'BRAND_CHANGED: someone else changed this brand; reload and try again'
        USING ERRCODE = '40001', DETAIL = format('expected version %s, found %s', p_expected_row_version, v_old.row_version);
    END IF;
    BEGIN
      UPDATE public.product_parent_brands SET brand_name = v_brand_name, epa_registration = v_epa,
        manufacturer = v_manufacturer, is_currently_sourced = p_is_currently_sourced, is_rup = p_is_rup,
        signal_word = p_signal_word, row_version = v_old.row_version + 1,
        status = CASE WHEN COALESCE(p_retire, false) THEN 'retired' ELSE 'active' END, updated_by = v_actor
      WHERE id = p_brand_id
      RETURNING * INTO v_saved;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'BRAND_NAME_TAKEN: this product already lists a brand named %', v_brand_name USING ERRCODE = '23505';
    END;
    PERFORM public._parent_brand_event(v_saved.id, p_parent_id,
      CASE WHEN COALESCE(p_retire, false) THEN 'retired' ELSE 'updated' END, v_reason, to_jsonb(v_old), to_jsonb(v_saved));
  END IF;

  v_result := to_jsonb(v_saved);
  PERFORM public.save_idempotency(p_idempotency_key, 'upsert_parent_brand',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.upsert_parent_brand(uuid, uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.upsert_parent_brand(uuid, uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_parent_brand(uuid, uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text)
  TO authenticated;
COMMENT ON FUNCTION public.upsert_parent_brand(uuid, uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text) IS
  'Admin-only add, edit or retire of a parent''s shared brand, saved from one of its sizes (p_product_id); refused with PRODUCT_BRANDS_PARENT_CHANGED unless that size is still under p_parent_id. Refused with PRODUCT_PARENT_GROUPING_NOT_OPEN while grouping is switched off. Retry key bound to caller + request; an edit must pass the row_version it read.';

DO $postflight$
DECLARE
  v_sig constant text := 'public.upsert_parent_brand(uuid,uuid,text,text,text,boolean,boolean,text,uuid,integer,boolean,text,text)';
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'upsert_parent_brand' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'PARENT_BRAND_SIZE_CHECK_POSTFLIGHT: expected exactly one upsert_parent_brand';
  END IF;
  IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'PARENT_BRAND_SIZE_CHECK_POSTFLIGHT: upsert_parent_brand grants are not authenticated-only';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_sig::regprocedure)
     OR NOT (SELECT proconfig @> ARRAY['search_path=public, pg_temp'] FROM pg_proc WHERE oid = v_sig::regprocedure) THEN
    RAISE EXCEPTION 'PARENT_BRAND_SIZE_CHECK_POSTFLIGHT: upsert_parent_brand must be SECURITY DEFINER with the pinned search_path';
  END IF;
END
$postflight$;
