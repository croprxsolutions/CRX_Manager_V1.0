-- predicate: save-field-actor-binding
-- Fail closed unless the exact reviewed save_field body from migration
-- 20261107140000 (20260729222311's actor binding plus the KI-31 FIELD_NOT_FOUND
-- check) is installed. Any body change requires a fresh security
-- review and an intentional fingerprint update.

WITH exact_signature AS (
  SELECT p.prosrc
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'save_field'
    AND oidvectortypes(p.proargtypes) = 'uuid, jsonb, jsonb, uuid, text'
)
SELECT 'save_field(uuid, jsonb, jsonb, uuid, text)' AS violation_key
WHERE NOT EXISTS (
  SELECT 1
  FROM exact_signature
  WHERE encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') =
        '1db4e4fe60469c50dcb4ae5ae892fb0781919422f8624cc3626368195f1850cf'
);
