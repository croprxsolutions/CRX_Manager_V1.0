-- KI-81 unit (Sol on release #1990, HIGH 20270125163000:174; Taha 2026-11-19, option 1 "stop and ask"):
-- an invoice never bills a quote price in a unit the product is no longer stocked in.
--
-- WHY: a quote line's price_per_unit is per the unit the line was saved in (quote_items.unit_size). Invoice lines
-- bill in the product's stock unit (inventory_unit, else unit_size). The three quote-price lookups added by
-- 20270125163000 never compared the two, so after a product's stock unit changed (lb -> dry oz), an $80/lb quote
-- billed $80 per oz. The older resolver (20260720233000:296) was just as unit-blind, so this is not new in the
-- release, but it is fixed before go-live. Reaching it needs an admin to set a product's stock unit (the
-- product screen locks it once set; 20270121110000 refuses a change while the product has stock or open lines),
-- so it is rare.
--
-- WHAT (two functions re-emitted from 20270125163000, each unchanged apart from one inserted check):
--  0. New private _quote_item_sent_unit_20270128(quote, item): the unit the grower was last SENT for that line (the
--     newest quote_versions snapshot, if it lists the line), else NULL. A line counts as mismatched when
--     either its live unit or its sent unit doesn't match the stock unit, or either is blank or unknown, including a
--     line no sent version lists (Taha 2026-11-19, "strict": a quote price bills only in the unit the grower was sent), so editing a sent line's unit (Lb -> Gal at the same price)
--     without a resend can't make a price the grower saw per Lb bill per Gal (attack run, F1b; Luna/Sol r2).
--  1. _field_app_sent_quote_price_cents (the single field-app save, the split save through
--     resolve_field_app_chemical_price, and a blend-ticket grower's own quote): after the eligible quotes are
--     locked, a priced line for the product on those fields whose unit doesn't match the stock unit
--     (_unit_matches_stock_unit, the same test the purchasing plan uses) refuses: QUOTE_RESEND_REQUIRED, "Or
--     type the price on this invoice line". The blend-ticket caller already rewrites that ending to "Fix or
--     resend the quote for <farm>".
--  2. create_invoice_from_blend_ticket: after the product rows are held and the price choice is made, a priced
--     job-quote line for a product on the ticket whose unit doesn't match refuses the same way, naming the farm,
--     before any invoice number; a valid stored pick on a matching-unit line clears that product.
-- Not re-emitted: the split preview (_preview_field_app_invoice_split_impl_20260908). It can still show such a line at
-- the quote price; the save then refuses with this message. The preview takes no locks and bills nothing.
-- Never a silent fallback to the list price (Taha: the grower must not be billed list price instead of the
-- quoted deal without anyone seeing it). A typed (manual) price still saves on the field-app paths.
-- Grants, owners, security mode, search_path and volatility are unchanged (CREATE OR REPLACE keeps the ACLs;
-- the postflight checks them).
--
-- Stored invoices are never re-priced by this file. (KI-81's read-only check of live on 2026-11-17 found no
-- field-app line ever priced "quoted" and no blend-ticket invoice.)
-- ROLLBACK: DROP FUNCTION public._quote_item_sent_unit_20270128(uuid, uuid) after re-running the two bodies
-- from 20270125163000 (lines 116-200, 259-1236).

DO $preflight$
BEGIN
  IF to_regprocedure('public._unit_matches_stock_unit(text,text)') IS NULL THEN
    RAISE EXCEPTION 'KI81_UNIT_PREFLIGHT: _unit_matches_stock_unit (20270121110000) is missing';
  END IF;
  IF to_regprocedure('public._quote_item_sent_unit_20270128(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'KI81_UNIT_PREFLIGHT: _quote_item_sent_unit_20270128 already exists (already applied)';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public._field_app_sent_quote_price_cents(uuid,uuid[],uuid[],date)', 'd2d182551c76b841220e9b4a5329025a'),
        ('public.create_invoice_from_blend_ticket(uuid,uuid,text,text,jsonb)', '14fbea62837d72dc76da8c38dd690234')
      ) AS pin(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
  ) THEN
    RAISE EXCEPTION 'KI81_UNIT_PREFLIGHT: a function is not the 20270125163000 body this file was written against (already applied, or drifted)';
  END IF;
  PERFORM set_config('crx.ki81u_xid', pg_current_xact_id()::text, true);
  PERFORM set_config('crx.ki81u_acls', (SELECT string_agg(coalesce(p.proacl::text, '') || '/' || p.proowner::regrole::text, '|' ORDER BY s.n)
    FROM unnest(ARRAY['public._field_app_sent_quote_price_cents(uuid,uuid[],uuid[],date)', 'public.create_invoice_from_blend_ticket(uuid,uuid,text,text,jsonb)']) WITH ORDINALITY AS s(sig, n)
    JOIN pg_proc p ON p.oid = to_regprocedure(s.sig)), true);
END;
$preflight$;

CREATE FUNCTION public._quote_item_sent_unit_20270128(p_quote_id uuid, p_item_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  -- KI-81 unit: the unit the grower was last sent for this quote line, from the NEWEST sent version only (a line a
  -- later send dropped is not on the quote the grower holds; Sol r4). NULL when that version doesn't list the line or
  -- records no unit for it: the unit the grower saw is
  -- unknown, so callers stop and ask (Taha 2026-11-19, "strict"). A malformed snapshot (sections or items not an
  -- array) lists nothing.
  SELECT it.value->>'unit_size'
    FROM (SELECT v.snapshot_data FROM public.quote_versions v
           WHERE v.quote_id = p_quote_id
           ORDER BY v.version_number DESC
           LIMIT 1) v
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.snapshot_data->'sections') = 'array'
                                                THEN v.snapshot_data->'sections' ELSE '[]'::jsonb END) s(value)
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.value->'items') = 'array'
                                                THEN s.value->'items' ELSE '[]'::jsonb END) it(value)
   WHERE it.value->>'quote_item_id' = p_item_id::text
   LIMIT 1
$fn$;
ALTER FUNCTION public._quote_item_sent_unit_20270128(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._quote_item_sent_unit_20270128(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._field_app_sent_quote_price_cents(
  p_product_id   uuid,
  p_field_ids    uuid[],
  p_customer_ids uuid[],
  p_on           date
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_quote  uuid;
  v_quotes uuid[] := '{}';
  v_prices bigint[];
  v_name   text;
  v_key    text;
  v_cached text;
  v_msg    text;
BEGIN
  -- KI-81 (Mason, 2026-11-17): a field-application chemical takes a quote price only from an eligible quote
  -- (_field_app_quote_eligible) sent to the grower being billed (callers pass that one grower: "own quote
  -- only"); its prices must pass the sent-price lock. Two such quotes at
  -- different prices refuse ("Stop, type the price"). Not SECURITY DEFINER: it runs inside the definer-rights
  -- field-app saves, and no API role may execute it.
  IF p_product_id IS NULL OR p_field_ids IS NULL OR p_customer_ids IS NULL THEN
    RETURN NULL;
  END IF;
  -- One answer per transaction for the same inputs: the split save asks once per grower, and a quote sent by
  -- another session between those calls must not price one grower and not the other. The first answer is
  -- recorded transaction-locally; every later call recomputes and refuses if it differs, so the record can
  -- only refuse a save, never supply a price. A reverted setting reads back as '' (no record).
  v_key := 'crx_ki81.p' || md5(concat_ws('|', p_product_id,
             array_to_string(ARRAY(SELECT DISTINCT f FROM unnest(p_field_ids) f ORDER BY 1), ','),
             array_to_string(ARRAY(SELECT DISTINCT c FROM unnest(p_customer_ids) c ORDER BY 1), ','), p_on));
  v_cached := current_setting(v_key, true);
  FOR v_quote IN
    SELECT q.id
      FROM quotes q
     WHERE q.customer_id = ANY (p_customer_ids)
       AND public._field_app_quote_eligible(q, p_product_id, p_field_ids, p_on)
     ORDER BY q.id
       FOR SHARE OF q
  LOOP
    -- Held FOR SHARE until the invoice commits, so save_quote or a send (FOR UPDATE) cannot change the
    -- prices between this check and the invoice line.
    BEGIN
      PERFORM public._assert_quote_prices_as_sent(v_quote);
    EXCEPTION WHEN raise_exception THEN
      -- KI-81 (Taha's review): on a field-app invoice staff may also type the price instead of resending.
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg LIKE 'QUOTE_RESEND_REQUIRED:%' THEN
        RAISE EXCEPTION '% Or type the price on this invoice line, then save again.', v_msg USING ERRCODE = 'P0001';
      END IF;
      RAISE;
    END;
    v_quotes := v_quotes || v_quote;
  END LOOP;

  -- KI-81 unit (Sol on #1990; Taha 2026-11-19, "stop and ask"): a quote line's price is per the unit it was saved
  -- and sent in. When either no longer matches the product's stock unit (the unit invoice lines bill in), its price
  -- can't be billed as is, so stop and name it instead of billing $X per lb as $X per oz or using the list price.
  -- The product row is held FOR SHARE until commit, so its stock unit can't change between this check and the bill.
  PERFORM 1 FROM products WHERE id = p_product_id FOR SHARE;
  SELECT format('%s is quoted per %s but is now stocked per %s, so that quote price can''t be billed.',
                COALESCE(p.product_name, 'A product'),
                COALESCE(NULLIF(CASE WHEN COALESCE(btrim(qi.unit_size, ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '') <> '' AND public._unit_matches_stock_unit(COALESCE(btrim(qi.unit_size, ' ' || chr(9) || chr(10) || chr(13) || chr(160)), ''), COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size))
                     THEN COALESCE(btrim(public._quote_item_sent_unit_20270128(qi.quote_id, qi.id), ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '') ELSE COALESCE(btrim(qi.unit_size, ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '') END, ''), 'an unrecorded unit'),
                COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size))
    INTO v_msg
    FROM quote_sections qs
    JOIN quote_items qi ON qi.section_id = qs.id AND qi.quote_id = qs.quote_id
    JOIN products p ON p.id = qi.product_id
   WHERE qs.quote_id = ANY (v_quotes)
     AND qs.field_id = ANY (p_field_ids)
     AND qi.product_id = p_product_id
     AND qi.price_per_unit >= 0
     AND (COALESCE(btrim(qi.unit_size, ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '') = ''
          OR COALESCE(btrim(public._quote_item_sent_unit_20270128(qi.quote_id, qi.id), ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '') = ''
          OR NOT public._unit_matches_stock_unit(COALESCE(btrim(qi.unit_size, ' ' || chr(9) || chr(10) || chr(13) || chr(160)), ''), COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size))
          OR NOT public._unit_matches_stock_unit(COALESCE(btrim(public._quote_item_sent_unit_20270128(qi.quote_id, qi.id), ' ' || chr(9) || chr(10) || chr(13) || chr(160)), ''), COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)))
   ORDER BY qi.id
   LIMIT 1;
  IF v_msg IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_RESEND_REQUIRED: % Or type the price on this invoice line, then save again.', v_msg
      USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(DISTINCT ROUND(qi.price_per_unit * 100)::bigint)
    INTO v_prices
    FROM quote_sections qs
    JOIN quote_items qi ON qi.section_id = qs.id AND qi.quote_id = qs.quote_id
   WHERE qs.quote_id = ANY (v_quotes)
     AND qs.field_id = ANY (p_field_ids)
     AND qi.product_id = p_product_id
     AND qi.price_per_unit >= 0;
  IF cardinality(v_prices) > 1 THEN
    SELECT product_name INTO v_name FROM products WHERE id = p_product_id;
    RAISE EXCEPTION 'FIELD_APP_QUOTE_PRICE_CONFLICT: % is quoted at more than one price for these fields. Type the agreed price on that line, then save again.',
      COALESCE(v_name, 'A product')
      USING ERRCODE = 'P0001';
  END IF;
  IF v_cached LIKE 'v:%' THEN
    IF v_cached IS DISTINCT FROM 'v:' || COALESCE(v_prices[1]::text, '') THEN
      SELECT product_name INTO v_name FROM products WHERE id = p_product_id;
      RAISE EXCEPTION 'FIELD_APP_QUOTE_PRICE_CHANGED: A quote for % changed while this invoice was saving. Save again.',
        COALESCE(v_name, 'a product')
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    PERFORM set_config(v_key, 'v:' || COALESCE(v_prices[1]::text, ''), true);
  END IF;
  RETURN v_prices[1];
END;
$fn$;

CREATE OR REPLACE FUNCTION public.create_invoice_from_blend_ticket(p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text, p_below_cost_reason text DEFAULT NULL::text, p_approved_zero_lines jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor               uuid := auth.uid();
  v_unit_msg            text;
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
  v_app_date            date;     -- KI-81: the application date the job quote must be valid on
  v_own_prices          jsonb := '{}'::jsonb;  -- KI-81: each other grower's own sent-quote price, "grower|product"
  v_own_row             record;
  v_own_cents           bigint;
  v_own_msg             text;
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
    -- KI-81: the job's quote row before the job row, the order save_quote takes them (quote, then
    -- anything that references the job), so this invoice and a quote save cannot deadlock.
    PERFORM 1 FROM quotes q
     WHERE q.id = (SELECT j.quote_id FROM jobs j WHERE j.id = v_ticket.job_id)
       FOR UPDATE OF q;
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
  -- KI-81: the application date is the ticket's date, else the job's date, else today (Chicago).
  v_app_date := COALESCE(v_ticket.ticket_date::date,
                         (SELECT j.job_date FROM jobs j WHERE j.id = v_ticket.job_id)::date,
                         (now() AT TIME ZONE 'America/Chicago')::date);
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
          AND q.id = (SELECT j.quote_id FROM jobs j WHERE j.id = v_ticket.job_id)
          -- KI-81 (Mason, 2026-11-18 "Yes, same rules"): as the field-app paths, the quote must have been
          -- sent (a version exists; not a draft, declined or cancelled quote), written on or before the
          -- application date and not expired by it. Checked after the quote row lock above.
          AND q.status IN ('sent', 'revised', 'accepted', 'expired', 'closed_by_application', 'closed_short')
          AND EXISTS (SELECT 1 FROM quote_versions v WHERE v.quote_id = q.id)
          AND (q.created_at AT TIME ZONE 'America/Chicago')::date <= v_app_date
          AND (q.expires_at IS NULL OR q.expires_at >= v_app_date)) THEN
    v_quote_section_id := NULL;
  END IF;
  -- KI-81 (Taha's re-review, 2026-11-18): the job's quote prices only its owner's per-unit share. When the
  -- owner has none on this ticket, or the quote has no usable price for any product on it (Luna r12), the quote
  -- prices nothing, so it is not held to the sent-price lock (its row lock above stays): an invoice is never
  -- refused because a quote that prices none of it needs a resend.
  IF v_quote_section_id IS NOT NULL AND (NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
        WHERE (r.value->>'price_override_cents') IS NULL
          AND (r.value->>'customer_id')::uuid = v_ticket.customer_id
          AND (r.value->>'share_acres')::numeric > 0)
     OR NOT EXISTS (
       SELECT 1 FROM quote_items qi
         JOIN blend_ticket_products btp ON btp.product_id = qi.product_id
        WHERE qi.section_id = v_quote_section_id
          AND btp.blend_ticket_id = p_blend_ticket_id
          AND COALESCE(btp.rate_per_acre, 0) > 0
          AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric
          AND qi.price_per_unit = ROUND(qi.price_per_unit, 2))) THEN
    v_quote_section_id := NULL;
  END IF;
  -- 20261021070000: hold the quote prices still until this invoice commits, so the $0 check
  -- below and the billing loop read the same prices (an approval covers only what it showed).
  -- KI-81 (Mason, 2026-11-17): the job's quote row first (save_quote's lock order), then the
  -- sent-price lock: every price on it must be one the customer was sent, or a change save_quote
  -- recorded since the send, before any price is read or an invoice number drawn.
  IF v_quote_section_id IS NOT NULL THEN
    PERFORM 1 FROM quotes q
     WHERE q.id = (SELECT qs.quote_id FROM quote_sections qs WHERE qs.id = v_quote_section_id)
       FOR UPDATE OF q;
    PERFORM public._assert_quote_prices_as_sent(
      (SELECT qs.quote_id FROM quote_sections qs WHERE qs.id = v_quote_section_id));
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

  -- KI-81 (Mason, 2026-11-18, "Yes, use B's quote" and "Yes, price the owner from their own quote"): a grower who does not own the job's
  -- quote, and the owner for a product the job's quote does not price, is priced from their OWN quote, as the
  -- field-application invoices are (_field_app_sent_quote_price_cents: a quote sent
  -- to that grower for a ticket field where they have a per-unit share, written on or before the application date, not expired
  -- by it, its prices as sent, one price), else their list price. Worked out here, before any price check
  -- or invoice number, for each such grower with a per-unit share and each product with a rate; the checks
  -- and the billing loop below read this map. The helper holds those quotes FOR SHARE until commit.
  FOR v_own_row IN
    SELECT DISTINCT (r.value->>'customer_id')::uuid AS customer_id, btp.product_id
      FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
     CROSS JOIN blend_ticket_products btp
     WHERE btp.blend_ticket_id = p_blend_ticket_id
       AND btp.product_id IS NOT NULL
       AND COALESCE(btp.rate_per_acre, 0) > 0
       AND (r.value->>'price_override_cents') IS NULL
       AND (r.value->>'share_acres')::numeric > 0
       AND ((r.value->>'customer_id')::uuid IS DISTINCT FROM v_ticket.customer_id
            -- the owner only where the job's quote gives no usable price (a valid pick needs one too)
            OR v_quote_section_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM quote_items qi
                            WHERE qi.section_id = v_quote_section_id
                              AND qi.product_id = btp.product_id
                              AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric
                              AND qi.price_per_unit = ROUND(qi.price_per_unit, 2)))
     ORDER BY 1, 2
  LOOP
    BEGIN
      v_own_cents := public._field_app_sent_quote_price_cents(
        v_own_row.product_id,
        -- only the fields where this grower has a per-unit share, as the split save passes each member's fields
        ARRAY(SELECT DISTINCT (r.value->>'field_id')::uuid
                FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
               WHERE (r.value->>'customer_id')::uuid = v_own_row.customer_id
                 AND (r.value->>'price_override_cents') IS NULL
                 AND (r.value->>'share_acres')::numeric > 0
               ORDER BY 1),
        ARRAY[v_own_row.customer_id], v_app_date);
    EXCEPTION WHEN raise_exception THEN
      -- A blend ticket has no per-grower typed price, so the grower's quote is fixed or resent instead.
      GET STACKED DIAGNOSTICS v_own_msg = MESSAGE_TEXT;
      IF v_own_msg LIKE 'QUOTE_RESEND_REQUIRED:%' OR v_own_msg LIKE 'FIELD_APP_QUOTE_PRICE_CONFLICT:%' THEN
        -- Taha's re-review: name the grower, so the office knows whose quote to fix.
        RAISE EXCEPTION '%', regexp_replace(v_own_msg,
          ' (Or type the price on this invoice line|Type the agreed price on that line), then save again[.]$', '')
          || ' Fix or resend the quote for '
          || COALESCE((SELECT c.farm_name FROM customers c WHERE c.id = v_own_row.customer_id), 'that grower')
          || ', then create this invoice again.' USING ERRCODE = 'P0001';
      END IF;
      RAISE;
    END;
    IF v_own_cents IS NOT NULL THEN
      v_own_prices := v_own_prices || jsonb_build_object(v_own_row.customer_id::text || '|' || v_own_row.product_id::text, v_own_cents);
    END IF;
  END LOOP;

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
                    AND (r.value->>'customer_id')::uuid = v_ticket.customer_id  -- KI-81: own quote only
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
  -- KI-81 unit (Sol on #1990; Taha 2026-11-19, "stop and ask"): the job's quote prices the owner only while its
  -- line is in the product's stock unit (live and as sent). A line in another unit stops the invoice before any
  -- number is drawn; a blend ticket has no typed price, so the quote is fixed or resent. It runs after the product
  -- rows are held FOR SHARE (above) and after the price choice, so where the quote lists a product more than once,
  -- staff can pick the line in the right unit: a valid stored pick carried by a matching-unit line clears that
  -- product (Luna r1).
  IF v_quote_section_id IS NOT NULL THEN
    SELECT format('%s is quoted per %s but is now stocked per %s, so that quote price can''t be billed.',
                  COALESCE(p.product_name, 'A product'),
                  COALESCE(NULLIF(CASE WHEN COALESCE(btrim(qi.unit_size, ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '') <> '' AND public._unit_matches_stock_unit(COALESCE(btrim(qi.unit_size, ' ' || chr(9) || chr(10) || chr(13) || chr(160)), ''), COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size))
                     THEN COALESCE(btrim(public._quote_item_sent_unit_20270128(qi.quote_id, qi.id), ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '') ELSE COALESCE(btrim(qi.unit_size, ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '') END, ''), 'an unrecorded unit'),
                  COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size))
      INTO v_unit_msg
      FROM blend_ticket_products btp
      JOIN quote_items qi ON qi.section_id = v_quote_section_id AND qi.product_id = btp.product_id
      JOIN products p ON p.id = qi.product_id
     WHERE btp.blend_ticket_id = p_blend_ticket_id
       AND COALESCE(btp.rate_per_acre, 0) > 0
       AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric
       AND qi.price_per_unit = ROUND(qi.price_per_unit, 2)
       AND (COALESCE(btrim(qi.unit_size, ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '') = ''
          OR COALESCE(btrim(public._quote_item_sent_unit_20270128(qi.quote_id, qi.id), ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '') = ''
          OR NOT public._unit_matches_stock_unit(COALESCE(btrim(qi.unit_size, ' ' || chr(9) || chr(10) || chr(13) || chr(160)), ''), COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size))
          OR NOT public._unit_matches_stock_unit(COALESCE(btrim(public._quote_item_sent_unit_20270128(qi.quote_id, qi.id), ' ' || chr(9) || chr(10) || chr(13) || chr(160)), ''), COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)))
       -- Per ticket line (Luna/Sol r2): a line whose valid stored pick is a usable quote price on a matching-unit
       -- line bills that pick; every other line could bill this quote line's price, so it stops.
       AND NOT (public._blend_quote_pick_valid_20261020(
                  v_quote_section_id, v_ticket.customer_id, btp.product_id, btp.unit_price_cents)
                AND EXISTS (SELECT 1 FROM quote_items q2
                             WHERE q2.section_id = v_quote_section_id
                               AND q2.product_id = btp.product_id
                               AND q2.price_per_unit >= 0 AND q2.price_per_unit < 'Infinity'::numeric
                               AND q2.price_per_unit = ROUND(q2.price_per_unit, 2)
                               AND ROUND(q2.price_per_unit * 100)::bigint = btp.unit_price_cents
                               AND COALESCE(btrim(q2.unit_size, ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '') <> ''
                               AND COALESCE(btrim(public._quote_item_sent_unit_20270128(q2.quote_id, q2.id), ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '') <> ''
                               AND public._unit_matches_stock_unit(btrim(q2.unit_size, ' ' || chr(9) || chr(10) || chr(13) || chr(160)), COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size))
                               AND public._unit_matches_stock_unit(
                                     btrim(public._quote_item_sent_unit_20270128(q2.quote_id, q2.id), ' ' || chr(9) || chr(10) || chr(13) || chr(160)), COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size))))
     ORDER BY btp.sequence_order, btp.id, qi.id
     LIMIT 1;
    IF v_unit_msg IS NOT NULL THEN
      RAISE EXCEPTION 'QUOTE_RESEND_REQUIRED: % Fix or resend the quote for %, then create this invoice again.', v_unit_msg,
        COALESCE((SELECT c.farm_name FROM customers c WHERE c.id = v_ticket.customer_id), 'that grower')
        USING ERRCODE = 'P0001';
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
           WHERE b.blend_ticket_id = p_blend_ticket_id) btp
    CROSS JOIN LATERAL (
      SELECT DISTINCT COALESCE((c.value->>'tier')::int, 1) AS tier, (c.value->>'customer_id')::uuid AS customer_id
        FROM jsonb_array_elements(v_customers) AS c(value)
       WHERE EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
          WHERE (r.value->>'customer_id')::uuid = (c.value->>'customer_id')::uuid
            AND (r.value->>'price_override_cents') IS NULL
            AND (r.value->>'share_acres')::numeric > 0)
    ) cust
   -- KI-81 (CodeRabbit): a valid pick prices only the job quote's own grower; every other grower still needs a
   -- price here, so a missing one refuses before any invoice number is drawn.
   WHERE NOT (cust.customer_id = v_ticket.customer_id
              AND public._blend_quote_pick_valid_20261020(
                    v_quote_section_id, v_ticket.customer_id, btp.product_id, btp.unit_price_cents))
     AND NOT EXISTS (
           SELECT 1 FROM quote_items qi
            WHERE v_quote_section_id IS NOT NULL
              AND cust.customer_id = v_ticket.customer_id  -- KI-81: another grower pays the list price
              AND qi.section_id = v_quote_section_id
              AND qi.product_id = btp.product_id
              AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2))
     AND NOT (v_own_prices ? (cust.customer_id::text || '|' || btp.product_id::text))  -- KI-81: own quote
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
                                         AND (r.value->>'customer_id')::uuid = v_ticket.customer_id  -- KI-81
                                         AND (r.value->>'share_acres')::numeric > 0), false)
                 -- KI-81: a grower's own quote (worked out above) lists it at $0
                 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
                             WHERE (r.value->>'price_override_cents') IS NULL
                               AND (r.value->>'share_acres')::numeric > 0
                               AND (v_own_prices ->> (((r.value->>'customer_id')::uuid)::text || '|' || y.product_id::text))::bigint = 0) AS quoted_zero,
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
        -- KI-81 (Mason, 2026-11-18): the job's quote prices only its owner.
        IF v_customer_id IS DISTINCT FROM v_ticket.customer_id THEN
          NULL;
        ELSIF public._blend_quote_pick_valid_20261020(
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
        -- KI-81: otherwise the grower's own quote price worked out above, else the list price below.
        IF v_unit_price IS NULL THEN
          v_unit_price := (v_own_prices ->> (v_customer_id::text || '|' || v_btp.product_id::text))::bigint;
          IF v_unit_price IS NOT NULL THEN
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


DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public._field_app_sent_quote_price_cents(uuid,uuid[],uuid[],date)', '0ef8fe3ec32a116df641eb8c6ed81ecb', false, 'v'),
        ('public.create_invoice_from_blend_ticket(uuid,uuid,text,text,jsonb)', '755c2e95af051602fb891ba03aee49ef', true, 'v')
      ) AS pin(sig, body_md5, secdef, vol)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
        OR p.prosecdef IS DISTINCT FROM pin.secdef
        OR p.provolatile::text <> pin.vol
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'KI81_UNIT_POSTFLIGHT: a re-emitted function is not the body, security mode, volatility or search_path this file installs';
  END IF;
  IF to_regprocedure('public._quote_item_sent_unit_20270128(uuid,uuid)') IS NULL
     OR (SELECT prosecdef OR provolatile <> 's' OR proowner <> 'postgres'::regrole
           FROM pg_proc WHERE oid = to_regprocedure('public._quote_item_sent_unit_20270128(uuid,uuid)'))
     OR has_function_privilege('anon', 'public._quote_item_sent_unit_20270128(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._quote_item_sent_unit_20270128(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._quote_item_sent_unit_20270128(uuid,uuid)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = to_regprocedure('public._quote_item_sent_unit_20270128(uuid,uuid)') AND a.grantee <> p.proowner) THEN
    RAISE EXCEPTION 'KI81_UNIT_POSTFLIGHT: _quote_item_sent_unit_20270128 is not the private, stable, postgres-owned helper this file installs';
  END IF;
  IF current_setting('crx.ki81u_xid', true) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'KI81_UNIT_POSTFLIGHT: the preflight did not run in this transaction; apply this file as ONE transaction';
  END IF;
  IF (SELECT string_agg(coalesce(p.proacl::text, '') || '/' || p.proowner::regrole::text, '|' ORDER BY s.n)
        FROM unnest(ARRAY['public._field_app_sent_quote_price_cents(uuid,uuid[],uuid[],date)', 'public.create_invoice_from_blend_ticket(uuid,uuid,text,text,jsonb)']) WITH ORDINALITY AS s(sig, n)
        JOIN pg_proc p ON p.oid = to_regprocedure(s.sig)) IS DISTINCT FROM current_setting('crx.ki81u_acls', true) THEN
    RAISE EXCEPTION 'KI81_UNIT_POSTFLIGHT: an owner or ACL changed across the replacement';
  END IF;
END;
$postflight$;
