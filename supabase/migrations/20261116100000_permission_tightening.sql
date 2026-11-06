-- Written 2026-11-05. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261116100000_permission_tightening.md.
-- Re-read the live ledger before applying.
--
-- WHAT (permissions; Mason's decisions of 2026-11-05, about 10:30 PM Central):
--   1. KI-101 residual. Signed-in users lose their direct UPDATE grant on orders.status, so an
--      order's status changes only through the SECURITY DEFINER functions (delivery completion,
--      cancel, void, pricing), which run as postgres and are unaffected. Every other orders column
--      keeps its UPDATE grant (the screens still set notes, the planned flag, the soft delete...).
--   2. KI-07. Signed-in and anonymous users lose TRUNCATE and TRIGGER on profiles.
--   3. KI-26. The four older delivery-signature storage rules for the fixed path
--      signatures/<delivery id>.png (from before 20261022075000):
--        * insert, update and delete are dropped: no app version writes or removes that path any
--          more, and they let staff replace or remove proof on deliveries completed before then;
--        * select now also requires that file to be the delivery's recorded signature
--          (deliveries.signature_url), for the same people as before (admin, sales rep, or the
--          delivery's active assigned driver).
--      The per-attempt rules (signatures/<id>/<32 hex>.png) and the restrictive no-update /
--      no-delete rules from 20261022075000 are unchanged.
--
-- NOT CHANGED: every function, trigger and table; every other grant and policy; no rows.
-- The service role (Edge Functions) is not in any REVOKE here and bypasses row security, so it is
-- unaffected. The DROP/ALTER POLICY statements briefly lock storage.objects (all buckets) until
-- commit; lock_timeout caps the wait at 5 s.
--
-- ROLLBACK (its own reviewed migration): GRANT UPDATE (status) ON public.orders TO authenticated;
--   GRANT TRUNCATE, TRIGGER ON public.profiles TO authenticated; re-create the three dropped
--   policies and re-set the select policy from supabase/baselines/20260727174805_platform_overlay.sql.
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE permission_tightening_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.permission_tightening_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.permission_tightening_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PERMISSION_TIGHTENING_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  -- A column REVOKE only works while no table-wide UPDATE grant covers the column.
  IF has_table_privilege('authenticated', 'public.orders', 'UPDATE')
     OR has_table_privilege('anon', 'public.orders', 'UPDATE') THEN
    RAISE EXCEPTION 'PERMISSION_TIGHTENING_PREFLIGHT: a table-wide UPDATE grant on orders exists; a column revoke would not close it';
  END IF;
  -- The four older signature rules, exactly as read live 2026-11-05 (same md5 recipe as 20261022075000).
  IF (SELECT string_agg(policyname || '=' || md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')), ',' ORDER BY policyname)
        FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname IN ('delivery_signatures_scoped_select', 'delivery_signatures_scoped_insert',
                            'delivery_signatures_scoped_update', 'delivery_signatures_scoped_delete'))
     IS DISTINCT FROM 'delivery_signatures_scoped_delete=b613f0278f79ff2fb50bca39823fd1ca,'
                   || 'delivery_signatures_scoped_insert=8dec52ae49cc1ace8678d320a2d899c9,'
                   || 'delivery_signatures_scoped_select=3fa6fdae43648f207c08c3ce3b276397,'
                   || 'delivery_signatures_scoped_update=8e1331d356854ab54e419bf0ba9ba037' THEN
    RAISE EXCEPTION 'PERMISSION_TIGHTENING_PREFLIGHT: the four older delivery-signature policies drifted';
  END IF;
END
$preflight$;

-- 1. KI-101: order status changes only through the server functions.
REVOKE UPDATE (status) ON public.orders FROM authenticated, anon;

-- 2. KI-07.
REVOKE TRUNCATE, TRIGGER ON public.profiles FROM authenticated, anon;

-- 3. KI-26: nobody signed in writes, replaces or removes a signature at the old fixed path.
DROP POLICY delivery_signatures_scoped_insert ON storage.objects;
DROP POLICY delivery_signatures_scoped_update ON storage.objects;
DROP POLICY delivery_signatures_scoped_delete ON storage.objects;

-- Reading an old signature stays open to the same people, but only the file the delivery records.
ALTER POLICY delivery_signatures_scoped_select ON storage.objects
  USING (
    bucket_id = 'delivery-signatures'
    AND EXISTS (
      SELECT 1
        FROM public.deliveries d
       WHERE objects.name = ('signatures/' || d.id::text || '.png')
         AND d.signature_url = objects.name
         AND (
           public.is_admin()
           OR public.is_sales_rep()
           OR (EXISTS (SELECT 1 FROM public.profiles p
                        WHERE p.id = (SELECT auth.uid()) AND p.role = 'driver' AND p.is_active = true)
               AND d.assigned_driver = (SELECT auth.uid()))
         )
    )
  );

DO $postflight$
BEGIN
  IF has_column_privilege('authenticated', 'public.orders', 'status', 'UPDATE')
     OR has_column_privilege('anon', 'public.orders', 'status', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.orders', 'is_planned', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.orders', 'deleted_at', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.orders', 'status', 'SELECT') THEN
    RAISE EXCEPTION 'PERMISSION_TIGHTENING_POSTFLIGHT: orders grants are not as intended';
  END IF;
  IF has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.profiles', 'TRIGGER')
     OR has_table_privilege('anon', 'public.profiles', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.profiles', 'TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'PERMISSION_TIGHTENING_POSTFLIGHT: profiles grants are not as intended';
  END IF;
  IF (SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname)
        FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%delivery-signatures%')
     IS DISTINCT FROM 'delivery_signatures_attempt_insert:INSERT,delivery_signatures_attempt_select:SELECT,delivery_signatures_scoped_select:SELECT' THEN
    RAISE EXCEPTION 'PERMISSION_TIGHTENING_POSTFLIGHT: delivery-signature policy set is not as intended';
  END IF;
  -- The narrowed read rule as reviewed, and the 20261022075000 restrictive rules (they name no
  -- bucket, so the set above cannot see them) still in place, all for authenticated only.
  IF (SELECT string_agg(policyname || '=' || permissive || '=' || md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')), ',' ORDER BY policyname)
        FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname IN ('delivery_signatures_scoped_select', 'delivery_evidence_objects_no_update',
                            'delivery_evidence_objects_no_delete'))
     IS DISTINCT FROM 'delivery_evidence_objects_no_delete=RESTRICTIVE=2e0dd64d0b25a9478be6576a2985f9aa,'
                   || 'delivery_evidence_objects_no_update=RESTRICTIVE=0b0038bcf5071878ee813adb923f1479,'
                   || 'delivery_signatures_scoped_select=PERMISSIVE=2384b70ad2be19dbe718ca42e744138e' THEN
    RAISE EXCEPTION 'PERMISSION_TIGHTENING_POSTFLIGHT: the narrowed read rule or the restrictive evidence rules are not as intended';
  END IF;
END
$postflight$;
