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
-- delivery cap triggers must remain installed. Restore the reviewed split-engine
-- pre-image (body md5 ccde51261dd8c5270b6dbd24f28981bd) in that rollback migration.
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
  -- The existing overlap guard enforces one billing shape per order. Match its
  -- document precision: delivery invoices store each row; order splits store a full line.
  WITH invoice_mode AS (
    SELECT EXISTS (
      SELECT 1 FROM public.invoices i WHERE i.order_id = p_order_id AND i.delivery_id IS NOT NULL
        AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL
        AND i.status NOT IN ('voided', 'cancelled')
    ) AS per_delivery
  ), allowed AS (
    SELECT di.order_item_id, di.product_id,
           CASE WHEN (SELECT per_delivery FROM invoice_mode)
             THEN sum(round(coalesce(di.quantity_delivered, 0), 4))
             ELSE round(sum(coalesce(di.quantity_delivered, 0)), 4) END AS qty
      FROM public.delivery_items di
      JOIN public.deliveries d ON d.id = di.delivery_id
     WHERE d.order_id = p_order_id AND d.status = 'completed' AND d.deleted_at IS NULL
     GROUP BY di.order_item_id, di.product_id
  ), billed AS (
      SELECT ii.order_item_id, ii.product_id, ii.quantity AS quantity
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
  ) quantities WHERE billed_qty > allowed_qty
  ORDER BY product_id LIMIT 1;  -- Split generation conserves source quantities to four places.
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
        -- Record the physical quick delivery even when its edited draft still needs
        -- correction. Only its exact linked-line trim is exempt; posting rechecks all lines.
        IF NEW.order_item_id IS NOT NULL AND v_invoice.status = 'draft' AND NEW.quantity = (
             SELECT sum(round(coalesce(di.quantity_delivered, 0), 4))
               FROM public.delivery_items di JOIN public.deliveries d ON d.id = di.delivery_id
              WHERE di.delivery_id = v_invoice.delivery_id
                AND di.order_item_id = NEW.order_item_id AND di.product_id = NEW.product_id
                AND d.order_id = v_invoice.order_id AND d.is_quick_delivery
                AND d.status = 'completed' AND d.deleted_at IS NULL) THEN
          RETURN NULL;
        END IF;
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
-- Whole-order draft and unposted invoices are locked even when the delivery never completed:
-- cancel_delivery cancels them without rechecking their status, so a post racing that cancel
-- must not be overwritten. They only BLOCK when the delivery was completed.
CREATE OR REPLACE FUNCTION public.enforce_delivery_void_needs_invoice_void()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Completed deliveries leave the allowance only through the governed void/cancel flow.
  IF OLD.status = 'completed' AND OLD.deleted_at IS NULL AND OLD.order_id IS NOT NULL
     AND (NEW.deleted_at IS NOT NULL OR NEW.order_id IS DISTINCT FROM OLD.order_id) THEN
    RAISE EXCEPTION 'DELIVERY_COMPLETED_SOURCE_IMMUTABLE: void delivery % before removing or reassigning it', OLD.delivery_number
      USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    PERFORM 1 FROM public.invoices i
     WHERE i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL AND i.status IN ('draft', 'unposted', 'posted', 'paid', 'overdue')
       AND (i.delivery_id = NEW.id
            OR (i.delivery_id IS NULL AND i.order_id = NEW.order_id
                AND (OLD.status = 'completed' OR i.status IN ('draft', 'unposted'))))
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'ORDER_LIFECYCLE_BUSY_RETRY: an invoice for delivery % is being changed; retry in a moment', NEW.delivery_number
      USING ERRCODE = 'P0001';
  END;
  IF EXISTS (
    SELECT 1 FROM public.invoices i
     WHERE i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL
       AND (i.status IN ('posted', 'paid', 'overdue')
            OR (NEW.status = 'voided' AND i.status = 'unposted'))
       AND (i.delivery_id = NEW.id
            OR (OLD.status = 'completed' AND i.delivery_id IS NULL AND i.order_id = NEW.order_id))
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
  BEFORE UPDATE OF status, deleted_at, order_id ON public.deliveries
  FOR EACH ROW
  WHEN ((NEW.status IN ('voided', 'cancelled') AND OLD.status NOT IN ('voided', 'cancelled'))
     OR (OLD.status = 'completed' AND OLD.deleted_at IS NULL AND OLD.order_id IS NOT NULL
         AND (NEW.deleted_at IS NOT NULL OR NEW.order_id IS DISTINCT FROM OLD.order_id)))
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

-- Preserve the live split engine's money, lineage, ownership and retry behavior.
-- Only the per-owner quantity calculation changes to conserve each source line.
DO $split_preflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='_create_split_invoices_from_order_provenance_impl_20260719') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)')
         AND md5(p.prosrc) IN ('ccde51261dd8c5270b6dbd24f28981bd','141b26d15133656e1c09bda75be52cc4')
         AND p.proowner='postgres'::regrole AND p.prosecdef
         AND p.prorettype='uuid[]'::regtype AND p.provolatile='v' AND NOT p.proisstrict AND p.proparallel='u'
         AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
         AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN
    RAISE EXCEPTION 'ORDER_SPLIT_QUANTITY_DRIFT: split engine body or contract changed';
  END IF;
END;
$split_preflight$;

CREATE OR REPLACE FUNCTION public._create_split_invoices_from_order_provenance_impl_20260719(p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT 'chemical_sale'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing text;
  v_order record;
  v_has_alloc boolean := false;
  v_existing_count int;
  v_delivery_count int;
  v_group_id uuid;
  v_invoice_id uuid;
  v_invoice_ids uuid[] := '{}';
  v_item record;
  v_alloc record;
  v_cust record;
  v_line_cents bigint;
  v_total_acres numeric;
  v_acre_pcts numeric[];
  v_field_cents bigint[];
  v_field_idx int;
  v_owner_ids uuid[];
  v_owner_pcts numeric[];
  v_owner_cents bigint[];
  v_owner_acres numeric;
  v_sum_pct numeric;
  v_oidx int;
  v_total_cents bigint;
  -- per-(customer, line) contribution accumulator; aggregated in pass 2.
  v_rows jsonb := '[]'::jsonb;
  -- Same Chicago business-date resolution as the single-invoice path above:
  -- every invoice minted by this call shares one explicit business date for
  -- both invoice_date and season, instead of the UTC CURRENT_DATE.
  v_business_date date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  -- Authorization (mirror create_invoice_from_order): creating invoices is admin/sales_rep only.
  -- The old split path was unreachable (quote_sections.field_id was never persisted), so it had
  -- no gate; making it reachable means it MUST gate here or any authenticated user (driver/applicator)
  -- could mint invoices via this SECURITY DEFINER RPC (Codex P1).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  -- Lock the order FIRST (mirror create_invoice_from_order's Codex-P1 lock): serializes against a
  -- concurrent delivery/invoice insert AND against a same-key retry, so the idempotency replay below
  -- runs only after any in-flight first call on this order has committed.
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;

  -- Canonical operation-scoped idempotency replay, AFTER the order lock (draw_down_quote 2026-06-10
  -- pattern): a racing same-key retry blocks on the lock above, then resumes here and returns the
  -- cached invoice ids — instead of missing the still-uncommitted row pre-lock and then falsely
  -- erroring on the active-invoice guard below (Codex round-3 P2). result is a jsonb string; #>>'{}'
  -- extracts the bare "id1,id2" text so string_to_array sees no surrounding quotes.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result #>> '{}' INTO v_existing FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'create_split_invoices_from_order';
    IF v_existing IS NOT NULL THEN RETURN string_to_array(v_existing, ',')::uuid[]; END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM order_item_field_allocations oifa
    JOIN order_items oi ON oi.id = oifa.order_item_id
    WHERE oi.order_id = p_order_id
  ) INTO v_has_alloc;

  -- No per-line field allocations anywhere on this order -> single invoice (unchanged).
  IF NOT v_has_alloc THEN
    v_invoice_id := create_invoice_from_order(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key);
    RETURN ARRAY[v_invoice_id];
  END IF;

  -- The split path inserts invoices DIRECTLY (the single-invoice path above delegates to
  -- create_invoice_from_order, which carries these guards). Replicate them so an allocated order
  -- that already has an active invoice or an active delivery cannot be double-billed (Codex P1).
  SELECT COUNT(*) INTO v_existing_count FROM invoices
    WHERE order_id = p_order_id AND status NOT IN ('voided', 'cancelled')
     AND invoice_type <> 'credit_memo'
     AND deleted_at IS NULL;
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'Active invoice already exists for order % (% existing invoice(s)). Void or cancel the existing invoice first if you need to recreate.', v_order.order_number, v_existing_count;
  END IF;
  SELECT COUNT(*) INTO v_delivery_count FROM deliveries
    -- U7 SAFE-SCOPE (#43): only an OPEN (scheduled/in_progress) delivery blocks now;
    -- a COMPLETED delivery on a field/acre-allocated order left NO auto-draft to
    -- double against (complete_delivery skipped the mono-bill), so the split can run.
    WHERE order_id = p_order_id AND status IN ('scheduled', 'in_progress');
  IF v_delivery_count > 0 THEN
    RAISE EXCEPTION 'Cannot create an order-level invoice for order % — it has % active delivery(ies); invoices are created per delivery on completion. Cancel/void those deliveries first to bill the whole order manually.', v_order.order_number, v_delivery_count;
  END IF;

  -- U7 SAFE-SCOPE (#43, refined R3 P2): this engine bills the WHOLE order (off
  -- order_items.total_price). Block ONLY the partial-delivery-in-progress case — a
  -- delivery has COMPLETED but product still remains — where whole-order billing would
  -- bill undelivered product. A PRE-delivery order (no completed delivery) can still be
  -- invoiced up front (invoice-on-order, like create_invoice_from_order), and a fully
  -- delivered order passes. (Per-delivery split billing would be a larger redesign.)
  IF EXISTS (SELECT 1 FROM deliveries WHERE order_id = p_order_id AND status = 'completed')
     AND EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id AND COALESCE(quantity_remaining, 0) > 0) THEN
    RAISE EXCEPTION 'Order % is partially delivered — split invoicing bills the whole order and would bill undelivered product. Finish delivering (or void the open deliveries) first.', v_order.order_number;
  END IF;

  -- Split-by-acre needs real line prices: a price-pending order would allocate $0 across fields
  -- (meaningless) and price_order cannot re-split a multi-customer invoice, so the single-invoice
  -- path's "create $0 drafts, sweep later" does not transfer here. Reject EXPLICITLY rather than
  -- silently produce no invoice (Codex round-2 P2). Price the order first, then split.
  IF EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id AND pricing_pending) THEN
    RAISE EXCEPTION 'PRICING_INCOMPLETE: price the order before generating split invoices';
  END IF;

  -- Split-payer return (20261021155000): freeze who owns each allocated field, and in what
  -- percentages, for the rest of this transaction. Pass 1 reads the billing defaults field by field
  -- in separate statements, so an edit committed between them could mix old and new percentages,
  -- and the lineage guard checks only that each customer is still an owner (Codex App P1 on #1010).
  -- Same order as save_field (the field row, then its defaults): the allocated fields' rows, then
  -- the whole defaults table in SHARE mode (blocks every write to it until this split commits).
  PERFORM 1
     FROM fields f
    WHERE f.id IN (
      SELECT oifa.field_id
        FROM order_item_field_allocations oifa
        JOIN order_items oi ON oi.id = oifa.order_item_id
       WHERE oi.order_id = p_order_id
    )
    ORDER BY f.id
    FOR SHARE;
  LOCK TABLE public.field_billing_defaults IN SHARE MODE;

  -- PASS 1: compute every (customer, line) cents + prorated qty into v_rows.
  FOR v_item IN
    SELECT * FROM order_items WHERE order_id = p_order_id ORDER BY sort_order NULLS LAST, id
  LOOP
    v_line_cents := round(v_item.total_price * 100)::bigint;

    IF NOT EXISTS (SELECT 1 FROM order_item_field_allocations WHERE order_item_id = v_item.id) THEN
      -- Unallocated line: bill the whole line (incl. its full acres) to the order's own customer.
      v_rows := v_rows || jsonb_build_object(
        'c', v_order.customer_id, 'oi', v_item.id,
        'cents', v_line_cents, 'qty', COALESCE(v_item.total_units_needed, 0),
        'acres', COALESCE(v_item.acres, 0));
      CONTINUE;
    END IF;

    -- Split the line across its fields BY ACRES (stable order = field_id).
    SELECT sum(acres) INTO v_total_acres
      FROM order_item_field_allocations WHERE order_item_id = v_item.id;
    SELECT array_agg(acres / v_total_acres * 100 ORDER BY field_id) INTO v_acre_pcts
      FROM order_item_field_allocations WHERE order_item_id = v_item.id;
    v_field_cents := calculate_billing_splits(v_line_cents, v_acre_pcts);

    v_field_idx := 0;
    FOR v_alloc IN
      SELECT field_id, acres FROM order_item_field_allocations
      WHERE order_item_id = v_item.id ORDER BY field_id
    LOOP
      v_field_idx := v_field_idx + 1;

      -- Owners of this field, or fall back to the field's own customer at 100%.
      IF EXISTS (SELECT 1 FROM field_billing_defaults WHERE field_id = v_alloc.field_id) THEN
        SELECT array_agg(customer_id ORDER BY customer_id),
               array_agg(split_pct ORDER BY customer_id),
               sum(split_pct)
          INTO v_owner_ids, v_owner_pcts, v_sum_pct
          FROM field_billing_defaults WHERE field_id = v_alloc.field_id;
        IF v_sum_pct < 99.99 OR v_sum_pct > 100.01 THEN
          RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: field % billing splits total % (must equal 100)',
            v_alloc.field_id, v_sum_pct;
        END IF;
        -- Normalize to sum EXACTLY 100 (order-preserving) so calculate_billing_splits — which assumes
        -- the percentages total 100 — cannot over-allocate within the tolerance band, e.g. 50.01+50.00
        -- would otherwise floor to MORE than the field's cents (Codex P2). v_owner_ids stays aligned.
        SELECT array_agg(p / v_sum_pct * 100 ORDER BY ord)
          INTO v_owner_pcts FROM unnest(v_owner_pcts) WITH ORDINALITY AS u(p, ord);
      ELSE
        SELECT ARRAY[customer_id] INTO v_owner_ids FROM fields WHERE id = v_alloc.field_id;
        v_owner_pcts := ARRAY[100::numeric];
      END IF;

      -- Split this field's portion among its owners BY split_pct (penny-exact).
      v_owner_cents := calculate_billing_splits(v_field_cents[v_field_idx], v_owner_pcts);

      FOR v_oidx IN 1..array_length(v_owner_ids, 1) LOOP
        -- This owner's slice of THIS field = field acres * their normalized pct. Bill that many
        -- acres to them (so split invoice items carry PRORATED acres, not the line's full acres —
        -- otherwise year-end/RUP acre reports double-count; Codex round-5 P2). qty is prorated by the
        -- same acre-share: well-defined even for a $0 line (v_total_acres > 0 for any allocated line)
        -- and it sums back to the line's total qty across owners.
        v_owner_acres := v_alloc.acres * v_owner_pcts[v_oidx] / 100;
        v_rows := v_rows || jsonb_build_object(
          'c', v_owner_ids[v_oidx], 'oi', v_item.id,
          'cents', v_owner_cents[v_oidx],
          'acres', round(v_owner_acres, 4),
          'qty', COALESCE(v_item.total_units_needed, 0) * v_owner_acres / v_total_acres);
      END LOOP;
    END LOOP;
  END LOOP;

  -- Quantities use integer ten-thousandths and deterministic largest remainders.
  -- Keep the existing penny allocation and acres; conserve each source line exactly.
  WITH shares AS (
    SELECT x.c, x.oi, sum(x.cents)::bigint AS cents, sum(x.qty) AS qty, sum(x.acres) AS acres
      FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric, acres numeric)
     GROUP BY x.c, x.oi
  ), units AS (
    SELECT s.*, floor(s.qty * 10000)::bigint AS floor_units,
           (round(coalesce(oi.total_units_needed, 0), 4) * 10000)::bigint AS total_units
      FROM shares s JOIN order_items oi ON oi.id = s.oi
  ), ranked AS (
    SELECT u.*, row_number() OVER (PARTITION BY oi ORDER BY qty * 10000 - floor_units DESC, c) AS share_rank,
           total_units - sum(floor_units) OVER (PARTITION BY oi) AS extra_units
      FROM units u
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'c', c, 'oi', oi, 'cents', cents, 'acres', acres,
           'qty', (floor_units + CASE WHEN share_rank <= extra_units THEN 1 ELSE 0 END)::numeric / 10000)
         ORDER BY oi, c), '[]'::jsonb)
    INTO v_rows FROM ranked;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric, acres numeric)
      JOIN order_items oi ON oi.id = x.oi
     GROUP BY x.oi, oi.total_units_needed
    HAVING sum(x.qty) <> round(coalesce(oi.total_units_needed, 0), 4)
  ) THEN
    RAISE EXCEPTION 'SPLIT_QUANTITY_RECONCILIATION_FAILED: split quantities must equal their source line';
  END IF;

  -- A customer whose allocated subtotal is NEGATIVE (a discount line allocated to them exceeds their
  -- charges) cannot become a non-negative invoice; silently skipping them (the outer HAVING > 0 below)
  -- would make the OTHER customers' invoices over-sum the order total — breaking the penny-exact
  -- reconciliation guarantee. Fail loudly instead of mis-billing (Codex round-6 P2). A net-ZERO customer
  -- is safe to skip (contributes 0, reconciliation still holds); only a strictly-negative net is rejected.
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric, acres numeric)
    GROUP BY x.c HAVING sum(x.cents) < 0
  ) THEN
    RAISE EXCEPTION 'SPLIT_NET_NEGATIVE: a customer''s allocated subtotal is negative — cannot create split invoices (adjust the discount/allocation or issue a credit memo)';
  END IF;

  -- PASS 2: one invoice per customer, from the accumulated contributions.
  v_group_id := gen_random_uuid();

  FOR v_cust IN
    SELECT x.c AS customer_id, sum(x.cents) AS cust_total
    FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric)
    GROUP BY x.c
    HAVING sum(x.cents) > 0
    ORDER BY x.c
  LOOP
    INSERT INTO invoices (order_id, customer_id, invoice_type, status, season, salesman_id,
      created_by, total_amount_cents, invoice_date, invoice_group_id, header_notes)
    VALUES (p_order_id, v_cust.customer_id, p_invoice_type, 'draft',
      COALESCE(v_order.season, compute_season(v_business_date)),
      COALESCE(p_salesman_id, v_order.salesman_id), auth.uid(), 0, v_business_date, v_group_id,
      'Split invoice (by field/acre) from order ' || v_order.order_number)
    RETURNING id INTO v_invoice_id;

    v_total_cents := 0;
    FOR v_item IN
      SELECT oi.*, agg.cents AS cust_cents, agg.qty AS cust_qty, agg.acres AS cust_acres
      FROM (
        SELECT x.oi AS order_item_id, sum(x.cents)::bigint AS cents, sum(x.qty) AS qty, sum(x.acres) AS acres
        FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric, acres numeric)
        WHERE x.c = v_cust.customer_id
        GROUP BY x.oi
        -- Keep a line on the invoice if the customer has ANY contribution to it: non-zero cents
        -- (incl. a negative discount line, so the total reconciles to their net — Codex round-4 P2),
        -- OR non-zero qty/acres (so a legitimate $0 / no-charge product line still carries its product,
        -- quantity and acres for the PDF and year-end usage reports, matching create_invoice_from_order
        -- — Codex round-5 P2). The per-customer (outer) HAVING > 0 still gates which customers get a
        -- (CHECK-non-negative) invoice; a customer whose net is <= 0 is skipped (v1 — a net credit /
        -- a $0-only allocation would need a credit_memo / explicit $0 invoice, out of scope).
        HAVING sum(x.cents) <> 0 OR sum(x.qty) <> 0 OR sum(x.acres) <> 0
      ) agg
      JOIN order_items oi ON oi.id = agg.order_item_id
      ORDER BY oi.sort_order NULLS LAST, oi.id
    LOOP
      INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity,
        unit_price_cents, extended_cents, cost_cents, sort_order, rate_per_acre, acres, unit_size)
      VALUES (v_invoice_id, v_item.id, v_item.product_id, COALESCE(v_item.product_name, ''),
        v_item.cust_qty, round(v_item.price_per_unit * 100)::bigint, v_item.cust_cents,
        round(v_item.cost_per_unit * 100)::bigint, COALESCE(v_item.sort_order, 0),
        v_item.actual_rate, v_item.cust_acres,
        -- Split-payer return (20261021155000): a line with no unit is billed as 'ea', the unit its
        -- return carries (create_return), so the return credit can trace the sale line it reverses
        -- (the credit refuses a source line whose unit differs: RETURN_CREDIT_UNIT_MISMATCH).
        COALESCE(v_item.unit_size, 'ea'));
      v_total_cents := v_total_cents + v_item.cust_cents;
    END LOOP;

    UPDATE invoices SET total_amount_cents = v_total_cents WHERE id = v_invoice_id;

    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description)
    VALUES ('invoice_created', 'invoice', v_invoice_id,
      COALESCE((SELECT role FROM profiles WHERE id = auth.uid()), 'admin'),
      jsonb_build_object('order_number', v_order.order_number, 'group_id', v_group_id,
        'split_basis', 'field_acre'),
      v_total_cents, 'Split invoice (by field/acre) from order ' || v_order.order_number);

    v_invoice_ids := v_invoice_ids || v_invoice_id;
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('split_invoices_created',
    COALESCE(array_length(v_invoice_ids, 1), 0) || ' split invoices from order ' || v_order.order_number,
    auth.uid(), 'order', p_order_id, v_order.customer_id);

  -- U7 SAFE-SCOPE (#43): the order is now split-billed per-owner — clear the
  -- "needs split billing" queue flag complete_delivery set when it skipped the mono-bill.
  UPDATE orders SET needs_split_billing = false, updated_at = now() WHERE id = p_order_id;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_split_invoices_from_order',
      to_jsonb(array_to_string(v_invoice_ids, ',')));
  END IF;

  RETURN v_invoice_ids;
END;
$function$;

DO $split_postflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='_create_split_invoices_from_order_provenance_impl_20260719') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)')
         AND md5(p.prosrc) IN ('141b26d15133656e1c09bda75be52cc4')
         AND p.proowner='postgres'::regrole AND p.prosecdef
         AND p.prorettype='uuid[]'::regtype AND p.provolatile='v' AND NOT p.proisstrict AND p.proparallel='u'
         AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
         AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN
    RAISE EXCEPTION 'ORDER_SPLIT_QUANTITY_DRIFT: split engine body or contract changed';
  END IF;
END;
$split_postflight$;
