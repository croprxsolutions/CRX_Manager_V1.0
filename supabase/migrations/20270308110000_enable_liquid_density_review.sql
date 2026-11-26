-- Enable the reviewed liquid weight workflow after its Weight card is available.
-- The guard and trigger functions ship closed in the earlier migration.

DO $preflight$
BEGIN
  IF to_regclass('public.brand_document_links') IS NULL
     OR to_regprocedure('public.get_liquid_density_review(uuid)') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc
       WHERE oid = to_regprocedure('public.submit_liquid_density_draft(uuid,bigint,numeric,text,text,text,text,text,text)')
         AND md5(replace(prosrc, chr(13), '')) = 'dcb15229da1628f89b1436a19e38844f'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc
       WHERE oid = to_regprocedure('public.approve_liquid_density_draft(uuid,uuid,bigint,jsonb,boolean,text)')
         AND md5(replace(prosrc, chr(13), '')) = '2cecbd479f006dd668a898426a59b078'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc
       WHERE oid = to_regprocedure('public.reject_liquid_density_draft(uuid,uuid,bigint,text,text)')
         AND md5(replace(prosrc, chr(13), '')) = 'e69a5441a9e35ebadd65f68914b4f657'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid = to_regclass('public.product_parent_brands')
         AND tgfoid = to_regprocedure('public.return_liquid_density_to_draft_for_brand()')
         AND tgname = 'return_liquid_density_to_draft_for_brand'
         AND tgenabled IN ('O', 'A') AND NOT tgisinternal
         AND pg_get_triggerdef(oid) ~ ' AFTER INSERT OR UPDATE OF status, parent_id, epa_registration, manufacturer ON (public[.])?product_parent_brands FOR EACH ROW EXECUTE FUNCTION (public[.])?return_liquid_density_to_draft_for_brand[(][)]$'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc
       WHERE oid = to_regprocedure('public.return_liquid_density_to_draft_for_brand()')
         AND md5(replace(prosrc, chr(13), '')) = 'f4a558214d47daf8d0bc2c2785e2f113'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc
       WHERE oid = to_regprocedure('public._write_parent_density(text,uuid,bigint,numeric,text,text,text,text,text)')
         AND md5(replace(prosrc, chr(13), '')) = '2b5e0585e0f86b1e21e3b228101977e4'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc
       WHERE oid = to_regprocedure('public.approve_weights(jsonb,text)')
         AND md5(replace(prosrc, chr(13), '')) = 'adda6f0854f3de86bca3e5d50ae88113'
     ) THEN
    RAISE EXCEPTION 'PREFLIGHT_LIQUID_DENSITY_REVIEW: the prior database safeguards are missing';
  END IF;
  IF public.liquid_density_review_open() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'PREFLIGHT_LIQUID_DENSITY_REVIEW: expected the review switch to be closed';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.liquid_density_review_open() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $function$
  SELECT true;
$function$;
