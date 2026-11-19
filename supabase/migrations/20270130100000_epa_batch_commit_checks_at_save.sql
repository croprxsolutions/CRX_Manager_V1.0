-- idempotency-body-check: exempt
-- (commit_epa_proposal_batch requires p_idempotency_key and checks it before any write with PAR-1's
--  _product_parent_replay(key, scope, fingerprint), which calls check_idempotency; the receipt is saved by
--  commit_epa_proposal itself, in the same transaction. The hook only recognises check_idempotency.)
-- Written 2026-11-19. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270130100000_epa_batch_commit_checks_at_save.md.
--
-- WHY (issue #1976, follow-up from PR #1975): the EPA batch fill re-checks in the browser, just before it saves,
--   that a product still has exactly one EPA number and no other proposal. That check is not atomic with the
--   save, so two admins batching the same products at once (or a person's lookup recorded meanwhile) could race.
--
-- WHAT: a new admin RPC, commit_epa_proposal_batch, with commit_epa_proposal's exact arguments. Under the same
--   locks commit_epa_proposal takes, in the same order, it refuses with EPA_BATCH_NOT_ELIGIBLE (nothing written,
--   the proposal stays open for a person) unless, at that moment:
--     - the product's only EPA number (its own, its sizes', its active brands' and its sizes' legacy brands',
--       normalized as _parent_chemistry_epa_refusal reads them) is the proposal's number;
--     - no other proposal for that product and number is proposed, held or rejected;
--     - the product has no ingredient row (the batch only fills empty products).
--   Then it calls commit_epa_proposal unchanged, in the same transaction. The product page keeps calling
--   commit_epa_proposal directly; only the batch calls the new RPC.
--
-- LOCKS: the retry-key lock (_product_parent_replay, same scope and fingerprint as commit_epa_proposal, so a
--   retry of a finished save returns its receipt without re-checking), then the REG-1 exclusive lock, the
--   registration row FOR UPDATE and the product row FOR UPDATE: commit_epa_proposal's order. start_epa_lookup and
--   record_epa_lookup take the shared REG-1 lock and the product row, so a proposal being recorded is waited out
--   and then seen. Every other writer of the numbers read here also takes the product row first: upsert_parent_brand
--   (FOR SHARE), correct_product_parent_identity (_lock_product_parent, FOR UPDATE), and a new member or parent brand
--   (its foreign key lock); a size cannot carry a number of its own (guard_product_parent_values) and a grouped size's
--   legacy brands are refused (PRODUCT_BRANDS_BELONG_TO_PARENT). So a number change in flight is waited out and then
--   seen, with no extra row locks. commit_epa_proposal re-takes the same locks (already held; no new wait).
--
-- NOT CHANGED: commit_epa_proposal and every other function, table, row, grant and policy.
--
-- ROLLBACK (its own reviewed migration): DROP FUNCTION public.commit_epa_proposal_batch(uuid, bigint, jsonb, text);
--   the batch screen then fails its saves with a clear error until the screen is rolled back too. Nothing deleted.
--
-- ORDERING: after every older migration. Not re-runnable (preflight refuses).

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.commit_epa_proposal_batch(uuid,bigint,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'EPA_BATCH_PREFLIGHT: commit_epa_proposal_batch already exists';
  END IF;
  IF to_regprocedure('public.commit_epa_proposal(uuid,bigint,jsonb,text)') IS NULL
     OR to_regprocedure('public._product_parent_replay(text,text,text)') IS NULL
     OR to_regprocedure('public._product_parent_require_admin()') IS NULL
     OR to_regprocedure('public._epa_registration_lock(boolean)') IS NULL
     OR to_regprocedure('public._normalize_epa_registration(text)') IS NULL THEN
    RAISE EXCEPTION 'EPA_BATCH_PREFLIGHT: a function this file calls is missing';
  END IF;
  -- commit_epa_proposal's body as read for this file (md5 of prosrc without carriage returns, pinned 2026-11-15).
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_proc
       WHERE oid = 'public.commit_epa_proposal(uuid,bigint,jsonb,text)'::regprocedure) <> '8e58775eae0d0a42b9ef08aea716fe75' THEN
    RAISE EXCEPTION 'EPA_BATCH_PREFLIGHT: commit_epa_proposal changed; re-read its fingerprint and lock order';
  END IF;
END
$preflight$;

CREATE FUNCTION public.commit_epa_proposal_batch(p_proposal_id uuid, p_expected_proposal_version bigint,
  p_decisions jsonb, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_existing jsonb;
  v_p public.epa_chemistry_proposals;
  v_numbers text[];
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  -- commit_epa_proposal's scope and fingerprint: a retry of a finished save replays its receipt unchecked.
  v_existing := public._product_parent_replay(p_idempotency_key, 'commit_epa_proposal',
    md5(jsonb_build_object('actor_id', v_actor, 'proposal_id', p_proposal_id,
      'expected_version', p_expected_proposal_version, 'decisions', p_decisions)::text));
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  SELECT * INTO v_p FROM public.epa_chemistry_proposals WHERE id = p_proposal_id;
  IF FOUND THEN
    PERFORM public._epa_registration_lock(true);
    PERFORM 1 FROM public.epa_registrations WHERE epa_registration = v_p.epa_registration FOR UPDATE;
    PERFORM 1 FROM public.product_parents WHERE id = v_p.parent_id FOR UPDATE;
    SELECT array_agg(DISTINCT s.n ORDER BY s.n) INTO v_numbers
      FROM (
        SELECT public._normalize_epa_registration(pp.generic_epa_registration) AS n
          FROM public.product_parents pp WHERE pp.id = v_p.parent_id
        UNION ALL
        SELECT public._normalize_epa_registration(p.epa_registration)
          FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
         WHERE m.parent_id = v_p.parent_id
        UNION ALL
        SELECT public._normalize_epa_registration(b.epa_registration)
          FROM public.product_parent_brands b WHERE b.parent_id = v_p.parent_id AND b.status = 'active'
        UNION ALL
        SELECT public._normalize_epa_registration(lb.epa_registration)
          FROM public.product_parent_members m JOIN public.product_brands lb ON lb.product_id = m.product_id
         WHERE m.parent_id = v_p.parent_id
      ) s
     WHERE s.n IS NOT NULL;
    IF v_numbers IS DISTINCT FROM ARRAY[v_p.epa_registration] THEN
      RAISE EXCEPTION 'EPA_BATCH_NOT_ELIGIBLE: its EPA numbers changed (now %); nothing was saved',
        COALESCE(array_to_string(v_numbers, ', '), 'none');
    END IF;
    IF EXISTS (SELECT 1 FROM public.epa_chemistry_proposals o
                WHERE o.parent_id = v_p.parent_id AND o.epa_registration = v_p.epa_registration AND o.id <> v_p.id
                  AND o.status IN ('proposed', 'held', 'rejected')) THEN
      RAISE EXCEPTION 'EPA_BATCH_NOT_ELIGIBLE: another proposal is waiting or was rejected; nothing was saved';
    END IF;
    IF EXISTS (SELECT 1 FROM public.product_parent_ingredients i WHERE i.parent_id = v_p.parent_id) THEN
      RAISE EXCEPTION 'EPA_BATCH_NOT_ELIGIBLE: ingredients were added meanwhile; nothing was saved';
    END IF;
  END IF;
  -- Not found, stale, not open, the admin check and the receipt: all commit_epa_proposal's own.
  RETURN public.commit_epa_proposal(p_proposal_id, p_expected_proposal_version, p_decisions, p_idempotency_key);
END;
$function$;

ALTER FUNCTION public.commit_epa_proposal_batch(uuid, bigint, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.commit_epa_proposal_batch(uuid, bigint, jsonb, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.commit_epa_proposal_batch(uuid, bigint, jsonb, text) TO authenticated;

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.commit_epa_proposal_batch(uuid,bigint,jsonb,text)');
  IF p.oid IS NULL
     OR position('EPA_BATCH_NOT_ELIGIBLE' IN p.prosrc) = 0
     OR p.proowner <> 'postgres'::regrole OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     OR has_function_privilege('anon', p.oid, 'EXECUTE')
     OR has_function_privilege('service_role', p.oid, 'EXECUTE')
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_proc
          WHERE oid = 'public.commit_epa_proposal(uuid,bigint,jsonb,text)'::regprocedure) <> '8e58775eae0d0a42b9ef08aea716fe75' THEN
    RAISE EXCEPTION 'EPA_BATCH_POSTFLIGHT: commit_epa_proposal_batch lost its owner, mode, search_path or grants, or commit_epa_proposal changed';
  END IF;
END
$postflight$;
