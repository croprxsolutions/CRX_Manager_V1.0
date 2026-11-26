-- Staging activation after the Weight card is available.
-- Only the verified staging migration transaction supplies this marker.

DO $preflight$
BEGIN
  IF current_setting('crx.liquid_weight_staging_project', true) IS DISTINCT FROM 'fsnjredpmakbmhwowjjt' THEN
    RETURN;
  END IF;
  IF to_regclass('public.brand_document_links') IS NULL
     OR (SELECT count(*) FROM pg_attribute
         WHERE attrelid = to_regclass('public.brand_document_links')
           AND attnum > 0 AND NOT attisdropped
           AND (attname, atttypid) IN (
             ('id', 'uuid'::regtype), ('parent_brand_id', 'uuid'::regtype),
             ('document_kind', 'text'::regtype), ('hidden_at', 'timestamptz'::regtype), ('url', 'text'::regtype)
           )) <> 5
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('liquid_density_review_open()', '7d69bbf21ad55293e15c24da50eaaa11', false, true),
         ('get_liquid_density_review(uuid)', '08f4067e9483ef8ac042e2e2a2827570', false, true),
         ('submit_liquid_density_draft(uuid,bigint,numeric,text,text,text,text,text,text)', 'dcb15229da1628f89b1436a19e38844f', true, true),
         ('approve_liquid_density_draft(uuid,uuid,bigint,jsonb,boolean,text)', '2cecbd479f006dd668a898426a59b078', true, true),
         ('reject_liquid_density_draft(uuid,uuid,bigint,text,text)', 'e69a5441a9e35ebadd65f68914b4f657', true, true),
         ('return_liquid_density_to_draft_for_brand()', 'f4a558214d47daf8d0bc2c2785e2f113', true, false),
         ('_write_parent_density(text,uuid,bigint,numeric,text,text,text,text,text)', '2b5e0585e0f86b1e21e3b228101977e4', true, false),
         ('approve_weights(jsonb,text)', 'adda6f0854f3de86bca3e5d50ae88113', true, true)
       ) AS expected(signature, body_hash, definer, authenticated)
       LEFT JOIN pg_proc p ON p.oid = to_regprocedure('public.' || expected.signature)
       WHERE p.oid IS NULL
          OR EXISTS (
            SELECT 1 FROM pg_proc other
            WHERE other.pronamespace = p.pronamespace AND other.proname = p.proname AND other.oid <> p.oid
          )
          OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM expected.body_hash
          OR p.proowner IS DISTINCT FROM 'postgres'::regrole
          OR p.prosecdef IS DISTINCT FROM expected.definer
          OR p.provolatile::text IS DISTINCT FROM CASE
               WHEN expected.signature IN ('liquid_density_review_open()', 'get_liquid_density_review(uuid)') THEN 's'
               ELSE 'v'
             END
          OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
          OR p.proacl IS NULL
          OR EXISTS (
            SELECT 1 FROM aclexplode(p.proacl) AS a
            WHERE a.grantee <> p.proowner
              AND (a.grantee <> 'authenticated'::regrole OR NOT expected.authenticated OR a.is_grantable)
          )
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE') IS DISTINCT FROM expected.authenticated
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid = to_regclass('public.product_parent_brands')
         AND tgfoid = to_regprocedure('public.return_liquid_density_to_draft_for_brand()')
         AND tgname = 'return_liquid_density_to_draft_for_brand'
         AND tgenabled = 'O' AND NOT tgisinternal
         AND pg_get_triggerdef(oid) ~ ' AFTER INSERT OR UPDATE OF status, parent_id, epa_registration, manufacturer ON (public[.])?product_parent_brands FOR EACH ROW EXECUTE FUNCTION (public[.])?return_liquid_density_to_draft_for_brand[(][)]$'
     )
     THEN
    RAISE EXCEPTION 'PREFLIGHT_LIQUID_DENSITY_REVIEW: the prior database safeguards are missing';
  END IF;
  IF public.liquid_density_review_open() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'PREFLIGHT_LIQUID_DENSITY_REVIEW: expected the review switch to be closed';
  END IF;

  CREATE OR REPLACE FUNCTION public.return_liquid_density_to_draft_for_brand() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $brand_review$
  DECLARE
    v_approved public.product_parent_density_values%ROWTYPE;
    v_existing_draft boolean;
    v_before jsonb;
    v_after jsonb;
    v_reason text := 'An active brand joined the product group';
  BEGIN
    IF NOT public.liquid_density_review_open() OR NEW.status <> 'active' THEN RETURN NULL; END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'active' AND OLD.parent_id = NEW.parent_id THEN
      IF (OLD.epa_registration, OLD.manufacturer) IS DISTINCT FROM (NEW.epa_registration, NEW.manufacturer) THEN
        v_reason := 'An active brand changed its EPA registration or manufacturer';
      ELSIF lower(btrim(regexp_replace(OLD.brand_name, '[[:space:]]+', ' ', 'g')))
            IS DISTINCT FROM lower(btrim(regexp_replace(NEW.brand_name, '[[:space:]]+', ' ', 'g'))) THEN
        v_reason := 'An active brand name changed';
      ELSE
        RETURN NULL;
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.product_parents WHERE id = NEW.parent_id AND is_active AND product_form = 'liquid') THEN
      RETURN NULL;
    END IF;

    PERFORM 1 FROM public.product_parent_density_state WHERE parent_id = NEW.parent_id FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT * INTO v_approved FROM public.product_parent_density_values
     WHERE parent_id = NEW.parent_id AND review_state = 'approved' FOR UPDATE;
    v_existing_draft := EXISTS (
      SELECT 1 FROM public.product_parent_density_values WHERE parent_id = NEW.parent_id AND review_state = 'draft'
    );
    IF v_approved.id IS NULL AND NOT v_existing_draft THEN RETURN NULL; END IF;

    UPDATE public.product_parent_density_state SET density_version = density_version + 1
     WHERE parent_id = NEW.parent_id;
    IF v_approved.id IS NULL THEN RETURN NULL; END IF;

    v_before := jsonb_build_object(
      'value_id', v_approved.id, 'review_state', 'approved', 'value', v_approved.lb_per_gal,
      'basis', v_approved.basis, 'reviewed_by', v_approved.reviewed_by, 'reviewed_at', v_approved.reviewed_at
    );
    IF v_existing_draft THEN
      UPDATE public.product_parent_density_values SET review_state = 'superseded', superseded_at = now()
       WHERE id = v_approved.id;
      v_after := v_before || jsonb_build_object('review_state', 'superseded');
    ELSE
      UPDATE public.product_parent_density_values SET review_state = 'draft', reviewed_by = NULL, reviewed_at = NULL
       WHERE id = v_approved.id;
      v_after := v_before || jsonb_build_object('review_state', 'draft', 'reviewed_by', NULL, 'reviewed_at', NULL);
    END IF;
    PERFORM public._product_weight_event('parent_density', NEW.parent_id, NULL, 'returned_to_draft', v_approved.id,
      jsonb_build_array(v_before), jsonb_build_array(v_after), v_reason, NULL);
    RETURN NULL;
  END;
  $brand_review$;

  CREATE OR REPLACE TRIGGER return_liquid_density_to_draft_for_brand
    AFTER INSERT OR UPDATE OF status, parent_id, epa_registration, manufacturer, brand_name ON public.product_parent_brands
    FOR EACH ROW EXECUTE FUNCTION public.return_liquid_density_to_draft_for_brand();

  CREATE OR REPLACE FUNCTION public.liquid_density_review_open() RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $function$
  SELECT true;
  $function$;
END;
$preflight$;
