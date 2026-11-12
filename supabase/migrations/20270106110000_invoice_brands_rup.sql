-- idempotency-body-check: exempt
-- (review_typed_brand, re-issued here unchanged apart from its delivery-status filter, requires p_idempotency_key and
--  checks it before any write with PAR-1's _product_parent_replay(key, scope, fingerprint), then saves its receipt
--  with save_idempotency, as in 20270104120000. generate_rup_sales_records keeps its check_idempotency /
--  save_idempotency pair. The hook only recognises check_idempotency.)
--
-- Written 2026-11-11. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270106110000_invoice_brands_rup.md. Re-read the live ledger before applying.
--
-- sql-safety: exempt-registry — rup_sales_records.invoice_item_id is live (#1746, 20261231210000) and in this
-- worktree's refreshed registry; the main checkout's 2026-11-10 registry the hook reads predates it.
--
-- WHY (Brand PR B, part B-1b; build sheet docs/plans/2026-11-08-product-BRAND-PRB-BUILD-SHEET.md, sections 14 and
--   16): the brands that went off the truck (B-1a) are carried onto invoice lines as a frozen snapshot
--   (invoice_items.brand_lines), and posting writes one restricted-use record per brand on a line (Mason 2026-11-10,
--   Q9) under that brand's own EPA number (Q8). Brands never refuse posting, saving, completion or correction (Q5);
--   a line whose brands do not reconcile gets no record and is listed on Sales to check (Q6).
--
-- WHAT:
--   1. invoice_items.brand_lines: written only by trg_fill_invoice_line_zbrands (BEFORE INSERT OR UPDATE) from the
--      delivery picks the line covers, on draft and unposted invoices; frozen otherwise. The line's EPA number is the
--      brand's when every entry is one brand with a number, else the product's.
--   2. Re-copy: a deferred constraint trigger on delivery_brand_events re-copies open drafts at the writer's commit,
--      after its picks are final; each invoice in its own sub-transaction, so a failure leaves that draft as it was.
--   3. invoice_line_brand_rup_captures (private) and the re-issued _capture_invoice_line_rup: one capture per brand.
--   4. rup_sales_records.brand_name / brand_key; one active record per (line, brand key); a line never holds a
--      per-line and a brand record at once. generate_rup_sales_records re-issued (md5 pinned): NULL or [] lines keep
--      #1746's per-line path; branded lines get one record per brand captured Yes with a positive allocated share,
--      none when the line has a brand problem.
--   5. get_epa_sales_to_check and _epa_registration_unrecorded_posted_lines re-issued per brand; get_rup_sales_register
--      returns brand_name (DROP and CREATE, same grants).
--   6. get_typed_brands_for_review leaves out picks on voided or cancelled deliveries; review_typed_brand refuses them.
--   7. Backfill: open drafts re-copied once.
--   8. _complete_delivery_aggregate_impl re-issued (md5 pinned, B-1a's body plus one marked setting): while the body
--      runs, the delivery being completed is named in crx.brand_completing_delivery, and _invoice_line_brand_lines
--      reads it as B-1a's completion rule will leave it. Lines written during a completion (Bill Split and landlord
--      split drafts, which the re-copy never touches) therefore hold the final brands.
--   9. Posting writes no brand record for a line whose stored brands no longer match its picks (a split draft
--      corrected after it was made, or a draft the re-copy skipped because another writer held it); the line is
--      listed as brand_lines_stale on Sales to check instead.
--
-- ACCEPTED EFFECT: posting checks the invoice it was reviewed against (_invoice_post_content_version hashes whole
--   lines). Adding brand_lines, the backfill, and a later re-copy each change that hash, so a draft open on a screen
--   at that moment is refused once as changed since loaded; reloading shows the current brands and posts (as the
--   price_tier_at_sale column did, 20261027060000).
-- ACCEPTED EFFECT: a re-copy never waits (FOR SHARE NOWAIT). A draft another writer holds at that moment keeps its
--   old brands until its next save; if it is posted first, posting writes no brand record for the line and lists it
--   as brand_lines_stale. The same holds for a split draft corrected after it was made: it is never re-copied.
--
-- NOT CHANGED: every amount, quantity, price, cost and stock column and function; invoice saving and posting
--   wrappers; B-1a's writers.
--
-- ROLLBACK (its own reviewed migration, a forward repair): drop the two triggers, restore the re-issued bodies from
--   their md5 pins below. The new columns, the capture table and its rows, and the (line, brand key) index STAY: the
--   old generator never writes brand records, and the index still allows one per-line record per line.
--   get_rup_sales_register's old body needs DROP, CREATE and its grants again (authenticated, service_role): its
--   returned columns change.
--
-- ORDERING: after 20270104120000 (B-1a) and the REG-1 seed run; the preflight refuses before the seed.
--
-- caller-analysis: get_rup_sales_register :: Compliance.tsx calls it by name with the same named parameters; the re-created function keeps the name, the six parameters and their defaults, the admin gate and the grants (authenticated, service_role), and only appends brand_name to the returned columns
-- caller-analysis: get_epa_sales_to_check :: EpaRegistrationSetup.tsx (through epaRegistrationSeed.ts) reads it; same signature and grant; rows gain brand_key, brand_name, allocated_quantity and new reasons, which this PR's screen change labels
-- caller-analysis: generate_rup_sales_records :: called only by _post_invoice_impl_20260714 and _post_deleted_delivery_recovery_invoice_20260719; same signature, owner, mode and grants
-- caller-analysis: _capture_invoice_line_rup :: trigger function of trg_zz_capture_invoice_line_rup only
-- caller-analysis: _epa_registration_unrecorded_posted_lines :: called only by set_epa_registration; same signature, private
-- caller-analysis: _guard_rup_sales_record_line :: trigger function of trg_rup_sales_record_line only
-- caller-analysis: _complete_delivery_aggregate_impl :: called only by B-1a's complete_delivery / start_and_complete_delivery bodies; same signature, owner, mode and grants (none for app roles); only sets and clears a transaction-local setting around the unchanged body call
-- caller-analysis: review_typed_brand, get_typed_brands_for_review :: same signatures and grants (authenticated); no caller in the app yet (B-2)
-- caller-analysis: all-functions :: every new _-prefixed helper is internal (EXECUTE revoked from PUBLIC, anon, authenticated, service_role)

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE invoice_brands_rup_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_pin record;
BEGIN
  -- Two separate checks: one OR would plan the subquery before the table is known to exist.
  IF to_regclass('pg_temp.invoice_brands_rup_tx') IS NULL THEN
    RAISE EXCEPTION 'INVOICE_BRANDS_RUP_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.invoice_brands_rup_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'INVOICE_BRANDS_RUP_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regclass('public.delivery_item_brands') IS NULL OR to_regclass('public.delivery_brand_events') IS NULL THEN
    RAISE EXCEPTION 'INVOICE_BRANDS_RUP_PREFLIGHT: apply 20270104120000_delivery_brands first';
  END IF;
  IF to_regclass('public.invoice_line_brand_rup_captures') IS NOT NULL THEN
    RAISE EXCEPTION 'INVOICE_BRANDS_RUP_PREFLIGHT: this file was already applied';
  END IF;
  -- Every function this file re-issues, and the REG-1 helpers it relies on, as they were when it was written.
  FOR v_pin IN SELECT * FROM (VALUES
      ('public._capture_invoice_line_rup()', 'f24b6436759c3cd662fbc98f6a70f33e'),
      ('public._epa_registration_unrecorded_posted_lines(text)', 'baecb3aee6f0d512fcd189e175b269c5'),
      ('public._guard_rup_sales_record_line()', '2ba59ac62f6934a757587f99486ca02e'),
      ('public._invoice_line_rup_facts(uuid,text)', 'bc95d187f776fcc8899c6ffe168da3f0'),
      ('public.generate_rup_sales_records(uuid,text)', 'e39591e18d10d8fe3a03769410251973'),
      ('public.get_epa_sales_to_check()', 'f75377b9fe8900394b54a509f67bf1dd'),
      ('public.get_rup_sales_register(date,date,uuid,uuid,text,boolean)', '01a56f57845ccc8fcc0bc91cfd114045'),
      ('public.get_typed_brands_for_review()', '97d8af013659a7c93f5d4ecbe11f7446'),
      ('public.review_typed_brand(uuid,text,uuid,text,text)', '654a80598fef179ed430edf0ac57ee81'),
      ('public._epa_registrations_seeded()', 'bfda524a07d41a733f891541f5c3c68f'),
      ('public._epa_registration_lock(boolean)', '0470f94473b8d22cc7ac19f5e880ca70'),
      ('public._split_invoice_content_claim(uuid)', 'ab4bb76a486afa09d35715f6b101231b'),
      ('public._complete_delivery_aggregate_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)',
       'fb5708a0eba6a6c9997b04b8958d9549'),
      ('public._delivery_brands_on_complete(uuid,boolean)', 'e0c40003cb79e8570a6c2f69982abf0f')) v(sig, body_md5)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig)
                      AND md5(replace(p.prosrc, chr(13), '')) = v_pin.body_md5 AND p.proowner = 'postgres'::regrole) THEN
      RAISE EXCEPTION 'INVOICE_BRANDS_RUP_PREFLIGHT: % drifted from the body this file was written from', v_pin.sig;
    END IF;
  END LOOP;
  -- The capture and the per-brand lists need the REG-1 registrations (build sheet 14.2).
  IF NOT public._epa_registrations_seeded() THEN
    RAISE EXCEPTION 'INVOICE_BRANDS_RUP_PREFLIGHT: run the REG-1 registration seed first';
  END IF;
  -- The new fill trigger must sort after the number fill and before the posted-line guard.
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.invoice_items'::regclass AND NOT t.tgisinternal
         AND t.tgname IN ('trg_fill_invoice_line_epa', 'trg_refuse_posted_invoice_child_write') AND (t.tgtype & 2) = 2) <> 2
     OR to_regclass('public.rup_sales_records_one_active_per_line') IS NULL THEN
    RAISE EXCEPTION 'INVOICE_BRANDS_RUP_PREFLIGHT: an invoice_items trigger or the per-line record index is not as expected';
  END IF;
  -- invoices first, then lines (the order posting and saves take them); then the brand tables, so no event slips in
  -- between the re-copy trigger's creation and the backfill.
  LOCK TABLE public.invoices IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.invoice_items IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.rup_sales_records IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.delivery_item_brands IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.delivery_brand_events IN SHARE ROW EXCLUSIVE MODE;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Columns and the record index
-- ---------------------------------------------------------------------------------------------

ALTER TABLE public.invoice_items ADD COLUMN brand_lines jsonb;
COMMENT ON COLUMN public.invoice_items.brand_lines IS
  'Brand PR B-1b (20270106110000): the delivered brands this line covers, frozen once the invoice leaves draft/unposted. NULL = no brand information; [] = a brand list but no pick; else one entry per pick (or per unpicked covered delivery line, brand_key ''n:''): brand_key, brand_name, epa_registration, manufacturer, signal_word, quantity, line_delivered, typed, pick_id, delivery_id, delivery_item_id, completed_at. Written only by trg_fill_invoice_line_zbrands.';
-- invoice_items is column-carved (20261022101000): readable like the line's other non-cost columns, as
-- price_tier_at_sale was (20261027060000); no INSERT or UPDATE grant, since only the trigger writes it.
GRANT SELECT (brand_lines) ON public.invoice_items TO authenticated;
GRANT REFERENCES (brand_lines) ON public.invoice_items TO authenticated;
GRANT SELECT (brand_lines) ON public.invoice_items TO anon;

-- The split-invoice provenance claim compares every line column except these; a new column must be left out in
-- the same file or every stored claim stops matching and split groups can no longer post (as price_tier_at_sale,
-- 20261027060000). Re-issued from that file (md5 pinned above) with brand_lines added; owner and grants kept.
CREATE OR REPLACE FUNCTION public._split_invoice_content_claim(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'contract_version', 'split_invoice_provenance_v1',
    'invoice', jsonb_build_object(
      'invoice_id', i.id,
      'invoice_number', i.invoice_number,
      'order_id', i.order_id,
      'customer_id', i.customer_id,
      'invoice_type', i.invoice_type,
      'season', i.season,
      'salesman_id', i.salesman_id,
      'created_by', i.created_by,
      'total_amount_cents', i.total_amount_cents,
      'invoice_date', i.invoice_date,
      'invoice_group_id', i.invoice_group_id,
      'header_notes', i.header_notes,
      'pricing_pending', i.pricing_pending
    ),
    'items', COALESCE((
      SELECT jsonb_agg(
               to_jsonb(ii) - ARRAY['created_at', 'updated_at', 'price_tier_at_sale', 'brand_lines']::text[]
               ORDER BY ii.sort_order, ii.id
             )
        FROM public.invoice_items ii
       WHERE ii.invoice_id = i.id
    ), '[]'::jsonb)
  )
  FROM public.invoices i
  WHERE i.id = p_invoice_id;
$function$;

ALTER TABLE public.rup_sales_records ADD COLUMN brand_name text;
ALTER TABLE public.rup_sales_records ADD COLUMN brand_key text;
ALTER TABLE public.rup_sales_records
  ADD CONSTRAINT rup_sales_records_brand_name_has_key CHECK (brand_name IS NULL OR brand_key IS NOT NULL);
COMMENT ON COLUMN public.rup_sales_records.brand_key IS
  'Brand PR B-1b: NULL for a per-line record (#1746); else the brand of the line this record is for (''b:<name>|<number>'' or ''n:'' for no brand recorded).';
DROP INDEX public.rup_sales_records_one_active_per_line;
CREATE UNIQUE INDEX rup_sales_records_one_active_per_line_brand
  ON public.rup_sales_records (invoice_item_id, COALESCE(brand_key, '')) WHERE voided_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- 2. Reading the brands a line covers (section 16.2.1)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public._invoice_brand_key(p_brand_name text, p_epa_registration text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT CASE WHEN p_brand_name IS NULL THEN 'n:'
              ELSE 'b:' || lower(btrim(p_brand_name)) || '|' || COALESCE(public._normalize_epa_registration(p_epa_registration), '')
         END;
$function$;

-- One read of a line's covered picks. Used to write the snapshot, to detect a stale one, and by posting to refuse a
-- stale one a record. A delivery being completed in this transaction (crx.brand_completing_delivery, set only by
-- _complete_delivery_aggregate_impl around the body, before B-1a's completion rule runs) is read as that rule will
-- leave it: had_list from the current brand list, and a single pick above the delivered amount trimmed to it
-- (20270104120000 _delivery_brands_on_complete steps 1 and 2; step 5 changes no field read here).
CREATE FUNCTION public._invoice_line_brand_lines(p_invoice_id uuid, p_order_item_id uuid, p_product_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  WITH inv AS (
    SELECT i.delivery_id FROM public.invoices i
     WHERE i.id = p_invoice_id AND i.invoice_type <> 'credit_memo'
       AND p_order_item_id IS NOT NULL AND p_product_id IS NOT NULL
  ), lines AS (
    SELECT di.id AS delivery_item_id, di.product_id, d.id AS delivery_id, d.completed_at,
           COALESCE(di.quantity_delivered, di.quantity) AS raw_delivered,
           d.id::text = current_setting('crx.brand_completing_delivery', true)
             AND NOT EXISTS (SELECT 1 FROM public.delivery_brand_events e
                              WHERE e.delivery_id = d.id AND e.event_type = 'completed') AS completing
      FROM inv
      JOIN public.delivery_items di ON di.order_item_id = p_order_item_id AND di.product_id = p_product_id
      JOIN public.deliveries d ON d.id = di.delivery_id
     WHERE d.status = 'completed' AND d.deleted_at IS NULL
       AND (inv.delivery_id IS NULL OR d.id = inv.delivery_id)
       AND round(COALESCE(di.quantity_delivered, di.quantity), 4) > 0
  ), covered AS (
    SELECT x.delivery_item_id, x.delivery_id, x.completed_at, x.raw_delivered, x.completing,
           round(x.raw_delivered, 4) AS line_delivered,
           CASE WHEN x.completing THEN EXISTS (SELECT 1 FROM public._delivery_line_brand_list(x.product_id))
                ELSE EXISTS (SELECT 1 FROM public.delivery_brand_events e, jsonb_array_elements(e.details -> 'lines') l
                              WHERE e.delivery_id = x.delivery_id AND e.event_type = 'completed'
                                AND l.value ->> 'delivery_item_id' = x.delivery_item_id::text
                                AND COALESCE((l.value ->> 'brand_list_size')::integer, 0) > 0) END AS had_list,
           (SELECT count(*) FROM public.delivery_item_brands b
             WHERE b.delivery_item_id = x.delivery_item_id AND b.superseded_at IS NULL) AS pick_count
      FROM lines x
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM covered WHERE had_list OR pick_count > 0) THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM covered WHERE pick_count > 0) THEN '[]'::jsonb
    ELSE (SELECT jsonb_agg(jsonb_build_object(
            'brand_key', public._invoice_brand_key(b.brand_name, b.epa_registration),
            'brand_name', b.brand_name, 'epa_registration', b.epa_registration, 'manufacturer', b.manufacturer,
            'signal_word', b.signal_word,
            'quantity', CASE WHEN c.completing AND c.pick_count = 1 AND b.quantity > c.raw_delivered
                                  AND c.raw_delivered = round(c.raw_delivered, 4)
                             THEN c.raw_delivered ELSE COALESCE(b.quantity, c.line_delivered) END,
            'line_delivered', c.line_delivered, 'typed', COALESCE(b.source = 'typed', false), 'pick_id', b.id,
            'delivery_id', c.delivery_id, 'delivery_item_id', c.delivery_item_id, 'completed_at', c.completed_at)
            ORDER BY c.completed_at, c.delivery_id, c.delivery_item_id, lower(b.brand_name),
                     COALESCE(public._normalize_epa_registration(b.epa_registration), ''), b.id)
            FROM covered c
            LEFT JOIN public.delivery_item_brands b ON b.delivery_item_id = c.delivery_item_id AND b.superseded_at IS NULL)
  END;
$function$;

-- One row per brand key of a snapshot, with the first entry's facts (entries are in a total order). ticked: the brand
-- row of any of the key's picks is ticked restricted use now (Mason, 2026-11-11, "any tick counts", after Sol r4); read
-- live, never stored in the snapshot, so a tick change never makes a draft's brands stale.
CREATE FUNCTION public._invoice_line_brand_keys(p_brand_lines jsonb)
RETURNS TABLE(brand_key text, brand_name text, epa_registration text, signal_word text, first_index integer, ticked boolean)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  WITH e AS (
    SELECT x.value AS v, x.ordinality::integer AS i
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_brand_lines) = 'array' THEN p_brand_lines ELSE '[]'::jsonb END)
           WITH ORDINALITY x
  )
  SELECT DISTINCT ON (e.v ->> 'brand_key')
         e.v ->> 'brand_key', e.v ->> 'brand_name', e.v ->> 'epa_registration', e.v ->> 'signal_word', e.i,
         EXISTS (SELECT 1 FROM e e2
                   JOIN public.delivery_item_brands d ON d.id = (e2.v ->> 'pick_id')::uuid
                   LEFT JOIN public.product_parent_brands pb ON pb.id = d.parent_brand_id
                   LEFT JOIN public.product_brands lb ON lb.id = d.legacy_brand_id
                   -- A typed pick an admin linked to a listed brand reads that brand's tick too.
                   LEFT JOIN public.product_parent_brands rpb ON d.review_state = 'added' AND rpb.id = d.review_brand_ref
                   LEFT JOIN public.product_brands rlb ON d.review_state = 'added' AND rlb.id = d.review_brand_ref
                  WHERE e2.v ->> 'brand_key' = e.v ->> 'brand_key'
                    AND (COALESCE(pb.is_rup, lb.is_rup, false) OR COALESCE(rpb.is_rup, rlb.is_rup, false)))
    FROM e
   ORDER BY e.v ->> 'brand_key', e.i;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 3. The fill trigger (section 16.2.2)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public._fill_invoice_line_brands()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_status text;
  v_one_key text;
BEGIN
  SELECT i.status INTO v_status FROM public.invoices i WHERE i.id = NEW.invoice_id;
  -- Frozen once issued: a posted line's cost, tote and return-credit updates keep passing the posted-line guard.
  IF v_status IS NULL OR v_status NOT IN ('draft', 'unposted') THEN
    NEW.brand_lines := CASE WHEN TG_OP = 'UPDATE' THEN OLD.brand_lines END;
    RETURN NEW;
  END IF;
  NEW.brand_lines := public._invoice_line_brand_lines(NEW.invoice_id, NEW.order_item_id, NEW.product_id);
  IF NEW.brand_lines IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD.brand_lines IS NOT NULL) THEN
    SELECT min(k.brand_key) INTO v_one_key FROM public._invoice_line_brand_keys(NEW.brand_lines) k
    HAVING count(*) = 1;
    -- One brand (any number of trips) with a number: the jug's number. Anything else: the product's own.
    NEW.epa_registration := COALESCE(
      CASE WHEN v_one_key LIKE 'b:%' THEN public._epa_norm(NEW.brand_lines -> 0 ->> 'epa_registration') END,
      (SELECT public._epa_norm(p.epa_registration) FROM public.products p WHERE p.id = NEW.product_id));
  END IF;
  RETURN NEW;
END;
$function$;
-- Named to fire after trg_fill_invoice_line_epa / _vendor and before trg_guard_split_invoice_items and
-- trg_refuse_posted_invoice_child_write (BEFORE triggers fire in name order).
CREATE TRIGGER trg_fill_invoice_line_zbrands BEFORE INSERT OR UPDATE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._fill_invoice_line_brands();

-- ---------------------------------------------------------------------------------------------
-- 4. Re-copy (section 16.2.3)
-- ---------------------------------------------------------------------------------------------

-- Re-copies one open invoice's lines whose stored brands differ from the picks. Never raises: a failure is a
-- warning and leaves the invoice as it was (Q5). Returns false when it was skipped.
CREATE FUNCTION public._invoice_brand_recopy_invoice(p_invoice_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  BEGIN
    -- NOWAIT: a posting or save holding the invoice makes this a caught 55P03 (the draft keeps its brands and is
    -- re-copied on its next save), so a delivery write never waits here. A split-group invoice is skipped: its
    -- stored provenance claim covers epa_registration, which a re-copy can change, and a mismatch blocks posting.
    -- It keeps the brands it was made with (final, see _invoice_line_brand_lines); a later correction is caught at
    -- posting (no record, listed as brand_lines_stale), so it counts as skipped.
    IF EXISTS (SELECT 1 FROM public.split_invoice_provenance sp WHERE sp.invoice_id = p_invoice_id) THEN
      RETURN false;
    END IF;
    PERFORM 1 FROM public.invoices i
     WHERE i.id = p_invoice_id AND i.status IN ('draft', 'unposted') AND i.deleted_at IS NULL
       AND i.invoice_type <> 'credit_memo'
       FOR SHARE NOWAIT;
    IF FOUND THEN
      UPDATE public.invoice_items ii SET brand_lines = NULL  -- trg_fill_invoice_line_zbrands writes the real value
       WHERE ii.invoice_id = p_invoice_id AND ii.order_item_id IS NOT NULL
         AND ii.brand_lines IS DISTINCT FROM public._invoice_line_brand_lines(ii.invoice_id, ii.order_item_id, ii.product_id);
    END IF;
    RETURN true;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'INVOICE_BRANDS_NOT_RECOPIED: invoice % kept its brands (%: %)', p_invoice_id, SQLSTATE, SQLERRM;
    RETURN false;
  END;
END;
$function$;

CREATE FUNCTION public._invoice_brand_recopy(p_delivery_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice uuid;
  v_skipped integer := 0;
BEGIN
  FOR v_invoice IN
    SELECT i.id FROM public.invoices i
     WHERE i.status IN ('draft', 'unposted') AND i.deleted_at IS NULL AND i.invoice_type <> 'credit_memo'
       AND (i.delivery_id = p_delivery_id
            OR (i.delivery_id IS NULL AND i.order_id = (SELECT d.order_id FROM public.deliveries d WHERE d.id = p_delivery_id)))
     ORDER BY i.id
  LOOP
    IF NOT public._invoice_brand_recopy_invoice(v_invoice) THEN v_skipped := v_skipped + 1; END IF;
  END LOOP;
  RETURN v_skipped;
END;
$function$;

CREATE FUNCTION public._delivery_brand_event_recopy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._invoice_brand_recopy(NEW.delivery_id);
  RETURN NULL;
END;
$function$;
-- Deferred to the writer's commit: correct_delivery_brands writes its event before it replaces the picks, and a
-- line_removed event is written before the picks cascade away; at commit the picks are final.
CREATE CONSTRAINT TRIGGER trg_zz_recopy_invoice_brands AFTER INSERT ON public.delivery_brand_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public._delivery_brand_event_recopy();

-- ---------------------------------------------------------------------------------------------
-- 5. Allocation (section 16.2.4)
-- ---------------------------------------------------------------------------------------------

-- floor(total * weight / den) per weight, then the leftover one unit at a time to the largest dropped remainder
-- (ties: the earlier weight). The weights must add up to den, so the result adds up to total exactly.
CREATE FUNCTION public._brand_largest_remainder(p_total numeric, p_weights numeric[], p_den numeric)
RETURNS numeric[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_n integer := COALESCE(array_length(p_weights, 1), 0);
  v_out numeric[] := '{}';
  v_rem numeric[] := '{}';
  v_left numeric;
  v_best integer;
  v_i integer;
BEGIN
  IF v_n = 0 THEN RETURN v_out; END IF;
  IF p_den IS NULL OR p_den <= 0 OR p_total IS NULL OR p_total < 0 OR p_total <> trunc(p_total)
     OR (SELECT sum(w) FROM unnest(p_weights) w) IS DISTINCT FROM p_den
     OR EXISTS (SELECT 1 FROM unnest(p_weights) w WHERE w IS NULL OR w < 0 OR w <> trunc(w)) THEN
    RAISE EXCEPTION 'BRAND_ALLOCATION_INVALID: total %, denominator %', p_total, p_den;
  END IF;
  FOR v_i IN 1 .. v_n LOOP
    v_out := v_out || div(p_total * p_weights[v_i], p_den);
    v_rem := v_rem || mod(p_total * p_weights[v_i], p_den);
  END LOOP;
  v_left := p_total - (SELECT sum(x) FROM unnest(v_out) x);
  WHILE v_left > 0 LOOP
    v_best := NULL;
    FOR v_i IN 1 .. v_n LOOP
      IF v_rem[v_i] > 0 AND (v_best IS NULL OR v_rem[v_i] > v_rem[v_best]) THEN v_best := v_i; END IF;
    END LOOP;
    IF v_best IS NULL THEN RAISE EXCEPTION 'BRAND_ALLOCATION_INVALID: leftover with no remainder'; END IF;
    v_out[v_best] := v_out[v_best] + 1;
    v_rem[v_best] := 0;
    v_left := v_left - 1;
  END LOOP;
  RETURN v_out;
END;
$function$;

-- A line's per-brand quantities and cents, from stored values only. {"problem": null | reason, "brands": [{brand_key,
-- brand_name, epa_registration, signal_word, quantity, cents}]} in first-entry order. A line with NULL or [] brands
-- returns no brands and no problem. Quantities are counted in units of 0.0001, cents in whole cents.
CREATE FUNCTION public._invoice_line_brand_allocation(p_line_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_line record;
  v_entries jsonb;
  v_n integer;
  v_amt numeric[] := '{}';
  v_x numeric[];
  v_cents numeric[];
  v_d numeric;
  v_t numeric;
  v_q numeric;
  v_ids uuid[];
  v_qty numeric[];
  v_differs boolean;
  v_self integer;
  v_r numeric[];
  v_tr numeric;
  v_k integer;
  v_left numeric;
  v_i integer;
  v_sign numeric;
BEGIN
  SELECT ii.id, ii.order_item_id, ii.product_id, ii.quantity, ii.extended_cents, ii.brand_lines, i.delivery_id
    INTO v_line
    FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE ii.id = p_line_id;
  v_entries := v_line.brand_lines;
  IF v_line.id IS NULL OR v_entries IS NULL OR jsonb_typeof(v_entries) <> 'array' OR jsonb_array_length(v_entries) = 0
     OR COALESCE(v_line.quantity, 0) <= 0 THEN
    RETURN jsonb_build_object('problem', NULL, 'brands', '[]'::jsonb);
  END IF;
  v_n := jsonb_array_length(v_entries);
  v_q := round(v_line.quantity, 4) * 10000;  -- the 4-place rule (16.7): a 5-place amount uses its 4-place value

  -- 1. Each covered delivery line with picks must add up to what it delivered (4 places), checked per trip; amounts
  --    finer than 4 places cannot be split exactly; nor can a line that rounds to nothing.
  IF v_q <= 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e
              WHERE (e ->> 'quantity')::numeric * 10000 <> trunc((e ->> 'quantity')::numeric * 10000)
                 OR (e ->> 'line_delivered')::numeric * 10000 <> trunc((e ->> 'line_delivered')::numeric * 10000)
                 OR (e ->> 'quantity')::numeric <= 0)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e
                 GROUP BY e ->> 'delivery_item_id'
                HAVING bool_or(e ->> 'brand_key' <> 'n:')
                   AND sum((e ->> 'quantity')::numeric) <> max((e ->> 'line_delivered')::numeric)) THEN
    RETURN jsonb_build_object('problem', 'brand_split_mismatch', 'brands', '[]'::jsonb);
  END IF;
  SELECT sum(ld) * 10000 INTO v_d
    FROM (SELECT DISTINCT e ->> 'delivery_item_id' AS di, (e ->> 'line_delivered')::numeric AS ld
            FROM jsonb_array_elements(v_entries) e) x;

  -- 2. Another active invoice billing the same order line under an overlapping coverage.
  IF EXISTS (SELECT 1 FROM public.invoice_items o JOIN public.invoices oi ON oi.id = o.invoice_id
              WHERE o.order_item_id = v_line.order_item_id AND o.product_id = v_line.product_id AND o.id <> v_line.id
                AND o.quantity > 0 AND oi.deleted_at IS NULL AND oi.status NOT IN ('voided', 'cancelled')
                AND oi.invoice_type <> 'credit_memo'
                AND oi.delivery_id IS DISTINCT FROM v_line.delivery_id
                AND (oi.delivery_id IS NULL OR v_line.delivery_id IS NULL)) THEN
    RETURN jsonb_build_object('problem', 'overlapping_invoices', 'brands', '[]'::jsonb);
  END IF;

  -- The payer group: every active line billing the same order line under the same coverage.
  SELECT array_agg(ii.id ORDER BY ii.invoice_id, ii.id), array_agg(round(ii.quantity, 4) * 10000 ORDER BY ii.invoice_id, ii.id),
         bool_or(ii.brand_lines IS DISTINCT FROM v_entries)
    INTO v_ids, v_qty, v_differs
    FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE ii.order_item_id = v_line.order_item_id AND ii.product_id = v_line.product_id AND ii.quantity > 0
     AND i.delivery_id IS NOT DISTINCT FROM v_line.delivery_id
     AND i.deleted_at IS NULL AND i.status NOT IN ('voided', 'cancelled') AND i.invoice_type <> 'credit_memo';
  v_self := array_position(v_ids, v_line.id);
  -- 3. Payers whose stored brands differ cannot share one split.
  IF v_self IS NULL OR v_differs THEN
    RETURN jsonb_build_object('problem', 'payer_split_changed', 'brands', '[]'::jsonb);
  END IF;
  SELECT sum(q) INTO v_t FROM unnest(v_qty) q;
  -- 4. The group bills more than the covered trips delivered.
  IF v_t > v_d THEN
    RETURN jsonb_build_object('problem', 'billed_above_delivered', 'brands', '[]'::jsonb);
  END IF;

  FOR v_i IN 1 .. v_n LOOP
    v_amt := v_amt || ((v_entries -> (v_i - 1) ->> 'quantity')::numeric * 10000);
  END LOOP;
  IF array_length(v_ids, 1) = 1 THEN
    -- One line: entries in order, each up to its amount, until the line quantity is used.
    v_x := '{}';
    v_left := v_q;
    FOR v_i IN 1 .. v_n LOOP
      v_x := v_x || LEAST(v_amt[v_i], v_left);
      v_left := v_left - LEAST(v_amt[v_i], v_left);
    END LOOP;
  ELSE
    -- Several payers: the group's brand shares, then each payer's row from what remains, in order.
    v_r := public._brand_largest_remainder(v_t, v_amt, v_d);
    v_tr := v_t;
    FOR v_k IN 1 .. v_self LOOP
      IF v_k = array_length(v_ids, 1) THEN
        v_x := v_r;
      ELSE
        v_x := public._brand_largest_remainder(v_qty[v_k], v_r, v_tr);
        FOR v_i IN 1 .. v_n LOOP v_r[v_i] := v_r[v_i] - v_x[v_i]; END LOOP;
        v_tr := v_tr - v_qty[v_k];
      END IF;
    END LOOP;
  END IF;

  -- Cents by allocated quantity, so the line's entries add up to its cents.
  v_sign := CASE WHEN COALESCE(v_line.extended_cents, 0) < 0 THEN -1 ELSE 1 END;
  v_cents := public._brand_largest_remainder(abs(COALESCE(v_line.extended_cents, 0)), v_x, v_q);

  RETURN jsonb_build_object('problem', NULL, 'brands', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('brand_key', k.brand_key, 'brand_name', k.brand_name,
             'epa_registration', k.epa_registration, 'signal_word', k.signal_word,
             'quantity', round(s.ticks / 10000, 4), 'cents', s.cents * v_sign) ORDER BY k.first_index)
      FROM public._invoice_line_brand_keys(v_entries) k
      CROSS JOIN LATERAL (
        SELECT sum(v_x[i]) AS ticks, sum(v_cents[i]) AS cents
          FROM generate_series(1, v_n) i WHERE v_entries -> (i - 1) ->> 'brand_key' = k.brand_key) s), '[]'::jsonb));
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 6. Per-brand captures (section 16.2.5)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.invoice_line_brand_rup_captures (
  invoice_item_id uuid NOT NULL REFERENCES public.invoice_items(id) ON DELETE CASCADE ON UPDATE CASCADE,
  brand_key text NOT NULL CHECK (brand_key = 'n:' OR brand_key LIKE 'b:%'),
  brand_name text,
  product_id uuid NOT NULL,
  epa_registration text,  -- the brand's number, else the product's, normalized; NULL when neither has one
  rup_status text NOT NULL CHECK (rup_status IN ('yes', 'no', 'unknown')),
  signal_word text,
  source text NOT NULL CHECK (source IN ('save', 'posting')),
  basis text NOT NULL,  -- what the capture was taken from; a change re-captures
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invoice_item_id, brand_key)
);
ALTER TABLE public.invoice_line_brand_rup_captures OWNER TO postgres;
ALTER TABLE public.invoice_line_brand_rup_captures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.invoice_line_brand_rup_captures FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
-- Private, like invoice_line_rup_captures: no app role holds a grant, so this policy only states intent.
CREATE POLICY invoice_line_brand_rup_captures_admin_read ON public.invoice_line_brand_rup_captures FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role = 'admin' AND pr.is_active));

-- #1746's rule with the brand's number: Yes when the product's tick, the product number's registration or the brand
-- number's registration says Yes. The captured number is the brand's, else the product's. The signal word is the
-- captured number's registration's, else the brand snapshot's, else the product's.
CREATE FUNCTION public._invoice_brand_rup_facts(p_product_id uuid, p_brand_number text, p_brand_signal_word text,
  OUT epa_registration text, OUT rup_status text, OUT signal_word text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(n.bn, n.pn),
         CASE WHEN COALESCE(p.is_rup, false) OR r.rup_status = 'yes' OR br.rup_status = 'yes' THEN 'yes'
              WHEN (n.pn IS NOT NULL AND COALESCE(r.rup_status, 'unknown') = 'unknown')
                OR (n.bn IS NOT NULL AND COALESCE(br.rup_status, 'unknown') = 'unknown') THEN 'unknown'
              ELSE 'no' END,
         COALESCE(CASE WHEN n.bn IS NOT NULL THEN br.signal_word ELSE r.signal_word END,
                  NULLIF(btrim(p_brand_signal_word), ''), p.signal_word)
    FROM public.products p
   CROSS JOIN LATERAL (SELECT public._normalize_epa_registration(p.epa_registration) AS pn,
                              public._normalize_epa_registration(p_brand_number) AS bn) n
    LEFT JOIN public.epa_registrations r ON r.epa_registration = n.pn
    LEFT JOIN public.epa_registrations br ON br.epa_registration = n.bn
   WHERE p.id = p_product_id;
$function$;

-- Keeps one capture per brand key: gone keys dropped, new ones captured, a changed basis re-captured, an unchanged
-- one kept. A Yes stays Yes on the same product. The caller holds the shared registration lock.
CREATE FUNCTION public._sync_invoice_line_brand_captures(p_line_id uuid, p_product_id uuid, p_brand_lines jsonb, p_source text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  DELETE FROM public.invoice_line_brand_rup_captures c
   WHERE c.invoice_item_id = p_line_id
     AND NOT EXISTS (SELECT 1 FROM public._invoice_line_brand_keys(p_brand_lines) k WHERE k.brand_key = c.brand_key);
  INSERT INTO public.invoice_line_brand_rup_captures AS c
    (invoice_item_id, brand_key, brand_name, product_id, epa_registration, rup_status, signal_word, source, basis)
  SELECT p_line_id, k.brand_key, k.brand_name, p_product_id, f.epa_registration,
         CASE WHEN k.ticked THEN 'yes' ELSE f.rup_status END, f.signal_word, p_source,
         md5(jsonb_build_array(k.brand_name, k.epa_registration, k.signal_word, p_product_id, k.ticked,
               (SELECT public._normalize_epa_registration(p.epa_registration) FROM public.products p WHERE p.id = p_product_id))::text)
    FROM public._invoice_line_brand_keys(p_brand_lines) k
   CROSS JOIN LATERAL public._invoice_brand_rup_facts(p_product_id, k.epa_registration, k.signal_word) f
  ON CONFLICT (invoice_item_id, brand_key) DO UPDATE
    SET brand_name = EXCLUDED.brand_name, epa_registration = EXCLUDED.epa_registration,
        rup_status = CASE WHEN c.product_id = EXCLUDED.product_id AND c.rup_status = 'yes' THEN 'yes' ELSE EXCLUDED.rup_status END,
        signal_word = EXCLUDED.signal_word, source = EXCLUDED.source, basis = EXCLUDED.basis,
        product_id = EXCLUDED.product_id, captured_at = now()
    WHERE c.basis IS DISTINCT FROM EXCLUDED.basis;
END;
$function$;

-- Re-issued from 20261231210000 (md5 pinned above): the per-brand captures first, then #1746's per-line capture
-- unchanged.
CREATE OR REPLACE FUNCTION public._capture_invoice_line_rup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_same_product boolean;
BEGIN
  IF NOT public._epa_registrations_seeded() THEN
    RETURN NULL;  -- before the seed nothing is captured; the seed captures every line that exists
  END IF;
  -- B-1b: the per-brand captures, before the per-line early return below. The registration lock first, so no
  -- registration edit runs between reading the facts and writing them.
  -- Only while the invoice is open, the same freeze as the brand snapshot: a posted line's captures stay as posted.
  IF NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = NEW.invoice_id AND i.status NOT IN ('draft', 'unposted')) THEN
    IF NEW.product_id IS NOT NULL AND jsonb_typeof(NEW.brand_lines) = 'array' AND jsonb_array_length(NEW.brand_lines) > 0 THEN
      PERFORM public._epa_registration_lock(false);
      PERFORM public._sync_invoice_line_brand_captures(NEW.id, NEW.product_id, NEW.brand_lines, 'save');
    ELSE
      DELETE FROM public.invoice_line_brand_rup_captures WHERE invoice_item_id = NEW.id;
    END IF;
  END IF;
  IF NEW.product_id IS NULL THEN
    DELETE FROM public.invoice_line_rup_captures WHERE invoice_item_id = NEW.id;
    RETURN NULL;
  END IF;
  -- Kept unless the product changed or the saved number changed. Any change re-captures, a blank number filled in
  -- included, whether the writer or _fill_invoice_line_epa filled it (Sol r9: the fill can ride a price edit, so the
  -- trigger fires on every update and compares here). A price, quantity or unit edit keeps the capture.
  IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND public._normalize_epa_registration(NEW.epa_registration)
         IS NOT DISTINCT FROM public._normalize_epa_registration(OLD.epa_registration)
     AND EXISTS (SELECT 1 FROM public.invoice_line_rup_captures c WHERE c.invoice_item_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  v_same_product := TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id;
  PERFORM public._epa_registration_lock(false);
  INSERT INTO public.invoice_line_rup_captures AS c (invoice_item_id, epa_registration, rup_status, signal_word, source)
  SELECT NEW.id, f.epa_registration, f.rup_status, f.signal_word, 'save'
    FROM public._invoice_line_rup_facts(NEW.product_id, NEW.epa_registration) f
  ON CONFLICT (invoice_item_id) DO UPDATE
    SET epa_registration = EXCLUDED.epa_registration,
        -- a Yes always wins (Mason, 2026-11-10): a re-capture on the same product never turns a Yes back
        rup_status = CASE WHEN v_same_product AND c.rup_status = 'yes' THEN 'yes' ELSE EXCLUDED.rup_status END,
        signal_word = EXCLUDED.signal_word, source = EXCLUDED.source, captured_at = now();
  RETURN NULL;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 7. Records (section 16.2.6)
-- ---------------------------------------------------------------------------------------------

-- Re-issued from 20261231210000 (md5 pinned above): also refuses a line holding a per-line and a brand record at once.
CREATE OR REPLACE FUNCTION public._guard_rup_sales_record_line() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'RUP_RECORD_VOID_IS_FINAL: a voided restricted-use record cannot be made active again';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
                  WHERE ii.id = NEW.invoice_item_id AND ii.invoice_id = NEW.invoice_id AND ii.product_id = NEW.product_id
                    AND i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL
                    AND i.invoice_type <> 'credit_memo') THEN
    RAISE EXCEPTION 'RUP_RECORD_LINE_MISMATCH: an active restricted-use record must name a line of its own invoice and product, on a posted sale';
  END IF;
  -- B-1b: one per-line record, or records per brand, never both on one line.
  IF EXISTS (SELECT 1 FROM public.rup_sales_records s
              WHERE s.invoice_item_id = NEW.invoice_item_id AND s.voided_at IS NULL AND s.id IS DISTINCT FROM NEW.id
                AND (s.brand_key IS NULL) <> (NEW.brand_key IS NULL)) THEN
    RAISE EXCEPTION 'RUP_RECORD_LINE_KIND_MIXED: a line has either one restricted-use record or one per brand, never both';
  END IF;
  RETURN NEW;
END;
$function$;

-- Re-issued from 20261231210000 (md5 pinned above). B-1b: a line with NULL or [] brands keeps #1746's per-line path;
-- a branded line gets one record per brand captured Yes with a positive allocated share, and none with a problem.
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
BEGIN
  -- N2-4 role gate (matches the sole caller post_invoice): block applicators/drivers.
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to generate RUP sales records';
  END IF;

  -- REG-1: the invoice first, then the shared registration lock: the order a save takes (its line write holds the
  -- invoice, then the capture trigger takes the shared lock), so a queued registration edit cannot deadlock them
  -- (Luna 2026-11-10). FOR NO KEY UPDATE: two postings of one invoice run one after the other (sheet 4.C
  -- de-duplication) without blocking rows that only point at the invoice (RLS review r2 L1).
  -- REG-1: the buyer is the order's customer (unchanged; a bill-split payer invoice names the sale's customer). A
  -- field application has no order and records under the invoice's own customer (Mason, 2026-11-10).
  SELECT i.id, i.order_id, c.id AS customer_id, c.farm_name, i.invoice_date,
         i.invoice_number, i.status, i.deleted_at, i.invoice_type, i.posted_at
  INTO v_invoice
  FROM invoices i
  LEFT JOIN orders o ON o.id = i.order_id AND i.invoice_type <> 'field_application'
  JOIN customers c ON c.id = COALESCE(o.customer_id, i.customer_id)
  WHERE i.id = p_invoice_id
  FOR NO KEY UPDATE OF i;
  -- REG-1: no registration changes while this posting reads them (sheet 3.2, shared mode).
  PERFORM public._epa_registration_lock(false);
  v_seeded := public._epa_registrations_seeded();

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
      -- REG-1 (Luna 2026-11-10): a key replays only for the invoice it was first used on.
      IF v_existing->>'invoice_id' IS DISTINCT FROM p_invoice_id::text THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: this key was already used for a different invoice';
      END IF;
      RETURN (v_existing->>'count')::integer;
    END IF;
  END IF;

  -- REG-1 (Mason, 2026-11-10): a return credit never creates or needs a restricted-use record. After the key check,
  -- so another invoice's key is refused here too (Luna 2026-11-10 r1), and its own key is spent (r2).
  IF v_invoice.invoice_type = 'credit_memo' THEN
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'generate_rup_sales_records',
        jsonb_build_object('count', 0, 'invoice_id', p_invoice_id));
    END IF;
    RETURN 0;
  END IF;

  v_season := CASE
    WHEN EXTRACT(MONTH FROM LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date)) >= 10
    THEN EXTRACT(YEAR FROM LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date))::integer + 1
    ELSE EXTRACT(YEAR FROM LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date))::integer
  END;

  IF v_seeded THEN
    -- REG-1 (sheet 4.C, Mason 2026-11-10 "Capture it at save"): every line was captured when saved, or by the seed;
    -- one still without a capture is captured now and keeps it.
    INSERT INTO invoice_line_rup_captures (invoice_item_id, epa_registration, rup_status, signal_word, source)
    SELECT ii.id, f.epa_registration, f.rup_status, f.signal_word, 'posting'
      FROM invoice_items ii, LATERAL public._invoice_line_rup_facts(ii.product_id, ii.epa_registration) f
     WHERE ii.invoice_id = p_invoice_id AND ii.product_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM invoice_line_rup_captures c WHERE c.invoice_item_id = ii.id);
    -- B-1b: the same for each brand of a branded line.
    INSERT INTO invoice_line_brand_rup_captures
      (invoice_item_id, brand_key, brand_name, product_id, epa_registration, rup_status, signal_word, source, basis)
    SELECT ii.id, k.brand_key, k.brand_name, ii.product_id, f.epa_registration,
           CASE WHEN k.ticked THEN 'yes' ELSE f.rup_status END, f.signal_word, 'posting',
           md5(jsonb_build_array(k.brand_name, k.epa_registration, k.signal_word, ii.product_id, k.ticked,
                 (SELECT public._normalize_epa_registration(p.epa_registration) FROM products p WHERE p.id = ii.product_id))::text)
      FROM invoice_items ii
     CROSS JOIN LATERAL public._invoice_line_brand_keys(ii.brand_lines) k
     CROSS JOIN LATERAL public._invoice_brand_rup_facts(ii.product_id, k.epa_registration, k.signal_word) f
     WHERE ii.invoice_id = p_invoice_id AND ii.product_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM invoice_line_brand_rup_captures c
                        WHERE c.invoice_item_id = ii.id AND c.brand_key = k.brand_key);
    -- A Yes at posting wins too (Mason, 2026-11-10, "Yes, Yes at post wins", after Sol r1): only when the invoice is
    -- posted in this transaction, a line captured No or Not reviewed that any Yes covers now is upgraded (never down);
    -- its saved number and signal word stay. A later run on a posted invoice leaves it to Sales to check.
    IF v_invoice.posted_at = now() THEN
      UPDATE invoice_line_rup_captures c
         SET rup_status = 'yes', source = 'posting', captured_at = now()
        FROM invoice_items ii
       WHERE ii.invoice_id = p_invoice_id AND c.invoice_item_id = ii.id AND c.rup_status <> 'yes'
         AND ((SELECT f.rup_status FROM public._invoice_line_rup_facts(ii.product_id, ii.epa_registration) f) = 'yes'
              OR EXISTS (SELECT 1 FROM epa_registrations r
                          WHERE r.epa_registration = c.epa_registration AND r.rup_status = 'yes'));
      -- B-1b: the same per brand.
      UPDATE invoice_line_brand_rup_captures c
         SET rup_status = 'yes', source = 'posting', captured_at = now()
        FROM invoice_items ii
       WHERE ii.invoice_id = p_invoice_id AND c.invoice_item_id = ii.id AND c.rup_status <> 'yes'
         AND (EXISTS (SELECT 1 FROM public._invoice_line_brand_keys(ii.brand_lines) k
                       CROSS JOIN LATERAL public._invoice_brand_rup_facts(ii.product_id, k.epa_registration, k.signal_word) f
                       WHERE k.brand_key = c.brand_key AND (f.rup_status = 'yes' OR k.ticked))
              OR EXISTS (SELECT 1 FROM epa_registrations r
                          WHERE r.epa_registration = c.epa_registration AND r.rup_status = 'yes'));
    END IF;
    -- One record per line captured 'yes' that has none: the record names its line, so nothing is matched or grouped.
    -- B-1b: only lines with NULL or [] brands; a branded line gets one record per brand captured 'yes' with a positive
    -- allocated share and no active record, and none when its brands have a problem.
    OPEN v_items FOR
      SELECT ii.id AS invoice_item_id, ii.product_id, p.product_name, ii.quantity,
             COALESCE(NULLIF(btrim(ii.unit_size), ''), 'Unit not set') AS unit_size, -- never fail posting on a line with no unit (Sol r4)
             ii.unit_price_cents, ii.extended_cents, c.epa_registration, c.signal_word,
             NULL::text AS brand_name, NULL::text AS brand_key
        FROM invoice_items ii
        JOIN products p ON p.id = ii.product_id
        JOIN invoice_line_rup_captures c ON c.invoice_item_id = ii.id
       WHERE ii.invoice_id = p_invoice_id AND c.rup_status = 'yes' AND ii.quantity > 0
         AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(ii.brand_lines) = 'array' THEN ii.brand_lines END), 0) = 0
         -- Never a per-line record under the product's number when the picks now name brands (a NULL or [] split
         -- draft corrected after it was made): the line is listed as brand_lines_stale instead (Sol r1).
         AND COALESCE(jsonb_array_length(public._invoice_line_brand_lines(ii.invoice_id, ii.order_item_id, ii.product_id)), 0) = 0
         AND NOT EXISTS (SELECT 1 FROM rup_sales_records r WHERE r.invoice_item_id = ii.id AND r.voided_at IS NULL)
      UNION ALL
      SELECT ii.id, ii.product_id, p.product_name, (b.value ->> 'quantity')::numeric,
             COALESCE(NULLIF(btrim(ii.unit_size), ''), 'Unit not set'),
             ii.unit_price_cents, (b.value ->> 'cents')::bigint, c.epa_registration, c.signal_word,
             c.brand_name, c.brand_key
        FROM invoice_items ii
        JOIN products p ON p.id = ii.product_id
       CROSS JOIN LATERAL public._invoice_line_brand_allocation(ii.id) a
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN a ->> 'problem' IS NULL THEN a -> 'brands' ELSE '[]'::jsonb END) b
        JOIN invoice_line_brand_rup_captures c ON c.invoice_item_id = ii.id AND c.brand_key = b.value ->> 'brand_key'
       WHERE ii.invoice_id = p_invoice_id AND c.rup_status = 'yes' AND ii.quantity > 0
         AND jsonb_typeof(ii.brand_lines) = 'array' AND jsonb_array_length(ii.brand_lines) > 0
         AND (b.value ->> 'quantity')::numeric > 0
         -- Never a record under brands the picks no longer say (a corrected split draft, a skipped re-copy):
         -- the line is listed as brand_lines_stale instead.
         AND ii.brand_lines IS NOT DISTINCT FROM public._invoice_line_brand_lines(ii.invoice_id, ii.order_item_id, ii.product_id)
         AND NOT EXISTS (SELECT 1 FROM rup_sales_records r
                          WHERE r.invoice_item_id = ii.id AND r.voided_at IS NULL AND r.brand_key = c.brand_key)
       ORDER BY 1, 11 NULLS FIRST;
  ELSE
    OPEN v_items FOR
    SELECT ii.id AS invoice_item_id, ii.product_id, p.product_name, ii.quantity,
           COALESCE(NULLIF(btrim(ii.unit_size), ''), 'Unit not set') AS unit_size,  -- as the seeded branch: a missing unit never blocks a post
           ii.unit_price_cents, ii.extended_cents,
           p.epa_registration, p.signal_word,
           NULL::text AS brand_name, NULL::text AS brand_key
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

    -- Before the seed, today's rule (PARKED-006): one active record per invoice and product.
    IF NOT v_seeded AND EXISTS (
      SELECT 1 FROM rup_sales_records
      WHERE invoice_id = p_invoice_id
        AND product_id = v_item.product_id
        AND voided_at IS NULL
    ) THEN
      CONTINUE;
    END IF;

      INSERT INTO rup_sales_records (
        invoice_id, invoice_item_id, order_id, customer_id, product_id,
        sale_date, product_name, epa_registration, quantity, unit,
        unit_price_cents, total_cents,
        buyer_name, buyer_certification_number,
        buyer_certification_type, buyer_certification_expiry,
        signal_word, compliance_status, compliance_notes,
        season, created_by, brand_name, brand_key
      ) VALUES (
        p_invoice_id, v_item.invoice_item_id, v_invoice.order_id, v_invoice.customer_id, v_item.product_id,
        LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date), v_item.product_name, v_item.epa_registration, v_item.quantity, v_item.unit_size,
        v_item.unit_price_cents, v_item.extended_cents,
        v_invoice.farm_name,
        v_license.license_number,
        v_license.license_type,
        v_license.expiry_date,
        v_item.signal_word, v_compliance_status, v_compliance_notes,
        v_season, auth.uid(), v_item.brand_name, v_item.brand_key
      );
      v_count := v_count + 1;
  END LOOP;
  CLOSE v_items;

  v_result := jsonb_build_object('count', v_count, 'invoice_id', p_invoice_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'generate_rup_sales_records', v_result);
  END IF;

  RETURN v_count;
END;
$function$;
ALTER FUNCTION public.generate_rup_sales_records(uuid, text) OWNER TO postgres;

-- ---------------------------------------------------------------------------------------------
-- 8. Lists (section 16.2.7)
-- ---------------------------------------------------------------------------------------------

-- Re-issued from 20261231210000 (md5 pinned above), same signature: posted sale lines under p_number with no active
-- record; for a branded line, each brand under p_number with a positive share and no active record for that brand.
CREATE OR REPLACE FUNCTION public._epa_registration_unrecorded_posted_lines(p_number text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(jsonb_agg(x.o ORDER BY x.line_id, x.brand_key NULLS FIRST), '[]'::jsonb) FROM (
    SELECT ii.id AS line_id, NULL::text AS brand_key,
           jsonb_build_object('invoice_item_id', ii.id, 'invoice_id', ii.invoice_id,
             'invoice_number', i.invoice_number, 'product_id', ii.product_id) AS o
      FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
      JOIN public.products p ON p.id = ii.product_id
      LEFT JOIN public.invoice_line_rup_captures c ON c.invoice_item_id = ii.id
     WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL AND i.invoice_type <> 'credit_memo'
       AND ii.quantity > 0
       AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(ii.brand_lines) = 'array' THEN ii.brand_lines END), 0) = 0
       AND (c.epa_registration = p_number OR public._normalize_epa_registration(ii.epa_registration) = p_number
            OR public._normalize_epa_registration(p.epa_registration) = p_number)
       AND NOT EXISTS (SELECT 1 FROM public.rup_sales_records s WHERE s.invoice_item_id = ii.id AND s.voided_at IS NULL)
    UNION ALL
    SELECT ii.id, b.value ->> 'brand_key',
           jsonb_build_object('invoice_item_id', ii.id, 'invoice_id', ii.invoice_id,
             'invoice_number', i.invoice_number, 'product_id', ii.product_id,
             'brand_key', b.value ->> 'brand_key', 'brand_name', b.value ->> 'brand_name')
      FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
      JOIN public.products p ON p.id = ii.product_id
     CROSS JOIN LATERAL public._invoice_line_brand_allocation(ii.id) a
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN a ->> 'problem' IS NULL THEN a -> 'brands' ELSE '[]'::jsonb END) b
      LEFT JOIN public.invoice_line_brand_rup_captures c ON c.invoice_item_id = ii.id AND c.brand_key = b.value ->> 'brand_key'
     WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL AND i.invoice_type <> 'credit_memo'
       AND ii.quantity > 0 AND jsonb_typeof(ii.brand_lines) = 'array' AND jsonb_array_length(ii.brand_lines) > 0
       AND (b.value ->> 'quantity')::numeric > 0
       -- the product's number counts too: Sales to check treats it as making each brand restricted now (Sol r3)
       AND (c.epa_registration = p_number OR public._normalize_epa_registration(b.value ->> 'epa_registration') = p_number
            OR public._normalize_epa_registration(p.epa_registration) = p_number)
       AND NOT EXISTS (SELECT 1 FROM public.rup_sales_records s
                        WHERE s.invoice_item_id = ii.id AND s.voided_at IS NULL AND s.brand_key = b.value ->> 'brand_key')
    UNION ALL
    -- A branded line whose brands do not reconcile records nothing; it is listed once under any number it carries (Sol r3).
    SELECT ii.id, NULL::text,
           jsonb_build_object('invoice_item_id', ii.id, 'invoice_id', ii.invoice_id,
             'invoice_number', i.invoice_number, 'product_id', ii.product_id)
      FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
      JOIN public.products p ON p.id = ii.product_id
     CROSS JOIN LATERAL public._invoice_line_brand_allocation(ii.id) a
     WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL AND i.invoice_type <> 'credit_memo'
       AND ii.quantity > 0 AND jsonb_typeof(ii.brand_lines) = 'array' AND jsonb_array_length(ii.brand_lines) > 0
       AND a ->> 'problem' IS NOT NULL
       AND (public._normalize_epa_registration(ii.epa_registration) = p_number
            OR public._normalize_epa_registration(p.epa_registration) = p_number
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(ii.brand_lines) e
                        WHERE public._normalize_epa_registration(e ->> 'epa_registration') = p_number)
            OR EXISTS (SELECT 1 FROM public.invoice_line_brand_rup_captures c
                        WHERE c.invoice_item_id = ii.id AND c.epa_registration = p_number))
       -- listed even with a record for some brand: a record never settles a split that does not reconcile (Luna)
  ) x;
$function$;

-- Re-issued from 20261231210000 (md5 pinned above), same signature and grant. Rows are per line (brand_key NULL) or per
-- brand; a line may have several rows, one per reason. Lines with NULL or [] brands keep #1746's rows exactly.
CREATE OR REPLACE FUNCTION public.get_epa_sales_to_check() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_out jsonb;
BEGIN
  PERFORM public._product_parent_require_admin();
  IF NOT public._epa_registrations_seeded() THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_NOT_SEEDED: registrations are not switched on yet';
  END IF;
  WITH posted AS (
    SELECT ii.id AS line_id, ii.invoice_id, i.invoice_number, i.invoice_date, ii.product_id, p.product_name,
           public._normalize_epa_registration(ii.epa_registration) AS saved_number, ii.quantity, ii.brand_lines,
           COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(ii.brand_lines) = 'array' THEN ii.brand_lines END), 0) > 0 AS branded,
           p.is_rup AS product_is_rup, public._normalize_epa_registration(p.epa_registration) AS product_number,
           ii.order_item_id
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN products p ON p.id = ii.product_id
     -- a return credit is never a sale to record (Mason, 2026-11-10); neither is a zero or negative line
     WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL AND i.invoice_type <> 'credit_memo'
       AND ii.quantity > 0
  ), lines AS (
    -- #1746's per-line rows, for lines with NULL or [] brands.
    SELECT l.line_id, l.invoice_id, l.invoice_number, l.invoice_date, l.product_id, l.product_name,
           c.epa_registration, l.saved_number, l.quantity, c.rup_status, c.source AS capture_source,
           -- any Yes now: the product's tick, or the registration of the captured number, the number saved on the
           -- line, or the product's number today (Mason, 2026-11-10, Sol r10)
           COALESCE(l.product_is_rup, false) OR r.rup_status = 'yes' OR lr.rup_status = 'yes' OR pr.rup_status = 'yes' AS yes_now,
           r.rup_status AS registration_rup_status_now, lr.rup_status AS saved_registration_rup_status_now,
           EXISTS (SELECT 1 FROM rup_sales_records s WHERE s.invoice_item_id = l.line_id AND s.voided_at IS NULL) AS has_record
      FROM posted l
      LEFT JOIN invoice_line_rup_captures c ON c.invoice_item_id = l.line_id
      LEFT JOIN epa_registrations r ON r.epa_registration = c.epa_registration
      LEFT JOIN epa_registrations lr ON lr.epa_registration = l.saved_number
      LEFT JOIN epa_registrations pr ON pr.epa_registration = l.product_number
     WHERE NOT l.branded
  ), judged AS (
    SELECT l.*,
           CASE WHEN rup_status IS NULL THEN 'not_captured'
                WHEN rup_status = 'yes' AND NOT has_record THEN 'restricted_use_to_record'
                WHEN rup_status = 'yes' AND epa_registration IS NULL THEN 'no_epa_number'
                WHEN rup_status = 'yes' OR has_record THEN NULL
                WHEN yes_now THEN 'now_restricted_use'
                WHEN rup_status = 'unknown'
                 AND ((epa_registration IS NOT NULL AND COALESCE(registration_rup_status_now, 'unknown') = 'unknown')
                      OR (saved_number IS NOT NULL AND COALESCE(saved_registration_rup_status_now, 'unknown') = 'unknown'))
                  THEN 'not_reviewed'
                ELSE NULL END AS reason
      FROM lines l
  ), alloc AS (
    SELECT l.*, public._invoice_line_brand_allocation(l.line_id) AS a FROM posted l WHERE l.branded
  ), brands AS (
    -- One row per brand with a positive share on a branded line without a problem.
    SELECT al.line_id, al.invoice_id, al.invoice_number, al.invoice_date, al.product_id, al.product_name,
           c.epa_registration, al.saved_number, al.quantity, c.rup_status, c.source AS capture_source,
           COALESCE(al.product_is_rup, false) OR r.rup_status = 'yes' OR pr.rup_status = 'yes'
             OR EXISTS (SELECT 1 FROM public._invoice_line_brand_keys(al.brand_lines) k
                         WHERE k.brand_key = b.value ->> 'brand_key' AND k.ticked) AS yes_now,
           r.rup_status AS registration_rup_status_now, pr.rup_status AS product_registration_rup_status_now,
           EXISTS (SELECT 1 FROM rup_sales_records s WHERE s.invoice_item_id = al.line_id AND s.voided_at IS NULL
                      AND s.brand_key = b.value ->> 'brand_key') AS has_record,
           b.value ->> 'brand_key' AS brand_key, b.value ->> 'brand_name' AS brand_name,
           (b.value ->> 'quantity')::numeric AS allocated_quantity,
           b.value ->> 'brand_key' LIKE 'b:%' AND public._normalize_epa_registration(b.value ->> 'epa_registration') IS NULL AS brand_has_no_number
      FROM alloc al
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN al.a ->> 'problem' IS NULL THEN al.a -> 'brands' ELSE '[]'::jsonb END) b
      LEFT JOIN invoice_line_brand_rup_captures c ON c.invoice_item_id = al.line_id AND c.brand_key = b.value ->> 'brand_key'
      LEFT JOIN epa_registrations r ON r.epa_registration = c.epa_registration
      LEFT JOIN epa_registrations pr ON pr.epa_registration = al.product_number
     WHERE (b.value ->> 'quantity')::numeric > 0
  ), all_rows AS (
    SELECT line_id, invoice_id, invoice_number, invoice_date, product_id, product_name, epa_registration, saved_number,
           quantity, rup_status, capture_source, registration_rup_status_now, has_record,
           NULL::text AS brand_key, NULL::text AS brand_name, NULL::numeric AS allocated_quantity, reason
      FROM judged WHERE reason IS NOT NULL
    UNION ALL
    SELECT line_id, invoice_id, invoice_number, invoice_date, product_id, product_name, epa_registration, saved_number,
           quantity, rup_status, capture_source, registration_rup_status_now, has_record, brand_key, brand_name,
           allocated_quantity,
           CASE WHEN rup_status IS NULL THEN 'not_captured'
                WHEN rup_status = 'yes' AND NOT has_record THEN 'restricted_use_to_record'
                WHEN rup_status = 'yes' AND epa_registration IS NULL THEN 'no_epa_number'
                WHEN rup_status = 'yes' OR has_record THEN NULL
                WHEN yes_now THEN 'now_restricted_use'
                WHEN rup_status = 'unknown' AND epa_registration IS NOT NULL
                 AND (COALESCE(registration_rup_status_now, 'unknown') = 'unknown'
                      OR COALESCE(product_registration_rup_status_now, 'unknown') = 'unknown') THEN 'not_reviewed'
                ELSE NULL END
      FROM brands
    UNION ALL
    SELECT line_id, invoice_id, invoice_number, invoice_date, product_id, product_name, epa_registration, saved_number,
           quantity, rup_status, capture_source, registration_rup_status_now, has_record, brand_key, brand_name,
           allocated_quantity, 'brand_no_epa_number'
      FROM brands WHERE brand_has_no_number
    UNION ALL
    -- Line-level brand reasons: a brand problem, a snapshot that no longer matches the picks, no brand recorded, or a
    -- sibling payer changed after this line posted so its records no longer match its allocation.
    SELECT l.line_id, l.invoice_id, l.invoice_number, l.invoice_date, l.product_id, l.product_name,
           NULL::text, l.saved_number, l.quantity, NULL::text, NULL::text, NULL::text,
           EXISTS (SELECT 1 FROM rup_sales_records s WHERE s.invoice_item_id = l.line_id AND s.voided_at IS NULL),
           NULL::text, NULL::text, NULL::numeric, f.reason
      FROM posted l
      LEFT JOIN alloc al ON al.line_id = l.line_id
     CROSS JOIN LATERAL (VALUES
       (al.a ->> 'problem'),
       (CASE WHEN l.order_item_id IS NOT NULL
                  AND l.brand_lines IS DISTINCT FROM public._invoice_line_brand_lines(l.invoice_id, l.order_item_id, l.product_id)
             THEN 'brand_lines_stale' END),
       (CASE WHEN jsonb_typeof(l.brand_lines) = 'array'
                  AND (jsonb_array_length(l.brand_lines) = 0 OR l.brand_lines @> '[{"brand_key": "n:"}]'::jsonb)
             THEN 'brand_not_recorded' END),
       (CASE WHEN al.a ->> 'problem' IS NULL AND EXISTS (
               SELECT 1 FROM rup_sales_records s
                WHERE s.invoice_item_id = l.line_id AND s.voided_at IS NULL AND s.brand_key IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(al.a -> 'brands') b
                                   WHERE b.value ->> 'brand_key' = s.brand_key
                                     AND (b.value ->> 'quantity')::numeric = s.quantity))
             THEN 'payer_split_changed' END)) f(reason)
     -- Every brand problem is listed, restricted or not (Mason, 2026-11-11): brands never block, so a
     -- few extra lines to check beat a restricted sale hidden by a filter.
     WHERE f.reason IS NOT NULL
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'line_id', line_id, 'invoice_id', invoice_id, 'invoice_number', invoice_number, 'invoice_date', invoice_date,
           'product_id', product_id, 'product_name', product_name, 'epa_registration', epa_registration,
           'saved_number', saved_number, 'quantity', quantity, 'captured_rup_status', rup_status,
           'capture_source', capture_source, 'registration_rup_status', registration_rup_status_now,
           'has_record', has_record, 'reason', reason,
           'brand_key', brand_key, 'brand_name', brand_name, 'allocated_quantity', allocated_quantity)
           ORDER BY invoice_date, invoice_number, line_id, brand_key NULLS FIRST, reason), '[]'::jsonb)
    INTO v_out
    FROM all_rows
   WHERE reason IS NOT NULL;
  RETURN v_out;
END;
$function$;

-- Re-created (RETURNS TABLE gains brand_name at the end): same parameters, admin gate and grants.
DROP FUNCTION public.get_rup_sales_register(date, date, uuid, uuid, text, boolean);
CREATE FUNCTION public.get_rup_sales_register(p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_product_id uuid DEFAULT NULL::uuid, p_customer_id uuid DEFAULT NULL::uuid, p_compliance_status text DEFAULT NULL::text, p_include_voided boolean DEFAULT false)
 RETURNS TABLE(id uuid, sale_date date, invoice_id uuid, customer_id uuid, buyer_name text, product_name text, epa_registration text, quantity numeric, unit text, unit_price_cents bigint, total_cents bigint, buyer_certification_number text, buyer_certification_type text, buyer_certification_expiry date, signal_word text, compliance_status text, compliance_notes text, season integer, voided_at timestamp with time zone, voided_by uuid, void_reason text, brand_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Admins only: refuses non-admins, deactivated profiles and calls with no
  -- signed-in user (auth.uid() IS NULL) before any row is read.
  PERFORM public.require_admin();

  RETURN QUERY
  SELECT
    r.id, r.sale_date, r.invoice_id, r.customer_id,
    r.buyer_name, r.product_name, r.epa_registration,
    r.quantity, r.unit, r.unit_price_cents, r.total_cents,
    r.buyer_certification_number, r.buyer_certification_type,
    r.buyer_certification_expiry, r.signal_word,
    r.compliance_status, r.compliance_notes, r.season,
    r.voided_at, r.voided_by, r.void_reason, r.brand_name
  FROM rup_sales_records r
  WHERE (p_start_date IS NULL OR r.sale_date >= p_start_date)
    AND (p_end_date   IS NULL OR r.sale_date <= p_end_date)
    AND (p_product_id IS NULL OR r.product_id = p_product_id)
    AND (p_customer_id IS NULL OR r.customer_id = p_customer_id)
    AND (p_compliance_status IS NULL OR r.compliance_status = p_compliance_status)
    AND (p_include_voided OR r.voided_at IS NULL)
  ORDER BY r.sale_date DESC, r.buyer_name;
END;
$function$;
ALTER FUNCTION public.get_rup_sales_register(date, date, uuid, uuid, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_rup_sales_register(date, date, uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_rup_sales_register(date, date, uuid, uuid, text, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 9. Typed-brand review leaves voided and cancelled deliveries out (B-1a Sol round 4 MED)
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.review_typed_brand(
  p_pick_id uuid, p_action text, p_brand_id uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_delivery_id uuid;
  v_pick public.delivery_item_brands;
  v_fp text;
  v_existing jsonb;
  v_reason text := NULLIF(btrim(regexp_replace(COALESCE(p_reason, ''), '[[:space:]]+', ' ', 'g')), '');
  v_seq bigint;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED: only an admin can review typed brands' USING ERRCODE = '42501';
  END IF;
  SELECT delivery_id INTO v_delivery_id FROM public.delivery_item_brands WHERE id = p_pick_id;
  IF v_delivery_id IS NULL THEN RAISE EXCEPTION 'BRAND_PICK_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM public.deliveries WHERE id = v_delivery_id FOR UPDATE;
  v_fp := md5(jsonb_build_array(p_pick_id, p_action, p_brand_id, p_reason)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'review_typed_brand', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  -- B-1b: a voided or cancelled delivery's picks are not reviewed, as a deleted one's; after the replay, so a
  -- committed review still answers its retry (Sol r1).
  IF NOT EXISTS (SELECT 1 FROM public.deliveries WHERE id = v_delivery_id AND deleted_at IS NULL
                    AND status NOT IN ('voided', 'cancelled')) THEN
    RAISE EXCEPTION 'BRAND_PICK_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Re-read under the delivery lock: a correction or edit may have replaced the pick meanwhile.
  SELECT * INTO v_pick FROM public.delivery_item_brands WHERE id = p_pick_id FOR UPDATE;
  IF v_pick.id IS NULL OR v_pick.source <> 'typed' OR v_pick.superseded_at IS NOT NULL
     OR v_pick.review_state IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'BRAND_REVIEW_NOT_PENDING: this brand is not waiting for review';
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'BRAND_REVIEW_REASON_TOO_LONG: keep the reason to 1,000 characters' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'link' THEN
    IF p_brand_id IS NULL OR NOT EXISTS (SELECT 1 FROM public._delivery_line_brand_list(v_pick.product_id) l
                                          WHERE l.brand_id = p_brand_id) THEN
      RAISE EXCEPTION 'BRAND_NOT_FOR_PRODUCT: that brand is not on this product''s brand list' USING ERRCODE = '22023';
    END IF;
    UPDATE public.delivery_item_brands
       SET review_state = 'added', review_brand_ref = p_brand_id, review_reason = v_reason,
           reviewed_by = v_actor, reviewed_at = now()
     WHERE id = p_pick_id;
  ELSIF p_action = 'dismiss' THEN
    UPDATE public.delivery_item_brands
       SET review_state = 'dismissed', review_reason = v_reason, reviewed_by = v_actor, reviewed_at = now()
     WHERE id = p_pick_id;
  ELSE
    RAISE EXCEPTION 'BRAND_REVIEW_ACTION_INVALID: use link or dismiss' USING ERRCODE = '22023';
  END IF;
  v_seq := public._delivery_brand_event(v_delivery_id, 'reviewed', v_reason, NULL, jsonb_build_array(to_jsonb(v_pick)),
    (SELECT jsonb_build_array(to_jsonb(b)) FROM public.delivery_item_brands b WHERE b.id = p_pick_id),
    jsonb_build_object('action', p_action, 'brand_id', p_brand_id));
  v_result := jsonb_build_object('pick_id', p_pick_id, 'delivery_id', v_delivery_id, 'event_seq', v_seq,
    'review_state', CASE WHEN p_action = 'link' THEN 'added' ELSE 'dismissed' END);
  PERFORM public.save_idempotency(p_idempotency_key, 'review_typed_brand',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_typed_brands_for_review()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'pick_id', b.id, 'delivery_id', b.delivery_id, 'delivery_number', d.delivery_number, 'delivery_status', d.status,
      'delivery_item_id', b.delivery_item_id, 'product_id', b.product_id, 'product_name', p.product_name,
      'brand_name', b.brand_name, 'epa_registration', b.epa_registration, 'manufacturer', b.manufacturer,
      'quantity', b.quantity, 'review_note', b.review_note, 'entered_by', b.entered_by, 'entered_at', b.entered_at)
      ORDER BY b.entered_at, b.id)
      FROM public.delivery_item_brands b
      JOIN public.deliveries d ON d.id = b.delivery_id
      LEFT JOIN public.products p ON p.id = b.product_id
     WHERE b.review_state = 'pending' AND b.superseded_at IS NULL AND d.deleted_at IS NULL
       AND d.status NOT IN ('voided', 'cancelled')), '[]'::jsonb);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 9b. Completion (WHAT 8): B-1a's _complete_delivery_aggregate_impl (20270104120000 section 8, md5 pinned), with
--     two marked additions that name the delivery being completed while the body runs.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._complete_delivery_aggregate_impl(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_quantities jsonb DEFAULT NULL::jsonb,
  p_issue_type text DEFAULT NULL::text,
  p_issue_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_delivery record;
  v_base_seq text := NULLIF(current_setting('crx.brand_base_seq', true), '');  -- 20270104120000
  v_picks_confirmed boolean;  -- 20270104120000
  v_result jsonb;  -- 20270104120000
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT id, assigned_driver, status
    INTO v_delivery
    FROM public.deliveries
   WHERE id = p_delivery_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;

  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  -- 20270104120000 (Brand PR B): brands never refuse a completion (Mason 2026-11-09). A screen that sent the
  -- brand seq it loaded confirms the picks only if they have not changed since; otherwise the completion still
  -- goes through and the 'completed' event records picks_confirmed false, which puts its picked lines on the
  -- office list. A caller that sent no seq (the app before B-2) records NULL: not stated, not flagged.
  PERFORM set_config('crx.brand_base_seq', '', true);
  -- Only the wrappers set the value; anything that is not a plain number reads as not confirmed, never an error.
  v_picks_confirmed := CASE WHEN v_base_seq IS NULL THEN NULL
    WHEN v_base_seq ~ '^[0-9]{1,18}$' THEN v_base_seq::bigint = public._delivery_brand_max_seq(p_delivery_id)
    ELSE false END;

  -- 20270106110000 (B-1b): invoice lines the body writes while completing this delivery (Bill Split and landlord
  -- split drafts, which the re-copy never touches) read its brands as the completion rule below will leave them.
  IF v_delivery.status = 'in_progress' THEN
    PERFORM set_config('crx.brand_completing_delivery', p_delivery_id::text, true);
  END IF;
  v_result := public._complete_delivery_authorized_impl(
    p_delivery_id,
    p_signed_by,
    p_performed_by,
    p_quantities,
    p_issue_type,
    p_issue_notes,
    p_idempotency_key,
    p_completed_at
  );
  PERFORM set_config('crx.brand_completing_delivery', '', true);  -- 20270106110000

  -- 20270104120000: the brand completion rule, once, for a delivery this call completed. Outside the body's Bill
  -- Split fallback, so an error here fails the completion instead of changing the billing.
  IF v_delivery.status = 'in_progress'
     AND (SELECT d.status FROM public.deliveries d WHERE d.id = p_delivery_id) = 'completed' THEN
    PERFORM public._delivery_brands_on_complete(p_delivery_id, v_picks_confirmed);
  END IF;
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 10. Grants
-- ---------------------------------------------------------------------------------------------

DO $grants$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public._invoice_brand_key(text,text)', 'public._invoice_line_brand_lines(uuid,uuid,uuid)',
    'public._invoice_line_brand_keys(jsonb)', 'public._fill_invoice_line_brands()',
    'public._invoice_brand_recopy_invoice(uuid)', 'public._invoice_brand_recopy(uuid)',
    'public._delivery_brand_event_recopy()', 'public._brand_largest_remainder(numeric,numeric[],numeric)',
    'public._invoice_line_brand_allocation(uuid)', 'public._invoice_brand_rup_facts(uuid,text,text)',
    'public._sync_invoice_line_brand_captures(uuid,uuid,jsonb,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_sig);
  END LOOP;
END
$grants$;

-- ---------------------------------------------------------------------------------------------
-- 11. Backfill: open drafts re-copied once (section 16.2.10)
-- ---------------------------------------------------------------------------------------------

DO $backfill$
DECLARE
  v_invoice uuid;
  v_done integer := 0;
  v_skipped integer := 0;
BEGIN
  FOR v_invoice IN
    SELECT i.id FROM public.invoices i
     WHERE i.status IN ('draft', 'unposted') AND i.deleted_at IS NULL AND i.invoice_type <> 'credit_memo'
       AND EXISTS (SELECT 1 FROM public.invoice_items ii WHERE ii.invoice_id = i.id AND ii.order_item_id IS NOT NULL)
     ORDER BY i.id
  LOOP
    IF public._invoice_brand_recopy_invoice(v_invoice) THEN v_done := v_done + 1; ELSE v_skipped := v_skipped + 1; END IF;
  END LOOP;
  RAISE NOTICE 'INVOICE_BRANDS_BACKFILL: % open invoices checked, % skipped', v_done, v_skipped;
END
$backfill$;

-- ---------------------------------------------------------------------------------------------
-- 12. Postflight
-- ---------------------------------------------------------------------------------------------

DO $postflight$
DECLARE
  v_role text;
  v_sig text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'public.invoice_line_brand_rup_captures', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_any_column_privilege(v_role, 'public.invoice_line_brand_rup_captures', 'SELECT,INSERT,UPDATE,REFERENCES')
       OR has_table_privilege(v_role, 'public.rup_sales_records', 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_any_column_privilege(v_role, 'public.rup_sales_records', 'INSERT,UPDATE')
       OR (v_role <> 'service_role' AND has_column_privilege(v_role, 'public.invoice_items', 'brand_lines', 'INSERT,UPDATE')) THEN
      RAISE EXCEPTION 'POSTFLIGHT_INVOICE_BRANDS_RUP: % can touch brand captures or write restricted-use records', v_role;
    END IF;
    FOREACH v_sig IN ARRAY ARRAY[
      'public._invoice_brand_key(text,text)', 'public._invoice_line_brand_lines(uuid,uuid,uuid)',
      'public._invoice_line_brand_keys(jsonb)', 'public._fill_invoice_line_brands()',
      'public._invoice_brand_recopy_invoice(uuid)', 'public._invoice_brand_recopy(uuid)',
      'public._delivery_brand_event_recopy()', 'public._brand_largest_remainder(numeric,numeric[],numeric)',
      'public._invoice_line_brand_allocation(uuid)', 'public._invoice_brand_rup_facts(uuid,text,text)',
      'public._sync_invoice_line_brand_captures(uuid,uuid,jsonb,text)', 'public._capture_invoice_line_rup()',
      'public._guard_rup_sales_record_line()', 'public._epa_registration_unrecorded_posted_lines(text)',
      'public._complete_delivery_aggregate_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'] LOOP
      IF has_function_privilege(v_role, v_sig, 'EXECUTE') THEN
        RAISE EXCEPTION 'POSTFLIGHT_INVOICE_BRANDS_RUP: % can run %', v_role, v_sig;
      END IF;
    END LOOP;
  END LOOP;
  IF has_table_privilege('metabase_ro', 'public.invoice_line_brand_rup_captures', 'SELECT')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.invoice_line_brand_rup_captures'::regclass) THEN
    RAISE EXCEPTION 'POSTFLIGHT_INVOICE_BRANDS_RUP: the capture table is readable or has no row security';
  END IF;
  -- Every new or re-issued SECURITY DEFINER function is owned by postgres with a pinned search_path.
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
                AND p.proname IN ('_invoice_line_brand_lines', '_fill_invoice_line_brands', '_invoice_brand_recopy_invoice',
                                  '_invoice_brand_recopy', '_delivery_brand_event_recopy', '_invoice_line_brand_allocation',
                                  '_invoice_brand_rup_facts', '_sync_invoice_line_brand_captures', '_capture_invoice_line_rup',
                                  'generate_rup_sales_records', 'get_epa_sales_to_check', 'get_rup_sales_register',
                                  'review_typed_brand', 'get_typed_brands_for_review', '_epa_registration_unrecorded_posted_lines',
                                  '_complete_delivery_aggregate_impl')
                AND (p.proowner <> 'postgres'::regrole
                     OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) s
                                     WHERE replace(s, '"', '') = 'search_path=public, pg_temp'))) THEN
    RAISE EXCEPTION 'POSTFLIGHT_INVOICE_BRANDS_RUP: a SECURITY DEFINER function is not owned by postgres or lacks its search_path';
  END IF;
  IF position('''brand_lines''' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public._split_invoice_content_claim(uuid)'::regprocedure)) = 0
     OR (SELECT proowner FROM pg_proc WHERE oid = 'public._split_invoice_content_claim(uuid)'::regprocedure) <> 'postgres'::regrole
     OR has_function_privilege('authenticated', 'public._split_invoice_content_claim(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._split_invoice_content_claim(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_INVOICE_BRANDS_RUP: the split-invoice claim does not leave brand_lines out, or its owner or grants changed';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_complete_delivery_aggregate_impl') <> 1
     OR position('crx.brand_completing_delivery' IN (SELECT prosrc FROM pg_proc
          WHERE oid = 'public._complete_delivery_aggregate_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'::regprocedure)) = 0
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = 'public._complete_delivery_aggregate_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'::regprocedure
                   AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_INVOICE_BRANDS_RUP: the completion does not name the delivery it completes, or PUBLIC can run it';
  END IF;
  -- Public functions keep their grants.
  IF has_function_privilege('anon', 'public.generate_rup_sales_records(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.generate_rup_sales_records(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_epa_sales_to_check()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_epa_sales_to_check()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_rup_sales_register(date,date,uuid,uuid,text,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_rup_sales_register(date,date,uuid,uuid,text,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_rup_sales_register(date,date,uuid,uuid,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.review_typed_brand(uuid,text,uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.review_typed_brand(uuid,text,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_typed_brands_for_review()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_typed_brands_for_review()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_INVOICE_BRANDS_RUP: a public function lost or gained a grant';
  END IF;
  IF to_regclass('public.rup_sales_records_one_active_per_line_brand') IS NULL
     OR to_regclass('public.rup_sales_records_one_active_per_line') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.invoice_items'::regclass AND tgname = 'trg_fill_invoice_line_zbrands')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_brand_events'::regclass
                      AND tgname = 'trg_zz_recopy_invoice_brands' AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'POSTFLIGHT_INVOICE_BRANDS_RUP: an index or trigger is missing';
  END IF;
END
$postflight$;
