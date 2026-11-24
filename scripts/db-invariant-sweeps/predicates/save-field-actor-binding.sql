-- predicate: save-field-actor-binding
-- Fail closed unless the exact reviewed save_field body from migration
-- 20261107140000 (20260729222311's actor binding plus the KI-31 FIELD_NOT_FOUND
-- check) is installed. Any body change requires a fresh security
-- review and an intentional fingerprint update.
-- Two accepted shapes: that body as public.save_field itself (before KI-10
-- batch 4d), or that body renamed unchanged to _save_field_replay_impl_20261015
-- behind the exact reviewed batch 4d wrapper (20261114200000, live 2026-11-06).

WITH pins AS (
  SELECT '1db4e4fe60469c50dcb4ae5ae892fb0781919422f8624cc3626368195f1850cf'::text AS reviewed_body,
         '54bc2ac100ec93402ce3990b387b8b7f2bd2549e7746dfe2d72162ceaba345c7'::text AS batch4d_wrapper
), installed AS (
  SELECT p.proname, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS body_sha
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('save_field', '_save_field_replay_impl_20261015')
    AND oidvectortypes(p.proargtypes) = 'uuid, jsonb, jsonb, uuid, text'
)
SELECT 'save_field(uuid, jsonb, jsonb, uuid, text)' AS violation_key
FROM pins
WHERE NOT EXISTS (
  SELECT 1 FROM installed
  WHERE proname = 'save_field' AND body_sha = pins.reviewed_body
)
AND NOT (
  EXISTS (SELECT 1 FROM installed WHERE proname = 'save_field' AND body_sha = pins.batch4d_wrapper)
  AND EXISTS (SELECT 1 FROM installed WHERE proname = '_save_field_replay_impl_20261015' AND body_sha = pins.reviewed_body)
);
