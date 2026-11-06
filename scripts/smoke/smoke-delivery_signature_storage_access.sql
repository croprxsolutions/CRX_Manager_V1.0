-- Delivery-signature Storage access after 20261116100000_permission_tightening (KI-26).
-- Old fixed-path files signatures/<delivery id>.png: readable only when the delivery records that
-- file, by an admin, a sales rep or the delivery's active assigned driver; nobody signed in can
-- write, replace or delete one. Per-attempt files are covered by the 20261022075000 proof.
DO $$
DECLARE
  v_policy_set text;
  v_bucket_public boolean;
  v_delivery_id uuid;
  v_driver_id uuid;
  v_object_id uuid;
  v_insert_delivery_id uuid;
  v_stranger_id uuid;
  v_admin_id uuid;
  v_forged_id uuid := gen_random_uuid();
  v_rows integer;
  v_denied boolean := false;
  v_sales_rep_source text;
BEGIN
  SELECT p.prosrc
  INTO v_sales_rep_source
  FROM pg_proc p
  WHERE p.oid = 'public.is_sales_rep()'::regprocedure;

  IF position('FROM public.profiles' IN v_sales_rep_source) = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: is_sales_rep does not qualify public.profiles';
  END IF;

  IF has_function_privilege('anon', 'public.is_sales_rep()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.is_sales_rep()', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: is_sales_rep EXECUTE grants are not least-privilege';
  END IF;

  -- A temp relation must never shadow the authorization helper's real profile source.
  CREATE TEMP TABLE profiles (
    id uuid PRIMARY KEY,
    role text,
    is_active boolean
  ) ON COMMIT DROP;
  INSERT INTO profiles (id, role, is_active)
  VALUES (v_forged_id, 'sales_rep', true);

  PERFORM set_config('request.jwt.claim.sub', v_forged_id::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  IF public.is_sales_rep() THEN
    RAISE EXCEPTION 'SMOKE_FAIL: temp profiles table forged sales-rep authorization';
  END IF;
  EXECUTE 'RESET ROLE';

  -- Only the per-attempt pair and the narrowed old-path read rule name this bucket.
  SELECT string_agg(p.policyname || ':' || p.cmd, ',' ORDER BY p.policyname)
  INTO v_policy_set
  FROM pg_policies p
  WHERE p.schemaname = 'storage'
    AND p.tablename = 'objects'
    AND coalesce(p.qual, '') || coalesce(p.with_check, '') LIKE '%delivery-signatures%';

  SELECT public INTO v_bucket_public
  FROM storage.buckets
  WHERE id = 'delivery-signatures';

  IF v_policy_set IS DISTINCT FROM 'delivery_signatures_attempt_insert:INSERT,delivery_signatures_attempt_select:SELECT,delivery_signatures_scoped_select:SELECT'
     OR v_bucket_public IS DISTINCT FROM false
     OR NOT EXISTS (SELECT 1 FROM pg_policies p
                     WHERE p.schemaname = 'storage' AND p.tablename = 'objects'
                       AND p.policyname = 'delivery_signatures_scoped_select'
                       AND p.qual LIKE '%signature_url%' AND p.qual LIKE '%assigned_driver%'
                       AND p.qual LIKE '%is_active%' AND p.qual LIKE '%is_admin%'
                       AND p.qual LIKE '%is_sales_rep%') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery signature Storage policies are not as intended (set=%, public=%)',
      v_policy_set, v_bucket_public;
  END IF;

  -- A completed delivery whose recorded signature is its old fixed-path file, with an active driver.
  SELECT d.id, d.assigned_driver, o.id
  INTO v_delivery_id, v_driver_id, v_object_id
  FROM public.deliveries d
  JOIN storage.objects o
    ON o.bucket_id = 'delivery-signatures'
   AND o.name = 'signatures/' || d.id::text || '.png'
   AND d.signature_url = o.name
  JOIN public.profiles dp
    ON dp.id = d.assigned_driver AND dp.role = 'driver' AND dp.is_active
  WHERE d.status = 'completed'
  ORDER BY d.id
  LIMIT 1;

  SELECT d.id
  INTO v_insert_delivery_id
  FROM public.deliveries d
  WHERE d.status = 'completed'
    AND d.assigned_driver = v_driver_id
    AND NOT EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'delivery-signatures'
        AND o.name = 'signatures/' || d.id::text || '.png'
    )
  ORDER BY d.id
  LIMIT 1;

  SELECT p.id
  INTO v_stranger_id
  FROM public.profiles p
  WHERE p.is_active
    AND p.id <> v_driver_id
    AND p.role NOT IN ('admin', 'sales_rep')
  ORDER BY p.id
  LIMIT 1;

  SELECT p.id
  INTO v_admin_id
  FROM public.profiles p
  WHERE p.is_active
    AND p.role = 'admin'
  ORDER BY p.id
  LIMIT 1;

  IF v_object_id IS NULL OR v_insert_delivery_id IS NULL OR
     v_stranger_id IS NULL OR v_admin_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: assigned-driver signature fixture is unavailable';
  END IF;

  -- The assigned driver reads the recorded file but cannot replace it or write a new old-path file.
  PERFORM set_config('request.jwt.claim.sub', v_driver_id::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*) INTO v_rows
  FROM storage.objects WHERE id = v_object_id;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: assigned driver cannot read own recorded delivery signature';
  END IF;

  UPDATE storage.objects SET metadata = metadata WHERE id = v_object_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: assigned driver can replace an old delivery signature';
  END IF;

  v_denied := false;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
    VALUES (
      'delivery-signatures',
      'signatures/' || v_insert_delivery_id::text || '.png',
      auth.uid()::text,
      '{"mimetype":"image/png","size":2400}'::jsonb
    );
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_denied := true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT v_denied THEN
    RAISE EXCEPTION 'SMOKE_FAIL: assigned driver can write an old-path delivery signature';
  END IF;

  -- The same driver loses read access once deactivated (rolled back with everything else). Only an
  -- admin may change is_active (PROFILE_ROLE_LOCK).
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  UPDATE public.profiles
  SET is_active = false
  WHERE id = v_driver_id;

  PERFORM set_config('request.jwt.claim.sub', v_driver_id::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows
  FROM storage.objects WHERE id = v_object_id;
  EXECUTE 'RESET ROLE';
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inactive assigned driver can read delivery signature';
  END IF;

  -- An unrelated signed-in user reads nothing.
  PERFORM set_config('request.jwt.claim.sub', v_stranger_id::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows
  FROM storage.objects WHERE id = v_object_id;
  EXECUTE 'RESET ROLE';
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unrelated actor can read another delivery signature';
  END IF;

  -- An admin reads it but can neither replace nor delete it.
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows
  FROM storage.objects WHERE id = v_object_id;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: admin cannot read a recorded delivery signature';
  END IF;
  UPDATE storage.objects SET metadata = metadata WHERE id = v_object_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: admin can replace an old delivery signature';
  END IF;
  BEGIN
    DELETE FROM storage.objects WHERE id = v_object_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: admin can delete an old delivery signature';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- storage.protect_delete may refuse direct SQL deletes first; only our own failure matters.
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN
      RAISE;
    END IF;
  END;
  EXECUTE 'RESET ROLE';

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$$;
