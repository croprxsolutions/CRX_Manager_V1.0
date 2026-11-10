-- Written 2026-11-08, rebuilt 2026-11-10. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261229190000_rup_records_by_sold_number.md (REG-1 Step 2, file 2 of 3).
-- Re-read the live ledger before applying.
--
-- WHY: REG-1 Step 2 part C (docs/plans/2026-11-06-product-REG1-BUILD-SHEET.md 4.C). Mason, 2026-11-10, "Capture
--   it at save": once the seed has run, the database stores each invoice line's restricted-use answer, EPA number
--   and signal word when the line is saved, and posting records exactly that, so a label change between saving and
--   posting never changes what a sale records. Kept rules (Mason, 2026-11-09): the number is the product's own
--   ("Yes, product's number"), any Yes makes it restricted use ("Yes, any Yes"), a missing or unregistered number
--   never blocks a sale, and every restricted-use sale gets its record ("Yes, always record").
--
-- WHAT:
--   - invoice_line_rup_captures (private, RLS on, no grants): one row per invoice line, removed with its line.
--   - _invoice_line_rup_facts(product, saved number): the capture rule, read in one statement.
--   - trg_zz_capture_invoice_line_rup (AFTER INSERT OR UPDATE OF product_id, epa_registration on invoice_items),
--     after the seed only: captures every new product line, and re-captures when the product changes or the saved
--     number changes to a different one. A blank number being filled, or a price, quantity or unit edit, keeps it.
--   - generate_rup_sales_records re-issued (md5 pinned): before the seed, today's rule. After it, posting first
--     captures any line without a capture (source 'posting'), then writes one record per product, captured number,
--     captured signal word, unit and unit price for the 'yes' lines. An active record matching all of those with a
--     different quantity or amount is refused (RUP_RECORD_CONFLICT).
--   - _rup_record_covers_line: only a 'yes' line can be covered (or, for a line posted before the seed, today's rule).
--   - _epa_registration_unrecorded_posted_lines re-issued (same signature and grants) and get_epa_sales_to_check()
--     (admin, read-only), each line judged on its own capture.
--   - Q7 (invoice_items half): INSERT, UPDATE and DELETE stay revoked from anon and authenticated (none today).
--
-- ACCEPTED (Mason, 2026-11-10): a save that deletes and re-inserts lines captures them again (the capture is as of
--   the latest save). The list is unpaged (admin-only, read-only, small history).
--
-- NOT CHANGED: invoice saving (save_invoice, the field-application saves), _fill_invoice_line_epa, the posting
--   wrappers (post_invoice calls the generator in its own transaction and does not catch its errors), and the
--   applicator-licence pick inside the generator. Saves and posting take the REG-1 lock in shared mode; one
--   colliding with a registration edit can end in a deadlock error, which rolls back with nothing written.
--
-- ROLLBACK (its own reviewed migration, forward repair): keep the captures; a generator that ignores them would
--   lose a sale captured Yes. Drop the trigger only with a generator that still reads the captures.
--
-- ORDERING: after 20261229180000_epa_registration_tools; before 20261229200000.

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
    RAISE EXCEPTION 'RUP_RECORDS_BY_SOLD_NUMBER_PREFLIGHT: apply 20261229180000_epa_registration_tools first';
  END IF;
  IF to_regprocedure('public.get_epa_sales_to_check()') IS NOT NULL
     OR to_regclass('public.invoice_line_rup_captures') IS NOT NULL THEN
    RAISE EXCEPTION 'RUP_RECORDS_BY_SOLD_NUMBER_PREFLIGHT: this file was already applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public.generate_rup_sales_records(uuid,text)')
                    AND md5(replace(p.prosrc, chr(13), '')) = '0cb155a27c654dd390a875c3ff3aa507'
                    AND p.proowner = 'postgres'::regrole AND p.prosecdef) THEN
    RAISE EXCEPTION 'RUP_RECORDS_BY_SOLD_NUMBER_PREFLIGHT: generate_rup_sales_records drifted from the body this file was written from';
  END IF;
  -- The capture reads the line's number after this trigger has filled a blank one (it must stay BEFORE).
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.invoice_items'::regclass
                    AND t.tgname = 'trg_fill_invoice_line_epa' AND NOT t.tgisinternal AND (t.tgtype & 2) = 2) THEN
    RAISE EXCEPTION 'RUP_RECORDS_BY_SOLD_NUMBER_PREFLIGHT: trg_fill_invoice_line_epa is missing or no longer BEFORE';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. The capture (sheet 4.C)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.invoice_line_rup_captures (
  invoice_item_id uuid PRIMARY KEY REFERENCES public.invoice_items(id) ON DELETE CASCADE,
  epa_registration text,  -- the product's own number, normalized; NULL when the product has none
  rup_status text NOT NULL CHECK (rup_status IN ('yes', 'no', 'unknown')),
  signal_word text,
  source text NOT NULL CHECK (source IN ('save', 'seed', 'posting')),
  captured_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.invoice_line_rup_captures OWNER TO postgres;
ALTER TABLE public.invoice_line_rup_captures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.invoice_line_rup_captures FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
-- Private: written and read only by SECURITY DEFINER functions owned by postgres. No app role holds a grant, so
-- this policy only states that intent (an admin read, should a grant ever be added).
CREATE POLICY invoice_line_rup_captures_admin_read ON public.invoice_line_rup_captures FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role = 'admin' AND pr.is_active));

-- The capture rule, in one statement: 'yes' when the product's tick, its number's registration or the registration
-- of the number saved on the line says Yes; else 'unknown' when either number, where present, has no registration or
-- a Not reviewed one; else 'no'. The number is the product's own; the signal word its registration's, else the product's.
CREATE FUNCTION public._invoice_line_rup_facts(p_product_id uuid, p_line_number text,
  OUT epa_registration text, OUT rup_status text, OUT signal_word text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT n.pn,
         CASE WHEN COALESCE(p.is_rup, false) OR r.rup_status = 'yes' OR lr.rup_status = 'yes' THEN 'yes'
              WHEN (n.pn IS NOT NULL AND COALESCE(r.rup_status, 'unknown') = 'unknown')
                OR (n.ln IS NOT NULL AND COALESCE(lr.rup_status, 'unknown') = 'unknown') THEN 'unknown'
              ELSE 'no' END,
         COALESCE(r.signal_word, p.signal_word)
    FROM public.products p
   CROSS JOIN LATERAL (SELECT public._normalize_epa_registration(p.epa_registration) AS pn,
                              public._normalize_epa_registration(p_line_number) AS ln) n
    LEFT JOIN public.epa_registrations r ON r.epa_registration = n.pn
    LEFT JOIN public.epa_registrations lr ON lr.epa_registration = n.ln
   WHERE p.id = p_product_id;
$function$;

CREATE FUNCTION public._capture_invoice_line_rup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF NOT public._epa_registrations_seeded() THEN
    RETURN NULL;  -- before the seed nothing is captured; the seed captures every line that exists
  END IF;
  IF NEW.product_id IS NULL THEN
    DELETE FROM public.invoice_line_rup_captures WHERE invoice_item_id = NEW.id;
    RETURN NULL;
  END IF;
  -- Kept unless the product changed or the saved number changed to a different number. A blank number filled in with
  -- the captured number or the size's own number (by the writer or by _fill_invoice_line_epa) is not a new sale fact;
  -- any other number filled in is, and re-captures (Luna 2026-11-10). The trigger fires only on these columns, so a
  -- price, quantity or unit edit never reaches here.
  IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND EXISTS (SELECT 1 FROM public.invoice_line_rup_captures c
                   JOIN public.products p ON p.id = NEW.product_id
                  WHERE c.invoice_item_id = NEW.id
                    AND CASE WHEN public._normalize_epa_registration(OLD.epa_registration) IS NULL
                             THEN public._normalize_epa_registration(NEW.epa_registration) IS NULL
                               OR public._normalize_epa_registration(NEW.epa_registration) = c.epa_registration
                               OR public._normalize_epa_registration(NEW.epa_registration)
                                  = public._normalize_epa_registration(p.epa_registration)
                             ELSE public._normalize_epa_registration(NEW.epa_registration)
                                  IS NOT DISTINCT FROM public._normalize_epa_registration(OLD.epa_registration) END) THEN
    RETURN NULL;
  END IF;
  PERFORM public._epa_registration_lock(false);
  INSERT INTO public.invoice_line_rup_captures (invoice_item_id, epa_registration, rup_status, signal_word, source)
  SELECT NEW.id, f.epa_registration, f.rup_status, f.signal_word, 'save'
    FROM public._invoice_line_rup_facts(NEW.product_id, NEW.epa_registration) f
  ON CONFLICT (invoice_item_id) DO UPDATE
    SET epa_registration = EXCLUDED.epa_registration, rup_status = EXCLUDED.rup_status,
        signal_word = EXCLUDED.signal_word, source = EXCLUDED.source, captured_at = now();
  RETURN NULL;
END;
$function$;

-- AFTER, so it reads the row as saved (after trg_fill_invoice_line_epa filled a blank number).
CREATE TRIGGER trg_zz_capture_invoice_line_rup AFTER INSERT OR UPDATE OF product_id, epa_registration
  ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION public._capture_invoice_line_rup();

-- ---------------------------------------------------------------------------------------------
-- 2. The one coverage rule
-- ---------------------------------------------------------------------------------------------

-- A posted line has its restricted-use record when it was captured 'yes' and an active record carries its invoice,
-- product, captured number, captured signal word, unit and unit price, with the quantity and amount of the 'yes'
-- lines sharing all of those (posting writes one per each). A line captured by the seed on an invoice posted before
-- it is also covered by today's rule: an active record for its invoice and product written before the seed.
CREATE FUNCTION public._rup_record_covers_line(p_line public.invoice_items) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.invoice_line_rup_captures c
             JOIN public.rup_sales_records s
               ON s.invoice_id = p_line.invoice_id AND s.product_id = p_line.product_id AND s.voided_at IS NULL
              AND s.epa_registration IS NOT DISTINCT FROM c.epa_registration
              AND s.signal_word IS NOT DISTINCT FROM c.signal_word
              -- a line with no unit records as 'Unit not set' (the record's unit is required)
              AND s.unit = COALESCE(p_line.unit_size, 'Unit not set')
              AND s.unit_price_cents IS NOT DISTINCT FROM p_line.unit_price_cents,
             LATERAL (SELECT sum(o.quantity) AS quantity, sum(o.extended_cents)::bigint AS total_cents
                        FROM public.invoice_items o
                        JOIN public.invoice_line_rup_captures oc ON oc.invoice_item_id = o.id
                       WHERE o.invoice_id = p_line.invoice_id AND o.product_id = p_line.product_id
                         AND oc.rup_status = 'yes'
                         AND oc.epa_registration IS NOT DISTINCT FROM c.epa_registration
                         AND oc.signal_word IS NOT DISTINCT FROM c.signal_word
                         AND COALESCE(o.unit_size, 'Unit not set') = COALESCE(p_line.unit_size, 'Unit not set')
                         AND o.unit_price_cents IS NOT DISTINCT FROM p_line.unit_price_cents) l
            WHERE c.invoice_item_id = p_line.id AND c.rup_status = 'yes'
              AND s.quantity = l.quantity AND s.total_cents IS NOT DISTINCT FROM l.total_cents
              -- a duplicate active record for the key covers nothing (Luna 2026-11-10)
              AND NOT EXISTS (SELECT 1 FROM public.rup_sales_records d
                               WHERE d.invoice_id = s.invoice_id AND d.product_id = s.product_id AND d.voided_at IS NULL
                                 AND d.id <> s.id AND d.epa_registration IS NOT DISTINCT FROM s.epa_registration
                                 AND d.signal_word IS NOT DISTINCT FROM s.signal_word AND d.unit = s.unit
                                 AND d.unit_price_cents IS NOT DISTINCT FROM s.unit_price_cents))
      OR EXISTS (
           SELECT 1
             FROM public.invoice_line_rup_captures c
             JOIN public.epa_registration_seed_run sr ON c.captured_at >= sr.seeded_at
             JOIN public.invoices i ON i.id = p_line.invoice_id AND i.posted_at < sr.seeded_at
             JOIN public.rup_sales_records s
               ON s.invoice_id = p_line.invoice_id AND s.product_id = p_line.product_id AND s.voided_at IS NULL
              AND s.created_at < sr.seeded_at
            WHERE c.invoice_item_id = p_line.id AND c.source = 'seed');
$function$;
ALTER FUNCTION public._rup_record_covers_line(public.invoice_items) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._rup_record_covers_line(public.invoice_items) FROM PUBLIC, anon, authenticated, service_role;

-- A line not captured 'yes' counts as recorded only when an active record carries its captured number, unit and
-- price with the quantity and amount of EVERY captured line sharing them (a record added by hand that includes it).
-- A record holding only a 'yes' sibling never hides it (Astra 2026-11-10).
CREATE FUNCTION public._rup_record_for_line_key(p_line public.invoice_items) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT EXISTS (SELECT 1
                   FROM public.invoice_line_rup_captures c
                   JOIN public.rup_sales_records s
                     ON s.invoice_id = p_line.invoice_id AND s.product_id = p_line.product_id AND s.voided_at IS NULL
                    AND s.epa_registration IS NOT DISTINCT FROM c.epa_registration
                    AND s.unit = COALESCE(p_line.unit_size, 'Unit not set')
                    AND s.unit_price_cents IS NOT DISTINCT FROM p_line.unit_price_cents,
                  LATERAL (SELECT sum(o.quantity) AS quantity, sum(o.extended_cents)::bigint AS total_cents
                             FROM public.invoice_items o
                             JOIN public.invoice_line_rup_captures oc ON oc.invoice_item_id = o.id
                            WHERE o.invoice_id = p_line.invoice_id AND o.product_id = p_line.product_id
                              AND oc.epa_registration IS NOT DISTINCT FROM c.epa_registration
                              AND COALESCE(o.unit_size, 'Unit not set') = COALESCE(p_line.unit_size, 'Unit not set')
                              AND o.unit_price_cents IS NOT DISTINCT FROM p_line.unit_price_cents) l
                  WHERE c.invoice_item_id = p_line.id
                    AND s.quantity = l.quantity AND s.total_cents IS NOT DISTINCT FROM l.total_cents);
$function$;

-- Re-issued from 20261229180000 (same signature and grants): posted lines whose captured number or saved number is
-- p_number and that are not covered.
CREATE OR REPLACE FUNCTION public._epa_registration_unrecorded_posted_lines(p_number text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('invoice_item_id', ii.id, 'invoice_id', ii.invoice_id,
           'invoice_number', i.invoice_number, 'product_id', ii.product_id) ORDER BY ii.id), '[]'::jsonb)
    FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
    LEFT JOIN public.invoice_line_rup_captures c ON c.invoice_item_id = ii.id
   WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL AND ii.product_id IS NOT NULL
     AND (c.epa_registration = p_number OR public._normalize_epa_registration(ii.epa_registration) = p_number)
     AND NOT public._rup_record_covers_line(ii) AND NOT public._rup_record_for_line_key(ii);
$function$;

DO $owners$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._invoice_line_rup_facts(uuid,text)', 'public._capture_invoice_line_rup()',
    'public._rup_record_for_line_key(public.invoice_items)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END
$owners$;

-- ---------------------------------------------------------------------------------------------
-- 3. Posting: generate_rup_sales_records (live body, md5 0cb155a2..., plus the seeded branch)
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

  -- REG-1: the invoice first, then the shared registration lock: the order a save takes (its line write holds the
  -- invoice, then the capture trigger takes the shared lock), so a queued registration edit cannot deadlock them
  -- (Luna 2026-11-10). FOR UPDATE: two postings of one invoice run one after the other (sheet 4.C de-duplication).
  SELECT i.id, i.order_id, o.customer_id, c.farm_name, i.invoice_date,
         i.invoice_number, i.status, i.deleted_at
  INTO v_invoice
  FROM invoices i
  JOIN orders o ON o.id = i.order_id
  JOIN customers c ON c.id = o.customer_id
  WHERE i.id = p_invoice_id
  FOR UPDATE OF i;
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
    -- One record per product, captured number, captured signal word, unit and unit price, holding the 'yes' lines
    -- sharing them (the coverage rule counts the same lines), under the captured number.
    OPEN v_items FOR
      SELECT ii.product_id, p.product_name, sum(ii.quantity) AS quantity,
             COALESCE(ii.unit_size, 'Unit not set') AS unit_size, -- never fail posting on a line with no unit (Sol r4)
             ii.unit_price_cents, sum(ii.extended_cents)::bigint AS extended_cents,
             c.epa_registration, c.signal_word
        FROM invoice_items ii
        JOIN products p ON p.id = ii.product_id
        JOIN invoice_line_rup_captures c ON c.invoice_item_id = ii.id
       WHERE ii.invoice_id = p_invoice_id AND c.rup_status = 'yes'
       GROUP BY ii.product_id, p.product_name, c.epa_registration, c.signal_word,
                COALESCE(ii.unit_size, 'Unit not set'), ii.unit_price_cents
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
      -- REG-1 (Luna 2026-11-10): an invoice posted before the seed whose product already has an active record written
      -- before the seed is covered by today's rule (as in _rup_record_covers_line); never write it a second record.
      IF EXISTS (SELECT 1 FROM epa_registration_seed_run sr
                   JOIN invoices i ON i.id = p_invoice_id AND i.posted_at < sr.seeded_at
                   JOIN rup_sales_records s ON s.invoice_id = p_invoice_id AND s.product_id = v_item.product_id
                    AND s.voided_at IS NULL AND s.created_at < sr.seeded_at) THEN
        CONTINUE;
      END IF;
      -- REG-1 (Luna 2026-11-10): two active records for one key are a duplicate a person must void; never pick one.
      IF (SELECT count(*) FROM rup_sales_records r
           WHERE r.invoice_id = p_invoice_id AND r.product_id = v_item.product_id
             AND r.epa_registration IS NOT DISTINCT FROM v_item.epa_registration
             AND r.signal_word IS NOT DISTINCT FROM v_item.signal_word
             AND r.unit = v_item.unit_size
             AND r.unit_price_cents IS NOT DISTINCT FROM v_item.unit_price_cents
             AND r.voided_at IS NULL) > 1 THEN
        RAISE EXCEPTION 'RUP_RECORD_CONFLICT: invoice % has more than one active restricted-use record for % at this number, unit and price; void the extra one',
          v_invoice.invoice_number, v_item.product_name;
      END IF;
      -- REG-1: one active record per invoice, product, number, signal word, unit and unit price (the coverage rule);
      -- one that disagrees with what this posting would write is an error, never skipped.
      SELECT r.quantity, r.total_cents INTO v_rec_qty, v_rec_total FROM rup_sales_records r
       WHERE r.invoice_id = p_invoice_id AND r.product_id = v_item.product_id
         AND r.epa_registration IS NOT DISTINCT FROM v_item.epa_registration
         AND r.signal_word IS NOT DISTINCT FROM v_item.signal_word
         AND r.unit = v_item.unit_size
         AND r.unit_price_cents IS NOT DISTINCT FROM v_item.unit_price_cents
         AND r.voided_at IS NULL
       -- a disagreeing record sorts first, so any one of several active records that disagrees is refused
       ORDER BY (r.quantity IS DISTINCT FROM v_item.quantity OR r.total_cents IS DISTINCT FROM v_item.extended_cents) DESC,
                r.id LIMIT 1;
      IF FOUND THEN
        IF v_rec_qty IS DISTINCT FROM v_item.quantity OR v_rec_total IS DISTINCT FROM v_item.extended_cents THEN
          RAISE EXCEPTION 'RUP_RECORD_CONFLICT: invoice % already has a restricted-use record for % at this number, unit and price with a different quantity or amount',
            v_invoice.invoice_number, v_item.product_name;
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

  v_result := jsonb_build_object('count', v_count, 'invoice_id', p_invoice_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'generate_rup_sales_records', v_result);
  END IF;

  RETURN v_count;
END;
$function$;
ALTER FUNCTION public.generate_rup_sales_records(uuid, text) OWNER TO postgres;

-- ---------------------------------------------------------------------------------------------
-- 4. Posted sales a person should check (admin, read-only; sheet 4.C)
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
           c.epa_registration, public._normalize_epa_registration(ii.epa_registration) AS saved_number,
           ii.quantity, c.rup_status, c.source AS capture_source,
           r.rup_status AS registration_rup_status_now, lr.rup_status AS saved_registration_rup_status_now,
           public._rup_record_covers_line(ii) AS covered, public._rup_record_for_line_key(ii) AS has_record
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN products p ON p.id = ii.product_id
      LEFT JOIN invoice_line_rup_captures c ON c.invoice_item_id = ii.id
      LEFT JOIN epa_registrations r ON r.epa_registration = c.epa_registration
      LEFT JOIN epa_registrations lr ON lr.epa_registration = public._normalize_epa_registration(ii.epa_registration)
     WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL
  ), judged AS (
    SELECT l.*,
           CASE WHEN rup_status IS NULL THEN 'not_captured'
                WHEN epa_registration IS NULL AND (rup_status = 'yes' OR has_record) THEN 'no_epa_number'
                WHEN rup_status = 'yes' AND NOT covered THEN 'restricted_use_to_record'
                WHEN rup_status = 'yes' THEN NULL
                WHEN has_record THEN NULL
                WHEN registration_rup_status_now = 'yes' OR saved_registration_rup_status_now = 'yes' THEN 'now_restricted_use'
                WHEN rup_status = 'unknown'
                 AND ((epa_registration IS NOT NULL AND COALESCE(registration_rup_status_now, 'unknown') = 'unknown')
                      OR (saved_number IS NOT NULL AND COALESCE(saved_registration_rup_status_now, 'unknown') = 'unknown'))
                  THEN 'not_reviewed'
                ELSE NULL END AS reason
      FROM lines l
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'line_id', line_id, 'invoice_id', invoice_id, 'invoice_number', invoice_number, 'invoice_date', invoice_date,
           'product_id', product_id, 'product_name', product_name, 'epa_registration', epa_registration,
           'saved_number', saved_number, 'quantity', quantity, 'captured_rup_status', rup_status,
           'capture_source', capture_source, 'registration_rup_status', registration_rup_status_now,
           'has_record', covered OR has_record, 'reason', reason)
           ORDER BY invoice_date, invoice_number, line_id), '[]'::jsonb)
    INTO v_out
    FROM judged
   WHERE reason IS NOT NULL;
  RETURN v_out;
END;
$function$;
ALTER FUNCTION public.get_epa_sales_to_check() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_epa_sales_to_check() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_epa_sales_to_check() TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Q7 (invoice_items half): no direct line writes from the app roles
-- ---------------------------------------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE ON TABLE public.invoice_items FROM anon, authenticated;
-- A table REVOKE leaves column grants in place; revoke those explicitly too (none live 2026-11-10).
DO $q7_columns$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.invoice_items'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE INSERT (%1$s), UPDATE (%1$s) ON TABLE public.invoice_items FROM anon, authenticated', v_cols);
END
$q7_columns$;

DO $postflight$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, 'public.invoice_items', 'INSERT')
       OR has_table_privilege(v_role, 'public.invoice_items', 'UPDATE')
       OR has_table_privilege(v_role, 'public.invoice_items', 'DELETE')
       OR has_any_column_privilege(v_role, 'public.invoice_items', 'INSERT')
       OR has_any_column_privilege(v_role, 'public.invoice_items', 'UPDATE')
       OR has_any_column_privilege(v_role, 'public.invoice_line_rup_captures', 'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'POSTFLIGHT_RUP_RECORDS_BY_SOLD_NUMBER: % can write or delete invoice_items or read captures', v_role;
    END IF;
  END LOOP;
  IF has_table_privilege('service_role', 'public.invoice_line_rup_captures', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('metabase_ro', 'public.invoice_line_rup_captures', 'SELECT')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.invoice_line_rup_captures'::regclass)
     OR has_function_privilege('authenticated', 'public._rup_record_covers_line(public.invoice_items)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._rup_record_for_line_key(public.invoice_items)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._invoice_line_rup_facts(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._capture_invoice_line_rup()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._epa_registration_unrecorded_posted_lines(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_epa_sales_to_check()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_epa_sales_to_check()', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM public.invoice_line_rup_captures) THEN
    RAISE EXCEPTION 'POSTFLIGHT_RUP_RECORDS_BY_SOLD_NUMBER_WRONG';
  END IF;
END;
$postflight$;
