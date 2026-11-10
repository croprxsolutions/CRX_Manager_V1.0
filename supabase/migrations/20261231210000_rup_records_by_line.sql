-- Written 2026-11-10. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261231210000_rup_records_by_line.md (REG-1 Step 2, file 2 of 3).
-- Re-read the live ledger before applying.
--
-- WHY: REG-1 Step 2 part C, redesigned (docs/plans/2026-11-10-reg1-step2-record-line-link-CONTRACT.md). PR #1688
--   matched restricted-use records to invoice lines by an inferred key (number, unit, price, signal word, customer,
--   order) and never converged. Here a record names its line: rup_sales_records.invoice_item_id.
--   Kept (Mason, 2026-11-09/10): the answer is captured when the line is saved; any Yes makes it restricted use;
--   a Yes always wins; the number is the product's own; a missing number never blocks a sale.
--   New (Mason, 2026-11-10): a return credit never creates or needs a record; voiding an invoice voids its records;
--   field-application invoices get records; no sales are made before the switch-on, so old data is out of scope.
--
-- WHAT:
--   - rup_sales_records.invoice_item_id (FK, ON DELETE SET NULL), an active record must have its line, one active
--     record per line, and trg_rup_sales_record_line: an active record's line is on its invoice, with its product,
--     and that invoice is posted and not a return credit.
--   - trg_zz_void_rup_records_off_posted (deferred, on invoices): at commit, an invoice that is no longer posted,
--     paid or overdue (voided, cancelled, unposted, deleted) has its active records voided. unpost_invoice still
--     voids its own first and reports the count; this catches every other path without re-issuing void_invoice.
--   - invoice_line_rup_captures, _invoice_line_rup_facts and the capture trigger (as built for #1688).
--   - generate_rup_sales_records re-issued (md5 pinned): after the seed, one record per line captured Yes with a
--     quantity above zero and no active record. Return credits write nothing. Field applications record under the
--     invoice's customer; other invoices under the order's customer (unchanged), else the invoice's.
--   - _epa_registration_unrecorded_posted_lines re-issued and get_epa_sales_to_check() (admin, read-only): a line is
--     recorded when an active record links to it.
--   - Only the posting function, unpost_invoice and the void trigger write records: INSERT, UPDATE, DELETE and
--     TRUNCATE revoked from anon, authenticated and service_role, the admin insert policy dropped. Q7 (invoice_items
--     half): INSERT, UPDATE, DELETE and TRUNCATE revoked from anon and authenticated (service_role keeps its writes).
--
-- ACCEPTED (Mason, 2026-11-10): a save that deletes and re-inserts lines captures them again. The list is unpaged.
--   A posted line that turns restricted use later is listed for a person; recording it from the list is a later step.
--
-- NOT CHANGED: invoice saving, _fill_invoice_line_epa, the posting wrappers, unpost_invoice, void_invoice, and the
--   applicator-licence pick inside the generator.
--
-- ROLLBACK (its own reviewed migration, forward repair): keep the link column and the captures.
--
-- ORDERING: after 20261231200000_epa_registration_tools; before 20261231220000.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE rup_records_by_line_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.rup_records_by_line_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.rup_records_by_line_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'RUP_RECORDS_BY_LINE_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._epa_registration_unrecorded_posted_lines(text)') IS NULL THEN
    RAISE EXCEPTION 'RUP_RECORDS_BY_LINE_PREFLIGHT: apply 20261231200000_epa_registration_tools first';
  END IF;
  IF to_regprocedure('public.get_epa_sales_to_check()') IS NOT NULL
     OR to_regclass('public.invoice_line_rup_captures') IS NOT NULL THEN
    RAISE EXCEPTION 'RUP_RECORDS_BY_LINE_PREFLIGHT: this file was already applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public.generate_rup_sales_records(uuid,text)')
                    AND md5(replace(p.prosrc, chr(13), '')) = '0cb155a27c654dd390a875c3ff3aa507'
                    AND p.proowner = 'postgres'::regrole AND p.prosecdef) THEN
    RAISE EXCEPTION 'RUP_RECORDS_BY_LINE_PREFLIGHT: generate_rup_sales_records drifted from the body this file was written from';
  END IF;
  -- No backfill (Mason, 2026-11-10: no sales before the switch-on; live had 0 records). Locked so none arrives meanwhile.
  -- invoices first: the order posting takes them, so this file cannot deadlock a posting. invoice_items next, taken
  -- up front rather than by the DDL below, so a save cannot hold lines while this file waits on them (reviews r2).
  LOCK TABLE public.invoices IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.invoice_items IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.rup_sales_records IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.rup_sales_records WHERE voided_at IS NULL) THEN
    RAISE EXCEPTION 'RUP_RECORDS_BY_LINE_PREFLIGHT: an active restricted-use record exists; void it first (it has no line to link)';
  END IF;
  -- The capture reads the line's number after this trigger has filled a blank one (it must stay BEFORE).
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.invoice_items'::regclass
                    AND t.tgname = 'trg_fill_invoice_line_epa' AND NOT t.tgisinternal AND (t.tgtype & 2) = 2) THEN
    RAISE EXCEPTION 'RUP_RECORDS_BY_LINE_PREFLIGHT: trg_fill_invoice_line_epa is missing or no longer BEFORE';
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
DECLARE
  v_same_product boolean;
BEGIN
  IF NOT public._epa_registrations_seeded() THEN
    RETURN NULL;  -- before the seed nothing is captured; the seed captures every line that exists
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

-- AFTER, so it reads the row as saved (after trg_fill_invoice_line_epa filled a blank number). Every column: the
-- function decides whether the product or the saved number changed.
CREATE TRIGGER trg_zz_capture_invoice_line_rup AFTER INSERT OR UPDATE
  ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION public._capture_invoice_line_rup();

-- ---------------------------------------------------------------------------------------------
-- 2. A record names its line
-- ---------------------------------------------------------------------------------------------

-- SET NULL: a voided record outlives its line (an unposted invoice's lines are deleted and rebuilt on save) and keeps
-- the sale facts as text. An active record cannot lose its line: the CHECK refuses the SET NULL.
ALTER TABLE public.rup_sales_records
  ADD COLUMN invoice_item_id uuid REFERENCES public.invoice_items(id) ON DELETE SET NULL,
  ADD CONSTRAINT rup_sales_records_active_has_line CHECK (invoice_item_id IS NOT NULL OR voided_at IS NOT NULL);
CREATE UNIQUE INDEX rup_sales_records_one_active_per_line ON public.rup_sales_records (invoice_item_id) WHERE voided_at IS NULL;
CREATE INDEX idx_rup_sales_records_invoice_item ON public.rup_sales_records (invoice_item_id);

-- An active record's line is on the record's invoice with the record's product, and the invoice is a posted sale.
CREATE FUNCTION public._guard_rup_sales_record_line() RETURNS trigger
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
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_rup_sales_record_line BEFORE INSERT OR UPDATE ON public.rup_sales_records
  FOR EACH ROW WHEN (NEW.voided_at IS NULL) EXECUTE FUNCTION public._guard_rup_sales_record_line();

-- At commit, an invoice that is not posted, paid or overdue (or is deleted) keeps no active record (Mason,
-- 2026-11-10: voiding an invoice voids them). Deferred so unpost_invoice, which voids its own after changing the
-- status and reports the count, finds them first; every other path (void, group void, batch void) is caught here.
CREATE FUNCTION public._void_rup_records_off_posted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  UPDATE public.rup_sales_records s
     SET voided_at = now(), voided_by = auth.uid(),
         void_reason = 'Invoice ' || COALESCE(i.invoice_number, '') || ' '
                       || CASE WHEN i.deleted_at IS NOT NULL THEN 'deleted' ELSE COALESCE(i.status, 'without a status') END
    FROM public.invoices i
   WHERE i.id = NEW.id AND s.invoice_id = i.id AND s.voided_at IS NULL
     AND (i.deleted_at IS NOT NULL OR i.status IS NULL OR i.status NOT IN ('posted', 'paid', 'overdue'));
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER trg_zz_void_rup_records_off_posted AFTER UPDATE ON public.invoices
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION public._void_rup_records_off_posted();

-- Re-issued from 20261231200000 (same signature and grants): posted sale lines under p_number (captured, saved on
-- the line, or the product's number now) with no active record.
CREATE OR REPLACE FUNCTION public._epa_registration_unrecorded_posted_lines(p_number text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('invoice_item_id', ii.id, 'invoice_id', ii.invoice_id,
           'invoice_number', i.invoice_number, 'product_id', ii.product_id) ORDER BY ii.id), '[]'::jsonb)
    FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
    JOIN public.products p ON p.id = ii.product_id
    LEFT JOIN public.invoice_line_rup_captures c ON c.invoice_item_id = ii.id
   WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL AND i.invoice_type <> 'credit_memo'
     AND ii.quantity > 0
     AND (c.epa_registration = p_number OR public._normalize_epa_registration(ii.epa_registration) = p_number
          OR public._normalize_epa_registration(p.epa_registration) = p_number)
     AND NOT EXISTS (SELECT 1 FROM public.rup_sales_records s WHERE s.invoice_item_id = ii.id AND s.voided_at IS NULL);
$function$;

DO $owners$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._invoice_line_rup_facts(uuid,text)', 'public._capture_invoice_line_rup()',
    'public._guard_rup_sales_record_line()', 'public._void_rup_records_off_posted()']
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
         i.invoice_number, i.status, i.deleted_at, i.invoice_type
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
    -- One record per line captured 'yes' that has none: the record names its line, so nothing is matched or grouped.
    OPEN v_items FOR
      SELECT ii.id AS invoice_item_id, ii.product_id, p.product_name, ii.quantity,
             COALESCE(NULLIF(btrim(ii.unit_size), ''), 'Unit not set') AS unit_size, -- never fail posting on a line with no unit (Sol r4)
             ii.unit_price_cents, ii.extended_cents, c.epa_registration, c.signal_word
        FROM invoice_items ii
        JOIN products p ON p.id = ii.product_id
        JOIN invoice_line_rup_captures c ON c.invoice_item_id = ii.id
       WHERE ii.invoice_id = p_invoice_id AND c.rup_status = 'yes' AND ii.quantity > 0
         AND NOT EXISTS (SELECT 1 FROM rup_sales_records r WHERE r.invoice_item_id = ii.id AND r.voided_at IS NULL)
       ORDER BY ii.id;
  ELSE
    OPEN v_items FOR
    SELECT ii.id AS invoice_item_id, ii.product_id, p.product_name, ii.quantity,
           COALESCE(NULLIF(btrim(ii.unit_size), ''), 'Unit not set') AS unit_size,  -- as the seeded branch: a missing unit never blocks a post
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
        season, created_by
      ) VALUES (
        p_invoice_id, v_item.invoice_item_id, v_invoice.order_id, v_invoice.customer_id, v_item.product_id,
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
           -- any Yes now: the product's tick, or the registration of the captured number, the number saved on the
           -- line, or the product's number today (Mason, 2026-11-10, Sol r10)
           COALESCE(p.is_rup, false) OR r.rup_status = 'yes' OR lr.rup_status = 'yes' OR pr.rup_status = 'yes' AS yes_now,
           r.rup_status AS registration_rup_status_now, lr.rup_status AS saved_registration_rup_status_now,
           EXISTS (SELECT 1 FROM rup_sales_records s WHERE s.invoice_item_id = ii.id AND s.voided_at IS NULL) AS has_record
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN products p ON p.id = ii.product_id
      LEFT JOIN invoice_line_rup_captures c ON c.invoice_item_id = ii.id
      LEFT JOIN epa_registrations r ON r.epa_registration = c.epa_registration
      LEFT JOIN epa_registrations lr ON lr.epa_registration = public._normalize_epa_registration(ii.epa_registration)
      LEFT JOIN epa_registrations pr ON pr.epa_registration = public._normalize_epa_registration(p.epa_registration)
     -- a return credit is never a sale to record (Mason, 2026-11-10); neither is a zero or negative line
     WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL AND i.invoice_type <> 'credit_memo'
       AND ii.quantity > 0
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
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'line_id', line_id, 'invoice_id', invoice_id, 'invoice_number', invoice_number, 'invoice_date', invoice_date,
           'product_id', product_id, 'product_name', product_name, 'epa_registration', epa_registration,
           'saved_number', saved_number, 'quantity', quantity, 'captured_rup_status', rup_status,
           'capture_source', capture_source, 'registration_rup_status', registration_rup_status_now,
           'has_record', has_record, 'reason', reason)
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

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.invoice_items FROM anon, authenticated;
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

-- Only the posting function (and unpost_invoice, the void trigger) writes restricted-use records, so a record's line,
-- invoice and product always belong together. No screen writes this table.
DROP POLICY IF EXISTS rup_sales_insert ON public.rup_sales_records;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.rup_sales_records FROM anon, authenticated, service_role;
DO $rup_columns$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.rup_sales_records'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE INSERT (%1$s), UPDATE (%1$s) ON TABLE public.rup_sales_records FROM anon, authenticated, service_role', v_cols);
END
$rup_columns$;

DO $postflight$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, 'public.invoice_items', 'INSERT')
       OR has_table_privilege(v_role, 'public.invoice_items', 'UPDATE')
       OR has_table_privilege(v_role, 'public.invoice_items', 'DELETE')
       OR has_table_privilege(v_role, 'public.invoice_items', 'TRUNCATE')
       OR has_any_column_privilege(v_role, 'public.invoice_items', 'INSERT')
       OR has_any_column_privilege(v_role, 'public.invoice_items', 'UPDATE')
       OR has_table_privilege(v_role, 'public.rup_sales_records', 'INSERT')
       OR has_table_privilege(v_role, 'public.rup_sales_records', 'UPDATE')
       OR has_table_privilege(v_role, 'public.rup_sales_records', 'DELETE')
       OR has_any_column_privilege(v_role, 'public.rup_sales_records', 'INSERT')
       OR has_any_column_privilege(v_role, 'public.rup_sales_records', 'UPDATE')
       OR has_any_column_privilege(v_role, 'public.invoice_line_rup_captures', 'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'POSTFLIGHT_RUP_RECORDS_BY_LINE: % can write or delete invoice_items or read captures', v_role;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'public.rup_sales_records', 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_any_column_privilege(v_role, 'public.rup_sales_records', 'INSERT,UPDATE')
       OR has_table_privilege(v_role, 'public.invoice_line_rup_captures', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_function_privilege(v_role, 'public._guard_rup_sales_record_line()', 'EXECUTE')
       OR has_function_privilege(v_role, 'public._void_rup_records_off_posted()', 'EXECUTE')
       OR has_function_privilege(v_role, 'public._invoice_line_rup_facts(uuid,text)', 'EXECUTE')
       OR has_function_privilege(v_role, 'public._capture_invoice_line_rup()', 'EXECUTE')
       OR has_function_privilege(v_role, 'public._epa_registration_unrecorded_posted_lines(text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_RUP_RECORDS_BY_LINE: % can write restricted-use records, touch captures or run a private helper', v_role;
    END IF;
  END LOOP;
  -- The re-issue keeps the generator's owner, mode and grants (authenticated and service_role, never anon).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.generate_rup_sales_records(uuid,text)')
                    AND p.proowner = 'postgres'::regrole AND p.prosecdef
                    AND p.proconfig @> ARRAY['search_path=public, pg_temp'])
     OR has_function_privilege('anon', 'public.generate_rup_sales_records(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.generate_rup_sales_records(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_RUP_RECORDS_BY_LINE: generate_rup_sales_records lost its owner, mode, search_path or grants';
  END IF;
  IF has_table_privilege('service_role', 'public.invoice_line_rup_captures', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('metabase_ro', 'public.invoice_line_rup_captures', 'SELECT')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.invoice_line_rup_captures'::regclass)
     OR has_function_privilege('authenticated', 'public._guard_rup_sales_record_line()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._void_rup_records_off_posted()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._invoice_line_rup_facts(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._capture_invoice_line_rup()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._epa_registration_unrecorded_posted_lines(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_epa_sales_to_check()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_epa_sales_to_check()', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM public.invoice_line_rup_captures) THEN
    RAISE EXCEPTION 'POSTFLIGHT_RUP_RECORDS_BY_LINE_WRONG';
  END IF;
END;
$postflight$;
