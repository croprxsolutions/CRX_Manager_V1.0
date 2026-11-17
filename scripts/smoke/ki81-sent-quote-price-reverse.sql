-- Reverse of 20270123100000_ki81_invoices_bill_sent_quote_price: restores the five bodies it replaced and drops
-- the two helpers. Run as ONE transaction (psql -1). Proven by scripts/smoke/prove-ki81-sent-quote-price-real-schema.mjs.
DO $pre$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('create_invoice_from_blend_ticket', 'public.create_invoice_from_blend_ticket(uuid,uuid,text,text,jsonb)', '81bcfd088498f0cb1624f161e1a55e46', ARRAY['authenticated', 'postgres', 'service_role'], 'v'),
        ('_save_field_app_invoice_impl_20260714', 'public._save_field_app_invoice_impl_20260714(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)', '7ec879b190189252a79d728584a08980', ARRAY['postgres', 'service_role'], 'v'),
        ('_save_field_app_split_invoice_impl', 'public._save_field_app_split_invoice_impl(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text,text)', '767b12bc61a96bf90c6adb5cb392d7be', ARRAY['postgres', 'service_role'], 'v'),
        ('_preview_field_app_invoice_split_impl_20260908', 'public._preview_field_app_invoice_split_impl_20260908(jsonb,jsonb,uuid,uuid,date)', 'a6ab05aaab8252db0607b6660666be09', ARRAY['postgres'], 's')
      ) AS pin(fn, sig, body_md5, execs, vol)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc o
             WHERE o.pronamespace = 'public'::regnamespace AND o.proname = pin.fn) <> 1
        OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
        OR p.proowner <> 'postgres'::regrole
        OR NOT p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR p.provolatile::text <> pin.vol OR p.proisstrict OR p.proleakproof OR p.proretset
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM pin.execs
  ) THEN
    RAISE EXCEPTION 'KI81_REVERSE_PREFLIGHT: the live bodies are not the ones 20270123100000 installs';
  END IF;
  IF to_regprocedure('public.resolve_field_app_chemical_price(uuid,uuid[],integer,bigint,uuid[],date)') IS NULL OR to_regprocedure('public._field_app_sent_quote_price_cents(uuid,uuid[],uuid[],date)') IS NULL OR to_regprocedure('public._field_app_quote_eligible(quotes,uuid,uuid[],date)') IS NULL THEN
    RAISE EXCEPTION 'KI81_REVERSE_PREFLIGHT: 20270123100000 is not applied';
  END IF;
END;
$pre$;
DROP FUNCTION public.resolve_field_app_chemical_price(uuid, uuid[], integer, bigint, uuid[], date);
CREATE OR REPLACE FUNCTION public.resolve_field_app_chemical_price(
  p_product_id         uuid,
  p_field_ids          uuid[],
  p_tier               integer,
  p_manual_price_cents bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_unit_price bigint;
  v_qi_price   numeric;
BEGIN
  -- 1) Manual override wins (caller must have explicitly flagged it upstream).
  IF p_manual_price_cents IS NOT NULL THEN
    RETURN jsonb_build_object('unit_price_cents', p_manual_price_cents, 'price_source', 'manual');
  END IF;

  -- A manual line with no product can only be manually priced; 0 otherwise.
  IF p_product_id IS NULL THEN
    RETURN jsonb_build_object('unit_price_cents', 0, 'price_source', 'manual');
  END IF;

  -- 2) Customer quote for one of these fields (dollars -> cents).
  SELECT qi.price_per_unit
    INTO v_qi_price
    FROM quote_items qi
    JOIN quote_sections qs ON qs.id = qi.section_id
   WHERE qi.product_id = p_product_id
     AND qs.field_id = ANY(p_field_ids)
   ORDER BY qi.id
   LIMIT 1;
  IF v_qi_price IS NOT NULL THEN
    RETURN jsonb_build_object('unit_price_cents', round(v_qi_price * 100)::bigint,
                              'price_source', 'quoted');
  END IF;

  -- 3) Product tier list price (fallback to tier1 when the tier price is null).
  SELECT CASE COALESCE(p_tier, 1)
           WHEN 2 THEN COALESCE(round(p.tier2_price * 100), round(p.tier1_price * 100), 0)
           WHEN 3 THEN COALESCE(round(p.tier3_price * 100), round(p.tier1_price * 100), 0)
           ELSE      COALESCE(round(p.tier1_price * 100), 0)
         END
    INTO v_unit_price
    FROM products p
   WHERE p.id = p_product_id;

  RETURN jsonb_build_object('unit_price_cents', COALESCE(v_unit_price, 0), 'price_source', 'tier');
END;
$fn$;
ALTER FUNCTION public.resolve_field_app_chemical_price(uuid, uuid[], integer, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_field_app_chemical_price(uuid, uuid[], integer, bigint)
  FROM public, anon, authenticated;
CREATE OR REPLACE FUNCTION public.create_invoice_from_blend_ticket(p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text, p_below_cost_reason text DEFAULT NULL::text, p_approved_zero_lines jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor               uuid := auth.uid();
  v_existing            jsonb;
  v_ticket              record;
  v_field_ids           uuid[];
  v_applied_acres_map   jsonb := '{}'::jsonb;
  v_btf                 record;
  v_field_acres         numeric;
  v_shares              jsonb;
  v_customers           jsonb;
  v_customer            jsonb;
  v_customer_id         uuid;
  v_customer_name       text;
  v_customer_tier       int;
  v_is_primary          boolean;
  v_has_override        boolean;
  v_invoice_id          uuid;
  v_invoice_number      text;
  v_invoice_group_id    uuid;
  v_invoice_ids         uuid[] := '{}';
  v_app_service         record;
  v_has_app_service     boolean := false;
  v_fee_rate            bigint;
  v_btp                 record;
  v_share_row           jsonb;
  v_share_acres         numeric;
  v_field_override      bigint;
  v_field_pricing_note  text;
  v_unit_price          bigint;
  v_unit_cost           bigint;
  v_qi_price            numeric;
  v_quoted_price        bigint;
  v_quote_section_id    uuid;
  v_price_source        text;
  v_extended            bigint;
  v_invoice_total       bigint;
  v_invoice_cost        bigint;
  v_total_share_acres   numeric;
  v_grower_share_amount bigint;
  v_fee_acres           numeric;
  v_fee_extended        bigint;
  v_fee_cost            bigint;
  v_result              jsonb;
  v_customer_count      int;
  v_chem_qty_a          numeric;
  v_chem_qty_b          numeric;
  v_rate                numeric;
  -- A5: unit-conversion + pre-billing validation locals
  v_rate_unit_line      text;
  v_inv_unit_line       text;
  v_chem_qty_a_conv     numeric;
  v_chem_qty_b_conv     numeric;
  v_zero_qty_line       record;
  v_bad_rate            text;
  v_bad_unit            text;
  -- Goal 3 pricing (20261020210000)
  v_price_choices       jsonb;
  v_unpriced            text;
  v_zero_line           jsonb;
  v_zero_lines          jsonb;
  v_zero_quoted         boolean;
  -- Blend invoice approval binding (20261021070000)
  v_unmatched           int;
  v_zero_grower         boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_created_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create blend ticket invoices';
  END IF;

  -- Own name (Mason, 2026-10-06, narrowed 2026-10-13): a sales rep bills any customer but only
  -- under their own name; an admin may name anyone. Every invoice below carries the ticket's
  -- salesperson, so a non-admin may bill a ticket only when it is theirs or has no salesperson.
  -- The ticket is locked first, so an admin reassigning it cannot change that salesperson between
  -- this test and the inserts, and the test runs before the replay lookup and any invoice number.
  IF NOT public.is_admin() THEN
    PERFORM 1 FROM public.blend_tickets bt WHERE bt.id = p_blend_ticket_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM public.blend_tickets bt
       WHERE bt.id = p_blend_ticket_id
         AND bt.salesman_id IS NOT NULL
         AND bt.salesman_id IS DISTINCT FROM v_actor
    ) THEN
      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
    END IF;
  END IF;

  -- 20261021070000: a retry key is required, so a lost reply can always be replayed instead of
  -- refused as already billed (the screen always sends one).
  IF NULLIF(btrim(COALESCE(p_idempotency_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_invoice_from_blend_ticket requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;

  -- 20261022020000: the key is required just above, so the replay lookup always runs (the
  -- "IF p_idempotency_key IS NOT NULL" test that wrapped it could never be false).
  v_existing := public.check_idempotency(
    p_idempotency_key,
    'create_invoice_from_blend_ticket'
  );
  IF v_existing IS NOT NULL THEN
    -- The receipt is keyed by the key alone. Replay it only to the person who billed this
    -- ticket under that key, so a reused key never returns another ticket's or another
    -- person's invoices.
    IF jsonb_typeof(v_existing->'invoice_ids') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_existing->'invoice_ids') = 0
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(v_existing->'invoice_ids') AS r(invoice_id)
           LEFT JOIN public.invoices i ON i.id = r.invoice_id::uuid
          WHERE i.id IS NULL
             OR i.blend_ticket_id IS DISTINCT FROM p_blend_ticket_id
             OR i.created_by IS DISTINCT FROM v_actor
       ) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_ticket
    FROM blend_tickets
   WHERE id = p_blend_ticket_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id; END IF;
  -- 20261021070000: hold the ticket's lines too, so a line edited between the $0 approval
  -- check below and the billing loop cannot bill something the approval never covered (the
  -- office policy lets staff update these rows directly).
  PERFORM 1 FROM blend_ticket_products btp WHERE btp.blend_ticket_id = p_blend_ticket_id FOR UPDATE;
  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved (status: %)', v_ticket.review_status;
  END IF;
  IF v_ticket.payment_status IS DISTINCT FROM 'unbilled' THEN
    RAISE EXCEPTION 'Blend ticket cannot be billed (payment_status: %); only an unbilled ticket can generate an invoice', v_ticket.payment_status;
  END IF;

  -- A linked sales-order path and a direct blend-ticket invoice are mutually
  -- exclusive billing provenance. The ticket row is already locked, and these
  -- checks run before field derivation, invoice numbering, commissions, or writes.
  IF v_ticket.order_link_status = 'linked'
     OR EXISTS (
       SELECT 1 FROM public.blend_ticket_to_order_items
        WHERE blend_ticket_id = p_blend_ticket_id
     ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_LINKED_ORDER_INVOICE_LOCKED';
  END IF;

  -- Do not trust the cached payment flag alone: an active invoice may exist
  -- while payment_status is stale/unbilled. Terminal invoices release the lock.
  IF EXISTS (
    SELECT 1 FROM public.invoices i
     WHERE i.blend_ticket_id = p_blend_ticket_id
       AND i.deleted_at IS NULL
       AND COALESCE(i.status, '') NOT IN ('voided', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_ACTIVE_INVOICE_EXISTS';
  END IF;

  -- U6 #91a: refuse to bill the blend ticket if its linked job has ALREADY been
  -- invoiced (job.status='invoiced', or job.invoice_id points at a still-active
  -- invoice). The blend ticket and the job invoice bill the SAME application, so
  -- letting both through double-bills the customer. Block, do not warn.
  IF v_ticket.job_id IS NOT NULL THEN
    -- U6 (Codex P1): lock the JOB row first — transfer_job_to_invoice locks this
    -- same row (FOR UPDATE) before ITS blend-ticket guard, so the two paths
    -- serialize on it; without the lock both guards could read pre-commit state
    -- concurrently and both invoices would land (the exact double-bill this
    -- guard exists to stop). Lock order is safe: neither path row-locks
    -- blend_tickets after jobs.
    PERFORM 1 FROM jobs WHERE id = v_ticket.job_id FOR UPDATE;
    -- Codex R2 P2: test for a LIVE invoice directly (invoices.job_id, non-void/
    -- cancel, not deleted) instead of trusting jobs.status — a job stranded as
    -- 'invoiced' by a PRE-U6 void (dead invoice, status never reverted) must not
    -- block billing the ticket forever.
    IF EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.job_id = v_ticket.job_id
        AND i.status NOT IN ('voided', 'cancelled')
        AND i.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'JOB_ALREADY_INVOICED: this blend ticket''s job has already been invoiced; billing the ticket too would double-bill the customer. Void the job invoice first if you meant to re-bill.';
    END IF;
  END IF;

  -- A5 BEGIN: refuse to bill blend lines that can't be priced correctly.
  -- (1) A billable product line with no per-acre rate would silently bill $0.
  SELECT string_agg(DISTINCT btp.product_name, ', ')
    INTO v_bad_rate
    FROM blend_ticket_products btp
   WHERE btp.blend_ticket_id = p_blend_ticket_id
     AND btp.product_id IS NOT NULL
     AND (btp.rate_per_acre IS NULL OR btp.rate_per_acre <= 0);
  IF v_bad_rate IS NOT NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_ZERO_RATE: product(s) have no per-acre rate and cannot be billed: %', v_bad_rate;
  END IF;
  -- (2) A billable line whose rate unit cannot convert to the product's inventory
  --     (pricing) unit would mis-bill by the unit ratio (the oz-vs-gal 128x class).
  SELECT string_agg(DISTINCT btp.product_name, ', ')
    INTO v_bad_unit
    FROM blend_ticket_products btp
    JOIN products p ON p.id = btp.product_id
   WHERE btp.blend_ticket_id = p_blend_ticket_id
     AND btp.product_id IS NOT NULL
     AND field_app_priced_quantity(
           1,
           normalize_rate_unit(COALESCE(NULLIF(btrim(btp.rate_per_acre_unit), ''), p.rate_unit)),
           normalize_rate_unit(COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)),
           p.product_form
         ) IS NULL;
  IF v_bad_unit IS NOT NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_UNIT_UNCONVERTIBLE: product(s) have a rate unit that cannot convert to the inventory unit: %', v_bad_unit;
  END IF;
  -- A5 END

  FOR v_btf IN
    SELECT btf.field_id,
           COALESCE(btf.actual_acres, btf.planned_acres, f.total_acres, 0) AS field_acres
      FROM blend_ticket_fields btf
      JOIN fields f ON f.id = btf.field_id
     WHERE btf.blend_ticket_id = p_blend_ticket_id
  LOOP
    v_field_ids := array_append(v_field_ids, v_btf.field_id);
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(v_btf.field_id::text, v_btf.field_acres);
  END LOOP;

  IF v_field_ids IS NULL OR array_length(v_field_ids, 1) IS NULL THEN
    IF v_ticket.field_id IS NOT NULL THEN
      v_field_ids := ARRAY[v_ticket.field_id];
      SELECT COALESCE(v_ticket.total_acres, f.total_acres, 0) INTO v_field_acres
        FROM fields f WHERE f.id = v_ticket.field_id;
      v_applied_acres_map := jsonb_build_object(v_ticket.field_id::text, v_field_acres);
    ELSE
      RAISE EXCEPTION 'Blend ticket has no fields';
    END IF;
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  v_customer_count := jsonb_array_length(v_customers);

  IF v_customer_count = 0 THEN
    RAISE EXCEPTION 'No billing customers derived from blend ticket fields';
  END IF;

  IF v_ticket.application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = v_ticket.application_service_id;
    v_has_app_service := FOUND
                         AND (v_app_service IS NOT NULL)
                         AND COALESCE(v_app_service.is_active, false);
  END IF;

  -- 20261021070000: every line must be a catalog product. A line with no product has no price or
  -- cost to check, so it billed $0 with no approval; refuse it, as the order path
  -- (create_order_from_blend_ticket) already does, before any invoice number or row.
  SELECT count(*) INTO v_unmatched
    FROM blend_ticket_products btp
   WHERE btp.blend_ticket_id = p_blend_ticket_id
     AND btp.product_id IS NULL;
  IF v_unmatched > 0 THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRODUCT_UNMATCHED: % line(s) are not matched to a product; match them before invoicing', v_unmatched;
  END IF;

  v_quote_section_id := NULL;
  IF v_ticket.job_id IS NOT NULL THEN
    SELECT j.quote_section_id INTO v_quote_section_id FROM jobs j WHERE j.id = v_ticket.job_id;
  END IF;
  -- Goal 3 pricing (20261020210000): a job pointed at another customer's quote, at a deleted
  -- quote, or at a section of a quote other than the job's own quote, supplies no quoted price (and
  -- no choices); the lines bill their tier prices instead.
  IF v_quote_section_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM quote_sections qs JOIN quotes q ON q.id = qs.quote_id
        WHERE qs.id = v_quote_section_id
          AND q.customer_id = v_ticket.customer_id
          AND q.deleted_at IS NULL
          AND q.id = (SELECT j.quote_id FROM jobs j WHERE j.id = v_ticket.job_id)) THEN
    v_quote_section_id := NULL;
  END IF;
  -- 20261021070000: hold the quote prices still until this invoice commits, so the $0 check
  -- below and the billing loop read the same prices (an approval covers only what it showed).
  IF v_quote_section_id IS NOT NULL THEN
    PERFORM 1 FROM quote_sections WHERE id = v_quote_section_id FOR UPDATE;
    PERFORM 1 FROM quote_items WHERE section_id = v_quote_section_id FOR SHARE;
  END IF;
  -- 20261021070000: hold the ticket's product costs still too (FOR SHARE, as the below-cost line
  -- trigger takes them; in id order), so the cost an approval was bound to is the cost billed.
  PERFORM 1 FROM products p
   WHERE p.id IN (SELECT btp.product_id FROM blend_ticket_products btp
                   WHERE btp.blend_ticket_id = p_blend_ticket_id AND btp.product_id IS NOT NULL)
   ORDER BY p.id
     FOR SHARE OF p;

  -- Goal 3 pricing (20261020210000), both before any invoice number or row:
  -- (1) The job's quote lists a product more than once at different prices. Taking one at
  --     random breaks "sent quotes keep their prices", so stop and hand the screen the choices;
  --     staff pick one with set_blend_ticket_product_quote_price, which stores it on the line.
  --     A stored pick counts only while it still matches a usable price on THIS job's quote for
  --     the line's CURRENT product and the ticket's customer (_blend_quote_pick_valid_20261020),
  --     so editing the product or the job asks again. Only usable quote prices count (finite,
  --     zero or above, whole cents), each price offered once, and only when some billed share is
  --     priced per unit (a line billed wholly inside grower-share overrides never uses it).
  IF v_quote_section_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
                  WHERE (r.value->>'price_override_cents') IS NULL
                    AND (r.value->>'share_acres')::numeric > 0) THEN
    SELECT jsonb_agg(jsonb_build_object(
             'blend_ticket_product_id', btp.id,
             'product_id', btp.product_id,
             'product_name', btp.product_name,
             'options', (
               SELECT jsonb_agg(jsonb_build_object(
                        'quote_item_id', o.id,
                        'price_cents', o.price_cents)
                      ORDER BY o.sort_order, o.id)
                 FROM (SELECT DISTINCT ON (ROUND(qi.price_per_unit * 100))
                              qi.id, qi.sort_order, ROUND(qi.price_per_unit * 100)::bigint AS price_cents
                         FROM quote_items qi
                        WHERE qi.section_id = v_quote_section_id
                          AND qi.product_id = btp.product_id
                          AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2)
                        ORDER BY ROUND(qi.price_per_unit * 100), qi.sort_order, qi.id) o))
           ORDER BY btp.sequence_order, btp.id)
      INTO v_price_choices
      FROM blend_ticket_products btp
     WHERE btp.blend_ticket_id = p_blend_ticket_id
       AND btp.product_id IS NOT NULL
       AND NOT public._blend_quote_pick_valid_20261020(
             v_quote_section_id, v_ticket.customer_id, btp.product_id, btp.unit_price_cents)
       AND (SELECT count(DISTINCT ROUND(qi.price_per_unit * 100))
              FROM quote_items qi
             WHERE qi.section_id = v_quote_section_id
               AND qi.product_id = btp.product_id
               AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2)) > 1;
    IF v_price_choices IS NOT NULL THEN
      RAISE EXCEPTION 'BLEND_TICKET_QUOTE_PRICE_CHOICE_REQUIRED: the quote lists a product more than once at different prices; pick the price to bill'
        USING DETAIL = jsonb_build_object('products', v_price_choices)::text;
    END IF;
  END IF;
  -- (2) A product billed at its tier price (no valid pick, no usable quote price) for a
  --     customer with a priced share uses that customer's tier price when it is above zero,
  --     otherwise the tier-1 price; a product with neither is refused instead of billed at $0.
  SELECT string_agg(DISTINCT COALESCE(btp.full_product_name, btp.product_name), ', ')
    INTO v_unpriced
    FROM (SELECT b.*, p.product_name AS full_product_name, p.tier1_price, p.tier2_price, p.tier3_price
            FROM blend_ticket_products b
            JOIN products p ON p.id = b.product_id
           WHERE b.blend_ticket_id = p_blend_ticket_id
             AND NOT public._blend_quote_pick_valid_20261020(
                   v_quote_section_id, v_ticket.customer_id, b.product_id, b.unit_price_cents)) btp
    CROSS JOIN LATERAL (
      SELECT DISTINCT COALESCE((c.value->>'tier')::int, 1) AS tier
        FROM jsonb_array_elements(v_customers) AS c(value)
       WHERE EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
          WHERE (r.value->>'customer_id')::uuid = (c.value->>'customer_id')::uuid
            AND (r.value->>'price_override_cents') IS NULL
            AND (r.value->>'share_acres')::numeric > 0)
    ) cust
   WHERE NOT EXISTS (
           SELECT 1 FROM quote_items qi
            WHERE v_quote_section_id IS NOT NULL
              AND qi.section_id = v_quote_section_id
              AND qi.product_id = btp.product_id
              AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2))
     AND public._blend_tier_price_cents_20261020(cust.tier, btp.tier1_price, btp.tier2_price, btp.tier3_price) IS NULL;
  IF v_unpriced IS NOT NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRICE_MISSING: product(s) have no price on the price list: %', v_unpriced;
  END IF;
  -- (3) A product the job's quote lists at $0 bills at $0 (Mason, 2026-10-20: "$0 of $0 but
  --     flag it in system and alert before save"). A $0 line is below cost, so it goes through
  --     the below-cost wall: only an admin, with a written reason (p_below_cost_reason), and the
  --     line trigger records each approval in below_cost_approvals. This asks first, with the same
  --     error shape the trigger uses, so the screen shows its approval window before any invoice
  --     number is drawn. It finds the price exactly as the line pricing below does (a valid pick,
  --     else the first usable quote line), for a line some priced share will bill per unit.
  --     The detail names the first $0 line in the trigger's fields and lists EVERY $0 line in
  --     zero_lines (Mason, 2026-10-20: "list every $0 line"), so the approval window shows
  --     every line the one reason approves.
  --     (20261021070000) A product line billed inside a grower-share override goes on the
  --     invoice at $0 ("included in grower share": the per-acre override carries the price), so it
  --     is below cost too and takes the same approval. Before, it reached the line trigger with no
  --     approval context and was refused, so such a ticket could not be invoiced at all.
  --     The approval also names the exact lines it covers (p_approved_zero_lines: each line and
  --     product as the screen showed them). If the $0 lines changed in between (a re-pick, an
  --     edited line), nothing is invoiced and the screen asks again.
  SELECT jsonb_agg(jsonb_build_object(
           'line_id', z.id,
           'product_id', z.product_id,
           'product_name', z.product_name,
           'cost_cents', z.cost_cents,
           'kind', CASE WHEN z.quoted_zero AND z.in_grower_share THEN 'quoted_zero_and_grower_share'
                        WHEN z.quoted_zero THEN 'quoted_zero' ELSE 'grower_share' END,
           -- What sets this line's billed quantity and the grower-share charge: its rate and rate
           -- unit, the product's units and form (the quantity conversion), and every field's acres
           -- and per-acre price. The approval must send it back unchanged.
           'basis', md5(format('%L|%L|%L|%L|%L|%L|%L', z.rate_per_acre, z.rate_per_acre_unit,
                      z.p_rate_unit, z.p_inventory_unit, z.p_unit_size, z.p_product_form,
                      (SELECT string_agg(r.value::text, ',' ORDER BY r.value::text)
                         FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)))))
         ORDER BY z.sequence_order, z.id)
    INTO v_zero_lines
    FROM (SELECT y.*,
                 COALESCE(y.price_cents = 0
                          AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
                                       WHERE (r.value->>'price_override_cents') IS NULL
                                         AND (r.value->>'share_acres')::numeric > 0), false) AS quoted_zero,
                 EXISTS (SELECT 1 FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
                          WHERE (r.value->>'price_override_cents') IS NOT NULL
                            AND (r.value->>'share_acres')::numeric > 0) AS in_grower_share
            FROM (SELECT btp.id, btp.product_id, btp.sequence_order, btp.rate_per_acre, btp.rate_per_acre_unit,
                         p.rate_unit AS p_rate_unit, p.inventory_unit AS p_inventory_unit,
                         p.unit_size AS p_unit_size, p.product_form AS p_product_form,
                         COALESCE(p.product_name, btp.product_name) AS product_name,
                         ROUND(p.current_cost * 100)::bigint AS cost_cents,
                         CASE WHEN v_quote_section_id IS NULL THEN NULL
                              WHEN public._blend_quote_pick_valid_20261020(
                                     v_quote_section_id, v_ticket.customer_id, btp.product_id, btp.unit_price_cents)
                              THEN btp.unit_price_cents
                              ELSE (SELECT ROUND(qi.price_per_unit * 100)::bigint
                                      FROM quote_items qi
                                     WHERE qi.section_id = v_quote_section_id
                                       AND qi.product_id = btp.product_id
                                       AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2)
                                     ORDER BY qi.id LIMIT 1)
                         END AS price_cents
                    FROM blend_ticket_products btp
                    JOIN products p ON p.id = btp.product_id
                   WHERE btp.blend_ticket_id = p_blend_ticket_id
                     AND COALESCE(btp.rate_per_acre, 0) > 0
                     AND p.current_cost > 0 AND p.current_cost < 'Infinity'::numeric) y) z
   WHERE z.quoted_zero OR z.in_grower_share;
  IF v_zero_lines IS NOT NULL THEN
    v_zero_line := jsonb_build_object(
      'operation', 'create_invoice_from_blend_ticket',
      'entity_type', 'blend_ticket',
      'entity_id', p_blend_ticket_id,
      'line_id', v_zero_lines -> 0 -> 'line_id',
      'product_id', v_zero_lines -> 0 -> 'product_id',
      'product_name', v_zero_lines -> 0 -> 'product_name',
      'unit_price_cents', 0,
      'locked_unit_cost_cents', v_zero_lines -> 0 -> 'cost_cents',
      'zero_lines', v_zero_lines);
    IF NOT public.is_admin() THEN
      -- Cost is admin-only (Mason, 2026-10-15): a non-admin's detail never carries it.
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'BELOW_COST_ADMIN_REQUIRED:' || jsonb_set(v_zero_line - 'locked_unit_cost_cents', '{zero_lines}',
          (SELECT jsonb_agg(e.value - 'cost_cents' ORDER BY e.ord)
             FROM jsonb_array_elements(v_zero_lines) WITH ORDINALITY AS e(value, ord)))::text;
    END IF;
    IF NULLIF(btrim(COALESCE(p_below_cost_reason, '')), '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'BELOW_COST_REASON_REQUIRED:' || v_zero_line::text;
    END IF;
    IF jsonb_typeof(p_approved_zero_lines) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'BELOW_COST_APPROVAL_STALE:' || v_zero_line::text;
    END IF;
    -- Each approved line is bound to what the window showed for it: line, product, why it is $0
    -- (kind) and its cost; a change to any of them asks again.
    IF ARRAY(SELECT DISTINCT lower(e.value->>'line_id') || ':' || lower(e.value->>'product_id') || ':' || COALESCE(e.value->>'kind', '') || ':' || COALESCE(e.value->>'cost_cents', '') || ':' || COALESCE(e.value->>'basis', '')
               FROM jsonb_array_elements(p_approved_zero_lines) AS e(value) ORDER BY 1)
       IS DISTINCT FROM ARRAY(SELECT DISTINCT lower(e.value->>'line_id') || ':' || lower(e.value->>'product_id') || ':' || COALESCE(e.value->>'kind', '') || ':' || COALESCE(e.value->>'cost_cents', '') || ':' || COALESCE(e.value->>'basis', '')
               FROM jsonb_array_elements(v_zero_lines) AS e(value) ORDER BY 1) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'BELOW_COST_APPROVAL_STALE:' || v_zero_line::text;
    END IF;
  ELSIF p_approved_zero_lines IS NOT NULL OR NULLIF(btrim(COALESCE(p_below_cost_reason, '')), '') IS NOT NULL THEN
    -- An approval (a reason or a line list) arrived but no line is $0 any more (a price changed
    -- in between): bill nothing the window did not show; the screen asks again. The reason is
    -- only ever used for $0 lines, so nothing legitimate sends one here. No cost in this detail.
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_APPROVAL_STALE:' || jsonb_build_object(
        'operation', 'create_invoice_from_blend_ticket',
        'entity_type', 'blend_ticket',
        'entity_id', p_blend_ticket_id,
        'zero_lines', '[]'::jsonb)::text;
  END IF;

  -- 20261022020000: each line stores its quantity rounded to 4 places (below). A positive
  -- quantity below 0.00005 would store as 0 and bill a 0-quantity, $0 line while the ticket is
  -- marked billed, so refuse it here, before any invoice number is drawn (a drawn number is never
  -- given back) and the office corrects the rate or acres. The quantity is worked out as the
  -- billing loop below does: per customer, rate x share acres, split by grower-share override,
  -- converted to the pricing unit.
  SELECT COALESCE(p.product_name, btp.product_name) AS product_name, btp.id
    INTO v_zero_qty_line
    FROM blend_ticket_products btp
    LEFT JOIN products p ON p.id = btp.product_id
   CROSS JOIN (SELECT DISTINCT (c.value->>'customer_id')::uuid AS customer_id
                 FROM jsonb_array_elements(v_customers) AS c(value)) cust
   CROSS JOIN LATERAL (
     SELECT COALESCE(SUM(COALESCE(btp.rate_per_acre, 0) * (r.value->>'share_acres')::numeric)
                       FILTER (WHERE (r.value->>'price_override_cents') IS NOT NULL), 0) AS qty_a,
            COALESCE(SUM(COALESCE(btp.rate_per_acre, 0) * (r.value->>'share_acres')::numeric)
                       FILTER (WHERE (r.value->>'price_override_cents') IS NULL), 0) AS qty_b
       FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
      WHERE (r.value->>'customer_id')::uuid = cust.customer_id) q
   CROSS JOIN LATERAL (
     SELECT normalize_rate_unit(COALESCE(NULLIF(btrim(btp.rate_per_acre_unit), ''), p.rate_unit)) AS rate_unit,
            normalize_rate_unit(COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)) AS inv_unit) u
   WHERE btp.blend_ticket_id = p_blend_ticket_id
     AND ((q.qty_a > 0 AND ROUND(CASE WHEN btp.product_id IS NOT NULL
                                THEN field_app_priced_quantity(q.qty_a, u.rate_unit, u.inv_unit, p.product_form)
                                ELSE q.qty_a END, 4) <= 0)
       OR (q.qty_b > 0 AND ROUND(CASE WHEN btp.product_id IS NOT NULL
                                THEN field_app_priced_quantity(q.qty_b, u.rate_unit, u.inv_unit, p.product_form)
                                ELSE q.qty_b END, 4) <= 0))
   ORDER BY btp.sequence_order, btp.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'BLEND_INVOICE_QUANTITY_ROUNDS_TO_ZERO: % (blend ticket line %) bills less than 0.0001 per line; correct the rate or acres', v_zero_qty_line.product_name, v_zero_qty_line.id USING ERRCODE = '22023';
  END IF;

  IF v_customer_count > 1 THEN
    v_invoice_group_id := gen_random_uuid();
  ELSE
    v_invoice_group_id := NULL;
  END IF;

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id   := (v_customer->>'customer_id')::uuid;
    v_customer_name := v_customer->>'customer_name';
    v_customer_tier := COALESCE((v_customer->>'tier')::int, 1);
    v_is_primary    := COALESCE((v_customer->>'is_primary')::boolean, false);
    v_has_override  := COALESCE((v_customer->>'has_override')::boolean, false);

    v_invoice_total := 0;
    v_invoice_cost  := 0;
    v_invoice_number := next_invoice_number();

    INSERT INTO invoices (
      blend_ticket_id, customer_id, invoice_type, status, season,
      invoice_number, salesman_id, created_by,
      total_amount_cents, total_cost_cents,
      invoice_date, invoice_group_id, application_service_id
    ) VALUES (
      p_blend_ticket_id, v_customer_id, 'field_application', 'draft',
      COALESCE(v_ticket.season, public.compute_season((now() AT TIME ZONE 'America/Chicago')::date)),
      v_invoice_number, v_ticket.salesman_id, p_created_by,
      0, 0,
      (now() AT TIME ZONE 'America/Chicago')::date, v_invoice_group_id, v_ticket.application_service_id
    ) RETURNING id INTO v_invoice_id;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value ->> 'customer_id')::uuid = v_customer_id
        AND (value ->> 'price_override_cents') IS NOT NULL
    LOOP
      v_share_acres        := (v_share_row->>'share_acres')::numeric;
      v_field_override     := (v_share_row->>'price_override_cents')::bigint;
      v_field_pricing_note := v_share_row->>'pricing_note';
      v_grower_share_amount := safe_cents_qty(v_field_override, v_share_acres);

      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size,
        unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id,
        (v_share_row->>'field_name') || ' — grower share @ $' ||
          (v_field_override / 100.0)::numeric(12,2) || '/ac' ||
          CASE WHEN v_field_pricing_note IS NOT NULL AND v_field_pricing_note <> ''
               THEN ' (' || v_field_pricing_note || ')' ELSE '' END,
        v_share_acres, 'acre',
        v_field_override, v_grower_share_amount, 0,
        0, v_share_acres, v_field_override, 'acre',
        false, 'manual'
      );
      v_invoice_total := v_invoice_total + v_grower_share_amount;
    END LOOP;

    FOR v_btp IN
      SELECT btp.*, p.tier1_price, p.tier2_price, p.tier3_price,
             p.product_name AS full_product_name, p.current_cost AS product_cost,
             p.unit_size, p.rate_unit,
             -- A5: inventory unit + form drive the rate->pricing-unit conversion
             p.inventory_unit, p.product_form
        FROM blend_ticket_products btp
        LEFT JOIN products p ON p.id = btp.product_id
       WHERE btp.blend_ticket_id = p_blend_ticket_id
       ORDER BY btp.sequence_order
    LOOP
      v_chem_qty_a := 0;
      v_chem_qty_b := 0;
      v_rate := COALESCE(v_btp.rate_per_acre, 0);

      FOR v_share_row IN
        SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
        WHERE (value ->> 'customer_id')::uuid = v_customer_id
      LOOP
        v_share_acres := (v_share_row->>'share_acres')::numeric;
        IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
          v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
        ELSE
          v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
        END IF;
      END LOOP;

      -- A5: convert the accumulated rate-unit quantities to the product's inventory
      -- (pricing) unit so money = price/inventory-unit x qty/inventory-unit. Unmatched
      -- products (no product row) keep the raw quantity (no price, nothing to convert).
      -- Convertibility was pre-validated above, so the helper is non-NULL here.
      -- Display units keep their original casing; the helper gets normalized units
      -- (strips /ac + maps plural/spelled aliases) so oz/ac, gallons, etc. convert.
      v_rate_unit_line := COALESCE(NULLIF(btrim(v_btp.rate_per_acre_unit), ''), v_btp.rate_unit);
      v_inv_unit_line  := COALESCE(NULLIF(btrim(v_btp.inventory_unit), ''), v_btp.unit_size);
      IF v_btp.product_id IS NOT NULL THEN
        v_chem_qty_a_conv := field_app_priced_quantity(v_chem_qty_a, normalize_rate_unit(v_rate_unit_line), normalize_rate_unit(v_inv_unit_line), v_btp.product_form);
        v_chem_qty_b_conv := field_app_priced_quantity(v_chem_qty_b, normalize_rate_unit(v_rate_unit_line), normalize_rate_unit(v_inv_unit_line), v_btp.product_form);
      ELSE
        v_chem_qty_a_conv := v_chem_qty_a;
        v_chem_qty_b_conv := v_chem_qty_b;
      END IF;

      -- 20261022020000: a line stores its quantity rounded to 4 places. Price it, cost it and
      -- add it to the invoice totals from that same stored quantity (as save_invoice does when
      -- a line is saved again), so quantity x price is the line amount and the totals match the
      -- lines. Before, the amount and cost used the unrounded quantity and could differ by cents.
      v_chem_qty_a_conv := ROUND(v_chem_qty_a_conv, 4);
      v_chem_qty_b_conv := ROUND(v_chem_qty_b_conv, 4);

      IF v_chem_qty_a > 0 THEN
        -- 20261021070000: the included line is $0, below cost; it carries the admin's reason (asked
        -- for above) to the line trigger, which re-checks it and records the approval. Only this
        -- insert gets the context.
        v_zero_grower := v_btp.product_id IS NOT NULL
                         AND COALESCE(v_zero_lines @> jsonb_build_array(jsonb_build_object('line_id', v_btp.id, 'product_id', v_btp.product_id)), false);
        IF v_zero_grower THEN
          PERFORM set_config('app.crx_below_cost_operation', 'create_invoice_from_blend_ticket', true);
          PERFORM set_config('app.crx_below_cost_reason', COALESCE(btrim(p_below_cost_reason), ''), true);
        END IF;
        -- 20261021070000: the chemical is billed inside the per-acre price, but it still costs
        -- money; record its catalog cost (locked above: the cost the approval showed and the line
        -- trigger records, not the ticket line's editable copy) so the invoice margin is right.
        v_unit_cost := ROUND(COALESCE(v_btp.product_cost, 0) * 100)::bigint;
        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size,
          unit_price_cents, extended_cents, cost_cents,
          sort_order, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_btp.product_id,
          COALESCE(v_btp.full_product_name, v_btp.product_name) || ' — included in grower share',
          ROUND(v_chem_qty_a_conv, 4), v_inv_unit_line,
          0, 0, v_unit_cost,
          v_btp.sequence_order, v_rate, v_rate_unit_line,
          false, 'manual'
        );
        IF v_zero_grower THEN
          PERFORM set_config('app.crx_below_cost_operation', '', true);
          PERFORM set_config('app.crx_below_cost_reason', '', true);
        END IF;
        v_invoice_cost := v_invoice_cost + safe_cents_qty(v_unit_cost, v_chem_qty_a_conv);
      END IF;

      IF v_chem_qty_b > 0 THEN
        v_unit_price   := NULL;
        v_quoted_price := NULL;
        v_price_source := NULL;

        -- Goal 3 pricing: a price staff picked from this job's quote bills as quoted, but only
        -- while it still matches the current quote, product and customer; a stale or hand-set
        -- value is ignored (the pre-checks above already asked again or tier-priced the line).
        IF public._blend_quote_pick_valid_20261020(
             v_quote_section_id, v_ticket.customer_id, v_btp.product_id, v_btp.unit_price_cents) THEN
          v_unit_price   := v_btp.unit_price_cents;
          v_quoted_price := v_unit_price;
          v_price_source := 'quoted';
        ELSIF v_quote_section_id IS NOT NULL AND v_btp.product_id IS NOT NULL THEN
          SELECT qi.price_per_unit INTO v_qi_price
            FROM quote_items qi
           WHERE qi.section_id = v_quote_section_id
             AND qi.product_id = v_btp.product_id
             AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2)
           ORDER BY qi.id LIMIT 1;
          IF v_qi_price IS NOT NULL THEN
            v_unit_price   := ROUND(v_qi_price * 100)::bigint;
            v_quoted_price := v_unit_price;
            v_price_source := 'quoted';
          END IF;
        END IF;

        IF v_unit_price IS NULL THEN
          IF v_btp.product_id IS NOT NULL THEN
            -- Goal 3 pricing: the tier price, else the tier-1 price, never a missing price as $0.
            v_unit_price := public._blend_tier_price_cents_20261020(
              v_customer_tier, v_btp.tier1_price, v_btp.tier2_price, v_btp.tier3_price);
            IF v_unit_price IS NULL THEN
              RAISE EXCEPTION 'BLEND_TICKET_PRICE_MISSING: product(s) have no price on the price list: %',
                COALESCE(v_btp.full_product_name, v_btp.product_name);
            END IF;
          ELSE
            v_unit_price := 0;
          END IF;
          IF v_price_source IS NULL THEN v_price_source := 'tier'; END IF;
        END IF;

        v_unit_cost := COALESCE(v_btp.unit_cost_cents,
                                ROUND(COALESCE(v_btp.product_cost, 0) * 100)::bigint, 0);
        v_extended := safe_cents_qty(v_unit_price, v_chem_qty_b_conv);
        -- Goal 3 pricing: a $0 quoted line carries the admin's below-cost reason to the line
        -- trigger, which re-checks it and records the approval. Only this line gets the context;
        -- every other line keeps the fail-closed default.
        v_zero_quoted := v_price_source = 'quoted' AND v_unit_price = 0 AND v_btp.product_id IS NOT NULL
                         AND COALESCE(v_zero_lines @> jsonb_build_array(jsonb_build_object('line_id', v_btp.id, 'product_id', v_btp.product_id)), false);
        IF v_zero_quoted THEN
          -- 20261022020000: an approved $0 line records the catalog cost (locked above) that the
          -- approval window showed and below_cost_approvals records, not the ticket line's
          -- editable cost copy, as the included-in-grower-share line already does.
          v_unit_cost := ROUND(COALESCE(v_btp.product_cost, 0) * 100)::bigint;
          PERFORM set_config('app.crx_below_cost_operation', 'create_invoice_from_blend_ticket', true);
          PERFORM set_config('app.crx_below_cost_reason', COALESCE(btrim(p_below_cost_reason), ''), true);
        END IF;

        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size,
          unit_price_cents, extended_cents, cost_cents,
          sort_order, rate_per_acre, rate_unit,
          quoted_price_cents, is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_btp.product_id,
          COALESCE(v_btp.full_product_name, v_btp.product_name),
          ROUND(v_chem_qty_b_conv, 4), v_inv_unit_line,
          v_unit_price, v_extended, v_unit_cost,
          v_btp.sequence_order, v_rate, v_rate_unit_line,
          v_quoted_price, false, v_price_source
        );
        IF v_zero_quoted THEN
          PERFORM set_config('app.crx_below_cost_operation', '', true);
          PERFORM set_config('app.crx_below_cost_reason', '', true);
        END IF;
        v_invoice_total := v_invoice_total + v_extended;
        v_invoice_cost  := v_invoice_cost + safe_cents_qty(v_unit_cost, v_chem_qty_b_conv);
      END IF;
    END LOOP;

    IF v_has_app_service THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id            = v_customer_id
         AND car.application_service_id = v_ticket.application_service_id
         AND car.season                 = COALESCE(v_ticket.season, public.compute_season((now() AT TIME ZONE 'America/Chicago')::date))
       LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;

      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;

      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := safe_cents_qty(v_fee_rate, v_fee_acres);
        v_fee_cost     := safe_cents_qty(v_app_service.cost_per_acre_cents, v_fee_acres);
        INSERT INTO invoice_items (
          invoice_id, description, quantity, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_app_service.name, v_fee_acres,
          v_fee_rate, v_fee_extended, v_fee_cost,
          9999, v_fee_acres, v_fee_rate, 'acre',
          true, 'tier'
        );
        v_invoice_total := v_invoice_total + v_fee_extended;
        v_invoice_cost  := v_invoice_cost + v_fee_cost;
      END IF;
    END IF;

    UPDATE invoices SET
      total_amount_cents = v_invoice_total,
      total_cost_cents   = v_invoice_cost
    WHERE id = v_invoice_id;

    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description
    ) VALUES (
      'invoice_created', 'invoice', v_invoice_id,
      (SELECT role FROM profiles WHERE id = v_actor),
      jsonb_build_object(
        'invoice_number', v_invoice_number,
        'blend_ticket_number', v_ticket.ticket_number,
        'customer_id', v_customer_id,
        'total_cents', v_invoice_total
      ),
      v_invoice_total,
      'Invoice created from blend ticket ' || v_ticket.ticket_number
    );

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_total_share_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id;

    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order,
      price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_total_share_acres, v_invoice_total,
      v_is_primary, 0,
      CASE WHEN v_has_override THEN
        (SELECT (value->>'price_override_cents')::bigint
         FROM jsonb_array_elements(v_shares -> 'rows') AS value
         WHERE (value->>'customer_id')::uuid = v_customer_id
           AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
      ELSE NULL END,
      CASE WHEN v_has_override THEN
        (SELECT (value->>'pricing_note')
         FROM jsonb_array_elements(v_shares -> 'rows') AS value
         WHERE (value->>'customer_id')::uuid = v_customer_id
           AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
      ELSE NULL END
    );
  END LOOP;

  UPDATE blend_tickets SET payment_status = 'billed' WHERE id = p_blend_ticket_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_created',
          'Invoice(s) created from blend ticket ' || v_ticket.ticket_number ||
            CASE WHEN v_invoice_group_id IS NOT NULL
                 THEN ' (group of ' || v_customer_count || ')' ELSE '' END,
          p_created_by, 'invoice', v_invoice_ids[1], v_ticket.customer_id);

  v_result := jsonb_build_object(
    'invoice_ids',      to_jsonb(v_invoice_ids),
    'invoice_group_id', v_invoice_group_id
  );

  -- 20261022020000: the key is required, so the receipt is always saved (no dead NULL test).
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'create_invoice_from_blend_ticket',
    v_result
  );

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._save_field_app_invoice_impl_20260714(p_invoice_id uuid, p_invoice jsonb, p_locations jsonb, p_chemicals jsonb, p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor               uuid := auth.uid();
  v_existing            jsonb;
  v_existing_group_id   uuid;
  v_existing_status     text;
  v_locked_count        int;
  v_field_ids           uuid[];
  v_applied_acres_map   jsonb := '{}'::jsonb;
  v_total_applied_acres numeric := 0;
  v_this_applied        numeric;
  v_loc                 jsonb;
  v_chem                jsonb;
  v_shares              jsonb;
  v_customers           jsonb;
  v_customer            jsonb;
  v_customer_id         uuid;
  v_customer_name       text;
  v_customer_tier       int;
  v_is_primary          boolean;
  v_has_override        boolean;
  v_invoice_id          uuid;
  v_invoice_number      text;
  v_invoice_group_id    uuid;
  v_invoice_ids         uuid[] := '{}';
  v_app_service         record;
  v_fee_rate            bigint;
  v_loc_id              uuid;
  v_share_row           jsonb;
  v_share_pct           numeric;
  v_share_acres         numeric;
  v_field_id            uuid;
  v_field_applied_acres numeric;
  v_field_override      bigint;
  v_field_pricing_note  text;
  v_unit_price          bigint;
  v_unit_cost           bigint;
  v_qi_price            numeric;
  v_quoted_price        bigint;
  v_price_source        text;
  v_extended            bigint;
  v_invoice_total       bigint;
  v_invoice_cost        bigint;
  v_total_share_acres   numeric;
  v_grower_share_amount bigint;
  v_fee_acres           numeric;
  v_fee_extended        bigint;
  v_fee_cost            bigint;
  v_result              jsonb;
  v_customer_count      int;
  v_orphan              record;
  v_req_salesman        uuid;
  v_salesman_id         uuid;
  v_skipped_customer_ids uuid[] := '{}';
  v_is_new_invoice      boolean;
  v_surcharge_acres     numeric;
  v_surcharge_cents     bigint;
  v_season              integer;
  v_invoice_season      integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save field application invoices';
  END IF;

  v_req_salesman := (p_invoice->>'salesman_id')::uuid;
  IF is_admin() THEN
    v_salesman_id := v_req_salesman;
  ELSE
    IF v_req_salesman IS NOT NULL AND v_req_salesman IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Not authorized: cannot attribute this invoice to another user (salesman_id)';
    END IF;
    v_salesman_id := v_actor;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'save_field_app_invoice';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT status, invoice_group_id INTO v_existing_status, v_existing_group_id
      FROM invoices WHERE id = p_invoice_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
    -- KI-156 follow-up: only field-application invoices are rebuilt here (the invoice and every live member of its
    -- group, whose lines are deleted below); any other draft keeps its own lines.
    IF EXISTS (SELECT 1 FROM invoices
                WHERE (id = p_invoice_id
                       OR (v_existing_group_id IS NOT NULL AND invoice_group_id = v_existing_group_id AND deleted_at IS NULL))
                  AND invoice_type IS DISTINCT FROM 'field_application') THEN
      RAISE EXCEPTION 'FIELD_APP_INVOICE_REQUIRED: invoice % is not a field application invoice', p_invoice_id;
    END IF;
    SELECT COUNT(*) INTO v_locked_count
      FROM invoices
     WHERE (id = p_invoice_id OR invoice_group_id = v_existing_group_id)
       AND v_existing_group_id IS NOT NULL
       AND deleted_at IS NULL
       AND status NOT IN ('draft', 'unposted');
    IF v_locked_count > 0 OR v_existing_status NOT IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Cannot edit field app invoice — % invoice(s) in this group are posted/voided. Use void/reissue.', GREATEST(v_locked_count, 1);
    END IF;

    IF v_existing_group_id IS NOT NULL THEN
      DELETE FROM field_app_location_shares WHERE location_id IN (
        SELECT id FROM field_app_locations WHERE invoice_group_id = v_existing_group_id
      );
      DELETE FROM field_app_locations WHERE invoice_group_id = v_existing_group_id;
      DELETE FROM invoice_items   WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_group_id = v_existing_group_id AND deleted_at IS NULL);
      DELETE FROM invoice_shares  WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_group_id = v_existing_group_id AND deleted_at IS NULL);
    ELSE
      DELETE FROM field_app_location_shares WHERE location_id IN (
        SELECT id FROM field_app_locations WHERE invoice_id = p_invoice_id
      );
      DELETE FROM field_app_locations WHERE invoice_id = p_invoice_id;
      DELETE FROM invoice_items  WHERE invoice_id = p_invoice_id;
      DELETE FROM invoice_shares WHERE invoice_id = p_invoice_id;
    END IF;
  END IF;

  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    v_this_applied := (v_loc->>'applied_acres')::numeric;
    IF v_this_applied IS NULL OR v_this_applied <= 0 THEN
      RAISE EXCEPTION 'ZERO_APPLIED_ACRES: applied acres must be greater than 0 for field % (enter applied acres, or remove the field)', v_loc->>'field_id';
    END IF;
    v_field_ids := array_append(v_field_ids, (v_loc->>'field_id')::uuid);
    v_total_applied_acres := v_total_applied_acres + v_this_applied;
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(v_loc->>'field_id', v_this_applied);
  END LOOP;

  IF v_field_ids IS NULL OR array_length(v_field_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one field is required';
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  v_customer_count := jsonb_array_length(v_customers);

  IF v_customer_count = 0 THEN
    RAISE EXCEPTION 'No billing customers derived from selected fields';
  END IF;

  IF v_existing_group_id IS NOT NULL THEN
    FOR v_orphan IN
      SELECT id, invoice_number, customer_id
        FROM invoices
       WHERE invoice_group_id = v_existing_group_id
         AND deleted_at IS NULL
         AND customer_id NOT IN (
           SELECT (c->>'customer_id')::uuid FROM jsonb_array_elements(v_customers) c
         )
    LOOP
      UPDATE invoices SET
        status              = 'cancelled',
        invoice_group_id    = NULL,
        total_amount_cents  = 0,
        total_cost_cents    = 0,
        updated_at          = now()
      WHERE id = v_orphan.id;

      INSERT INTO activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'invoice_orphan_cancelled',
        'Field app invoice ' || v_orphan.invoice_number ||
          ' cancelled — customer removed from group during edit',
        p_performed_by, 'invoice', v_orphan.id, v_orphan.customer_id
      );
    END LOOP;
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
  END IF;

  IF v_customer_count > 1 THEN
    v_invoice_group_id := COALESCE(v_existing_group_id, gen_random_uuid());
  ELSE
    v_invoice_group_id := NULL;
  END IF;

  -- Season stamped on a NEW invoice, derived from the same date that invoice is stamped with
  -- (2026-09-04). This previously read the current-season helper, which is compute_season of
  -- the UTC current-date built-in -- an INDEPENDENT clock read of the UTC calendar day. From
  -- 7 pm America/Chicago on 2026-09-30 that helper returns 2027 while invoice_date is stamped
  -- 2026-09-30 (season 2026), and season drives customer_application_rates lookups and
  -- year-end statements. Deriving it from the invoice date also files a backdated invoice under
  -- THAT season, which is the rule _save_field_app_split_invoice_impl already follows
  -- (Codex round-3 P1). p_invoice is loop-invariant, so this is computed once.
  v_season := compute_season(COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date));

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id   := (v_customer->>'customer_id')::uuid;
    v_customer_name := v_customer->>'customer_name';
    v_customer_tier := COALESCE((v_customer->>'tier')::int, 1);
    v_is_primary    := COALESCE((v_customer->>'is_primary')::boolean, false);
    v_has_override  := COALESCE((v_customer->>'has_override')::boolean, false);

    v_invoice_total := 0;
    v_invoice_cost  := 0;

    v_invoice_id := NULL;
    IF v_existing_group_id IS NOT NULL THEN
      SELECT id INTO v_invoice_id FROM invoices
       WHERE invoice_group_id = v_existing_group_id AND customer_id = v_customer_id AND deleted_at IS NULL LIMIT 1;
    ELSIF p_invoice_id IS NOT NULL AND v_customer_count = 1 THEN
      v_invoice_id := p_invoice_id;
    END IF;

    IF v_invoice_id IS NULL AND v_existing_group_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoices
       WHERE invoice_group_id = v_existing_group_id
         AND customer_id = v_customer_id
         AND deleted_at IS NOT NULL
    ) THEN
      v_skipped_customer_ids := array_append(v_skipped_customer_ids, v_customer_id);
      CONTINUE;
    END IF;

    v_is_new_invoice := (v_invoice_id IS NULL);

    IF v_invoice_id IS NULL THEN
      v_invoice_number := next_invoice_number();
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status,
        invoice_date, salesman_id, header_notes, created_by,
        total_amount_cents, total_cost_cents,
        invoice_group_id, application_service_id,
        season
      ) VALUES (
        v_invoice_number, v_customer_id, 'field_application', 'draft',
        COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date),  -- fallback is the America/Chicago business date, never UTC (2026-09-03)
        v_salesman_id,
        p_invoice->>'header_notes',
        p_performed_by,
        0, 0,
        v_invoice_group_id,
        p_application_service_id,
        v_season
      ) RETURNING id, season INTO v_invoice_id, v_invoice_season;
    ELSE
      UPDATE invoices SET
        invoice_date            = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
        salesman_id             = CASE WHEN is_admin() THEN COALESCE(v_salesman_id, salesman_id) ELSE salesman_id END,
        header_notes            = COALESCE(p_invoice->>'header_notes', header_notes),
        application_service_id  = p_application_service_id,
        invoice_group_id        = v_invoice_group_id,
        total_amount_cents      = 0,
        total_cost_cents        = 0,
        updated_at              = now()
      WHERE id = v_invoice_id
      -- Season is deliberately NOT rewritten on an edit: that would move an existing invoice to
      -- a different year-end statement, and the split-provenance triggers refuse it outright.
      -- Read back what the row carries so the rate lookup below prices at THAT season.
      RETURNING season INTO v_invoice_season;
    END IF;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value ->> 'customer_id')::uuid = v_customer_id
        AND (value ->> 'price_override_cents') IS NOT NULL
    LOOP
      v_field_id            := (v_share_row->>'field_id')::uuid;
      v_field_applied_acres := (v_share_row->>'field_applied_acres')::numeric;
      v_share_pct           := (v_share_row->>'split_pct')::numeric;
      v_share_acres         := (v_share_row->>'share_acres')::numeric;
      v_field_override      := (v_share_row->>'price_override_cents')::bigint;
      v_field_pricing_note  := v_share_row->>'pricing_note';

      v_grower_share_amount := safe_cents_qty(v_field_override, v_share_acres);

      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size,
        unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id,
        (v_share_row->>'field_name') || ' — grower share @ $' ||
          (v_field_override / 100.0)::numeric(12,2) || '/ac' ||
          CASE WHEN v_field_pricing_note IS NOT NULL AND v_field_pricing_note <> ''
               THEN ' (' || v_field_pricing_note || ')' ELSE '' END,
        v_share_acres, 'acre',
        v_field_override, v_grower_share_amount, 0,
        0, v_share_acres, v_field_override, 'acre',
        false, 'manual'
      );

      v_invoice_total := v_invoice_total + v_grower_share_amount;
    END LOOP;

    FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals)
    LOOP
      DECLARE
        v_chem_qty_a   numeric := 0;
        v_chem_qty_b   numeric := 0;
        v_rate         numeric;
        v_qa_unit_cost bigint;
        v_wh           text := NULLIF(v_chem->>'warehouse', '');
        v_vendor       text := NULLIF(v_chem->>'vendor', '');
        v_form         text;
        v_epa          text := NULLIF(v_chem->>'epa_registration', '');
        v_ta_unit      text := COALESCE(NULLIF(v_chem->>'rate_unit',''), NULLIF(v_chem->>'unit_size',''));
        v_conv         record;
        v_inv_unit     text;       -- PARKED-010: product's sold/pricing unit (inventory_unit)
        v_priced_qty   numeric;    -- PARKED-010: applied qty converted into the pricing unit
        v_qa_unit      text;       -- KI-156: unit the grower-share line's cost is per
        v_qa_qty       numeric;    -- KI-156: grower-share applied qty converted into v_qa_unit
        v_prev_op      text;       -- KI-156: below-cost context to restore after the grower-share line
        v_srv_cost     bigint;     -- KI-156: product current cost (cents per sold unit), read with its unit
      BEGIN
        v_rate := COALESCE((v_chem->>'rate_per_acre')::numeric, 0);

        IF (v_chem->>'product_id') IS NOT NULL THEN
          -- KI-156: read the sold unit and the current cost together, locked, so a grower-share line never pairs a
          -- quantity in one unit with a cost per another (the below-cost wall locks the same row at the insert).
          SELECT p.product_form::text, COALESCE(v_epa, p.epa_registration), COALESCE(v_vendor, p.vendor), p.inventory_unit,
                 round(p.current_cost * 100)::bigint
            INTO v_form, v_epa, v_vendor, v_inv_unit, v_srv_cost
            FROM products p WHERE p.id = (v_chem->>'product_id')::uuid
           FOR SHARE;
        END IF;

        FOR v_share_row IN
          SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
          WHERE (value ->> 'customer_id')::uuid = v_customer_id
        LOOP
          v_share_acres := (v_share_row->>'share_acres')::numeric;
          IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
            v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
          ELSE
            v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
          END IF;
        END LOOP;

        IF v_chem_qty_a > 0 THEN
          -- KI-156 (Mason, 2026-11-16): a grower-share chemical with a product is ALWAYS costed at the server cost,
          -- even for an admin: the product's current cost per its sold unit; a typed cost_cents is ignored. A
          -- hand-typed line with no product has no server cost: an admin's typed cost stands ("Yes, allow it"),
          -- anyone else's books 0.
          v_qa_unit_cost := CASE WHEN (v_chem->>'product_id') IS NOT NULL THEN COALESCE(v_srv_cost, 0)
                                 WHEN is_admin() THEN COALESCE((v_chem->>'cost_cents')::bigint, 0)
                                 ELSE 0 END;
          -- KI-156: cost_cents is per the product's SOLD unit (inventory_unit); on a line with no
          -- product it is per the unit the line is entered in (unit_size, which the screen keeps
          -- equal to the rate unit). Convert the applied amount (rate unit) into that unit before
          -- costing, as the billed branch below does, so 16 oz/ac x 100 ac of a $30/gal product
          -- costs 12.5 gal x $30 = $375, not 1,600 x $30. Round once to the stored precision and
          -- cost THAT quantity, so quantity x cost_cents on the saved line equals what is booked.
          -- A product line takes its unit from the server exactly as the billed branch does, never
          -- from the request.
          -- Its cost is per the sold unit, so a product with no sold unit cannot be costed: refuse rather than
          -- cost a rate-unit quantity at a sold-unit price (live 2026-11-16: 0 such products).
          IF (v_chem->>'product_id') IS NOT NULL AND NULLIF(btrim(v_inv_unit), '') IS NULL THEN
            RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: cannot cost "%" in the grower share — the product has no sold unit. Fix this product''s units before invoicing this field application.',
              COALESCE(NULLIF(v_chem->>'description', ''), (v_chem->>'product_id'));
          END IF;
          v_qa_unit := CASE WHEN (v_chem->>'product_id') IS NOT NULL
                            THEN v_inv_unit
                            ELSE COALESCE(NULLIF(v_chem->>'unit_size', ''), v_ta_unit) END;
          v_qa_qty  := field_app_priced_quantity(v_chem_qty_a, v_ta_unit, v_qa_unit, v_form);
          IF v_qa_qty IS NULL THEN
            RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: cannot price "%" — rate unit "%" does not convert to the product''s sold unit "%". Fix this product''s units before invoicing this field application.',
              COALESCE(NULLIF(v_chem->>'description', ''), (v_chem->>'product_id')), v_ta_unit, v_qa_unit;
          END IF;
          -- The line stores 4 decimals (invoice_items.quantity numeric(12,4)). Mason, 2026-11-17 ("Refuse if off
          -- >$0.50"): refuse a grower-share line whose booked cost would differ from the exact cost by more than
          -- 50 cents (a tiny amount of a costly product rounding to 0, #1926); smaller differences save as before.
          IF abs(safe_cents_qty(v_qa_unit_cost, ROUND(v_qa_qty, 4)) - v_qa_qty * v_qa_unit_cost) > 50 THEN
            RAISE EXCEPTION 'FIELD_APP_GROWER_SHARE_ROUNDING: cannot cost "%" in the grower share — % % is too small to record to 4 decimals without its cost changing by more than $0.50. Record this product in a smaller sold unit before invoicing this field application.',
              COALESCE(NULLIF(v_chem->>'description', ''), (v_chem->>'product_id')), trim_scale(v_qa_qty), v_qa_unit;
          END IF;
          v_qa_qty := ROUND(v_qa_qty, 4);
          SELECT * INTO v_conv FROM convert_to_gl_lb(ROUND(v_chem_qty_a, 4), v_ta_unit, v_form);
          -- KI-156 (Mason, 2026-11-15: "Admins and reps"): this $0 line is the chemical the grower's per-acre
          -- price already covers, not a sale below cost. Declare that to the below-cost wall for THIS insert
          -- only; the wall lets an active admin or sales rep save it and judges every other line as before.
          v_prev_op := current_setting('app.crx_below_cost_operation', true);
          PERFORM set_config('app.crx_below_cost_operation', 'field_app_grower_share', true);
          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            is_application_fee, price_source,
            warehouse, vendor, total_applied, total_applied_unit,
            total_applied_gl_lb, gl_lb_unit, epa_registration, product_form
          ) VALUES (
            v_invoice_id,
            (v_chem->>'product_id')::uuid,
            (v_chem->>'description') || ' — included in grower share',
            v_qa_qty,
            v_qa_unit,
            0, 0, v_qa_unit_cost,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            false,
            'manual',
            v_wh, v_vendor, ROUND(v_chem_qty_a, 4), v_ta_unit,
            v_conv.converted_value, v_conv.converted_unit, v_epa, v_form
          );
          PERFORM set_config('app.crx_below_cost_operation', COALESCE(v_prev_op, ''), true);
          v_invoice_cost := v_invoice_cost + safe_cents_qty(v_qa_unit_cost, v_qa_qty);
        END IF;

        IF v_chem_qty_b > 0 THEN
          v_unit_price   := NULL;
          v_quoted_price := NULL;
          v_price_source := NULL;

          IF v_chem ? 'manual_override' AND (v_chem->>'manual_override')::boolean = true
             AND (v_chem->>'unit_price_cents') IS NOT NULL THEN
            v_unit_price   := (v_chem->>'unit_price_cents')::bigint;
            v_price_source := 'manual';
          END IF;

          IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
            SELECT qi.price_per_unit INTO v_qi_price
              FROM quote_items qi
              JOIN quote_sections qs ON qs.id = qi.section_id
             WHERE qi.product_id = (v_chem->>'product_id')::uuid
               AND qs.field_id   = ANY(v_field_ids)
             ORDER BY qi.id LIMIT 1;
            IF v_qi_price IS NOT NULL THEN
              v_unit_price   := ROUND(v_qi_price * 100)::bigint;
              v_quoted_price := v_unit_price;
              v_price_source := 'quoted';
            END IF;
          END IF;

          IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
            SELECT CASE v_customer_tier
              WHEN 1 THEN COALESCE(ROUND(p.tier1_price * 100), 0)
              WHEN 2 THEN COALESCE(ROUND(p.tier2_price * 100), ROUND(p.tier1_price * 100), 0)
              WHEN 3 THEN COALESCE(ROUND(p.tier3_price * 100), ROUND(p.tier1_price * 100), 0)
              ELSE COALESCE(ROUND(p.tier1_price * 100), 0)
            END INTO v_unit_price
            FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
            v_price_source := 'tier';
          END IF;

          v_unit_price := COALESCE(v_unit_price, 0);
          v_unit_cost  := COALESCE((v_chem->>'cost_cents')::bigint, 0);

          -- PARKED-010 (field-app billing unit fix): the applied amount (v_chem_qty_b) is in the
          -- RATE unit (e.g. oz), but v_unit_price is per the product's SOLD unit (inventory_unit,
          -- e.g. $/gal). Convert the applied amount into the pricing unit BEFORE multiplying, so a
          -- 16 oz/ac product at $32.10/gal bills $/gal x gallons (not $/gal x ounces = ~128x high).
          -- Manual line (no product_id): no inventory_unit, so price in the rate unit as entered
          -- (identity). If the units genuinely do not convert (e.g. an oz rate on a product sold
          -- "per unit"), refuse rather than silently mis-bill.
          v_priced_qty := field_app_priced_quantity(v_chem_qty_b, v_ta_unit, COALESCE(v_inv_unit, v_ta_unit), v_form);
          IF v_priced_qty IS NULL THEN
            RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: cannot price "%" — rate unit "%" does not convert to the product''s sold unit "%". Fix this product''s units before invoicing this field application.',
              COALESCE(NULLIF(v_chem->>'description', ''), (v_chem->>'product_id')), v_ta_unit, COALESCE(v_inv_unit, v_ta_unit);
          END IF;
          -- Round once to the stored precision so quantity x unit_price == extended_cents
          -- (the invoice line stays internally consistent on any later re-compute).
          v_priced_qty := ROUND(v_priced_qty, 4);
          v_extended   := safe_cents_qty(v_unit_price, v_priced_qty);

          SELECT * INTO v_conv FROM convert_to_gl_lb(ROUND(v_chem_qty_b, 4), v_ta_unit, v_form);

          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            quoted_price_cents, is_application_fee, price_source,
            warehouse, vendor, total_applied, total_applied_unit,
            total_applied_gl_lb, gl_lb_unit, epa_registration, product_form
          ) VALUES (
            v_invoice_id,
            (v_chem->>'product_id')::uuid,
            v_chem->>'description',
            ROUND(v_priced_qty, 4),
            COALESCE(v_inv_unit, v_chem->>'unit_size'),
            v_unit_price, v_extended, v_unit_cost,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            v_quoted_price, false, v_price_source,
            v_wh, v_vendor, ROUND(v_chem_qty_b, 4), v_ta_unit,
            v_conv.converted_value, v_conv.converted_unit, v_epa, v_form
          );

          v_invoice_total := v_invoice_total + v_extended;
          -- PARKED-010: cost (v_unit_cost is also per the SOLD unit) must use the converted
          -- quantity too, otherwise margin = revenue(gallons) - cost(ounces) is wildly wrong.
          v_invoice_cost  := v_invoice_cost + safe_cents_qty(v_unit_cost, v_priced_qty);
        END IF;
      END;
    END LOOP;

    IF p_application_service_id IS NOT NULL THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id            = v_customer_id
         AND car.application_service_id = p_application_service_id
         -- Price the application fee at the season THIS INVOICE IS FILED UNDER, whether it was
         -- just inserted (v_season, from the invoice date) or already existed (its stored
         -- season). Reading the clock here instead let a row be filed in one season and priced
         -- in another (rls-security-reviewer M3 / migration-drift-reviewer H1, 2026-09-04).
         AND car.season                 = v_invoice_season
       LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;

      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
        INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;

      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := safe_cents_qty(v_fee_rate, v_fee_acres);
        v_fee_cost     := safe_cents_qty(v_app_service.cost_per_acre_cents, v_fee_acres);
        INSERT INTO invoice_items (
          invoice_id, description, quantity, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_app_service.name, v_fee_acres,
          v_fee_rate, v_fee_extended, v_fee_cost,
          9999, v_fee_acres, v_fee_rate, 'acre',
          true, 'tier'
        );
        v_invoice_total := v_invoice_total + v_fee_extended;
        v_invoice_cost  := v_invoice_cost + v_fee_cost;
      END IF;
    END IF;

    -- #32: FUEL SURCHARGE LINE (owner-configured; OFF + blank by default = NOTHING here).
    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
      INTO v_surcharge_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id
       AND (value->>'price_override_cents') IS NULL;

    v_surcharge_cents := compute_fuel_surcharge_cents(v_surcharge_acres, v_invoice_total);

    IF v_surcharge_cents > 0 THEN
      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_price_cents, extended_cents,
        cost_cents, sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id, 'Fuel Surcharge', 1,
        v_surcharge_cents, v_surcharge_cents, 0,
        9998, NULL, NULL, NULL,
        true, 'manual'
      );
      v_invoice_total := v_invoice_total + v_surcharge_cents;
    END IF;
    -- #32 END

    UPDATE invoices SET
      total_amount_cents = v_invoice_total,
      total_cost_cents   = v_invoice_cost,
      updated_at         = now()
    WHERE id = v_invoice_id;

    IF v_is_new_invoice THEN
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object(
          'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_invoice_id),
          'customer_id', v_customer_id,
          'total_cents', v_invoice_total
        ),
        v_invoice_total,
        'Field application invoice created'
      );
    END IF;

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
      INTO v_total_share_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id;

    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order,
      price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_total_share_acres, v_invoice_total,
      v_is_primary, 0,
      CASE WHEN v_has_override
        THEN (SELECT (value->>'price_override_cents')::bigint
              FROM jsonb_array_elements(v_shares -> 'rows') AS value
              WHERE (value->>'customer_id')::uuid = v_customer_id
                AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
        ELSE NULL
      END,
      CASE WHEN v_has_override
        THEN (SELECT (value->>'pricing_note')
              FROM jsonb_array_elements(v_shares -> 'rows') AS value
              WHERE (value->>'customer_id')::uuid = v_customer_id
                AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
        ELSE NULL
      END
    );
  END LOOP;

  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    INSERT INTO field_app_locations (
      invoice_id, invoice_group_id,
      field_id, map_number, total_acres, planted_acres,
      applied_acres, crop_type, wind_direction, sort_order
    ) VALUES (
      CASE WHEN v_invoice_group_id IS NULL THEN v_invoice_ids[1] ELSE NULL END,
      v_invoice_group_id,
      (v_loc->>'field_id')::uuid,
      (v_loc->>'map_number')::int,
      (v_loc->>'total_acres')::numeric,
      (v_loc->>'planted_acres')::numeric,
      (v_loc->>'applied_acres')::numeric,
      v_loc->>'crop_type',
      v_loc->>'wind_direction',
      COALESCE((v_loc->>'sort_order')::int, 0)
    ) RETURNING id INTO v_loc_id;

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value->>'field_id')::uuid = (v_loc->>'field_id')::uuid
        AND NOT ((value->>'customer_id')::uuid = ANY(v_skipped_customer_ids))
    LOOP
      INSERT INTO field_app_location_shares (
        location_id, customer_id, split_pct, acres, amount_cents
      ) VALUES (
        v_loc_id,
        (v_share_row->>'customer_id')::uuid,
        (v_share_row->>'split_pct')::numeric,
        (v_share_row->>'share_acres')::numeric,
        0
      );
    END LOOP;
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN p_invoice_id IS NULL THEN 'field_app_invoice_created' ELSE 'field_app_invoice_updated' END,
    'Field app invoice ' ||
      CASE WHEN v_invoice_group_id IS NOT NULL
           THEN '(group of ' || v_customer_count || ') '
           ELSE '' END ||
      'saved with ' || array_length(v_invoice_ids, 1) || ' invoice(s)',
    p_performed_by, 'invoice', v_invoice_ids[1]
  );

  v_result := jsonb_build_object(
    'invoice_ids',      to_jsonb(v_invoice_ids),
    'invoice_group_id', v_invoice_group_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_field_app_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._save_field_app_split_invoice_impl(p_billing_set_id uuid, p_source_job_id uuid, p_invoice jsonb, p_fields jsonb, p_lines jsonb, p_performed_by uuid, p_application_service_id uuid, p_idempotency_key text, p_request_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor              uuid := auth.uid();
  v_req_salesman       uuid;
  v_salesman_id        uuid;
  v_field_ids          uuid[] := '{}';
  v_applied_acres_map  jsonb  := '{}'::jsonb;
  v_fld                jsonb;
  v_this_acres         numeric;
  v_vector             jsonb;          -- default vector [{customer_id, micro_pct}]
  v_micro_map          jsonb := '{}'::jsonb;
  v_members            text[];         -- billing-set member customer_ids, sorted ASC
  v_set_id             uuid;
  v_group_id           uuid;
  v_line               jsonb;
  v_idx                int := 0;
  v_line_id            uuid;
  v_line_kind          text;
  v_product_id         uuid;
  v_app_service_id     uuid;
  v_line_desc          text;
  v_src_qty            numeric;
  v_src_acres          numeric;
  v_src_unit_price     bigint;
  v_src_flat           bigint;
  v_base_source        text;
  v_eff_rate_unit      text;           -- display unit for the line (pricing unit after chemical conversion)
  v_chem_price_map     jsonb;          -- chemical Option B: customer_id -> that customer's own resolved unit price
  v_svc_price_map      jsonb;          -- service Option B: customer_id -> that customer's own per-acre service rate
  v_uniform_price      bigint;         -- chemical/service: the single price when ALL co-owners match (routes round-once)
  v_repr_base_price    bigint;         -- resolved representative base BEFORE the uniform-override penny guard (Codex r7 P2 audit base)
  v_inv_field_names    text[];         -- denormalized field names for the child invoice row (Codex r7 P2)
  v_inv_crop_type      text;           -- denormalized representative crop for the child invoice row (Codex r7 P2)
  v_inv_applicator_name text;          -- source-job applicator, denormalized onto the child (Codex r8 P2)
  v_inv_vehicle_name   text;           -- source-job vehicle, denormalized onto the child (Codex r8 P2)
  v_line_unit_cost     bigint;         -- per-unit COGS for the current line (Codex P1 #3)
  v_invoice_cost       bigint;         -- per-child accumulated total_cost_cents (Codex P1 #3)
  v_is_new_invoice     boolean;        -- true only when a child invoice row is freshly INSERTed (Codex P1 #8)
  v_total_applied_acres numeric := 0;  -- SUM(applied_acres) across p_fields (Codex P2 #9 acre derivation)
  v_shares             jsonb;
  v_line_customers     text[];
  v_calc               jsonb;
  v_app_service        record;
  v_svc_name           text;   -- safe copy of v_app_service.name (fix: unassigned-record crash)
  v_line_plans         jsonb := '[]'::jsonb;   -- [{meta..., alloc}]
  v_plan               jsonb;
  v_cust               text;
  v_customer_id        uuid;
  v_customer_name      text;
  v_is_primary         boolean;
  v_invoice_id         uuid;
  v_invoice_number     text;
  v_invoice_total      bigint;
  v_invoice_ids        uuid[] := '{}';
  v_alloc_row          jsonb;
  v_item_id            uuid;
  v_qty                numeric;
  v_acres_alloc        numeric;
  v_cust_acres         numeric;
  v_send_disposition   text;
  v_line_hashes        jsonb := '[]'::jsonb;
  v_item_price_source  text;
  v_item_cost_cents    bigint;   -- per-item cost_cents (per-unit for chemical, EXTENDED for fee) — Codex r2 #F
  -- #E source-job double-bill guard (Codex round-2 P1) + round-3 season/freeze
  v_job                record;
  v_other_set          uuid;
  v_set_child_ids      uuid[];    -- this set's child invoice ids captured BEFORE orphan-cancel (round-5 B1)
  v_set_source_job     uuid;     -- the set's frozen source_job_id on re-save (round-3 P1)
  v_season             integer;  -- job/invoice season for pricing + stamping (round-3 P1)
  v_job_app_date       date;     -- source job's application/scheduled date for child invoices (round-3 P2)
  -- Commissions on the split (Codex round-4 P1): mirror transfer_job_to_invoice per child
  v_commission_split   jsonb;
  v_child_id           uuid;
  v_child_customer     uuid;
  v_child_profit       numeric;
  -- Codex round-5 P1: per-child CHEMICAL profit using the LR-allocated COGS (not a re-rounded
  -- cost*qty), so commissions tie to the penny-exact allocation already in the header.
  v_invoice_chem_profit  bigint;
  v_chem_profit_by_child jsonb := '{}'::jsonb;   -- child invoice_id::text -> chemical profit cents
  -- #G canonical line COGS + its largest-remainder split (Codex round-2 P1)
  v_line_cogs          bigint;
  v_cogs_weights       jsonb;
  v_cogs_map           jsonb;
  -- #M audited-base + #L reason capture (Codex round-2 P2)
  v_caller_override    text[];   -- customers the caller priced as a genuine manual override
  v_svc_source_map     jsonb;    -- service: customer_id -> 'service_rate' | 'service_default'
  v_reasons_map        jsonb;    -- customer_id -> {split_reason, price_reason}
  v_share_base_price   bigint;
  v_share_base_source  text;
  v_share_price_mode   text;
  v_split_reason       text;
  v_price_reason       text;
  -- invariant probes
  v_sum_cents          bigint;
  v_src_line_cents     bigint;
  v_sum_qty            numeric;
  v_sum_micro          bigint;
  v_line_member_count  int;
  v_line_src_qty       numeric;
  v_result             jsonb;
BEGIN
  -- ---- GUARDS (defense-in-depth; the wrapper already checked these) -----------
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
                   AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: active admin or sales role required';
  END IF;

  -- Codex round-4 P1 (posting-boundary integrity): mark THIS transaction as the legitimate
  -- split writer. The trg_guard_split_invoice_items trigger (below) blocks any other path —
  -- notably the generic save_invoice, whose FIELD_INVOICE_SPLIT_LOCKED guard does NOT fire for
  -- our single-compat-share children — from deleting a split child's invoice_items and
  -- cascading away its invoice_line_shares. is_local = true: auto-resets at txn end.
  PERFORM set_config('crx.split_writer', 'on', true);

  -- Salesman attribution: admin may name anyone; a sales_rep is forced to self.
  v_req_salesman := (p_invoice->>'salesman_id')::uuid;
  IF is_admin() THEN
    v_salesman_id := v_req_salesman;
  ELSE
    IF v_req_salesman IS NOT NULL AND v_req_salesman IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Not authorized: cannot attribute this invoice to another user';
    END IF;
    v_salesman_id := v_actor;
  END IF;

  -- ---- FIELDS + Mode-A rejection ---------------------------------------------
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'array'
     OR jsonb_array_length(p_fields) = 0 THEN
    RAISE EXCEPTION 'SPLIT_NO_FIELDS: at least one field is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_fld IN SELECT * FROM jsonb_array_elements(p_fields)
  LOOP
    v_this_acres := (v_fld->>'applied_acres')::numeric;
    IF v_this_acres IS NULL OR v_this_acres <= 0 THEN
      RAISE EXCEPTION 'SPLIT_ZERO_ACRES: applied acres must be > 0 for field %', v_fld->>'field_id'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_field_ids := array_append(v_field_ids, (v_fld->>'field_id')::uuid);
    v_applied_acres_map := v_applied_acres_map
      || jsonb_build_object(v_fld->>'field_id', v_this_acres);
  END LOOP;

  -- Codex round-4 P1: reject a field id appearing more than once. A duplicate would
  -- double-count its acres into the ownership vector / compat share AND write a duplicate
  -- field_app_locations snapshot for the group. (v_applied_acres_map would silently collapse
  -- dupes to one key, so the acres map and the raw field array could disagree.)
  IF (SELECT count(*) FROM unnest(v_field_ids)) <>
     (SELECT count(DISTINCT x) FROM unnest(v_field_ids) AS x) THEN
    RAISE EXCEPTION 'SPLIT_DUPLICATE_FIELD: a field id appears more than once in p_fields'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Mode-A: reject the ENTIRE feature for any grower-share field (spec §5).
  IF EXISTS (
    SELECT 1 FROM field_billing_defaults d
     WHERE d.field_id = ANY(v_field_ids)
       AND d.price_override_cents IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'MODE_A_UNSUPPORTED: per-line split billing is not available for grower-share (Mode A) fields'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ---- DEFAULT VECTOR + member set -------------------------------------------
  v_vector := resolve_line_split_vector(v_field_ids, p_source_job_id, v_applied_acres_map);

  SELECT array_agg(value->>'customer_id' ORDER BY value->>'customer_id')
    INTO v_members
    FROM jsonb_array_elements(v_vector) AS value;

  SELECT COALESCE(jsonb_object_agg(value->>'customer_id', (value->>'micro_pct')::bigint), '{}'::jsonb)
    INTO v_micro_map
    FROM jsonb_array_elements(v_vector) AS value;

  -- ---- CUSTOMER-SCOPE SECURITY (Codex P1 #4, 2026-07-18; widened 2026-10-13) ----
  -- Reps bill ANY customer (Mason, 2026-10-13): 20261013220000 removed the
  -- assigned-rep test. A non-admin is still refused a derived member that is not
  -- a customer row at all.
  IF NOT is_admin() THEN
    IF EXISTS (
      SELECT 1 FROM unnest(v_members) AS m(cust)
      LEFT JOIN customers c ON c.id = m.cust::uuid
      WHERE c.id IS NULL
    ) THEN
      RAISE EXCEPTION 'SPLIT_CUSTOMER_NOT_ASSIGNED: not authorized to bill one or more of these customers'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Total applied acres across the fields — the acre basis for the per-customer compat
  -- share row (Codex P2 #9), derived ONCE here, independent of the billing lines.
  SELECT COALESCE(SUM((f->>'applied_acres')::numeric), 0) INTO v_total_applied_acres
    FROM jsonb_array_elements(p_fields) AS f;

  -- Codex round-7 P2: denormalized field context for the child invoice ROW. FieldInvoicesListPanel +
  -- buildInvoicePdfDataFromRow read invoices.field_names/crop_type/total_acres directly (the dedicated
  -- Drafts/Posted panels hydrate field_app_locations, but the COMBINED list + its PDFs use the row) —
  -- without these each split child shows blank acreage/fields/crop in the combined list and exports.
  SELECT array_agg(fl.field_name ORDER BY t.ord),
         (array_agg(fl.crop_type ORDER BY t.ord) FILTER (WHERE fl.crop_type IS NOT NULL))[1]
    INTO v_inv_field_names, v_inv_crop_type
    FROM jsonb_array_elements(p_fields) WITH ORDINALITY AS t(fld, ord)
    LEFT JOIN fields fl ON fl.id = (t.fld->>'field_id')::uuid;

  -- ---- LINES ------------------------------------------------------------------
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'SPLIT_NO_LINES: at least one billing line is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Codex round-7 P1 (RUP under-reporting): reject the SAME chemical product on more than one line.
  -- Two chemical lines with the same product create two invoice_items with the same
  -- (invoice_id, product_id); generate_rup_sales_records de-dups by (invoice_id, product_id) and
  -- inserts only the FIRST, silently under-reporting the regulated quantity + amount of the second.
  -- The operator must combine them into one line (mirrors the SPLIT_DUPLICATE_FIELD guard).
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_lines) AS l
     WHERE l->>'line_kind' = 'chemical' AND NULLIF(l->>'product_id', '') IS NOT NULL
     GROUP BY l->>'product_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'SPLIT_DUPLICATE_PRODUCT: the same chemical product appears on more than one line — combine them into a single line'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
    v_svc_name := v_app_service.name;
  END IF;

  -- ---- RE-SAVE: reuse an existing DRAFT/UNPOSTED billing set -----------------
  -- The wrapper already advisory-locked the set's group and FOR UPDATE-locked the
  -- child invoices, and asserted all draft/unposted. Here we clear the prior child
  -- LINE DATA (invoice_items — cascades invoice_line_shares — plus compat shares and
  -- the billing lines) but we do NOT hard-delete the invoice ROWS: a child that was
  -- posted-then-unposted carries append-only invoice_line_share_snapshots whose FK is
  -- ON DELETE RESTRICT, so a hard invoice delete would abort the whole re-save
  -- (adversarial F1). Instead PASS 2 REUSES the existing child invoice per customer
  -- (UPDATE), preserving its invoice_number + snapshot history, and only INSERTs for a
  -- newly-added customer. The freeze trigger permits the share rewrite because every
  -- member is draft/unposted (not posted).
  IF p_billing_set_id IS NOT NULL THEN
    SELECT id, invoice_group_id, source_job_id INTO v_set_id, v_group_id, v_set_source_job
      FROM field_app_billing_sets WHERE id = p_billing_set_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Billing set not found: %', p_billing_set_id;
    END IF;

    -- Freeze the source job on re-save (Codex round-3 P1): the set's source_job_id is set
    -- once at first Save and drives the #E consume/guard below. Allowing it to change would
    -- let one billing set consume TWO jobs (the new one gets marked invoiced while the old
    -- stays invoiced and linked). Reject any change; the operator must start a new set.
    IF p_source_job_id IS DISTINCT FROM v_set_source_job THEN
      RAISE EXCEPTION 'SPLIT_JOB_IMMUTABLE: the source job cannot be changed on a saved split set (was %, got %)',
        v_set_source_job, p_source_job_id USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Ownership on re-save (Codex P1 #4; narrowed 2026-10-13 by 20261013220000): reps may
    -- re-save a split set for ANY customer (Mason, 2026-10-13), but only when every EXISTING
    -- child is under their own name: they are its salesperson, or it has none and they created
    -- it (before any delete/insert).
    IF NOT is_admin() AND EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.field_app_billing_set_id = v_set_id AND i.deleted_at IS NULL
        AND NOT (i.salesman_id IS NOT DISTINCT FROM v_actor
             OR (i.salesman_id IS NULL AND i.created_by IS NOT DISTINCT FROM v_actor))
    ) THEN
      RAISE EXCEPTION 'SPLIT_SET_NOT_OWNED: not authorized to modify this billing set'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Only EDITABLE children are cleared for the rebuild. A voided/cancelled child keeps its
    -- invoice_items/invoice_shares as the printed audit record of what was billed then reversed
    -- (RLS review M1) — its billing-line links are NULLed below so the line DELETE stays FK-safe.
    -- Posted/paid children can't reach here (the wrapper's already-posted block rejects the set).
    DELETE FROM invoice_items
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL
                              AND status IN ('draft', 'unposted'));
    DELETE FROM invoice_shares
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL
                              AND status IN ('draft', 'unposted'));
    -- Fable-adversarial BLOCKER: a SOFT-deleted child (via the live delete_invoices) is NOT in the
    -- delete above (deleted_at IS NOT NULL), but its invoice_items still reference this set's
    -- field_app_billing_lines (invoice_items.billing_line_id FK, NO ACTION) — so the DELETE below
    -- would 23503-abort and BRICK every future re-save. NULL those dangling refs first (the soft-
    -- deleted invoice keeps its items as history; only the now-meaningless billing-line link is
    -- cleared). PASS 2 then re-creates a child for that customer if they are still a member.
    UPDATE invoice_items SET billing_line_id = NULL
      WHERE billing_line_id IN (SELECT id FROM field_app_billing_lines WHERE billing_set_id = v_set_id);
    DELETE FROM field_app_billing_lines WHERE billing_set_id = v_set_id;
    -- Clear the prior group's field snapshots; PASS 3 re-creates them from p_fields (Codex P1 #7).
    DELETE FROM field_app_locations WHERE invoice_group_id = v_group_id;

    -- Round-5 B1: snapshot this set's current child ids BEFORE the orphan-cancel below detaches any
    -- dropped member (it nulls field_app_billing_set_id). The #E already-invoiced guard uses this so a
    -- re-save that drops the member currently stored in jobs.invoice_id still recognizes that anchor as
    -- OURS — otherwise the just-detached anchor looks like a foreign invoice and trips a false
    -- SPLIT_JOB_ALREADY_INVOICED, blocking the drop-member re-save entirely.
    SELECT array_agg(id) INTO v_set_child_ids
      FROM invoices WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL;

    -- Any existing EDITABLE child whose customer is no longer a billing-set member is
    -- soft-cancelled + detached from the set (its snapshots stay pointing at it,
    -- audit intact) — never hard-deleted. Mirrors the live orphan-cancel path.
    -- Fable-adversarial: only draft/unposted children — a child already voided/cancelled via the
    -- live void_invoice must be skipped, since draft->cancelled is fine but voided->cancelled is a
    -- forbidden status transition that would abort the whole re-save.
    UPDATE invoices
       SET status = 'cancelled', invoice_group_id = NULL, field_app_billing_set_id = NULL,
           total_amount_cents = 0, total_cost_cents = 0, send_disposition = 'normal',
           updated_at = now()
     WHERE field_app_billing_set_id = v_set_id
       AND deleted_at IS NULL
       AND status IN ('draft', 'unposted')
       AND customer_id::text <> ALL (v_members);

    -- Codex round-6 P1: a child VOIDED/CANCELLED (or soft-deleted) via the live void/cancel/delete
    -- path stays attached to this set's invoice_group_id. PASS 2 skips it (reuse is draft/unposted +
    -- not-deleted only) and mints a fresh replacement, BUT post_invoice_group loops EVERY non-filtered
    -- member of the group and RAISES on any status not in (draft,unposted) — so leaving the terminal/
    -- deleted child in the group makes the rebuilt group permanently UNPOSTABLE. Detach such children
    -- from the group (invoice_group_id = NULL) so only active draft/unposted children remain postable;
    -- they keep field_app_billing_set_id as set/audit history and the replacement carries the group.
    UPDATE invoices
       SET invoice_group_id = NULL, updated_at = now()
     WHERE field_app_billing_set_id = v_set_id
       AND invoice_group_id IS NOT NULL
       AND (deleted_at IS NOT NULL OR status IN ('voided', 'cancelled'));
  ELSE
    -- New set. R7: ALWAYS assign an invoice_group_id (even single recipient) so
    -- posting is uniformly post_invoice_group and the set is the durable anchor.
    v_group_id := gen_random_uuid();
    INSERT INTO field_app_billing_sets (invoice_group_id, source_job_id, created_by)
    VALUES (v_group_id, p_source_job_id, p_performed_by)
    RETURNING id INTO v_set_id;
  END IF;

  -- ---- #E SOURCE-JOB DOUBLE-BILL GUARD (Codex round-2 P1, 2026-07-18) ---------
  -- source_job_id was recorded as provenance only, so the SAME job could be billed
  -- here AND again through the normal transfer_job_to_invoice flow (double-bill).
  -- Lock the job, refuse it if it was already billed elsewhere, and (after the child
  -- invoices exist) consume it exactly like transfer_job_to_invoice does — flipping
  -- jobs.status to 'invoiced' so that path's own "Job already invoiced" guard fires.
  -- All checks are re-save-safe: this set's own already-consumed job passes.
  IF p_source_job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM jobs WHERE id = p_source_job_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_FOUND: source job % not found', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Reps bill ANY customer's job (Mason, 2026-10-13; 20261013220000 removed the
    -- assigned-rep test). A job with a NULL or missing customer is still REFUSED for a
    -- non-admin (NOT EXISTS is true when customer_id is null).
    IF NOT is_admin()
       AND NOT EXISTS (SELECT 1 FROM customers c
                        WHERE c.id = v_job.customer_id) THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_ASSIGNED: not authorized to bill source job %', p_source_job_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Already tied to a DIFFERENT split billing set?
    SELECT id INTO v_other_set FROM field_app_billing_sets
      WHERE source_job_id = p_source_job_id AND id IS DISTINCT FROM v_set_id
      LIMIT 1;
    IF v_other_set IS NOT NULL THEN
      RAISE EXCEPTION 'SPLIT_JOB_ALREADY_BILLED: source job % is already on split billing set %',
        p_source_job_id, v_other_set USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Already invoiced by the normal flow (linked to an invoice that is NOT one of THIS set's children)?
    -- Round-5 B1: accept the anchor if it is STILL attached to this set OR was one of this set's
    -- children before the orphan-cancel above detached it (a drop-anchor re-save) — v_set_child_ids is
    -- the pre-cancel snapshot; NULL on a first save (COALESCE to empty, so the EXISTS still governs).
    IF v_job.status = 'invoiced' AND v_job.invoice_id IS NOT NULL
       AND NOT (v_job.invoice_id = ANY (COALESCE(v_set_child_ids, ARRAY[]::uuid[])))
       AND NOT EXISTS (SELECT 1 FROM invoices i
                        WHERE i.id = v_job.invoice_id AND i.field_app_billing_set_id = v_set_id) THEN
      RAISE EXCEPTION 'SPLIT_JOB_ALREADY_INVOICED: source job % was already invoiced (invoice %)',
        p_source_job_id, v_job.invoice_id USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Must be completed (or already this set's) to bill — mirrors transfer_job_to_invoice.
    IF v_job.status NOT IN ('completed', 'invoiced') THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_COMPLETED: source job % must be completed to bill (status: %)',
        p_source_job_id, v_job.status USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Codex round-4 P1 + round-5 P1: the billed fields must EXACTLY EQUAL the job's job_fields.
    -- Consuming the job marks the WHOLE job 'invoiced', so billing only a subset (or unrelated
    -- fields) would silently orphan the job's other fields — normal transfer then refuses the
    -- now-invoiced job, so that work can never be billed. Enforce set equality (⊆ AND ⊇), exactly
    -- like transfer_job_to_invoice which always bills every job_field. (a) no billed field outside
    -- the job:
    IF EXISTS (
      SELECT 1 FROM unnest(v_field_ids) AS fid
       WHERE NOT EXISTS (SELECT 1 FROM job_fields jf
                          WHERE jf.job_id = p_source_job_id AND jf.field_id = fid)
    ) THEN
      RAISE EXCEPTION 'SPLIT_FIELD_NOT_ON_JOB: one or more billed fields do not belong to source job %', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- (b) no job field left unbilled:
    IF EXISTS (
      SELECT 1 FROM job_fields jf
       WHERE jf.job_id = p_source_job_id
         AND NOT (jf.field_id = ANY (v_field_ids))
    ) THEN
      RAISE EXCEPTION 'SPLIT_JOB_FIELDS_INCOMPLETE: billing a source job must include ALL of its fields (the whole job is consumed as invoiced); job % has fields not in this split', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_job_app_date := v_job.job_date;          -- carried onto each child (round-3 P2); the LIVE
                                               -- jobs table has job_date (no scheduled_date), and
                                               -- live transfer_job_to_invoice uses job_date too.
    v_season       := v_job.season;            -- capture here (v_job is a bare record, only assigned
                                               -- inside this guard; referencing v_job.season outside
                                               -- it — even in a not-taken CASE branch — raises 55000).
    -- Codex round-8 P2: denormalize the job's applicator + vehicle onto each child (like
    -- transfer_job_to_invoice) — field-invoice lists and PDFs read these invoice columns, so without
    -- them a split child loses who applied it and with what equipment. Job-less splits stay NULL.
    IF v_job.applicator_id IS NOT NULL THEN
      SELECT full_name INTO v_inv_applicator_name FROM profiles WHERE id = v_job.applicator_id;
    END IF;
    IF v_job.vehicle_id IS NOT NULL THEN
      SELECT vehicle_name INTO v_inv_vehicle_name FROM vehicles WHERE id = v_job.vehicle_id;
    END IF;
  END IF;

  -- Season for per-customer service-rate lookups AND the child invoice stamp (Codex round-3 P1):
  -- the SOURCE JOB's season if billing a job (captured above), else the invoice DATE's season, else
  -- current. current_season() alone mis-priced a backdated/prior-season job and filed the wrong year.
  v_season := COALESCE(
    v_season,
    compute_season(COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date)),  -- America/Chicago business date, never UTC (2026-09-03)
    current_season());

  -- ---- PASS 1: build billing lines + compute allocations ----------------------
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_idx            := v_idx + 1;
    v_line_kind      := v_line->>'line_kind';
    v_product_id     := (v_line->>'product_id')::uuid;
    v_app_service_id := COALESCE((v_line->>'application_service_id')::uuid, p_application_service_id);
    v_line_desc      := v_line->>'description';
    v_src_qty        := (v_line->>'source_quantity')::numeric;
    v_src_acres      := (v_line->>'source_acres')::numeric;
    v_src_flat       := (v_line->>'source_flat_cents')::bigint;
    v_src_unit_price := (v_line->>'source_unit_price_cents')::bigint;
    v_base_source    := v_line->>'base_price_source';
    v_eff_rate_unit  := v_line->>'rate_unit';   -- default; chemical overrides to the pricing unit below
    v_chem_price_map := NULL;                    -- chemical-only; NULL keeps non-chemical lines untouched
    v_svc_price_map  := NULL;                    -- service-only; NULL keeps non-service lines untouched
    v_svc_source_map := NULL;                    -- service-only: customer_id -> resolved source (#M)
    v_line_unit_cost := 0;                       -- per-unit COGS for this line (Codex P1 #3)

    -- #M: customers the CALLER explicitly priced as a genuine manual per-person override
    -- (those stay audited as an 'override'; every other co-owner's resolved per-customer
    -- price is stored as their BASE, not an override vs the largest-share owner). #L: the
    -- operator's reason for a customized split / price, captured per co-owner.
    IF v_line ? 'shares' AND jsonb_typeof(v_line->'shares') = 'array' THEN
      -- Codex round-4 P1 (server defense-in-depth for the editor's per-share guard): a
      -- per-PERSON price override must be a POSITIVE amount. Below, a share flagged
      -- price_mode='override' with a non-null override_unit_price_cents is treated as a genuine
      -- caller override and billed at that price — so a 0 / negative value (e.g. the editor's
      -- "1e5" → 0 path, or a direct RPC call) would bill $0 and give product away. Reject it.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_line->'shares') AS s
         WHERE s->>'price_mode' = 'override'
           AND s->'override_unit_price_cents' IS NOT NULL
           AND jsonb_typeof(s->'override_unit_price_cents') <> 'null'
           AND (s->>'override_unit_price_cents')::bigint <= 0
      ) THEN
        RAISE EXCEPTION 'SPLIT_SHARE_OVERRIDE_INVALID: a per-person price override on line % must be a positive amount', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      SELECT array_agg(s->>'customer_id')
        INTO v_caller_override
        FROM jsonb_array_elements(v_line->'shares') AS s
       WHERE s->>'price_mode' = 'override'
         AND s->'override_unit_price_cents' IS NOT NULL
         AND jsonb_typeof(s->'override_unit_price_cents') <> 'null';
      SELECT jsonb_object_agg(s->>'customer_id', jsonb_build_object(
               'split_reason', NULLIF(btrim(COALESCE(s->>'split_override_reason', '')), ''),
               'price_reason', NULLIF(btrim(COALESCE(s->>'price_override_reason', '')), '')))
        INTO v_reasons_map
        FROM jsonb_array_elements(v_line->'shares') AS s;
    ELSE
      v_caller_override := NULL;
      v_reasons_map     := '{}'::jsonb;
    END IF;

    IF v_line_kind IS NULL
       OR v_line_kind NOT IN ('chemical', 'service', 'fuel_surcharge', 'flat_fee') THEN
      RAISE EXCEPTION 'SPLIT_BAD_LINE_KIND: %', COALESCE(v_line_kind, '<null>')
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Base-price resolution by kind (see SCOPE NOTE at top for the chemical caveat).
    IF v_line_kind = 'service' THEN
      -- Per-line service record (Codex P1 #1): the editor sends the service id on the LINE
      -- (line.application_service_id); the old code only loaded v_app_service from the always-null
      -- top-level p_application_service_id, so v_app_service was never assigned. Load it per line.
      IF v_app_service_id IS NULL THEN
        RAISE EXCEPTION 'SPLIT_SERVICE_NO_SERVICE: service line % requires an application service', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      SELECT * INTO v_app_service FROM application_services WHERE id = v_app_service_id;
      IF NOT FOUND OR NOT v_app_service.is_active THEN
        RAISE EXCEPTION 'Application service not found or inactive: %', v_app_service_id;
      END IF;
      v_svc_name := v_app_service.name;

      IF v_src_acres IS NULL THEN
        v_src_acres := v_total_applied_acres;
      END IF;
      -- Fable-adversarial HIGH: service source_acres is the billable basis and was the one billable
      -- input with no positivity guard (round-5 covered chemical qty, service RATE, flat cents, per-
      -- share override). A direct/modified RPC call with a negative or zero value would mint a NEGATIVE
      -- (credit) invoice that reduces AR and passes every §5 invariant (signed LR; total<>0 so not $0-
      -- suppressed). The editor only sends positive acres; enforce it server-side.
      IF v_src_acres <= 0 THEN
        RAISE EXCEPTION 'SPLIT_SERVICE_ACRES_NONPOSITIVE: service line % requires source_acres > 0', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;

      -- Service COGS: per-acre cost from the service record (mirrors the live field-app path,
      -- which uses application_services.cost_per_acre_cents). Codex P1 #3.
      v_line_unit_cost := COALESCE(v_app_service.cost_per_acre_cents, 0);

      IF COALESCE((v_line->>'manual_override')::boolean, false) THEN
        -- Explicit single negotiated per-acre rate for the whole line (applies to everyone).
        -- Codex round-5 P1: enforce a POSITIVE amount server-side (the editor rejects <=0, but a
        -- direct/modified RPC call could otherwise create a free or negative service line).
        IF v_src_unit_price IS NULL OR v_src_unit_price <= 0 THEN
          RAISE EXCEPTION 'SPLIT_SERVICE_RATE_NONPOSITIVE: a manual service rate must be a positive amount on line %', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_base_source := COALESCE(v_base_source, 'service_rate');
      ELSE
        -- Per-customer service rate (Codex P1 #2 — Option B for service): each co-owner at
        -- their OWN customer_application_rates(service, INVOICE/JOB season) → service default,
        -- exactly like the live per-child field-app save. v_season (round-3 P1) ensures a
        -- backdated/prior-season job uses that season's historical rate, not current_season().
        SELECT COALESCE(jsonb_object_agg(m.cust, COALESCE(
                 (SELECT car.rate_per_acre_cents FROM customer_application_rates car
                   WHERE car.customer_id            = m.cust::uuid
                     AND car.application_service_id = v_app_service_id
                     AND car.season                 = v_season
                   LIMIT 1),
                 v_app_service.default_rate_per_acre_cents, 0)), '{}'::jsonb)
          INTO v_svc_price_map
          FROM unnest(v_members) AS m(cust);
        -- #M: the precise per-customer source (a custom customer_application_rates row =>
        -- 'service_rate', otherwise the service default => 'service_default'), so each
        -- co-owner's audited base_price_source is their OWN resolved source. Same season (round-3).
        SELECT jsonb_object_agg(m.cust, CASE WHEN EXISTS (
                 SELECT 1 FROM customer_application_rates car
                  WHERE car.customer_id            = m.cust::uuid
                    AND car.application_service_id = v_app_service_id
                    AND car.season                 = v_season)
               THEN 'service_rate' ELSE 'service_default' END)
          INTO v_svc_source_map
          FROM unnest(v_members) AS m(cust);
        -- Representative (display + the calculator's default price): the largest-share owner's rate.
        v_src_unit_price := COALESCE((v_svc_price_map->>(
            SELECT (value->>'customer_id') FROM jsonb_array_elements(v_vector) AS value
             ORDER BY (value->>'micro_pct')::bigint DESC, value->>'customer_id' ASC LIMIT 1))::bigint, 0);
        v_base_source := COALESCE(v_base_source, 'service_default');
      END IF;
    ELSIF v_line_kind = 'chemical' THEN
      -- R8 (Option B — Mason 2026-07-18): resolve the price SERVER-SIDE and price EACH
      -- co-owner's share at THAT customer's OWN tier (manual override → field quote apply to
      -- everyone; only the tier fallback differs per customer — exactly like the live per-child
      -- field-app save). Also convert the applied quantity rate-unit → product sold unit.
      DECLARE
        v_chem_manual bigint  := NULL;
        v_rep_tier    integer;
        v_inv_unit    text;
        v_form        text;
        v_priced_qty  numeric;
        v_price_res   jsonb;
        v_rate_unit   text := NULLIF(btrim(coalesce(v_line->>'rate_unit', '')), '');
      BEGIN
        IF v_product_id IS NULL THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_NO_PRODUCT: chemical line % requires product_id', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF v_src_qty IS NULL OR v_src_qty <= 0 THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_NO_QUANTITY: chemical line % requires source_quantity > 0', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;

        -- Honor a caller price ONLY as an explicit manual override (a single negotiated price
        -- for the whole line — applies to every co-owner).
        IF COALESCE((v_line->>'manual_override')::boolean, false) THEN
          -- Codex round-5 P1: require a POSITIVE manual price server-side (the editor rejects
          -- <=0 / sci-notation, but a direct or modified-client RPC call could otherwise create a
          -- free or negative chemical line despite the UI invariant).
          IF v_src_unit_price IS NULL OR v_src_unit_price <= 0 THEN
            RAISE EXCEPTION 'SPLIT_CHEMICAL_OVERRIDE_PRICE_REQUIRED: manual_override set but source_unit_price_cents is missing or not positive on chemical line %', v_idx
              USING ERRCODE = 'invalid_parameter_value';
          END IF;
          v_chem_manual := v_src_unit_price;
        END IF;

        -- Product units for the rate -> pricing-unit conversion, plus the server-resolved
        -- unit COST (Codex P1 #3). current_cost is dollars per the product's inventory (sold)
        -- unit — the SAME unit as the priced quantity below — so per-unit cents = round(*100),
        -- exactly like _snapshot_order_item_cost and the parked save_invoice.
        SELECT p.inventory_unit, p.product_form,
               COALESCE(round(p.current_cost * 100)::bigint, 0)
          INTO v_inv_unit, v_form, v_line_unit_cost
          FROM products p WHERE p.id = v_product_id;

        -- Per-customer price map (Option B): each billing-set member priced at their OWN
        -- assigned_tier. resolve_field_app_chemical_price() naturally makes manual/quote shared
        -- (tier-independent) and only the tier fallback per-customer, so a manual/quote line
        -- yields identical prices for everyone (calculator collapses to source_lr) while a
        -- pure-tier line prices each co-owner at their own tier (calculator per_person).
        SELECT COALESCE(jsonb_object_agg(
                 m.cust,
                 (resolve_field_app_chemical_price(
                    v_product_id, v_field_ids,
                    COALESCE((SELECT c.assigned_tier FROM customers c WHERE c.id = m.cust::uuid), 1),
                    v_chem_manual)->>'unit_price_cents')::bigint), '{}'::jsonb)
          INTO v_chem_price_map
          FROM unnest(v_members) AS m(cust);

        -- Codex round-11 P1: reject an UNRESOLVED chemical price. Without a manual override, if any
        -- co-owner's resolved price (field quote → their assigned tier) is NULL or <= 0, the line would
        -- bill $0, be flagged suppressed_zero_total, and STILL post — consuming inventory + RUP records
        -- with NO receivable and no operator signal. Require a real positive price for EVERY member. A
        -- manual override (already validated > 0 above) resolves the same for everyone, so it passes.
        IF v_chem_manual IS NULL AND EXISTS (
          SELECT 1 FROM unnest(v_members) AS m(cust)
           WHERE COALESCE((v_chem_price_map->>m.cust)::bigint, 0) <= 0
        ) THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_PRICE_UNRESOLVED: chemical line % has no resolvable price (no field quote and no tier price) for one or more co-owners — set the product''s tier pricing / a field quote, or enter a manual override, before saving', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;

        -- Representative line base (display + the calculator's default price): the largest-share
        -- owner's price. The MONEY comes from the per-customer overrides injected below, not this.
        SELECT c.assigned_tier INTO v_rep_tier
          FROM customers c
         WHERE c.id = (
           SELECT (value->>'customer_id')::uuid
             FROM jsonb_array_elements(v_vector) AS value
            ORDER BY (value->>'micro_pct')::bigint DESC, value->>'customer_id' ASC
            LIMIT 1);
        v_price_res      := resolve_field_app_chemical_price(
                              v_product_id, v_field_ids, COALESCE(v_rep_tier, 1), v_chem_manual);
        v_src_unit_price := (v_price_res->>'unit_price_cents')::bigint;
        v_base_source    := v_price_res->>'price_source';

        -- Convert applied qty (rate unit) -> product sold unit so price x qty is per the
        -- SAME unit (the live 128x guard). No inventory_unit -> identity (price as entered).
        v_priced_qty := field_app_priced_quantity(
                          v_src_qty, v_rate_unit, COALESCE(v_inv_unit, v_rate_unit), v_form);
        IF v_priced_qty IS NULL THEN
          RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: chemical line % — rate unit "%" does not convert to the product''s sold unit "%". Fix this product''s units before invoicing.',
            v_idx, coalesce(v_rate_unit, '<none>'), COALESCE(v_inv_unit, v_rate_unit, '<none>')
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_src_qty := round(v_priced_qty, 4);
        -- Quantity is now in the pricing (sold) unit; show that unit on the invoice line
        -- so the displayed quantity and its unit label agree.
        v_eff_rate_unit := COALESCE(v_inv_unit, v_rate_unit);
      END;
    ELSE
      -- flat_fee / fuel_surcharge: bill from source_flat_cents; unit price is 0.
      -- Codex round-5 P1: require a POSITIVE amount server-side. The editor rejects <=0
      -- ("credits aren't supported here yet"), but a direct RPC call must not create a free or
      -- negative flat charge (a negative flat_cents would post a CHARGE the operator never saw).
      IF v_src_flat IS NULL OR v_src_flat <= 0 THEN
        RAISE EXCEPTION 'SPLIT_FLAT_CENTS_REQUIRED: source_flat_cents must be a positive amount for % line %', v_line_kind, v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_src_unit_price := COALESCE(v_src_unit_price, 0);
      v_base_source    := 'flat';
    END IF;

    INSERT INTO field_app_billing_lines (
      billing_set_id, line_kind, product_id, application_service_id, description,
      source_quantity, source_acres, source_unit_price_cents, sort_order
    ) VALUES (
      v_set_id, v_line_kind, v_product_id, v_app_service_id, v_line_desc,
      -- Codex round-4 P2 #10: persist the source applied-acre basis alongside the quantity.
      -- Service lines bill on acres (source_quantity is NULL for them), so without this a
      -- post-time verifier had no acre basis for a service line. Now every line records both.
      v_src_qty, v_src_acres, v_src_unit_price, v_idx
    ) RETURNING id INTO v_line_id;

    -- Build the calculator share vector. If the caller omitted 'shares' the line
    -- uses the default vector; otherwise each share may override micro_pct/price
    -- (a null micro_pct on a field_default share is filled from the default map).
    IF v_line ? 'shares' AND jsonb_typeof(v_line->'shares') = 'array'
       AND jsonb_array_length(v_line->'shares') > 0 THEN
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', s->>'customer_id',
               'micro_pct',
                 CASE WHEN s->'micro_pct' IS NOT NULL AND jsonb_typeof(s->'micro_pct') <> 'null'
                      THEN (s->>'micro_pct')::bigint
                      ELSE (v_micro_map->>(s->>'customer_id'))::bigint END,
               'split_mode', COALESCE(s->>'split_mode', 'field_default'),
               'price_mode', COALESCE(s->>'price_mode', 'default'),
               'override_unit_price_cents', s->'override_unit_price_cents'
             ))
        INTO v_shares
        FROM jsonb_array_elements(v_line->'shares') AS s;
    ELSE
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', v->>'customer_id',
               'micro_pct',   (v->>'micro_pct')::bigint,
               'split_mode',  'field_default',
               'price_mode',  'default'
             ))
        INTO v_shares
        FROM jsonb_array_elements(v_vector) AS v;
    END IF;

    -- Option B (chemical): price each share at that customer's OWN resolved price from the map,
    -- UNLESS the caller already set an explicit per-person override (a manual draft adjustment,
    -- which wins). The override slot is how per-person prices reach the calculator. Uniform-price
    -- lines are then routed round-once via the penny guard below (source_lr); genuinely mixed
    -- per-customer prices use the calculator's per_person path (exact to its own SUM).
    IF COALESCE(v_chem_price_map, v_svc_price_map) IS NOT NULL THEN
      SELECT jsonb_agg(
               CASE
                 WHEN s->>'price_mode' = 'override'
                      AND s->'override_unit_price_cents' IS NOT NULL
                      AND jsonb_typeof(s->'override_unit_price_cents') <> 'null'
                 THEN s
                 ELSE jsonb_set(
                        jsonb_set(s, '{price_mode}', '"override"'::jsonb),
                        '{override_unit_price_cents}',
                        to_jsonb((COALESCE(v_chem_price_map, v_svc_price_map)->>(s->>'customer_id'))::bigint))
               END)
        INTO v_shares
        FROM jsonb_array_elements(v_shares) AS s;

      -- Penny guard: when EVERY co-owner ends up at the SAME effective price (a manual/quote
      -- line, all-same-tier, OR a uniform manual per-person adjustment that differs from the
      -- representative), align the calculator's source price to that shared value so it routes
      -- through the round-once source_lr path (penny-exact to a single parent total) instead of
      -- per_person (which can differ by up to n-1 cents on the group total). Mixed prices keep
      -- per_person. Adversarial LOW, 2026-07-18.
      SELECT CASE WHEN count(DISTINCT (s->>'override_unit_price_cents')::bigint) = 1
                  THEN max((s->>'override_unit_price_cents')::bigint) END
        INTO v_uniform_price
        FROM jsonb_array_elements(v_shares) AS s
       WHERE s->>'override_unit_price_cents' IS NOT NULL;
      -- Codex round-7 P2: preserve the RESOLVED representative base BEFORE the uniform penny guard may
      -- overwrite v_src_unit_price with a (uniform) caller override. An 'override' share's AUDITED base
      -- must stay the true tier/quote/service base, not the override value — otherwise the audit reads
      -- as if the override equalled the base and the real tier/quote/service price is lost.
      v_repr_base_price := v_src_unit_price;
      IF v_uniform_price IS NOT NULL THEN
        v_src_unit_price := v_uniform_price;
      END IF;
    ELSE
      v_repr_base_price := v_src_unit_price;
    END IF;

    -- Every line's customer set must EXACTLY equal the billing-set members (spec §3).
    SELECT array_agg(value->>'customer_id' ORDER BY value->>'customer_id')
      INTO v_line_customers
      FROM jsonb_array_elements(v_shares) AS value;
    IF v_line_customers IS DISTINCT FROM v_members THEN
      RAISE EXCEPTION 'SPLIT_LINE_MEMBER_MISMATCH: line % customers do not equal the billing-set members', v_idx
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The single shared engine — preview and save both call this exact function.
    v_calc := compute_line_split_allocation(jsonb_build_object(
      'billing_line_id',         v_line_id::text,
      'line_kind',               v_line_kind,
      'source_quantity',         v_src_qty,
      'source_acres',            v_src_acres,
      'source_unit_price_cents', v_src_unit_price,
      'source_flat_cents',       v_src_flat,
      'base_price_source',       v_base_source,
      'shares',                  v_shares
    ));

    -- Persist the canonical source-line total for the invariant check. Fable-adversarial MED: also
    -- re-persist source_unit_price_cents to the price the money ACTUALLY used — the billing line was
    -- INSERTed with the representative resolved price, but the uniform-override penny guard above may
    -- have re-pointed v_src_unit_price (e.g. a uniform per-person override that differs from the base),
    -- leaving the audit row's price × source inconsistent with its own source_line_cents.
    UPDATE field_app_billing_lines
       SET source_line_cents = (v_calc->>'source_line_cents')::bigint,
           source_unit_price_cents = v_src_unit_price
     WHERE id = v_line_id;

    -- #G (Codex round-2 P1): allocate the ONE canonical line COGS across co-owners with the
    -- SAME largest-remainder rule used for revenue, so the group total_cost ties EXACTLY to
    -- unit_cost x source — no per-child independent-rounding drift of up to n-1 cents. The
    -- line's micro_pct weights already sum to 100000000 (enforced by the invariant), so
    -- _lr_allocate_int sums the shares to v_line_cogs exactly. Zero cost => all-zero shares.
    v_line_cogs := CASE
      WHEN v_line_kind = 'service'  THEN safe_cents_qty(v_line_unit_cost, COALESCE(v_src_acres, 0))
      WHEN v_line_kind = 'chemical' THEN safe_cents_qty(v_line_unit_cost, COALESCE(v_src_qty, 0))
      ELSE 0 END;
    SELECT jsonb_agg(jsonb_build_object('customer_id', a->>'customer_id',
                                        'weight', (a->>'micro_pct')::bigint))
      INTO v_cogs_weights
      FROM jsonb_array_elements(v_calc->'allocations') AS a;
    SELECT jsonb_object_agg(x->>'customer_id', (x->>'amount')::bigint)
      INTO v_cogs_map
      FROM jsonb_array_elements(public._lr_allocate_int(v_line_cogs, v_cogs_weights)) AS x;

    v_line_plans := v_line_plans || jsonb_build_array(jsonb_build_object(
      'billing_line_id', v_line_id::text,
      'line_kind',       v_line_kind,
      'product_id',      v_product_id,
      'description',     v_line_desc,
      'rate_unit',       v_eff_rate_unit,
      'sort_order',      v_idx,
      'unit_cost_cents', v_line_unit_cost,   -- per-unit COGS (Codex P1 #3)
      'cogs_by_customer', v_cogs_map,        -- LR-allocated per-child COGS (Codex r2 #G)
      'per_customer_priced', (COALESCE(v_chem_price_map, v_svc_price_map) IS NOT NULL), -- Option B (#M)
      'caller_override_custs', COALESCE(to_jsonb(v_caller_override), '[]'::jsonb),       -- genuine overrides (#M)
      'repr_base_unit_price_cents', v_repr_base_price,   -- resolved representative base for the override audit (Codex r7 P2)
      'resolved_price_map', COALESCE(v_chem_price_map, v_svc_price_map, '{}'::jsonb),    -- customer_id -> OWN resolved pre-override price (Codex r8 P2)
      'svc_source_map',  COALESCE(v_svc_source_map, '{}'::jsonb),  -- per-customer service source (#M)
      'reasons_map',     COALESCE(v_reasons_map, '{}'::jsonb),     -- split/price reasons (#L)
      'service_name',    CASE WHEN v_line_kind = 'service' THEN v_svc_name ELSE NULL END, -- Codex r2 #N (via v_svc_name: referencing the record here crashed service-less saves)
      'alloc',           v_calc
    ));
    v_line_hashes := v_line_hashes || jsonb_build_array(v_calc->>'vector_hash');
  END LOOP;

  -- ---- PASS 2: one child invoice per customer --------------------------------
  FOREACH v_cust IN ARRAY v_members
  LOOP
    v_customer_id := v_cust::uuid;
    SELECT farm_name INTO v_customer_name FROM customers WHERE id = v_customer_id;
    -- Display-only "primary grower" flag on the compat share row.
    v_is_primary := EXISTS (
      SELECT 1 FROM field_billing_defaults d
       WHERE d.field_id = ANY(v_field_ids)
         AND d.customer_id = v_customer_id
         AND d.is_primary);

    -- sql-safety: exempt-registry — invoices.field_app_billing_set_id / send_disposition
    -- are created by the prior parked migration 20260718010000 (see file header).
    -- Reuse an existing child for this customer on re-save (preserves invoice_number
    -- + append-only snapshot history — adversarial F1 fix); INSERT only for a new customer.
    v_invoice_id := NULL;
    IF p_billing_set_id IS NOT NULL THEN
      -- Reuse only an EDITABLE (draft/unposted) child. Fable-adversarial BLOCKER: a child voided/
      -- cancelled via the live void_invoice stays attached to the set; reusing (reviving) it would be a
      -- forbidden voided->draft transition AND resurrect a dead invoice. Skip it — a fresh child is
      -- INSERTed below for this still-member customer; the terminal one stays as voided/cancelled history.
      SELECT id INTO v_invoice_id FROM invoices
       WHERE field_app_billing_set_id = v_set_id
         AND customer_id = v_customer_id
         AND deleted_at IS NULL
         AND status IN ('draft', 'unposted')
       LIMIT 1;
    END IF;

    IF v_invoice_id IS NULL THEN
      v_is_new_invoice := true;
      v_invoice_number := next_invoice_number('field_application');
      -- sql-safety: exempt-registry — invoices.field_app_billing_set_id is created by the prior
      -- parked migration 20260718010000 (not yet in the schema-registry); job_id / application_date
      -- / season are long-standing invoices columns (mirrors transfer_job_to_invoice).
      -- sql-safety: exempt-registry — field_app_billing_set_id is created by the parked migration
      -- 20260718010000 (not yet in the registry); field_names/crop_type/total_acres are long-standing
      -- invoices columns (20260219200000_invoice_statement_enrichment).
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status,
        invoice_date, salesman_id, header_notes, created_by,
        total_amount_cents, total_cost_cents,
        invoice_group_id, application_service_id, season,
        field_app_billing_set_id, job_id, application_date,
        field_names, crop_type, total_acres,   -- Codex r7 P2: denormalized field context for the combined list/PDFs
        applicator_name, vehicle_name           -- Codex r8 P2: source-job applicator/vehicle
      ) VALUES (
        v_invoice_number, v_customer_id, 'field_application', 'draft',
        COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date),  -- fallback is the America/Chicago business date, never UTC (2026-09-03)
        v_salesman_id, p_invoice->>'header_notes', p_performed_by,
        0, 0,
        v_group_id, p_application_service_id, v_season,   -- season = job/invoice season (round-3 P1)
        -- job_id + application_date on EVERY child so field-invoice lists resolve Job # and the
        -- application date, not just the first child via jobs.invoice_id (round-3 P2).
        v_set_id, p_source_job_id, v_job_app_date,
        v_inv_field_names, v_inv_crop_type, v_total_applied_acres,
        v_inv_applicator_name, v_inv_vehicle_name
      ) RETURNING id INTO v_invoice_id;
    ELSE
      v_is_new_invoice := false;
      -- Load the existing invoice_number so it is never stale/null on a re-save (Codex P1 #8).
      SELECT invoice_number INTO v_invoice_number FROM invoices WHERE id = v_invoice_id;
      -- Keep status as-is (draft or unposted); a non-admin cannot reassign salesman.
      UPDATE invoices SET
        invoice_date           = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
        salesman_id            = CASE WHEN is_admin() THEN v_salesman_id ELSE salesman_id END,
        header_notes           = p_invoice->>'header_notes',
        application_service_id  = p_application_service_id,
        invoice_group_id       = v_group_id,
        season                 = v_season,               -- keep season in sync on re-save (round-3 P1)
        job_id                 = p_source_job_id,         -- round-3 P2 (frozen source job)
        application_date       = v_job_app_date,
        field_names            = v_inv_field_names,        -- Codex r7 P2: keep denormalized field context in sync on re-save
        crop_type              = v_inv_crop_type,
        total_acres            = v_total_applied_acres,
        applicator_name        = v_inv_applicator_name,    -- Codex r8 P2
        vehicle_name           = v_inv_vehicle_name,
        total_amount_cents     = 0,
        total_cost_cents       = 0,
        send_disposition       = 'normal',
        updated_at             = now()
      WHERE id = v_invoice_id;
    END IF;

    v_invoice_total := 0;
    v_invoice_cost  := 0;
    v_invoice_chem_profit := 0;   -- round-5 P1: this child's chemical profit (LR COGS), for commissions
    -- Compat share acres derived ONCE from the ownership vector × total applied acres
    -- (Codex P2 #9), independent of the billing lines — so it neither zeroes out on a
    -- no-service set nor double-counts across multiple service lines.
    v_cust_acres    := round(v_total_applied_acres
                             * COALESCE((v_micro_map->>v_cust)::numeric, 0) / 100000000.0, 2);

    FOR v_plan IN SELECT * FROM jsonb_array_elements(v_line_plans)
    LOOP
      v_line_kind := v_plan->>'line_kind';
      -- this customer's allocation row for this line
      SELECT a INTO v_alloc_row
        FROM jsonb_array_elements(v_plan->'alloc'->'allocations') AS a
       WHERE a->>'customer_id' = v_cust;
      IF v_alloc_row IS NULL THEN
        RAISE EXCEPTION 'SPLIT_MISSING_ALLOCATION: customer % missing on line %', v_cust, v_plan->>'billing_line_id'
          USING ERRCODE = 'internal_error';
      END IF;

      v_qty         := (v_alloc_row->>'allocated_quantity')::numeric;
      v_acres_alloc := (v_alloc_row->>'allocated_acres')::numeric;

      -- #M (Codex round-2 P2) + #L reasons: decide each co-owner's AUDITED base price / source /
      -- mode. A co-owner's OWN resolved per-customer price (Option B) is their BASE with its real
      -- source and price_mode='default'; only a genuine caller-supplied manual per-person override
      -- is audited as an 'override' against the representative base. Non-Option-B lines keep the
      -- calculator's values verbatim. Reasons are captured when the operator supplied them.
      v_split_reason := NULLIF(v_plan->'reasons_map'->v_cust->>'split_reason', '');
      v_price_reason := NULLIF(v_plan->'reasons_map'->v_cust->>'price_reason', '');
      IF (v_plan->'caller_override_custs') ? v_cust THEN
        -- Codex round-7/8 P2: audit THIS customer's OWN resolved pre-override price (Option B), falling
        -- back to the resolved representative base (round-7) then the calculator base. Never the override
        -- value itself — the audit must document what the price WOULD have been before the override.
        v_share_base_price  := COALESCE((v_plan->'resolved_price_map'->>v_cust)::bigint,
                                        (v_plan->>'repr_base_unit_price_cents')::bigint,
                                        (v_alloc_row->>'base_unit_price_cents')::bigint);
        v_share_base_source := CASE WHEN v_line_kind = 'service'
                                    THEN COALESCE(v_plan->'svc_source_map'->>v_cust, v_alloc_row->>'base_price_source')
                                    ELSE v_alloc_row->>'base_price_source' END;
        v_share_price_mode  := 'override';
      ELSIF COALESCE((v_plan->>'per_customer_priced')::boolean, false) THEN
        v_share_base_price  := (v_alloc_row->>'unit_price_cents')::bigint;        -- this co-owner's OWN price
        v_share_base_source := CASE WHEN v_line_kind = 'service'
                                    THEN COALESCE(v_plan->'svc_source_map'->>v_cust, v_alloc_row->>'base_price_source')
                                    ELSE v_alloc_row->>'base_price_source' END;
        v_share_price_mode  := 'default';
      ELSE
        v_share_base_price  := (v_alloc_row->>'base_unit_price_cents')::bigint;
        v_share_base_source := v_alloc_row->>'base_price_source';
        v_share_price_mode  := v_alloc_row->>'price_mode';
      END IF;

      -- Map the AUDITED per-customer source onto the invoice_items.price_source
      -- convention set ('manual'|'quoted'|'tier'); the exact source is preserved
      -- on invoice_line_shares.base_price_source.
      v_item_price_source := CASE v_share_base_source
        WHEN 'quoted' THEN 'quoted'
        WHEN 'tier'   THEN 'tier'
        WHEN 'service_rate'    THEN 'tier'
        WHEN 'service_default' THEN 'tier'
        ELSE 'manual' END;

      -- #G (Codex round-2 P1): this co-owner's LR-allocated COGS share for the line, so the
      -- GROUP total_cost ties EXACTLY to the canonical unit_cost x source (no per-child
      -- independent-round drift of up to n-1 cents). The invoice_items.cost_cents keeps its
      -- display convention (#F): a chemical item carries PER-UNIT cost (PDF/detail render unit
      -- economics), a fee (service) item carries this EXTENDED share. The header total_cost
      -- accumulates the LR share below, so the group total is exact regardless.
      v_item_cost_cents := COALESCE((v_plan->'cogs_by_customer'->>v_cust)::bigint, 0);

      -- sql-safety: exempt-registry — invoice_items.billing_line_id is created by the prior parked
      -- migration 20260718010000 (not yet in the registry); unit_size/total_applied/total_applied_unit
      -- are long-standing invoice_items columns (20260219200000_invoice_statement_enrichment).
      -- Codex round-8 P1: the field-application PDF/email renders the price unit from unit_size and the
      -- applied quantity from total_applied/total_applied_unit. For a chemical child, mirror the canonical
      -- field-app item: unit_size = the pricing unit, total_applied = this co-owner's billed quantity in
      -- that unit. Service/flat leave them null (service bills per acre; flat is flat).
      INSERT INTO invoice_items (
        invoice_id, product_id, description,
        quantity, unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_unit,
        unit_size, total_applied, total_applied_unit,
        is_application_fee, price_source, billing_line_id
      ) VALUES (
        v_invoice_id, (v_plan->>'product_id')::uuid,
        COALESCE(NULLIF(v_plan->>'description', ''),
                 (SELECT product_name FROM products WHERE id = (v_plan->>'product_id')::uuid),
                 NULLIF(v_plan->>'service_name', ''),      -- Codex r2 #N: real service name, not literal 'Service'
                 initcap(v_line_kind)),
        CASE WHEN v_line_kind = 'service' THEN COALESCE(v_acres_alloc, 0)
             WHEN v_line_kind = 'chemical' THEN COALESCE(v_qty, 0)
             ELSE 1 END,
        (v_alloc_row->>'unit_price_cents')::bigint,
        (v_alloc_row->>'amount_cents')::bigint,     -- extended = authoritative allocation
        CASE WHEN v_line_kind = 'chemical' THEN (v_plan->>'unit_cost_cents')::bigint
             ELSE v_item_cost_cents END,            -- chemical: PER-UNIT; fee: EXTENDED LR share (#F/#G)
        (v_plan->>'sort_order')::int,
        v_acres_alloc,
        CASE WHEN v_line_kind = 'service' THEN 'acre' ELSE v_plan->>'rate_unit' END,
        CASE WHEN v_line_kind = 'chemical' THEN NULLIF(v_plan->>'rate_unit', '') END,   -- unit_size = pricing unit
        CASE WHEN v_line_kind = 'chemical' THEN COALESCE(v_qty, 0) END,                  -- total_applied = billed qty
        CASE WHEN v_line_kind = 'chemical' THEN NULLIF(v_plan->>'rate_unit', '') END,   -- total_applied_unit
        (v_line_kind = 'service'),
        v_item_price_source,
        (v_plan->>'billing_line_id')::uuid
      ) RETURNING id INTO v_item_id;

      INSERT INTO invoice_line_shares (
        billing_line_id, invoice_item_id, customer_id,
        split_mode, split_micro_pct, allocated_quantity, allocated_acres,
        base_unit_price_cents, base_price_source, price_mode,
        unit_price_cents, amount_cents,
        split_override_reason, price_override_reason,
        calculation_hash, vector_hash, created_by
      ) VALUES (
        (v_plan->>'billing_line_id')::uuid, v_item_id, v_customer_id,
        v_alloc_row->>'split_mode', (v_alloc_row->>'micro_pct')::bigint,
        v_qty, v_acres_alloc,
        v_share_base_price,          -- #M: co-owner's OWN resolved price is the audited base
        v_share_base_source,         -- #M: their own resolved source (service_rate/tier/...)
        v_share_price_mode,          -- #M: 'default' for resolved pricing, 'override' only for a real one
        (v_alloc_row->>'unit_price_cents')::bigint,
        (v_alloc_row->>'amount_cents')::bigint,
        v_split_reason, v_price_reason,   -- #L: captured reasons when the operator supplied them
        v_alloc_row->>'calculation_hash',
        v_plan->'alloc'->>'vector_hash',
        p_performed_by
      );

      v_invoice_total := v_invoice_total + (v_alloc_row->>'amount_cents')::bigint;
      -- #G: accumulate this co-owner's LR-allocated COGS share directly; the GROUP total_cost
      -- now ties EXACTLY to the canonical unit_cost x source (no per-child rounding drift).
      v_invoice_cost  := v_invoice_cost + v_item_cost_cents;
      -- Codex round-5 P1: chemical-line profit for commissions uses the SAME LR-allocated COGS
      -- (v_item_cost_cents), NOT a re-rounded cost*qty on the per-unit item cost. Only product-
      -- backed chemical lines count toward commission (fees/service/flat are excluded), mirroring
      -- transfer_job_to_invoice's chemical-only profit basis.
      IF v_line_kind = 'chemical' THEN
        v_invoice_chem_profit := v_invoice_chem_profit
          + ((v_alloc_row->>'amount_cents')::bigint - v_item_cost_cents);
      END IF;
    END LOOP;

    -- Stash this child's chemical profit (cents) for the commission mint below (round-5 P1).
    v_chem_profit_by_child := v_chem_profit_by_child
      || jsonb_build_object(v_invoice_id::text, v_invoice_chem_profit);

    v_send_disposition := CASE WHEN v_invoice_total = 0 THEN 'suppressed_zero_total' ELSE 'normal' END;

    UPDATE invoices
       SET total_amount_cents = v_invoice_total,
           total_cost_cents   = v_invoice_cost,
           send_disposition   = v_send_disposition,
           updated_at         = now()
     WHERE id = v_invoice_id;

    -- R2: keep the compatibility invoice_shares self-100% row (statements/year-end
    -- read invoice_shares.amount_cents). Do NOT drop as "redundant".
    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order, price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_cust_acres, v_invoice_total,
      v_is_primary, 0, NULL, NULL
    );

    -- Append-only ledger: emit the 'invoice_created' row ONLY when this child was freshly
    -- INSERTed (Codex P1 #8). On a re-save we reuse the existing child, so a creation row
    -- here would duplicate the invoice's financial impact and (previously) carry a stale/null
    -- invoice_number. A re-save changes draft line detail only; no creation event is due.
    IF v_is_new_invoice THEN
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object('invoice_number', v_invoice_number,
                           'customer_id', v_customer_id,
                           'total_cents', v_invoice_total,
                           'send_disposition', v_send_disposition),
        v_invoice_total,
        'Per-line split field application invoice created'
      );
    END IF;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);
  END LOOP;

  -- ---- #E CONSUME THE SOURCE JOB (Codex round-2 P1) --------------------------
  -- Now that the child invoices exist, mark the source job invoiced exactly like
  -- transfer_job_to_invoice does, so the normal flow's "Job already invoiced" guard
  -- fires and the same work can never be billed twice. Idempotent on re-save (a job
  -- already 'invoiced' by THIS set is left as-is; the guard above already allowed it).
  IF p_source_job_id IS NOT NULL THEN
    -- Resolve the commission split exactly like transfer_job_to_invoice: the job's own
    -- creation-time snapshot, else the parent quote's split, else the customer default (only
    -- pre-U8 jobs reach the fallback). v_job was loaded FOR UPDATE in the #E guard above.
    v_commission_split := v_job.commission_split;
    IF v_commission_split IS NULL THEN
      IF v_job.quote_id IS NOT NULL THEN
        SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
      ELSE
        SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
      END IF;
    END IF;

    -- Consume the job: flip completed->invoiced, set the anchor invoice_id, AND persist the resolved
    -- split — ALL IN ONE statement while OLD.status='completed'. The live enforce_billed_job_immutability
    -- trigger early-returns for a not-yet-billed job, so this is the ONLY point a non-admin may set
    -- invoice_id (drift B1); it is exactly the single-statement shape of transfer_job_to_invoice.
    -- Idempotent: no-ops on re-save (status already 'invoiced').
    UPDATE jobs SET status = 'invoiced', invoice_id = v_invoice_ids[1],
        commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
     WHERE id = p_source_job_id AND status <> 'invoiced';

    -- Codex round-5 P2 / drift B1: on a RE-SAVE that dropped the member previously stored in
    -- jobs.invoice_id, the anchor now points at a cancelled, detached child — repoint it to a surviving
    -- current child (v_invoice_ids only ever holds current members). The job is already 'invoiced', so
    -- the immutability trigger would block a non-admin from changing invoice_id — use the SAME
    -- app.admin_override hatch that trigger sanctions for definer-flow writers (as transfer_invoice_to_job
    -- does), scoped tightly around JUST this repoint, and ONLY when the stored anchor is no longer a live
    -- member child (a no-op when it is unchanged — the common re-save case, no override needed).
    IF NOT EXISTS (
      SELECT 1 FROM invoices i
       WHERE i.id = (SELECT j.invoice_id FROM jobs j WHERE j.id = p_source_job_id)
         AND i.field_app_billing_set_id = v_set_id
         AND i.deleted_at IS NULL AND i.status <> 'cancelled'
    ) THEN
      PERFORM set_config('app.admin_override', 'true', true);
      UPDATE jobs SET invoice_id = v_invoice_ids[1] WHERE id = p_source_job_id;
      PERFORM set_config('app.admin_override', 'false', true);
    END IF;

    -- application_records has no billed-immutability guard (triggers live only on jobs / job_applied_
    -- records) — repoint it unconditionally to the surviving anchor, matching live transfer_job_to_invoice.
    UPDATE application_records SET invoice_id = v_invoice_ids[1]
     WHERE source_type = 'job' AND source_id = p_source_job_id;

    -- ---- Per-child commissions (Codex round-4 P1) ----------------------------
    -- Mirror transfer_job_to_invoice's PER-OWNER GROUP path: each child invoice mints
    -- commissions on ITS OWN chemical-line profit, so the sum across children equals the
    -- whole job's chemical profit and each recipient is paid per invoice they touch. A
    -- split job billed here previously created NO commissions AND the status flip blocked
    -- the normal path from ever creating them.
    --
    -- Profit basis (Codex round-5 P1): each child's CHEMICAL profit accumulated in PASS 2 using the
    -- SAME largest-remainder-allocated COGS (v_item_cost_cents) that the header total_cost carries —
    -- NOT a re-rounded ROUND(cost × qty) on the per-unit item cost, which would drift on fractional
    -- child quantities (1¢/1u/50-50 rounds both 0.5¢ shares up to 1¢, understating profit). Service /
    -- flat / fee lines contribute 0. Sum across children == the whole job's chemical profit.
    --
    -- Re-save safe: a redraw rewrites every child's items (changing profit) and may DROP a member
    -- (whose child was orphan-cancelled above). The #E guard makes this job EXCLUSIVE to this set
    -- (it cannot be on another set or normally invoiced), so EVERY commission carrying this job_id
    -- belongs to this set — clear them ALL (including a dropped member's, which would otherwise leak
    -- a phantom pending commission on a cancelled invoice), then re-mint only for the current
    -- members. First REFUSE if any are already in an active payout batch or already paid (mirrors
    -- the U8 edit guards): the operator must void that commission payment before re-saving. On a
    -- first save there are none, so the guards pass and the clear is a no-op.
    IF EXISTS (
      SELECT 1 FROM commissions c
      JOIN commission_payment_items cpi ON cpi.commission_id = c.id
      JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
      WHERE c.job_id = p_source_job_id AND c.status = 'pending' AND cp.status <> 'voided'
    ) THEN
      RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this split''s pending commissions are in an active payout batch — void that commission payment before re-saving';
    END IF;
    IF EXISTS (
      SELECT 1 FROM commissions c WHERE c.job_id = p_source_job_id AND c.status = 'paid'
    ) THEN
      RAISE EXCEPTION 'JOB_COMMISSIONS_PAID: this split''s commissions were already paid out — void that commission payment before re-saving';
    END IF;

    -- Fable-adversarial HIGH: SOFT-cancel (never hard-DELETE) the prior commissions, then re-mint.
    -- A hard DELETE FK-violates once any of the job's commissions were EVER in a payout batch — even a
    -- VOIDED one, which is exactly what JOB_HAS_BATCHED_COMMISSIONS tells the operator to do first
    -- (commission_payment_items.commission_id is NO ACTION and void_commission_payment leaves its cpi
    -- rows in place). Soft-cancel mirrors the live convention (delete_invoices / void_invoice cancel+zero
    -- commissions, never delete them) and preserves the audit trail. Re-mint below writes fresh rows.
    UPDATE commissions
       SET status = 'cancelled', commission_amount = 0, deleted_at = now()
     WHERE job_id = p_source_job_id AND deleted_at IS NULL;

    FOREACH v_child_id IN ARRAY v_invoice_ids
    LOOP
      -- Chemical profit for this child from the LR-allocated accumulator (cents -> dollars).
      v_child_profit := COALESCE((v_chem_profit_by_child->>v_child_id::text)::bigint, 0)::numeric / 100.0;

      SELECT customer_id INTO v_child_customer FROM invoices WHERE id = v_child_id;

      PERFORM _insert_commissions_for_job(
        p_source_job_id, v_child_id, v_child_customer,
        COALESCE(v_child_profit, 0), v_commission_split, (now() AT TIME ZONE 'America/Chicago')::date);
    END LOOP;
  END IF;

  -- ---- PASS 3: field snapshots for the group (Codex P1 #7) -------------------
  -- Grouped (multi-customer) field-app invoices carry their field/crop/acre snapshot at the
  -- GROUP level (invoice_id NULL, invoice_group_id set) — exactly how the live field-app save
  -- and the invoice-list panels read them. Without these, lists and PDFs show blank fields,
  -- crops, and zero acres. job_id carries source-job provenance AND satisfies fal_requires_parent
  -- when no invoice_id is present. The prior group's rows were cleared in the re-save block.
  INSERT INTO field_app_locations (
    invoice_group_id, job_id, field_id, applied_acres, total_acres, crop_type, sort_order
  )
  SELECT v_group_id, p_source_job_id, (t.fld->>'field_id')::uuid,
         (t.fld->>'applied_acres')::numeric,
         fl.total_acres, fl.crop_type, (t.ord - 1)::int
    FROM jsonb_array_elements(p_fields) WITH ORDINALITY AS t(fld, ord)
    LEFT JOIN fields fl ON fl.id = (t.fld->>'field_id')::uuid;

  -- ---- §5 INVARIANTS — check the STORED rows, never the allocator's self-report -
  FOR v_line_id, v_src_line_cents, v_line_src_qty IN
    SELECT id, source_line_cents, source_quantity
      FROM field_app_billing_lines WHERE billing_set_id = v_set_id
  LOOP
    SELECT COALESCE(SUM(amount_cents), 0),
           COALESCE(SUM(split_micro_pct), 0),
           count(DISTINCT customer_id),
           SUM(allocated_quantity)
      INTO v_sum_cents, v_sum_micro, v_line_member_count, v_sum_qty
      FROM invoice_line_shares WHERE billing_line_id = v_line_id;

    IF v_sum_cents IS DISTINCT FROM v_src_line_cents THEN
      RAISE EXCEPTION 'INVARIANT_CENTS: line % stored cents % <> source_line_cents %',
        v_line_id, v_sum_cents, v_src_line_cents USING ERRCODE = 'internal_error';
    END IF;
    IF v_sum_micro <> 100000000 THEN
      RAISE EXCEPTION 'INVARIANT_MICRO: line % micro_pct sum % <> 100000000', v_line_id, v_sum_micro
        USING ERRCODE = 'internal_error';
    END IF;
    IF v_line_member_count <> array_length(v_members, 1) THEN
      RAISE EXCEPTION 'INVARIANT_MEMBERS: line % has % customers, expected %',
        v_line_id, v_line_member_count, array_length(v_members, 1) USING ERRCODE = 'internal_error';
    END IF;
    -- quantity ties to source at 4dp when a source quantity was provided
    IF v_line_src_qty IS NOT NULL
       AND round(COALESCE(v_sum_qty, 0), 4) IS DISTINCT FROM round(v_line_src_qty, 4) THEN
      RAISE EXCEPTION 'INVARIANT_QTY: line % qty sum % <> source_quantity %',
        v_line_id, v_sum_qty, v_line_src_qty USING ERRCODE = 'internal_error';
    END IF;
  END LOOP;

  -- ---- RESULT + idempotency ---------------------------------------------------
  v_result := jsonb_build_object(
    'billing_set_id',     v_set_id,
    'invoice_group_id',   v_group_id,
    'invoice_ids',        to_jsonb(v_invoice_ids),
    'line_vector_hashes', v_line_hashes,
    'request_hash',       p_request_hash
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    'field_app_split_invoice_saved',
    'Per-line split field app billing set saved with ' || array_length(v_invoice_ids, 1) || ' invoice(s)',
    p_performed_by, 'invoice', v_invoice_ids[1]
  );

  -- Record the idempotency key (paired with the wrapper's check_idempotency; see the
  -- idempotency-body-check exemption note at the top — canonical wrapper/impl split).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field_app_split_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._preview_field_app_invoice_split_impl_20260908(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid DEFAULT NULL::uuid, p_invoice_id uuid DEFAULT NULL::uuid, p_invoice_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_field_ids         uuid[];
  v_applied_acres_map jsonb := '{}'::jsonb;
  v_loc               jsonb;
  v_shares            jsonb;
  v_customers         jsonb;
  v_customer          jsonb;
  v_customer_id       uuid;
  v_customer_tier     int;
  v_app_service       record;
  v_per_customer      jsonb := '[]'::jsonb;
  v_customer_lines    jsonb;
  v_grand_total       bigint := 0;
  v_chem              jsonb;
  v_share_row         jsonb;
  v_chem_qty_a        numeric;
  v_chem_qty_b        numeric;
  v_share_acres       numeric;
  v_field_override    bigint;
  v_unit_price        bigint;
  v_qi_price          numeric;
  v_extended          bigint;
  v_fee_rate          bigint;
  v_fee_acres         numeric;
  v_fee_extended      bigint;
  v_customer_total    bigint;
  v_rate              numeric;
  v_ta_unit           text;       -- PARKED-010: rate unit of the applied amount
  v_inv_unit          text;       -- PARKED-010: product's sold/pricing unit
  v_form              text;       -- PARKED-010: product_form (liquid/dry)
  v_priced_qty        numeric;    -- PARKED-010: applied qty converted into the pricing unit
  v_group_id          uuid;
  v_skipped_customer_ids uuid[] := '{}';
  v_surcharge_acres   numeric;
  v_surcharge_cents   bigint;
  v_customer_count    int;        -- CRX-SEC-001: mirrors save's single-customer test
  v_new_season        integer;    -- CRX-SEC-001: season a NOT-YET-SAVED invoice would be filed under
  v_row_season        integer;    -- CRX-SEC-001: season an ALREADY-SAVED member carries
  v_price_season      integer;    -- CRX-SEC-001: the season the fee is actually priced at
BEGIN
  -- PARKED-007 (codex-driven cycle 5 #1 HIGH): in-body role gate — without it
  -- ANY authenticated role (applicator, driver, etc.) can call this SECDEF
  -- function with arbitrary field_ids and receive private customer pricing
  -- and split detail. RLS doesn't apply (we're SECDEF), the EXECUTE grant to
  -- `authenticated` widens beyond billing roles. Mirrors the save side's gate.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins or sales reps can preview field-app invoice splits'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    v_field_ids := array_append(v_field_ids, (v_loc->>'field_id')::uuid);
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(
      v_loc->>'field_id',
      GREATEST(COALESCE((v_loc->>'applied_acres')::numeric, 0), 0)
    );
  END LOOP;

  IF v_field_ids IS NULL THEN
    RETURN jsonb_build_object('per_customer', '[]'::jsonb, 'grand_total_cents', 0, 'customer_count', 0);
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  -- CRX-SEC-001 (2026-09-06): counted BEFORE the deleted-member skip, exactly like save's
  -- v_customer_count, because save's single-customer branch tests the DERIVED list.
  v_customer_count := jsonb_array_length(v_customers);
  -- The season a customer WITHOUT an existing invoice would be filed under. Same expression
  -- and same America/Chicago fallback as _save_field_app_invoice_impl_20260714's v_season, so
  -- a preview and the save it precedes cannot land on different sides of October 1.
  v_new_season := compute_season(COALESCE(p_invoice_date, (now() AT TIME ZONE 'America/Chicago')::date));

  IF p_invoice_id IS NOT NULL THEN
    SELECT invoice_group_id INTO v_group_id FROM invoices WHERE id = p_invoice_id;
    IF v_group_id IS NOT NULL THEN
      SELECT COALESCE(array_agg(DISTINCT d.customer_id), '{}') INTO v_skipped_customer_ids
        FROM invoices d
       WHERE d.invoice_group_id = v_group_id
         AND d.deleted_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM invoices l
            WHERE l.invoice_group_id = v_group_id
              AND l.customer_id = d.customer_id
              AND l.deleted_at IS NULL
         );
    END IF;
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
  END IF;

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id    := (v_customer->>'customer_id')::uuid;
    IF v_customer_id = ANY(v_skipped_customer_ids) THEN CONTINUE; END IF;
    v_customer_tier  := COALESCE((v_customer->>'tier')::int, 1);
    v_customer_total := 0;
    v_customer_lines := '[]'::jsonb;

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value->>'customer_id')::uuid = v_customer_id
        AND (value->>'price_override_cents') IS NOT NULL
    LOOP
      v_share_acres    := (v_share_row->>'share_acres')::numeric;
      v_field_override := (v_share_row->>'price_override_cents')::bigint;
      v_extended := ROUND(v_field_override * v_share_acres)::bigint;
      v_customer_lines := v_customer_lines || jsonb_build_object(
        'kind', 'grower_share',
        'description', (v_share_row->>'field_name') || ' grower share @ $' ||
                       (v_field_override / 100.0)::numeric(12,2) || '/ac',
        'quantity', v_share_acres,
        'unit_price_cents', v_field_override,
        'extended_cents', v_extended
      );
      v_customer_total := v_customer_total + v_extended;
    END LOOP;

    FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals)
    LOOP
      v_chem_qty_a := 0;
      v_chem_qty_b := 0;
      v_rate := COALESCE((v_chem->>'rate_per_acre')::numeric, 0);
      FOR v_share_row IN
        SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
        WHERE (value->>'customer_id')::uuid = v_customer_id
      LOOP
        v_share_acres := (v_share_row->>'share_acres')::numeric;
        IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
          v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
        ELSE
          v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
        END IF;
      END LOOP;

      IF v_chem_qty_b > 0 THEN
        v_unit_price := NULL;
        IF v_chem ? 'manual_override' AND (v_chem->>'manual_override')::boolean = true
           AND (v_chem->>'unit_price_cents') IS NOT NULL THEN
          v_unit_price := (v_chem->>'unit_price_cents')::bigint;
        END IF;
        IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
          SELECT qi.price_per_unit INTO v_qi_price
            FROM quote_items qi
            JOIN quote_sections qs ON qs.id = qi.section_id
           WHERE qi.product_id = (v_chem->>'product_id')::uuid
             AND qs.field_id   = ANY(v_field_ids)
           ORDER BY qi.id LIMIT 1;
          IF v_qi_price IS NOT NULL THEN v_unit_price := ROUND(v_qi_price * 100)::bigint; END IF;
        END IF;
        IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
          SELECT CASE v_customer_tier
            WHEN 1 THEN COALESCE(ROUND(p.tier1_price * 100), 0)
            WHEN 2 THEN COALESCE(ROUND(p.tier2_price * 100), ROUND(p.tier1_price * 100), 0)
            WHEN 3 THEN COALESCE(ROUND(p.tier3_price * 100), ROUND(p.tier1_price * 100), 0)
            ELSE COALESCE(ROUND(p.tier1_price * 100), 0)
          END INTO v_unit_price FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        END IF;
        v_unit_price := COALESCE(v_unit_price, 0);

        -- PARKED-010 (preview parity with save_field_app_invoice): the applied amount is in the
        -- RATE unit but v_unit_price is per the product's SOLD unit; convert before pricing so this
        -- on-page customer-split preview shows the same dollars the saved invoice will (not ~128x).
        v_ta_unit  := COALESCE(NULLIF(v_chem->>'rate_unit', ''), NULLIF(v_chem->>'unit_size', ''));
        v_inv_unit := NULL;
        v_form     := NULL;
        IF (v_chem->>'product_id') IS NOT NULL THEN
          SELECT p.inventory_unit, p.product_form::text INTO v_inv_unit, v_form
            FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        END IF;
        v_priced_qty := field_app_priced_quantity(v_chem_qty_b, v_ta_unit, COALESCE(v_inv_unit, v_ta_unit), v_form);
        -- Unconvertible units (save blocks with FIELD_APP_UNIT_UNCONVERTIBLE): preview the line at
        -- $0 rather than the old ~128x figure or crashing the preview.
        v_priced_qty := CASE WHEN v_priced_qty IS NULL THEN 0 ELSE ROUND(v_priced_qty, 4) END;
        v_extended := ROUND(v_unit_price * v_priced_qty)::bigint;
        v_customer_lines := v_customer_lines || jsonb_build_object(
          'kind', 'chemical', 'description', v_chem->>'description',
          'quantity', v_priced_qty,
          'unit_price_cents', v_unit_price, 'extended_cents', v_extended
        );
        v_customer_total := v_customer_total + v_extended;
      END IF;
    END LOOP;

    IF p_application_service_id IS NOT NULL THEN
      -- CRX-SEC-001: resolve the season THIS customer's invoice is (or would be) filed under,
      -- reproducing _save_field_app_invoice_impl_20260714's branch order exactly:
      --   1. an existing live member of the group  -> that row's stored season
      --   2. a single-customer edit of p_invoice_id -> that row's stored season
      --   3. otherwise (a new invoice)              -> compute_season(invoice date)
      -- Save never re-seasons an existing invoice (DECISION_LOG 2026-09-04), so branches 1
      -- and 2 must read the STORED season rather than recompute one.
      --
      -- v_row_season is reset at the top of every iteration. The hazard is not the SELECT INTO
      -- itself -- PL/pgSQL assigns NULL to the target when the query returns no row -- it is the
      -- IF/ELSIF below, which can take NEITHER branch (no group, and either no p_invoice_id or a
      -- multi-customer split). In that case nothing assigns v_row_season at all and, without this
      -- reset, it would still hold the PREVIOUS customer's season and price this customer's fee
      -- against the wrong year. The reset makes branch 3 reachable rather than inherited.
      --
      -- COALESCE treats "no row found" and "row found with a NULL season" the same way, falling
      -- through to the computed season where save would instead match no rate row and use the
      -- service default. That divergence cannot occur today because invoices.season is NOT NULL
      -- with a default; if that constraint is ever relaxed, this line must be revisited.
      v_row_season := NULL;
      IF v_group_id IS NOT NULL THEN
        SELECT i.season INTO v_row_season
          FROM invoices i
         WHERE i.invoice_group_id = v_group_id
           AND i.customer_id      = v_customer_id
           AND i.deleted_at IS NULL
         LIMIT 1;
      ELSIF p_invoice_id IS NOT NULL AND v_customer_count = 1 THEN
        SELECT i.season INTO v_row_season FROM invoices i WHERE i.id = p_invoice_id;
      END IF;
      v_price_season := COALESCE(v_row_season, v_new_season);

      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id = v_customer_id
         AND car.application_service_id = p_application_service_id
         AND car.season = v_price_season LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;
      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;
      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := ROUND(v_fee_rate * v_fee_acres)::bigint;
        v_customer_lines := v_customer_lines || jsonb_build_object(
          'kind', 'service_fee', 'description', v_app_service.name,
          'quantity', v_fee_acres, 'unit_price_cents', v_fee_rate,
          'extended_cents', v_fee_extended
        );
        v_customer_total := v_customer_total + v_fee_extended;
      END IF;
    END IF;

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_surcharge_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id
       AND (value->>'price_override_cents') IS NULL;

    v_surcharge_cents := compute_fuel_surcharge_cents(v_surcharge_acres, v_customer_total);

    IF v_surcharge_cents > 0 THEN
      v_customer_lines := v_customer_lines || jsonb_build_object(
        'kind', 'fuel_surcharge', 'description', 'Fuel Surcharge',
        'quantity', 1, 'unit_price_cents', v_surcharge_cents,
        'extended_cents', v_surcharge_cents
      );
      v_customer_total := v_customer_total + v_surcharge_cents;
    END IF;

    v_per_customer := v_per_customer || jsonb_build_object(
      'customer_id',   v_customer_id,
      'customer_name', v_customer->>'customer_name',
      'is_primary',    COALESCE((v_customer->>'is_primary')::boolean, false),
      'tier',          v_customer_tier,
      'total_cents',   v_customer_total,
      'lines',         v_customer_lines
    );
    v_grand_total := v_grand_total + v_customer_total;
  END LOOP;

  RETURN jsonb_build_object(
    'per_customer',      v_per_customer,
    'grand_total_cents', v_grand_total,
    'customer_count',    jsonb_array_length(v_per_customer),
    'shares_detail',     v_shares
  );
END;
$function$;

-- Establish the ownership the postflight asserts, rather than depending on the applying role
-- happening to be postgres. DROP+CREATE re-owns the function to whoever runs the migration, and
-- 20260729015706's column-level revoke on application_services.cost_per_acre_cents -- which names
-- this function explicitly -- is safe only while it is a POSTGRES-OWNED SECURITY DEFINER. Without
-- this line POSTFLIGHT_OWNER would abort a correct apply run by any other role, at the very end,
-- after everything appeared to work. Same statement 20260729125314, 20260731001654 and
-- 20260826221000 use, for the same reason.
--
-- Two consequences worth stating rather than leaving to be discovered:
--   * POSTFLIGHT_OWNER can no longer fail on an unmutated run of this file, because this line
--     forces the value it asserts. It is now a check on THIS statement rather than on the applying
--     role, and the prover has to mutate this line to make it fire at all. Recorded because a
--     guard that cannot fail is exactly the shape this file spends its length guarding against.
--   * This file now SUCCEEDS under applying roles that would previously have been refused -- any
--     role that may SET ROLE postgres, not only postgres itself. That is the intended trade (the
--     20260729015706 invariant needs a postgres-OWNED function, and this establishes it), but it
--     is a real widening. A role that may NOT SET ROLE postgres now aborts here with PostgreSQL's
--     own "must be able to SET ROLE" rather than with POSTFLIGHT_OWNER's explanation; same
--     rollback, worse diagnosis.

DROP FUNCTION public._field_app_sent_quote_price_cents(uuid, uuid[], uuid[], date);
DROP FUNCTION public._field_app_quote_eligible(public.quotes, uuid, uuid[], date);
DO $post$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('create_invoice_from_blend_ticket', 'public.create_invoice_from_blend_ticket(uuid,uuid,text,text,jsonb)', 'a6f5c6e72d6632313549313b34f406ad', ARRAY['authenticated', 'postgres', 'service_role'], 'v'),
        ('_save_field_app_invoice_impl_20260714', 'public._save_field_app_invoice_impl_20260714(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)', '0f5da38476fe174cd25c9bf3e364055f', ARRAY['postgres', 'service_role'], 'v'),
        ('_save_field_app_split_invoice_impl', 'public._save_field_app_split_invoice_impl(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text,text)', 'a69f21d8e9f32fc6fecb38ac3a54801c', ARRAY['postgres', 'service_role'], 'v'),
        ('_preview_field_app_invoice_split_impl_20260908', 'public._preview_field_app_invoice_split_impl_20260908(jsonb,jsonb,uuid,uuid,date)', '83f6600412ced085d0876a3c7339ff12', ARRAY['postgres'], 's')
      ) AS pin(fn, sig, body_md5, execs, vol)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc o
             WHERE o.pronamespace = 'public'::regnamespace AND o.proname = pin.fn) <> 1
        OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
        OR p.proowner <> 'postgres'::regrole
        OR NOT p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR p.provolatile::text <> pin.vol OR p.proisstrict OR p.proleakproof OR p.proretset
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM pin.execs
  ) THEN
    RAISE EXCEPTION 'KI81_REVERSE_POSTFLIGHT: a restored body, header or grant differs';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.resolve_field_app_chemical_price(uuid,uuid[],integer,bigint)')) IS DISTINCT FROM 'd2617d60d7b6e5b922bc3e3be4e5850b' THEN
    RAISE EXCEPTION 'KI81_REVERSE_POSTFLIGHT: the resolver body differs';
  END IF;
END;
$post$;
