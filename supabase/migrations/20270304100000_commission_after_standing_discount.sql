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
--      every payer of a Bill Split counted. The same figure the dashboard and the sale page already show.
--   2. _recompute_order_commissions_20270304(sale): puts the sale's pending rows that are in no live payout batch on
--      that base. When those rows are the sale's whole live set, they add up to the base exactly (largest remainder,
--      as Cancel Remaining splits); otherwise each pending row is its own share (compute_commission_amount), the
--      edit paths' rule. Paid or batched rows never move. It writes nothing when the rows already sit on the base, so
--      a sale with no discount is exactly as before (no extra commission history).
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
-- ROLLBACK (its own reviewed migration): drop the four triggers, _commission_after_discount_20270304(),
--   _recompute_order_commissions_20270304(uuid) and _order_commission_base_20270304(uuid). Amounts already moved stay
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
     OR to_regprocedure('public._commission_after_discount_20270304()') IS NOT NULL THEN
    RAISE EXCEPTION 'COMMISSION_AFTER_DISCOUNT_PREFLIGHT: already applied';
  END IF;
  IF to_regprocedure('public._order_standing_discount_20270109(uuid)') IS NULL
     OR to_regprocedure('public.compute_commission_amount(numeric,numeric)') IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_AFTER_DISCOUNT_PREFLIGHT: 20270117130000_standing_discount_in_order_profit is not applied';
  END IF;
END
$preflight$;

-- 1. The base ---------------------------------------------------------------------------------------------------
CREATE FUNCTION public._order_commission_base_20270304(p_order_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The sale's profit after its standing discount (0 or negative dollars); never sales tax.
  SELECT round(COALESCE(o.total_profit, 0) + public._order_standing_discount_20270109(o.id), 2)
    FROM public.orders o
   WHERE o.id = p_order_id;
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
  v_live int;
  v_eligible int;
  v_split_total numeric;
  v_ids uuid[];
  v_pcts numeric[];
  v_count int := 0;
BEGIN
  IF p_order_id IS NULL THEN
    RETURN 0;
  END IF;
  -- Hold the sale's rows first (a payout batching them waits, or is waited on), then read who may move.
  PERFORM 1 FROM commissions WHERE order_id = p_order_id AND deleted_at IS NULL ORDER BY id FOR UPDATE;

  SELECT array_agg(c.id ORDER BY c.id), array_agg(c.split_percentage ORDER BY c.id), count(*), sum(c.split_percentage)
    INTO v_ids, v_pcts, v_eligible, v_split_total
    FROM commissions c
   WHERE c.order_id = p_order_id AND c.deleted_at IS NULL AND c.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM commission_payment_items cpi
                       JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
                      WHERE cpi.commission_id = c.id AND cp.status <> 'voided');
  IF v_eligible = 0 THEN
    RETURN 0;
  END IF;

  v_base := public._order_commission_base_20270304(p_order_id);
  -- Already on this base (every sale with no discount, and every quiet re-save): write nothing.
  IF NOT EXISTS (SELECT 1 FROM commissions c WHERE c.id = ANY (v_ids) AND c.order_profit IS DISTINCT FROM v_base) THEN
    RETURN 0;
  END IF;

  SELECT count(*) INTO v_live FROM commissions
   WHERE order_id = p_order_id AND deleted_at IS NULL AND status <> 'cancelled';

  IF v_live = v_eligible AND v_split_total > 0 THEN
    -- The whole live set: exact to the cent (largest remainder, as _close_undelivered_order_remainder_20260718).
    v_base_cents := round(GREATEST(v_base, 0) * 100)::bigint;
    WITH raw AS (
      SELECT r.id, v_base_cents::numeric * r.pct / v_split_total AS raw_cents
        FROM unnest(v_ids, v_pcts) AS r(id, pct)
    ), ranked AS (
      SELECT raw.id, floor(raw.raw_cents)::bigint AS base_cents,
             row_number() OVER (ORDER BY raw.raw_cents - floor(raw.raw_cents) DESC, raw.id) AS remainder_rank,
             sum(floor(raw.raw_cents)::bigint) OVER () AS allocated
        FROM raw
    ), calc AS (
      SELECT id, base_cents + CASE WHEN remainder_rank <= v_base_cents - allocated THEN 1 ELSE 0 END AS cents
        FROM ranked
    )
    UPDATE commissions c
       SET order_profit = v_base, commission_amount = calc.cents / 100.0
      FROM calc
     WHERE c.id = calc.id;
  ELSE
    -- Some rows are paid or batched: each pending row is its own share (the edit paths' rule).
    UPDATE commissions c
       SET order_profit = v_base, commission_amount = public.compute_commission_amount(v_base, r.pct)
      FROM unnest(v_ids, v_pcts) AS r(id, pct)
     WHERE c.id = r.id;
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$function$;
REVOKE ALL ON FUNCTION public._recompute_order_commissions_20270304(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 3. When: at commit, after the discount line itself is settled ------------------------------------------------
CREATE FUNCTION public._commission_after_discount_20270304()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order uuid;
  v_invoices uuid[];
BEGIN
  IF TG_TABLE_NAME = 'commissions' THEN
    IF NEW.order_id IS NOT NULL AND NEW.status = 'pending' AND NEW.deleted_at IS NULL THEN
      PERFORM public._recompute_order_commissions_20270304(NEW.order_id);
    END IF;
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'invoice_items' THEN
    -- Only a discount line (any change to a draft's product lines re-settles its discount line, which lands here).
    IF TG_OP <> 'DELETE' AND NEW.charge_type IS NOT DISTINCT FROM 'standing_discount' THEN
      v_invoices := array_append(v_invoices, NEW.invoice_id);
    END IF;
    IF TG_OP <> 'INSERT' AND OLD.charge_type IS NOT DISTINCT FROM 'standing_discount' THEN
      v_invoices := array_append(v_invoices, OLD.invoice_id);
    END IF;
    IF v_invoices IS NULL THEN
      RETURN NULL;
    END IF;
  ELSE
    -- invoices: one carrying a discount line that was voided, deleted, moved or retyped (OLD kept for a delete).
    IF TG_OP = 'DELETE' THEN
      IF OLD.order_id IS NOT NULL THEN
        PERFORM public._recompute_order_commissions_20270304(OLD.order_id);
      END IF;
      RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = NEW.id AND charge_type = 'standing_discount') THEN
      RETURN NULL;
    END IF;
    v_invoices := ARRAY[NEW.id];
    IF OLD.order_id IS DISTINCT FROM NEW.order_id AND OLD.order_id IS NOT NULL THEN
      PERFORM public._recompute_order_commissions_20270304(OLD.order_id);
    END IF;
  END IF;

  -- Every sale those invoices bill: the invoice's own sale and the sales of its product lines.
  FOR v_order IN
    SELECT i.order_id FROM invoices i WHERE i.id = ANY (v_invoices) AND i.order_id IS NOT NULL
    UNION
    SELECT oi.order_id FROM invoice_items b JOIN order_items oi ON oi.id = b.order_item_id
     WHERE b.invoice_id = ANY (v_invoices)
  LOOP
    PERFORM public._recompute_order_commissions_20270304(v_order);
  END LOOP;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public._commission_after_discount_20270304() FROM PUBLIC, anon, authenticated, service_role;

-- ponytail: row-level, so a sale is recomputed once per changed row; each pass after the first writes nothing.
CREATE CONSTRAINT TRIGGER invoice_items_commission_after_discount_20270304
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._commission_after_discount_20270304();
CREATE CONSTRAINT TRIGGER invoices_commission_after_discount_20270304
  AFTER UPDATE OF status, deleted_at, invoice_type, order_id ON public.invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._commission_after_discount_20270304();
CREATE CONSTRAINT TRIGGER invoices_delete_commission_after_discount_20270304
  AFTER DELETE ON public.invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._commission_after_discount_20270304();
CREATE CONSTRAINT TRIGGER commissions_after_discount_20270304
  AFTER INSERT OR UPDATE OF commission_amount, order_profit, status, deleted_at ON public.commissions
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
        'invoices_delete_commission_after_discount_20270304', 'commissions_after_discount_20270304')
        AND tgdeferrable AND tginitdeferred) <> 4
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
