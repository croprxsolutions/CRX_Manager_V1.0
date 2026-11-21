-- ============================================================================
-- 20270204140000_quote_restore_keeps_planning_picks
-- Bookings Phase A follow-up (PR #1980): rewinding a booking keeps each section's Timing and
-- Confidence.
--
-- WHY: restore_quote_version (the rewind to an earlier sent version) deletes every section and
--   re-inserts them from the version snapshot. Versions never recorded timing or confidence
--   (added by 20270127110000), so a rewind blanked both on every section, and the purchasing plan
--   then counted committed ("firm") demand as "could add", silently dropping it from the buy plan.
-- WHAT: CREATE OR REPLACE of public._restore_quote_version_owner_impl only. Its body is the
--   20261027040000 body, byte for byte, plus PLANNING_PICKS_KEPT: before the section delete it
--   reads the current sections' timing and confidence keyed by sort_order and section_name, and
--   each restored section takes the picks of the current section with the same sort_order AND
--   section_name (none: unset; a tie: the highest id). Position alone is not enough: removing a
--   section renumbers the rest, which would move picks onto another section.
--   Planning picks are deliberately not version content (decided 2026-11-21): a rewind keeps the
--   current picks. The snapshot function (_create_quote_version_owner_impl) is unchanged.
-- NOT CHANGED: signature, owner, SECURITY DEFINER, search_path, EXECUTE grants (postgres and
--   service_role; the public wrapper restore_quote_version is untouched), the drawn-booking
--   refusal, money handling, idempotency handling. No rows change at apply.
--
-- idempotency-body-check: exempt -- no public RPC changes; the impl's p_idempotency_key handling is
--   byte for byte unchanged.
-- caller-analysis: _restore_quote_version_owner_impl :: same name, signature, defaults, result and
--   grants; its only caller restore_quote_version (QuoteBuilder rewind) is unchanged.
--
-- PROOF: npm run proof:quote-restore-keeps-planning-picks
--   (scripts/smoke/prove-quote-restore-keeps-planning-picks-real-schema.mjs).
-- ROLLBACK (as its own reviewed migration): re-run the 20261027040000_quote_sent_price_lock.sql
--   CREATE OR REPLACE of _restore_quote_version_owner_impl (body md5 f97868f93ca6a97e52b909dbbe6fdcd7). A rewind then
--   blanks timing and confidence again; no stored data is lost by the rollback itself.
-- ORDERING: strict. Apply after every older pending migration.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_fn record;
BEGIN
  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig, p.proowner, p.proacl INTO v_fn
    FROM pg_proc p WHERE p.oid = to_regprocedure('public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)');
  IF v_fn.oid IS NULL
     OR (SELECT count(*) FROM pg_proc o WHERE o.pronamespace = 'public'::regnamespace
          AND o.proname = '_restore_quote_version_owner_impl') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_RESTORE_MISSING: _restore_quote_version_owner_impl(uuid,uuid,uuid,text) is missing or has another overload';
  END IF;
  IF position('PLANNING_PICKS_KEPT' IN v_fn.prosrc) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_ALREADY_APPLIED: _restore_quote_version_owner_impl already keeps planning picks';
  END IF;
  IF position('v_item->>''quote_item_id''' IN v_fn.prosrc) = 0
     OR position('QUOTE_RESTORE_BLOCKED_BY_DRAW' IN v_fn.prosrc) = 0
     OR md5(replace(v_fn.prosrc, chr(13), '')) IS DISTINCT FROM 'f97868f93ca6a97e52b909dbbe6fdcd7' THEN
    RAISE EXCEPTION 'PREFLIGHT_RESTORE_DRIFT: _restore_quote_version_owner_impl is not the reviewed 20261027040000 body';
  END IF;
  IF NOT v_fn.prosecdef
     OR v_fn.proowner <> 'postgres'::regrole
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(v_fn.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['postgres', 'service_role'] THEN
    RAISE EXCEPTION 'PREFLIGHT_RESTORE_SECURITY_DRIFT: _restore_quote_version_owner_impl owner, mode, search_path or grants differ';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'quote_sections'
         AND column_name IN ('timing', 'confidence', 'sort_order')) <> 3 THEN
    RAISE EXCEPTION 'PREFLIGHT_COLUMNS_MISSING: quote_sections.timing, confidence or sort_order is missing (20270127110000 first)';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._restore_quote_version_owner_impl(p_quote_id uuid, p_version_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_snapshot jsonb;
  v_section jsonb;
  v_item jsonb;
  v_section_id uuid;
  v_version_number integer;
  v_actor uuid;
  v_drawn_guard record; -- drawn-version guard (20260611120100)
  v_planning_picks jsonb; -- PLANNING_PICKS_KEPT (20270204140000)
BEGIN
  -- Strict-actor auth (function previously had NO auth check). Before idempotency.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency check — operation-scoped so a key minted for a different operation
  -- can't short-circuit a legitimate restore (was: matched idempotency_key alone).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key
        AND operation = 'restore_quote_version';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
  END IF;

  -- Get snapshot data
  SELECT snapshot_data, version_number INTO v_snapshot, v_version_number
  FROM quote_versions
  WHERE id = p_version_id AND quote_id = p_quote_id;

  IF v_snapshot IS NULL THEN
    RAISE EXCEPTION 'Version not found: %', p_version_id;
  END IF;

  -- Preserve the newer live restore safeguard from
  -- 20260812011000_restore_quote_version_whole_cent_money. This pricing
  -- migration re-emits the same owner implementation to add quote-time cost
  -- snapshots, so it must reject non-finite constrained money before the first
  -- destructive restore write rather than silently replacing that live guard.
  IF (v_snapshot->'quote'->>'total_price')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quotes.total_price in version % is non-finite', p_version_id;
  END IF;
  IF (v_snapshot->'quote'->>'total_profit')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quotes.total_profit in version % is non-finite', p_version_id;
  END IF;
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_snapshot->'sections')
  LOOP
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      IF (v_item->>'profit')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quote_items.profit in version % is non-finite', p_version_id;
      END IF;
      IF (v_item->>'total_price')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quote_items.total_price in version % is non-finite', p_version_id;
      END IF;
    END LOOP;
  END LOOP;

  -- PROVENANCE: refuse the restore outright if this booking has been drawn.
  --
  -- order_items.quote_item_id records which booked quote line each drawn order
  -- line was billed from. This migration makes that FK NO ACTION DEFERRABLE
  -- INITIALLY DEFERRED so an ordinary save_quote edit -- which deletes and
  -- reinserts the SAME ids -- keeps the stamp. A version RESTORE is different:
  -- it rebuilds the quote from a snapshot and mints a brand-new id for every
  -- line (the INSERT below names no id column), so the old ids never come back
  -- and every stamp would dangle at COMMIT.
  --
  -- An earlier draft RELEASED the stamps here (UPDATE ... SET quote_item_id =
  -- NULL) instead of refusing. Codex review 2026-08-19 found that silently
  -- overbills, and it was REPRODUCED on PostgreSQL 17.6: two 0.5-unit lines at
  -- $1.01, draw 0.5, restore to a single 1-unit version, draw the rest -- the
  -- customer is billed $1.02 against a booking whose own arithmetic says
  -- $1.01. Releasing the stamp discards the telescoping rounding basis, and
  -- DRAW_MIXED_TIER_UNMATCHED_LINE cannot catch it because that guard only
  -- fires when the product carries MORE THAN ONE distinct (price, cost) -- and
  -- after the restore it carries exactly one. The release also fired
  -- after_order_items_change -> trg_recalc_order_totals, which locks the order
  -- row while this function already holds the quote row, crossing the lock
  -- order that cancel/void takes.
  --
  -- So restore fails CLOSED instead.
  --
  -- SCOPE, STATED ACCURATELY -- an earlier draft of this comment called the
  -- guard "narrow: only a booking actually drawn into an order is blocked".
  -- That was wrong, and Codex review 2026-08-19 caught it. The join below is
  -- UNFILTERED by order status, so the real rule is: once a booking has EVER
  -- been drawn, it can never restore a version again -- even if every draw
  -- order was afterwards cancelled or voided, the quantity returned to
  -- quote_product_draws and the booking reopened. Those reversed order_items
  -- rows are retained for audit and still carry their stamp, so the join stays
  -- true forever.
  --
  -- That over-breadth is DELIBERATE and Mason accepted it on 2026-08-20 rather
  -- than narrow it. Narrowing means letting a reversed line past the guard,
  -- and its stamp would then dangle at COMMIT exactly as before -- so restore
  -- would have to RELEASE the stamps on those dead lines. Releasing is
  -- money-neutral for them (a voided line is filtered out of billed_stamped and
  -- v_unmatched entirely, and a cancelled line contributes only its delivered
  -- quantity, which is zero here), but it puts back an UPDATE on order_items,
  -- which fires after_order_items_change -> trg_recalc_order_totals and locks
  -- the order row under the quote lock. That is the deadlock this rework just
  -- removed. Trading a rare capability for a reintroduced lock cycle is the
  -- wrong trade, so the limitation is recorded instead of fixed.
  --
  -- Recorded in docs/manual/KNOWN_ISSUES.md and pinned by a regression case in
  -- scripts/smoke/smoke-restore-version-drawn-guard.sql, so a later narrowing
  -- has to change the recorded decision consciously rather than by accident.
  --
  -- What is unaffected: a booking never drawn restores freely, and editing the
  -- quote directly still works on ANY booking, because save_quote reuses the
  -- same line ids and the deferred FK keeps the stamps.
  --
  -- Doing this properly -- carrying the line-level billing basis across a
  -- restore so the money stays exact -- means giving restore a real identity
  -- mapping from snapshot lines to live lines. That is the same missing
  -- capability QUOTE_ITEM_AMBIGUOUS_COST is about, and it gets its own PR.
  IF EXISTS (
    SELECT 1
    FROM order_items oi
    JOIN quote_items qi ON qi.id = oi.quote_item_id
    WHERE qi.quote_id = p_quote_id
  ) THEN
    RAISE EXCEPTION 'QUOTE_RESTORE_BLOCKED_BY_DRAW: this booking has already been drawn down into an order, so restoring an earlier version would change what the customer has already been billed. Edit the quote directly instead -- ordinary edits are still allowed and keep the billing history intact.'
      USING ERRCODE = 'P0001';
  END IF;

  -- PLANNING_PICKS_KEPT (20270204140000): timing and confidence are planning picks, not version
  -- content (a version never records them). Keep each current section's picks for the restored
  -- section with the same sort_order AND section_name (a removal renumbers sections, so position
  -- alone could move picks onto another section); no such current section: restored unset.
  -- Neither is unique: on a tie the section with the highest id wins (deterministic).
  SELECT COALESCE(jsonb_object_agg(qs.sort_order::text || chr(31) || COALESCE(qs.section_name, chr(30)),
           jsonb_build_object('timing', qs.timing, 'confidence', qs.confidence) ORDER BY qs.id), '{}'::jsonb)
    INTO v_planning_picks
    FROM quote_sections qs
   WHERE qs.quote_id = p_quote_id;

  -- Delete existing sections (cascades to items via ON DELETE CASCADE)
  DELETE FROM quote_sections WHERE quote_id = p_quote_id;

  -- Restore quote-level fields. Bracket the status write with the admin override so
  -- the enforcer permits restore->revised from any source state (accepted/declined/etc.).
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET
    header_notes = v_snapshot->'quote'->>'header_notes',
    footer_notes = v_snapshot->'quote'->>'footer_notes',
    -- Historical snapshots may predate the live whole-cent constraints from
    -- 20260810151000. Normalize the replay boundary so restoring one cannot
    -- fail or reintroduce fractional stored money.
    total_price = ROUND((v_snapshot->'quote'->>'total_price')::numeric, 2),
    total_cost = ROUND((v_snapshot->'quote'->>'total_cost')::numeric, 2),
    total_profit = ROUND((v_snapshot->'quote'->>'total_profit')::numeric, 2),
    total_margin_pct = (v_snapshot->'quote'->>'total_margin_pct')::numeric,
    -- PRICE LOCK (20261027040000): a rewind also puts back the version's customer (when that
    -- customer still exists) and tier, so a rewound quote matches the version as sent.
    customer_id = COALESCE(
      (SELECT c.id FROM customers c WHERE c.id = NULLIF(v_snapshot->'quote'->>'customer_id', '')::uuid),
      customer_id),
    tier = COALESCE(NULLIF(v_snapshot->'quote'->>'tier', '')::integer, tier),
    status = 'revised',
    updated_at = now()
  WHERE id = p_quote_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- SNAPSHOT<<< arm the trusted passthrough for this transaction so the rows
  -- reinserted below carry the version's own quote-time cost. Same mechanism
  -- save_quote uses: transaction-local, so a PostgREST caller cannot set it.
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '1', true);
  -- >>>SNAPSHOT

  -- Restore sections and items from snapshot
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_snapshot->'sections')
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes, needed_by_date, field_id,
                                timing, confidence)
    VALUES (
      p_quote_id,
      v_section->>'section_name',
      (v_section->>'sort_order')::integer,
      v_section->>'section_notes',
      v_section->>'section_header_notes',
      (v_section->>'needed_by_date')::date,
      -- PRICE LOCK (20261027040000): a rewind keeps the section's field when the version
      -- recorded it and the field still exists for the quote's (restored) customer.
      (SELECT f.id FROM fields f
        WHERE f.id = NULLIF(v_section->>'field_id', '')::uuid
          AND f.customer_id = (SELECT q.customer_id FROM quotes q WHERE q.id = p_quote_id)),
      -- PLANNING_PICKS_KEPT (20270204140000): the current picks at this position and name, else unset.
      v_planning_picks->((v_section->>'sort_order')::integer::text || chr(31)
        || COALESCE(v_section->>'section_name', chr(30)))->>'timing',
      v_planning_picks->((v_section->>'sort_order')::integer::text || chr(31)
        || COALESCE(v_section->>'section_name', chr(30)))->>'confidence'
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      IF NULLIF(v_item->>'current_cost', '') IS NULL
         OR (v_item->>'current_cost')::numeric <= 0 THEN
        RAISE EXCEPTION 'COST_BASIS_REQUIRED:%', v_item->>'product_id';
      END IF;
      -- PRICE LOCK (20261027040000): a version that recorded its line ids restores each line
      -- under its own id with its own manual price, so the rewound quote still matches the
      -- version as sent. An id already in use (impossible after the delete above) gets a new one.
      INSERT INTO quote_items (
        id, price_override,
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
        oz_per_acre, price_per_acre, acres, total_units_needed, unit_size,
        profit, total_price, net_margin, calc_mode, price_unit,
        cost_at_quote_cents -- SNAPSHOT
      )
      VALUES (
        CASE WHEN NULLIF(v_item->>'quote_item_id', '') IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM quote_items WHERE id = (v_item->>'quote_item_id')::uuid)
          THEN (v_item->>'quote_item_id')::uuid
          ELSE gen_random_uuid() END,
        (v_item->>'price_override')::numeric,
        p_quote_id, v_section_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'sort_order')::integer,
        v_item->>'notes',
        (v_item->>'price_per_unit')::numeric,
        (v_item->>'current_cost')::numeric,
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        ROUND((v_item->>'profit')::numeric, 2),
        ROUND((v_item->>'total_price')::numeric, 2),
        (v_item->>'net_margin')::numeric,
        v_item->>'calc_mode',
        v_item->>'price_unit',
        -- SNAPSHOT: the version stored the cost this quote was priced with.
        -- Without it the BEFORE INSERT trigger stamps todays catalog cost, and
        -- the next ordinary save preserves that stamp and recomputes the line
        -- from it, silently repricing the restored version.
        --
        -- A version without a positive historical basis is rejected above.
        -- Unknown money must not become a real zero-cost quote line.
        ROUND((v_item->>'current_cost')::numeric * 100)::bigint
      );
    END LOOP;
  END LOOP;

  -- SNAPSHOT<<< disarm immediately once the reinsert loop closes.
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '0', true);
  -- >>>SNAPSHOT

  -- BEGIN drawn-version guard (20260611120100)
  -- Codex round-2 MED (2026-06-11): a restore must never under-book the drawn
  -- ledger (quote_product_draws deliberately survives the section delete +
  -- re-insert above). Validates the FINAL persisted quote_items — the same
  -- invariant, token, and block shape as save_quote's drawn-product guard
  -- (20260610184230). A violation rolls back the entire restore atomically,
  -- including the section DELETE.
  -- LAYER2<<< drawn guard counts ORDER + JOB draws (§6.5 / Codex round-2 P1).
  SELECT
    COALESCE(p.product_name, d.product_id::text) AS product_name,
    d.quantity_drawn,
    COALESCE(b.booked, 0) AS new_booked
  INTO v_drawn_guard
  FROM (
    SELECT product_id, SUM(qty) AS quantity_drawn
    FROM (
      SELECT product_id, quantity_drawn AS qty FROM quote_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0
      UNION ALL
      SELECT product_id, quantity_drawn AS qty FROM job_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0
    ) x
    GROUP BY product_id
  ) d
  LEFT JOIN (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items
    WHERE quote_id = p_quote_id
    GROUP BY product_id
  ) b ON b.product_id = d.product_id
  LEFT JOIN products p ON p.id = d.product_id
  WHERE d.quantity_drawn > 0
    AND COALESCE(b.booked, 0) < d.quantity_drawn
  ORDER BY d.quantity_drawn - COALESCE(b.booked, 0) DESC, d.product_id
  LIMIT 1;
  -- >>>LAYER2
  IF FOUND THEN
    IF v_drawn_guard.new_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot restore this version — it removes %, which already has % drawn',
        v_drawn_guard.product_name, v_drawn_guard.quantity_drawn;
    END IF;
    RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot restore this version — % would fall below its already-drawn % (restored total would be %)',
      v_drawn_guard.product_name, v_drawn_guard.quantity_drawn, v_drawn_guard.new_booked;
  END IF;
  -- END drawn-version guard (20260611120100)

  -- BEGIN planned-hold + job-reservation sync (20260611132115 + Layer2 A3.12)
  -- Codex round-2 #3: restores rewrite quote_items wholesale — rebuild the
  -- planned reservation (booked − drawn) to match the restored state.
  -- LAYER2-CHAN (push-gate #C): a restore that changes booked quantity must ALSO
  -- re-sync the quote's ACTIVE jobs (draws + shed holds), exactly as save_quote now
  -- does — else a restored-larger booking leaves stale job draws and reopens balance
  -- the job still needs. _sync_quote_job_reservations rebuilds the jobs THEN calls
  -- _sync_planned_holds itself (strict superset). Was: PERFORM _sync_planned_holds(...).
  PERFORM _sync_quote_job_reservations(p_quote_id, v_actor);
  -- END planned-hold + job-reservation sync

  -- Save idempotency key (result stored as a valid jsonb object — was a bare ::text UUID).
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'restore_quote_version', jsonb_build_object('quote_id', p_quote_id))
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'status', 'restored',
    'restored_from_version', v_version_number,
    'quote_id', p_quote_id
  );
END;
$function$;

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig, p.proowner, p.proacl INTO v_fn
    FROM pg_proc p WHERE p.oid = to_regprocedure('public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)');
  IF v_fn.oid IS NULL
     OR (SELECT count(*) FROM pg_proc o WHERE o.pronamespace = 'public'::regnamespace
          AND o.proname = '_restore_quote_version_owner_impl') <> 1
     OR NOT v_fn.prosecdef
     OR v_fn.proowner <> 'postgres'::regrole
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(v_fn.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['postgres', 'service_role']
     OR has_function_privilege('anon', v_fn.oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_RESTORE_SECURITY_DRIFT: _restore_quote_version_owner_impl lost its owner, mode, search_path or grants';
  END IF;
  IF position('PLANNING_PICKS_KEPT' IN v_fn.prosrc) = 0
     OR position('v_item->>''quote_item_id''' IN v_fn.prosrc) = 0
     OR position('QUOTE_RESTORE_BLOCKED_BY_DRAW' IN v_fn.prosrc) = 0
     OR md5(replace(v_fn.prosrc, chr(13), '')) IS DISTINCT FROM 'aaa8e3297d94899f2bc4d6279a57c644' THEN
    RAISE EXCEPTION 'POSTFLIGHT_RESTORE_BODY: _restore_quote_version_owner_impl is not the reviewed body of this file';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK rewind keeps planning picks';
END;
$postflight$;
