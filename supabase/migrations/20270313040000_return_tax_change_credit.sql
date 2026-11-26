-- Written 2026-11-25. STATUS: NOT APPLIED (staging candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270313040000_return_tax_change_credit.md.
-- Re-read the live ledger before applying.
--
-- WHY: a release #1990 follow-up (fix before the next release; Mason 20 Nov, Taha agreed):
--   #2066: a return made at the order price (no tax or discount line on the sale's live invoices yet) switches to
--     billed-share pricing once a live invoice of the sale gains a sales-tax (or discount) line, so receiving or
--     crediting it refused with RETURN_SPLIT_SHARE_REPRICED. Mason, 22 Nov: re-price to the taxed share; the credit is
--     never more than the customer was charged on the posted invoice, tax included.
--
-- WHAT (Taha, 25 Nov: A+B; then 1 keep refusal, 2a, 3 yes; 26 Nov: q3 yes; Mason, 26 Nov: draft units wait):
--   1. return_items.priced_from ('order_price' | 'billed_share' | 'unrecorded'): how create_return priced the line,
--      so a re-price never guesses from amounts. Every line that exists when this applies is 'unrecorded' (the column
--      default; no guessing) and is never re-priced: such a return keeps today's stale refusal, for the office (live
--      has none after the 24 Nov reset). create_return (_create_return_intent_impl_20260812) sets it on every new
--      line. create_return also refuses a new share-priced line while an older return of the same customer and order
--      line, made at the order price (or unrecorded), is not yet credited (RETURN_OLDER_RETURN_AT_ORDER_PRICE; Mason
--      confirmed, 25 Nov), so a newer return never takes the older one's tax.
--   1a. _return_customer_line_share: only a POSTED invoice's sales-tax or discount line switches a line to share
--      pricing (billed_cents counts only posted invoices). A draft's tax line used to switch it early, so a return
--      received meanwhile was re-priced from the untaxed lot alone and then refused once the draft posted.
--      A re-priced line keeps priced_from 'order_price' (its origin), so it is re-priced again if more taxed lots
--      post before it is credited.
--   1b. _return_order_price_lot_price (new, not SECURITY DEFINER, no grants): an order-price line of the order's own
--      customer (no field split) on a sale with tax or a discount is priced from its share of the customer's POSTED
--      lots of the line, each after its discount and with its share of its tax, by create_return's running-total
--      rule. "Tax or a discount" is the order's sales-tax box (orders.sales_tax; Taha, 26 Nov: tax-on comes from the
--      order) or a sales-tax or discount line on a live invoice holding the line, a draft too. Returned units that are
--      still on a draft wait until it is posted (Mason, 26 Nov: "keep it simple"; RETURN_UNITS_ON_DRAFT, post the
--      draft first); units on no live invoice cannot be priced (RETURN_UNITS_NOT_INVOICED). A line from before this
--      change ('unrecorded') keeps staging's refusal while a live invoice of the line, a draft too, carries a tax or
--      discount line (Taha, 26 Nov), though share pricing now switches on posted lines only.
--   2. receive_return and issue_return_credit (_receive_return_intent_impl_20260812,
--      _issue_return_credit_intent_impl_20260812): under the per-order-line locks they already take, a line of THIS
--      return priced 'order_price' on a sale with tax or a discount (1b; the returner is the order's customer and the
--      order has no split evidence; a field split never triggers it) is re-priced to its posted-lot price (tax and
--      discount included, never beyond the posted lots; it stays 'order_price'), with one financial_audit_log row,
--      instead of refused; a line with units still on a draft, or on no invoice, is refused before anything is
--      restocked. No other
--      return changes: while another open return of that customer and order line still has a price that is not what
--      create_return would give it now, this one is refused (RETURN_REPRICE_OTHER_RETURN_PENDING) and nothing
--      changes. A 'billed_share' line that went stale (an earlier return cancelled, a split payer's blend moved) is
--      still refused (RETURN_SPLIT_SHARE_REPRICED, Mason's #1010 rule), as is anything beyond the billed share.
--      issue_return_credit re-prices before its cents cap (its pre-lock check leaves the cents bound to that cap).
--      receive_return refuses a sales rep who cannot read every posted invoice of the customer on the order before
--      re-pricing (RETURN_SPLIT_INVOICE_NOT_VISIBLE, as create_return), and refuses a re-priced line whose order line has
--      a posted sale line in another unit (RETURN_CREDIT_UNIT_MISMATCH, create_return's check), before restocking.
--   The tax ledger freeze (#2591) is not touched: a re-priced line's units are all on posted lots, so it freezes as today.
--   Applying: like every migration here, the preflight relies on the file running as one transaction with
--   ON_ERROR_STOP (the apply gate and the staging DB job do); run statement by statement it stops at the preflight.
--
-- NOT CHANGED (beyond 1a): the credit implementation _issue_return_credit_impl, the tax ledger freeze, the public wrappers,
--   every trigger, every money amount already stored. Each re-emitted body is staging's current body (pinned below)
--   plus only the hunks marked (#2066). CREATE OR REPLACE keeps each OID, owner and exact ACL; the
--   postflight proves it.
--
-- ROLLBACK (its own reviewed migration): re-emit the four bodies pinned in the preflight (20261215110000 for
--   create_return, 20261021155000 for the two return bodies, 20270109100200 for the share helper), drop
--   _return_order_price_lot_price, then drop return_items.priced_from. Credits issued meanwhile keep their amounts and
--   frozen tax.
--
-- ORDERING: after 20261215110000 (create_return), 20270109100200 (the share helper) and 20261021155000 (the return
--   bodies).

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
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'return_items' AND column_name = 'priced_from') THEN
    RAISE EXCEPTION 'RETURN_TAX_CHANGE_PREFLIGHT: already applied';
  END IF;
  IF to_regprocedure('public._return_order_price_lot_price(uuid,uuid,uuid,uuid,numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_TAX_CHANGE_PREFLIGHT: already applied';
  END IF;
  -- The three SECURITY DEFINER functions re-emitted below, exactly as staging has them.
  SELECT string_agg(f.name, ', ') INTO v_bad
    FROM (VALUES
      ('public._create_return_intent_impl_20260812(jsonb,jsonb,text)', 'dd95a7decaea1130352bc03e31f23ccf', 2),
      ('public._receive_return_intent_impl_20260812(uuid,uuid,text)', '67566a09967e74b1ee813354038955b0', 1),
      ('public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)', '0d5209ab7179f36d71f548b55a6cf77d', 1)
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
  -- The share helper (not SECURITY DEFINER), exactly as 20270109100200 left it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._return_customer_line_share(uuid,uuid,uuid,uuid)')
       AND md5(replace(p.prosrc, chr(13), '')) = '8e799519fa332cb51465f51b5c3585e7'
       AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef AND p.provolatile = 's'
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]
  ) THEN
    RAISE EXCEPTION 'RETURN_TAX_CHANGE_PREFLIGHT: drifted from staging: public._return_customer_line_share';
  END IF;
END
$preflight$;

-- 1. (#2066) How each return line was priced ---------------------------------------------------------------------------
ALTER TABLE public.return_items ADD COLUMN priced_from text NOT NULL DEFAULT 'unrecorded'
  CONSTRAINT return_items_priced_from_check CHECK (priced_from IN ('order_price', 'billed_share', 'unrecorded'));
COMMENT ON COLUMN public.return_items.priced_from IS
  'How create_return priced this line: order_price (the order line''s price) or billed_share (the returner''s billed share, tax and discount included). A re-price at receive or credit (20270313040000) keeps order_price: it records how the line was first priced. unrecorded: the line existed before this column, or was written by something other than create_return; never re-priced.';

-- 2. (#2066) create_return records how it priced each line, and refuses a newer line over an older order-price one ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._create_return_intent_impl_20260812(p_return jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_return_id uuid;
  v_return_number text;
  v_order_id uuid;
  v_customer_id uuid;
  v_order_status text;
  v_item jsonb;
  v_order_item record;
  v_qty numeric;
  v_prior_qty numeric;
  v_count integer := 0;
  v_existing jsonb;
  -- Phase 3 addition: sorted advisory locks cover all products in this request.
  v_product_ids uuid[];
  -- Split-payer return (20261021155000): see the order check and the per-line share below.
  v_order_customer_id uuid;
  v_share record;
  v_extended bigint;
  v_unit_price bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'create_return');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_customer_id := nullif(p_return->>'customer_id', '')::uuid;
  v_order_id := nullif(p_return->>'order_id', '')::uuid;
  IF v_customer_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_REQUIRED'; END IF;
  IF v_order_id IS NULL THEN RAISE EXCEPTION 'RETURN_ORDER_REQUIRED'; END IF;
  IF coalesce(btrim(p_return->>'reason'), '') = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  IF jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'ITEMS_REQUIRED'; END IF;

  -- Split-payer return (20261021155000): the order's customer, or a customer a posted governed
  -- split invoice of this order bills (a field owner such as a landlord), may return its goods.
  SELECT status, customer_id INTO v_order_status, v_order_customer_id FROM public.orders
  WHERE id = v_order_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR (
    v_order_customer_id IS DISTINCT FROM v_customer_id
    AND NOT public._return_customer_is_split_payer(v_order_id, v_customer_id)
  ) THEN RAISE EXCEPTION 'RETURN_ORDER_CUSTOMER_MISMATCH'; END IF;
  IF v_order_status IN ('voided', 'cancelled') THEN
    RAISE EXCEPTION 'RETURN_SOURCE_ORDER_INACTIVE';
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) item WHERE nullif(item->>'order_item_id', '') IS NULL) THEN
    RAISE EXCEPTION 'RETURN_ORDER_ITEM_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
     (SELECT count(DISTINCT item->>'order_item_id') FROM jsonb_array_elements(p_items) item) THEN
    RAISE EXCEPTION 'DUPLICATE_RETURN_ORDER_ITEM';
  END IF;

  PERFORM 1
  FROM public.order_items oi
  JOIN jsonb_array_elements(p_items) item
    ON oi.id = (item->>'order_item_id')::uuid
  WHERE oi.order_id = v_order_id
  ORDER BY oi.id
  FOR UPDATE OF oi;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
     (SELECT count(*) FROM public.order_items oi
      JOIN jsonb_array_elements(p_items) item ON oi.id = (item->>'order_item_id')::uuid
      WHERE oi.order_id = v_order_id) THEN
    RAISE EXCEPTION 'RETURN_ORDER_ITEM_MISMATCH';
  END IF;

  -- Phase 3 addition: UUID-order locks and a policy re-read happen after all
  -- source order-item locks/validation and before creating any return rows.
  SELECT array_agg(DISTINCT oi.product_id ORDER BY oi.product_id)
    INTO v_product_ids
  FROM public.order_items oi
  JOIN jsonb_array_elements(p_items) item
    ON oi.id = (item->>'order_item_id')::uuid
  WHERE oi.order_id = v_order_id;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  PERFORM public.assert_phase3_return_policy(v_product_ids);

  v_return_number := public.next_return_number();
  INSERT INTO public.returns (
    return_number, customer_id, order_id, reason, reason_notes, notes, requested_by, status
  ) VALUES (
    v_return_number, v_customer_id, v_order_id, p_return->>'reason',
    p_return->>'reason_notes', p_return->>'notes', v_actor, 'requested'
  ) RETURNING id INTO v_return_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_order_item
    FROM public.order_items
    WHERE id = (v_item->>'order_item_id')::uuid AND order_id = v_order_id;

    v_qty := coalesce((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'RETURN_QUANTITY_MUST_BE_POSITIVE'; END IF;
    -- A return holds 2 decimal places (return_items.quantity numeric(10,2)). A finer quantity, such as a Bill
    -- Split payer's 4-place share or a plain 2.125 line, would be stored rounded but priced in full, then refused at
    -- receive and left stuck; refuse it here in plain words (billing plan M2, 2026-11-09). After the wrapper's
    -- replay, so a retry of an earlier accepted request still answers as before.
    IF v_qty <> round(v_qty, 2) THEN
      RAISE EXCEPTION 'RETURN_QUANTITY_TOO_FINE: a return holds 2 decimal places; return a quantity like 0.70'
        USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(v_order_item.quantity_delivered, 0) <= 0 THEN
      RAISE EXCEPTION 'RETURN_SOURCE_NOT_DELIVERED';
    END IF;
    IF v_order_item.price_per_unit IS NULL THEN
      RAISE EXCEPTION 'RETURN_SOURCE_PRICE_MISSING';
    END IF;

    SELECT coalesce(sum(ri.quantity), 0) INTO v_prior_qty
    FROM public.return_items ri
    JOIN public.returns r ON r.id = ri.return_id
    WHERE ri.order_item_id = v_order_item.id
      AND r.deleted_at IS NULL
      AND r.status NOT IN ('rejected', 'cancelled');

    IF v_prior_qty + v_qty > v_order_item.quantity_delivered THEN
      RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS_DELIVERED';
    END IF;

    -- Split-payer return (20261021155000): on a split order, or when the returner is not the
    -- order's customer, the returner may return only what it was billed, and its credit is what is
    -- left of its own billed cents for that quantity, so its full share credits exactly.
    SELECT * INTO v_share
      FROM public._return_customer_line_share(v_order_id, v_order_item.id, v_customer_id, v_return_id);
    IF v_share.share_mode THEN
      -- A share-mode return stores a price derived from the returner's own invoices on this order,
      -- so a non-admin may create one only when invoices_select lets it read every active invoice
      -- billing the returner here (it created it or is its salesperson), as the Returns lookups do.
      IF NOT public.is_admin() AND EXISTS (
        SELECT 1 FROM public.invoices hidden
         WHERE hidden.order_id = v_order_id
           AND hidden.customer_id = v_customer_id
           AND hidden.invoice_type <> 'credit_memo'
           AND hidden.deleted_at IS NULL
           AND hidden.status IN ('posted', 'overdue', 'paid')
           AND NOT (hidden.created_by IS NOT DISTINCT FROM auth.uid()
                    OR hidden.salesman_id IS NOT DISTINCT FROM auth.uid())
      ) THEN RAISE EXCEPTION 'RETURN_SPLIT_INVOICE_NOT_VISIBLE'; END IF;
      -- A posted sale line of this order line whose unit differs from the return's (an order line
      -- with no unit is returned as 'ea', and its invoice lines carry no unit) can never back the
      -- credit: _issue_return_credit_impl refuses every such return with this same code. Refuse it
      -- here, before anything is restocked, rather than as "not billed".
      IF EXISTS (
        SELECT 1
          FROM public.invoice_items ii
          JOIN public.invoices i ON i.id = ii.invoice_id
         WHERE ii.order_item_id = v_order_item.id
           AND ii.product_id = v_order_item.product_id
           AND ii.quantity > 0
           AND i.invoice_type <> 'credit_memo'
           AND i.status IN ('posted', 'overdue', 'paid')
           AND i.deleted_at IS NULL
           AND ii.unit_size IS DISTINCT FROM coalesce(v_order_item.unit_size, 'ea')
      ) THEN RAISE EXCEPTION 'RETURN_CREDIT_UNIT_MISMATCH'; END IF;
      IF v_share.billed_qty <= 0 THEN RAISE EXCEPTION 'RETURN_SPLIT_SHARE_NOT_BILLED'; END IF;
      -- (#2066) An older return of this line made at the order price, not yet credited, is re-priced to its taxed
      -- share when it is received or credited; a newer one priced now would take its tax. Refuse until that one is
      -- credited or cancelled (Taha, 25 Nov: 2a; to confirm with Mason).
      IF EXISTS (
        SELECT 1 FROM public.return_items ori JOIN public.returns orr ON orr.id = ori.return_id
         WHERE ori.order_item_id = v_order_item.id AND orr.id <> v_return_id
           AND orr.order_id = v_order_id AND orr.customer_id = v_customer_id
           AND orr.deleted_at IS NULL AND orr.status IN ('requested', 'approved', 'received')
           AND orr.credit_invoice_id IS NULL AND ori.priced_from IN ('order_price', 'unrecorded')
      ) AND v_customer_id = v_order_customer_id
         AND NOT EXISTS (SELECT 1 FROM public.orders so WHERE so.id = v_order_id AND COALESCE(so.needs_split_billing, false))
         AND NOT EXISTS (SELECT 1 FROM public.order_item_field_allocations oifa
                           JOIN public.order_items alloc_oi ON alloc_oi.id = oifa.order_item_id
                          WHERE alloc_oi.order_id = v_order_id)
         AND NOT EXISTS (SELECT 1 FROM public.split_invoice_provenance sp WHERE sp.order_id = v_order_id) THEN
        RAISE EXCEPTION 'RETURN_OLDER_RETURN_AT_ORDER_PRICE: an older return of this product for this customer was priced before the sale''s tax or discount and is not credited yet; credit or cancel it first';
      END IF;
      IF v_share.other_returned_qty + v_qty > v_share.billed_qty THEN
        RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS_BILLED_SHARE';
      END IF;
      v_extended := greatest(0,
        round(v_share.billed_cents * (v_share.other_returned_qty + v_qty) / v_share.billed_qty)::bigint
        - v_share.other_returned_cents);
      IF v_share.other_returned_cents + v_extended > v_share.billed_cents THEN
        RAISE EXCEPTION 'RETURN_CREDIT_EXCEEDS_BILLED_SHARE';
      END IF;
      -- The unit price the return and its credit memo show is the returner's own billed rate, not
      -- the order price (a split invoice may bill a share at another rate).
      v_unit_price := round(v_share.billed_cents / v_share.billed_qty)::bigint;
    ELSE
      v_extended := round(v_qty * v_order_item.price_per_unit * 100)::bigint;
      v_unit_price := round(v_order_item.price_per_unit * 100)::bigint;
    END IF;

    INSERT INTO public.return_items (
      return_id, order_item_id, product_id, product_name, quantity, unit,
      unit_price_cents, extended_cents, condition, restock, sort_order, notes, priced_from
    ) VALUES (
      v_return_id, v_order_item.id, v_order_item.product_id, v_order_item.product_name,
      v_qty, coalesce(v_order_item.unit_size, 'ea'),
      v_unit_price,  -- Split-payer return (20261021155000): priced above
      v_extended,
      coalesce(v_item->>'condition', 'unopened'),
      coalesce((v_item->>'restock')::boolean, false),
      coalesce((v_item->>'sort_order')::integer, v_count), v_item->>'notes',
      -- (#2066) how this line was priced, so a later re-price never has to guess
      CASE WHEN v_share.share_mode THEN 'billed_share' ELSE 'order_price' END
    );
    v_count := v_count + 1;
  END LOOP;

  INSERT INTO public.activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'return_requested', 'Return ' || v_return_number || ' requested for ' || v_count || ' product(s)',
    v_actor, 'return', v_return_id, v_customer_id
  );

  v_existing := jsonb_build_object(
    'success', true, 'return_id', v_return_id,
    'return_number', v_return_number, 'item_count', v_count
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'create_return', v_existing);
  END IF;
  RETURN v_existing;
END;
$function$;

-- 2a. (#2066) the share helper: only a posted tax or discount line switches a line to share pricing ----------------
CREATE OR REPLACE FUNCTION public._return_customer_line_share(p_order_id uuid, p_order_item_id uuid, p_customer_id uuid, p_exclude_return_id uuid)
 RETURNS TABLE(share_mode boolean, billed_qty numeric, billed_cents bigint, other_returned_qty numeric, other_returned_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ord AS (
    SELECT o.customer_id,
           COALESCE(o.needs_split_billing, false)
             OR EXISTS (
               SELECT 1 FROM public.order_item_field_allocations oifa
                 JOIN public.order_items alloc_oi ON alloc_oi.id = oifa.order_item_id
                WHERE alloc_oi.order_id = o.id
             )
             OR EXISTS (SELECT 1 FROM public.split_invoice_provenance p WHERE p.order_id = o.id)
             AS split_evidence
      FROM public.orders o WHERE o.id = p_order_id
  ), billed AS (
    -- after the invoice's discount, with its share of the invoice's tax
    SELECT i.id AS invoice_id, i.customer_id, i.invoice_group_id, ii.quantity,
           public._standing_discount_net_cents_20261231(ii.id) AS extended_cents
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
      JOIN public.order_items oi ON oi.id = ii.order_item_id
     WHERE ii.order_item_id = p_order_item_id
       AND ii.product_id = oi.product_id
       AND ii.unit_size IS NOT DISTINCT FROM coalesce(oi.unit_size, 'ea')
       AND ii.quantity > 0
       AND i.order_id = p_order_id
       AND i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL
       AND i.status IN ('posted', 'overdue', 'paid')
  ), own AS (
    SELECT b.quantity, b.extended_cents
      FROM billed b
     WHERE b.customer_id = p_customer_id
       AND (
         p_customer_id IS NOT DISTINCT FROM (SELECT customer_id FROM ord)
         OR EXISTS (
           SELECT 1 FROM public.split_invoice_provenance p
            WHERE p.invoice_id = b.invoice_id
              AND p.order_id = p_order_id
              AND p.customer_id = p_customer_id
              AND p.invoice_group_id = b.invoice_group_id
         )
       )
  ), other_returns AS (
    SELECT ri.quantity, ri.extended_cents
      FROM public.return_items ri
      JOIN public.returns r ON r.id = ri.return_id
     WHERE ri.order_item_id = p_order_item_id
       AND r.order_id = p_order_id
       AND r.customer_id = p_customer_id
       AND r.deleted_at IS NULL
       AND r.status NOT IN ('rejected', 'cancelled')
       AND r.id IS DISTINCT FROM p_exclude_return_id
  )
  SELECT
    p_customer_id IS DISTINCT FROM (SELECT customer_id FROM ord)
      OR COALESCE((SELECT split_evidence FROM ord), false)
      -- this line is on one of the customer's POSTED invoices with a discount or (tax) a tax line ((#2066) posted
      -- only, since billed_cents counts only posted invoices: a draft's tax or discount line no longer switches the
      -- line to share pricing before it is billed; a return made meanwhile is priced at the order price and re-priced
      -- at receive or credit once that invoice posts)
      OR EXISTS (
        SELECT 1 FROM public.invoice_items di
          JOIN public.invoices i ON i.id = di.invoice_id
         WHERE di.order_item_id = p_order_item_id
           AND i.order_id = p_order_id
           AND i.customer_id = p_customer_id
           AND i.invoice_type <> 'credit_memo'
           AND i.deleted_at IS NULL
           AND i.status IN ('posted', 'overdue', 'paid')  -- (#2066)
           AND EXISTS (SELECT 1 FROM public.invoice_items dl
                        WHERE dl.invoice_id = i.id AND dl.charge_type IN ('standing_discount', 'sales_tax'))),
    coalesce((SELECT sum(quantity) FROM own), 0),
    coalesce((SELECT sum(extended_cents) FROM own), 0)::bigint,
    coalesce((SELECT sum(quantity) FROM other_returns), 0),
    coalesce((SELECT sum(extended_cents) FROM other_returns), 0)::bigint;
$function$;

-- 2b. (#2066) the price of an order-price line on a sale with tax or a discount: its share of the customer's POSTED lots
-- applies: the returner is the order's customer, the order has no field split, and the sale has tax or a discount: the
--   order's sales-tax box is ticked (Taha, 26 Nov: tax-on comes from the order), or a live invoice of the customer on
--   this order holding the line carries a sales-tax or discount line (posted or draft). Otherwise the line keeps the
--   order price, as before.
-- fits: the returned units, with this customer's other open returns of the line, are all on its posted invoices and
--   within their cents.
-- on_draft: it does not fit, but would once the customer's drafts of the line post (Mason, 26 Nov: such a return
--   waits until the draft is posted).
-- unit_price_cents / extended_cents: exactly as create_return prices a billed share (the running total over the posted
--   lots, after each invoice's discount and with its share of its tax).
-- adjusted: only the invoice evidence (a sales-tax or discount line on a live invoice holding the line), the rule
--   staging used to switch a line to share pricing; it keeps a line from before this change refused (see receive).
CREATE FUNCTION public._return_order_price_lot_price(p_order_id uuid, p_order_item_id uuid, p_customer_id uuid, p_exclude_return_id uuid, p_quantity numeric)
 RETURNS TABLE(applies boolean, fits boolean, unit_price_cents bigint, extended_cents bigint, adjusted boolean, on_draft boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ord AS (
    SELECT o.customer_id, o.sales_tax,
           COALESCE(o.needs_split_billing, false)
             OR EXISTS (
               SELECT 1 FROM public.order_item_field_allocations oifa
                 JOIN public.order_items alloc_oi ON alloc_oi.id = oifa.order_item_id
                WHERE alloc_oi.order_id = o.id
             )
             OR EXISTS (SELECT 1 FROM public.split_invoice_provenance p WHERE p.order_id = o.id)
             AS split_evidence
      FROM public.orders o WHERE o.id = p_order_id
  ), live AS (
    -- the customer's live sale invoices of this order that hold this order line: posted lots and drafts
    SELECT i.id, i.status IN ('posted', 'overdue', 'paid') AS posted
      FROM public.invoices i
     WHERE i.order_id = p_order_id
       AND i.customer_id = p_customer_id
       AND i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL
       AND i.status IN ('draft', 'unposted', 'posted', 'overdue', 'paid')
       AND EXISTS (SELECT 1 FROM public.invoice_items x WHERE x.invoice_id = i.id AND x.order_item_id = p_order_item_id)
  ), lots AS (
    -- after the invoice's discount, with its share of the invoice's tax (as _return_customer_line_share bills)
    SELECT live.posted, ii.quantity, public._standing_discount_net_cents_20261231(ii.id) AS cents
      FROM live
      JOIN public.invoice_items ii ON ii.invoice_id = live.id
      JOIN public.order_items oi ON oi.id = ii.order_item_id
     WHERE ii.order_item_id = p_order_item_id
       AND ii.product_id = oi.product_id
       AND ii.unit_size IS NOT DISTINCT FROM coalesce(oi.unit_size, 'ea')
       AND ii.quantity > 0
  ), other_returns AS (
    SELECT ri.quantity, ri.extended_cents
      FROM public.return_items ri
      JOIN public.returns r ON r.id = ri.return_id
     WHERE ri.order_item_id = p_order_item_id
       AND r.order_id = p_order_id
       AND r.customer_id = p_customer_id
       AND r.deleted_at IS NULL
       AND r.status NOT IN ('rejected', 'cancelled')
       AND r.id IS DISTINCT FROM p_exclude_return_id
  ), t AS (
    SELECT coalesce((SELECT sum(quantity) FROM lots WHERE posted), 0) AS lot_qty,
           coalesce((SELECT sum(cents) FROM lots WHERE posted), 0)::bigint AS lot_cents,
           coalesce((SELECT sum(quantity) FROM lots WHERE NOT posted), 0) AS draft_qty,
           coalesce((SELECT sum(quantity) FROM other_returns), 0) AS other_qty,
           coalesce((SELECT sum(extended_cents) FROM other_returns), 0)::bigint AS other_cents
  ), adj AS (
    SELECT EXISTS (SELECT 1 FROM live JOIN public.invoice_items dl ON dl.invoice_id = live.id
                    WHERE dl.charge_type IN ('standing_discount', 'sales_tax')) AS adjusted
  ), priced AS (
    SELECT t.*,
           CASE WHEN t.lot_qty > 0 THEN round(t.lot_cents / t.lot_qty)::bigint END AS unit_price_cents,
           CASE WHEN t.lot_qty > 0 THEN greatest(0,
             round(t.lot_cents * (t.other_qty + p_quantity) / t.lot_qty)::bigint - t.other_cents) END AS extended_cents
      FROM t
  )
  SELECT
    COALESCE((SELECT customer_id FROM ord) = p_customer_id AND NOT (SELECT split_evidence FROM ord), false)
      AND (COALESCE((SELECT sales_tax FROM ord), false) OR a.adjusted),
    COALESCE(p.lot_qty > 0 AND p.other_qty + p_quantity <= p.lot_qty
             AND p.other_cents + p.extended_cents <= p.lot_cents, false),
    p.unit_price_cents,
    p.extended_cents,
    a.adjusted,
    COALESCE(NOT (p.lot_qty > 0 AND p.other_qty + p_quantity <= p.lot_qty
                  AND p.other_cents + p.extended_cents <= p.lot_cents)
             AND p.other_qty + p_quantity <= p.lot_qty + p.draft_qty, false)
  FROM priced p, adj a;
$function$;
REVOKE ALL ON FUNCTION public._return_order_price_lot_price(uuid, uuid, uuid, uuid, numeric)
  FROM PUBLIC, anon, authenticated, service_role;

-- 3. (#2066) receive_return: re-price this return's order-price lines instead of refusing ----------------------------
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
    ) OR EXISTS (  -- (#2066) an order-price line on a sale with tax or a discount
      SELECT 1
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_order_price_lot_price(v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
       WHERE ri.return_id = p_return_id
         AND ((ri.priced_from = 'order_price' AND lp.applies) OR (ri.priced_from = 'unrecorded' AND lp.adjusted))
    ) THEN
      FOR v_lock_order_item_id IN
        SELECT DISTINCT ri.order_item_id
          FROM public.return_items ri
         WHERE ri.return_id = p_return_id AND ri.order_item_id IS NOT NULL
         ORDER BY ri.order_item_id
      LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_order_item_id::text, 361));
      END LOOP;
      -- (#2066) A line create_return priced at the order price (the sale had no posted sales-tax or discount line yet), of
      -- the order's own customer with no field split, on a sale with tax or a discount (its sales-tax box, or a sales-tax or
      -- discount line on a live invoice of the line) is re-priced here, under these locks, to its share of that customer's
      -- POSTED lots of the line, each after its discount and with its share of its tax, priced as create_return prices a
      -- share (the running total), never beyond those lots (Mason, 22 Nov: the taxed share, never more than is charged).
      -- Units still on a draft wait until it is posted (Mason, 26 Nov: RETURN_UNITS_ON_DRAFT); units on no live invoice
      -- cannot be priced (RETURN_UNITS_NOT_INVOICED; Taha, 26 Nov). Only this return's lines change (Taha, 25 Nov): while
      -- another open return of that customer and order line still has a price that is not what it would be priced at now,
      -- this one is refused (RETURN_REPRICE_OTHER_RETURN_PENDING) and nothing changes. The line keeps priced_from
      -- 'order_price' (its origin), so it is re-priced again if more lots post before it is credited. A line priced from
      -- what was billed (priced_from 'billed_share') is never re-priced: if stale it is refused below as before (Mason's
      -- #1010 rule, cancel and recreate).
      IF EXISTS (
        SELECT 1
          FROM public.return_items ri
          CROSS JOIN LATERAL public._return_order_price_lot_price(
            v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
         WHERE ri.return_id = p_return_id AND ri.priced_from = 'order_price' AND lp.applies
           AND (NOT lp.fits
                OR ri.extended_cents IS DISTINCT FROM lp.extended_cents
                OR ri.unit_price_cents IS DISTINCT FROM lp.unit_price_cents)
      ) THEN
        IF EXISTS (
          SELECT 1
            FROM public.return_items ri
            CROSS JOIN LATERAL public._return_order_price_lot_price(
              v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
           WHERE ri.return_id = p_return_id AND ri.priced_from = 'order_price' AND lp.applies AND lp.on_draft
        ) THEN
          RAISE EXCEPTION 'RETURN_UNITS_ON_DRAFT: some returned units are still on a draft invoice of this sale; post that invoice first';
        END IF;
        IF EXISTS (
          SELECT 1
            FROM public.return_items ri
            CROSS JOIN LATERAL public._return_order_price_lot_price(
              v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
           WHERE ri.return_id = p_return_id AND ri.priced_from = 'order_price' AND lp.applies AND NOT lp.fits
        ) THEN
          RAISE EXCEPTION 'RETURN_UNITS_NOT_INVOICED: some returned units are not on any invoice of this sale yet, and the sale has sales tax or a discount, so their credit cannot be priced; invoice them first';
        END IF;
        -- A sales rep may re-price only from invoices invoices_select lets them read (as create_return requires).
        IF NOT public.is_admin() AND EXISTS (
          SELECT 1 FROM public.invoices hidden
           WHERE hidden.order_id = v_order_id
             AND hidden.customer_id = v_customer_id
             AND hidden.invoice_type <> 'credit_memo'
             AND hidden.deleted_at IS NULL
             AND hidden.status IN ('posted', 'overdue', 'paid')
             AND NOT (hidden.created_by IS NOT DISTINCT FROM auth.uid()
                      OR hidden.salesman_id IS NOT DISTINCT FROM auth.uid())
        ) THEN RAISE EXCEPTION 'RETURN_SPLIT_INVOICE_NOT_VISIBLE'; END IF;
        -- A posted sale line of a re-priced order line in another unit can never back the credit (create_return's check).
        IF EXISTS (
          SELECT 1
            FROM public.return_items ri
            CROSS JOIN LATERAL public._return_order_price_lot_price(
              v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
            JOIN public.order_items oi ON oi.id = ri.order_item_id AND oi.order_id = v_order_id
            JOIN public.invoice_items ii ON ii.order_item_id = oi.id AND ii.product_id = oi.product_id AND ii.quantity > 0
            JOIN public.invoices i ON i.id = ii.invoice_id
           WHERE ri.return_id = p_return_id
             AND ri.priced_from = 'order_price' AND lp.applies
             AND i.invoice_type <> 'credit_memo'
             AND i.status IN ('posted', 'overdue', 'paid')
             AND i.deleted_at IS NULL
             AND ii.unit_size IS DISTINCT FROM coalesce(oi.unit_size, 'ea')
        ) THEN RAISE EXCEPTION 'RETURN_CREDIT_UNIT_MISMATCH'; END IF;
        IF EXISTS (
          SELECT 1
            FROM public.return_items ol
            JOIN public.returns r ON r.id = ol.return_id
            CROSS JOIN LATERAL public._return_order_price_lot_price(
              v_order_id, ol.order_item_id, v_customer_id, ol.return_id, ol.quantity) olp
            CROSS JOIN LATERAL public._return_customer_line_share(
              v_order_id, ol.order_item_id, v_customer_id, ol.return_id
            ) s
           WHERE ol.order_item_id IN (SELECT mine.order_item_id FROM public.return_items mine
                                       WHERE mine.return_id = p_return_id AND mine.priced_from = 'order_price')
             AND r.id <> p_return_id
             AND r.order_id = v_order_id
             AND r.customer_id = v_customer_id
             AND r.deleted_at IS NULL
             AND r.status NOT IN ('rejected', 'cancelled', 'credited')
             AND r.credit_invoice_id IS NULL
             AND CASE WHEN ol.priced_from = 'order_price' AND olp.applies
                      THEN ol.extended_cents IS DISTINCT FROM olp.extended_cents
                           OR ol.unit_price_cents IS DISTINCT FROM olp.unit_price_cents
                      ELSE s.share_mode
                           AND (ol.extended_cents IS DISTINCT FROM greatest(0,
                                  round(s.billed_cents * (s.other_returned_qty + ol.quantity) / NULLIF(s.billed_qty, 0))::bigint
                                  - s.other_returned_cents)
                                OR ol.unit_price_cents IS DISTINCT FROM round(s.billed_cents / NULLIF(s.billed_qty, 0))::bigint)
                 END
        ) THEN
          RAISE EXCEPTION 'RETURN_REPRICE_OTHER_RETURN_PENDING: another open return of this product for this customer still has its old price; cancel that return, finish this one, then create the other again';
        END IF;
        WITH fresh AS (
          SELECT ri.id, ri.order_item_id, ri.quantity, ri.unit_price_cents AS old_unit_price_cents,
                 ri.extended_cents AS old_extended_cents, lp.unit_price_cents, lp.extended_cents
            FROM public.return_items ri
            CROSS JOIN LATERAL public._return_order_price_lot_price(
              v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
           WHERE ri.return_id = p_return_id
             AND ri.priced_from = 'order_price' AND lp.applies AND lp.fits
             AND (ri.extended_cents IS DISTINCT FROM lp.extended_cents
                  OR ri.unit_price_cents IS DISTINCT FROM lp.unit_price_cents)
        ), repriced AS (
          UPDATE public.return_items ri
             SET unit_price_cents = f.unit_price_cents, extended_cents = f.extended_cents
            FROM fresh f
           WHERE ri.id = f.id
          RETURNING f.*
        )
        SELECT jsonb_agg(to_jsonb(repriced) ORDER BY repriced.order_item_id),
               sum(repriced.extended_cents - repriced.old_extended_cents)::bigint
          INTO v_repriced, v_repriced_delta
          FROM repriced;
        IF v_repriced IS NOT NULL THEN
          INSERT INTO public.financial_audit_log (
            operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
          ) VALUES (
            'return_received', 'return', p_return_id, v_actor, NULL, jsonb_build_object('lines', v_repriced), v_repriced_delta,
            'Return re-priced to its share of the sale''s invoices (tax and discount included) after the sale''s billing changed'
          );
        END IF;
      END IF;
      -- (#2066, Taha 26 Nov) A line from before this change (priced_from 'unrecorded') keeps today's rule: while a live invoice
      -- of the line (a draft too) carries a sales-tax or discount line, it must be exactly the posted billed share and within
      -- it, as staging's share check required (a draft's tax line used to switch the line to share pricing).
      IF EXISTS (
        SELECT 1
          FROM public.return_items ri
          CROSS JOIN LATERAL public._return_customer_line_share(
            v_order_id, ri.order_item_id, v_customer_id, p_return_id
          ) s
          CROSS JOIN LATERAL public._return_order_price_lot_price(v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
         WHERE ri.return_id = p_return_id
           AND ri.priced_from = 'unrecorded'
           AND NOT s.share_mode AND lp.adjusted
           AND (s.billed_qty <= 0
                OR s.other_returned_qty + ri.quantity > s.billed_qty
                OR s.other_returned_cents + ri.extended_cents > s.billed_cents
                OR ri.extended_cents IS DISTINCT FROM greatest(0,
                     round(s.billed_cents * (s.other_returned_qty + ri.quantity) / NULLIF(s.billed_qty, 0))::bigint
                     - s.other_returned_cents)
                OR ri.unit_price_cents IS DISTINCT FROM round(s.billed_cents / NULLIF(s.billed_qty, 0))::bigint)
      ) THEN RAISE EXCEPTION 'RETURN_SPLIT_SHARE_REPRICED'; END IF;
      -- Each share line's stored credit must still be exactly what create_return would price it at
      -- now: an earlier return of the line cancelled or rejected after this one was created leaves it
      -- stale, so refuse before restocking (cancel and recreate the return to reprice it).
      IF EXISTS (
        SELECT 1
          FROM public.return_items ri
          CROSS JOIN LATERAL public._return_customer_line_share(
            v_order_id, ri.order_item_id, v_customer_id, p_return_id
          ) s
          CROSS JOIN LATERAL public._return_order_price_lot_price(v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
         WHERE ri.return_id = p_return_id
           AND s.share_mode
           AND s.billed_qty > 0
           AND NOT (ri.priced_from = 'order_price' AND lp.applies)  -- (#2066) priced from its lots above
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
      -- (#2066) an order-price line on a sale with tax or a discount is priced from its posted lots
      LEFT JOIN LATERAL public._return_order_price_lot_price(v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp ON true
      WHERE ri.return_id = p_return_id
        AND (
          ri.order_item_id IS NULL
          OR oi.id IS NULL
          OR oi.price_per_unit IS NULL
          OR ri.product_id IS DISTINCT FROM oi.product_id
          OR ri.unit IS DISTINCT FROM coalesce(oi.unit_size, 'ea')
          OR ri.quantity <= 0
          OR ri.quantity > coalesce(oi.quantity_delivered, 0)
          OR (NOT s.share_mode AND NOT (ri.priced_from = 'order_price' AND lp.applies)
              AND (ri.unit_price_cents IS DISTINCT FROM round(oi.price_per_unit * 100)::bigint
                   OR ri.extended_cents IS DISTINCT FROM round(ri.quantity * oi.price_per_unit * 100)::bigint))
          -- Split-payer return (20261021155000): within the returner's billed share, in quantity and
          -- in cents (create_return priced it from what was left of its billed cents).
          OR (s.share_mode AND NOT (ri.priced_from = 'order_price' AND lp.applies) AND (
            s.billed_qty <= 0
            OR ri.extended_cents < 0
            OR s.other_returned_qty + ri.quantity > s.billed_qty
            OR s.other_returned_cents + ri.extended_cents > s.billed_cents
          ))
          -- (#2066) re-priced above under the locks: exactly its lots' price, within them
          OR (ri.priced_from = 'order_price' AND lp.applies AND (
            NOT lp.fits
            OR ri.extended_cents IS DISTINCT FROM lp.extended_cents
            OR ri.unit_price_cents IS DISTINCT FROM lp.unit_price_cents
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

-- 4. (#2066) issue_return_credit: re-price this return's order-price lines, then cap them ----------------------------
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
      -- (#2066) an order-price line on a sale with tax or a discount is priced from its posted lots
      LEFT JOIN LATERAL public._return_order_price_lot_price(v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp ON true
      WHERE ri.return_id = p_return_id
        AND (
          ri.order_item_id IS NULL
          OR oi.id IS NULL
          OR oi.price_per_unit IS NULL
          OR ri.product_id IS DISTINCT FROM oi.product_id
          OR ri.unit IS DISTINCT FROM coalesce(oi.unit_size, 'ea')
          OR ri.quantity <= 0
          OR ri.quantity > coalesce(oi.quantity_delivered, 0)
          OR (NOT s.share_mode AND NOT (ri.priced_from = 'order_price' AND lp.applies)
              AND (ri.unit_price_cents IS DISTINCT FROM round(oi.price_per_unit * 100)::bigint
                   OR ri.extended_cents IS DISTINCT FROM round(ri.quantity * oi.price_per_unit * 100)::bigint))
          -- Split-payer return (20261021155000): within the returner's billed share, in quantity and
          -- in cents (create_return priced it from what was left of its billed cents).
          OR (s.share_mode AND NOT (ri.priced_from = 'order_price' AND lp.applies) AND (
            s.billed_qty <= 0
            OR ri.extended_cents < 0
            OR s.other_returned_qty + ri.quantity > s.billed_qty
            -- (#2066) the cents bound is checked after the re-price, under the locks (RETURN_CREDIT_EXCEEDS_BILLED_SHARE)
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
    -- (#2066) A line create_return priced at the order price (the sale had no posted sales-tax or discount line yet), of
    -- the order's own customer with no field split, on a sale with tax or a discount (its sales-tax box, or a sales-tax or
    -- discount line on a live invoice of the line) is re-priced here, under these locks, to its share of that customer's
    -- POSTED lots of the line, each after its discount and with its share of its tax, priced as create_return prices a
    -- share (the running total), never beyond those lots (Mason, 22 Nov: the taxed share, never more than is charged).
    -- Units still on a draft wait until it is posted (Mason, 26 Nov: RETURN_UNITS_ON_DRAFT); units on no live invoice
    -- cannot be priced (RETURN_UNITS_NOT_INVOICED; Taha, 26 Nov). Only this return's lines change (Taha, 25 Nov): while
    -- another open return of that customer and order line still has a price that is not what it would be priced at now,
    -- this one is refused (RETURN_REPRICE_OTHER_RETURN_PENDING) and nothing changes. The line keeps priced_from
    -- 'order_price' (its origin), so it is re-priced again if more lots post before it is credited. A line priced from
    -- what was billed (priced_from 'billed_share') is never re-priced: if stale it is refused below as before (Mason's
    -- #1010 rule, cancel and recreate).
    IF EXISTS (
      SELECT 1
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_order_price_lot_price(
          v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
       WHERE ri.return_id = p_return_id AND ri.priced_from = 'order_price' AND lp.applies
         AND (NOT lp.fits
              OR ri.extended_cents IS DISTINCT FROM lp.extended_cents
              OR ri.unit_price_cents IS DISTINCT FROM lp.unit_price_cents)
    ) THEN
      IF EXISTS (
        SELECT 1
          FROM public.return_items ri
          CROSS JOIN LATERAL public._return_order_price_lot_price(
            v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
         WHERE ri.return_id = p_return_id AND ri.priced_from = 'order_price' AND lp.applies AND lp.on_draft
      ) THEN
        RAISE EXCEPTION 'RETURN_UNITS_ON_DRAFT: some returned units are still on a draft invoice of this sale; post that invoice first';
      END IF;
      IF EXISTS (
        SELECT 1
          FROM public.return_items ri
          CROSS JOIN LATERAL public._return_order_price_lot_price(
            v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
         WHERE ri.return_id = p_return_id AND ri.priced_from = 'order_price' AND lp.applies AND NOT lp.fits
      ) THEN
        RAISE EXCEPTION 'RETURN_UNITS_NOT_INVOICED: some returned units are not on any invoice of this sale yet, and the sale has sales tax or a discount, so their credit cannot be priced; invoice them first';
      END IF;
      -- A sales rep may re-price only from invoices invoices_select lets them read (as create_return requires).
      IF NOT public.is_admin() AND EXISTS (
        SELECT 1 FROM public.invoices hidden
         WHERE hidden.order_id = v_order_id
           AND hidden.customer_id = v_customer_id
           AND hidden.invoice_type <> 'credit_memo'
           AND hidden.deleted_at IS NULL
           AND hidden.status IN ('posted', 'overdue', 'paid')
           AND NOT (hidden.created_by IS NOT DISTINCT FROM auth.uid()
                    OR hidden.salesman_id IS NOT DISTINCT FROM auth.uid())
      ) THEN RAISE EXCEPTION 'RETURN_SPLIT_INVOICE_NOT_VISIBLE'; END IF;
      -- A posted sale line of a re-priced order line in another unit can never back the credit (create_return's check).
      IF EXISTS (
        SELECT 1
          FROM public.return_items ri
          CROSS JOIN LATERAL public._return_order_price_lot_price(
            v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
          JOIN public.order_items oi ON oi.id = ri.order_item_id AND oi.order_id = v_order_id
          JOIN public.invoice_items ii ON ii.order_item_id = oi.id AND ii.product_id = oi.product_id AND ii.quantity > 0
          JOIN public.invoices i ON i.id = ii.invoice_id
         WHERE ri.return_id = p_return_id
           AND ri.priced_from = 'order_price' AND lp.applies
           AND i.invoice_type <> 'credit_memo'
           AND i.status IN ('posted', 'overdue', 'paid')
           AND i.deleted_at IS NULL
           AND ii.unit_size IS DISTINCT FROM coalesce(oi.unit_size, 'ea')
      ) THEN RAISE EXCEPTION 'RETURN_CREDIT_UNIT_MISMATCH'; END IF;
      IF EXISTS (
        SELECT 1
          FROM public.return_items ol
          JOIN public.returns r ON r.id = ol.return_id
          CROSS JOIN LATERAL public._return_order_price_lot_price(
            v_order_id, ol.order_item_id, v_customer_id, ol.return_id, ol.quantity) olp
          CROSS JOIN LATERAL public._return_customer_line_share(
            v_order_id, ol.order_item_id, v_customer_id, ol.return_id
          ) s
         WHERE ol.order_item_id IN (SELECT mine.order_item_id FROM public.return_items mine
                                     WHERE mine.return_id = p_return_id AND mine.priced_from = 'order_price')
           AND r.id <> p_return_id
           AND r.order_id = v_order_id
           AND r.customer_id = v_customer_id
           AND r.deleted_at IS NULL
           AND r.status NOT IN ('rejected', 'cancelled', 'credited')
           AND r.credit_invoice_id IS NULL
           AND CASE WHEN ol.priced_from = 'order_price' AND olp.applies
                    THEN ol.extended_cents IS DISTINCT FROM olp.extended_cents
                         OR ol.unit_price_cents IS DISTINCT FROM olp.unit_price_cents
                    ELSE s.share_mode
                         AND (ol.extended_cents IS DISTINCT FROM greatest(0,
                                round(s.billed_cents * (s.other_returned_qty + ol.quantity) / NULLIF(s.billed_qty, 0))::bigint
                                - s.other_returned_cents)
                              OR ol.unit_price_cents IS DISTINCT FROM round(s.billed_cents / NULLIF(s.billed_qty, 0))::bigint)
               END
      ) THEN
        RAISE EXCEPTION 'RETURN_REPRICE_OTHER_RETURN_PENDING: another open return of this product for this customer still has its old price; cancel that return, finish this one, then create the other again';
      END IF;
      WITH fresh AS (
        SELECT ri.id, ri.order_item_id, ri.quantity, ri.unit_price_cents AS old_unit_price_cents,
               ri.extended_cents AS old_extended_cents, lp.unit_price_cents, lp.extended_cents
          FROM public.return_items ri
          CROSS JOIN LATERAL public._return_order_price_lot_price(
            v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
         WHERE ri.return_id = p_return_id
           AND ri.priced_from = 'order_price' AND lp.applies AND lp.fits
           AND (ri.extended_cents IS DISTINCT FROM lp.extended_cents
                OR ri.unit_price_cents IS DISTINCT FROM lp.unit_price_cents)
      ), repriced AS (
        UPDATE public.return_items ri
           SET unit_price_cents = f.unit_price_cents, extended_cents = f.extended_cents
          FROM fresh f
         WHERE ri.id = f.id
        RETURNING f.*
      )
      SELECT jsonb_agg(to_jsonb(repriced) ORDER BY repriced.order_item_id),
             sum(repriced.extended_cents - repriced.old_extended_cents)::bigint
        INTO v_repriced, v_repriced_delta
        FROM repriced;
      IF v_repriced IS NOT NULL THEN
        INSERT INTO public.financial_audit_log (
          operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
        ) VALUES (
          'return_credit_issued', 'return', p_return_id, v_actor, NULL, jsonb_build_object('lines', v_repriced), v_repriced_delta,
          'Return re-priced to its share of the sale''s invoices (tax and discount included) after the sale''s billing changed'
        );
      END IF;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_customer_line_share(
          v_order_id, ri.order_item_id, v_customer_id, p_return_id
        ) s
        CROSS JOIN LATERAL public._return_order_price_lot_price(v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
       WHERE ri.return_id = p_return_id
         AND s.share_mode
         AND NOT (ri.priced_from = 'order_price' AND lp.applies)  -- (#2066) capped at its lots above
         AND (
           s.billed_qty <= 0
           OR s.other_returned_qty + ri.quantity > s.billed_qty
           OR s.other_returned_cents + ri.extended_cents > s.billed_cents
         )
    ) THEN RAISE EXCEPTION 'RETURN_CREDIT_EXCEEDS_BILLED_SHARE'; END IF;
    -- (#2066, Taha 26 Nov) A line from before this change (priced_from 'unrecorded') keeps today's rule: while a live invoice
    -- of the line (a draft too) carries a sales-tax or discount line, it must be exactly the posted billed share and within
    -- it, as staging's share check required (a draft's tax line used to switch the line to share pricing).
    IF EXISTS (
      SELECT 1
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_customer_line_share(
          v_order_id, ri.order_item_id, v_customer_id, p_return_id
        ) s
        CROSS JOIN LATERAL public._return_order_price_lot_price(v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
       WHERE ri.return_id = p_return_id
         AND ri.priced_from = 'unrecorded'
         AND NOT s.share_mode AND lp.adjusted
         AND (s.billed_qty <= 0
              OR s.other_returned_qty + ri.quantity > s.billed_qty
              OR s.other_returned_cents + ri.extended_cents > s.billed_cents
              OR ri.extended_cents IS DISTINCT FROM greatest(0,
                   round(s.billed_cents * (s.other_returned_qty + ri.quantity) / NULLIF(s.billed_qty, 0))::bigint
                   - s.other_returned_cents)
              OR ri.unit_price_cents IS DISTINCT FROM round(s.billed_cents / NULLIF(s.billed_qty, 0))::bigint)
    ) THEN RAISE EXCEPTION 'RETURN_SPLIT_SHARE_REPRICED'; END IF;
    -- And each share line's stored credit is still exactly what create_return would price it at
    -- now: an earlier return of the line cancelled or rejected after this one was created leaves it
    -- stale, so refuse rather than credit a stale price (cancel and recreate the return).
    IF EXISTS (
      SELECT 1
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_customer_line_share(
          v_order_id, ri.order_item_id, v_customer_id, p_return_id
        ) s
        CROSS JOIN LATERAL public._return_order_price_lot_price(v_order_id, ri.order_item_id, v_customer_id, p_return_id, ri.quantity) lp
       WHERE ri.return_id = p_return_id
         AND s.share_mode
         AND s.billed_qty > 0
         AND NOT (ri.priced_from = 'order_price' AND lp.applies)  -- (#2066) priced from its lots above
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

DO $postflight$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(f.name, ', ') INTO v_bad
    FROM (VALUES
      ('public._create_return_intent_impl_20260812(jsonb,jsonb,text)', '(#2066)', 2),
      ('public._receive_return_intent_impl_20260812(uuid,uuid,text)', '(#2066)', 1),
      ('public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)', '(#2066)', 1)
    ) AS f(name, marker, ndef)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(f.name)
        AND position(f.marker in p.prosrc) > 0
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef
        AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
        AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]
        AND p.pronargdefaults = f.ndef);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_TAX_CHANGE_POSTFLIGHT: not as written: %', v_bad;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._return_customer_line_share(uuid,uuid,uuid,uuid)')
       AND position('(#2066)' in p.prosrc) > 0
       AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef AND p.provolatile = 's'
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]
  ) THEN
    RAISE EXCEPTION 'RETURN_TAX_CHANGE_POSTFLIGHT: not as written: public._return_customer_line_share';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._return_order_price_lot_price(uuid,uuid,uuid,uuid,numeric)')
       AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef AND p.provolatile = 's'
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]
  ) THEN
    RAISE EXCEPTION 'RETURN_TAX_CHANGE_POSTFLIGHT: not as written: public._return_order_price_lot_price';
  END IF;
  -- No Data API role may write the new column (return lines change only through the return functions).
  IF has_column_privilege('authenticated', 'public.return_items', 'priced_from', 'UPDATE')
     OR has_column_privilege('anon', 'public.return_items', 'priced_from', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.return_items', 'priced_from', 'INSERT')
     OR has_column_privilege('anon', 'public.return_items', 'priced_from', 'INSERT') THEN
    RAISE EXCEPTION 'RETURN_TAX_CHANGE_POSTFLIGHT: priced_from is writable from the Data API';
  END IF;
  RAISE NOTICE 'RETURN_TAX_CHANGE_POSTFLIGHT_OK: % line(s) order_price, % billed_share, % unrecorded',
    (SELECT count(*) FROM public.return_items WHERE priced_from = 'order_price'),
    (SELECT count(*) FROM public.return_items WHERE priced_from = 'billed_share'),
    (SELECT count(*) FROM public.return_items WHERE priced_from = 'unrecorded');
END
$postflight$;
