-- Written 2026-11-08. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261218120000_invoice_line_sale_capture.md (REG-1 Step 2, file C of 4).
-- Re-read the live ledger before applying.
--
-- WHY: REG-1 Step 2 part C (docs/plans/2026-11-06-product-REG1-BUILD-SHEET.md 3.1, 3.3, 4.C): once the
--   seed has run, each invoice line records what was sold (its EPA number, restricted-use answer and signal
--   word) when it is saved, and posting builds the restricted-use register from that, never from the
--   product's state at posting time. A missing, unregistered or mismatched EPA number never blocks a sale
--   (Mason, 2026-11-09): the line saves and posts, gets no restricted-use record without a number, and is
--   listed on Sales to check.
--
-- WHAT:
--   - invoice_items gains sale_rup_status (yes/no/unknown; NULL = not captured), sale_signal_word,
--     sale_facts_captured_at (NULL = not captured) and sale_facts_source. No API role can write them.
--   - One BEFORE INSERT OR UPDATE trigger, zzz_capture_invoice_line_sale (sorts after every other line
--     trigger), is the single place that fills the capture. DEVIATION from the sheet (which re-issued every
--     line-writing function to call a helper): the trigger covers all of them, including any added later,
--     without re-issuing about 13 money functions. It takes the REG-1 lock in shared mode on every line
--     write and refuses a capture-column change without the invoice's pass (INVOICE_LINE_SALE_CAPTURE).
--     Before the seed it changes nothing else.
--   - _fill_invoice_line_epa re-issued (md5 pinned) to take the shared lock before it reads a product.
--   - _save_invoice_lineage_unaware_impl_20260827 re-issued (md5 pinned): kept lines carry the number they
--     were sold under and their capture; a quantity change re-captures (a Yes is never lowered); a sent
--     number that differs is ignored (the line takes its stored or its size's number). Before the seed it stores what it does today.
--   - generate_rup_sales_records re-issued (md5 pinned): before the seed, today's rule. After the seed it
--     reads only the line's capture and its sold number's registration, groups by product, number and
--     signal word, records an uncaptured line from its stored number's registration, and skips (never refuses) a line with no number.
--   - get_epa_sales_to_check() (admin, read-only): posted lines a person should check (sheet 4.C).
--   - Q7 (invoice_items half): INSERT and UPDATE stay revoked from anon and authenticated (none today);
--     the postflight proves it, including the new columns.
--
-- NOT CHANGED: posting wrappers (post_invoice, group and batch posting). DEVIATION: they are not re-issued
--   to take the shared lock first; a posting that collides with the seed or a registration change can end in
--   a deadlock error, which rolls back and is retried. Accepted: nothing half-writes. The same holds for
--   any writer that locks a product, brand or invoice row before its first line or brand write (deliveries,
--   auto-invoicing, proposal grouping): the trigger and guards take the REG-1 lock after those row locks, so
--   a registration change touching the same row can end one of them with a deadlock error. Rare (registration
--   changes are admin-only and short) and all-or-nothing.
--
-- LOCKS: ADD COLUMN and CREATE TRIGGER take a brief ACCESS EXCLUSIVE lock on invoice_items (lock_timeout 5s).
--
-- ROLLBACK (its own reviewed migration): drop the trigger and get_epa_sales_to_check, re-emit the three
--   re-issued bodies from their pinned versions, then drop the four columns.
--
-- ORDERING: after 20261218110000_epa_registration_draft_setup; before 20261218130000.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE invoice_line_sale_capture_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.invoice_line_sale_capture_tx') IS NULL THEN
    RAISE EXCEPTION 'INVOICE_LINE_SALE_CAPTURE_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.invoice_line_sale_capture_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'INVOICE_LINE_SALE_CAPTURE_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._epa_registration_ensure(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'INVOICE_LINE_SALE_CAPTURE_PREFLIGHT: apply 20261218110000_epa_registration_draft_setup first';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoice_items'
              AND column_name IN ('sale_rup_status', 'sale_signal_word', 'sale_facts_captured_at', 'sale_facts_source')) THEN
    RAISE EXCEPTION 'INVOICE_LINE_SALE_CAPTURE_PREFLIGHT: this file was already applied';
  END IF;
  IF (SELECT count(*) FROM pg_proc p
       WHERE (p.oid, md5(replace(p.prosrc, chr(13), ''))) IN (
         (to_regprocedure('public._fill_invoice_line_epa()'), 'b874d36678293c157e9d739b6db6c86f'),
         (to_regprocedure('public._save_invoice_lineage_unaware_impl_20260827(jsonb,jsonb,text)'), 'cf36f99934d4b68aa7e9d3eab0b04fb8'),
         (to_regprocedure('public.generate_rup_sales_records(uuid,text)'), '0cb155a27c654dd390a875c3ff3aa507'))
         AND p.proowner = 'postgres'::regrole AND p.prosecdef) <> 3 THEN
    RAISE EXCEPTION 'INVOICE_LINE_SALE_CAPTURE_PREFLIGHT: a re-issued function drifted from the body this file was written from';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Capture columns
-- ---------------------------------------------------------------------------------------------

ALTER TABLE public.invoice_items
  ADD COLUMN sale_rup_status text CHECK (sale_rup_status IN ('yes', 'no', 'unknown')),
  ADD COLUMN sale_signal_word text CHECK (sale_signal_word IN ('Danger', 'Warning', 'Caution')),
  ADD COLUMN sale_facts_captured_at timestamptz,
  ADD COLUMN sale_facts_source text,
  ADD CONSTRAINT invoice_items_sale_capture_whole CHECK (
    (sale_facts_captured_at IS NULL AND sale_rup_status IS NULL AND sale_signal_word IS NULL AND sale_facts_source IS NULL)
    OR (sale_facts_captured_at IS NOT NULL AND sale_rup_status IS NOT NULL AND sale_facts_source IS NOT NULL
        AND sale_facts_source ~ '^(seed-assumed:)?(registration:[0-9A-Z-]+@[1-9][0-9]*|product:[0-9a-f-]{36})$'));
-- invoice_items is column-carved (20261022101000): read grants match its other non-cost columns; no write grants.
GRANT SELECT (sale_rup_status, sale_signal_word, sale_facts_captured_at, sale_facts_source)
  ON public.invoice_items TO authenticated, anon;
GRANT REFERENCES (sale_rup_status, sale_signal_word, sale_facts_captured_at, sale_facts_source)
  ON public.invoice_items TO authenticated;
COMMENT ON COLUMN public.invoice_items.sale_rup_status IS
  'REG-1: restricted-use answer when the line was saved (yes/no/unknown). NULL = not captured (saved before the seed), never No. Set only by the database.';
COMMENT ON COLUMN public.invoice_items.sale_facts_source IS
  'REG-1: registration:<number>@<version> or product:<id>; prefix seed-assumed: on lines the seed captured.';

-- ---------------------------------------------------------------------------------------------
-- 2. The capture trigger (the one writer of the capture)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public._capture_invoice_line_sale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_capture_sent boolean;
  v_p record;
  v_reg public.epa_registrations;
  v_n text;
  v_keep_yes boolean := false;
BEGIN
  PERFORM public._epa_registration_lock(false);
  IF TG_OP = 'INSERT' THEN
    v_capture_sent := num_nonnulls(NEW.sale_rup_status, NEW.sale_signal_word, NEW.sale_facts_captured_at, NEW.sale_facts_source) > 0;
  ELSE
    v_capture_sent := (NEW.sale_rup_status, NEW.sale_signal_word, NEW.sale_facts_captured_at, NEW.sale_facts_source)
      IS DISTINCT FROM (OLD.sale_rup_status, OLD.sale_signal_word, OLD.sale_facts_captured_at, OLD.sale_facts_source);
  END IF;
  IF v_capture_sent AND NOT public._epa_registration_has_pass('invoices', NEW.invoice_id) THEN
    RAISE EXCEPTION 'INVOICE_LINE_SALE_CAPTURE: an invoice line''s sale capture is set only by the database';
  END IF;
  IF NOT public._epa_registrations_seeded() OR v_capture_sent THEN
    RETURN NEW;  -- before the seed nothing is captured; a carried capture (save_invoice, the seed) is kept
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND public._normalize_epa_registration(NEW.epa_registration) IS NOT DISTINCT FROM public._normalize_epa_registration(OLD.epa_registration) THEN
    IF NEW.quantity IS NOT DISTINCT FROM OLD.quantity THEN
      RETURN NEW;  -- price, notes and similar edits keep the capture
    END IF;
    v_keep_yes := OLD.sale_rup_status = 'yes';  -- with today's facts, but a Yes is never lowered
    NEW.epa_registration := NULL;  -- a quantity change re-captures from the product's current label
  END IF;

  IF NEW.product_id IS NULL THEN
    NEW.sale_rup_status := NULL; NEW.sale_signal_word := NULL;
    NEW.sale_facts_captured_at := NULL; NEW.sale_facts_source := NULL;
    RETURN NEW;
  END IF;
  SELECT p.id, p.epa_registration, p.is_rup, p.signal_word INTO v_p
    FROM public.products p WHERE p.id = NEW.product_id FOR SHARE;
  -- Decision (a): a line sells under its size's number, whichever writer inserted it; a numberless size's line has none.
  -- A different number sent by a screen is replaced, never refused: a missing or wrong number never blocks a sale (Mason, 2026-11-09).
  -- Only save_invoice (holding the invoice's pass) sends a number: a kept line's stored (sold) number, which it keeps.
  -- A Yes line keeps its old sold number on a quantity change (sheet 4.C), so its record names the label sold.
  v_n := CASE WHEN v_keep_yes AND public._normalize_epa_registration(OLD.epa_registration) IS NOT NULL
              THEN public._normalize_epa_registration(OLD.epa_registration)
              WHEN public._epa_registration_has_pass('invoices', NEW.invoice_id)
                   AND public._normalize_epa_registration(NEW.epa_registration) IS NOT NULL
              THEN public._normalize_epa_registration(NEW.epa_registration)
              ELSE public._normalize_epa_registration(v_p.epa_registration) END;
  NEW.epa_registration := v_n;
  IF v_n IS NOT NULL THEN
    SELECT * INTO v_reg FROM public.epa_registrations WHERE epa_registration = v_n FOR SHARE;
  END IF;
  IF v_n IS NOT NULL AND v_reg.epa_registration IS NOT NULL THEN
    NEW.sale_rup_status := v_reg.rup_status;
    NEW.sale_signal_word := v_reg.signal_word;
    NEW.sale_facts_source := 'registration:' || v_n || '@' || v_reg.registration_version;
  ELSE
    NEW.sale_rup_status := CASE WHEN v_p.is_rup THEN 'yes' ELSE public._epa_rup_default() END;
    NEW.sale_signal_word := v_p.signal_word;
    NEW.sale_facts_source := 'product:' || v_p.id::text;
  END IF;
  IF v_keep_yes THEN NEW.sale_rup_status := 'yes'; END IF;
  NEW.sale_facts_captured_at := now();
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._capture_invoice_line_sale() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._capture_invoice_line_sale() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER zzz_capture_invoice_line_sale BEFORE INSERT OR UPDATE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._capture_invoice_line_sale();

-- ---------------------------------------------------------------------------------------------
-- 3. _fill_invoice_line_epa: live body (md5 b874d366...) plus the shared lock first
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._fill_invoice_line_epa()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- REG-1: no number changes between this read and the line's commit (sheet 3.2, shared mode).
  PERFORM public._epa_registration_lock(false);
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    -- Moved to another product: keep a number the writer sent with it, else the new product's. A writer
    -- re-sending the old line's own number cannot be told from sending nothing; it gets the new product's
    -- number, which is the label that product carries (accepted, Sol 2026-11-07).
    IF NEW.epa_registration IS DISTINCT FROM OLD.epa_registration AND public._epa_norm(NEW.epa_registration) IS NOT NULL THEN
      RETURN NEW;
    END IF;
  ELSIF public._epa_norm(NEW.epa_registration) IS NOT NULL THEN
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND NOT EXISTS (SELECT 1 FROM public.invoices i
                                          WHERE i.id = NEW.invoice_id AND i.status IN ('draft', 'unposted')) THEN
    -- A posted invoice's blank line keeps falling back as before; an unrelated edit never freezes
    -- today's number onto it.
    RETURN NEW;
  END IF;
  -- A line with no number, or a line moved to another product: the product's number.
  NEW.epa_registration := (SELECT public._epa_norm(p.epa_registration) FROM public.products p
                            WHERE p.id = NEW.product_id FOR SHARE);
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._fill_invoice_line_epa() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._fill_invoice_line_epa() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. save_invoice (implementation re-issued from its live body, md5 cf36f999...; REG-1 lines marked)
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._save_invoice_lineage_unaware_impl_20260827(p_invoice jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_invoice_id uuid; v_is_new boolean := false; v_item jsonb;
  v_total_cents bigint := 0; v_qty numeric; v_unit_price bigint; v_extended bigint;
  v_cost_cents bigint; v_product record; v_order_id uuid; v_blend_id uuid; v_existing jsonb;
  v_total_cost bigint := 0;
  v_is_field boolean := false;
  v_is_fee boolean;
  v_from_scratch boolean := false;  -- Goal 3 (20261021050000)
  v_charge_type text;               -- Goal 3 (20261021050000)
  -- #13: each order-linked line of this draft, keyed by line id, before the rebuild.
  v_kept jsonb := '{}'::jsonb;
  v_kept_line jsonb;
  v_order_item_id uuid;
  -- REG-1 (20261218120000): sale capture
  v_seeded boolean;
  v_old jsonb := '{}'::jsonb;
  v_old_line jsonb;
  v_line_epa text;
  v_cap jsonb;
  v_keep_yes boolean;
  v_new_line_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save invoices';
  END IF;

  -- REG-1: no EPA number or label fact changes while this save reads them (sheet 3.2, shared mode).
  PERFORM public._epa_registration_lock(false);
  v_seeded := public._epa_registrations_seeded();

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_invoice');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  v_invoice_id := (p_invoice->>'id')::uuid;
  v_order_id := (p_invoice->>'order_id')::uuid;
  v_blend_id := (p_invoice->>'blend_ticket_id')::uuid;

  IF v_invoice_id IS NULL THEN
    -- PARKED-002 (codex-driven cycle 1 #1 MED): credit memos must come exclusively
    -- from issue_return_credit (the ONLY caller that derives the credit from a
    -- 'received' return and gates on check_period_open). save_invoice's NEW-invoice
    -- branch otherwise allows an admin/sales-rep to forge a posted credit memo by
    -- riding on the enforce_invoice_draft_on_insert credit_memo exemption. Reject
    -- BEFORE the order/blend check so the error surfaced is the intent-mismatch one.
    IF (p_invoice->>'invoice_type') = 'credit_memo' THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;
    -- Manual miscellaneous charges are the one controlled orderless invoice
    -- type. Chemical sales still require a source order/blend ticket.
    IF v_order_id IS NULL
       AND v_blend_id IS NULL
       AND COALESCE(NULLIF(p_invoice->>'invoice_type', ''), 'chemical_sale') <> 'misc_charge' THEN
      RAISE EXCEPTION 'Invoices must link to an order or blend ticket. Provide order_id or blend_ticket_id in p_invoice payload.';
    END IF;
    IF COALESCE(NULLIF(p_invoice->>'invoice_type', ''), 'chemical_sale') = 'misc_charge'
       AND COALESCE(NULLIF(p_invoice->>'status', ''), 'draft') <> 'draft' THEN
      RAISE EXCEPTION 'MISC_CHARGE_MUST_START_DRAFT: orderless miscellaneous charges must be reviewed before posting';
    END IF;
    v_is_new := true;
    INSERT INTO invoices (order_id, blend_ticket_id, customer_id, invoice_type, status, season, salesman_id,
      invoice_date, due_date, payment_terms, purchase_order_ref, header_notes, footer_notes, total_amount_cents, created_by)
    VALUES (v_order_id, v_blend_id, (p_invoice->>'customer_id')::uuid,
      COALESCE(p_invoice->>'invoice_type', 'chemical_sale'),
      COALESCE(p_invoice->>'status', 'draft'),
      -- Season follows the SAME date this row is stamped with (2026-09-04). It previously read
      -- the current-season helper, which is compute_season of the UTC current-date built-in --
      -- an INDEPENDENT clock read of the UTC calendar day. From 7 pm America/Chicago on 2026-09-30
      -- the helper returns 2027 while the line below stamps invoice_date 2026-09-30 (season 2026),
      -- and season drives customer_application_rates lookups and year-end statements.
      -- A caller-supplied season still wins; only the fallback changes. This is the INSERT path:
      -- the UPDATE path below still keeps whatever season the row already carries.
      COALESCE((p_invoice->>'season')::int,
               compute_season(COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date))),
      (p_invoice->>'salesman_id')::uuid,
      COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date),  -- fallback is the America/Chicago business date, never UTC (2026-09-03)
      (p_invoice->>'due_date')::date,
      NULLIF(btrim(COALESCE(p_invoice->>'payment_terms', '')), ''),
      p_invoice->>'purchase_order_ref',
      p_invoice->>'header_notes',
      p_invoice->>'footer_notes',
      0, v_actor) RETURNING id INTO v_invoice_id;
  ELSE
    -- An orderless miscellaneous charge must remain a miscellaneous charge.
    -- The edit payload does not carry source IDs, so enforce this against the
    -- stored invoice rather than trusting the client to keep the type locked.
    IF EXISTS (
      SELECT 1
       FROM invoices
       WHERE id = v_invoice_id
         AND invoice_type = 'misc_charge'
         AND order_id IS NULL
         AND blend_ticket_id IS NULL
         AND COALESCE(NULLIF(p_invoice->>'invoice_type', ''), invoice_type) <> 'misc_charge'
    ) THEN
      RAISE EXCEPTION 'ORDERLESS_INVOICE_TYPE_LOCKED: an orderless miscellaneous charge cannot be reclassified';
    END IF;

    -- PARKED-002 (Codex r3): EXPLICIT pre-UPDATE guard on the credit_memo boundary.
    -- A silent CASE-keep would swallow an attempted chemical_sale -> credit_memo flip
    -- (other payload fields still save) so the caller never sees the rejection. Fail
    -- LOUDLY with CREDIT_MEMO_VIA_SAVE_INVOICE whenever OLD or NEW crosses 'credit_memo'.
    -- Mirrors how enforce_field_application_type_lock errors on its boundary cross,
    -- except this is RPC-side because credit_memo is born 'posted' and the trigger only
    -- fires on UPDATE OF invoice_type (a posted credit_memo never gets here at all).
    -- PARKED-002 (Codex r4): drop the status filter — surface the boundary cross even
    -- when the target invoice is posted/voided/etc. The existing post-UPDATE
    -- "NOT EXISTS ... status IN ('draft','unposted')" path would otherwise silently
    -- no-op a posted-invoice credit_memo attempt; the caller deserves a clear error.
    IF EXISTS (
      SELECT 1 FROM invoices
       WHERE id = v_invoice_id
         AND (
              invoice_type = 'credit_memo'
           OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
         )
         AND invoice_type IS DISTINCT FROM COALESCE(p_invoice->>'invoice_type', invoice_type)
    ) THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;

    UPDATE invoices SET
      customer_id = CASE WHEN invoice_type = 'field_application'
                         THEN customer_id
                         ELSE COALESCE((p_invoice->>'customer_id')::uuid, customer_id) END,
      -- PARKED-002 (Codex r2): symmetric lock — credit_memo is a SEGREGATION boundary like
      -- field_application. The pre-UPDATE guard above ALREADY rejected any cross-boundary
      -- attempt with CREDIT_MEMO_VIA_SAVE_INVOICE; this CASE is the second-line invariant
      -- so a bug in the guard can't silently let the column flip. Stacks on top of DELTA-F.
      invoice_type = CASE
        WHEN invoice_type = 'field_application'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'field_application'
        THEN invoice_type
        WHEN invoice_type = 'credit_memo'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
        THEN invoice_type
        ELSE COALESCE(p_invoice->>'invoice_type', invoice_type) END,
      season = COALESCE((p_invoice->>'season')::int, season),
      salesman_id = (p_invoice->>'salesman_id')::uuid,
      invoice_date = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
      due_date = CASE WHEN p_invoice ? 'due_date' THEN (p_invoice->>'due_date')::date ELSE due_date END,
      payment_terms = CASE WHEN p_invoice ? 'payment_terms' THEN NULLIF(btrim(p_invoice->>'payment_terms'), '') ELSE payment_terms END,
      purchase_order_ref = p_invoice->>'purchase_order_ref',
      header_notes = p_invoice->>'header_notes',
      footer_notes = p_invoice->>'footer_notes',
      updated_at = now()
    WHERE id = v_invoice_id AND status IN ('draft', 'unposted');
  END IF;

  IF NOT v_is_new THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = v_invoice_id AND status IN ('draft', 'unposted')) THEN
      IF p_idempotency_key IS NOT NULL THEN
        PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'no_op', true));
      END IF;
      RETURN v_invoice_id;
    END IF;
  END IF;

  v_is_field := (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application';

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE v_share_n int; v_has_ovr boolean;
    BEGIN
      SELECT count(*), COALESCE(bool_or(price_per_acre_cents IS NOT NULL), false)
        INTO v_share_n, v_has_ovr
        FROM invoice_shares WHERE invoice_id = v_invoice_id;
      IF v_share_n > 1 OR v_has_ovr THEN
        RAISE EXCEPTION 'FIELD_INVOICE_SPLIT_LOCKED: this field invoice is split across growers (or has a fixed-price grower) — void and reissue to change it';
      END IF;
    END;
  END IF;

  -- Goal 3 (Mason, 2026-10-14 6e; 2026-10-15): an invoice made from scratch -- a misc_charge or
  -- chemical_sale invoice with no order and no delivery behind it -- carries no product lines.
  -- Each of its lines is a typed charge line (freight, application fee, service, other) with a
  -- description and an amount. Judged on the stored row after the header write above, so a new
  -- and an edited invoice are treated alike. The invoice_items trigger
  -- trg_refuse_from_scratch_invoice_product_lines enforces the product half on every other path.
  SELECT i.invoice_type IN ('misc_charge', 'chemical_sale')
         AND i.order_id IS NULL
         AND i.delivery_id IS NULL
    INTO v_from_scratch
    FROM invoices i
   WHERE i.id = v_invoice_id;
  IF v_from_scratch THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_items) AS line(item)
       WHERE NULLIF(btrim(line.item->>'product_id'), '') IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'FROM_SCRATCH_INVOICE_PRODUCT_LINE_REFUSED: an invoice with no order or delivery cannot carry product lines; sell product through an order or a quick delivery'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_items) AS line(item)
       WHERE NULLIF(btrim(line.item->>'charge_type'), '') IS NULL
    ) THEN
      RAISE EXCEPTION 'FROM_SCRATCH_INVOICE_CHARGE_TYPE_REQUIRED: every line on an invoice with no order or delivery must be a charge line with a type (freight, application fee, service, other)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- #13 (bug list): a draft is rebuilt line by line, and a product line used to take today's
  -- product cost. An order-linked line saved back as the same product and unit keeps the cost it
  -- was invoiced at and its order line, so a later cost change neither re-costs the draft nor
  -- makes the below-cost check refuse a note edit. Only a line at its saved price and no larger
  -- than it was saved keeps them, and each saved line is kept once, so a re-save cannot lower a
  -- price or raise the below-cost exposure without the check.
  SELECT COALESCE(jsonb_object_agg(ii.id::text, jsonb_build_object(
           'order_item_id', ii.order_item_id, 'product_id', ii.product_id,
           'unit_size', ii.unit_size, 'cost_cents', ii.cost_cents,
           'quantity', ii.quantity, 'unit_price_cents', ii.unit_price_cents)), '{}'::jsonb)
    INTO v_kept
    FROM invoice_items ii
   WHERE ii.invoice_id = v_invoice_id
     AND ii.order_item_id IS NOT NULL
     AND ii.quantity > 0;

  -- REG-1: after the seed, every line of this draft keyed by id, so a kept line carries the number it
  -- was sold under and its sale capture; the pass lets the capture trigger accept the carried values.
  IF v_seeded THEN
    SELECT COALESCE(jsonb_object_agg(ii.id::text, jsonb_build_object(
             'product_id', ii.product_id, 'epa_registration', ii.epa_registration, 'quantity', ii.quantity,
             'sale_rup_status', ii.sale_rup_status, 'sale_signal_word', ii.sale_signal_word,
             'sale_facts_captured_at', ii.sale_facts_captured_at, 'sale_facts_source', ii.sale_facts_source)), '{}'::jsonb)
      INTO v_old
      FROM invoice_items ii
     WHERE ii.invoice_id = v_invoice_id;
    PERFORM public._epa_registration_pass('invoices', v_invoice_id);
  END IF;

  DELETE FROM invoice_items WHERE invoice_id = v_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Invoice line item quantity must be greater than zero'; END IF;
    v_unit_price := COALESCE((v_item->>'unit_price_cents')::bigint, 0);
    v_is_fee := COALESCE((v_item->>'is_application_fee')::boolean, false) AND (v_item->>'product_id') IS NULL;
    v_extended := ROUND(v_qty * v_unit_price)::bigint;
    IF v_is_fee
       AND (v_item->>'extended_cents') IS NOT NULL
       AND ABS((v_item->>'extended_cents')::bigint - v_extended) <= CEIL(v_qty)::bigint + 1 THEN
      v_extended := (v_item->>'extended_cents')::bigint;
    END IF;
    v_cost_cents := COALESCE((v_item->>'cost_cents')::bigint, 0);
    IF (v_item->>'product_id') IS NOT NULL AND NOT v_is_field THEN
      SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
      IF FOUND AND v_product.current_cost IS NOT NULL THEN
        v_cost_cents := (v_product.current_cost * 100)::bigint;
      END IF;
    END IF;
    v_kept_line := v_kept -> lower(NULLIF(v_item->>'id', ''));
    IF v_kept_line IS NOT NULL THEN
      v_kept := v_kept - lower(v_item->>'id');  -- the first entry with a saved line's id uses it up, kept or not
    END IF;
    v_order_item_id := NULL;
    IF v_kept_line IS NOT NULL AND NOT v_is_field
       AND (v_kept_line->>'product_id')::uuid IS NOT DISTINCT FROM (v_item->>'product_id')::uuid
       AND (v_kept_line->>'unit_size') IS NOT DISTINCT FROM (v_item->>'unit_size')
       AND v_qty <= (v_kept_line->>'quantity')::numeric
       AND v_unit_price = (v_kept_line->>'unit_price_cents')::bigint THEN
      v_cost_cents := (v_kept_line->>'cost_cents')::bigint;
      v_order_item_id := (v_kept_line->>'order_item_id')::uuid;
    END IF;
    -- A charge line carries no cost (Mason, 2026-10-15); the shape CHECK refuses anything else.
    v_charge_type := NULLIF(btrim(v_item->>'charge_type'), '');
    IF v_charge_type IS NOT NULL THEN
      v_cost_cents := 0;
    END IF;
    -- REG-1 (sheet 4.C): before the seed the payload's number is stored as today and nothing is captured.
    v_line_epa := v_item->>'epa_registration';
    v_cap := NULL;
    v_keep_yes := false;
    IF v_seeded AND NULLIF(btrim(v_item->>'product_id'), '') IS NOT NULL THEN
      v_old_line := v_old -> lower(NULLIF(v_item->>'id', ''));
      IF v_old_line IS NOT NULL THEN
        v_old := v_old - lower(v_item->>'id');  -- each saved line is carried once
      END IF;
      IF v_old_line IS NOT NULL AND (v_old_line->>'product_id')::uuid = (v_item->>'product_id')::uuid THEN
        -- Kept line: keeps its stored (sold) number; a different payload number is ignored, never refused (Mason, 2026-11-09).
        IF v_qty IS DISTINCT FROM (v_old_line->>'quantity')::numeric THEN
          v_keep_yes := (v_old_line->>'sale_rup_status') = 'yes';  -- with today's facts, but a Yes is never lowered
          -- a quantity change re-captures from the product's current label (Mason, 2026-11-06); a Yes line keeps its sold number
          v_line_epa := CASE WHEN v_keep_yes THEN v_old_line->>'epa_registration' END;
        ELSE
          v_line_epa := v_old_line->>'epa_registration';
          v_cap := v_old_line;
        END IF;
      ELSE
        -- New or product-changed line: the payload's number is ignored; the capture trigger gives it the product's.
        v_line_epa := NULL;
      END IF;
    END IF;
    INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents,
      cost_cents, sort_order, rate_per_acre, acres, unit_size, notes,
      rate_unit, is_application_fee, total_applied, total_applied_unit,
      total_applied_gl_lb, gl_lb_unit, epa_registration, product_form,
      price_source, quoted_price_cents, charge_type, order_item_id,
      sale_rup_status, sale_signal_word, sale_facts_captured_at, sale_facts_source)
    VALUES (v_invoice_id, (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'description', ''),
      v_qty, v_unit_price, v_extended, v_cost_cents,
      COALESCE((v_item->>'sort_order')::int, 0),
      (v_item->>'rate_per_acre')::numeric, (v_item->>'acres')::numeric,
      v_item->>'unit_size', v_item->>'notes',
      v_item->>'rate_unit',
      v_is_fee,
      (v_item->>'total_applied')::numeric,
      v_item->>'total_applied_unit',
      (v_item->>'total_applied_gl_lb')::numeric,
      v_item->>'gl_lb_unit',
      v_line_epa,
      v_item->>'product_form',
      CASE WHEN v_item->>'price_source' IN ('quoted','tier','manual') THEN v_item->>'price_source' ELSE NULL END,
      (v_item->>'quoted_price_cents')::bigint,
      v_charge_type,
      v_order_item_id,
      v_cap->>'sale_rup_status', v_cap->>'sale_signal_word',
      (v_cap->>'sale_facts_captured_at')::timestamptz, v_cap->>'sale_facts_source')
    RETURNING id INTO v_new_line_id;
    IF v_keep_yes THEN
      -- The re-capture took today's facts; hold the Yes (the pass lets the capture trigger keep this value).
      UPDATE invoice_items SET sale_rup_status = 'yes' WHERE id = v_new_line_id AND sale_rup_status IS DISTINCT FROM 'yes';
    END IF;
    v_total_cents := v_total_cents + v_extended;
    v_total_cost := v_total_cost + CASE
      WHEN v_is_fee THEN v_cost_cents
      ELSE ROUND(v_cost_cents * v_qty)::bigint END;
  END LOOP;
  IF v_seeded THEN
    PERFORM public._epa_registration_pass_clear('invoices', v_invoice_id);
  END IF;

  UPDATE invoices SET total_amount_cents = v_total_cents,
    total_cost_cents = CASE WHEN invoice_type = 'field_application' THEN v_total_cost ELSE total_cost_cents END,
    updated_at = now()
  WHERE id = v_invoice_id AND status IN ('draft', 'unposted');

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    WITH s AS (
      SELECT id, COALESCE(amount_cents, 0) AS amount_cents,
             row_number() OVER (ORDER BY is_primary DESC, sort_order, id) AS rn,
             SUM(COALESCE(amount_cents, 0)) OVER () AS tot
      FROM invoice_shares WHERE invoice_id = v_invoice_id
    ),
    alloc AS (
      SELECT id, rn,
             CASE WHEN tot > 0 THEN ROUND(v_total_cents * amount_cents / tot)::bigint
                  WHEN rn = 1 THEN v_total_cents ELSE 0 END AS part
      FROM s
    ),
    recon AS (
      SELECT id, rn, part, v_total_cents - COALESCE(SUM(part) OVER (), 0) AS rem
      FROM alloc
    )
    UPDATE invoice_shares isr
       SET amount_cents = r.part + CASE WHEN r.rn = 1 THEN r.rem ELSE 0 END
      FROM recon r WHERE isr.id = r.id;
  END IF;

  -- U8<<< (Codex R2 P1): a job-born field_application invoice stays editable while
  -- draft/unposted, and the items rewrite above changes chemical-line profit without
  -- touching the pending job commissions minted at transfer time. Recompute them from
  -- the just-written lines — the exact mirror of update_order_items' commission-
  -- recompute-on-edit (20260617040000), including its batch-freeze guard. Scoped by
  -- commissions.invoice_id (generation-precise): order-channel rows and other
  -- generations are untouched, and a non-job invoice simply matches zero rows.
  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE
      v_u8_profit numeric;
    BEGIN
      -- Codex R6 P2: an edit while any of this generation's pending commissions sit
      -- in an active payout batch would leave that batch stale (post_commission_payment
      -- pays the OLD amount) — block, mirroring the reversal paths' guard.
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this invoice''s pending commissions are in an active payout batch — void that commission payment before editing';
      END IF;
      -- Codex R7 P1: commissions already PAID against this still-unposted invoice
      -- must also block the edit — the recompute below only touches pending rows,
      -- so an edit would silently strand the paid ledger on the old profit. Fully
      -- recoverable: void the commission payment (rows reset to pending because
      -- this invoice is live), edit, then re-batch.
      IF EXISTS (
        SELECT 1 FROM commissions c
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL AND c.status = 'paid'
      ) THEN
        RAISE EXCEPTION 'JOB_COMMISSIONS_PAID: this invoice''s commissions were already paid out — void that commission payment before editing the invoice';
      END IF;

      -- Codex R6 P2: COGS per line is cost_cents × quantity (save_invoice stores
      -- per-unit cost — the SAME math its own v_total_cost uses); transfer-minted
      -- lines carry quantity=1 with line-total cost, so ×1 is identical there.
      SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - ROUND(COALESCE(ii.cost_cents, 0) * COALESCE(ii.quantity, 1))::bigint), 0)::numeric / 100.0
        INTO v_u8_profit
      FROM invoice_items ii
      WHERE ii.invoice_id = v_invoice_id
        AND COALESCE(ii.is_application_fee, false) = false
        AND ii.product_id IS NOT NULL;

      UPDATE commissions c
         SET order_profit      = ROUND(COALESCE(v_u8_profit, 0), 2),
             commission_amount = calc.new_amount
        FROM (
          SELECT x.id,
                 -- Codex R5 P2: mirror the mint's last-row penny reconciliation so the
                 -- recomputed rows sum EXACTLY to the rounded profit (a 33.33/33.33/33.34
                 -- split of $0.02 must not round up to $0.03). Only safe when the eligible
                 -- pending rows ARE the whole generation (x.cnt = x.cnt_all, and cnt_all
                 -- counts EVERY non-deleted row of the generation regardless of status —
                 -- drift-review R6 H1: a sibling already PAID via a posted batch must
                 -- force the per-row fallback, or the last pending row would absorb the
                 -- paid recipient's entire share, not a penny). The mixed case keeps the
                 -- per-row math (update_order_items parity).
                 CASE WHEN x.rn = x.cnt AND x.cnt = x.cnt_all THEN
                     GREATEST(ROUND(COALESCE(v_u8_profit, 0), 2), 0)
                     - COALESCE(SUM(compute_commission_amount(v_u8_profit, x.split_percentage))
                         OVER (ORDER BY x.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
                   ELSE compute_commission_amount(v_u8_profit, x.split_percentage)
                 END AS new_amount
          FROM (
            SELECT c2.id, c2.split_percentage,
                   row_number() OVER (ORDER BY c2.id) AS rn,
                   count(*) OVER () AS cnt,
                   (SELECT count(*) FROM commissions c3
                     WHERE c3.invoice_id = v_invoice_id AND c3.job_id IS NOT NULL
                       AND c3.deleted_at IS NULL) AS cnt_all
            FROM commissions c2
            WHERE c2.invoice_id = v_invoice_id
              AND c2.job_id IS NOT NULL
              AND c2.status = 'pending'
              AND c2.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM commission_payment_items cpi
                JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
                WHERE cpi.commission_id = c2.id AND cp.status <> 'voided'
              )
          ) x
        ) calc
       WHERE c.id = calc.id;
    END;
  END IF;
  -- >>>U8

  IF v_is_new THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_created',
      'Invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_invoice_id) || ' created',
      v_actor, 'invoice', v_invoice_id, (p_invoice->>'customer_id')::uuid);
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'is_new', v_is_new));
  END IF;

  RETURN v_invoice_id;
END;
$function$;
ALTER FUNCTION public._save_invoice_lineage_unaware_impl_20260827(jsonb, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._save_invoice_lineage_unaware_impl_20260827(jsonb, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Posting: generate_rup_sales_records (live body, md5 0cb155a2..., plus the seeded branch)
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.generate_rup_sales_records(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer := 0;
  v_invoice record;
  v_item record;
  v_license record;
  v_compliance_status text;
  v_compliance_notes text;
  v_season integer;
  v_existing jsonb;
  v_result jsonb;
  -- REG-1
  v_seeded boolean;
  v_items refcursor;
  v_line record;
  v_rec_qty numeric;
  v_rec_total bigint;
BEGIN
  -- N2-4 role gate (matches the sole caller post_invoice): block applicators/drivers.
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to generate RUP sales records';
  END IF;

  -- REG-1: no registration changes while this posting reads the sold numbers (sheet 3.2, shared mode).
  PERFORM public._epa_registration_lock(false);
  v_seeded := public._epa_registrations_seeded();

  IF v_seeded THEN
    -- REG-1: two postings of one invoice run one after the other (sheet 4.C de-duplication).
    SELECT i.id, i.order_id, o.customer_id, c.farm_name, i.invoice_date,
           i.invoice_number, i.status, i.deleted_at
    INTO v_invoice
    FROM invoices i
    JOIN orders o ON o.id = i.order_id
    JOIN customers c ON c.id = o.customer_id
    WHERE i.id = p_invoice_id
    FOR UPDATE OF i;
  ELSE
  SELECT i.id, i.order_id, o.customer_id, c.farm_name, i.invoice_date,
         i.invoice_number, i.status, i.deleted_at
  INTO v_invoice
  FROM invoices i
  JOIN orders o ON o.id = i.order_id
  JOIN customers c ON c.id = o.customer_id
  WHERE i.id = p_invoice_id
  FOR SHARE OF i;
  END IF;

  IF v_invoice IS NULL THEN RETURN 0; END IF;

  -- KI-05: register rows record a sale, so only a posted invoice may write them.
  IF v_invoice.status IS NULL OR v_invoice.status NOT IN ('posted', 'paid', 'overdue')
     OR v_invoice.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'RUP_INVOICE_NOT_POSTED: invoice % is % and not posted; RUP sales records are written only for a posted invoice',
      v_invoice.invoice_number,
      CASE WHEN v_invoice.deleted_at IS NOT NULL THEN 'deleted' ELSE coalesce(v_invoice.status, 'without a status') END;
  END IF;

  -- Replay only after the posted check, so a key reused for an unposted invoice cannot return a cached success.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'generate_rup_sales_records');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'count')::integer;
    END IF;
  END IF;

  v_season := CASE
    WHEN EXTRACT(MONTH FROM LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date)) >= 10
    THEN EXTRACT(YEAR FROM LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date))::integer + 1
    ELSE EXTRACT(YEAR FROM LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date))::integer
  END;

  IF v_seeded THEN
    -- REG-1: a missing or unregistered number never blocks posting (Mason, 2026-11-09): the line posts, gets no record
    -- without a number, and is listed on Sales to check. Neither does a line with no capture (one posted before the seed and
    -- unposted after; a split group cannot be re-saved): it records under its stored number with that number's registration
    -- facts and is listed on Sales to check as posted_before_seed.
    -- A line needs a record when its capture or its sold number's registration says Yes (sheet 4.C).
    -- One record per unit and unit price too, so a record never merges lines sold at different prices or units.
    OPEN v_items FOR
      SELECT ii.product_id, p.product_name, sum(ii.quantity) AS quantity, ii.unit_size,
             ii.unit_price_cents, sum(ii.extended_cents)::bigint AS extended_cents,
             public._normalize_epa_registration(ii.epa_registration) AS epa_registration,
             CASE WHEN ii.sale_facts_captured_at IS NULL THEN r.signal_word ELSE ii.sale_signal_word END AS signal_word
        FROM invoice_items ii
        JOIN products p ON p.id = ii.product_id
        LEFT JOIN epa_registrations r ON r.epa_registration = public._normalize_epa_registration(ii.epa_registration)
       WHERE ii.invoice_id = p_invoice_id
         AND (ii.sale_rup_status = 'yes' OR r.rup_status = 'yes')
         AND public._normalize_epa_registration(ii.epa_registration) IS NOT NULL  -- a RUP record never has a blank number
       GROUP BY ii.product_id, p.product_name, public._normalize_epa_registration(ii.epa_registration),
                CASE WHEN ii.sale_facts_captured_at IS NULL THEN r.signal_word ELSE ii.sale_signal_word END,
                ii.unit_size, ii.unit_price_cents
       ORDER BY ii.product_id, 7, 8, 4, 5;
  ELSE
    OPEN v_items FOR
    SELECT ii.product_id, p.product_name, ii.quantity, ii.unit_size,
           ii.unit_price_cents, ii.extended_cents,
           p.epa_registration, p.signal_word
    FROM invoice_items ii
    JOIN products p ON p.id = ii.product_id
    WHERE ii.invoice_id = p_invoice_id
      AND p.is_rup = true;
  END IF;

  LOOP
    FETCH v_items INTO v_item;
    EXIT WHEN NOT FOUND;
    SELECT al.license_number, al.license_type, al.expiry_date, al.issued_date
    INTO v_license
    FROM applicator_licenses al
    WHERE al.customer_id = v_invoice.customer_id
      AND al.is_active = true
    ORDER BY ((al.issued_date IS NOT NULL AND al.issued_date <= LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date)) AND al.expiry_date >= GREATEST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date)) DESC, al.expiry_date DESC NULLS LAST
    LIMIT 1;

    IF v_license IS NULL OR v_license.license_number IS NULL THEN
      v_compliance_status := 'non_compliant';
      v_compliance_notes := 'No applicator license on file for this customer';
    ELSIF v_license.expiry_date IS NOT NULL AND v_license.expiry_date < GREATEST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date) THEN
      v_compliance_status := 'warning';
      v_compliance_notes := 'Applicator license expired on ' || v_license.expiry_date::text;
    ELSIF v_license.issued_date IS NULL THEN
      v_compliance_status := 'warning';
      v_compliance_notes := 'Applicator license issue date unknown';
    ELSIF v_license.issued_date > LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date) THEN
      v_compliance_status := 'warning';
      v_compliance_notes := 'Applicator license issued on ' || v_license.issued_date::text || ', after the sale date';
    ELSE
      v_compliance_status := 'compliant';
      v_compliance_notes := NULL;
    END IF;

    IF v_seeded THEN
      -- REG-1: one active record per invoice, product, sold number, captured signal word, unit and unit price;
      -- one that disagrees with what this posting would write is an error, never skipped.
      SELECT r.quantity, r.total_cents INTO v_rec_qty, v_rec_total FROM rup_sales_records r
       WHERE r.invoice_id = p_invoice_id AND r.product_id = v_item.product_id
         AND public._normalize_epa_registration(r.epa_registration) IS NOT DISTINCT FROM v_item.epa_registration
         AND r.signal_word IS NOT DISTINCT FROM v_item.signal_word
         AND r.unit IS NOT DISTINCT FROM v_item.unit_size
         AND r.unit_price_cents IS NOT DISTINCT FROM v_item.unit_price_cents
         AND r.voided_at IS NULL
       ORDER BY r.id LIMIT 1;
      IF FOUND THEN
        IF v_rec_qty IS DISTINCT FROM v_item.quantity OR v_rec_total IS DISTINCT FROM v_item.extended_cents THEN
          RAISE EXCEPTION 'RUP_RECORD_CONFLICT: invoice % already has a restricted-use record for % under EPA number % with a different quantity or amount',
            v_invoice.invoice_number, v_item.product_name, v_item.epa_registration;
        END IF;
        CONTINUE;
      END IF;
    -- PARKED-006: dedup ignores voided rows so a legitimate re-post can record
    -- a fresh active sale even when a prior voided row exists.
    ELSIF EXISTS (
      SELECT 1 FROM rup_sales_records
      WHERE invoice_id = p_invoice_id
        AND product_id = v_item.product_id
        AND voided_at IS NULL
    ) THEN
      CONTINUE;
    END IF;

      INSERT INTO rup_sales_records (
        invoice_id, order_id, customer_id, product_id,
        sale_date, product_name, epa_registration, quantity, unit,
        unit_price_cents, total_cents,
        buyer_name, buyer_certification_number,
        buyer_certification_type, buyer_certification_expiry,
        signal_word, compliance_status, compliance_notes,
        season, created_by
      ) VALUES (
        p_invoice_id, v_invoice.order_id, v_invoice.customer_id, v_item.product_id,
        LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date), v_item.product_name, v_item.epa_registration, v_item.quantity, v_item.unit_size,
        v_item.unit_price_cents, v_item.extended_cents,
        v_invoice.farm_name,
        v_license.license_number,
        v_license.license_type,
        v_license.expiry_date,
        v_item.signal_word, v_compliance_status, v_compliance_notes,
        v_season, auth.uid()
      );
      v_count := v_count + 1;
  END LOOP;
  CLOSE v_items;

  v_result := jsonb_build_object('count', v_count);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'generate_rup_sales_records', v_result);
  END IF;

  RETURN v_count;
END;
$function$;
ALTER FUNCTION public.generate_rup_sales_records(uuid, text) OWNER TO postgres;

-- ---------------------------------------------------------------------------------------------
-- 6. Posted sales a person should check (admin, read-only; sheet 4.C "Not reviewed at posting")
-- ---------------------------------------------------------------------------------------------

-- The one rule for "this posted line has its restricted-use record": an active record with the line's invoice,
-- product, sold number, unit and unit price (posting writes one per each), and its captured signal word when
-- it has a capture (a line posted before the seed has none). Both lists below use only this.
CREATE FUNCTION public._rup_record_covers_line(p_line public.invoice_items) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT EXISTS (SELECT 1 FROM public.rup_sales_records s
                  WHERE s.invoice_id = p_line.invoice_id AND s.product_id = p_line.product_id AND s.voided_at IS NULL
                    AND public._normalize_epa_registration(s.epa_registration)
                        IS NOT DISTINCT FROM public._normalize_epa_registration(p_line.epa_registration)
                    AND s.unit IS NOT DISTINCT FROM p_line.unit_size
                    AND s.unit_price_cents IS NOT DISTINCT FROM p_line.unit_price_cents
                    AND (p_line.sale_facts_captured_at IS NULL OR s.signal_word IS NOT DISTINCT FROM p_line.sale_signal_word));
$function$;
ALTER FUNCTION public._rup_record_covers_line(public.invoice_items) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._rup_record_covers_line(public.invoice_items) FROM PUBLIC, anon, authenticated, service_role;

-- Re-issued from 20261218100000 (same signature and grants) to use the one coverage rule above.
CREATE OR REPLACE FUNCTION public._epa_registration_unrecorded_posted_lines(p_number text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('invoice_item_id', ii.id, 'invoice_id', ii.invoice_id,
           'invoice_number', i.invoice_number, 'product_id', ii.product_id) ORDER BY ii.id), '[]'::jsonb)
    FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL
     AND public._normalize_epa_registration(ii.epa_registration) = p_number
     AND NOT public._rup_record_covers_line(ii);
$function$;

CREATE FUNCTION public.get_epa_sales_to_check() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_out jsonb;
BEGIN
  PERFORM public._product_parent_require_admin();
  IF NOT public._epa_registrations_seeded() THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_NOT_SEEDED: registrations are not switched on yet';
  END IF;
  WITH lines AS (
    SELECT ii.id AS line_id, ii.invoice_id, i.invoice_number, i.invoice_date, ii.product_id, p.product_name,
           public._normalize_epa_registration(ii.epa_registration) AS epa_registration,
           ii.quantity, ii.sale_rup_status, ii.sale_facts_source, ii.sale_facts_captured_at, r.rup_status AS registration_rup_status,
           r.epa_registration IS NULL AS no_registration,
           public._rup_record_covers_line(ii) AS has_record
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN products p ON p.id = ii.product_id
      LEFT JOIN epa_registrations r ON r.epa_registration = public._normalize_epa_registration(ii.epa_registration)
     WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'line_id', line_id, 'invoice_id', invoice_id, 'invoice_number', invoice_number, 'invoice_date', invoice_date,
           'product_id', product_id, 'product_name', product_name, 'epa_registration', epa_registration,
           'quantity', quantity, 'sale_rup_status', sale_rup_status, 'sale_facts_source', sale_facts_source,
           'registration_rup_status', registration_rup_status, 'has_record', has_record,
           'reasons', to_jsonb(array_remove(ARRAY[
             CASE WHEN (registration_rup_status = 'yes' OR sale_rup_status = 'yes') AND NOT has_record THEN 'restricted_use_to_record' END,
             CASE WHEN sale_rup_status = 'unknown' AND NOT has_record THEN 'not_reviewed_no_record' END,
             CASE WHEN sale_facts_captured_at IS NULL THEN 'posted_before_seed' END,
             CASE WHEN sale_facts_source LIKE 'seed-assumed:%' THEN 'seed_assumed' END,
             CASE WHEN epa_registration IS NULL AND sale_facts_captured_at IS NOT NULL THEN 'no_epa_number' END,
             CASE WHEN epa_registration IS NOT NULL AND no_registration AND sale_facts_captured_at IS NOT NULL THEN 'no_registration' END], NULL)))
           ORDER BY invoice_date, invoice_number, line_id), '[]'::jsonb)
    INTO v_out
    FROM lines
   WHERE ((registration_rup_status = 'yes' OR sale_rup_status = 'yes') AND NOT has_record)
      OR (sale_rup_status = 'unknown' AND NOT has_record)
      OR sale_facts_captured_at IS NULL
      OR sale_facts_source LIKE 'seed-assumed:%'
      OR (sale_facts_captured_at IS NOT NULL AND (epa_registration IS NULL OR no_registration));
  RETURN v_out;
END;
$function$;
ALTER FUNCTION public.get_epa_sales_to_check() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_epa_sales_to_check() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_epa_sales_to_check() TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 7. Q7 (invoice_items half): no direct line writes from the app roles
-- ---------------------------------------------------------------------------------------------

REVOKE INSERT, UPDATE ON TABLE public.invoice_items FROM anon, authenticated;

DO $postflight$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, 'public.invoice_items', 'INSERT')
       OR has_table_privilege(v_role, 'public.invoice_items', 'UPDATE')
       OR has_any_column_privilege(v_role, 'public.invoice_items', 'INSERT')
       OR has_any_column_privilege(v_role, 'public.invoice_items', 'UPDATE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_INVOICE_LINE_SALE_CAPTURE: % can write invoice_items', v_role;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._capture_invoice_line_sale()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fill_invoice_line_epa()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._save_invoice_lineage_unaware_impl_20260827(jsonb,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._rup_record_covers_line(public.invoice_items)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._epa_registration_unrecorded_posted_lines(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_epa_sales_to_check()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_epa_sales_to_check()', 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.invoice_items'::regclass
                     AND tgname = 'zzz_capture_invoice_line_sale' AND tgenabled = 'O')
     OR (SELECT max(tgname) FROM pg_trigger WHERE tgrelid = 'public.invoice_items'::regclass AND NOT tgisinternal)
        <> 'zzz_capture_invoice_line_sale' THEN
    RAISE EXCEPTION 'POSTFLIGHT_INVOICE_LINE_SALE_CAPTURE_WRONG';
  END IF;
END;
$postflight$;
