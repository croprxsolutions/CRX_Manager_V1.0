-- Goal 3 / to-do 3.2. Schema only; no existing billing or inventory is rewritten.
-- Gross positive billing is bounded by completed delivery history, at both order-line
-- and product level. A return credit never creates a second sale allowance: the
-- original sale and credit remain paired, and a replacement needs another delivery.
-- Existing per-delivery caps, order/delivery exclusivity and split provenance remain.
-- Quick-delivery drafts are the approved exception; their existing per-delivery cap
-- bounds planned quantities and refuses posting before completion.
-- Owner decision (Mason, 2026-10-29): an active posted invoice must be voided before the
-- delivery behind it can be voided or cancelled, so voiding a delivery can never strand
-- an order billed above what was delivered. A draft invoice never blocks (void_delivery
-- and cancel_delivery cancel their own drafts); a cancelled delivery that never completed
-- changes no delivered quantity, so only invoices tied to that delivery block it.
-- Rollback: a new reviewed migration dropping the two zz_cap_order_* triggers, the
-- zz_delivery_void_needs_invoice_void trigger and these three helpers. Existing
-- delivery cap triggers must remain installed.
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.invoices, public.invoice_items, public.deliveries IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public._order_invoice_overbilling(p_order_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE v_bad record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
     WHERE i.order_id = p_order_id AND i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL AND i.status NOT IN ('voided', 'cancelled')
       AND ((ii.product_id IS NULL AND ii.charge_type IS NULL)
         OR (ii.product_id IS NOT NULL AND (ii.quantity IS NULL OR ii.quantity < 0))
         OR (ii.order_item_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.order_items oi WHERE oi.id = ii.order_item_id
             AND oi.order_id = p_order_id AND oi.product_id IS NOT DISTINCT FROM ii.product_id)))
  ) THEN
    RETURN 'LINE_INVALID: sale lines need a matching product and nonnegative quantity; non-product lines need a charge type.';
  END IF;
  WITH allowed AS (
    SELECT di.order_item_id, di.product_id,
           sum(round(coalesce(di.quantity_delivered, 0), 4)) AS qty
      FROM public.delivery_items di
      JOIN public.deliveries d ON d.id = di.delivery_id
     WHERE d.order_id = p_order_id AND d.status = 'completed' AND d.deleted_at IS NULL
     GROUP BY di.order_item_id, di.product_id
  ), billed AS (
      SELECT ii.order_item_id, ii.product_id, round(ii.quantity, 4) AS quantity
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
      LEFT JOIN public.deliveries d ON d.id = i.delivery_id
     WHERE i.order_id = p_order_id AND i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL AND i.status NOT IN ('voided', 'cancelled')
       AND NOT (i.status = 'draft' AND coalesce(d.is_quick_delivery, false)
                AND d.deleted_at IS NULL AND d.status IN ('scheduled', 'in_progress'))
       AND ii.product_id IS NOT NULL
  ), over_line AS (
    SELECT b.product_id, sum(b.quantity) AS billed_qty,
           (SELECT coalesce(sum(a.qty), 0) FROM allowed a
             WHERE a.order_item_id = b.order_item_id AND a.product_id = b.product_id) AS allowed_qty
      FROM billed b WHERE b.order_item_id IS NOT NULL
     GROUP BY b.order_item_id, b.product_id
  ), over_product AS (
    SELECT b.product_id, sum(b.quantity) AS billed_qty,
           (SELECT coalesce(sum(a.qty), 0) FROM allowed a
             WHERE a.product_id = b.product_id) AS allowed_qty
      FROM billed b GROUP BY b.product_id
  )
  SELECT * INTO v_bad FROM (
    SELECT * FROM over_line UNION ALL SELECT * FROM over_product
  ) quantities WHERE billed_qty > allowed_qty + 0.001 ORDER BY product_id LIMIT 1;  -- field splits round shares to 4 places (0.6667 x 3 = 2.0001)
  IF FOUND THEN
    RETURN format('Product billing totals %s units; completed deliveries allow %s. Refresh the invoice and bill only delivered goods.',
                  v_bad.billed_qty, v_bad.allowed_qty);
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public._order_invoice_overbilling(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._order_invoice_overbilling(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_order_invoice_within_delivered()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice public.invoices%ROWTYPE;
  v_reason text;
  v_invoice_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'invoice_items' THEN
    v_invoice_id := NEW.invoice_id;
  ELSE
    v_invoice_id := NEW.id;
  END IF;
  SELECT * INTO v_invoice FROM public.invoices WHERE id = v_invoice_id;
  IF v_invoice.order_id IS NULL OR v_invoice.invoice_type = 'credit_memo'
     OR v_invoice.deleted_at IS NOT NULL OR v_invoice.status IN ('voided', 'cancelled') THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'invoice_items' THEN
    IF NEW.product_id IS NULL AND NEW.charge_type IS NULL THEN
      RAISE EXCEPTION 'ORDER_INVOICE_LINE_INVALID: a non-product line requires a charge type';
    END IF;
    -- A negative product quantity may not offset another sale. Credits use the
    -- governed credit-memo path. Non-product service/charge lines consume no units.
    IF NEW.product_id IS NOT NULL AND (NEW.quantity IS NULL OR NEW.quantity < 0) THEN
      RAISE EXCEPTION 'ORDER_INVOICE_LINE_INVALID: product sale quantities must be nonnegative';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.invoice_id = OLD.invoice_id
         AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
         AND NEW.order_item_id IS NOT DISTINCT FROM OLD.order_item_id
         AND NEW.quantity >= 0 THEN
        IF NEW.quantity <= OLD.quantity THEN RETURN NULL; END IF;
        -- Every increase, including changes made during delivery completion,
        -- is checked against the order-wide completed-delivery aggregate.
      END IF;
    END IF;
    -- Existing invoice-line writers already acquire this order lock. The query
    -- after it sees the preceding transaction's committed billing at READ COMMITTED.
    PERFORM 1 FROM public.orders WHERE id = v_invoice.order_id FOR UPDATE;
  ELSE
    -- Posting only rechecks already-reserved units and must not invert the
    -- invoice-before-order locking of post_invoice. Restoring adds reservations.
    IF NOT (OLD.deleted_at IS NULL AND OLD.status IN ('draft', 'unposted')
            AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id
            AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
            AND NEW.delivery_id IS NOT DISTINCT FROM OLD.delivery_id) THEN
      PERFORM 1 FROM public.orders WHERE id = v_invoice.order_id FOR UPDATE;
    END IF;
  END IF;
  v_reason := public._order_invoice_overbilling(v_invoice.order_id);
  IF v_reason IS NOT NULL THEN
    IF v_reason LIKE 'LINE_INVALID:%' THEN
      RAISE EXCEPTION 'ORDER_INVOICE_LINE_INVALID: %', ltrim(substr(v_reason, length('LINE_INVALID:') + 1));
    END IF;
    RAISE EXCEPTION 'ORDER_INVOICE_EXCEEDS_DELIVERED: %', v_reason;
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.enforce_order_invoice_within_delivered() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_order_invoice_within_delivered() FROM PUBLIC, anon, authenticated, service_role;

-- Every active order-backed invoice is subject to the trigger's aggregate check,
-- including invoices linked to a delivery. Correct invalid or over-cap bills
-- deliberately before installation; this migration never changes saved bills.
DO $preflight$
DECLARE v_order_id uuid;
BEGIN
  FOR v_order_id IN SELECT DISTINCT order_id FROM public.invoices
    WHERE order_id IS NOT NULL AND invoice_type <> 'credit_memo'
      AND deleted_at IS NULL AND status NOT IN ('voided', 'cancelled') LOOP
    IF public._order_invoice_overbilling(v_order_id) IS NOT NULL THEN
      RAISE EXCEPTION 'ORDER_INVOICE_CAP_PREFLIGHT: existing whole-order billing needs review';
    END IF;
  END LOOP;
END;
$preflight$;

DROP TRIGGER IF EXISTS zz_cap_order_invoice_items ON public.invoice_items;
CREATE TRIGGER zz_cap_order_invoice_items
  AFTER INSERT OR UPDATE OF invoice_id, product_id, order_item_id, quantity, charge_type ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_order_invoice_within_delivered();
DROP TRIGGER IF EXISTS zz_cap_order_invoice_header ON public.invoices;
CREATE TRIGGER zz_cap_order_invoice_header
  AFTER UPDATE OF order_id, delivery_id, invoice_type, deleted_at, status ON public.invoices
  FOR EACH ROW
  WHEN (NEW.order_id IS NOT NULL AND NEW.invoice_type <> 'credit_memo'
        AND NEW.deleted_at IS NULL AND NEW.status NOT IN ('voided', 'cancelled')
        AND (NEW.order_id IS DISTINCT FROM OLD.order_id
          OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
          OR NEW.invoice_type IS DISTINCT FROM OLD.invoice_type
          OR OLD.deleted_at IS NOT NULL OR OLD.status IN ('voided', 'cancelled')
          OR (NEW.status IN ('posted', 'paid', 'overdue') AND OLD.status IN ('draft', 'unposted'))))
  EXECUTE FUNCTION public.enforce_order_invoice_within_delivered();

-- Invoice-first rule. Runs inside void_delivery / cancel_delivery (and any other writer)
-- the moment a delivery becomes voided or cancelled, so the refusal is in PostgreSQL, not
-- only in the screen. The whole call rolls back, including any inventory it had restored.
-- Blocking invoices: posted, paid or overdue. An unposted invoice (posted, then reversed)
-- also blocks a VOID, because void_delivery cancels only drafts and would leave it billing
-- units that are no longer delivered; cancel_delivery cancels unposted invoices itself.
-- A completed delivery being voided reduces delivered quantity, so an order-level invoice
-- (no delivery link, the legacy shape) also blocks it; a delivery that never completed
-- reduces nothing, so only invoices linked to that delivery block its cancellation.
-- The candidate invoices are row-locked first (NOWAIT): a post running at the same moment
-- either finished before this check (and blocks) or must wait, then finds the delivery
-- no longer completed and is refused by the per-delivery cap.
CREATE OR REPLACE FUNCTION public.enforce_delivery_void_needs_invoice_void()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  BEGIN
    PERFORM 1 FROM public.invoices i
     WHERE i.order_id = NEW.order_id AND i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL AND i.status IN ('draft', 'unposted', 'posted', 'paid', 'overdue')
       AND (i.delivery_id = NEW.id
            OR (OLD.status = 'completed' AND i.delivery_id IS NULL))
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'ORDER_LIFECYCLE_BUSY_RETRY: an invoice for delivery % is being changed; retry in a moment', NEW.delivery_number
      USING ERRCODE = 'P0001';
  END;
  IF EXISTS (
    SELECT 1 FROM public.invoices i
     WHERE i.order_id = NEW.order_id AND i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL
       AND (i.status IN ('posted', 'paid', 'overdue')
            OR (NEW.status = 'voided' AND i.status = 'unposted'))
       AND (i.delivery_id = NEW.id
            OR (OLD.status = 'completed' AND i.delivery_id IS NULL))
  ) THEN
    RAISE EXCEPTION 'DELIVERY_HAS_POSTED_INVOICE: void the active invoice for delivery % (or its order) before voiding or cancelling it', NEW.delivery_number
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.enforce_delivery_void_needs_invoice_void() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_delivery_void_needs_invoice_void() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS zz_delivery_void_needs_invoice_void ON public.deliveries;
CREATE TRIGGER zz_delivery_void_needs_invoice_void
  BEFORE UPDATE OF status ON public.deliveries
  FOR EACH ROW
  WHEN (NEW.status IN ('voided', 'cancelled') AND OLD.status NOT IN ('voided', 'cancelled'))
  EXECUTE FUNCTION public.enforce_delivery_void_needs_invoice_void();

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('zz_cap_order_invoice_items', 'zz_cap_order_invoice_header')
       AND tgfoid = 'public.enforce_order_invoice_within_delivered()'::regprocedure
       AND tgenabled = 'O' AND NOT tgdeferrable) <> 2 THEN
    RAISE EXCEPTION 'ORDER_INVOICE_CAP_POSTFLIGHT: immediate cap triggers must be enabled';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'zz_delivery_void_needs_invoice_void'
       AND tgrelid = 'public.deliveries'::regclass
       AND tgfoid = 'public.enforce_delivery_void_needs_invoice_void()'::regprocedure
       AND tgenabled = 'O' AND NOT tgdeferrable) <> 1 THEN
    RAISE EXCEPTION 'ORDER_INVOICE_CAP_POSTFLIGHT: invoice-first delivery trigger must be enabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) AS roles(name)
     WHERE has_function_privilege(name, 'public._order_invoice_overbilling(uuid)', 'EXECUTE')
        OR has_function_privilege(name, 'public.enforce_order_invoice_within_delivered()', 'EXECUTE')
        OR has_function_privilege(name, 'public.enforce_delivery_void_needs_invoice_void()', 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'ORDER_INVOICE_CAP_POSTFLIGHT: helpers must remain private';
  END IF;
END;
$postflight$;
