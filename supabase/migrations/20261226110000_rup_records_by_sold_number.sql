-- Written 2026-11-08, cut down 2026-11-09. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261226110000_rup_records_by_sold_number.md (REG-1 Step 2, file C of 4).
-- Re-read the live ledger before applying.
--
-- WHY: REG-1 Step 2 part C (docs/plans/2026-11-06-product-REG1-BUILD-SHEET.md 4.C): once the seed has run,
--   posting writes the restricted-use register under the EPA number each invoice line was sold under (the
--   line's stored number), and takes the restricted-use answer and signal word from that number's
--   registration. Today it reads the product's current number and tick, which can differ from the label sold.
--   A missing or unregistered number never blocks a sale (Mason, 2026-11-09): the line posts, gets no
--   record without a number, and is listed on Sales to check.
--   SIMPLIFIED (Mason, 2026-11-09, "Yes, simplify"): no per-line copy of the label facts. Restricted use is
--   a fact of the EPA number, and the line's stored number already survives a re-save (the screens send it
--   back; _fill_invoice_line_epa keeps a sent number and fills only a blank line from its product, as today).
--
-- WHAT:
--   - generate_rup_sales_records re-issued (md5 pinned): before the seed, today's rule. After the seed a
--     line needs a record when its stored number's registration says Yes OR its product is ticked
--     restricted-use (sizes are not kept in step with registrations, so either Yes records it; recording
--     one extra sale is the safe side; Mason, 2026-11-09, "Drop them"). One record per product, number, unit and
--     unit price (lines sold at different prices or units never merge). A line with no number is skipped,
--     never refused. An active record that disagrees with what posting would write is refused
--     (RUP_RECORD_CONFLICT), never silently kept.
--   - _rup_record_covers_line: the one rule for "this posted line has its record"; used by
--     _epa_registration_unrecorded_posted_lines (re-issued from 20261226100000, same grants) and the list below.
--   - get_epa_sales_to_check() (admin, read-only): posted restricted-use lines (same either-Yes rule) with no record
--     (restricted_use_to_record) and posted lines of a restricted-use product with no number (no_epa_number).
--   - Q7 (invoice_items half): INSERT and UPDATE stay revoked from anon and authenticated (none today);
--     the postflight proves it.
--
-- ACCEPTED (Mason, 2026-11-09): a draft line saved with no number takes its product's number when re-saved
--   (today's rule); a re-post after un-posting uses the registration as it is then.
--
-- NOT CHANGED: invoice saving (save_invoice, the field-application saves), _fill_invoice_line_epa, the
--   posting wrappers. Posting takes the REG-1 lock in shared mode; one colliding with a registration change
--   can end in a deadlock error, which rolls back and is retried (rare, admin-only, all-or-nothing).
--
-- ROLLBACK (its own reviewed migration): drop get_epa_sales_to_check and _rup_record_covers_line, re-emit
--   generate_rup_sales_records from its pinned body and _epa_registration_unrecorded_posted_lines from
--   20261226100000.
--
-- ORDERING: after 20261226100000_epa_registration_tools; before 20261226120000.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE rup_records_by_sold_number_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.rup_records_by_sold_number_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.rup_records_by_sold_number_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'RUP_RECORDS_BY_SOLD_NUMBER_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._epa_registration_unrecorded_posted_lines(text)') IS NULL THEN
    RAISE EXCEPTION 'RUP_RECORDS_BY_SOLD_NUMBER_PREFLIGHT: apply 20261226100000_epa_registration_tools first';
  END IF;
  IF to_regprocedure('public.get_epa_sales_to_check()') IS NOT NULL THEN
    RAISE EXCEPTION 'RUP_RECORDS_BY_SOLD_NUMBER_PREFLIGHT: this file was already applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public.generate_rup_sales_records(uuid,text)')
                    AND md5(replace(p.prosrc, chr(13), '')) = '0cb155a27c654dd390a875c3ff3aa507'
                    AND p.proowner = 'postgres'::regrole AND p.prosecdef) THEN
    RAISE EXCEPTION 'RUP_RECORDS_BY_SOLD_NUMBER_PREFLIGHT: generate_rup_sales_records drifted from the body this file was written from';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. The one coverage rule
-- ---------------------------------------------------------------------------------------------

-- A posted line has its restricted-use record when an active record has its invoice, product, sold number,
-- unit and unit price (posting writes one per each) and that record's quantity and amount are the sum of every
-- line on the invoice sharing them (an older record written for only some of those lines does not count).
CREATE FUNCTION public._rup_record_covers_line(p_line public.invoice_items) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT EXISTS (SELECT 1
                   FROM public.rup_sales_records s,
                        LATERAL (SELECT sum(o.quantity) AS quantity, sum(o.extended_cents)::bigint AS total_cents
                                   FROM public.invoice_items o
                                  WHERE o.invoice_id = p_line.invoice_id AND o.product_id = p_line.product_id
                                    AND public._normalize_epa_registration(o.epa_registration)
                                        IS NOT DISTINCT FROM public._normalize_epa_registration(p_line.epa_registration)
                                    AND o.unit_size IS NOT DISTINCT FROM p_line.unit_size
                                    AND o.unit_price_cents IS NOT DISTINCT FROM p_line.unit_price_cents) l
                  WHERE s.invoice_id = p_line.invoice_id AND s.product_id = p_line.product_id AND s.voided_at IS NULL
                    AND public._normalize_epa_registration(s.epa_registration)
                        IS NOT DISTINCT FROM public._normalize_epa_registration(p_line.epa_registration)
                    AND s.unit IS NOT DISTINCT FROM p_line.unit_size
                    AND s.unit_price_cents IS NOT DISTINCT FROM p_line.unit_price_cents
                    AND s.quantity IS NOT DISTINCT FROM l.quantity
                    AND s.total_cents IS NOT DISTINCT FROM l.total_cents);
$function$;
ALTER FUNCTION public._rup_record_covers_line(public.invoice_items) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._rup_record_covers_line(public.invoice_items) FROM PUBLIC, anon, authenticated, service_role;

-- Re-issued from 20261226100000 (same signature and grants) to use the one coverage rule above.
CREATE OR REPLACE FUNCTION public._epa_registration_unrecorded_posted_lines(p_number text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('invoice_item_id', ii.id, 'invoice_id', ii.invoice_id,
           'invoice_number', i.invoice_number, 'product_id', ii.product_id) ORDER BY ii.id), '[]'::jsonb)
    FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL
     AND public._normalize_epa_registration(ii.epa_registration) = p_number
     AND NOT public._rup_record_covers_line(ii);
$function$;

-- ---------------------------------------------------------------------------------------------
-- 2. Posting: generate_rup_sales_records (live body, md5 0cb155a2..., plus the seeded branch)
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

  -- REG-1: no registration changes while this posting reads them (sheet 3.2, shared mode).
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
    -- REG-1 (sheet 4.C): a line records under the number it was sold under (its stored number), and needs a
    -- record when that number's registration says Yes or its product is ticked (either Yes records it).
    -- A line with no number posts with no record and is listed on Sales to check (Mason, 2026-11-09).
    -- One record per unit and unit price too, so a record never merges lines sold at different prices or units.
    OPEN v_items FOR
      SELECT ii.product_id, p.product_name, sum(ii.quantity) AS quantity, ii.unit_size,
             ii.unit_price_cents, sum(ii.extended_cents)::bigint AS extended_cents,
             public._normalize_epa_registration(ii.epa_registration) AS epa_registration,
             COALESCE(r.signal_word, p.signal_word) AS signal_word
        FROM invoice_items ii
        JOIN products p ON p.id = ii.product_id
        LEFT JOIN epa_registrations r ON r.epa_registration = public._normalize_epa_registration(ii.epa_registration)
       WHERE ii.invoice_id = p_invoice_id
         AND public._normalize_epa_registration(ii.epa_registration) IS NOT NULL  -- a RUP record never has a blank number
         AND (r.rup_status = 'yes' OR p.is_rup)
       GROUP BY ii.product_id, p.product_name, public._normalize_epa_registration(ii.epa_registration),
                COALESCE(r.signal_word, p.signal_word), ii.unit_size, ii.unit_price_cents
       ORDER BY ii.product_id, 7, 4, 5;
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
      -- REG-1: one active record per invoice, product, sold number, unit and unit price (the coverage rule);
      -- one that disagrees with what this posting would write is an error, never skipped.
      SELECT r.quantity, r.total_cents INTO v_rec_qty, v_rec_total FROM rup_sales_records r
       WHERE r.invoice_id = p_invoice_id AND r.product_id = v_item.product_id
         AND public._normalize_epa_registration(r.epa_registration) IS NOT DISTINCT FROM v_item.epa_registration
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
-- 3. Posted sales a person should check (admin, read-only; sheet 4.C)
-- ---------------------------------------------------------------------------------------------

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
           public._normalize_epa_registration(ii.epa_registration) AS epa_registration, ii.quantity,
           r.rup_status AS registration_rup_status, p.is_rup AS product_is_rup,
           (r.rup_status = 'yes' OR p.is_rup) AS restricted_use,
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
           'quantity', quantity, 'registration_rup_status', registration_rup_status,
           'product_is_rup', product_is_rup, 'has_record', has_record,
           'reason', CASE WHEN epa_registration IS NULL THEN 'no_epa_number' ELSE 'restricted_use_to_record' END)
           ORDER BY invoice_date, invoice_number, line_id), '[]'::jsonb)
    INTO v_out
    FROM lines
   WHERE (epa_registration IS NOT NULL AND restricted_use AND NOT has_record)
      OR (epa_registration IS NULL AND product_is_rup);
  RETURN v_out;
END;
$function$;
ALTER FUNCTION public.get_epa_sales_to_check() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_epa_sales_to_check() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_epa_sales_to_check() TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Q7 (invoice_items half): no direct line writes from the app roles
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
      RAISE EXCEPTION 'POSTFLIGHT_RUP_RECORDS_BY_SOLD_NUMBER: % can write invoice_items', v_role;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._rup_record_covers_line(public.invoice_items)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._epa_registration_unrecorded_posted_lines(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_epa_sales_to_check()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_epa_sales_to_check()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_RUP_RECORDS_BY_SOLD_NUMBER_WRONG';
  END IF;
END;
$postflight$;
