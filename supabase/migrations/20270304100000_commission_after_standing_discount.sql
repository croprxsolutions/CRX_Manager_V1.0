-- Written 2026-11-25. STATUS: NOT APPLIED (staging candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270304100000_commission_after_standing_discount.md.
-- Re-read the live ledger before applying.
--
-- WHY (M4; Mason 2026-11-09, #crx-work: "commission on the profit after discounts"; KNOWN_ISSUES "Commission basis
-- ignores the standing discount"): a sale's commission splits its profit between its recipients (percentages total
-- 100, validate_commission_split_json), and every writer takes that profit from orders.total_profit, BEFORE the
-- standing grower discount. The invoice, the P&L and the profit reports already subtract the discount
-- (20270117130000_standing_discount_in_order_profit), so commission was paid on profit the business never made.
-- Example: $1,000 sale, $600 cost, 10% off ($100), 7% tax: commission was split on $400; it is now split on $300.
-- Sales tax was never in the base (total_profit is product lines only; the discount share leaves tax out) and still
-- isn't.
--
-- WHAT:
--   1. _order_commission_base_20270304(sale) = total_profit + _order_standing_discount_20270109(sale): the profit
--      after the discount lines on the sale's chemical-sale invoices that are not voided or deleted (drafts included),
--      every payer of a Bill Split counted. The same figure the dashboard and the sale page already show. While the
--      sale is only part-invoiced, the discount so far is scaled to the whole sale (discount × booked ÷ invoiced;
--      Taha 2026-11-25), so the P&L, which earns commission by the share invoiced, never earns more than the invoiced
--      profit after its discount.
--   2. _recompute_order_commissions_20270304(sale): puts the sale's pending rows that are in no live payout batch on
--      that base, each row its own percentage of it. Together they hold the live rows' share of the base less what paid
--      or batched rows hold, exact to the cent (largest remainder, as Cancel Remaining splits); when paid rows sit on an
--      older base, each pending row is its own share (the edit paths' rule). Paid or batched rows never move. Rows the
--      writers minted (each its rounded share, the last taking the penny) are kept, so a sale with no discount is
--      exactly as before (no extra commission history). One recompute per sale at a time (advisory lock).
--   3. Run at commit (a deferred trigger, the way 20270109100100 keeps the discount line itself) whenever a sale's
--      discount can have changed or its commission was just written: a standing-discount line added, changed or
--      removed; a chemical-sale invoice carrying one voided, deleted, moved or retyped; a sale's commission row
--      minted or recomputed (the 7 sale creators through _insert_commissions_for_order, edits, Cancel Remaining,
--      Fix Delivery). One place covers every writer, today's and later ones.
--   4. Sales that already have discount lines (staging test data; live has none while the M4 switch is off) are put
--      on the new base once, at the end of this file.
--
-- NOT CHANGED: the writers themselves, field-job commission (a field-application invoice can't carry a discount line:
--   _recompute_standing_discount_20261231 strips one), payouts, the reports (they read the stored amounts), the M4
--   switches (billing_m4_switch and billingM4Enabled(): their own change once Mason has seen this on staging).
--
-- KNOWN LIMIT (Mason's call, asked in the plan): a commission already paid or in a payout batch keeps its amount when
--   a later invoice of the same sale brings more discount. Taking it back belongs with returns (KI-13).
--
-- ROLLBACK (its own reviewed migration): drop the six triggers, _commission_after_discount_20270304(),
--   _commission_mark_sale_20270304(), _recompute_order_commissions_20270304(uuid) and
--   _order_commission_base_20270304(uuid). Amounts already moved stay
--   until the sale's next edit re-mints them on total_profit.
--
-- ORDERING: after 20270117130000_standing_discount_in_order_profit (uses _order_standing_discount_20270109).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE commission_after_discount_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.commission_after_discount_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.commission_after_discount_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'COMMISSION_AFTER_DISCOUNT_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._recompute_order_commissions_20270304(uuid)') IS NOT NULL
     OR to_regprocedure('public._order_commission_base_20270304(uuid)') IS NOT NULL
     OR to_regprocedure('public._commission_after_discount_20270304()') IS NOT NULL
     OR to_regprocedure('public._commission_mark_sale_20270304()') IS NOT NULL THEN
    RAISE EXCEPTION 'COMMISSION_AFTER_DISCOUNT_PREFLIGHT: already applied';
  END IF;
  IF to_regprocedure('public._order_standing_discount_20270109(uuid)') IS NULL
     OR to_regprocedure('public._invoice_line_tax_shares_20270109(uuid)') IS NULL
     OR to_regprocedure('public.compute_commission_amount(numeric,numeric)') IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_AFTER_DISCOUNT_PREFLIGHT: 20270117130000_standing_discount_in_order_profit is not applied';
  END IF;
END
$preflight$;

-- 1. The base ---------------------------------------------------------------------------------------------------
CREATE FUNCTION public._order_commission_base_20270304(p_order_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_invoice uuid;
  v_cents bigint := 0;
  v_billed numeric;
  v_booked numeric;
  v_profit numeric;
BEGIN
  -- The sale's discount so far: exactly _order_standing_discount_20270109(sale) (each order line's share of its
  -- invoices' discount lines, summed; never tax), but each discounted invoice is spread ONCE, in a plain loop, not once
  -- per order line: the per-line helper took a 150-line sale past the 8 s statement timeout, and one set-based query
  -- flipped plans (attack run, 2026-11-25). The smoke checks the two agree.
  FOR v_invoice IN
    SELECT DISTINCT b.invoice_id
      FROM order_items oi
      JOIN invoice_items b ON b.order_item_id = oi.id
      JOIN invoices i ON i.id = b.invoice_id
     WHERE oi.order_id = p_order_id
       AND i.invoice_type = 'chemical_sale' AND i.deleted_at IS NULL AND i.status NOT IN ('voided', 'cancelled')
       AND EXISTS (SELECT 1 FROM invoice_items d WHERE d.invoice_id = i.id AND d.charge_type = 'standing_discount')
  LOOP
    v_cents := v_cents + COALESCE((
      SELECT sum(sh.net_cents - sh.tax_cents - b.extended_cents)
        FROM public._invoice_line_tax_shares_20270109(v_invoice) sh
        JOIN invoice_items b ON b.id = sh.item_id
        JOIN order_items oi ON oi.id = b.order_item_id
       WHERE oi.order_id = p_order_id AND b.product_id IS NOT NULL AND b.charge_type IS NULL), 0);
  END LOOP;
  SELECT COALESCE(total_profit, 0), round(total_price * 100) INTO v_profit, v_booked FROM orders WHERE id = p_order_id;
  -- Part-invoiced (Taha 2026-11-25, "b"): the discount so far is that invoiced share's discount, so the whole sale is
  -- put on the same rate (discount × booked ÷ invoiced). The P&L earns commission by the share invoiced
  -- (_report_commission_cents_20270203), so what it earns is the invoiced profit after its discount, never more (Sol
  -- HIGH 1): $1,000 sale, $600 cost, half invoiced with $50 off → rows on $300, $150 earned. Fully invoiced: as is.
  IF v_cents <> 0 AND v_booked > 0 THEN
    SELECT sum(b.extended_cents) INTO v_billed
      FROM order_items oi
      JOIN invoice_items b ON b.order_item_id = oi.id AND b.product_id IS NOT NULL AND b.charge_type IS NULL
      JOIN invoices i ON i.id = b.invoice_id
     WHERE oi.order_id = p_order_id
       AND i.invoice_type = 'chemical_sale' AND i.deleted_at IS NULL AND i.status NOT IN ('voided', 'cancelled');
    IF v_billed > 0 AND v_billed < v_booked THEN
      RETURN round(v_profit + round(v_cents * v_booked / v_billed) / 100.0, 2);
    END IF;
  END IF;
  RETURN round(v_profit + v_cents / 100.0, 2);
END
$function$;
REVOKE ALL ON FUNCTION public._order_commission_base_20270304(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 2. The recompute ----------------------------------------------------------------------------------------------
CREATE FUNCTION public._recompute_order_commissions_20270304(p_order_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base numeric;
  v_base_cents bigint;
  v_pool bigint;
  v_n int;
  v_ids uuid[];
  v_pcts numeric[];
  v_cur numeric[];
  v_new numeric[];
  v_moving uuid[];
  v_locked uuid[] := '{}';
  v_count int;
BEGIN
  IF p_order_id IS NULL THEN
    RETURN 0;
  END IF;
  -- One recompute of a sale at a time, taken before anything is read (Sol HIGH 4): a discount change and a payout void
  -- of the same sale both arrive here at commit, and the second waits, then reads what the first committed.
  PERFORM pg_advisory_xact_lock(hashtextextended('crx.commission_recompute_20270304:' || p_order_id::text, 0));
  LOOP
    v_base := public._order_commission_base_20270304(p_order_id);
    v_base_cents := round(GREATEST(v_base, 0) * 100)::bigint;
    -- The rows this may move: pending, in no live payout batch.
    SELECT array_agg(c.id ORDER BY c.id), array_agg(c.split_percentage ORDER BY c.id),
           array_agg(c.commission_amount ORDER BY c.id), count(*)
      INTO v_ids, v_pcts, v_cur, v_n
      FROM commissions c
     WHERE c.order_id = p_order_id AND c.deleted_at IS NULL AND c.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM commission_payment_items cpi
                         JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
                        WHERE cpi.commission_id = c.id AND cp.status <> 'voided');
    IF v_n = 0 THEN
      RETURN 0;
    END IF;
    -- What those rows share: each live row's own percentage of the base, never a share of what is left (Sol HIGH 2:
    -- a 40% row stays 40% when the 60% row is cancelled, moved or deleted), less what paid or batched rows already
    -- hold, so an unchanged base adds no cent after a batch (Sol MED 10).
    SELECT round(v_base_cents * sum(c.split_percentage) / 100)::bigint
           - COALESCE(round(sum(c.commission_amount) FILTER (WHERE c.id <> ALL (v_ids)) * 100), 0)::bigint
      INTO v_pool
      FROM commissions c
     WHERE c.order_id = p_order_id AND c.deleted_at IS NULL AND c.status <> 'cancelled';

    SELECT CASE
             -- Already right: the rows add up to their share and each is its rounded share but at most one (the
             -- writers' last-row penny, _insert_commissions_for_order). Exact, no tolerance (Sol MED 11), so a sale
             -- with no discount keeps its minted rows and writes no history.
             WHEN sum(r.cur * 100) = v_pool
                  AND count(*) FILTER (WHERE r.cur IS DISTINCT FROM public.compute_commission_amount(v_base, r.pct)) <= 1
               THEN array_agg(r.cur ORDER BY r.id)
             -- Otherwise exact to the cent by largest remainder (as _close_undelivered_order_remainder_20260718)...
             WHEN v_pool - sum(floor(r.raw)) BETWEEN 0 AND count(*)
               THEN array_agg((floor(r.raw) + CASE WHEN r.remainder_rank <= v_pool - r.floored THEN 1 ELSE 0 END) / 100.0
                              ORDER BY r.id)
             -- ...unless paid rows sit on an older base: then each pending row is its own share (the edit paths' rule).
             ELSE array_agg(public.compute_commission_amount(v_base, r.pct) ORDER BY r.id)
           END
      INTO v_new
      FROM (SELECT u.id, u.pct, u.cur, u.raw,
                   row_number() OVER (ORDER BY u.raw - floor(u.raw) DESC, u.id) AS remainder_rank,
                   sum(floor(u.raw)) OVER () AS floored
              FROM (SELECT x.id, x.pct, x.cur, v_base_cents * x.pct / 100 AS raw
                      FROM unnest(v_ids, v_pcts, v_cur) AS x(id, pct, cur)) u) r;

    SELECT array_agg(c.id ORDER BY c.id) INTO v_moving
      FROM commissions c JOIN unnest(v_ids, v_new) AS r(id, amount) ON r.id = c.id
     WHERE c.order_profit IS DISTINCT FROM v_base OR c.commission_amount IS DISTINCT FROM r.amount;
    IF v_moving IS NULL THEN
      RETURN 0;
    END IF;
    EXIT WHEN v_moving <@ v_locked;
    -- Lock only the rows to move (Sol MED 12), then decide again on what has committed by then: a row a payout took
    -- meanwhile drops out, and only rows locked here are written (Sol HIGH 5).
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
REVOKE ALL ON FUNCTION public._recompute_order_commissions_20270304(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 3. When: every change that can move a sale's base or its rows marks the sale at once; at commit, after the discount
-- line itself is settled, each marked sale is recomputed once (Sol MED 13: a 150-line invoice deleted is one recompute,
-- not 150). Marks live in a transaction-local setting, so nothing is stored.
CREATE FUNCTION public._commission_mark_sale_20270304()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_orders uuid[];
  v_invoices uuid[];
  v_marks text := COALESCE(current_setting('crx.commission_sales_20270304', true), '');
  v_order uuid;
BEGIN
  IF TG_TABLE_NAME = 'commissions' THEN
    -- The row's sale, before and after (a row moved leaves its old sale's set changed too).
    IF TG_OP <> 'DELETE' THEN v_orders := ARRAY[NEW.order_id]; END IF;
    IF TG_OP <> 'INSERT' THEN v_orders := v_orders || OLD.order_id; END IF;
  ELSIF TG_TABLE_NAME = 'invoice_items' THEN
    -- A product line's sale, before and after (a relink changes both; Sol HIGH 3); for a discount line, every sale
    -- its invoice bills.
    IF TG_OP <> 'DELETE' THEN
      v_orders := ARRAY(SELECT order_id FROM order_items WHERE id = NEW.order_item_id);
      IF NEW.charge_type IS NOT DISTINCT FROM 'standing_discount' THEN v_invoices := ARRAY[NEW.invoice_id]; END IF;
    END IF;
    IF TG_OP <> 'INSERT' THEN
      v_orders := v_orders || ARRAY(SELECT order_id FROM order_items WHERE id = OLD.order_item_id);
      IF OLD.charge_type IS NOT DISTINCT FROM 'standing_discount' THEN v_invoices := v_invoices || OLD.invoice_id; END IF;
    END IF;
  ELSE
    -- An invoice voided, deleted, moved or retyped: its sale before and after, and every sale its lines bill.
    IF TG_OP <> 'DELETE' THEN v_orders := ARRAY[NEW.order_id]; v_invoices := ARRAY[NEW.id]; END IF;
    v_orders := v_orders || OLD.order_id;
    v_invoices := v_invoices || OLD.id;
  END IF;
  IF v_invoices IS NOT NULL THEN
    v_orders := v_orders
      || ARRAY(SELECT order_id FROM invoices WHERE id = ANY (v_invoices))
      || ARRAY(SELECT oi.order_id FROM invoice_items b JOIN order_items oi ON oi.id = b.order_item_id
                WHERE b.invoice_id = ANY (v_invoices));
  END IF;
  FOR v_order IN SELECT DISTINCT o FROM unnest(v_orders) AS o WHERE o IS NOT NULL LOOP
    IF position(v_order::text IN v_marks) = 0 THEN
      v_marks := v_marks || v_order::text || ',';
    END IF;
  END LOOP;
  PERFORM set_config('crx.commission_sales_20270304', v_marks, true);
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public._commission_mark_sale_20270304() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._commission_after_discount_20270304()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_marks text := COALESCE(current_setting('crx.commission_sales_20270304', true), '');
  v_order uuid;
BEGIN
  -- Every change queues one of these after its mark, so the last one queued after any mark still finds it. The marks
  -- are taken before recomputing; the recompute's own writes mark the sale again and settle on a pass that writes
  -- nothing. Sales in id order, so two commits lock them in the same order.
  IF v_marks = '' THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('crx.commission_sales_20270304', '', true);
  FOR v_order IN SELECT DISTINCT m::uuid FROM unnest(string_to_array(v_marks, ',')) AS m WHERE m <> '' ORDER BY 1 LOOP
    PERFORM public._recompute_order_commissions_20270304(v_order);
  END LOOP;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public._commission_after_discount_20270304() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER invoice_items_commission_mark_20270304
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._commission_mark_sale_20270304();
CREATE TRIGGER invoices_commission_mark_20270304
  AFTER UPDATE OF status, deleted_at, invoice_type, order_id OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._commission_mark_sale_20270304();
CREATE TRIGGER commissions_mark_20270304
  AFTER INSERT OR UPDATE OF commission_amount, order_profit, status, deleted_at, split_percentage, order_id OR DELETE
  ON public.commissions
  FOR EACH ROW EXECUTE FUNCTION public._commission_mark_sale_20270304();
CREATE CONSTRAINT TRIGGER invoice_items_commission_after_discount_20270304
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._commission_after_discount_20270304();
CREATE CONSTRAINT TRIGGER invoices_commission_after_discount_20270304
  AFTER UPDATE OF status, deleted_at, invoice_type, order_id OR DELETE ON public.invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._commission_after_discount_20270304();
CREATE CONSTRAINT TRIGGER commissions_after_discount_20270304
  AFTER INSERT OR UPDATE OF commission_amount, order_profit, status, deleted_at, split_percentage, order_id OR DELETE
  ON public.commissions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._commission_after_discount_20270304();

-- 4. Sales that already carry a discount line (none on live while the M4 switch is off) -------------------------
DO $existing$
DECLARE
  v_order uuid;
  v_moved int := 0;
BEGIN
  FOR v_order IN
    SELECT DISTINCT o.order_id FROM (
      SELECT i.order_id FROM invoices i
        JOIN invoice_items d ON d.invoice_id = i.id AND d.charge_type = 'standing_discount'
       WHERE i.order_id IS NOT NULL
      UNION
      SELECT oi.order_id FROM invoice_items d
        JOIN invoice_items b ON b.invoice_id = d.invoice_id
        JOIN order_items oi ON oi.id = b.order_item_id
       WHERE d.charge_type = 'standing_discount'
    ) o
     ORDER BY 1
  LOOP
    v_moved := v_moved + public._recompute_order_commissions_20270304(v_order);
  END LOOP;
  RAISE NOTICE 'COMMISSION_AFTER_DISCOUNT: % pending commission row(s) moved onto the profit after discount', v_moved;
END
$existing$;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
        'invoice_items_commission_after_discount_20270304', 'invoices_commission_after_discount_20270304',
        'commissions_after_discount_20270304')
        AND tgdeferrable AND tginitdeferred) <> 3
     OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
        'invoice_items_commission_mark_20270304', 'invoices_commission_mark_20270304', 'commissions_mark_20270304')
        AND NOT tgdeferrable) <> 3
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._commission_mark_sale_20270304()'::regprocedure)
          IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._recompute_order_commissions_20270304(uuid)'::regprocedure)
          IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._commission_after_discount_20270304()'::regprocedure)
          IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._order_commission_base_20270304(uuid)'::regprocedure)
          IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[] THEN
    RAISE EXCEPTION 'COMMISSION_AFTER_DISCOUNT_POSTFLIGHT: a trigger or grant is not as written';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$postflight$;
