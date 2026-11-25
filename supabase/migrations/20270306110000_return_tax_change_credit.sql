-- Written 2026-11-25. STATUS: NOT APPLIED (staging candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270306110000_return_tax_change_credit.md.
-- Re-read the live ledger before applying.
--
-- WHY: two release #1990 follow-ups (fix before the next release; Mason 20 Nov, Taha agreed):
--   #2066: a return made at the order price (no tax or discount line on the sale's live invoices yet) switches to
--     billed-share pricing once a live invoice of the sale gains a sales-tax (or discount) line, so receiving or
--     crediting it refused with RETURN_SPLIT_SHARE_REPRICED. Mason, 22 Nov: re-price to the taxed share; the credit is
--     never more than the customer was charged on the posted invoice, tax included.
--   #2091: the return-credit tax ledger (credit_memo_sales_tax) pooled only source invoices stamped at or before the
--     credit's posting time (its transaction start), but the credit is priced from every invoice posted when it runs,
--     so a source invoice that posted in between could be refunded tax the ledger recorded as zero.
--
-- WHAT:
--   1. receive_return and issue_return_credit (their private bodies _receive_return_intent_impl_20260812 and
--      _issue_return_credit_intent_impl_20260812): under the per-order-line locks they already take, a share-mode line
--      whose stored price is no longer what create_return would price it at now is re-priced to that (the returner's
--      billed share, tax and discount included, from posted invoices only), with one financial_audit_log row,
--      instead of refusing. The existing share caps still refuse a line beyond the billed share, so a return's credits
--      never add up to more than was billed. issue_return_credit re-prices before its cap check. Unchanged (Mason's
--      #1010 rule, cancel and recreate): a line made stale by an earlier return of it cancelled, rejected or deleted
--      after this one was made is still refused (RETURN_SPLIT_SHARE_REPRICED).
--   2. _freeze_credit_sales_tax_20270109: the pool is every lot posted when the credit freezes (at its commit), not
--      only lots stamped at or before the credit's posting time. The credit holds the order lines' locks (361), which
--      posting or unposting a sale of the line also takes, so that is exactly the set the credit was priced from.
--
-- NOT CHANGED: create_return, _return_customer_line_share, the credit implementation _issue_return_credit_impl,
--   the public wrappers, every trigger, every stored row. Each re-emitted body is staging's current body (pinned below)
--   plus only the hunks marked (#2066) or (#2091). CREATE OR REPLACE keeps each OID, owner and exact ACL; the postflight
--   proves it.
--
-- ROLLBACK (its own reviewed migration): re-emit the three bodies pinned in the preflight (20261021155000 for the two
--   return bodies, 20270117120000 for the freeze). Credits issued meanwhile keep their amounts and frozen tax.
--
-- ORDERING: after 20270117120000_billing_sol_fixes_staging (the freeze) and 20261021155000 (the return bodies).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE return_tax_change_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('pg_temp.return_tax_change_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.return_tax_change_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'RETURN_TAX_CHANGE_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE oid = to_regprocedure('public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)')
                AND position('(#2066)' in prosrc) > 0) THEN
    RAISE EXCEPTION 'RETURN_TAX_CHANGE_PREFLIGHT: already applied';
  END IF;
  -- The three functions re-emitted below, exactly as staging has them.
  SELECT string_agg(f.name, ', ') INTO v_bad
    FROM (VALUES
      ('public._receive_return_intent_impl_20260812(uuid,uuid,text)', '67566a09967e74b1ee813354038955b0', 1),
      ('public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)', '0d5209ab7179f36d71f548b55a6cf77d', 1),
      ('public._freeze_credit_sales_tax_20270109(uuid)', '6b175becb29ac202c5b1983ddc6686a5', 0)
    ) AS f(name, md5, ndef)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.name)
        AND md5(replace(p.prosrc, chr(13), '')) = f.md5
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef
        AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
        AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]
        AND p.pronargdefaults = f.ndef);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_TAX_CHANGE_PREFLIGHT: drifted from staging: %', v_bad;
  END IF;
END
$preflight$;

-- 1. (#2066) receive_return: re-price a stale share line instead of refusing ----------------------------------------
CREATE OR REPLACE FUNCTION public._receive_return_intent_impl_20260812(p_return_id uuid, p_received_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_order_id uuid;
  v_customer_id uuid;
  v_order_customer_id uuid;
  v_order_status text;
  v_is_legacy_unlinked boolean := false;
  -- Phase 3 addition: this wrapper takes the sorted multi-product lock set.
  v_product_ids uuid[];
  -- Split-payer return (20261021155000): see the per-line locks below.
  v_lock_order_item_id uuid;
  -- (#2066) the lines re-priced below
  v_repriced jsonb;
  v_repriced_delta bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_received_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'receive_return');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT r.order_id, r.customer_id INTO v_order_id, v_customer_id
  FROM public.returns r
  WHERE r.id = p_return_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found: %', p_return_id; END IF;

  IF v_order_id IS NOT NULL THEN
    SELECT o.status, o.customer_id INTO v_order_status, v_order_customer_id
    FROM public.orders o
    WHERE o.id = v_order_id AND o.deleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND OR v_order_status IN ('voided', 'cancelled') THEN
      RAISE EXCEPTION 'RETURN_SOURCE_ORDER_INACTIVE';
    END IF;
    -- Split-payer return (20261021155000): or a customer a posted governed split invoice of this
    -- order bills.
    IF v_order_customer_id IS DISTINCT FROM v_customer_id
       AND NOT public._return_customer_is_split_payer(v_order_id, v_customer_id) THEN
      RAISE EXCEPTION 'RETURN_ORDER_CUSTOMER_MISMATCH';
    END IF;

    -- Split-payer return (20261021155000): on a split return, hold the per-order-line locks the
    -- credit takes before checking the share, so a source invoice cannot be voided or edited (that
    -- path try-takes them and fails fast) between this check and the restock; a change committed
    -- first is seen by the check below.
    IF v_order_customer_id IS DISTINCT FROM v_customer_id OR EXISTS (
      SELECT 1
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_customer_line_share(
          v_order_id, ri.order_item_id, v_customer_id, p_return_id
        ) s
       WHERE ri.return_id = p_return_id AND s.share_mode
    ) THEN
      FOR v_lock_order_item_id IN
        SELECT DISTINCT ri.order_item_id
          FROM public.return_items ri
         WHERE ri.return_id = p_return_id AND ri.order_item_id IS NOT NULL
         ORDER BY ri.order_item_id
      LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_order_item_id::text, 361));
      END LOOP;
      -- (#2066) A share line priced before the sale's billing changed (made at the order price before a sales-tax or
      -- discount line reached a live invoice of the sale, or before such an invoice posted), under these locks,
      -- (Mason, 22 Nov: re-price to the taxed share, never more than was charged on the posted invoices, tax included)
      -- is re-priced to the returner's billed share instead of refused as stale. Not re-priced, so still refused below
      -- (Mason's #1010 rule: cancel and recreate the return): a line beyond the billed share, and a line whose price is
      -- stale because an earlier return of it was cancelled, rejected or deleted after this one was made.
      WITH fresh AS (
        SELECT ri.id, ri.order_item_id, ri.quantity, ri.unit_price_cents AS old_unit_price_cents,
               ri.extended_cents AS old_extended_cents,
               round(s.billed_cents / s.billed_qty)::bigint AS unit_price_cents,
               greatest(0, round(s.billed_cents * (s.other_returned_qty + ri.quantity) / s.billed_qty)::bigint
                 - s.other_returned_cents) AS extended_cents
          FROM public.return_items ri
          CROSS JOIN LATERAL public._return_customer_line_share(
            v_order_id, ri.order_item_id, v_customer_id, p_return_id
          ) s
         WHERE ri.return_id = p_return_id
           AND s.share_mode
           AND s.billed_qty > 0
           AND s.other_returned_qty + ri.quantity <= s.billed_qty
           AND NOT EXISTS (
             SELECT 1
               FROM public.return_items ori
               JOIN public.returns orr ON orr.id = ori.return_id
               JOIN public.returns me ON me.id = p_return_id
              WHERE ori.order_item_id = ri.order_item_id
                AND orr.id <> p_return_id
                AND orr.order_id = v_order_id
                AND orr.customer_id = v_customer_id
                AND (orr.status IN ('rejected', 'cancelled') OR orr.deleted_at IS NOT NULL)
                AND orr.created_at <= me.created_at
                AND orr.updated_at >= me.created_at
           )
      ), repriced AS (
        UPDATE public.return_items ri
           SET unit_price_cents = f.unit_price_cents, extended_cents = f.extended_cents
          FROM fresh f
         WHERE ri.id = f.id
           AND (ri.unit_price_cents IS DISTINCT FROM f.unit_price_cents OR ri.extended_cents IS DISTINCT FROM f.extended_cents)
        RETURNING f.*
      )
      SELECT jsonb_agg(to_jsonb(repriced) ORDER BY repriced.order_item_id),
             sum(repriced.extended_cents - repriced.old_extended_cents)
        INTO v_repriced, v_repriced_delta
        FROM repriced;
      IF v_repriced IS NOT NULL THEN
        INSERT INTO public.financial_audit_log (
          operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
        ) VALUES (
          'return_received', 'return', p_return_id, v_actor, NULL, jsonb_build_object('lines', v_repriced), v_repriced_delta,
          'Return re-priced to the billed share (tax and discount included) after the sale''s billing changed'
        );
      END IF;
      -- Each share line's stored credit must still be exactly what create_return would price it at
      -- now: an earlier return of the line cancelled or rejected after this one was created leaves it
      -- stale, so refuse before restocking (cancel and recreate the return to reprice it).
      IF EXISTS (
        SELECT 1
          FROM public.return_items ri
          CROSS JOIN LATERAL public._return_customer_line_share(
            v_order_id, ri.order_item_id, v_customer_id, p_return_id
          ) s
         WHERE ri.return_id = p_return_id
           AND s.share_mode
           AND s.billed_qty > 0
           AND (
             ri.extended_cents IS DISTINCT FROM greatest(0,
               round(s.billed_cents * (s.other_returned_qty + ri.quantity) / NULLIF(s.billed_qty, 0))::bigint
               - s.other_returned_cents)
             -- and the unit price shown is the returner's billed rate
             OR ri.unit_price_cents IS DISTINCT FROM round(s.billed_cents / NULLIF(s.billed_qty, 0))::bigint
           )
      ) THEN RAISE EXCEPTION 'RETURN_SPLIT_SHARE_REPRICED'; END IF;
    END IF;

    -- Older linked rows were writable through table policies, so re-derive and
    -- verify every source fact before the legacy implementation can restock.
    IF NOT EXISTS (
      SELECT 1 FROM public.return_items ri WHERE ri.return_id = p_return_id
    ) OR EXISTS (
      SELECT 1
      FROM public.return_items ri
      LEFT JOIN public.order_items oi
        ON oi.id = ri.order_item_id AND oi.order_id = v_order_id
      -- Split-payer return (20261021155000): the returner's billed share of the line.
      LEFT JOIN LATERAL public._return_customer_line_share(
        v_order_id, ri.order_item_id, v_customer_id, p_return_id
      ) s ON true
      WHERE ri.return_id = p_return_id
        AND (
          ri.order_item_id IS NULL
          OR oi.id IS NULL
          OR oi.price_per_unit IS NULL
          OR ri.product_id IS DISTINCT FROM oi.product_id
          OR ri.unit IS DISTINCT FROM coalesce(oi.unit_size, 'ea')
          OR ri.quantity <= 0
          OR ri.quantity > coalesce(oi.quantity_delivered, 0)
          OR (NOT s.share_mode
              AND (ri.unit_price_cents IS DISTINCT FROM round(oi.price_per_unit * 100)::bigint
                   OR ri.extended_cents IS DISTINCT FROM round(ri.quantity * oi.price_per_unit * 100)::bigint))
          -- Split-payer return (20261021155000): within the returner's billed share, in quantity and
          -- in cents (create_return priced it from what was left of its billed cents).
          OR (s.share_mode AND (
            s.billed_qty <= 0
            OR ri.extended_cents < 0
            OR s.other_returned_qty + ri.quantity > s.billed_qty
            OR s.other_returned_cents + ri.extended_cents > s.billed_cents
          ))
        )
    ) OR (
      SELECT count(*) <> count(DISTINCT ri.order_item_id)
      FROM public.return_items ri
      WHERE ri.return_id = p_return_id
    ) OR EXISTS (
      SELECT 1
      FROM public.return_items current_ri
      JOIN public.order_items oi
        ON oi.id = current_ri.order_item_id AND oi.order_id = v_order_id
      WHERE current_ri.return_id = p_return_id
        AND (
          SELECT coalesce(sum(other_ri.quantity), 0)
          FROM public.return_items other_ri
          JOIN public.returns other_r ON other_r.id = other_ri.return_id
          WHERE other_ri.order_item_id = oi.id
            AND other_r.deleted_at IS NULL
            AND other_r.status NOT IN ('rejected', 'cancelled')
        ) > coalesce(oi.quantity_delivered, 0)
    ) THEN
      RAISE EXCEPTION 'RETURN_SOURCE_NOT_VERIFIED';
    END IF;
  ELSE
    -- Exact one-time compatibility for the sole approved production RMA that
    -- predates order-line capture. IDs and immutable source/money fields were
    -- verified read-only immediately before this migration was authored.
    v_is_legacy_unlinked := p_return_id = '0cb556ed-467a-4949-866d-8d9edbb09522'::uuid
      AND EXISTS (
        SELECT 1
        FROM public.returns r
        WHERE r.id = p_return_id
          AND r.return_number = 'RMA-2026-0001'
          AND r.customer_id = 'df6087cb-232f-4962-bb33-c74580a06935'::uuid
          AND r.requested_by = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
          AND r.approved_by = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
          AND r.reason = 'overstock'
          AND r.created_at = timestamptz '2026-04-30 20:48:18.967975+00'
          AND r.requested_at = timestamptz '2026-04-30 20:48:18.967975+00'
          AND r.approved_at = timestamptz '2026-07-10 16:45:29.044351+00'
          AND r.total_credit_cents = 0
      )
      AND 1 = (
        SELECT count(*) FROM public.return_items ri WHERE ri.return_id = p_return_id
      )
      AND EXISTS (
        SELECT 1
        FROM public.return_items ri
        WHERE ri.return_id = p_return_id
          AND ri.id = 'c4f6cc7d-0bbd-4c25-8bc0-c2c9e84aaadd'::uuid
          AND ri.order_item_id IS NULL
          AND ri.product_id = 'fad3ea45-cd8c-4bb8-b0ce-8a515941586c'::uuid
          AND ri.product_name = 'Gen Capture LFR: (Batallion LFC, Seguro) - 2.5 Gal'
          AND ri.quantity = 15.00
          AND ri.unit = 'ea'
          AND ri.unit_price_cents = 7597
          AND ri.extended_cents = 113955
          AND ri.condition = 'unopened'
          AND ri.restock = true
          AND ri.restocked = false
          AND ri.sort_order = 0
          AND ri.notes IS NULL
          AND ri.created_at = timestamptz '2026-04-30 20:48:19.173027+00'
      );
    IF NOT v_is_legacy_unlinked THEN
      RAISE EXCEPTION 'RETURN_SOURCE_NOT_VERIFIED';
    END IF;
  END IF;

  -- Phase 3 addition: policy is checked after all source verification and
  -- immediately before invoking the untouched private receive implementation.
  SELECT array_agg(DISTINCT ri.product_id ORDER BY ri.product_id)
    INTO v_product_ids
    FROM public.return_items ri
   WHERE ri.return_id = p_return_id;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  PERFORM public.assert_phase3_return_policy(v_product_ids);
  RETURN public._receive_return_impl_20260714(p_return_id, v_actor, p_idempotency_key);
END;
$function$;

-- 2. (#2066) issue_return_credit: re-price a stale share line, then cap it ---------------------------------------------
CREATE OR REPLACE FUNCTION public._issue_return_credit_intent_impl_20260812(p_return_id uuid, p_actor_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_order_id uuid;
  v_customer_id uuid;
  v_order_customer_id uuid;
  v_order_status text;
  v_is_legacy_unlinked boolean := false;
  -- Phase 3 addition: this wrapper takes the sorted multi-product lock set.
  v_product_ids uuid[];
  -- Split-payer return (20261021155000): see the re-check before the credit below.
  v_lock_order_item_id uuid;
  v_result jsonb;
  v_split_return boolean;
  -- (#2066) the lines re-priced below
  v_repriced jsonb;
  v_repriced_delta bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_actor_id IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'issue_return_credit');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT r.order_id, r.customer_id INTO v_order_id, v_customer_id
  FROM public.returns r
  WHERE r.id = p_return_id AND r.status = 'received'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_CREDITABLE'; END IF;

  IF v_order_id IS NULL THEN
    -- The same exact production record may be credited after receive_return
    -- advances it to received. No other source-free/caller-priced row qualifies.
    v_is_legacy_unlinked := p_return_id = '0cb556ed-467a-4949-866d-8d9edbb09522'::uuid
      AND EXISTS (
        SELECT 1
        FROM public.returns r
        WHERE r.id = p_return_id
          AND r.return_number = 'RMA-2026-0001'
          AND r.customer_id = 'df6087cb-232f-4962-bb33-c74580a06935'::uuid
          AND r.requested_by = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
          AND r.approved_by = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
          AND r.reason = 'overstock'
          AND r.created_at = timestamptz '2026-04-30 20:48:18.967975+00'
          AND r.requested_at = timestamptz '2026-04-30 20:48:18.967975+00'
          AND r.approved_at = timestamptz '2026-07-10 16:45:29.044351+00'
          AND r.total_credit_cents = 0
      )
      AND 1 = (
        SELECT count(*) FROM public.return_items ri WHERE ri.return_id = p_return_id
      )
      AND EXISTS (
        SELECT 1
        FROM public.return_items ri
        WHERE ri.return_id = p_return_id
          AND ri.id = 'c4f6cc7d-0bbd-4c25-8bc0-c2c9e84aaadd'::uuid
          AND ri.order_item_id IS NULL
          AND ri.product_id = 'fad3ea45-cd8c-4bb8-b0ce-8a515941586c'::uuid
          AND ri.product_name = 'Gen Capture LFR: (Batallion LFC, Seguro) - 2.5 Gal'
          AND ri.quantity = 15.00
          AND ri.unit = 'ea'
          AND ri.unit_price_cents = 7597
          AND ri.extended_cents = 113955
          AND ri.condition = 'unopened'
          AND ri.restock = true
          AND ri.sort_order = 0
          AND ri.notes IS NULL
          AND ri.created_at = timestamptz '2026-04-30 20:48:19.173027+00'
      );
    IF NOT v_is_legacy_unlinked THEN
      RAISE EXCEPTION 'RETURN_SOURCE_NOT_VERIFIED';
    END IF;
  ELSE
    SELECT o.status, o.customer_id INTO v_order_status, v_order_customer_id
    FROM public.orders o
    WHERE o.id = v_order_id AND o.deleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND OR v_order_status IN ('voided', 'cancelled') THEN
      RAISE EXCEPTION 'RETURN_SOURCE_ORDER_INACTIVE';
    END IF;
    -- Split-payer return (20261021155000): or a customer a posted governed split invoice of this
    -- order bills.
    IF v_order_customer_id IS DISTINCT FROM v_customer_id
       AND NOT public._return_customer_is_split_payer(v_order_id, v_customer_id) THEN
      RAISE EXCEPTION 'RETURN_ORDER_CUSTOMER_MISMATCH';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.return_items ri WHERE ri.return_id = p_return_id
    ) OR EXISTS (
      SELECT 1
      FROM public.return_items ri
      LEFT JOIN public.order_items oi
        ON oi.id = ri.order_item_id AND oi.order_id = v_order_id
      -- Split-payer return (20261021155000): the returner's billed share of the line.
      LEFT JOIN LATERAL public._return_customer_line_share(
        v_order_id, ri.order_item_id, v_customer_id, p_return_id
      ) s ON true
      WHERE ri.return_id = p_return_id
        AND (
          ri.order_item_id IS NULL
          OR oi.id IS NULL
          OR oi.price_per_unit IS NULL
          OR ri.product_id IS DISTINCT FROM oi.product_id
          OR ri.unit IS DISTINCT FROM coalesce(oi.unit_size, 'ea')
          OR ri.quantity <= 0
          OR ri.quantity > coalesce(oi.quantity_delivered, 0)
          OR (NOT s.share_mode
              AND (ri.unit_price_cents IS DISTINCT FROM round(oi.price_per_unit * 100)::bigint
                   OR ri.extended_cents IS DISTINCT FROM round(ri.quantity * oi.price_per_unit * 100)::bigint))
          -- Split-payer return (20261021155000): within the returner's billed share, in quantity and
          -- in cents (create_return priced it from what was left of its billed cents).
          OR (s.share_mode AND (
            s.billed_qty <= 0
            OR ri.extended_cents < 0
            OR s.other_returned_qty + ri.quantity > s.billed_qty
            OR s.other_returned_cents + ri.extended_cents > s.billed_cents
          ))
        )
    ) OR (
      SELECT count(*) <> count(DISTINCT ri.order_item_id)
      FROM public.return_items ri
      WHERE ri.return_id = p_return_id
    ) OR EXISTS (
      SELECT 1
      FROM public.return_items current_ri
      JOIN public.order_items oi
        ON oi.id = current_ri.order_item_id AND oi.order_id = v_order_id
      WHERE current_ri.return_id = p_return_id
        AND (
          SELECT coalesce(sum(other_ri.quantity), 0)
          FROM public.return_items other_ri
          JOIN public.returns other_r ON other_r.id = other_ri.return_id
          WHERE other_ri.order_item_id = oi.id
            AND other_r.deleted_at IS NULL
            AND other_r.status NOT IN ('rejected', 'cancelled')
        ) > coalesce(oi.quantity_delivered, 0)
    ) THEN RAISE EXCEPTION 'RETURN_SOURCE_NOT_VERIFIED'; END IF;
  END IF;

  -- Phase 3 addition: policy is checked after all source verification and
  -- immediately before invoking the untouched private credit implementation.
  SELECT array_agg(DISTINCT ri.product_id ORDER BY ri.product_id)
    INTO v_product_ids
    FROM public.return_items ri
   WHERE ri.return_id = p_return_id;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  PERFORM public.assert_phase3_return_policy(v_product_ids);

  -- Split-payer return (20261021155000): re-check every line's billed share under the same
  -- per-order-line locks the credit takes (a source void or edit try-takes them), so the share
  -- cannot shrink between this check and the credit. The credit memo is created inside this
  -- return's claim: the invoice guards admit a return credit memo on a split order, or for a field
  -- owner who is not the order's customer, only inside it. On a split return every credited unit
  -- must come from the returner's own billed line (no zero-cost remainder without source lineage).
  IF v_order_id IS NOT NULL THEN
    FOR v_lock_order_item_id IN
      SELECT DISTINCT ri.order_item_id
        FROM public.return_items ri
       WHERE ri.return_id = p_return_id AND ri.order_item_id IS NOT NULL
       ORDER BY ri.order_item_id
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_order_item_id::text, 361));
    END LOOP;
    -- (#2066) A share line priced before the sale's billing changed (made at the order price before a sales-tax or
    -- discount line reached a live invoice of the sale, or before such an invoice posted), under these locks,
    -- (Mason, 22 Nov: re-price to the taxed share, never more than was charged on the posted invoices, tax included)
    -- is re-priced to the returner's billed share instead of refused as stale. Not re-priced, so still refused below
    -- (Mason's #1010 rule: cancel and recreate the return): a line beyond the billed share, and a line whose price is
    -- stale because an earlier return of it was cancelled, rejected or deleted after this one was made.
    WITH fresh AS (
      SELECT ri.id, ri.order_item_id, ri.quantity, ri.unit_price_cents AS old_unit_price_cents,
             ri.extended_cents AS old_extended_cents,
             round(s.billed_cents / s.billed_qty)::bigint AS unit_price_cents,
             greatest(0, round(s.billed_cents * (s.other_returned_qty + ri.quantity) / s.billed_qty)::bigint
               - s.other_returned_cents) AS extended_cents
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_customer_line_share(
          v_order_id, ri.order_item_id, v_customer_id, p_return_id
        ) s
       WHERE ri.return_id = p_return_id
         AND s.share_mode
         AND s.billed_qty > 0
         AND s.other_returned_qty + ri.quantity <= s.billed_qty
         AND NOT EXISTS (
           SELECT 1
             FROM public.return_items ori
             JOIN public.returns orr ON orr.id = ori.return_id
             JOIN public.returns me ON me.id = p_return_id
            WHERE ori.order_item_id = ri.order_item_id
              AND orr.id <> p_return_id
              AND orr.order_id = v_order_id
              AND orr.customer_id = v_customer_id
              AND (orr.status IN ('rejected', 'cancelled') OR orr.deleted_at IS NOT NULL)
              AND orr.created_at <= me.created_at
              AND orr.updated_at >= me.created_at
         )
    ), repriced AS (
      UPDATE public.return_items ri
         SET unit_price_cents = f.unit_price_cents, extended_cents = f.extended_cents
        FROM fresh f
       WHERE ri.id = f.id
         AND (ri.unit_price_cents IS DISTINCT FROM f.unit_price_cents OR ri.extended_cents IS DISTINCT FROM f.extended_cents)
      RETURNING f.*
    )
    SELECT jsonb_agg(to_jsonb(repriced) ORDER BY repriced.order_item_id),
           sum(repriced.extended_cents - repriced.old_extended_cents)
      INTO v_repriced, v_repriced_delta
      FROM repriced;
    IF v_repriced IS NOT NULL THEN
      INSERT INTO public.financial_audit_log (
        operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
      ) VALUES (
        'return_credit_issued', 'return', p_return_id, v_actor, NULL, jsonb_build_object('lines', v_repriced), v_repriced_delta,
        'Return re-priced to the billed share (tax and discount included) after the sale''s billing changed'
      );
    END IF;
    IF EXISTS (
      SELECT 1
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_customer_line_share(
          v_order_id, ri.order_item_id, v_customer_id, p_return_id
        ) s
       WHERE ri.return_id = p_return_id
         AND s.share_mode
         AND (
           s.billed_qty <= 0
           OR s.other_returned_qty + ri.quantity > s.billed_qty
           OR s.other_returned_cents + ri.extended_cents > s.billed_cents
         )
    ) THEN RAISE EXCEPTION 'RETURN_CREDIT_EXCEEDS_BILLED_SHARE'; END IF;
    -- And each share line's stored credit is still exactly what create_return would price it at
    -- now: an earlier return of the line cancelled or rejected after this one was created leaves it
    -- stale, so refuse rather than credit a stale price (cancel and recreate the return).
    IF EXISTS (
      SELECT 1
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_customer_line_share(
          v_order_id, ri.order_item_id, v_customer_id, p_return_id
        ) s
       WHERE ri.return_id = p_return_id
         AND s.share_mode
         AND s.billed_qty > 0
         AND (
           ri.extended_cents IS DISTINCT FROM greatest(0,
             round(s.billed_cents * (s.other_returned_qty + ri.quantity) / NULLIF(s.billed_qty, 0))::bigint
             - s.other_returned_cents)
           -- and the unit price shown is the returner's billed rate
           OR ri.unit_price_cents IS DISTINCT FROM round(s.billed_cents / NULLIF(s.billed_qty, 0))::bigint
         )
    ) THEN RAISE EXCEPTION 'RETURN_SPLIT_SHARE_REPRICED'; END IF;
    v_split_return := v_order_customer_id IS DISTINCT FROM v_customer_id OR EXISTS (
      SELECT 1
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_customer_line_share(
          v_order_id, ri.order_item_id, v_customer_id, p_return_id
        ) s
       WHERE ri.return_id = p_return_id AND s.share_mode
    );

    INSERT INTO public.return_credit_customer_claims (return_id, order_id, customer_id)
    VALUES (p_return_id, v_order_id, v_customer_id);
    v_result := public._issue_return_credit_impl(p_return_id, v_actor, p_idempotency_key);
    DELETE FROM public.return_credit_customer_claims
     WHERE return_id = p_return_id AND transaction_id = pg_current_xact_id();
    IF v_split_return AND EXISTS (
      SELECT 1
        FROM public.returns r
        JOIN public.invoice_items ii ON ii.invoice_id = r.credit_invoice_id
       WHERE r.id = p_return_id
         AND ii.quantity < 0
         AND ii.return_credit_source_item_id IS NULL
    ) THEN RAISE EXCEPTION 'RETURN_SPLIT_CREDIT_UNBACKED'; END IF;
    RETURN v_result;
  END IF;
  RETURN public._issue_return_credit_impl(p_return_id, v_actor, p_idempotency_key);
END;
$function$;

-- 3. (#2091) the credit's tax ledger pools the same invoices the credit was priced from ---------------------------------
CREATE OR REPLACE FUNCTION public._freeze_credit_sales_tax_20270109(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv record;
  v_key record;
  v_pool_cents numeric;
  v_pool_tax numeric;
  v_tax bigint;
BEGIN
  SELECT i.id, i.invoice_type, i.status, i.deleted_at, i.customer_id,
         COALESCE(i.posted_at, i.created_at) AS booked_at INTO v_inv
    FROM public.invoices i WHERE i.id = p_invoice_id;
  IF NOT FOUND OR v_inv.invoice_type IS DISTINCT FROM 'credit_memo' THEN
    RETURN;
  END IF;
  -- one freeze or clear per customer at a time, so a credit never freezes against one being cleared
  -- (ponytail: per customer; a per-line-pool lock if credits ever queue up)
  PERFORM pg_advisory_xact_lock(hashtextextended('credit_memo_sales_tax:' || v_inv.customer_id::text, 0));
  IF v_inv.deleted_at IS NOT NULL OR v_inv.status NOT IN ('posted', 'overdue', 'paid') THEN
    DELETE FROM public.credit_memo_sales_tax WHERE invoice_id = p_invoice_id;
    RETURN;
  END IF;
  -- (A) A return credit line with no source line is the quantity delivered but never billed
  -- (_issue_return_credit_impl's NULL arm): it carries no tax, so it simply isn't in the loop below (the JOIN
  -- skips it). It used to refuse the credit here, which rolled back a valid return.
  IF EXISTS (SELECT 1 FROM public.credit_memo_sales_tax WHERE invoice_id = p_invoice_id) THEN
    RETURN;  -- already frozen (posted -> overdue -> paid keeps it)
  END IF;
  FOR v_key IN
    -- a credited line with no order line (a charge, or a product billed by hand) pools on its own source line, at
    -- that line's own whole-cent tax share
    SELECT COALESCE(src.order_item_id, src.id) AS line_key, src.order_item_id IS NULL AS is_charge,
           sum(ii.extended_cents) AS cents
      FROM public.invoice_items ii
      JOIN public.invoice_items src ON src.id = ii.return_credit_source_item_id
     WHERE ii.invoice_id = p_invoice_id
     GROUP BY 1, 2
  LOOP
    SELECT COALESCE(sum(sh.net_cents), 0), COALESCE(sum(sh.tax_cents), 0) INTO v_pool_cents, v_pool_tax
      FROM public.invoices i
      CROSS JOIN LATERAL public._invoice_line_tax_shares_20270109(i.id) sh
      JOIN public.invoice_items b ON b.id = sh.item_id
     WHERE i.customer_id = v_inv.customer_id
       AND i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL
       AND i.status IN ('posted', 'overdue', 'paid')
       -- (#2091) every lot of the pool that is posted now, not only those stamped at or before the credit's posting
       -- time: a return credit holds its order lines' locks (361), which posting or unposting a sale of the line also
       -- takes, so this is exactly the set the credit was priced from, including a lot that posted after the credit's
       -- transaction began.
       AND CASE WHEN v_key.is_charge
                THEN b.id = v_key.line_key AND b.order_item_id IS NULL
                ELSE i.id IN (SELECT o.invoice_id FROM public.invoice_items o WHERE o.order_item_id = v_key.line_key)
                     AND b.order_item_id = v_key.line_key AND b.quantity > 0 AND b.product_id IS NOT NULL
           END;
    SELECT v_pool_cents + COALESCE(sum(c.line_cents), 0), v_pool_tax + COALESCE(sum(c.tax_cents), 0)
      INTO v_pool_cents, v_pool_tax
      FROM public.credit_memo_sales_tax c
     WHERE c.line_key = v_key.line_key AND c.customer_id = v_inv.customer_id;
    v_tax := CASE
      WHEN v_pool_cents <= 0 THEN 0
      WHEN v_pool_cents + v_key.cents <= 0 THEN -v_pool_tax          -- takes all that remains
      ELSE round(v_key.cents * v_pool_tax / v_pool_cents)
    END;
    INSERT INTO public.credit_memo_sales_tax (invoice_id, line_key, customer_id, line_cents, tax_cents)
    VALUES (p_invoice_id, v_key.line_key, v_inv.customer_id, v_key.cents, v_tax);
  END LOOP;
END
$function$;

DO $postflight$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(f.name, ', ') INTO v_bad
    FROM (VALUES
      ('public._receive_return_intent_impl_20260812(uuid,uuid,text)', '(#2066)', 1),
      ('public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)', '(#2066)', 1),
      ('public._freeze_credit_sales_tax_20270109(uuid)', '(#2091)', 0)
    ) AS f(name, marker, ndef)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.name)
        AND position(f.marker in p.prosrc) > 0
        AND position('<= v_inv.booked_at' in p.prosrc) = 0
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef
        AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
        AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]
        AND p.pronargdefaults = f.ndef);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_TAX_CHANGE_POSTFLIGHT: not as written: %', v_bad;
  END IF;
  RAISE NOTICE 'RETURN_TAX_CHANGE_POSTFLIGHT_OK';
END
$postflight$;
