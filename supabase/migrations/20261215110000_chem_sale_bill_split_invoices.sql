-- Written 2026-11-06. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261215110000_chem_sale_bill_split_invoices.md.
-- Re-read the live ledger before applying.
--
-- WHAT (billing plan M2, Mason 4 Nov: "splits work line by line"): the Bill Split card now bills. When
--   a delivery on a sale with other payers completes, it drafts one chemical-sale invoice per payer,
--   numbered with one sale number and a suffix (CS-2026-0412-1, -2), in one governed split group.
--   - New table order_item_shares: a line's own shares, overriding the card for that line.
--   - Each line shares its delivered cents and quantity: every other payer gets their share rounded
--     down and the main customer (the sale's customer) gets the rest, so each line bills exactly. If
--     the main customer has no share of a line, the largest share gets the rest. Shares under 100% leave
--     the rest with the main customer. Another payer's quantity rounds down to whole hundredths, so they can
--     return it in full; only a share under 0.01 falls back to 4 places, as an invoice line holds it. The main
--     customer takes the rest, so a three-decimal delivery (2.125) bills like a plain sale (Mason, 2026-11-09,
--     replacing the Nov 6 refusal of deliveries not in whole hundredths). Each payer's cents are exactly its percentage rounded down. A share under
--     0.0001 of a unit that is worth cents refuses the split (BILL_SPLIT_QUANTITY_TOO_SMALL), so no billed money
--     sits on no quantity; the office adjusts the shares.
--   - Each payer's cost is the sum of its own lines, ROUND(cost_cents * quantity), as on every other
--     invoice and in the month-end report (Mason, 2026-11-05, Option 1). Summed across payers it can top
--     the line's cost by about a cent where a share splits a unit, and more where the unit cost itself has
--     sub-cent digits, which round to a cent as on every invoice (12.345 x 1,000 units is $5.00 over; live
--     had 0 of 296 such lines). Billed cents are exact.
--   - The card and the line shares freeze at the first completed delivery (voiding it reopens them), and
--     refuse a change while a one-customer draft is on the sale, which would never bill the new payer.
--     A line with its own shares can't move to another sale.
--   - guard_invoice_terminal_order admits a payer on the sale's card or line shares, only inside the
--     creation claim or as the invoice its provenance row names, as for field splits. Delivery lineage
--     accepts that invoice. A sale with other payers refuses a one-customer chemical-sale or misc-charge
--     invoice.
--   - Create Invoice on a delivery (backfill) drafts per payer too.
--   - A Bill Split draft takes charges and header edits through save_invoice until it posts (a field split
--     still can't). Its product lines (product, description, quantity, price, cents and cost) follow the
--     split: changing them means voiding the group, so the cost the save recomputes stays the same.
--   - The payers' drafts stand or fall together: delete_invoices refuses one member of a Bill Split group.
--   - A payer's draft holding a product line with no quantity refuses edits (BILL_SPLIT_SLIVER_LOCKED). The split
--     never drafts one (BILL_SPLIT_QUANTITY_TOO_SMALL); the lock stays as a backstop.
--   - A posted group unposts together: unpost_invoice refuses any group member (GROUP_UNPOST_REQUIRED), as
--     post_invoice does (GROUP_POST_REQUIRED). This covers field-split groups too: the screens already send
--     them to unpost_invoice_group, which calls the inner function and isn't changed.
--   - A line bills in the order line's unit, as the return checks compare it, so every payer can return it.
--   - A Bill Split bills the real delivered amount, as a plain sale does (Mason, 2026-11-09). Only a delivered
--     amount finer than an invoice line holds (more than 4 places) refuses (BILL_SPLIT_QUANTITY_TOO_FINE), since
--     it couldn't be split exactly. A one-customer sale is unchanged.
--   - A return holds 2 places (return_items.quantity). Creating a return now refuses a finer quantity
--     (RETURN_QUANTITY_TOO_FINE): stored rounded but priced in full, it was refused at receive and left stuck, on
--     a plain 2.125 line too. A payer returns their share to 2 places, so as on a plain sale a sliver under 0.01
--     isn't returnable.
--   - Dates (Mason, 2026-11-09): completing a delivery dates the payers by the completion, as a plain sale. Create
--     Invoice dates them the day it runs, as a plain Create Invoice does, so a rush sale billed after pricing
--     lands in the month it was billed. Nothing is ever dated into a closed month (check_period_open).
--   - A price-later (rush) sale drafts nothing until it is priced (PRICING_INCOMPLETE, as for field
--     splits): the delivery completes, the office is told, and Create Invoice drafts per payer after.
--   - A failed split doesn't stop the delivery completing: it leaves an activity record and a flag in the
--     result, and Create Invoice on the delivery runs it again.
--   - Reps read the card (order_shares_select): any rep can already write it and reps work any customer.
--   - An inactive customer can't be added to a card or a line (BILL_SPLIT_CUSTOMER_INACTIVE).
--   - One row per customer on a card: UNIQUE (order_id, customer_id). Live had 0 rows on 2026-11-06.
--   - A card totals at most exactly 100%, without the old 0.01 tolerance, and a row can't move to another
--     order or line, which would take it out of a frozen sale without the check.
--
-- MASON'S DECISIONS (2026-11-06, #crx-work): the restricted-use register keeps the main customer as buyer on a
--   payer's share (the farmer takes delivery and applies; the landlord only pays). Sales reports stay under
--   the main customer until M15.
--   Per-line rounding is accepted (Mason, 2026-11-06, "Yes, accept it"): each line splits on its own, so up
--   to one cent per line goes to the main customer instead of another payer; billed totals stay exact.
--   Per-payer cost follows Option 1 above (Mason, 2026-11-05).
--
-- SCREENS (the next PR; this one lands the database first, as planned): the completion screens show
--   bill_split_failed and every drafted invoice, Create Invoice is offered for a split backfill while
--   needs_split_billing is set, and the card shows each payer's live amount. Until then a failed split is
--   reported by the admin notification and the activity record, and the server-side paths are complete.
--
-- NOT CHANGED: a sale with no other payers bills exactly as before. Field/acre splits keep their own
--   engine and win over a card until it freezes. Posting, payments and the overbilling caps. Who may unpost
--   a plain invoice. A field-split
--   group still deletes member by member. No existing row is written.
--
-- ROLLBACK (its own reviewed migration): re-emit the eight changed functions from their previous bodies
--   (_complete_delivery_authorized_impl 20261106230000, guard_invoice_terminal_order 20261021155000,
--   _create_invoice_for_unbilled_delivery_impl_20260718 20260827041200,
--   _save_invoice_intent_impl_20260802 20260720175946, prevent_order_shares_edit_after_post 20260504100000,
--   _validate_order_shares_total 20260616121521, delete_invoices 20260719060256,
--   unpost_invoice 20261102180000), restore order_shares_select
--   from 20260511050000, drop the new helpers, trg_oifa_bill_split_freeze, trg_order_items_bill_split_move, order_item_shares,
--   order_shares.updated_at and order_shares_order_customer_key. Split invoices already drafted stay governed by their
--   provenance rows; void them first if the sale should bill as one invoice.
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE chem_sale_bill_split_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  r record;
BEGIN
  IF to_regclass('pg_temp.chem_sale_bill_split_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.chem_sale_bill_split_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'CHEM_SALE_BILL_SPLIT_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  -- Held to commit, so no card can change between the checks below and the new guard.
  LOCK TABLE public.order_shares IN ACCESS EXCLUSIVE MODE;
  -- And no invoice can be created on a sale with a card before the new guard takes effect.
  LOCK TABLE public.invoices IN SHARE ROW EXCLUSIVE MODE;
  -- Each re-emitted function, pinned to its current body, owner, mode, search_path and grants.
  FOR r IN SELECT * FROM (VALUES
    ('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)', '6665c5841f047c9ca165c8a20c68f4f9', ARRAY['postgres=X/postgres']::aclitem[]),
    ('public.guard_invoice_terminal_order()', '3d76dae05876de46fd11233e7304af48', ARRAY['postgres=X/postgres']::aclitem[]),
    ('public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)', 'aeb4643d79eccb9e998cd8a5e3a9598e', ARRAY['postgres=X/postgres']::aclitem[]),
    ('public._save_invoice_intent_impl_20260802(jsonb,jsonb,text)', 'f7e0fe8f494fe160039df9aef46067df', ARRAY['postgres=X/postgres']::aclitem[]),
    ('public._validate_order_shares_total()', '5afa7599d7d9b60b90f626a8781a17e3', ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[]),
    ('public.prevent_order_shares_edit_after_post()', 'f21012312edbc966076a3318a3214abb', ARRAY['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::aclitem[]),
    ('public.delete_invoices(uuid[],uuid,text)', '24c271164caa2369c57c3bdc5d88c50a', ARRAY['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::aclitem[]),
    ('public.unpost_invoice(uuid,uuid,text)', '1d886fac647db1ac12e0972ff26664c2', ARRAY['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::aclitem[]),
    ('public._create_return_intent_impl_20260812(jsonb,jsonb,text)', '5a04a82127e6181aa8e95d74e23216c7', ARRAY['postgres=X/postgres']::aclitem[])
  ) AS v(sig, body_md5, acl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = to_regprocedure(r.sig)
         AND md5(replace(p.prosrc, chr(13), '')) = r.body_md5
         AND p.proowner = 'postgres'::regrole
         AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND p.proacl = r.acl
    ) THEN
      RAISE EXCEPTION 'CHEM_SALE_BILL_SPLIT_PREFLIGHT: % drifted', r.sig;
    END IF;
  END LOOP;
  IF to_regclass('public.order_item_shares') IS NOT NULL THEN
    RAISE EXCEPTION 'CHEM_SALE_BILL_SPLIT_PREFLIGHT: order_item_shares already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_shares GROUP BY order_id, customer_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'CHEM_SALE_BILL_SPLIT_PREFLIGHT: a card lists a customer twice; resolve it before applying';
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_shares GROUP BY order_id HAVING sum(split_percentage) > 100) THEN
    RAISE EXCEPTION 'CHEM_SALE_BILL_SPLIT_PREFLIGHT: a card totals over 100%%; resolve it before applying';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.order_shares s
      JOIN public.orders o ON o.id = s.order_id
      JOIN public.invoices i ON i.order_id = o.id
     WHERE s.customer_id <> o.customer_id
       AND i.invoice_type IN ('chemical_sale', 'misc_charge')
       AND (i.invoice_group_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM public.split_invoice_provenance p WHERE p.invoice_id = i.id))
       AND i.deleted_at IS NULL AND i.status IN ('draft', 'unposted', 'posted', 'paid', 'overdue')
  ) THEN
    RAISE EXCEPTION 'CHEM_SALE_BILL_SPLIT_PREFLIGHT: a sale with other payers has a one-customer invoice; resolve it before applying';
  END IF;
END
$preflight$;

ALTER TABLE public.order_shares
  ADD CONSTRAINT order_shares_order_customer_key UNIQUE (order_id, customer_id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.order_shares FROM authenticated;

CREATE TABLE public.order_item_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  split_percentage numeric(9,6) NOT NULL CHECK (split_percentage > 0 AND split_percentage <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_item_id, customer_id)
);
CREATE INDEX order_item_shares_customer_id_idx ON public.order_item_shares (customer_id);

ALTER TABLE public.order_item_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_item_shares FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_item_shares TO authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.order_item_shares FROM authenticated;
GRANT ALL ON public.order_item_shares TO service_role;

CREATE POLICY order_item_shares_select ON public.order_item_shares FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
                  WHERE oi.id = order_item_shares.order_item_id AND o.deleted_at IS NULL
                    AND (public.is_admin() OR public.is_sales_rep())));
CREATE POLICY order_item_shares_insert ON public.order_item_shares FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
                       WHERE oi.id = order_item_shares.order_item_id AND o.deleted_at IS NULL
                         AND (public.is_admin() OR public.is_sales_rep())));
CREATE POLICY order_item_shares_update ON public.order_item_shares FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
                  WHERE oi.id = order_item_shares.order_item_id AND o.deleted_at IS NULL
                    AND (public.is_admin() OR public.is_sales_rep())));
CREATE POLICY order_item_shares_delete ON public.order_item_shares FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
                  WHERE oi.id = order_item_shares.order_item_id AND o.deleted_at IS NULL
                    AND (public.is_admin() OR public.is_sales_rep())));

DROP POLICY order_shares_select ON public.order_shares;
CREATE POLICY order_shares_select ON public.order_shares FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o
                  WHERE o.id = order_shares.order_id AND o.deleted_at IS NULL
                    AND (public.is_admin() OR public.is_sales_rep())));

-- Refuses a split change once an invoice is posted or a completed delivery is billed, or while a one-customer
-- draft is on the sale (it would post without the new payer). Locks the order, so a change and a delivery
-- completing can't pass each other.
CREATE FUNCTION public._refuse_bill_split_change(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_blocking text;
BEGIN
  PERFORM 1 FROM orders WHERE id = p_order_id FOR UPDATE;

  SELECT i.invoice_number INTO v_blocking
    FROM invoices i
   WHERE i.order_id = p_order_id
     AND i.deleted_at IS NULL
     AND i.status IN ('posted', 'paid', 'overdue')
   ORDER BY i.created_at
   LIMIT 1;
  IF v_blocking IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot modify bill split — invoice % is already posted. Void the invoice first or adjust the split on a new order.',
      v_blocking
      USING ERRCODE = 'check_violation';
  END IF;

  -- A completed delivery freezes the split once it is billed. One the split refused (a share too small to
  -- return, Mason 2026-11-06 option B, or a price-later sale) stays open, so the office can fix the shares.
  SELECT d.delivery_number INTO v_blocking
    FROM deliveries d
   WHERE d.order_id = p_order_id
     AND d.status = 'completed'
     AND d.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM invoices i
                  WHERE i.delivery_id = d.id AND i.deleted_at IS NULL
                    AND i.status NOT IN ('voided', 'cancelled') AND i.invoice_type <> 'credit_memo')
   ORDER BY d.completed_at
   LIMIT 1;
  IF v_blocking IS NOT NULL THEN
    RAISE EXCEPTION
      'BILL_SPLIT_FROZEN: delivery % is complete and billed, so this sale''s bill split can''t change. Void its invoices or the delivery to change it. Unpost a posted group first, so the sale keeps its commission.',
      v_blocking
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT i.invoice_number INTO v_blocking
    FROM invoices i
   WHERE i.order_id = p_order_id
     AND i.invoice_type IN ('chemical_sale', 'misc_charge')
     -- Only the split writer's invoices stand as a group: a group id with no split record is still one customer's draft.
     AND (i.invoice_group_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.split_invoice_provenance p WHERE p.invoice_id = i.id))
     AND i.deleted_at IS NULL
     AND i.status IN ('draft', 'unposted')
   ORDER BY i.created_at
   LIMIT 1;
  IF v_blocking IS NOT NULL THEN
    RAISE EXCEPTION
      'BILL_SPLIT_HAS_DRAFT: draft invoice % bills this sale to one customer. Remove that draft to change the bill split.',
      v_blocking
      USING ERRCODE = 'check_violation';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_order_shares_edit_after_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- A row that moved would leave a frozen sale without the check on it.
  IF TG_OP = 'UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'ORDER_SHARES_ORDER_IMMUTABLE: a bill split row cannot move to another order'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public._refuse_bill_split_change(COALESCE(NEW.order_id, OLD.order_id));
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id)
     AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id = NEW.customer_id AND is_active) THEN
    RAISE EXCEPTION 'BILL_SPLIT_CUSTOMER_INACTIVE: an inactive customer can''t be added to a bill split'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

-- A card totals at most exactly 100%: the 0.01 tolerance from 20260616121521 could bill a share 0.01% off.
CREATE OR REPLACE FUNCTION public._validate_order_shares_total()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total numeric;
BEGIN
  -- Serialize concurrent share writes for this order (race fix): lock the parent order row.
  PERFORM 1 FROM orders WHERE id = NEW.order_id FOR UPDATE;
  -- SECURITY DEFINER so the aggregate sees ALL shares for the order, RLS-independent.
  SELECT COALESCE(SUM(split_percentage), 0) INTO v_total
  FROM order_shares
  WHERE order_id = NEW.order_id
    AND id <> NEW.id;
  v_total := v_total + NEW.split_percentage;
  IF v_total > 100 THEN
    RAISE EXCEPTION 'ORDER_SHARES_OVER_100: order % bill-split total would be % (max 100)',
      NEW.order_id, v_total;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.guard_order_item_shares()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_item_id uuid := COALESCE(NEW.order_item_id, OLD.order_item_id);
  v_order_id uuid := (SELECT order_id FROM order_items WHERE id = COALESCE(NEW.order_item_id, OLD.order_item_id));
  v_line_held boolean;
  v_total numeric;
BEGIN
  -- A share that moved would leave a frozen sale without the check on it.
  IF TG_OP = 'UPDATE' AND NEW.order_item_id IS DISTINCT FROM OLD.order_item_id THEN
    RAISE EXCEPTION 'ORDER_ITEM_SHARES_LINE_IMMUTABLE: a line share cannot move to another line'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The sale is locked before its line, as Create Invoice locks them. Completion updates its lines before
  -- the sale, so the line is taken NOWAIT: a share write that meets a completing delivery gives up and asks
  -- for a retry instead of deadlocking it. FOR SHARE then holds the line on its sale until commit
  -- (trg_order_items_bill_split_move).
  -- A line being deleted takes its shares with it; trg_order_items_bill_split_move checked its sale.
  IF v_order_id IS NULL AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  PERFORM 1 FROM orders WHERE id = v_order_id FOR UPDATE;
  BEGIN
    v_line_held := EXISTS (SELECT 1 FROM order_items WHERE id = v_item_id AND order_id = v_order_id FOR SHARE NOWAIT);
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'ORDER_ITEM_SHARES_BUSY: a delivery on this sale is being completed; try again'
      USING ERRCODE = 'serialization_failure';
  END;
  IF NOT v_line_held THEN
    RAISE EXCEPTION 'ORDER_ITEM_SHARES_LINE_MOVED: the line moved to another order; try again'
      USING ERRCODE = 'serialization_failure';
  END IF;
  PERFORM public._refuse_bill_split_change(v_order_id);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id)
     AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id = NEW.customer_id AND is_active) THEN
    RAISE EXCEPTION 'BILL_SPLIT_CUSTOMER_INACTIVE: an inactive customer can''t be added to a bill split'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(split_percentage), 0) + NEW.split_percentage INTO v_total
    FROM order_item_shares
   WHERE order_item_id = NEW.order_item_id AND id IS DISTINCT FROM NEW.id;
  IF v_total > 100 THEN
    RAISE EXCEPTION 'ORDER_ITEM_SHARES_OVER_100: a line''s shares can''t total more than 100%%'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_guard_order_item_shares
  BEFORE INSERT OR UPDATE OR DELETE ON public.order_item_shares
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_item_shares();

-- A line with its own shares can't move to another sale: the override would bill the other sale's payers.
-- Deleting it is checked here, on its sale: the cascade to its shares runs after the line is gone.
CREATE FUNCTION public.guard_order_item_bill_split_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM order_item_shares WHERE order_item_id = OLD.id) THEN
      PERFORM public._refuse_bill_split_change(OLD.order_id);
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
     AND EXISTS (SELECT 1 FROM order_item_shares WHERE order_item_id = OLD.id) THEN
    RAISE EXCEPTION 'ORDER_ITEM_SHARES_LINE_MOVE: this line has its own bill split; remove its shares before moving it to another order'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A line with a field allocation would switch the sale it joins to the field split, as adding one does.
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
     AND EXISTS (SELECT 1 FROM order_item_field_allocations WHERE order_item_id = OLD.id)
     AND public._order_has_bill_split(NEW.order_id) THEN
    PERFORM public._refuse_bill_split_change(NEW.order_id);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_order_items_bill_split_move
  BEFORE UPDATE OF order_id OR DELETE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_item_bill_split_move();

-- True when a sale bills someone other than its customer. Field/acre splits win over a card.
CREATE FUNCTION public._order_has_bill_split(p_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT NOT EXISTS (
           SELECT 1 FROM order_item_field_allocations oifa
             JOIN order_items oi ON oi.id = oifa.order_item_id
            WHERE oi.order_id = p_order_id)
     AND (EXISTS (
           SELECT 1 FROM order_shares s JOIN orders o ON o.id = s.order_id
            WHERE s.order_id = p_order_id AND s.customer_id <> o.customer_id)
       OR EXISTS (
           SELECT 1 FROM order_item_shares x
             JOIN order_items oi ON oi.id = x.order_item_id
             JOIN orders o ON o.id = oi.order_id
            WHERE oi.order_id = p_order_id AND x.customer_id <> o.customer_id));
$function$;

CREATE FUNCTION public._order_bill_split_has_payer(p_order_id uuid, p_customer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (SELECT 1 FROM order_shares s WHERE s.order_id = p_order_id AND s.customer_id = p_customer_id)
      OR EXISTS (SELECT 1 FROM order_item_shares x JOIN order_items oi ON oi.id = x.order_item_id
                  WHERE oi.order_id = p_order_id AND x.customer_id = p_customer_id);
$function$;

-- One line's shares of p_cents and p_units (ten-thousandths): the line's own shares, else the card; any
-- share left over belongs to the main customer. The taker (the main customer, else the largest share)
-- gets the rest after everyone else rounds down, so each line adds up exactly. Each payer's cents are
-- exactly their percentage, rounded down. Other payers' quantity rounds down to whole hundredths, as a return
-- holds it; a share under 0.01 falls back to 4 places, as an invoice line holds it (Mason, 2026-11-09), so only a
-- share under 0.0001 comes back as 0 units with its cents, and the invoice writer refuses it. The taker comes first. A line
-- delivered past its planned quantity bills a capped total; each payer takes their percentage of it
-- (Mason restored exact cents over quantity times price, 2026-11-06).
CREATE FUNCTION public._bill_split_line_shares(p_order_item_id uuid, p_cents bigint, p_units bigint)
RETURNS TABLE (customer_id uuid, cents bigint, units bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  WITH line AS (
    SELECT oi.id, oi.order_id, o.customer_id AS main
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.id = p_order_item_id
  ), own AS (
    SELECT x.customer_id, x.split_percentage AS pct FROM order_item_shares x WHERE x.order_item_id = p_order_item_id
  ), named AS (
    SELECT * FROM own
    UNION ALL
    SELECT s.customer_id, s.split_percentage FROM order_shares s, line
     WHERE s.order_id = line.order_id AND NOT EXISTS (SELECT 1 FROM own)
  ), shares AS (
    SELECT n.customer_id, n.pct FROM named n
    UNION ALL
    SELECT line.main, 100 - (SELECT COALESCE(sum(pct), 0) FROM named) FROM line
  ), payers AS (
    SELECT s.customer_id, sum(s.pct) AS pct FROM shares s GROUP BY s.customer_id HAVING sum(s.pct) > 0
  ), ranked AS (
    SELECT p.customer_id,
           floor(p_cents * p.pct / 100)::bigint AS floor_cents,
           -- Whole hundredths when the share allows, so a return (2 places) takes it back in full; a share too
           -- small for 0.01 falls back to 4 places so it still bills (Mason, 2026-11-09).
           CASE WHEN floor(p_units * p.pct / 10000) > 0 THEN floor(p_units * p.pct / 10000)::bigint * 100
                ELSE floor(p_units * p.pct / 100)::bigint END AS floor_units,
           row_number() OVER (ORDER BY p.customer_id = line.main DESC, p.pct DESC, p.customer_id) AS rn
      FROM payers p, line
  )
  SELECT r.customer_id,
         CASE WHEN r.rn = 1 THEN p_cents - (SELECT COALESCE(sum(floor_cents), 0) FROM ranked WHERE rn > 1)
              ELSE r.floor_cents END::bigint,
         CASE WHEN r.rn = 1 THEN p_units - (SELECT COALESCE(sum(floor_units), 0) FROM ranked WHERE rn > 1)
              ELSE r.floor_units END::bigint
    FROM ranked r
   ORDER BY r.rn;
$function$;

-- Drafts one invoice per payer for a completed delivery on a Bill Split sale. Same governed path as a
-- field split: inside a creation claim, with a provenance row per invoice.
CREATE FUNCTION public._create_bill_split_delivery_invoices(p_delivery_id uuid, p_invoice_date date, p_actor uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_delivery record;
  v_order record;
  v_item record;
  v_share record;
  v_base text;
  v_group uuid := gen_random_uuid();
  v_map jsonb := '{}'::jsonb;
  v_invoice_id uuid;
  v_ids uuid[] := '{}';
  v_line_cents bigint;
  v_line_units bigint;
BEGIN
  SELECT * INTO STRICT v_delivery FROM deliveries WHERE id = p_delivery_id;
  SELECT * INTO STRICT v_order FROM orders WHERE id = v_delivery.order_id;

  -- As for field splits: price_order sweeps a draft's lines and can't touch a governed split, so a
  -- price-later (rush) sale is priced first; Create Invoice on the delivery drafts the payers then.
  IF EXISTS (SELECT 1 FROM order_items WHERE order_id = v_order.id AND pricing_pending) THEN
    RAISE EXCEPTION 'PRICING_INCOMPLETE: price the order before its Bill Split invoices are drafted';
  END IF;
  -- Never dated into a closed month (Mason, 2026-11-09).
  PERFORM check_period_open(p_invoice_date);

  INSERT INTO split_invoice_creation_claims (transaction_id, order_id) VALUES (pg_current_xact_id(), v_order.id);
  v_base := next_invoice_number('chemical_sale');

  FOR v_item IN
    SELECT di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id, di.tote_number,
           oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name, oi.unit_size AS oi_unit_size,
           p.product_name AS p_name, p.is_rup
      FROM delivery_items di
      JOIN order_items oi ON oi.id = di.order_item_id
      JOIN products p ON p.id = di.product_id
     WHERE di.delivery_id = p_delivery_id
       AND COALESCE(di.quantity_delivered, 0) > 0
     ORDER BY di.id
  LOOP
    v_line_cents := _allocated_delivery_cents(v_item.order_item_id, v_item.quantity_delivered, NULL);
    v_line_units := round(v_item.quantity_delivered * 10000)::bigint;
    -- The real delivered amount bills (Mason, 2026-11-09); only one finer than an invoice line holds can't split exactly.
    IF v_item.quantity_delivered <> round(v_item.quantity_delivered, 4) THEN
      RAISE EXCEPTION 'BILL_SPLIT_QUANTITY_TOO_FINE: delivery % delivered % of %, finer than an invoice line holds (4 places); correct it with Fix Delivery',
        v_delivery.delivery_number, v_item.quantity_delivered, COALESCE(v_item.oi_product_name, v_item.p_name)
        USING ERRCODE = 'check_violation';
    END IF;
    FOR v_share IN
      SELECT c.customer_id, c.cents, c.units
        FROM _bill_split_line_shares(v_item.order_item_id, v_line_cents, v_line_units)
             WITH ORDINALITY c(customer_id, cents, units, n)
       ORDER BY c.n
    LOOP
      CONTINUE WHEN v_share.cents = 0 AND v_share.units = 0;
      -- A share worth cents on no quantity an invoice line can hold refuses, so no billed money sits on nothing;
      -- the office adjusts the shares.
      IF v_share.units = 0 THEN
        RAISE EXCEPTION 'BILL_SPLIT_QUANTITY_TOO_SMALL: on delivery % a payer''s share of % is under 0.0001 of a unit; change the shares so each payer gets at least 0.0001',
          v_delivery.delivery_number, COALESCE(v_item.oi_product_name, v_item.p_name)
          USING ERRCODE = 'check_violation';
      END IF;
      v_invoice_id := (v_map ->> v_share.customer_id::text)::uuid;
      IF v_invoice_id IS NULL THEN
        INSERT INTO invoices (invoice_number, invoice_type, order_id, customer_id, delivery_id, status, invoice_date,
          season, salesman_id, total_amount_cents, total_cost_cents, created_by, invoice_group_id)
        VALUES (v_base || '-' || (cardinality(v_ids) + 1), 'chemical_sale', v_order.id, v_share.customer_id, p_delivery_id,
          'draft', p_invoice_date, compute_season(p_invoice_date), v_order.salesman_id,
          0, 0, p_actor, v_group)
        RETURNING id INTO v_invoice_id;
        v_map := v_map || jsonb_build_object(v_share.customer_id::text, v_invoice_id);
        v_ids := v_ids || v_invoice_id;
      END IF;
      INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents,
        extended_cents, cost_cents, unit_size, tote_number)
      VALUES (v_invoice_id, v_item.order_item_id, v_item.product_id, COALESCE(v_item.oi_product_name, v_item.p_name),
        v_share.units::numeric / 10000, ROUND(v_item.price_per_unit * 100)::bigint, v_share.cents,
        ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint, COALESCE(v_item.oi_unit_size, 'ea'), v_item.tote_number);
    END LOOP;
  END LOOP;
  IF cardinality(v_ids) = 0 THEN
    DELETE FROM split_invoice_creation_claims WHERE transaction_id = pg_current_xact_id();
    RETURN v_ids;
  END IF;

  -- Cost is the sum of each payer's own lines, as on every invoice and in the month-end report (Mason,
  -- 2026-11-05: Option 1). See the header for how far it can top the line's cost across payers.
  UPDATE invoices i
     SET total_amount_cents = t.cents, total_cost_cents = t.cost
    FROM (SELECT ii.invoice_id, sum(ii.extended_cents)::bigint AS cents,
                 sum(ROUND(ii.cost_cents * ii.quantity))::bigint AS cost
            FROM invoice_items ii
           WHERE ii.invoice_id = ANY (v_ids)
           GROUP BY ii.invoice_id) t
   WHERE i.id = t.invoice_id;

  INSERT INTO split_invoice_provenance (invoice_id, order_id, invoice_group_id, customer_id, invoice_type, season,
    total_amount_cents, content_claim, created_by)
  SELECT i.id, i.order_id, i.invoice_group_id, i.customer_id, i.invoice_type, i.season, i.total_amount_cents,
         _split_invoice_content_claim(i.id), p_actor
    FROM invoices i WHERE i.id = ANY (v_ids);

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  SELECT 'invoice_created', 'invoice', i.id, (SELECT role FROM profiles WHERE id = p_actor),
         jsonb_build_object('invoice_number', i.invoice_number, 'delivery_id', p_delivery_id, 'order_id', i.order_id,
           'customer_id', i.customer_id, 'total_cents', i.total_amount_cents, 'group_id', v_group, 'split_basis', 'bill_split'),
         i.total_amount_cents,
         'Invoice ' || i.invoice_number || ' drafted from the Bill Split on delivery ' || v_delivery.delivery_number
    FROM invoices i WHERE i.id = ANY (v_ids);

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('split_invoices_auto_created',
    cardinality(v_ids) || ' Bill Split invoices drafted on delivery ' || v_delivery.delivery_number,
    p_actor, 'order', v_order.id, v_order.customer_id);

  DELETE FROM split_invoice_creation_claims WHERE transaction_id = pg_current_xact_id();
  RETURN v_ids;
END;
$function$;

-- A draft's product lines as they bill and cost. Charge lines (no product, no order line) are free to change.
CREATE FUNCTION public._bill_split_product_lines(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_array(ii.order_item_id, ii.product_id, ii.description, ii.quantity,
                                    ii.unit_price_cents, ii.extended_cents, ii.cost_cents)
                  ORDER BY ii.order_item_id, ii.quantity, ii.extended_cents, ii.description), '[]'::jsonb)
    FROM invoice_items ii
   WHERE ii.invoice_id = p_invoice_id
     AND ii.charge_type IS NULL;
$function$;

-- A field split wins over a card only until the card freezes: past that it would take the rest of a
-- part-billed sale away from the split that billed its first delivery.
CREATE FUNCTION public.guard_bill_split_field_switch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_id uuid := (SELECT order_id FROM order_items WHERE id = NEW.order_item_id);
BEGIN
  IF public._order_has_bill_split(v_order_id) THEN
    PERFORM public._refuse_bill_split_change(v_order_id);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_oifa_bill_split_freeze
  BEFORE INSERT OR UPDATE OF order_item_id ON public.order_item_field_allocations
  FOR EACH ROW EXECUTE FUNCTION public.guard_bill_split_field_switch();

REVOKE ALL ON FUNCTION public.guard_bill_split_field_switch() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._bill_split_product_lines(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._refuse_bill_split_change(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_order_item_shares() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_order_item_bill_split_move() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._order_has_bill_split(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._order_bill_split_has_payer(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._bill_split_line_shares(uuid, bigint, bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._create_bill_split_delivery_invoices(uuid, date, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_invoice_terminal_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_status text;
  v_order_number text;
  v_order_deleted_at timestamptz;
  v_order_customer_id uuid;
  v_canonical_cancel_cleanup boolean := false;
  v_canonical_void_cleanup boolean := false;
  v_canonical_delete_cleanup boolean := false;
  v_existing_accounting_update boolean := false;
  v_valid_delivery_lineage boolean := false;
  v_valid_completed_delivery boolean := false;
  v_has_writer_capability boolean := false;
  v_has_poster_capability boolean := false;
  -- Governed split (20261021150000): see the lineage test below.
  v_split_identity_kept boolean := false;
  v_governed_split_customer boolean := false;
  -- Split-payer return credit (20261021155000): see the lineage test below.
  v_split_payer_credit boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
  ) THEN
    RAISE EXCEPTION 'INVOICE_SOURCE_LINEAGE_IMMUTABLE: order_id and delivery_id cannot change after invoice creation';
  END IF;
  -- An invoice keeps the type it was created with (Mason, 2026-11-06), except that a draft may switch
  -- between chemical sale and misc charge, as the invoice editor offers. Otherwise a credit memo
  -- retyped as a sale would bill one customer past the Bill Split checks, which run on insert.
  IF TG_OP = 'UPDATE' AND NEW.invoice_type IS DISTINCT FROM OLD.invoice_type
     AND NOT (OLD.status = 'draft' AND OLD.invoice_type IN ('chemical_sale', 'misc_charge') AND NEW.invoice_type IN ('chemical_sale', 'misc_charge')) THEN
    RAISE EXCEPTION 'INVOICE_TYPE_IMMUTABLE: an invoice keeps its type; void it and create the right one'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Bill Split: a sale invoice joins a group only inside the split writer's claim, or a one-customer
  -- draft given a made-up group id would pass the Bill Split checks. Leaving a group stays open.
  IF TG_OP = 'UPDATE' AND NEW.invoice_type IN ('chemical_sale', 'misc_charge')
     AND NEW.invoice_group_id IS NOT NULL AND NEW.invoice_group_id IS DISTINCT FROM OLD.invoice_group_id
     AND NOT EXISTS (SELECT 1 FROM public.split_invoice_creation_claims claim
                      WHERE claim.transaction_id = pg_current_xact_id() AND claim.order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'INVOICE_GROUP_ASSIGN_REQUIRES_SPLIT: a sale invoice joins a group only when the split drafts it'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.order_id IS NULL THEN
    IF NEW.delivery_id IS NOT NULL THEN
      RAISE EXCEPTION 'INVOICE_DELIVERY_ORDER_REQUIRED: a delivery-linked invoice must retain its source order';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT status, order_number, deleted_at, customer_id
      INTO v_order_status, v_order_number, v_order_deleted_at, v_order_customer_id
      FROM public.orders
     WHERE id = NEW.order_id
     FOR UPDATE;
  ELSE
    SELECT status, order_number, deleted_at, customer_id
      INTO v_order_status, v_order_number, v_order_deleted_at, v_order_customer_id
      FROM public.orders
     WHERE id = NEW.order_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot attach an invoice to missing order %', NEW.order_id;
  END IF;
  -- Bill Split (billing plan M2): a sale with payers other than its customer bills through
  -- one draft per payer, never as one invoice to the customer. A grouped invoice is created only
  -- inside the split writer's claim for this transaction and order: a made-up group id isn't a split.
  IF TG_OP = 'INSERT' AND NEW.invoice_type IN ('chemical_sale', 'misc_charge')
     AND (NEW.invoice_group_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.split_invoice_creation_claims claim
        WHERE claim.transaction_id = pg_current_xact_id() AND claim.order_id = NEW.order_id))
     AND public._order_has_bill_split(NEW.order_id) THEN
    RAISE EXCEPTION 'ORDER_HAS_BILL_SPLIT: this sale has a bill split, so it cannot be billed as one invoice';
  END IF;
  -- Governed split (20261021150000): a split invoice (invoice_group_id set) may name a field owner
  -- other than the customer of its order, and only that invoice. While the split RPC creates or
  -- totals it: inside its claim for this transaction and order, for a customer the field split of
  -- this order bills (the billing-default customers of a field, or the customer of the field when
  -- it has none, as the split implementation resolves them). Afterwards: only as the invoice its
  -- private provenance row names. Its customer and group never change through this exception.
  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id AND NEW.invoice_group_id IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      v_split_identity_kept := true;
    ELSE
      v_split_identity_kept := NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
        AND NEW.invoice_group_id IS NOT DISTINCT FROM OLD.invoice_group_id;
      v_governed_split_customer := v_split_identity_kept AND EXISTS (
        SELECT 1
          FROM public.split_invoice_provenance p
         WHERE p.invoice_id = NEW.id
           AND p.order_id = NEW.order_id
           AND p.customer_id = NEW.customer_id
           AND p.invoice_group_id = NEW.invoice_group_id
      );
    END IF;
    IF v_split_identity_kept AND NOT v_governed_split_customer THEN
      v_governed_split_customer := EXISTS (
        SELECT 1
          FROM public.split_invoice_creation_claims claim
         WHERE claim.transaction_id = pg_current_xact_id()
           AND claim.order_id = NEW.order_id
      ) AND (public._order_bill_split_has_payer(NEW.order_id, NEW.customer_id) OR EXISTS (
        SELECT 1
          FROM public.order_item_field_allocations oifa
          JOIN public.order_items oi ON oi.id = oifa.order_item_id
         WHERE oi.order_id = NEW.order_id
           AND (
             EXISTS (
               SELECT 1 FROM public.field_billing_defaults fbd
                WHERE fbd.field_id = oifa.field_id
                  AND fbd.customer_id = NEW.customer_id
             )
             OR (
               NOT EXISTS (SELECT 1 FROM public.field_billing_defaults fbd WHERE fbd.field_id = oifa.field_id)
               AND EXISTS (
                 SELECT 1 FROM public.fields f
                  WHERE f.id = oifa.field_id
                    AND f.customer_id = NEW.customer_id
               )
             )
           )
      ));
    END IF;
  END IF;
  -- Split-payer return credit (20261021155000): the credit memo for a return by a field owner who
  -- is not the order's customer. Created: only inside issue_return_credit's claim for this
  -- transaction, order and customer. Afterwards (apply, unapply, void): only as the credit memo of a
  -- return for that order and customer, with its customer unchanged and never as a split invoice.
  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id AND NOT v_governed_split_customer
     AND NEW.invoice_type = 'credit_memo' AND NEW.invoice_group_id IS NULL
     AND (TG_OP = 'INSERT' OR (
       OLD.invoice_type = 'credit_memo'
       AND OLD.invoice_group_id IS NULL
       AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
     )) THEN
    v_split_payer_credit := EXISTS (
      SELECT 1
        FROM public.return_credit_customer_claims claim
       WHERE claim.transaction_id = pg_current_xact_id()
         AND claim.order_id = NEW.order_id
         AND claim.customer_id = NEW.customer_id
    ) OR (TG_OP = 'UPDATE' AND EXISTS (
      SELECT 1
        FROM public.returns r
       WHERE r.credit_invoice_id = NEW.id
         AND r.order_id = NEW.order_id
         AND r.customer_id = NEW.customer_id
    ));
  END IF;
  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id AND NOT v_governed_split_customer
     AND NOT v_split_payer_credit THEN
    RAISE EXCEPTION 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID: invoice and order customer must match';
  END IF;

  IF NEW.delivery_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.deliveries d
       WHERE d.id = NEW.delivery_id
         AND d.order_id = NEW.order_id
         AND (d.customer_id = NEW.customer_id
              OR (v_governed_split_customer AND d.customer_id = v_order_customer_id AND public._order_has_bill_split(NEW.order_id)))
         AND d.deleted_at IS NULL
    ), EXISTS (
      SELECT 1 FROM public.deliveries d
       WHERE d.id = NEW.delivery_id
         AND d.order_id = NEW.order_id
         AND (d.customer_id = NEW.customer_id
              OR (v_governed_split_customer AND d.customer_id = v_order_customer_id AND public._order_has_bill_split(NEW.order_id)))
         AND d.status = 'completed'
         AND d.deleted_at IS NULL
    ) INTO v_valid_delivery_lineage, v_valid_completed_delivery;
    IF NOT v_valid_delivery_lineage THEN
      RAISE EXCEPTION 'INVOICE_DELIVERY_LINEAGE_INVALID: delivery, order, and customer must match';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.invoice_delivery_recovery_capabilities c
     WHERE c.transaction_id = txid_current()
       AND c.purpose = 'writer'
       AND c.delivery_id = NEW.delivery_id
       AND c.actor_id = auth.uid()
  ), EXISTS (
    SELECT 1 FROM public.invoice_delivery_recovery_capabilities c
     WHERE c.transaction_id = txid_current()
       AND c.purpose = 'poster'
       AND c.delivery_id = NEW.delivery_id
       AND c.actor_id = auth.uid()
  ) INTO v_has_writer_capability, v_has_poster_capability;

  IF TG_OP = 'UPDATE' THEN
    v_canonical_cancel_cleanup :=
      OLD.status IN ('draft', 'unposted')
      AND NEW.status = 'cancelled'
      AND NEW.total_amount_cents = 0
      AND NEW.paid_amount_cents = 0
      AND NEW.prepay_applied_cents = 0
      AND NEW.write_off_cents = 0
      AND NEW.credit_applied_cents = 0
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

    v_canonical_void_cleanup :=
      OLD.status NOT IN ('cancelled', 'voided')
      AND NEW.status = 'voided'
      AND NEW.total_amount_cents = 0
      AND NEW.paid_amount_cents = 0
      AND NEW.prepay_applied_cents = 0
      AND NEW.write_off_cents = 0
      AND NEW.credit_applied_cents = 0
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

    v_canonical_delete_cleanup :=
      OLD.deleted_at IS NULL
      AND NEW.deleted_at IS NOT NULL
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_amount_cents IS NOT DISTINCT FROM OLD.total_amount_cents
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

    -- A posted invoice may legitimately survive an order cancellation. Keep
    -- payment state, due dates, and other accounting metadata maintainable,
    -- while forbidding a draft from being activated or any source/amount rewrite.
    v_existing_accounting_update :=
      OLD.status IN ('posted', 'overdue', 'paid')
      AND NEW.status IN ('posted', 'overdue', 'paid')
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_amount_cents IS NOT DISTINCT FROM OLD.total_amount_cents
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;
  END IF;

  -- Exact historical exception: only the canonical recovery writer/poster may
  -- touch a matching completed-delivery invoice on a soft-deleted, otherwise
  -- fulfilled order. Cancelled and voided orders never receive this bypass.
  IF v_order_deleted_at IS NOT NULL
     AND v_order_status IN ('fulfilled', 'partially_fulfilled')
     AND v_valid_completed_delivery
     AND auth.uid() IS NOT NULL
     AND (
       (TG_OP = 'INSERT' AND v_has_writer_capability)
       OR (TG_OP = 'UPDATE' AND (v_has_writer_capability OR v_has_poster_capability))
     ) THEN
    RETURN NEW;
  END IF;

  IF v_order_status IN ('cancelled', 'voided') OR v_order_deleted_at IS NOT NULL THEN
    IF v_canonical_cancel_cleanup
       OR v_canonical_void_cleanup
       OR v_canonical_delete_cleanup
       OR v_existing_accounting_update THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot attach or update a nonterminal invoice on cancelled, voided, or deleted order %',
      COALESCE(v_order_number, NEW.order_id::text);
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public._complete_delivery_authorized_impl(p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_qty_to_deliver numeric;
  v_deduct_from_prebooked numeric;
  v_any_partial boolean := false;
  v_all_delivered boolean;
  v_linked_invoice record;
  v_result jsonb;
  v_existing jsonb;
  v_actor uuid;
  v_actor_role text;
  v_auto_invoice_id uuid;
  v_auto_invoice_number text;
  v_bill_split_ids uuid[];
  v_bill_split_failed boolean := false;
  v_auto_total_cents bigint := 0;
  v_auto_cost_cents bigint := 0;
  -- CRX-MONEY-LIFECYCLE-001: cents allocated to THIS delivery from the order
  -- line's stored total, rather than re-extended from price x quantity.
  v_line_alloc_cents bigint := 0;
  v_existing_active_invoice_count int;
  v_closed_period record;
  v_admin record;
  -- U9 stock-policy WARN-NOT-BLOCK
  v_short_count int := 0;
  v_stock_warnings text[] := '{}';
  v_short_product_ids uuid[] := '{}';
  v_effective_completion_date date;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  -- U15: optional backdate. Reject future timestamps (small clock-skew allowance);
  -- NULL = legacy behavior (now()/CURRENT_DATE).
  IF p_completed_at IS NOT NULL AND p_completed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'COMPLETED_AT_IN_FUTURE: completion time cannot be in the future';
  END IF;

  v_effective_completion_date := COALESCE(
    (p_completed_at AT TIME ZONE 'America/Chicago')::date,
    (now() AT TIME ZONE 'America/Chicago')::date
  );

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'complete_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  IF v_delivery.status != 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be in_progress to complete (current status: %). Call confirm_delivery() first.', v_delivery.status;
  END IF;

  -- PR-01 fix: column is `scheduled_date`, not `delivery_date`.
  SELECT id, period_start, period_end
    INTO v_closed_period
    FROM accounting_periods
   WHERE status = 'closed'
     AND v_effective_completion_date BETWEEN period_start AND period_end
   LIMIT 1;

  IF FOUND THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'backdated_delivery_in_closed_period',
      'WARNING: Delivery ' || v_delivery.delivery_number ||
        ' completed for ' || v_effective_completion_date::text ||
        ' which falls in CLOSED accounting period ' ||
        v_closed_period.period_start::text || ' to ' ||
        v_closed_period.period_end::text || '. Operation proceeded; verify with finance.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );

    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Backdated Delivery Completion',
        'Delivery ' || v_delivery.delivery_number ||
          ' was completed for ' || v_effective_completion_date::text ||
          ' — that date is inside a CLOSED accounting period (' ||
          v_closed_period.period_start::text || ' to ' ||
          v_closed_period.period_end::text || '). Inventory and lifecycle ' ||
          'changes proceeded. Verify the financial impact.',
        'period_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  FOR v_item IN
    SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;
    IF v_qty_to_deliver < v_item.quantity THEN v_any_partial := true; END IF;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;
    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;
    -- U9: WARN-NOT-BLOCK (was: RAISE EXCEPTION 'Insufficient inventory ...').
    -- Same on-hand math; completion proceeds and stock is allowed to go negative.
    IF NOT FOUND OR COALESCE(v_inv.quantity_available, 0) < v_qty_to_deliver THEN
      v_short_count := v_short_count + 1;
      v_short_product_ids := array_append(v_short_product_ids, v_item.product_id);
      v_stock_warnings := array_append(v_stock_warnings,
        v_item.product_name || ': need ' || v_qty_to_deliver || ', only ' ||
        COALESCE(v_inv.quantity_available, 0) || ' on-hand');
      -- U9 (Codex R2 P2): seed a zero row when missing so the deduction UPDATE
      -- below lands and the on-hand aggregate goes visibly negative.
      IF NOT FOUND THEN
        INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, manufactured_at_delivery)
        VALUES (v_item.product_id, 'Main Warehouse', 0, 0, true)  -- surfaces on /integrity-cleanup (P4-7 phantom-row flag)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  -- P2-D: authorize the post-completion delivery_items + lifecycle writes below.
  -- The enforce_delivery_items_parent_lock trigger blocks writes to a
  -- non-scheduled delivery's items; complete_delivery legitimately records
  -- quantity_delivered after flipping status to 'completed', so it sets the
  -- canonical admin_override escape hatch (transaction-local).
  SET LOCAL app.admin_override = 'true';

  UPDATE deliveries SET
    status = 'completed', completed_at = COALESCE(p_completed_at, now()), signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  FOR v_item IN
    SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;
    UPDATE delivery_items SET quantity_delivered = v_qty_to_deliver, quantity_prebooked_released = 0 WHERE id = v_item.id;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;

    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_qty_to_deliver,
      quantity_remaining = GREATEST(quantity_remaining - v_qty_to_deliver, 0)
    WHERE id = v_item.order_item_id;

    -- U9: flag the delivered ledger row for review when the product was short.
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes, requires_review
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE '' END ||
        CASE WHEN v_item.product_id = ANY(v_short_product_ids)
          THEN ' [SHORT STOCK — review required]' ELSE '' END ||
        '. Signed by: ' || p_signed_by,
      v_item.product_id = ANY(v_short_product_ids)
    );

    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
    v_deduct_from_prebooked := LEAST(v_qty_to_deliver, COALESCE(v_inv.quantity_prebooked, 0));
    -- KI-94 (20261106230000): record what this line takes from the reservation; void_delivery puts back exactly this.
    UPDATE delivery_items SET quantity_prebooked_released = v_deduct_from_prebooked WHERE id = v_item.id;

    UPDATE inventory SET
      quantity_available = quantity_available - v_qty_to_deliver,
      quantity_prebooked = quantity_prebooked - v_deduct_from_prebooked,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- U2 (Codex P2): with per-delivery invoices now possible on one order, the
  -- tote copy must NOT stamp a SIBLING delivery's invoice — scope it to this
  -- delivery's own invoice or an order-level one (delivery_id IS NULL), the
  -- same shape as the auto-invoice guard below. Return-credit lines are
  -- immutable accounting provenance, not delivery-sale lines to relabel.
  UPDATE invoice_items ii
  SET tote_number = di.tote_number
  FROM delivery_items di
  JOIN invoices inv ON inv.order_id = v_delivery.order_id AND inv.deleted_at IS NULL
    AND inv.invoice_type <> 'credit_memo'
    AND (inv.delivery_id = p_delivery_id OR inv.delivery_id IS NULL)
  WHERE di.delivery_id = p_delivery_id
    AND ii.invoice_id = inv.id
    AND di.order_item_id = ii.order_item_id
    AND di.tote_number IS NOT NULL;

  IF v_any_partial THEN
    FOR v_item IN
      SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id AND di.quantity_delivered < di.quantity
    LOOP
      INSERT INTO delivery_remainders (
        original_delivery_id, order_id, order_item_id,
        customer_id, product_id, quantity_remaining, unit_size
      ) VALUES (
        p_delivery_id, v_delivery.order_id, v_item.order_item_id,
        v_delivery.customer_id, v_item.product_id,
        v_item.quantity - v_item.quantity_delivered, v_item.unit_size
      );
    END LOOP;
  END IF;

  -- U2 #39: close out the remainder rows THIS follow-up delivery was created to satisfy.
  -- create_followup_delivery flips the parent's remainders 'pending'->'scheduled' and stamps
  -- followup_delivery_id = this delivery. Now that this delivery has completed, mark them
  -- 'fulfilled'. Any lines this follow-up ITSELF shorted are already captured as fresh
  -- 'pending' remainder rows by the v_any_partial INSERT above (original_delivery_id = this
  -- delivery), so this flip never loses outstanding quantity — it prevents the same shortfall
  -- being double-counted as both a stale 'scheduled' row and a new 'pending' row. Idempotent
  -- (guarded by status = 'scheduled'); targets rows disjoint from the ones just inserted.
  UPDATE delivery_remainders
     SET status = 'fulfilled', updated_at = now()
   WHERE followup_delivery_id = p_delivery_id
     AND status = 'scheduled';

  -- P2 fix (Codex 2026-07-10): serialize concurrent same-day FINAL deliveries on the SAME
  -- order. Two deliveries completing at once each read v_all_delivered under READ COMMITTED
  -- without seeing the other's uncommitted order_items decrement, so both could compute
  -- false and skip the Feature A auto-split (order falls back to manual split-billing — safe,
  -- but the auto-split silently doesn't fire). Take the orders row lock BEFORE the read: the
  -- second completion blocks here until the first commits, then sees the committed decrement.
  -- Lock ORDER is unchanged (deliveries -> inventory -> orders): the UPDATE orders just below
  -- already acquired this same row lock — this only moves the acquisition ahead of the read,
  -- adding no new lock pair (no new deadlock surface).
  IF v_delivery.order_id IS NOT NULL THEN
    PERFORM 1 FROM orders WHERE id = v_delivery.order_id FOR UPDATE;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  IF v_any_partial AND v_delivery.order_id IS NOT NULL THEN
    FOR v_linked_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id AND status = 'draft' AND delivery_id = p_delivery_id
    LOOP
      UPDATE invoice_items ii SET
        quantity = di.quantity_delivered,
        extended_cents = public._allocated_delivery_cents(
                           ii.order_item_id, di.quantity_delivered, ii.invoice_id)
      FROM delivery_items di
      WHERE di.delivery_id = p_delivery_id AND ii.invoice_id = v_linked_invoice.id AND ii.order_item_id = di.order_item_id;
      -- Overnight bug-hunt LOW (20260620): also recompute the stored header cost so
      -- a partial completion doesn't leave total_cost_cents sized to the full qty.
      -- cost_cents is PER-UNIT cents; line cost = cost_cents * quantity (no *100).
      UPDATE invoices SET
        total_amount_cents = (SELECT COALESCE(SUM(extended_cents), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
        total_cost_cents = (SELECT COALESCE(SUM(cost_cents * quantity), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
        updated_at = now()
      WHERE id = v_linked_invoice.id;
    END LOOP;
  END IF;

  IF v_delivery.order_id IS NOT NULL THEN
    -- U2 #34: per-DELIVERY-aware guard (was per-ORDER). Block only if THIS delivery already
    -- has an active invoice, or an ORDER-LEVEL invoice (delivery_id IS NULL) already covers
    -- the whole order. An active invoice tied to a DIFFERENT delivery must NOT block this
    -- delivery — otherwise a follow-up delivery of shorted product is never billed.
    SELECT COUNT(*) INTO v_existing_active_invoice_count
    FROM invoices
    WHERE order_id = v_delivery.order_id
      AND status NOT IN ('voided', 'cancelled')
      AND invoice_type <> 'credit_memo'
      AND deleted_at IS NULL
      AND (delivery_id = p_delivery_id OR delivery_id IS NULL);

    IF v_existing_active_invoice_count = 0 THEN
      -- U7 SAFE-SCOPE (#43): a field/acre-allocated order must NOT be mono-billed
      -- 100% to the primary customer (that dead-ends the landlord's payment). Skip the
      -- auto-draft, flag the order for a manual per-owner split-billing pass, and notify
      -- the office. Non-allocated orders keep the EXACT auto-draft in the ELSE below.
      IF EXISTS (
        SELECT 1 FROM order_item_field_allocations oifa
        JOIN order_items oi ON oi.id = oifa.order_item_id
        WHERE oi.order_id = v_delivery.order_id
      ) THEN
        -- Codex pre-ship HIGH fix: only auto-split when the delivery's EFFECTIVE date is TODAY.
        -- create_split_invoices_from_order stamps invoice_date = CURRENT_DATE and takes no date arg, so
        -- auto-splitting a BACKDATED completion (p_completed_at in a prior/closed period) would silently
        -- date the drafts today and shift AR aging/terms — while the mono-bill path (below) respects the
        -- backdate. A backdated allocated order falls through to flag+notify (the office creates the split
        -- manually, exactly as before Feature A); same-day completions (the common case) auto-split.
        IF v_all_delivered
           AND v_effective_completion_date = (now() AT TIME ZONE 'America/Chicago')::date THEN
          -- the whole order is now delivered TODAY -> auto-create the per-owner split DRAFTS via the proven engine.
          BEGIN
            -- Marks this automatic split so the split wrapper keeps the order's salesperson for a
            -- rep who completes another rep's delivery (20261014210000). Transaction-local; a failed
            -- split rolls it back with this block, and it is cleared right after a successful one.
            PERFORM set_config('crx.order_invoice_autosplit', v_delivery.order_id::text, true);
            PERFORM create_split_invoices_from_order(
              v_delivery.order_id, NULL, 'chemical_sale',
              COALESCE(p_idempotency_key, p_delivery_id::text) || ':autosplit'
            );
            PERFORM set_config('crx.order_invoice_autosplit', '', true);
            -- create_split_invoices_from_order creates draft invoices per owner, clears
            -- needs_split_billing, and writes its own activity_feed + financial_audit_log rows.
            -- Add ONE activity_feed row noting the auto-creation on this delivery completion.
            INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
            VALUES (
              'split_invoices_auto_created',
              'Delivery ' || v_delivery.delivery_number || ' completed the order — per-owner split DRAFT invoices were auto-created (review + post them).',
              v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
            );
          EXCEPTION WHEN OTHERS THEN
            -- Any reason the split cannot run yet (order not priced -> PRICING_INCOMPLETE, an
            -- edge race, a still-open sibling delivery, etc.): fall back to today's flag+notify.
            -- The subtransaction rolls back any partial split work; the delivery completion is UNAFFECTED.
        UPDATE orders SET needs_split_billing = true, updated_at = now()
          WHERE id = v_delivery.order_id;
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'order_needs_split_billing',
          'Delivery ' || v_delivery.delivery_number || ' completed on a multi-owner (field/acre) order — auto-invoice skipped; create split invoices from the order to bill each owner.',
          v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
        );
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (
            user_id, title, message, notification_type,
            related_entity_type, related_entity_id
          ) VALUES (
            v_admin.id,
            'Order needs split billing',
            'Delivery ' || v_delivery.delivery_number || ' completed on a field/acre-allocated order. The mono-bill auto-invoice was skipped — open the order and use "Create Split Invoices" to bill each owner their own payable invoice.',
            'split_billing', 'order', v_delivery.order_id
          );
        END LOOP;
        END;
      ELSE
        -- Partial delivery of an allocated order (product still remains): keep today's
        -- skip-and-queue exactly. (Per-delivery split billing for partial orders is a separate redesign.)
        UPDATE orders SET needs_split_billing = true, updated_at = now()
          WHERE id = v_delivery.order_id;
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'order_needs_split_billing',
          'Delivery ' || v_delivery.delivery_number || ' completed on a multi-owner (field/acre) order — auto-invoice skipped; create split invoices from the order to bill each owner.',
          v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
        );
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (
            user_id, title, message, notification_type,
            related_entity_type, related_entity_id
          ) VALUES (
            v_admin.id,
            'Order needs split billing',
            'Delivery ' || v_delivery.delivery_number || ' completed on a field/acre-allocated order. The mono-bill auto-invoice was skipped — open the order and use "Create Split Invoices" to bill each owner their own payable invoice.',
            'split_billing', 'order', v_delivery.order_id
          );
        END LOOP;
      END IF;
      ELSIF public._order_has_bill_split(v_delivery.order_id) THEN
        -- Billing plan M2: a Bill Split sale drafts one invoice per payer for this delivery. A failure here
        -- must not stop the driver completing the delivery: it rolls back only this block, and the office
        -- is told; Create Invoice on the delivery runs the same split again.
        BEGIN
          v_bill_split_ids := public._create_bill_split_delivery_invoices(p_delivery_id, v_effective_completion_date, v_actor);
          -- As Create Invoice does: the flag stays while another completed delivery is still unbilled.
          UPDATE orders SET needs_split_billing = false, updated_at = now()
           WHERE id = v_delivery.order_id AND needs_split_billing
             AND NOT EXISTS (
               SELECT 1 FROM deliveries d
                WHERE d.order_id = v_delivery.order_id AND d.id <> p_delivery_id
                  AND d.status = 'completed' AND d.deleted_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM invoices i
                     WHERE i.delivery_id = d.id AND i.status NOT IN ('voided', 'cancelled')
                       AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL));
        EXCEPTION WHEN OTHERS THEN
          v_bill_split_failed := true;
          INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
          VALUES ('bill_split_invoices_failed',
            'Delivery ' || v_delivery.delivery_number || ' completed, but its Bill Split invoices could not be drafted: ' || SQLERRM,
            v_actor, 'order', v_delivery.order_id, v_delivery.customer_id);
          FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
          LOOP
            INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
            VALUES (v_admin.id, 'Order needs split billing',
              'Delivery ' || v_delivery.delivery_number || ' completed, but its Bill Split invoices could not be drafted (' || SQLERRM || '). Use Create Invoice on the delivery.',
              'split_billing', 'order', v_delivery.order_id);
          END LOOP;
        END;
      ELSE
      v_auto_invoice_number := next_invoice_number('chemical_sale');
      INSERT INTO invoices (
        invoice_number, invoice_type, order_id, customer_id, delivery_id,
        status, invoice_date, total_amount_cents, total_cost_cents, created_by
      ) VALUES (
        v_auto_invoice_number, 'chemical_sale', v_delivery.order_id, v_delivery.customer_id, p_delivery_id,
        'draft', v_effective_completion_date, 0, 0, v_actor
      ) RETURNING id INTO v_auto_invoice_id;

      v_auto_total_cents := 0;
      v_auto_cost_cents := 0;
      FOR v_item IN
        SELECT di.id AS di_id, di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id, di.tote_number,
               oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name,
               p.product_name AS p_name
          FROM delivery_items di
          JOIN order_items oi ON oi.id = di.order_item_id
          JOIN products p ON p.id = di.product_id
         WHERE di.delivery_id = p_delivery_id
           AND COALESCE(di.quantity_delivered, 0) > 0
      LOOP
        v_line_alloc_cents := public._allocated_delivery_cents(
                                v_item.order_item_id, v_item.quantity_delivered, NULL);
        v_auto_total_cents := v_auto_total_cents + v_line_alloc_cents;
        v_auto_cost_cents  := v_auto_cost_cents  + ROUND(v_item.quantity_delivered * COALESCE(v_item.cost_per_unit, 0) * 100)::bigint;
        INSERT INTO invoice_items (
          invoice_id, order_item_id, product_id, description,
          quantity, unit_price_cents, extended_cents, cost_cents,
          unit_size, tote_number
        ) VALUES (
          v_auto_invoice_id, v_item.order_item_id, v_item.product_id,
          COALESCE(v_item.oi_product_name, v_item.p_name),
          v_item.quantity_delivered,
          ROUND(v_item.price_per_unit * 100)::bigint,
          v_line_alloc_cents,
          ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint,
          v_item.unit_size,
          v_item.tote_number
        );
      END LOOP;

      UPDATE invoices
         SET total_amount_cents = v_auto_total_cents,
             total_cost_cents   = v_auto_cost_cents
       WHERE id = v_auto_invoice_id;

      -- Overnight bug-hunt MED (20260620): provenance breadcrumb. Write the same
      -- financial_audit_log 'invoice_created' row create_invoice_from_order /
      -- create_invoice_for_unbilled_delivery write, so the append-only ledger
      -- records this auto-creator too (it previously logged only activity_feed).
      -- Draft-stage provenance; post_invoice still writes 'invoice_posted' later.
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_auto_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object(
          'invoice_number', v_auto_invoice_number,
          'delivery_id', p_delivery_id,
          'order_id', v_delivery.order_id,
          'customer_id', v_delivery.customer_id,
          'total_cents', v_auto_total_cents
        ),
        v_auto_total_cents,
        'Invoice ' || v_auto_invoice_number || ' auto-created on completion of delivery ' || v_delivery.delivery_number
      );
      END IF;
    END IF;
  END IF;

  -- U9: short-stock WARN emit (mirrors the backdated-period warn+notify pattern above).
  IF v_short_count > 0 THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'delivery_short_stock',
      'WARNING: Delivery ' || v_delivery.delivery_number || ' completed with ' || v_short_count ||
        ' product(s) short on stock: ' || array_to_string(v_stock_warnings, ' | ') ||
        '. Completion proceeded; on-hand inventory went negative — review with the warehouse.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );
    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Short Stock — Delivery ' || v_delivery.delivery_number,
        'Delivery ' || v_delivery.delivery_number || ' was completed but ' || v_short_count ||
          ' product(s) did not have enough on-hand stock: ' || array_to_string(v_stock_warnings, ' | ') ||
          '. The completion proceeded and inventory went negative; please review.',
        'stock_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number || ' completed. Signed by: ' || p_signed_by ||
      CASE WHEN v_any_partial THEN ' (partial delivery — remainders created)' ELSE '' END ||
      CASE WHEN v_auto_invoice_id IS NOT NULL THEN ' [draft invoice ' || v_auto_invoice_number || ' auto-created]' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- U9: additive result fields — warnings[] + short_stock_count.
  v_result := jsonb_build_object(
    'status', CASE WHEN v_any_partial THEN 'partial' ELSE 'completed' END,
    'delivery_id', p_delivery_id,
    'order_fulfilled', v_all_delivered,
    'auto_invoice', CASE
      WHEN v_auto_invoice_id IS NOT NULL THEN
        jsonb_build_object('invoice_id', v_auto_invoice_id, 'invoice_number', v_auto_invoice_number, 'total_cents', v_auto_total_cents)
      ELSE NULL
    END,
    'bill_split_failed', v_bill_split_failed,
    'bill_split_invoices', (SELECT jsonb_agg(jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number, 'total_cents', i.total_amount_cents) ORDER BY i.invoice_number)
                              FROM invoices i WHERE i.id = ANY (v_bill_split_ids)),
    'stock_warning', (v_short_count > 0),
    'short_stock_count', v_short_count,
    'warnings', to_jsonb(v_stock_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'complete_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._create_invoice_for_unbilled_delivery_impl_20260718(p_delivery_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_existing jsonb; v_delivery record; v_existing_count integer;
  v_invoice_id uuid; v_invoice_number text; v_total_cents bigint := 0;
  v_cost_cents bigint := 0; v_item record; v_result jsonb;
  -- CRX-MONEY-LIFECYCLE-001: see public._allocated_delivery_cents.
  v_line_alloc_cents bigint := 0;
  v_invoice_ids uuid[];
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin access required to create an invoice for a delivery'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;
  IF v_delivery.status != 'completed' THEN
    RAISE EXCEPTION 'Delivery is not completed (current status: %). Only completed deliveries can be invoiced retroactively.', v_delivery.status;
  END IF;
  IF v_delivery.order_id IS NULL THEN RAISE EXCEPTION 'Delivery has no order_id — cannot auto-invoice an orphan delivery'; END IF;
  PERFORM 1 FROM orders WHERE id = v_delivery.order_id FOR UPDATE;

  -- CODE-RABBIT FIX: child allocation inserts take a KEY SHARE lock on their
  -- parent item. Lock every item in stable id order before checking OIFA rows.
  PERFORM 1
    FROM order_items
   WHERE order_id = v_delivery.order_id
   ORDER BY id
   FOR UPDATE;

  -- The flag alone doesn't refuse a Bill Split sale: a field allocation removed after a part delivery
  -- leaves it set with no field split to bill through.
  IF ((SELECT COALESCE(needs_split_billing, false) FROM orders WHERE id = v_delivery.order_id)
      AND NOT public._order_has_bill_split(v_delivery.order_id))
     OR EXISTS (
       SELECT 1 FROM order_item_field_allocations oifa
       JOIN order_items oi ON oi.id = oifa.order_item_id
       WHERE oi.order_id = v_delivery.order_id
     ) THEN
    RAISE EXCEPTION 'ORDER_NEEDS_SPLIT_BILLING: delivery %''s order uses split billing — a single backfilled invoice would mono-bill it and mis-attribute AR. Create the split invoices through the split-billing flow instead.', v_delivery.delivery_number;
  END IF;

  SELECT COUNT(*) INTO v_existing_count FROM invoices
  WHERE order_id = v_delivery.order_id AND status NOT IN ('voided', 'cancelled')
    AND invoice_type <> 'credit_memo'
    AND (delivery_id = p_delivery_id OR delivery_id IS NULL) AND deleted_at IS NULL;
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'This delivery already has an active invoice (or an order-level invoice covers the whole order) — nothing to backfill. Find and review the existing invoice instead.';
  END IF;
  -- Billing plan M2: a Bill Split sale is drafted per payer, as completing the delivery does.
  IF public._order_has_bill_split(v_delivery.order_id) THEN
    v_invoice_ids := public._create_bill_split_delivery_invoices(
      p_delivery_id,
      -- Dated the day it runs, as a plain Create Invoice is (Mason, 2026-11-09): a rush sale billed after pricing
      -- lands in the month it was billed.
      (now() AT TIME ZONE 'America/Chicago')::date,
      v_actor);
    IF cardinality(v_invoice_ids) = 0 THEN
      RAISE EXCEPTION 'BILL_SPLIT_NOTHING_TO_BILL: delivery % delivered no quantity, so there is nothing to bill', v_delivery.delivery_number
        USING ERRCODE = 'check_violation';
    END IF;
    -- The flag stays while another completed delivery on the order is still unbilled.
    UPDATE orders SET needs_split_billing = false, updated_at = now()
     WHERE id = v_delivery.order_id AND needs_split_billing
       AND NOT EXISTS (
         SELECT 1 FROM deliveries d
          WHERE d.order_id = v_delivery.order_id AND d.id <> p_delivery_id
            AND d.status = 'completed' AND d.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM invoices i
               WHERE i.delivery_id = d.id AND i.status NOT IN ('voided', 'cancelled')
                 AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL));
    SELECT id, invoice_number INTO v_invoice_id, v_invoice_number FROM invoices WHERE id = v_invoice_ids[1];
    v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id,
      'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number, 'invoice_ids', to_jsonb(v_invoice_ids),
      'invoice_numbers', (SELECT jsonb_agg(invoice_number ORDER BY invoice_number) FROM invoices WHERE id = ANY (v_invoice_ids)),
      'total_cents', (SELECT sum(total_amount_cents) FROM invoices WHERE id = ANY (v_invoice_ids)));
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery', v_result);
    END IF;
    RETURN v_result;
  END IF;
  v_invoice_number := next_invoice_number('chemical_sale');
  INSERT INTO invoices (invoice_number, invoice_type, order_id, customer_id, delivery_id,
    status, invoice_date, total_amount_cents, total_cost_cents, created_by)
  VALUES (v_invoice_number, 'chemical_sale', v_delivery.order_id, v_delivery.customer_id,
    p_delivery_id, 'draft', (now() AT TIME ZONE 'America/Chicago')::date, 0, 0, v_actor) RETURNING id INTO v_invoice_id;
  FOR v_item IN
    SELECT di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id,
      oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name, p.product_name AS p_name
    FROM delivery_items di JOIN order_items oi ON oi.id = di.order_item_id
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id AND COALESCE(di.quantity_delivered, 0) > 0
  LOOP
    v_line_alloc_cents := public._allocated_delivery_cents(
                            v_item.order_item_id, v_item.quantity_delivered, NULL);
    v_total_cents := v_total_cents + v_line_alloc_cents;
    v_cost_cents := v_cost_cents + ROUND(v_item.quantity_delivered * COALESCE(v_item.cost_per_unit, 0) * 100)::bigint;
    INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents, unit_size)
    VALUES (v_invoice_id, v_item.order_item_id, v_item.product_id,
      COALESCE(v_item.oi_product_name, v_item.p_name), v_item.quantity_delivered,
      ROUND(v_item.price_per_unit * 100)::bigint,
      v_line_alloc_cents,
      ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint, v_item.unit_size);
  END LOOP;
  UPDATE invoices SET total_amount_cents = v_total_cents, total_cost_cents = v_cost_cents WHERE id = v_invoice_id;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description)
  VALUES ('invoice_created', 'invoice', v_invoice_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('invoice_number', v_invoice_number, 'delivery_id', p_delivery_id,
      'order_id', v_delivery.order_id, 'customer_id', v_delivery.customer_id, 'total_cents', v_total_cents),
    v_total_cents, 'Invoice ' || v_invoice_number || ' backfilled for completed delivery ' || v_delivery.delivery_number);
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_backfilled_for_delivery', 'Backfilled draft invoice ' || v_invoice_number ||
    ' for completed delivery ' || v_delivery.delivery_number, v_actor, 'invoice', v_invoice_id, v_delivery.customer_id);
  v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id,
    'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number, 'total_cents', v_total_cents);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._save_invoice_intent_impl_20260802(p_invoice jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_invoice_id uuid := NULLIF(p_invoice->>'id', '')::uuid;
  v_bill_split_draft boolean := false;
  v_lines_before jsonb;
  v_saved_id uuid;
BEGIN
  -- A retry replays its saved answer before the draft checks below, so a save whose response was lost still
  -- answers after the group posts (Sol, 6 Nov). save_invoice has already matched the key's actor and request.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT NULLIF(k.result->>'invoice_id', '')::uuid
      INTO v_saved_id
      FROM public.idempotency_keys k
     WHERE k.idempotency_key = p_idempotency_key
       AND k.operation = 'save_invoice'
       AND k.request_fingerprint IS NOT NULL;
    IF v_saved_id IS NOT NULL THEN
      RETURN v_saved_id;
    END IF;
  END IF;
  IF v_invoice_id IS NOT NULL THEN
    PERFORM 1
      FROM public.invoices i
     WHERE i.id = v_invoice_id
     FOR UPDATE;

    -- Billing plan M2: a Bill Split draft takes charges and header edits until it posts, and again once the
    -- group is unposted. The layer below already refreshes its provenance under a mutation claim.
    SELECT public._bill_split_product_lines(i.id)
      INTO v_lines_before
      FROM public.invoices i
     WHERE i.id = v_invoice_id
       AND i.status IN ('draft', 'unposted')
       AND i.delivery_id IS NOT NULL
       AND i.invoice_group_id IS NOT NULL
       AND public._order_has_bill_split(i.order_id);
    v_bill_split_draft := FOUND;
    -- A product line with no quantity can't pass the save path, which needs a quantity on every line. Refuse
    -- here in plain words; the group still posts as drafted, or a group void redrafts it.
    IF v_bill_split_draft AND EXISTS (
      SELECT 1 FROM public.invoice_items ii
       WHERE ii.invoice_id = v_invoice_id AND ii.charge_type IS NULL AND ii.quantity = 0
    ) THEN
      RAISE EXCEPTION 'BILL_SPLIT_SLIVER_LOCKED: this payer''s draft has a product line with no quantity, so it can''t be edited. Post it as drafted, or void the group'
        USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.split_invoice_provenance p
       WHERE p.invoice_id = v_invoice_id
    ) AND NOT v_bill_split_draft THEN
      RAISE EXCEPTION
        'SPLIT_INVOICE_EDIT_REQUIRES_REISSUE: governed split invoices cannot be edited; void the group and create a replacement'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  v_saved_id := public._save_invoice_governed_split_guard_impl_20260720(
    p_invoice,
    p_items,
    p_idempotency_key
  );

  IF v_bill_split_draft AND public._bill_split_product_lines(v_invoice_id) IS DISTINCT FROM v_lines_before THEN
    RAISE EXCEPTION
      'BILL_SPLIT_LINES_LOCKED: a Bill Split invoice''s product lines follow the split. Void the group to change them; charges can still be added.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN v_saved_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_invoices(p_invoice_ids uuid[], p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_contract CONSTANT text := 'delete_invoices_v1';
  v_request_ids uuid[] := '{}'::uuid[];
  v_request jsonb;
  v_fingerprint text;
  v_replay jsonb;
  v_deleted_count integer;
  v_governed_ids uuid[] := '{}'::uuid[];
  v_claim_count integer := 0;
BEGIN
  PERFORM public.require_admin();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT requested.invoice_id ORDER BY requested.invoice_id), '{}'::uuid[])
    INTO v_request_ids
    FROM unnest(COALESCE(p_invoice_ids, '{}'::uuid[])) AS requested(invoice_id)
   WHERE requested.invoice_id IS NOT NULL;
  IF cardinality(v_request_ids) = 0 THEN
    RAISE EXCEPTION 'No invoice IDs provided';
  END IF;

  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'invoice_ids', to_jsonb(v_request_ids)
  );
  v_fingerprint := md5(v_request::text);
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_bound_lifecycle_idempotency(
      p_idempotency_key,
      'delete_invoices',
      v_contract,
      v_fingerprint,
      v_request
    );
    IF v_replay IS NOT NULL THEN
      RETURN (v_replay #>> '{}')::integer;
    END IF;
  END IF;

  SELECT COALESCE(array_agg(p.invoice_id ORDER BY p.invoice_id), '{}'::uuid[])
    INTO v_governed_ids
    FROM public.split_invoice_provenance p
   WHERE p.invoice_id = ANY(v_request_ids);

  -- Billing plan M2: a Bill Split group's drafts stand or fall together. One gone would post the rest
  -- and leave that payer's share unbilled.
  IF EXISTS (
    SELECT 1
      FROM public.invoices member
      JOIN public.invoices other
        ON other.invoice_group_id = member.invoice_group_id
       AND other.deleted_at IS NULL
       AND other.id <> ALL (v_request_ids)
     WHERE member.id = ANY (v_governed_ids)
       AND member.invoice_group_id IS NOT NULL
       AND public._order_has_bill_split(member.order_id)
  ) THEN
    RAISE EXCEPTION 'BILL_SPLIT_GROUP_DELETE_PARTIAL: select every payer''s draft in this Bill Split group to delete them together'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.split_invoice_mutation_claims (
    transaction_id, invoice_id, operation
  )
  SELECT pg_current_xact_id(), governed.invoice_id, 'delete_invoices'
    FROM unnest(v_governed_ids) AS governed(invoice_id);

  v_deleted_count := public._delete_invoices_split_provenance_impl_20260719(
    v_request_ids,
    p_performed_by,
    NULL::text
  );

  UPDATE public.invoices i
     SET status = 'cancelled'
   WHERE i.id = ANY(v_governed_ids)
     AND i.deleted_at IS NOT NULL
     AND i.status IN ('draft', 'unposted');

  DELETE FROM public.split_invoice_mutation_claims claim
   WHERE claim.transaction_id = pg_current_xact_id()
     AND claim.operation = 'delete_invoices'
     AND claim.invoice_id = ANY(v_governed_ids);
  GET DIAGNOSTICS v_claim_count = ROW_COUNT;
  IF v_claim_count IS DISTINCT FROM cardinality(v_governed_ids) THEN
    RAISE EXCEPTION 'SPLIT_INVOICE_DELETE_CLAIM_LOST';
  END IF;

  IF cardinality(v_governed_ids) > 0
     AND NOT EXISTS (
       SELECT 1
         FROM public.split_invoice_provenance p
        WHERE p.invoice_id = ANY(v_governed_ids)
     ) THEN
    RAISE EXCEPTION 'SPLIT_INVOICE_PROVENANCE_IDENTITY_LOST';
  END IF;

  PERFORM public._bind_completed_lifecycle_idempotency(
    p_idempotency_key,
    'delete_invoices',
    v_contract,
    v_fingerprint,
    v_request,
    to_jsonb(v_deleted_count)
  );

  RETURN v_deleted_count;
END;
$function$;

-- A posted group unposts together, as it posts: the screens already call unpost_invoice_group, which calls
-- the inner function directly. Only this public entry refuses a member.
CREATE OR REPLACE FUNCTION public.unpost_invoice(
  p_invoice_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: unpost_invoice requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'invoice_id', p_invoice_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'unpost_invoice', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  -- A retry of an unpost saved before this migration replays; only a new request is refused.
  IF v_replay IS NULL AND EXISTS (SELECT 1 FROM invoices WHERE id = p_invoice_id AND invoice_group_id IS NOT NULL) THEN
    RAISE EXCEPTION 'GROUP_UNPOST_REQUIRED';
  END IF;
  v_result := public._unpost_invoice_replay_impl_20261015(p_invoice_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'unpost_invoice', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

-- _create_return_intent_impl_20260812: the 20261021155000 body, plus a refusal of a quantity finer than a return holds.
CREATE OR REPLACE FUNCTION public._create_return_intent_impl_20260812(p_return jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
      unit_price_cents, extended_cents, condition, restock, sort_order, notes
    ) VALUES (
      v_return_id, v_order_item.id, v_order_item.product_id, v_order_item.product_name,
      v_qty, coalesce(v_order_item.unit_size, 'ea'),
      v_unit_price,  -- Split-payer return (20261021155000): priced above
      v_extended,
      coalesce(v_item->>'condition', 'unopened'),
      coalesce((v_item->>'restock')::boolean, false),
      coalesce((v_item->>'sort_order')::integer, v_count), v_item->>'notes'
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

DO $postflight$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)', '_create_bill_split_delivery_invoices', ARRAY['postgres=X/postgres']::aclitem[]),
    ('public.guard_invoice_terminal_order()', '_order_bill_split_has_payer', ARRAY['postgres=X/postgres']::aclitem[]),
    ('public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)', '_create_bill_split_delivery_invoices', ARRAY['postgres=X/postgres']::aclitem[]),
    ('public._save_invoice_intent_impl_20260802(jsonb,jsonb,text)', 'BILL_SPLIT_LINES_LOCKED', ARRAY['postgres=X/postgres']::aclitem[]),
    ('public._validate_order_shares_total()', 'v_total > 100 THEN', ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[]),
    ('public.prevent_order_shares_edit_after_post()', '_refuse_bill_split_change', ARRAY['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::aclitem[]),
    ('public.delete_invoices(uuid[],uuid,text)', 'BILL_SPLIT_GROUP_DELETE_PARTIAL', ARRAY['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::aclitem[]),
    ('public.unpost_invoice(uuid,uuid,text)', 'GROUP_UNPOST_REQUIRED', ARRAY['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::aclitem[]),
    ('public._create_return_intent_impl_20260812(jsonb,jsonb,text)', 'RETURN_QUANTITY_TOO_FINE', ARRAY['postgres=X/postgres']::aclitem[])
  ) AS v(sig, marker, acl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = to_regprocedure(r.sig)
         AND position(r.marker IN p.prosrc) > 0
         AND p.proowner = 'postgres'::regrole
         AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND p.proacl = r.acl
    ) THEN
      RAISE EXCEPTION 'CHEM_SALE_BILL_SPLIT_POSTFLIGHT: % lost its change, owner, mode or grants', r.sig;
    END IF;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.order_item_shares'::regclass) THEN
    RAISE EXCEPTION 'CHEM_SALE_BILL_SPLIT_POSTFLIGHT: order_item_shares has no row security';
  END IF;
  IF has_table_privilege('authenticated', 'public.order_shares', 'TRUNCATE') THEN
    RAISE EXCEPTION 'CHEM_SALE_BILL_SPLIT_POSTFLIGHT: the card can still be truncated';
  END IF;
  IF has_function_privilege('authenticated', 'public._create_bill_split_delivery_invoices(uuid,date,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CHEM_SALE_BILL_SPLIT_POSTFLIGHT: the split writer must not be callable directly';
  END IF;
END
$postflight$;
