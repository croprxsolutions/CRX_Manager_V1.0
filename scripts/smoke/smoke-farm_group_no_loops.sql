-- Smoke chain: farm groups cannot loop, and include grandchildren (REQUIRES 20270127200000, KI-146).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so the three invented customers it writes are rolled back.
--   * an admin (role authenticated with a live admin's claims) builds A > B > C through save_customer;
--   * putting A under C (its grandchild) through save_customer is refused, and A keeps no parent;
--   * get_customer_farm_group from C returns A, B and C, with only A marked parent.
-- Before 20270127200000 the refusal does not happen and C is missing from the group read from A.
-- Every other case is proven on invented rows by scripts/smoke/prove-farm-group-no-loops-real-schema.mjs.
DO $$
DECLARE
  v_admin uuid;
  v_tag text := substr(md5(clock_timestamp()::text), 1, 10);
  v_a uuid;
  v_b uuid;
  v_c uuid;
  v_msg text;
  v_group text;
BEGIN
  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' AND p.is_active ORDER BY p.created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: need an active admin';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_a := (public.save_customer(NULL, jsonb_build_object('farm_name', '[SMOKE] FG A ' || v_tag, 'assigned_sales_rep', v_admin),
            '[]'::jsonb, v_admin, 'smoke-fg-a-' || v_tag)->>'customer_id')::uuid;
  v_b := (public.save_customer(NULL, jsonb_build_object('farm_name', '[SMOKE] FG B ' || v_tag, 'assigned_sales_rep', v_admin, 'parent_customer_id', v_a),
            '[]'::jsonb, v_admin, 'smoke-fg-b-' || v_tag)->>'customer_id')::uuid;
  v_c := (public.save_customer(NULL, jsonb_build_object('farm_name', '[SMOKE] FG C ' || v_tag, 'assigned_sales_rep', v_admin, 'parent_customer_id', v_b),
            '[]'::jsonb, v_admin, 'smoke-fg-c-' || v_tag)->>'customer_id')::uuid;

  BEGIN
    PERFORM public.save_customer(v_a, jsonb_build_object('farm_name', '[SMOKE] FG A ' || v_tag, 'parent_customer_id', v_c,
      'row_version_expected', (SELECT row_version FROM public.customers WHERE id = v_a)), '[]'::jsonb, v_admin, 'smoke-fg-loop-' || v_tag);
    v_msg := 'NOT REFUSED';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
  END;
  IF v_msg NOT LIKE 'Nothing was saved. The chosen parent customer is already below this customer in its farm group%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: putting a customer under its grandchild was not refused: %', v_msg;
  END IF;
  IF (SELECT parent_customer_id FROM public.customers WHERE id = v_a) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the refused save left a parent on A';
  END IF;

  SELECT string_agg(CASE g.id WHEN v_a THEN 'A' WHEN v_b THEN 'B' WHEN v_c THEN 'C' ELSE '?' END
           || CASE WHEN g.is_parent THEN '*' ELSE '' END, ',' ORDER BY g.farm_name)
    INTO v_group FROM public.get_customer_farm_group(v_c) g;
  EXECUTE 'RESET ROLE';
  IF v_group IS DISTINCT FROM 'A*,B,C' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the farm group read from C is % (expected A*,B,C)', v_group;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: farm group no-loops chain passed';
END;
$$;
