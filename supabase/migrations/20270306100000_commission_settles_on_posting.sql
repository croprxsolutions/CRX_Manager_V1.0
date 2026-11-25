-- Written 2026-11-25. STATUS: NOT APPLIED (staging candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270306100000_commission_settles_on_posting.md.
-- Re-read the live ledger before applying.
--
-- WHY (M4; Mason 2026-11-09, #crx-work: "commission on the profit after discounts"; KNOWN_ISSUES "Commission basis
-- ignores the standing discount"): a sale's commission splits its profit between its recipients (percentages total
-- 100), and every writer takes that profit from orders.total_profit, BEFORE the standing grower discount. The invoice,
-- the P&L and the profit reports already subtract it, so commission was paid on profit the business never made.
-- Example: $1,000 sale, $600 cost, 10% off, 7% tax, 60/40: $240 / $160 on $400 becomes $180 / $120 on $300 once the
-- invoice is posted. Sales tax was never in the base and still isn't.
--
-- DESIGN (re-planned 2026-11-25, Taha: "Yes, re-plan" / "Yes, OK with check"; plan in the M4 re-plan note): commission
-- settles when a chemical-sale invoice enters or leaves the posted set, never at a draft, never from a commit-time
-- queue. A first design recomputed at commit from deferred triggers and drew HIGHs in five review rounds.
--   1. _order_commission_base_20270306(sale) = total_profit + D × booked ÷ billed, over the sale's chemical-sale
--      invoices that are posted, overdue or paid and not deleted: D their standing-discount cents (each product line's
--      share, never tax: _invoice_line_tax_shares_20270109), billed their product cents, booked orders.total_price.
--      Fully billed: total_profit + D. Nothing posted: total_profit. The P&L earns commission by the share billed over
--      the same invoices (_report_commission_cents_20270203), so it earns exactly total_profit × share + D: the posted
--      profit after its discount (Taha, rule "b"). Lines with different margins are prorated by revenue, as the P&L
--      already does (accepted, Sol r6 H5).
--   2. _settle_order_commission_20270306(sale): takes the sale lock (orders row, FOR NO KEY UPDATE NOWAIT;
--      ORDER_LIFECYCLE_BUSY_RETRY when another save holds it, as guard_terminal_order_invoice_items does), then moves the
--      pending rows in no live payout batch whose stored base differs from the new base: each row its own percentage
--      of the base (never a share of what is left), exact to the cent by largest remainder when they are the sale's
--      whole live set, otherwise each its own rounded share. Rows already on the base never move (no cent after a
--      batch), and a sale with no posted discount whose rows sit on total_profit is left exactly as its writer made it.
--      It locks only the rows it moves, reads them again under the lock, and writes only those.
--   3. invoices_settle_commission_20270306: a plain (not deferred) AFTER UPDATE OF status, deleted_at row trigger on
--      chemical-sale invoices entering or leaving the posted set. It covers post (single and group), unpost, void
--      (including Fix Delivery's) and the deleted-delivery recovery post without re-emitting those functions; each
--      locks its invoice row first, and the sale lock is never waited for, so no lock cycle.
--   4. Re-emitted with one call each (bodies pinned below): _insert_commissions_for_order (the 7 sale creators),
--      fix_delivery (its re-inserted rows), cancel_order (Cancel Remaining), void_commission_payment (locks the
--      payout's sales first, then settles them). update_order_items is not: a sale can be edited only before any
--      delivery ("Cannot edit order in status: partially_fulfilled"), so it never has a posted invoice.
--   5. Sales that already have a posted discounted invoice are settled once below (live has none while the M4 switch
--      is off).
--
-- NOT CHANGED: field-job commission (field-application invoices can't carry a discount line), the reports, the M4
-- switches. Drafts: commission no longer follows a draft's discount at all.
--
-- KNOWN LIMITS: a commission already paid or batched keeps its amount when a later posted invoice brings more discount
-- (taking it back goes with returns, KI-13, and payout eligibility, Sol r6 H6: follow-up). A direct SQL change to
-- orders.total_profit / total_price or a commission row outside these app paths waits for the sale's next posting.
--
-- ROLLBACK (its own reviewed migration): drop the trigger and the three new functions, and re-emit the four pinned
-- functions from their source migrations (20260914100500, 20261106150000, 20260721145936, 20270228160000). Amounts
-- already settled stay until the sale's next re-split.
--
-- ORDERING: after 20270117130000_standing_discount_in_order_profit (_invoice_line_tax_shares_20270109) and
-- 20270228160000_idempotency_keys_printable_only (void_commission_payment as pinned).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE commission_settles_on_posting_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

CREATE TEMP TABLE commission_settles_on_posting_acl ON COMMIT DROP AS
SELECT p.oid, p.proacl FROM pg_proc p
 WHERE p.oid IN ('public._insert_commissions_for_order(uuid,uuid,numeric,jsonb,date)'::regprocedure,
                 'public.fix_delivery(uuid,text,text,text)'::regprocedure,
                 'public.cancel_order(uuid,uuid,text)'::regprocedure,
                 'public.void_commission_payment(uuid,text,uuid,text)'::regprocedure);

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.commission_settles_on_posting_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.commission_settles_on_posting_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'COMMISSION_SETTLES_ON_POSTING_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._settle_order_commission_20270306(uuid)') IS NOT NULL
     OR to_regprocedure('public._order_commission_base_20270306(uuid)') IS NOT NULL
     OR to_regprocedure('public._invoice_settles_commission_20270306()') IS NOT NULL THEN
    RAISE EXCEPTION 'COMMISSION_SETTLES_ON_POSTING_PREFLIGHT: already applied';
  END IF;
  IF to_regprocedure('public._invoice_line_tax_shares_20270109(uuid)') IS NULL
     OR to_regprocedure('public.compute_commission_amount(numeric,numeric)') IS NULL
     OR to_regprocedure('public._cancel_order_idem_impl_20260721(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_SETTLES_ON_POSTING_PREFLIGHT: a helper this needs is missing';
  END IF;
  -- The four functions re-emitted below must be exactly the bodies they were written from; anything else is a
  -- concurrent change to merge first.
  IF (SELECT string_agg(md5(prosrc), ',' ORDER BY oid::regprocedure::text) FROM pg_proc
       WHERE oid IN (SELECT oid FROM pg_temp.commission_settles_on_posting_acl))
     IS DISTINCT FROM (SELECT string_agg(m, ',' ORDER BY f) FROM (VALUES
       ('_insert_commissions_for_order(uuid,uuid,numeric,jsonb,date)', '3dd9c370d2aa7088db2cb4d20059ea45'),
       ('cancel_order(uuid,uuid,text)', '501473a43b505df72bc803a7354b0e60'),
       ('fix_delivery(uuid,text,text,text)', '2fb61be677985b989e9146bab4de9c2a'),
       ('void_commission_payment(uuid,text,uuid,text)', '36efe2f2f8c314cffa03ef6417f5da91')) AS v(f, m)) THEN
    RAISE EXCEPTION 'COMMISSION_SETTLES_ON_POSTING_PREFLIGHT: a re-emitted function changed since this was written';
  END IF;
END
$preflight$;

-- 1. The base ---------------------------------------------------------------------------------------------------
CREATE FUNCTION public._order_commission_base_20270306(p_order_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_invoice uuid;
  v_discount bigint := 0;
  v_billed numeric;
  v_booked numeric;
  v_profit numeric;
BEGIN
  SELECT COALESCE(total_profit, 0), round(total_price * 100) INTO v_profit, v_booked FROM orders WHERE id = p_order_id;
  -- Each posted discounted invoice is spread once (a per-line helper per order line took a 150-line sale past the
  -- statement timeout in the first design).
  FOR v_invoice IN
    SELECT DISTINCT b.invoice_id
      FROM order_items oi
      JOIN invoice_items b ON b.order_item_id = oi.id
      JOIN invoices i ON i.id = b.invoice_id
     WHERE oi.order_id = p_order_id
       AND i.invoice_type = 'chemical_sale' AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM invoice_items d WHERE d.invoice_id = i.id AND d.charge_type = 'standing_discount')
  LOOP
    v_discount := v_discount + COALESCE((
      SELECT sum(sh.net_cents - sh.tax_cents - b.extended_cents)
        FROM public._invoice_line_tax_shares_20270109(v_invoice) sh
        JOIN invoice_items b ON b.id = sh.item_id
        JOIN order_items oi ON oi.id = b.order_item_id
       WHERE oi.order_id = p_order_id AND b.product_id IS NOT NULL AND b.charge_type IS NULL), 0);
  END LOOP;
  IF v_discount = 0 THEN
    RETURN round(v_profit, 2);
  END IF;
  SELECT sum(b.extended_cents) INTO v_billed
    FROM order_items oi
    JOIN invoice_items b ON b.order_item_id = oi.id AND b.product_id IS NOT NULL AND b.charge_type IS NULL
    JOIN invoices i ON i.id = b.invoice_id
   WHERE oi.order_id = p_order_id
     AND i.invoice_type = 'chemical_sale' AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL;
  IF v_billed > 0 AND v_booked > v_billed THEN
    -- Part-billed: the posted invoices' discount rate across the whole sale.
    RETURN round(v_profit + round(v_discount * v_booked / v_billed) / 100.0, 2);
  END IF;
  RETURN round(v_profit + v_discount / 100.0, 2);
END
$function$;
REVOKE ALL ON FUNCTION public._order_commission_base_20270306(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 2. The settle -------------------------------------------------------------------------------------------------
CREATE FUNCTION public._settle_order_commission_20270306(p_order_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_profit numeric;
  v_base numeric;
  v_base_cents bigint;
  v_whole boolean;
  v_ids uuid[];
  v_pcts numeric[];
  v_new numeric[];
  v_moving uuid[];
  v_locked uuid[] := '{}';
  v_count int;
BEGIN
  IF p_order_id IS NULL THEN
    RETURN 0;
  END IF;
  -- The one sale lock, taken first. Never waited for: a caller holding an invoice row must not queue behind a save
  -- that holds the sale and wants that invoice.
  BEGIN
    SELECT COALESCE(total_profit, 0) INTO v_profit FROM orders WHERE id = p_order_id FOR NO KEY UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'ORDER_LIFECYCLE_BUSY_RETRY: this order is being changed; wait a moment and retry';
  END;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  v_base := public._order_commission_base_20270306(p_order_id);
  v_base_cents := round(GREATEST(v_base, 0) * 100)::bigint;

  LOOP
    -- The rows this may move: pending, in no live payout batch.
    SELECT array_agg(c.id ORDER BY c.id), array_agg(c.split_percentage ORDER BY c.id)
      INTO v_ids, v_pcts
      FROM commissions c
     WHERE c.order_id = p_order_id AND c.deleted_at IS NULL AND c.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM commission_payment_items cpi
                         JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
                        WHERE cpi.commission_id = c.id AND cp.status <> 'voided');
    IF v_ids IS NULL THEN
      RETURN 0;
    END IF;
    -- A sale whose base is its plain profit and whose rows already sit on it belongs to its writer: untouched.
    IF v_base = round(v_profit, 2)
       AND NOT EXISTS (SELECT 1 FROM commissions WHERE id = ANY (v_ids) AND order_profit IS DISTINCT FROM v_base) THEN
      RETURN 0;
    END IF;
    v_whole := NOT EXISTS (SELECT 1 FROM commissions c
                            WHERE c.order_id = p_order_id AND c.deleted_at IS NULL AND c.status <> 'cancelled'
                              AND c.id <> ALL (v_ids));
    IF v_whole THEN
      -- Exact to the cent: each row its own percentage of the base, the set's share by largest remainder.
      SELECT array_agg((floor(r.raw) + CASE WHEN r.remainder_rank <= r.share - r.floored THEN 1 ELSE 0 END) / 100.0
                       ORDER BY r.id)
        INTO v_new
        FROM (SELECT u.id, u.raw,
                     row_number() OVER (ORDER BY u.raw - floor(u.raw) DESC, u.id) AS remainder_rank,
                     sum(floor(u.raw)) OVER () AS floored,
                     round(sum(u.raw) OVER ()) AS share
                FROM (SELECT x.id, v_base_cents * x.pct / 100 AS raw FROM unnest(v_ids, v_pcts) AS x(id, pct)) u) r;
    ELSE
      -- Some rows are paid or batched: each pending row is its own share (the edit paths' rule).
      SELECT array_agg(public.compute_commission_amount(v_base, x.pct) ORDER BY x.id) INTO v_new
        FROM unnest(v_ids, v_pcts) AS x(id, pct);
    END IF;
    -- Only rows whose stored base differs move: an unchanged base never moves a cent.
    SELECT array_agg(c.id ORDER BY c.id) INTO v_moving
      FROM commissions c
     WHERE c.id = ANY (v_ids) AND c.order_profit IS DISTINCT FROM v_base;
    IF v_moving IS NULL THEN
      RETURN 0;
    END IF;
    EXIT WHEN v_moving <@ v_locked;
    -- Lock only the rows that move, then decide again: a row a payout took meanwhile drops out, and only locked rows
    -- are written.
    PERFORM 1 FROM commissions WHERE id = ANY (v_moving) AND id <> ALL (v_locked) ORDER BY id FOR UPDATE;
    v_locked := v_locked || ARRAY(SELECT unnest(v_moving) EXCEPT SELECT unnest(v_locked));
  END LOOP;

  UPDATE commissions c
     SET order_profit = v_base, commission_amount = r.amount
    FROM unnest(v_ids, v_new) AS r(id, amount)
   WHERE c.id = r.id AND c.id = ANY (v_moving);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$function$;
REVOKE ALL ON FUNCTION public._settle_order_commission_20270306(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 3. Posting, unposting and voiding ------------------------------------------------------------------------------
CREATE FUNCTION public._invoice_settles_commission_20270306()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- The invoice's own sale and every sale its product lines bill, in id order.
  PERFORM public._settle_order_commission_20270306(s.order_id)
     FROM (SELECT NEW.order_id AS order_id WHERE NEW.order_id IS NOT NULL
           UNION
           SELECT oi.order_id FROM invoice_items b JOIN order_items oi ON oi.id = b.order_item_id
            WHERE b.invoice_id = NEW.id
           ORDER BY 1) s;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public._invoice_settles_commission_20270306() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER invoices_settle_commission_20270306
  AFTER UPDATE OF status, deleted_at ON public.invoices
  FOR EACH ROW
  WHEN (NEW.invoice_type = 'chemical_sale'
        AND (OLD.status IN ('posted', 'overdue', 'paid') AND OLD.deleted_at IS NULL)
            IS DISTINCT FROM (NEW.status IN ('posted', 'overdue', 'paid') AND NEW.deleted_at IS NULL))
  EXECUTE FUNCTION public._invoice_settles_commission_20270306();

-- 4. The writers that put rows back on total_profit (bodies as pinned above, one call added each) ----------------
CREATE OR REPLACE FUNCTION public._insert_commissions_for_order(p_order_id uuid, p_customer_id uuid, p_order_profit numeric, p_commission_split jsonb, p_order_date date DEFAULT ((now() AT TIME ZONE 'America/Chicago'::text))::date)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count int := 0;
  v_order_date date;
BEGIN
  PERFORM set_config('crx.chicago_date_cutover', '20260905200400', true);
  IF p_commission_split IS NULL OR NOT (p_commission_split ? 'splits') THEN
    RETURN 0;
  END IF;
  PERFORM public.validate_commission_split_json(p_commission_split);
  SELECT o.order_date INTO v_order_date FROM public.orders o WHERE o.id = p_order_id;
  v_order_date := COALESCE(v_order_date, p_order_date, (now() AT TIME ZONE 'America/Chicago')::date);
  INSERT INTO public.commissions (
    order_id, customer_id, recipient, recipient_user_id, split_percentage,
    commission_amount, order_profit, order_date, status
  )
  WITH split_rows AS (
    SELECT s, ord, row_number() OVER (ORDER BY ord) AS rn, count(*) OVER () AS split_count,
           s->>'recipient' AS recipient, NULLIF(btrim(s->>'recipient_user_id'), '')::uuid AS split_user_id,
           (s->>'percentage')::numeric AS percentage
      FROM jsonb_array_elements(p_commission_split->'splits') WITH ORDINALITY AS e(s, ord)
     WHERE (NULLIF(btrim(s->>'recipient'), '') IS NOT NULL OR NULLIF(btrim(s->>'recipient_user_id'), '') IS NOT NULL)
       AND (s->>'percentage')::numeric > 0
  ), calculated AS (
    SELECT sr.*, COALESCE(
      (SELECT p.id FROM public.profiles p WHERE p.id = sr.split_user_id AND p.is_active = true),
      (SELECT p.id FROM public.profiles p WHERE lower(trim(p.full_name)) = lower(trim(sr.recipient)) AND p.is_active = true
         AND (SELECT count(*) FROM public.profiles p2 WHERE lower(trim(p2.full_name)) = lower(trim(sr.recipient)) AND p2.is_active = true) = 1 LIMIT 1)
    ) AS resolved_user_id,
    CASE WHEN sr.rn = sr.split_count THEN GREATEST(ROUND(COALESCE(p_order_profit, 0), 2), 0) - COALESCE(
      SUM(public.compute_commission_amount(p_order_profit, sr.percentage)) OVER (ORDER BY sr.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
    ELSE public.compute_commission_amount(p_order_profit, sr.percentage) END AS reconciled_amount
    FROM split_rows sr
  )
  SELECT p_order_id, p_customer_id, COALESCE((SELECT p.full_name FROM public.profiles p WHERE p.id = c.resolved_user_id), c.recipient),
         c.resolved_user_id, c.percentage, c.reconciled_amount, COALESCE(p_order_profit, 0), v_order_date, 'pending'
    FROM calculated c;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  -- M4 (20270306100000): new rows land on total_profit; put them on the profit after the sale's posted discount.
  PERFORM public._settle_order_commission_20270306(p_order_id);
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fix_delivery(p_delivery_id uuid, p_reason text, p_plan_token text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''), E' \t\r\n');
  v_fingerprint text;
  v_replay jsonb;
  v_plan jsonb;
  v_order_id uuid;
  v_invoice jsonb;
  v_pending_commission_ids uuid[];
  v_commissions_restored integer := 0;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: fix_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin access required to fix a delivery'; END IF;
  -- Only blanks of any kind (no-break and other Unicode spaces too) is no reason.
  IF v_reason ~ '^[[:space:][:cntrl:]\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*$' THEN
    RAISE EXCEPTION 'Reason is required to fix a delivery';
  END IF;

  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'delivery_id', p_delivery_id,
    'reason', v_reason,
    'plan_token', p_plan_token
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'fix_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- Lock in the order void_delivery and the invoice-first trigger use: delivery, then order
  -- (fail fast), then the delivery's invoices (fail fast).
  SELECT order_id INTO v_order_id FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;
  BEGIN
    IF v_order_id IS NOT NULL THEN
      PERFORM 1 FROM orders WHERE id = v_order_id FOR UPDATE NOWAIT;
    END IF;
    PERFORM 1 FROM invoices WHERE delivery_id = p_delivery_id FOR UPDATE NOWAIT;
    -- The order drafts void_delivery will cancel, so they cannot deadlock it later.
    PERFORM 1 FROM invoices WHERE order_id = v_order_id AND delivery_id IS NULL
                              AND status IN ('draft', 'unposted') AND deleted_at IS NULL FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'DELIVERY_ORDER_BUSY_RETRY';
  END;
  -- Lock the order's pending commissions so a payout batch created meanwhile is seen by the plan
  -- below (create_commission_payment locks these same rows).
  SELECT COALESCE(array_agg(id), '{}') INTO v_pending_commission_ids
    FROM (SELECT id FROM commissions
           WHERE order_id = v_order_id AND status = 'pending' AND deleted_at IS NULL
           FOR UPDATE) c;
  -- Hold the delivery month and each applied credit's months (UTC and Chicago dates) against
  -- close_accounting_period, as check_period_open does, so the plan's closed-month checks cannot
  -- pass just before one of those months closes.
  PERFORM public._lock_accounting_months(
    ARRAY[(SELECT COALESCE((d.completed_at AT TIME ZONE 'America/Chicago')::date, d.scheduled_date)
             FROM deliveries d WHERE d.id = p_delivery_id)]
    || ARRAY(SELECT x FROM invoices i
               JOIN credit_memo_applications cma ON cma.reversed_at IS NULL
                AND (cma.credit_memo_id = i.id OR cma.target_invoice_id = i.id),
               LATERAL (VALUES (cma.applied_at::date), ((cma.applied_at AT TIME ZONE 'America/Chicago')::date)) v(x)
              WHERE i.delivery_id = p_delivery_id),
    false);

  v_plan := public._fix_delivery_plan(p_delivery_id);
  IF NOT (v_plan ->> 'can_fix')::boolean THEN
    RAISE EXCEPTION 'FIX_DELIVERY_REFUSED: %', v_plan -> 'refusals' -> 0 ->> 'message'
      USING DETAIL = (v_plan -> 'refusals')::text;
  END IF;
  IF (v_plan ->> 'plan_token') IS DISTINCT FROM p_plan_token THEN
    RAISE EXCEPTION 'FIX_DELIVERY_PREVIEW_STALE: the delivery or its invoices changed since the preview; reopen Fix delivery to see the new plan';
  END IF;

  -- This key has no receipt yet, and the inner receipts commit only with it, so an inner key
  -- already used means another request took it; void_invoice's receipt would replay that one.
  -- Any operation counts: idempotency_key is unique on its own. An expired receipt does not count:
  -- the inner function's idempotency helper clears it.
  IF EXISTS (SELECT 1 FROM idempotency_keys k
              WHERE (k.expires_at IS NULL OR k.expires_at > now())
                AND (k.idempotency_key = p_idempotency_key || ':void_delivery'
                     OR k.idempotency_key IN (SELECT p_idempotency_key || ':void_invoice:' || (e ->> 'id')
                                                FROM jsonb_array_elements(v_plan -> 'invoices') e))) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH';
  END IF;

  FOR v_invoice IN SELECT e FROM jsonb_array_elements(v_plan -> 'invoices') e LOOP
    PERFORM public.void_invoice(
      (v_invoice ->> 'id')::uuid,
      'Fix delivery ' || (v_plan ->> 'delivery_number') || ': ' || v_reason,
      p_idempotency_key || ':void_invoice:' || (v_invoice ->> 'id'));
  END LOOP;

  PERFORM public.void_delivery(p_delivery_id, v_reason, v_actor, p_idempotency_key || ':void_delivery');
  -- Never report success, or restore the commission, unless the delivery really is voided now.
  IF NOT EXISTS (SELECT 1 FROM deliveries WHERE id = p_delivery_id AND status = 'voided') THEN
    RAISE EXCEPTION 'FIX_DELIVERY_NOT_VOIDED';
  END IF;

  -- The order stands, so the rep keeps the commission void_invoice just cancelled.
  PERFORM set_config('crx.fix_delivery_restore', 'on', true);
  INSERT INTO commissions (order_id, customer_id, recipient, recipient_user_id, split_percentage,
                           commission_amount, order_profit, order_date, season, order_number, customer_name,
                           status, replaces_commission_id)
  SELECT c.order_id, c.customer_id, c.recipient, c.recipient_user_id, c.split_percentage,
         c.commission_amount, c.order_profit, c.order_date, c.season, c.order_number, c.customer_name,
         'pending', c.id
    FROM commissions c
   WHERE c.id = ANY (v_pending_commission_ids) AND c.status = 'cancelled';
  GET DIAGNOSTICS v_commissions_restored = ROW_COUNT;
  PERFORM set_config('crx.fix_delivery_restore', 'off', true);

  v_result := jsonb_build_object(
    'success', true,
    'delivery_id', p_delivery_id,
    'delivery_number', v_plan ->> 'delivery_number',
    'order_id', v_order_id,
    'customer_id', v_plan -> 'customer_id',
    'invoices', v_plan -> 'invoices',
    'other_draft_invoices', v_plan -> 'other_draft_invoices',
    'commissions_restored', v_commissions_restored
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('delivery_fixed',
          'Fixed delivery ' || (v_plan ->> 'delivery_number') || ': undid it and ' ||
            jsonb_array_length(v_plan -> 'invoices') || ' invoice(s) for re-entry' ||
            CASE WHEN jsonb_array_length(v_plan -> 'other_draft_invoices') > 0
                 THEN ', and cancelled ' || jsonb_array_length(v_plan -> 'other_draft_invoices') || ' order draft invoice(s)'
                 ELSE '' END || '. Reason: ' || v_reason,
          v_actor, 'delivery', p_delivery_id, (v_plan ->> 'customer_id')::uuid);

  PERFORM public.save_idempotency(p_idempotency_key, 'fix_delivery', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'fix_delivery', v_fingerprint);
  -- M4 (20270306100000): the restored rows copy the old amounts; put them on the profit after the sale's posted
  -- discount (the voided invoice no longer counts).
  PERFORM public._settle_order_commission_20270306(v_order_id);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: cancel_order'
      USING ERRCODE = '22023';
  END IF;
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_result := public._cancel_order_idem_impl_20260721(
    p_order_id, p_performed_by, p_idempotency_key
  );
  -- M4 (20270306100000): Cancel Remaining re-splits the pending rows on total_profit; put them on the profit after
  -- the sale's posted discount. A whole cancel leaves no pending row, so this does nothing.
  PERFORM public._settle_order_commission_20270306(p_order_id);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_commission_payment(p_payment_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
  -- See create_commission_payment: fingerprint and implementation must receive
  -- the identical normalized value, never trimmed here and raw there.
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  -- REASON_REQUIRED is checked before the receipt lookup in the implementation;
  -- keep that ordering so the error surface is unchanged.
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  -- See create: a key is REQUIRED, so no caller reaches the money path unbound.
  -- Two predicates, deliberately. The first is the house rule already live in
  -- 20260721145936 across every money/lifecycle RPC, kept so this path does not
  -- drift from the rest. The second demands one printable ASCII character:
  -- [[:space:]] follows the database collation, so whether NBSP or an em-space
  -- counts as blank is not the same answer on every cluster, and a key made
  -- only of those would be accepted somewhere. Every key this application
  -- generates is ASCII, so this costs no real caller anything.
  --
  -- COLLATE "C" is what makes the second predicate locale-independent, and it
  -- is not decoration: Postgres resolves a bracket RANGE like [!-~] through the
  -- active collating sequence, so under a non-C collation a non-ASCII character
  -- can sort inside the range and satisfy it. Both predicates would then be
  -- locale-dependent and a key with no printable ASCII could be accepted after
  -- all. "C" is built in and always present, so pinning it here has no
  -- deployment cost.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: void_commission_payment requires p_idempotency_key';
  END IF;

  -- Intent = the actor, which payment is being voided, and the reason text
  -- (normalized only for surrounding whitespace, which the UI already trims).
  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'payment_id', p_payment_id,
        'reason', v_reason
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'void_commission_payment', v_actor, v_fingerprint
  );

  IF v_replay IS NOT NULL THEN
    -- See create_commission_payment: return the committed receipt directly so a
    -- NULL stored result can never be mistaken for "not yet performed".
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- M4 (20270306100000): the payout's sales are locked first, in id order (the one sale lock every commission writer
  -- takes before commission rows), then the rows it returns to pending are put on their sale's current base: they
  -- may have been batched before a later posted discount.
  PERFORM 1 FROM public.orders o
   WHERE o.id IN (SELECT c.order_id FROM public.commission_payment_items cpi
                    JOIN public.commissions c ON c.id = cpi.commission_id
                   WHERE cpi.commission_payment_id = p_payment_id)
   ORDER BY o.id
     FOR NO KEY UPDATE;
  v_result := public._void_commission_payment_intent_impl_20260809(
    p_payment_id, v_reason, p_performed_by, p_idempotency_key
  );
  PERFORM public._settle_order_commission_20270306(s.order_id)
     FROM (SELECT DISTINCT c.order_id FROM public.commission_payment_items cpi
             JOIN public.commissions c ON c.id = cpi.commission_id
            WHERE cpi.commission_payment_id = p_payment_id AND c.order_id IS NOT NULL
            ORDER BY 1) s;

  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'void_commission_payment';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_result;
END;
$function$;

-- 5. Sales that already have a posted discounted invoice (none on live while the M4 switch is off) -----------------
DO $existing$
DECLARE
  v_order uuid;
  v_moved int := 0;
BEGIN
  FOR v_order IN
    SELECT DISTINCT oi.order_id
      FROM public.invoice_items d
      JOIN public.invoices i ON i.id = d.invoice_id
      JOIN public.invoice_items b ON b.invoice_id = i.id
      JOIN public.order_items oi ON oi.id = b.order_item_id
     WHERE d.charge_type = 'standing_discount' AND i.invoice_type = 'chemical_sale'
       AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL
     ORDER BY 1
  LOOP
    v_moved := v_moved + public._settle_order_commission_20270306(v_order);
  END LOOP;
  RAISE NOTICE 'COMMISSION_SETTLES_ON_POSTING: % pending commission row(s) settled on the profit after discount', v_moved;
END
$existing$;

DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.invoices'::regclass AND tgname = 'invoices_settle_commission_20270306'
                    AND tgfoid = 'public._invoice_settles_commission_20270306()'::regprocedure
                    AND NOT tgdeferrable AND tgenabled = 'O')
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('public._order_commission_base_20270306(uuid)'::regprocedure,
                    'public._settle_order_commission_20270306(uuid)'::regprocedure,
                    'public._invoice_settles_commission_20270306()'::regprocedure)
                  AND p.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[])
     OR EXISTS (SELECT 1 FROM pg_temp.commission_settles_on_posting_acl a JOIN pg_proc p ON p.oid = a.oid
                 WHERE p.proacl IS DISTINCT FROM a.proacl
                    OR position('_settle_order_commission_20270306' IN p.prosrc) = 0) THEN
    RAISE EXCEPTION 'COMMISSION_SETTLES_ON_POSTING_POSTFLIGHT: a trigger, grant or re-emitted body is not as written';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$postflight$;
