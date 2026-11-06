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
  v_canonical text;
  v_bad_name text;
  v_bad_id uuid;
  v_reader uuid;
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

  -- Permissive rules are OR-ed: none may reach beyond its own single bucket.
  IF EXISTS (SELECT 1
               FROM pg_policies
              WHERE schemaname = 'storage' AND tablename = 'objects' AND permissive = 'PERMISSIVE'
                AND ((cmd <> 'INSERT' AND qual IS NULL)
                     OR (cmd = 'INSERT' AND with_check IS NULL)
                     OR qual !~ '^(\(bucket_id = ''[a-z0-9_-]+''::text\)|\(\(bucket_id = ''[a-z0-9_-]+''::text\) AND .*\))$'
                     OR with_check !~ '^(\(bucket_id = ''[a-z0-9_-]+''::text\)|\(\(bucket_id = ''[a-z0-9_-]+''::text\) AND .*\))$')) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a permissive storage.objects policy is not limited to one bucket';
  END IF;

  -- A completed delivery whose recorded signature is its old fixed-path file. Live history has no such
  -- delivery assigned to an active driver, so one is borrowed below (rolled back with everything else).
  SELECT d.id, o.id
  INTO v_delivery_id, v_object_id
  FROM public.deliveries d
  JOIN storage.objects o
    ON o.bucket_id = 'delivery-signatures'
   AND o.name = 'signatures/' || d.id::text || '.png'
   AND d.signature_url = o.name
  WHERE d.status = 'completed'
  ORDER BY d.id
  LIMIT 1;

  SELECT p.id
  INTO v_driver_id
  FROM public.profiles p
  WHERE p.role = 'driver' AND p.is_active
  ORDER BY p.id
  LIMIT 1;

  -- Any old fixed-path name must be refused; a fresh id never collides with a real file.
  v_insert_delivery_id := gen_random_uuid();

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

  IF v_object_id IS NULL OR v_driver_id IS NULL OR
     v_stranger_id IS NULL OR v_admin_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: assigned-driver signature fixture is unavailable';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  UPDATE public.deliveries SET assigned_driver = v_driver_id WHERE id = v_delivery_id;

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

  -- Malformed names: only the exact signatures/<delivery id>.png file is readable through the old-path
  -- rule, and only the exact per-attempt shape through the per-attempt rule. Each file is seeded here
  -- (rolled back) and, worst case, recorded as the delivery's signature; the driver, a stranger and an
  -- admin all read nothing. The completion-evidence marker lets this rolled-back test set signature_url.
  v_canonical := 'signatures/' || v_delivery_id::text || '.png';
  FOREACH v_bad_name IN ARRAY ARRAY[
      v_canonical || '/../x',
      'signatures//' || v_delivery_id::text || '.png',
      '/' || v_canonical,
      'signatures/' || upper(v_delivery_id::text) || '.png',
      v_canonical || '.png',
      'signatures/' || v_delivery_id::text || '.PNG',
      v_canonical || chr(10),
      'signatures/not-a-uuid.png',
      'signatures/' || v_delivery_id::text || '/' || repeat('A', 32) || '.png',
      'signatures/' || v_delivery_id::text || '/' || md5('x') || '.png/../x'] LOOP
    INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
    VALUES ('delivery-signatures', v_bad_name, v_driver_id::text, '{"mimetype":"image/png","size":2400}'::jsonb)
    RETURNING id INTO v_bad_id;
    PERFORM set_config('crx.delivery_completion_evidence', v_delivery_id::text, true);
    UPDATE public.deliveries SET signature_url = v_bad_name WHERE id = v_delivery_id;
    PERFORM set_config('crx.delivery_completion_evidence', '', true);
    FOREACH v_reader IN ARRAY ARRAY[v_driver_id, v_stranger_id, v_admin_id] LOOP
      PERFORM set_config('request.jwt.claim.sub', v_reader::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_rows FROM storage.objects WHERE id = v_bad_id;
      EXECUTE 'RESET ROLE';
      IF v_rows <> 0 THEN
        RAISE EXCEPTION 'SMOKE_FAIL: user % can read malformed signature name %', v_reader, quote_literal(v_bad_name);
      END IF;
    END LOOP;
  END LOOP;
  PERFORM set_config('crx.delivery_completion_evidence', v_delivery_id::text, true);
  UPDATE public.deliveries SET signature_url = v_canonical WHERE id = v_delivery_id;
  PERFORM set_config('crx.delivery_completion_evidence', '', true);

  -- The canonical recorded file is still readable by its driver.
  PERFORM set_config('request.jwt.claim.sub', v_driver_id::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM storage.objects WHERE id = v_object_id;
  EXECUTE 'RESET ROLE';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: assigned driver lost the canonical signature after the malformed-name checks';
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
