-- A4 + delivery price carry-over (Mason, Slack 25 Nov; Taha's calls 26 Nov; plan
-- docs/research/2026-11-25-chemical-sales-final-plan.md, "Billing what was delivered" and "Multi-delivery price").
--
-- 1. Carry-over. _allocated_delivery_cents priced a delivery's units as the line's allocation through every billed
--    unit MINUS the cents already billed, so a price change on one delivery's invoice was charged back on the next:
--    10 at $40, the first 6 billed at $35 ($210), the last 4 drafted at $190, not $160. Each chemical sale invoice now
--    records what the order line allocated to its units when it was drafted (invoice_order_line_allocations, filled by a
--    trigger on invoice_items; existing invoices backfilled from today's figures, totals checked unchanged), and the
--    telescoping counts that record instead of the billed cents. A price edit never moves another delivery's price;
--    voids and re-bills still sum to the line total exactly. Every caller is fixed at once: completion's auto-draft
--    and partial refresh, Create Invoice on a delivery and the Bill Split drafts.
-- 2. A4. The Unbilled list counted a delivery billed once any active invoice touched it: 10 delivered, the line
--    lowered to 6, and 4 units were never billed. delivery_billing_remainders compares delivered and billed units per
--    delivery and order line (product lines on active non-credit invoices bill, as the invoice caps count them; lines
--    naming the order line first, then editor-added
--    lines by product; whole-order lines cover the order's deliveries in completion order). Units of a received,
--    uncredited return are not owed (default until Mason rules). get_dashboard_action_items lists a delivery while
--    any unit is unbilled, and Create Invoice on such a delivery drafts exactly the rest on a new draft, at the order
--    line's allocation for the units after those already billed: on the delivery, or, when a whole-order invoice
--    covers the order, every unbilled unit on the order. A Bill Split sale is refused (BILL_SPLIT_REST_NOT_SUPPORTED);
--    a field split stays refused (ORDER_NEEDS_SPLIT_BILLING).
-- 3. Scope. create_invoice_for_unbilled_delivery takes p_expected_scope (new, rest_delivery or rest_order): the scope
--    the screen confirmed. A different scope at run time is refused (UNBILLED_SCOPE_CHANGED); the key binds it too.
--    NULL keeps the old behaviour. The three-argument chain is dropped and replaced (an overload would be ambiguous).
-- Nothing else is rewritten: invoices drafted before this file keep their cents.
--
-- actor-binding-check: exempt -- the repo hook's marker, not a waiver: the public create_invoice_for_unbilled_delivery
--   refuses a p_performed_by other than auth.uid() (ACTOR_MISMATCH) and the idempotency layer and the body re-check it
--   (unchanged lines).
-- idempotency-body-check: exempt -- the repo hook's marker, not a waiver: the public wrapper requires a key, and
--   _create_invoice_for_unbilled_delivery_idem_impl_20260721 binds it to the delivery, actor and expected scope
--   (IDEMPOTENCY_ARGUMENT_MISMATCH) before the body runs; the body's own key handling is unchanged.
-- caller-analysis: _allocated_delivery_cents :: same signature, result and grants; callers
--   _complete_delivery_authorized_impl_20270122, _create_invoice_for_unbilled_delivery_impl_20260718,
--   _create_bill_split_delivery_invoices get the same cents unless an earlier invoice's price was changed.
--   create_invoice_for_unbilled_delivery :: adds p_expected_scope DEFAULT NULL; the screens pass it, positional
--   three-argument callers keep working; result adds billed_rest and scope.
--   get_dashboard_action_items :: same signature and shape; unbilled_deliveries also lists short-billed deliveries.
--
-- ROLLBACK: scripts/smoke/unbilled-rest-and-carry-over-reverse.sql (proven by
--   scripts/smoke/prove-unbilled-rest-and-carry-over-real-schema.mjs).

CREATE TEMP TABLE unbilled_rest_carry_over_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_pin record;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.unbilled_rest_carry_over_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.unbilled_rest_carry_over_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regclass('public.delivery_billing_remainders') IS NOT NULL OR to_regclass('public.invoice_order_line_allocations') IS NOT NULL
     OR to_regprocedure('public.create_invoice_for_unbilled_delivery(uuid,uuid,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'UNBILLED_REST_BASELINE_DRIFT: already applied';
  END IF;
  FOR v_pin IN SELECT * FROM (VALUES
      ('public._allocated_delivery_cents(uuid,numeric,uuid)', '401b886a577bd0d6ded65a54b74ac759'),
      ('public._allocated_cumulative_cents(uuid,numeric)', 'ebe035d44594445026e12d26dcee6f06'),
      ('public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)', '41d6ec7fd81c96b8ab9bc1c1ae679245'),
      ('public._create_invoice_for_unbilled_delivery_idem_impl_20260721(uuid,uuid,text)', '0a5997370d8e708c2bf87ba4e1b29199'),
      ('public.create_invoice_for_unbilled_delivery(uuid,uuid,text)', 'a7f2531bd09ea6c650063f9661871caa'),
      ('public.get_dashboard_action_items(integer)', 'cd2cc3c9f43d5d9eee85730e06fcfb92')) t(sig, md5)
  LOOP
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure(v_pin.sig)) IS DISTINCT FROM v_pin.md5 THEN
      RAISE EXCEPTION 'UNBILLED_REST_BASELINE_DRIFT: % is not the body this file replaces', v_pin.sig;
    END IF;
  END LOOP;
END;
$preflight$;

-- 1. What the order line allocated to each chemical sale invoice's units of it, recorded when the invoice was drafted.
-- One row per invoice and order line. The invoice editor rebuilds a draft line by line (delete, then insert), so
-- the record is keyed by invoice and order line, not by the line row, and a later save never rewrites it; a save
-- that changes the quantity is counted pro rata by _allocated_delivery_cents. A database re-price of a line's
-- quantity (completing a delivery refreshes its pre-made draft) records the new figures.
CREATE TABLE public.invoice_order_line_allocations (
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE CASCADE,
  quantity numeric NOT NULL,
  allocated_cents bigint NOT NULL,
  -- The transaction that drafted the lines; only it adds to the record.
  created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY (invoice_id, order_item_id)
);
CREATE INDEX invoice_order_line_allocations_order_item_idx ON public.invoice_order_line_allocations (order_item_id);
ALTER TABLE public.invoice_order_line_allocations ENABLE ROW LEVEL SECURITY;
-- Readable with the invoice (the invoices policies decide); written only by the trigger below.
CREATE POLICY invoice_order_line_allocations_select ON public.invoice_order_line_allocations
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_order_line_allocations.invoice_id));
REVOKE ALL ON public.invoice_order_line_allocations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.invoice_order_line_allocations TO authenticated, service_role;
COMMENT ON TABLE public.invoice_order_line_allocations IS
  'A4 carry-over: the order line''s allocation (units, cents) for each chemical sale invoice, recorded when it was drafted. _allocated_delivery_cents telescopes on it, so an edited invoice price never moves the next delivery''s price.';

CREATE FUNCTION public._record_invoice_line_allocation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.order_item_id IS NULL
     OR (SELECT i.invoice_type FROM public.invoices i WHERE i.id = NEW.invoice_id) IS DISTINCT FROM 'chemical_sale' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- The drafting transaction adds each line it writes; a later save (delete + insert) leaves the record alone.
    INSERT INTO public.invoice_order_line_allocations AS a (invoice_id, order_item_id, quantity, allocated_cents)
    VALUES (NEW.invoice_id, NEW.order_item_id, COALESCE(NEW.quantity, 0), COALESCE(NEW.extended_cents, 0))
    ON CONFLICT (invoice_id, order_item_id) DO UPDATE
      SET quantity = a.quantity + EXCLUDED.quantity,
          allocated_cents = a.allocated_cents + EXCLUDED.allocated_cents
      WHERE a.created_xid = pg_current_xact_id();
  ELSIF NEW.quantity IS DISTINCT FROM OLD.quantity THEN
    -- A database re-price of the quantity (the editor never updates a line in place): record the line as it is now.
    INSERT INTO public.invoice_order_line_allocations AS a (invoice_id, order_item_id, quantity, allocated_cents)
    SELECT ii.invoice_id, ii.order_item_id, COALESCE(sum(ii.quantity), 0), COALESCE(sum(ii.extended_cents), 0)
      FROM public.invoice_items ii
     WHERE ii.invoice_id = NEW.invoice_id AND ii.order_item_id = NEW.order_item_id
     GROUP BY ii.invoice_id, ii.order_item_id
    ON CONFLICT (invoice_id, order_item_id) DO UPDATE
      SET quantity = EXCLUDED.quantity, allocated_cents = EXCLUDED.allocated_cents;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public._record_invoice_line_allocation() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER zz_record_invoice_line_allocation
  AFTER INSERT OR UPDATE OF quantity ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._record_invoice_line_allocation();

-- Backfill from today's figures: every existing chemical sale invoice records what its lines bill now, which is
-- what the old rule telescoped on, so no future draft changes for it. Nothing else is written; the check below
-- proves the invoice and line totals are untouched and the records add up to the lines' cents.
DO $backfill$
DECLARE
  v_before text;
  v_after text;
  v_lines bigint;
  v_cents numeric;
BEGIN
  SELECT md5(COALESCE(string_agg(i.id::text || ':' || i.total_amount_cents, ',' ORDER BY i.id), '')) || '/'
         || (SELECT md5(COALESCE(string_agg(ii.id::text || ':' || ii.quantity || ':' || ii.extended_cents, ',' ORDER BY ii.id), ''))
               FROM public.invoice_items ii)
    INTO v_before FROM public.invoices i;
  SELECT count(*), COALESCE(sum(ii.extended_cents), 0) INTO v_lines, v_cents
    FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE ii.order_item_id IS NOT NULL AND i.invoice_type = 'chemical_sale';

  INSERT INTO public.invoice_order_line_allocations (invoice_id, order_item_id, quantity, allocated_cents, created_xid)
  SELECT ii.invoice_id, ii.order_item_id, COALESCE(sum(ii.quantity), 0), COALESCE(sum(ii.extended_cents), 0), '0'::xid8
    FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE ii.order_item_id IS NOT NULL AND i.invoice_type = 'chemical_sale'
   GROUP BY ii.invoice_id, ii.order_item_id;

  SELECT md5(COALESCE(string_agg(i.id::text || ':' || i.total_amount_cents, ',' ORDER BY i.id), '')) || '/'
         || (SELECT md5(COALESCE(string_agg(ii.id::text || ':' || ii.quantity || ':' || ii.extended_cents, ',' ORDER BY ii.id), ''))
               FROM public.invoice_items ii)
    INTO v_after FROM public.invoices i;
  IF v_after IS DISTINCT FROM v_before
     OR (SELECT COALESCE(sum(allocated_cents), 0) FROM public.invoice_order_line_allocations) IS DISTINCT FROM v_cents THEN
    RAISE EXCEPTION 'UNBILLED_REST_BACKFILL_FAIL: invoice totals moved or the records do not add up';
  END IF;
  RAISE NOTICE 'UNBILLED_REST_BACKFILL_OK lines=% cents=%', v_lines, v_cents;
END;
$backfill$;

-- 2. One row per completed delivery, order line and product: units delivered, billed, returned before billing and
-- not billed yet, and the cents billing the rest would add. Product lines on active invoices bill, credit memos never:
-- a miscellaneous charge naming a product counts, as the invoice caps count it (_order_invoice_overbilling), so the
-- list never shows units the caps would refuse to bill again. Billed units are attributed in four steps: the delivery's own lines naming the
-- order line; its own lines with no order line (the invoice editor adds those), by product; then the order's
-- whole-order lines naming the order line; then its whole-order lines with no order line, by product; the last two
-- cover the order's deliveries in completion order. A line naming an order line but no product counts as that order
-- line's product. Units of a received return that no credit memo has credited (returned before billing) are not owed
-- (A4 default, to confirm with Mason). line_linked_qty / line_linked_cents (allocation recorded per invoice, as
-- _allocated_delivery_cents counts it) and line_unlinked_qty describe the order line's billing so far; the cents use
-- the order line's allocation (_allocated_cumulative_cents, inlined so a reader needs no EXECUTE on it).
-- security_invoker: each reader sees only the rows the policies on these tables let them read.
CREATE VIEW public.delivery_billing_remainders WITH (security_invoker = true) AS
WITH delivered AS (
  SELECT d.id AS delivery_id, d.order_id, d.completed_at, di.order_item_id, di.product_id,
         sum(round(COALESCE(di.quantity_delivered, 0), 4)) AS delivered_qty
    FROM public.deliveries d
    JOIN public.delivery_items di ON di.delivery_id = d.id
   WHERE d.status = 'completed' AND d.deleted_at IS NULL
     AND d.order_id IS NOT NULL AND di.order_item_id IS NOT NULL
   GROUP BY d.id, d.order_id, d.completed_at, di.order_item_id, di.product_id
), sale_lines AS (
  SELECT i.id AS invoice_id, i.order_id, i.delivery_id, ii.order_item_id,
         COALESCE(ii.product_id, oi.product_id) AS product_id, ii.quantity, ii.extended_cents
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
    LEFT JOIN public.order_items oi ON oi.id = ii.order_item_id
   WHERE i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL
     AND i.status NOT IN ('voided', 'cancelled') AND i.order_id IS NOT NULL
     AND ii.charge_type IS NULL AND COALESCE(ii.product_id, oi.product_id) IS NOT NULL
), pools AS (
  SELECT s.order_id, s.delivery_id, s.order_item_id, s.product_id, sum(s.quantity) AS qty
    FROM sale_lines s GROUP BY s.order_id, s.delivery_id, s.order_item_id, s.product_id
), linked AS (  -- per order line: units billed on lines naming it, and the allocation they count
  SELECT l.order_item_id, sum(l.qty) AS qty,
         sum(CASE WHEN a.invoice_id IS NULL OR a.quantity <= 0 THEN l.cents
                  WHEN l.qty = a.quantity THEN a.allocated_cents
                  ELSE round(a.allocated_cents * l.qty / a.quantity) END) AS cents
    FROM (SELECT s.invoice_id, s.order_item_id, sum(s.quantity) AS qty, sum(s.extended_cents) AS cents
            FROM sale_lines s WHERE s.order_item_id IS NOT NULL GROUP BY s.invoice_id, s.order_item_id) l
    LEFT JOIN public.invoice_order_line_allocations a ON a.invoice_id = l.invoice_id AND a.order_item_id = l.order_item_id
   GROUP BY l.order_item_id
), returned AS (  -- received, not credited: these units came back before they were billed
  SELECT ri.order_item_id, sum(ri.quantity) AS qty
    FROM public.return_items ri JOIN public.returns r ON r.id = ri.return_id
   WHERE r.status = 'received' AND r.deleted_at IS NULL AND r.credit_invoice_id IS NULL AND ri.order_item_id IS NOT NULL
   GROUP BY ri.order_item_id
), step1 AS (
  SELECT dl.*, LEAST(dl.delivered_qty, COALESCE((SELECT sum(p.qty) FROM pools p
           WHERE p.delivery_id = dl.delivery_id AND p.order_item_id = dl.order_item_id AND p.product_id = dl.product_id), 0)) AS b1
    FROM delivered dl
), step2 AS (
  SELECT s.*, LEAST(s.delivered_qty - s.b1, GREATEST(COALESCE((SELECT sum(p.qty) FROM pools p
           WHERE p.delivery_id = s.delivery_id AND p.order_item_id IS NULL AND p.product_id = s.product_id), 0)
         - COALESCE(sum(s.delivered_qty - s.b1) OVER (PARTITION BY s.delivery_id, s.product_id ORDER BY s.order_item_id
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0), 0)) AS b2
    FROM step1 s
), step3 AS (
  SELECT s.*, LEAST(s.delivered_qty - s.b1 - s.b2, GREATEST(COALESCE((SELECT sum(p.qty) FROM pools p
           WHERE p.delivery_id IS NULL AND p.order_id = s.order_id AND p.order_item_id = s.order_item_id AND p.product_id = s.product_id), 0)
         - COALESCE(sum(s.delivered_qty - s.b1 - s.b2) OVER (PARTITION BY s.order_id, s.order_item_id, s.product_id
             ORDER BY s.completed_at, s.delivery_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0), 0)) AS b3
    FROM step2 s
), step4 AS (
  SELECT s.*, LEAST(s.delivered_qty - s.b1 - s.b2 - s.b3, GREATEST(COALESCE((SELECT sum(p.qty) FROM pools p
           WHERE p.delivery_id IS NULL AND p.order_id = s.order_id AND p.order_item_id IS NULL AND p.product_id = s.product_id), 0)
         - COALESCE(sum(s.delivered_qty - s.b1 - s.b2 - s.b3) OVER (PARTITION BY s.order_id, s.product_id
             ORDER BY s.completed_at, s.delivery_id, s.order_item_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0), 0)) AS b4
    FROM step3 s
), step5 AS (
  SELECT s.*, LEAST(s.delivered_qty - s.b1 - s.b2 - s.b3 - s.b4, GREATEST(COALESCE((SELECT rt.qty FROM returned rt
           WHERE rt.order_item_id = s.order_item_id), 0)
         - COALESCE(sum(s.delivered_qty - s.b1 - s.b2 - s.b3 - s.b4) OVER (PARTITION BY s.order_item_id
             ORDER BY s.completed_at, s.delivery_id, s.product_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0), 0)) AS r5
    FROM step4 s
), covered AS (
  SELECT s.delivery_id, s.order_id, s.order_item_id, s.product_id, s.delivered_qty,
         s.b1 + s.b2 + s.b3 + s.b4 AS billed_qty, s.r5 AS returned_qty,
         COALESCE(lk.qty, 0) AS line_linked_qty, COALESCE(lk.cents, 0)::bigint AS line_linked_cents,
         sum(s.b2 + s.b4) OVER (PARTITION BY s.order_item_id) AS line_unlinked_qty
    FROM step5 s
    LEFT JOIN linked lk ON lk.order_item_id = s.order_item_id
)
SELECT c.delivery_id, c.order_id, c.order_item_id, c.product_id, c.delivered_qty, c.billed_qty, c.returned_qty,
       c.delivered_qty - c.billed_qty - c.returned_qty AS unbilled_qty,
       c.line_linked_qty, c.line_linked_cents, c.line_unlinked_qty,
       GREATEST(x.after_rest - c.line_linked_cents - (x.after_unlinked - x.after_linked), 0) AS unbilled_cents
  FROM covered c
  JOIN public.order_items oi ON oi.id = c.order_item_id
  CROSS JOIN LATERAL (
    SELECT max(v.cents) FILTER (WHERE v.k = 1) AS after_rest,
           max(v.cents) FILTER (WHERE v.k = 2) AS after_unlinked,
           max(v.cents) FILTER (WHERE v.k = 3) AS after_linked
      FROM (SELECT q.k, CASE
                     WHEN COALESCE(oi.total_units_needed, 0) <= 0 THEN round(GREATEST(q.qty, 0) * COALESCE(oi.price_per_unit, 0) * 100)
                     ELSE round(round(COALESCE(oi.total_price, 0) * 100) * LEAST(GREATEST(q.qty, 0), oi.total_units_needed) / oi.total_units_needed)
                   END::bigint AS cents
              FROM (VALUES (1, c.line_linked_qty + c.line_unlinked_qty + c.delivered_qty - c.billed_qty - c.returned_qty),
                           (2, c.line_linked_qty + c.line_unlinked_qty),
                           (3, c.line_linked_qty)) q(k, qty)) v
  ) x;
REVOKE ALL ON public.delivery_billing_remainders FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.delivery_billing_remainders TO authenticated, service_role;
COMMENT ON VIEW public.delivery_billing_remainders IS
  'A4: per completed delivery, order line and product, units delivered, billed (active non-credit invoices), returned before billing and not billed, with the cents billing the rest would add. Read under the reader''s own row policies (security_invoker).';

CREATE OR REPLACE FUNCTION public._allocated_delivery_cents(p_order_item_id uuid, p_quantity numeric, p_exclude_invoice_id uuid DEFAULT NULL::uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_prior_qty numeric := 0;
  v_prior_cents bigint := 0;
BEGIN
  IF p_order_item_id IS NULL THEN
    RETURN 0;
  END IF;

  -- A4 carry-over (Mason, 2026-11-25): each earlier invoice counts the cents the order line ALLOCATED to its units
  -- (invoice_order_line_allocations, recorded when the line was drafted; pro rata when its quantity was changed later), not
  -- the cents it bills, so a price changed on one invoice is never charged back on the next delivery. An invoice with
  -- no recorded allocation counts its billed cents, as before.
  SELECT COALESCE(SUM(l.qty), 0),
         COALESCE(SUM(CASE
           WHEN a.invoice_id IS NULL OR a.quantity <= 0 THEN l.cents
           WHEN l.qty = a.quantity THEN a.allocated_cents
           ELSE ROUND(a.allocated_cents * l.qty / a.quantity)
         END), 0)
    INTO v_prior_qty, v_prior_cents
    FROM (SELECT ii.invoice_id, SUM(ii.quantity) AS qty, SUM(ii.extended_cents) AS cents
            FROM public.invoice_items ii
            JOIN public.invoices inv ON inv.id = ii.invoice_id
           WHERE ii.order_item_id = p_order_item_id
             AND inv.invoice_type <> 'credit_memo'
             AND inv.deleted_at IS NULL
             AND inv.status NOT IN ('voided', 'cancelled')
             AND (p_exclude_invoice_id IS NULL OR inv.id <> p_exclude_invoice_id)
           GROUP BY ii.invoice_id) l
    LEFT JOIN public.invoice_order_line_allocations a
      ON a.invoice_id = l.invoice_id AND a.order_item_id = p_order_item_id;

  RETURN GREATEST(
    public._allocated_cumulative_cents(
      p_order_item_id,
      v_prior_qty + GREATEST(COALESCE(p_quantity, 0), 0)
    ) - v_prior_cents,
    0);
END;
$function$;
REVOKE ALL ON FUNCTION public._allocated_delivery_cents(uuid, numeric, uuid) FROM PUBLIC, anon, authenticated;

-- Create Invoice on a delivery takes the scope the screen confirmed (A4). The old three-argument chain is replaced:
-- a second overload would make the API call ambiguous.
DROP FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text);
DROP FUNCTION public._create_invoice_for_unbilled_delivery_idem_impl_20260721(uuid, uuid, text);
DROP FUNCTION public._create_invoice_for_unbilled_delivery_impl_20260718(uuid, uuid, text);

CREATE FUNCTION public._create_invoice_for_unbilled_delivery_impl_20260718(p_delivery_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_expected_scope text DEFAULT NULL::text)
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
  -- A4: v_rest when this bills the units an active invoice left unbilled; v_order_level when a whole-order invoice
  -- covers the order, so the rest is every unbilled unit on the order. v_scope is what this call does.
  v_rest boolean := false;
  v_order_level boolean := false;
  v_scope text := 'new';
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
    -- A4 (Mason, 2026-11-25): an invoice that bills fewer units than the delivery delivered leaves the rest on
    -- Unbilled; this bills exactly that rest on a new draft (delivery_billing_remainders).
    IF NOT EXISTS (SELECT 1 FROM public.delivery_billing_remainders r
                    WHERE r.delivery_id = p_delivery_id AND r.unbilled_qty > 0) THEN
      RAISE EXCEPTION 'This delivery already has an active invoice (or an order-level invoice covers the whole order) — nothing to backfill. Find and review the existing invoice instead.';
    END IF;
    IF public._order_has_bill_split(v_delivery.order_id) THEN
      RAISE EXCEPTION 'BILL_SPLIT_REST_NOT_SUPPORTED: delivery % is billed per payer and part of it is not billed yet; void its Bill Split invoices, then Create Invoice bills it again in full', v_delivery.delivery_number
        USING ERRCODE = 'check_violation';
    END IF;
    v_rest := true;
    -- Beside a whole-order invoice a delivery invoice is refused (ORDER_INVOICE_OVERLAPS_DELIVERY_INVOICE), and the
    -- whole-order lines cover the order rather than one delivery.
    v_order_level := EXISTS (
      SELECT 1 FROM invoices i
       WHERE i.order_id = v_delivery.order_id AND i.delivery_id IS NULL
         AND i.status NOT IN ('voided', 'cancelled') AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL);
    v_scope := CASE WHEN v_order_level THEN 'rest_order' ELSE 'rest_delivery' END;
  END IF;
  -- The screen's confirmation names what it will bill; a change since it was read is refused, not billed.
  IF p_expected_scope IS NOT NULL AND p_expected_scope IS DISTINCT FROM v_scope THEN
    RAISE EXCEPTION 'UNBILLED_SCOPE_CHANGED: delivery %''s billing changed since the screen read it (it would now be %, not %); reload the delivery and check again', v_delivery.delivery_number, v_scope, p_expected_scope
      USING ERRCODE = 'check_violation';
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
    v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id, 'billed_rest', false, 'scope', v_scope,
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
    CASE WHEN v_order_level THEN NULL ELSE p_delivery_id END, 'draft', (now() AT TIME ZONE 'America/Chicago')::date, 0, 0, v_actor) RETURNING id INTO v_invoice_id;
  -- A4: the rest is drafted from delivery_billing_remainders, one line per order line and product. Its cents are the
  -- order line's allocation for these units, counted after the units already billed on the line: invoice lines that
  -- name the order line count their recorded allocation (as _allocated_delivery_cents does), editor-added lines with
  -- no order line count at the line's allocation for their position. On a whole-order invoice it bills every
  -- unbilled unit on the order.
  IF v_rest THEN
    FOR v_item IN
      SELECT r.order_item_id, r.product_id, sum(r.unbilled_qty) AS quantity,
             max(r.line_linked_qty) AS linked_qty, max(r.line_linked_cents) AS linked_cents,
             max(r.line_unlinked_qty) AS unlinked_qty,
             oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name, p.product_name AS p_name,
             (SELECT di.unit_size FROM delivery_items di
               WHERE di.order_item_id = r.order_item_id AND di.product_id = r.product_id
                 AND (v_order_level OR di.delivery_id = p_delivery_id)
               ORDER BY di.id LIMIT 1) AS unit_size
        FROM public.delivery_billing_remainders r
        JOIN order_items oi ON oi.id = r.order_item_id
        JOIN products p ON p.id = r.product_id
       WHERE r.unbilled_qty > 0
         AND (r.delivery_id = p_delivery_id OR (v_order_level AND r.order_id = v_delivery.order_id))
       GROUP BY r.order_item_id, r.product_id, oi.price_per_unit, oi.cost_per_unit, oi.product_name, p.product_name
       ORDER BY r.order_item_id, r.product_id
    LOOP
      v_line_alloc_cents := GREATEST(
        public._allocated_cumulative_cents(v_item.order_item_id, v_item.linked_qty + v_item.unlinked_qty + v_item.quantity)
        - v_item.linked_cents
        - (public._allocated_cumulative_cents(v_item.order_item_id, v_item.linked_qty + v_item.unlinked_qty)
           - public._allocated_cumulative_cents(v_item.order_item_id, v_item.linked_qty)), 0);
      v_total_cents := v_total_cents + v_line_alloc_cents;
      v_cost_cents := v_cost_cents + ROUND(v_item.quantity * COALESCE(v_item.cost_per_unit, 0) * 100)::bigint;
      INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description,
        quantity, unit_price_cents, extended_cents, cost_cents, unit_size)
      VALUES (v_invoice_id, v_item.order_item_id, v_item.product_id,
        COALESCE(v_item.oi_product_name, v_item.p_name), v_item.quantity,
        ROUND(v_item.price_per_unit * 100)::bigint,
        v_line_alloc_cents,
        ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint, v_item.unit_size);
    END LOOP;
  END IF;
  FOR v_item IN
    SELECT di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id,
      oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name, p.product_name AS p_name
    FROM delivery_items di JOIN order_items oi ON oi.id = di.order_item_id
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id AND COALESCE(di.quantity_delivered, 0) > 0
      AND NOT v_rest
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
      'order_id', v_delivery.order_id, 'customer_id', v_delivery.customer_id, 'total_cents', v_total_cents, 'billed_rest', v_rest, 'scope', v_scope),
    v_total_cents, 'Invoice ' || v_invoice_number
      || CASE v_scope WHEN 'rest_order' THEN ' bills the unbilled rest of the order of completed delivery '
                      WHEN 'rest_delivery' THEN ' bills the unbilled rest of completed delivery '
                      ELSE ' backfilled for completed delivery ' END
      || v_delivery.delivery_number);
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_backfilled_for_delivery', CASE v_scope WHEN 'rest_order' THEN 'Drafted invoice ' || v_invoice_number || ' for the unbilled rest of the order of'
      WHEN 'rest_delivery' THEN 'Drafted invoice ' || v_invoice_number || ' for the unbilled rest of'
      ELSE 'Backfilled draft invoice ' || v_invoice_number || ' for' END ||
    ' completed delivery ' || v_delivery.delivery_number, v_actor, 'invoice', v_invoice_id, v_delivery.customer_id);
  v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id,
    'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number, 'total_cents', v_total_cents,
    'billed_rest', v_rest, 'scope', v_scope);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery', v_result);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public._create_invoice_for_unbilled_delivery_impl_20260718(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._create_invoice_for_unbilled_delivery_idem_impl_20260721(p_delivery_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_expected_scope text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request jsonb;
  v_result jsonb;
  v_is_deleted_fulfilled_recovery boolean := false;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Admin access required to create an invoice for a delivery';
  END IF;

  IF p_expected_scope IS NOT NULL AND p_expected_scope NOT IN ('new', 'rest_delivery', 'rest_order') THEN
    RAISE EXCEPTION 'UNBILLED_SCOPE_INVALID: expected scope must be new, rest_delivery or rest_order'
      USING ERRCODE = '22023';
  END IF;
  -- A key binds the scope the screen confirmed too (A4); a call without one binds exactly what it did before.
  v_request := jsonb_build_object(
    'version', 1,
    'delivery_id', p_delivery_id,
    'actor_id', v_actor
  ) || CASE WHEN p_expected_scope IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('expected_scope', p_expected_scope) END;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key, 'create_invoice_for_unbilled_delivery'
    );
    IF v_existing IS NOT NULL THEN
      IF NOT (v_existing ? 'request' AND v_existing ? 'response') THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_FORMAT_INVALID: create_invoice_for_unbilled_delivery';
      END IF;
      IF v_existing->'request' IS DISTINCT FROM v_request THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: create_invoice_for_unbilled_delivery key was already used for a different delivery, actor or billing scope';
      END IF;
      RETURN v_existing->'response';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.deliveries d
      JOIN public.orders o ON o.id = d.order_id
     WHERE d.id = p_delivery_id
       AND d.status = 'completed'
       AND d.deleted_at IS NULL
       AND d.customer_id = o.customer_id
       AND o.deleted_at IS NOT NULL
       AND o.status IN ('fulfilled', 'partially_fulfilled')
  ) INTO v_is_deleted_fulfilled_recovery;

  IF v_is_deleted_fulfilled_recovery THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.delivery_items di
       WHERE di.delivery_id = p_delivery_id
    ) OR EXISTS (
      SELECT 1
        FROM public.delivery_items di
        LEFT JOIN public.order_items oi ON oi.id = di.order_item_id
        JOIN public.deliveries d ON d.id = di.delivery_id
       WHERE di.delivery_id = p_delivery_id
         AND (
           oi.id IS NULL
           OR oi.order_id IS DISTINCT FROM d.order_id
           OR oi.product_id IS DISTINCT FROM di.product_id
           OR COALESCE(di.quantity_delivered, 0) <= 0
           OR di.quantity_delivered > COALESCE(di.quantity, 0)
         )
    ) THEN
      RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_ITEMS_INVALID: every historical recovery line must have matching order/product lineage and delivered quantity within its planned quantity';
    END IF;

    DELETE FROM public.invoice_delivery_recovery_capabilities
     WHERE transaction_id = txid_current() AND purpose = 'writer';
    INSERT INTO public.invoice_delivery_recovery_capabilities (
      transaction_id, purpose, delivery_id, actor_id
    ) VALUES (txid_current(), 'writer', p_delivery_id, v_actor);
  END IF;

  BEGIN
    v_result := public._create_invoice_for_unbilled_delivery_impl_20260718(
      p_delivery_id, v_actor, NULL, p_expected_scope
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM public.invoice_delivery_recovery_capabilities
     WHERE transaction_id = txid_current() AND purpose = 'writer';
    RAISE;
  END;

  DELETE FROM public.invoice_delivery_recovery_capabilities
   WHERE transaction_id = txid_current() AND purpose = 'writer';

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'create_invoice_for_unbilled_delivery',
      jsonb_build_object('request', v_request, 'response', v_result)
    );
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public._create_invoice_for_unbilled_delivery_idem_impl_20260721(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_invoice_for_unbilled_delivery(p_delivery_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_expected_scope text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_invoice_for_unbilled_delivery'
      USING ERRCODE = '22023';
  END IF;
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  RETURN public._create_invoice_for_unbilled_delivery_idem_impl_20260721(
    p_delivery_id, p_performed_by, p_idempotency_key, p_expected_scope
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_dashboard_action_items(p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_items jsonb;
  v_count bigint;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();
  -- Each group: one filter (CTE m) feeds both the first p_limit rows and the exact count (H36).

  -- 1. Overdue Invoices
  WITH m AS (
    SELECT
      'overdue_invoice' AS category,
      i.id,
      i.invoice_number AS primary_text,
      c.farm_name AS secondary_text,
      (v_today - i.due_date) AS days_overdue,
      i.balance_cents AS amount_cents
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status = 'overdue'
      AND i.balance_cents > 0
      AND i.invoice_type <> 'credit_memo'
      AND i.deleted_at IS NULL
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT category, id, primary_text, secondary_text, days_overdue, amount_cents
      FROM m ORDER BY days_overdue DESC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('overdue_invoices', v_items);
  v_counts := v_counts || jsonb_build_object('overdue_invoices', v_count);

  -- 2. Cancelled Orders with Posted Invoices (one row per order and posted invoice, as listed)
  WITH m AS (
    SELECT
      o.id,
      o.order_number AS primary_text,
      c.farm_name AS secondary_text,
      i.invoice_number,
      o.created_at AS sort_created_at
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    JOIN invoices i ON i.order_id = o.id
      AND i.status = 'posted'
      AND i.invoice_type <> 'credit_memo'
      AND i.deleted_at IS NULL
    WHERE o.status = 'cancelled'
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, invoice_number
      FROM m ORDER BY sort_created_at DESC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('cancelled_posted', v_items);
  v_counts := v_counts || jsonb_build_object('cancelled_posted', v_count);

  -- 3. Overdue Deliveries
  WITH m AS (
    SELECT
      d.id,
      d.delivery_number AS primary_text,
      c.farm_name AS secondary_text,
      (v_today - d.scheduled_date) AS days_overdue,
      d.scheduled_date AS sort_date
    FROM deliveries d
    JOIN customers c ON c.id = d.customer_id
    WHERE d.status IN ('scheduled', 'in_progress')
      AND d.scheduled_date < v_today
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, days_overdue
      FROM m ORDER BY sort_date ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('overdue_deliveries', v_items);
  v_counts := v_counts || jsonb_build_object('overdue_deliveries', v_count);

  -- 4. Low Stock Items
  WITH m AS (
    SELECT
      p.id,
      p.product_name AS primary_text,
      p.category AS secondary_text,
      COALESCE(inv.quantity_available, 0) AS current_qty,
      COALESCE(inv.reorder_point, 0) AS reorder_point,
      (COALESCE(inv.quantity_available, 0)::float / NULLIF(inv.reorder_point, 0)) AS sort_ratio
    FROM products p
    JOIN inventory inv ON inv.product_id = p.id
    WHERE p.is_active = true
      AND (
        (inv.reorder_point IS NOT NULL
          AND inv.reorder_point > 0
          AND COALESCE(inv.quantity_available, 0) < inv.reorder_point)
        OR COALESCE(inv.quantity_available, 0) < 0
      )
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, current_qty, reorder_point
      FROM m ORDER BY sort_ratio ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('low_stock', v_items);
  v_counts := v_counts || jsonb_build_object('low_stock', v_count);

  -- 5. Expiring Quotes (within 7 days)
  WITH m AS (
    SELECT
      q.id,
      q.quote_number AS primary_text,
      c.farm_name AS secondary_text,
      (q.expires_at::date - v_today) AS days_until_expiry,
      q.expires_at AS sort_expires_at
    FROM quotes q
    JOIN customers c ON c.id = q.customer_id
    WHERE q.status IN ('sent', 'revised')
      AND q.is_planned = false
      AND q.expires_at IS NOT NULL
      AND q.expires_at::date BETWEEN v_today AND (v_today + interval '7 days')
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, days_until_expiry
      FROM m ORDER BY sort_expires_at ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('expiring_quotes', v_items);
  v_counts := v_counts || jsonb_build_object('expiring_quotes', v_count);

  -- 6. Unassigned Deliveries
  WITH m AS (
    SELECT
      d.id,
      d.delivery_number AS primary_text,
      c.farm_name AS secondary_text,
      d.scheduled_date
    FROM deliveries d
    JOIN customers c ON c.id = d.customer_id
    WHERE d.status = 'scheduled'
      AND d.assigned_driver IS NULL
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, scheduled_date
      FROM m ORDER BY scheduled_date ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('unassigned_deliveries', v_items);
  v_counts := v_counts || jsonb_build_object('unassigned_deliveries', v_count);

  -- 7. Unassigned Jobs (findings #15-21/#111): a SCHEDULED job with no currently-active
  -- per-location dispatch and no legacy whole-job applicator (unchanged from 20261023090000).
  WITH m AS (
    SELECT
      j.id,
      j.job_number AS primary_text,
      c.farm_name AS secondary_text,
      j.job_date AS scheduled_date
    FROM jobs j
    JOIN customers c ON c.id = j.customer_id
    WHERE j.status = 'scheduled'
      AND j.deleted_at IS NULL
      AND j.applicator_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM job_location_dispatches d
        WHERE d.job_id = j.id AND d.dispatch_status = 'dispatched'
      )
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, scheduled_date
      FROM m ORDER BY scheduled_date ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('unassigned_jobs', v_items);
  v_counts := v_counts || jsonb_build_object('unassigned_jobs', v_count);

  -- 8. Due-today deliveries that have not been started.
  WITH m AS (
    SELECT
      d.id,
      d.delivery_number AS primary_text,
      c.farm_name AS secondary_text,
      d.scheduled_date
    FROM deliveries d
    JOIN customers c ON c.id = d.customer_id
    WHERE d.scheduled_date = v_today
      AND d.status = 'scheduled'
      AND d.deleted_at IS NULL
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, scheduled_date
      FROM m ORDER BY primary_text ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('due_today_not_started', v_items);
  v_counts := v_counts || jsonb_build_object('due_today_not_started', v_count);

  -- 9. Completed deliveries not covered by an active delivery- or order-level invoice, or with delivered units
  --    those invoices leave unbilled (A4, delivery_billing_remainders), and not billed outside CRX
  --    (delivery_external_billings).
  WITH m AS (
    SELECT
      d.id,
      d.delivery_number AS primary_text,
      c.farm_name AS secondary_text,
      d.scheduled_date
    FROM deliveries d
    JOIN customers c ON c.id = d.customer_id
    WHERE d.status = 'completed'
      AND d.deleted_at IS NULL
      AND d.order_id IS NOT NULL
      AND (NOT EXISTS (
        SELECT 1
        FROM invoices i
        WHERE i.order_id = d.order_id
          AND i.status NOT IN ('voided', 'cancelled')
          AND (i.delivery_id = d.id OR i.delivery_id IS NULL)
          AND i.invoice_type <> 'credit_memo'
          AND i.deleted_at IS NULL
      ) OR d.id IN (SELECT r.delivery_id FROM public.delivery_billing_remainders r WHERE r.unbilled_qty > 0))
      AND NOT EXISTS (
        SELECT 1 FROM delivery_external_billings b WHERE b.delivery_id = d.id
      )
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT id, primary_text, secondary_text, scheduled_date
      FROM m ORDER BY scheduled_date ASC LIMIT p_limit
    ) t), '[]'::jsonb),
    (SELECT count(*) FROM m)
  INTO v_items, v_count;
  v_result := v_result || jsonb_build_object('unbilled_deliveries', v_items);
  v_counts := v_counts || jsonb_build_object('unbilled_deliveries', v_count);

  RETURN v_result || jsonb_build_object('counts', v_counts);
END;
$function$
;
REVOKE ALL ON FUNCTION public.get_dashboard_action_items(integer) FROM PUBLIC, anon;

DO $postflight$
DECLARE
  v_pin record;
BEGIN
  FOR v_pin IN SELECT * FROM (VALUES
      ('public._allocated_delivery_cents(uuid,numeric,uuid)', '01eb25c376e2c472e55bed7ff9dcaebf', false),
      ('public._record_invoice_line_allocation()', '81474bdb9170f847f324cac4ce87e090', true),
      ('public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text,text)', 'e2566c18809f11f2029121674ecab7f9', true),
      ('public._create_invoice_for_unbilled_delivery_idem_impl_20260721(uuid,uuid,text,text)', '4f18fe996393549ebf7d4ee76570188d', true),
      ('public.create_invoice_for_unbilled_delivery(uuid,uuid,text,text)', 'ee18d8501f94a4c34bb71831c767f0a2', true),
      ('public.get_dashboard_action_items(integer)', 'eb96aacf4dfc840a22df32d6bb549aeb', true)) t(sig, md5, definer)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig)
                    AND md5(replace(p.prosrc, chr(13), '')) = v_pin.md5 AND p.prosecdef = v_pin.definer
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND pg_get_userbyid(p.proowner) = 'postgres') THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % is not this file''s body or settings', v_pin.sig;
    END IF;
  END LOOP;
  IF to_regprocedure('public.create_invoice_for_unbilled_delivery(uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public._create_invoice_for_unbilled_delivery_idem_impl_20260721(uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)') IS NOT NULL
     OR has_function_privilege('anon', 'public.create_invoice_for_unbilled_delivery(uuid,uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_invoice_for_unbilled_delivery(uuid,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._create_invoice_for_unbilled_delivery_idem_impl_20260721(uuid,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._create_invoice_for_unbilled_delivery_idem_impl_20260721(uuid,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._record_invoice_line_allocation()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._allocated_delivery_cents(uuid,numeric,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_dashboard_action_items(integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_dashboard_action_items(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: function grants drifted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.delivery_billing_remainders'::regclass
                  AND c.reloptions @> ARRAY['security_invoker=true'])
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.invoice_order_line_allocations'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_record_invoice_line_allocation'
                     AND tgrelid = 'public.invoice_items'::regclass AND tgenabled = 'O')
     OR has_table_privilege('anon', 'public.delivery_billing_remainders', 'SELECT')
     OR has_table_privilege('anon', 'public.invoice_order_line_allocations', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.delivery_billing_remainders', 'SELECT')
     OR has_table_privilege('authenticated', 'public.delivery_billing_remainders', 'INSERT')
     OR has_table_privilege('authenticated', 'public.invoice_order_line_allocations', 'INSERT')
     OR has_table_privilege('authenticated', 'public.invoice_order_line_allocations', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.invoice_order_line_allocations', 'DELETE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: view, table, trigger or table grants drifted';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
