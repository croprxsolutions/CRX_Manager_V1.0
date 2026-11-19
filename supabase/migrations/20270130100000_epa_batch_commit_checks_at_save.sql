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
--   locks commit_epa_proposal takes, in the same order, it re-makes every batch decision the screen made
--   (src/lib/epaBatchFill.ts, batchDecision and stillEligible) and refuses with EPA_BATCH_NOT_ELIGIBLE (nothing
--   written, the proposal stays open for a person) unless, at that moment:
--     - the product's only EPA number (its own, its sizes', its active brands' and its sizes' legacy brands',
--       normalized as _parent_chemistry_epa_refusal reads them) is the proposal's number;
--     - the product has no ingredient row (the batch only fills empty products);
--     - no other proposal for that product and number is proposed, held or rejected, no other lookup of it is
--       running (under 30 minutes old), none ever failed, and this lookup replaced no proposal recorded meanwhile;
--     - the registration was not edited since the lookup (its version is the proposal's);
--     - EPA's record is not flagged, a distributor's or cancelled, and its product name matches a current app name;
--     - every ingredient is a plain add with a CAS number and a percent, 100 at most in all;
--     - the label, re-sorted now, has only blanks, confirmations and matches (a fact edited since the lookup
--       sends it to a person), and EPA's restricted-use yes is already recorded here.
--   It refuses with EPA_BATCH_DECISION_INVALID when the decisions would not write exactly every ingredient add (a
--   label item left out takes its default, so each must be declined). Then it calls commit_epa_proposal unchanged,
--   in the same transaction. The product page keeps calling commit_epa_proposal directly; only the batch calls this.
--
-- LOCKS: the retry-key lock (_product_parent_replay, same scope and fingerprint as commit_epa_proposal, so a
--   retry of a finished save returns its receipt without re-checking), then the REG-1 exclusive lock, the
--   registration row FOR UPDATE and the product row FOR UPDATE: commit_epa_proposal's order. start_epa_lookup and
--   record_epa_lookup take the shared REG-1 lock and the product row, so a proposal being recorded is waited out
--   and then seen. Every other writer of the numbers read here also takes the product row first: upsert_parent_brand
--   (FOR SHARE), correct_product_parent_identity (_lock_product_parent, FOR UPDATE), and a new member or parent brand
--   (its foreign key lock); a size cannot carry a number of its own (guard_product_parent_values) and a grouped size's
--   legacy brands are refused (PRODUCT_BRANDS_BELONG_TO_PARENT). So a number change in flight is waited out and then
--   seen. A size's own name is not behind the product row, so its sizes are locked FOR SHARE next, in id order:
--   _lock_parent_chemistry's next lock, which commit_epa_proposal takes anyway. commit_epa_proposal re-takes the
--   same locks (already held; no new wait). READ COMMITTED only, so each check sees what committed while it waited.
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
     OR to_regprocedure('public._normalize_epa_registration(text)') IS NULL
     OR to_regprocedure('public._epa_proposal_items(uuid,text,jsonb)') IS NULL THEN
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
  v_why text;
  v_item jsonb;
  v_total numeric := 0;
  v_epa_words text[];
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  -- commit_epa_proposal's scope and fingerprint: a retry of a finished save replays its receipt unchecked.
  v_existing := public._product_parent_replay(p_idempotency_key, 'commit_epa_proposal',
    md5(jsonb_build_object('actor_id', v_actor, 'proposal_id', p_proposal_id,
      'expected_version', p_expected_proposal_version, 'decisions', p_decisions)::text));
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF jsonb_typeof(p_decisions) IS DISTINCT FROM 'array' OR jsonb_array_length(p_decisions) > 500 THEN
    RAISE EXCEPTION 'EPA_DECISION_INVALID: send the decisions as a list of {item_id, accept}';  -- commit_epa_proposal's check, before any lock
  END IF;
  -- The checks read after the locks, so each statement needs a fresh snapshot (as move_product_size).
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_READ_COMMITTED_REQUIRED: parents are written only in READ COMMITTED transactions'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_p FROM public.epa_chemistry_proposals WHERE id = p_proposal_id;
  IF FOUND THEN
    PERFORM public._epa_registration_lock(true);
    PERFORM 1 FROM public.epa_registrations WHERE epa_registration = v_p.epa_registration FOR UPDATE;
    PERFORM 1 FROM public.product_parents WHERE id = v_p.parent_id FOR UPDATE;
    -- _lock_parent_chemistry's next lock, taken now so a size renamed meanwhile is waited out for the name check.
    PERFORM 1 FROM public.products p
     WHERE p.id IN (SELECT m.product_id FROM public.product_parent_members m WHERE m.parent_id = v_p.parent_id)
     ORDER BY p.id FOR SHARE;
    SELECT * INTO v_p FROM public.epa_chemistry_proposals WHERE id = p_proposal_id;
  END IF;
  -- Not found, stale or already decided: commit_epa_proposal's own refusals, not "needs a person".
  IF v_p.id IS NULL OR v_p.status <> 'proposed' OR v_p.proposal_version IS DISTINCT FROM p_expected_proposal_version THEN
    RETURN public.commit_epa_proposal(p_proposal_id, p_expected_proposal_version, p_decisions, p_idempotency_key);
  END IF;

  -- 1. The product: still exactly this one EPA number, no ingredient row, nothing else open or failed for the number.
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
    v_why := format('its EPA numbers changed (now %s)', COALESCE(array_to_string(v_numbers, ', '), 'none'));
  ELSIF EXISTS (SELECT 1 FROM public.product_parent_ingredients i WHERE i.parent_id = v_p.parent_id) THEN
    v_why := 'ingredients were added meanwhile';
  ELSIF EXISTS (SELECT 1 FROM public.epa_chemistry_proposals o
                 WHERE o.parent_id = v_p.parent_id AND o.epa_registration = v_p.epa_registration AND o.id <> v_p.id
                   AND o.status IN ('proposed', 'held', 'rejected')) THEN
    v_why := 'another proposal is waiting or was rejected';
  ELSIF EXISTS (SELECT 1 FROM public.epa_chemistry_proposals o WHERE o.superseded_by_lookup_id = v_p.lookup_id) THEN
    -- This lookup replaced a proposal recorded after the screen's check (a person's): it waits for a person too.
    v_why := 'it replaced another proposal recorded meanwhile';
  ELSIF EXISTS (SELECT 1 FROM public.epa_lookups l
                 WHERE l.parent_id = v_p.parent_id AND l.epa_registration = v_p.epa_registration AND l.id <> v_p.lookup_id
                   AND l.status = 'pending' AND l.requested_at > now() - interval '30 minutes') THEN
    v_why := 'another lookup is running';
  ELSIF EXISTS (SELECT 1 FROM public.epa_lookup_failures f
                 WHERE f.parent_id = v_p.parent_id AND f.epa_registration = v_p.epa_registration) THEN
    v_why := 'a lookup of this number failed';
  ELSIF (SELECT r.registration_version FROM public.epa_registrations r WHERE r.epa_registration = v_p.epa_registration)
          IS DISTINCT FROM v_p.registration_version THEN
    -- Any edit to the registration since the lookup, even of a fact EPA did not send (step 5 also compares values).
    v_why := 'the EPA registration was edited since the lookup';
  -- 2. The EPA record (frozen on the proposal): not flagged, not a distributor's, not cancelled.
  ELSIF v_p.epa_summary->'needsManual' = 'true'::jsonb THEN
    v_why := 'EPA marks this record for manual checking';
  ELSIF v_p.epa_summary->'base_label_note' = 'true'::jsonb THEN
    v_why := 'distributor number: EPA has only the base label';
  ELSIF v_p.epa_summary->'isCancelled' = 'true'::jsonb THEN
    v_why := 'EPA lists the registration as cancelled';
  END IF;

  -- 3. A word of EPA's product name equals the first word of a current app name (catches a wrong number).
  IF v_why IS NULL THEN
    SELECT COALESCE(array_agg(x.w), '{}') INTO v_epa_words
      FROM (SELECT regexp_replace(t, '[^a-z0-9]', '', 'g') AS w
              FROM regexp_split_to_table(lower(COALESCE(v_p.epa_summary->>'productname', '')), '[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/-]+') t) x
     WHERE x.w <> '';
    IF NOT EXISTS (
      SELECT 1
        FROM (SELECT pp.name AS n FROM public.product_parents pp WHERE pp.id = v_p.parent_id
              UNION ALL
              SELECT p.product_name FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id
               WHERE m.parent_id = v_p.parent_id
              UNION ALL
              SELECT b.brand_name FROM public.product_parent_brands b WHERE b.parent_id = v_p.parent_id AND b.status = 'active'
              UNION ALL
              SELECT lb.brand_name FROM public.product_parent_members m JOIN public.product_brands lb ON lb.product_id = m.product_id
               WHERE m.parent_id = v_p.parent_id) names
       CROSS JOIN LATERAL (
         SELECT x.w FROM (SELECT regexp_replace(r.t, '[^a-z0-9]', '', 'g') AS w, r.o
                            FROM regexp_split_to_table(lower(COALESCE(names.n, '')), '[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/-]+') WITH ORDINALITY AS r(t, o)) x
          WHERE x.w <> '' ORDER BY x.o LIMIT 1) first_word
       WHERE first_word.w = ANY (v_epa_words)) THEN
      v_why := format('EPA name "%s" does not match this product', COALESCE(v_p.epa_summary->>'productname', ''));
    END IF;
  END IF;

  -- 4. Ingredients (frozen): at least one, each a plain add with a CAS number and a positive percent, 100 at most in all.
  IF v_why IS NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_p.items) e WHERE e->>'kind' = 'ingredient') THEN
    v_why := 'EPA lists no ingredients';
  END IF;
  IF v_why IS NULL THEN
    FOR v_item IN SELECT e FROM jsonb_array_elements(v_p.items) e WHERE e->>'kind' = 'ingredient' LOOP
      IF v_item->>'class' IS DISTINCT FROM 'add' OR jsonb_typeof(v_item->'change'->'cas') IS DISTINCT FROM 'string'
         OR v_item->'change'->>'cas' !~ '^[0-9]{2,7}-[0-9]{2}-[0-9]$' THEN
        v_why := format('ingredient needs a person (%s)', v_item->>'class');
      ELSIF jsonb_typeof(v_item->'change'->'strength_value') IS DISTINCT FROM 'number'
         OR (v_item->'change'->>'strength_value')::numeric <= 0
         OR v_item->'change'->>'strength_unit' IS DISTINCT FROM 'pct_ww'
         OR v_item->'change'->>'strength_basis' IS DISTINCT FROM 'active_ingredient' THEN
        v_why := 'ingredient has no percent';
      ELSE
        v_total := v_total + (v_item->'change'->>'strength_value')::numeric;
      END IF;
      EXIT WHEN v_why IS NOT NULL;
    END LOOP;
    IF v_why IS NULL AND v_total > 100 THEN v_why := 'ingredient percents add up to more than 100'; END IF;
  END IF;

  -- 5. The label as it stands now, re-sorted under the locks: only blanks, confirmations and matches, so a fact a
  --    person edited since the lookup sends the product to a person. The batch never writes a label fact (step 6).
  IF v_why IS NULL THEN
    FOR v_item IN SELECT e FROM jsonb_array_elements(public._epa_proposal_items(v_p.parent_id, v_p.epa_registration, v_p.epa_input)) e
                   WHERE e->>'kind' = 'label' LOOP
      IF (SELECT f->'current' FROM jsonb_array_elements(v_p.items) f WHERE f->>'item_id' = v_item->>'item_id')
           IS DISTINCT FROM v_item->'current' THEN
        v_why := format('label fact changed since the lookup (%s)', regexp_replace(v_item->>'item_id', '^label:', ''));
      ELSIF v_item->>'item_id' = 'label:registration_status' THEN
        -- Its class is always a difference (status is never written and is usually 'unknown'), so only cancelled,
        -- by EPA or as recorded here, needs a person.
        IF v_item->'epa' = 'true'::jsonb OR v_item->'current' = '"cancelled"'::jsonb THEN
          v_why := 'the registration is cancelled';
        END IF;
      ELSIF v_item->>'item_id' = 'label:label_document' AND v_item->>'class' = 'fill' THEN
        IF COALESCE(v_item->'current'->'label_accepted_on', 'null'::jsonb) <> 'null'::jsonb
           OR COALESCE(v_item->'current'->'label_url', 'null'::jsonb) <> 'null'::jsonb THEN
          v_why := 'EPA has a newer label than the one recorded';
        END IF;
      ELSIF v_item->>'item_id' = 'label:rup_status' AND v_item->'epa' = '"yes"'::jsonb AND v_item->>'class' <> 'confirm' THEN
        -- Restricted use by EPA and not yet yes here: recording it lists sales that need records, so a person decides.
        v_why := 'EPA lists it as restricted use';
      ELSIF v_item->>'class' NOT IN ('fill', 'confirm', 'matches') THEN
        v_why := CASE WHEN v_item->>'class' = 'rup_upgrade' THEN 'EPA lists it as restricted use'
                      ELSE format('label fact differs (%s)', regexp_replace(v_item->>'item_id', '^label:', '')) END;
      END IF;
      EXIT WHEN v_why IS NOT NULL;
    END LOOP;
  END IF;

  IF v_why IS NOT NULL THEN
    RAISE EXCEPTION 'EPA_BATCH_NOT_ELIGIBLE: %; nothing was saved', v_why;
  END IF;

  -- 6. The decisions: every ingredient add and nothing else is written. A label item left out takes its default, so each must be declined.
  IF EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_p.items) e
        WHERE e->>'class' IN ('add', 'add_name_only', 'fill', 'confirm', 'rup_upgrade')
          -- accepted exactly when it is an ingredient add: all of EPA's ingredients, nothing else
          AND (COALESCE((SELECT d->'accept' FROM jsonb_array_elements(p_decisions) d
                          WHERE d->>'item_id' = e->>'item_id' LIMIT 1), e->'accept_default') = 'true'::jsonb)
              IS DISTINCT FROM (e->>'kind' = 'ingredient' AND e->>'class' = 'add')) THEN
    RAISE EXCEPTION 'EPA_BATCH_DECISION_INVALID: the batch saves every ingredient and nothing else; accept each ingredient, decline every other item';
  END IF;
  -- commit_epa_proposal re-checks the decisions' shape and writes; same transaction, locks already held.
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
     OR has_function_privilege('metabase_ro', p.oid, 'EXECUTE')
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_proc
          WHERE oid = 'public.commit_epa_proposal(uuid,bigint,jsonb,text)'::regprocedure) <> '8e58775eae0d0a42b9ef08aea716fe75' THEN
    RAISE EXCEPTION 'EPA_BATCH_POSTFLIGHT: commit_epa_proposal_batch lost its owner, mode, search_path or grants, or commit_epa_proposal changed';
  END IF;
END
$postflight$;
