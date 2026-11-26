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
         AND tgenabled IN ('O', 'A') AND NOT tgisinternal
         AND pg_get_triggerdef(oid) ~ ' AFTER INSERT OR UPDATE OF status, parent_id, epa_registration, manufacturer ON (public[.])?product_parent_brands FOR EACH ROW EXECUTE FUNCTION (public[.])?return_liquid_density_to_draft_for_brand[(][)]$'
     )
     THEN
    RAISE EXCEPTION 'PREFLIGHT_LIQUID_DENSITY_REVIEW: the prior database safeguards are missing';
  END IF;
  IF public.liquid_density_review_open() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'PREFLIGHT_LIQUID_DENSITY_REVIEW: expected the review switch to be closed';
  END IF;
  CREATE OR REPLACE FUNCTION public.liquid_density_review_open() RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $function$
  SELECT true;
  $function$;
END;
$preflight$;
