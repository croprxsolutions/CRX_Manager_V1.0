-- idempotency-body-check: exempt
-- (correct_product_parent_identity checks its retry key through _product_parent_replay, which calls
--  check_idempotency, and saves its receipt with save_idempotency last, in the same transaction;
--  the same pattern as 20261108120000_product_parents.sql.)
--
-- Written 2026-11-06. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261207113000_parent_epa_correction.md.
-- Re-read the live ledger before applying.
--
-- WHY (Mason, 2026-11-06: "yes i want to be able to fix epa issues"): a parent's EPA number can be
--   corrected only once every old record that shows an EPA number keeps its own copy (build sheet
--   docs/plans/2026-11-04-product-stage2-BUILD-SHEET.md, PAR-1 identity correction; DECISION_LOG
--   2026-10-30). The reader trace is in docs/reference/product-corrections-record-map.md. Sprayed
--   and finished jobs got their kept numbers in 20261204120000_job_lines_keep_epa_number
--   (job_product_epa, locked per job and product when a spray is saved or the job is finished); a job
--   not sprayed yet shows the product's current number. This file adds the invoice-line copy rule and
--   the correction itself; the switch stays OFF here. A later migration (with the printouts that read
--   job_product_epa) turns it on.
--
-- WHAT:
--   - invoice_items: a line written with no EPA number, saved with none on a draft or unposted invoice,
--     or moved to another product without one, gets the product's number (chemical-sale lines were still
--     made blank, and blank lines print the product's current number). A posted invoice's blank line is
--     never filled by an unrelated edit. No existing invoice line is written by this file.
--   - No reader changes here (Mason, 2026-11-06, simpler plan): every printout, the sent proof and the
--     year-end summary still show what they show today.
--   - The parent identity correction can change the generic EPA number: the parent, every size
--     (under the parent copy pass) take the new number in one transaction with one logged event; jobs
--     not sprayed yet show it because they read the product's number. Sprayed and finished jobs (their
--     job_product_epa rows), invoices and restricted-use records keep the number they were made with. It is
--     refused while any invoice line for a size whose number would change has no EPA copy of its own
--     (that line would follow the change); the message names the invoices. And it stays refused while
--     _product_parent_epa_correction_enabled() is false, which this file creates as false.
--
-- NOT CHANGED: purchase orders show the product's current number (a buying request, not a
--   compliance record; record map). Restricted-use sale records still copy the product's number
--   when posted. The job and invoice writers, prices, costs and inventory. _insert_parent_size (its
--   notes change went live in 20261202110000).
--
-- LOCKS: the correction locks the parent and its sizes (_lock_product_parent) and writes only
--   product_parents and products; it locks no job or job line. A spray saved at the same time locks its
--   job and then takes FOR KEY SHARE on the products, which a non-key EPA update does not conflict with,
--   so the two never wait on each other: a spray that read the number before the correction committed
--   keeps the old number even if it commits after (a save in the same instant as the correction; accepted:
--   the spray keeps the number it was saved against, Luna 2026-11-07). The invoice trigger reads the product FOR SHARE.
--
-- ROLLBACK (its own reviewed migration): re-emit _product_parent_identity_after and
--   correct_product_parent_identity from their previous live bodies, drop trg_fill_invoice_line_epa
--   and _fill_invoice_line_epa, and drop _product_parent_epa_correction_enabled.
--
-- ORDERING: apply after 20261204120000_job_lines_keep_epa_number and every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE parent_epa_correction_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Two steps: outside a transaction the ON COMMIT DROP table is already gone.
  IF to_regclass('pg_temp.parent_epa_correction_tx') IS NULL THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.parent_epa_correction_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  -- The job half must be live first: sprayed and finished jobs keep their numbers, so a correction
  -- reaches only jobs not sprayed yet.
  IF to_regclass('public.job_product_epa') IS NULL
     OR to_regprocedure('public._job_epa_freeze(uuid)') IS NULL
     OR (SELECT count(*) FROM pg_trigger
          WHERE tgname IN ('trg_job_epa_freeze_on_spray', 'trg_job_epa_freeze_on_finish', 'trg_job_line_epa_lock')
            AND tgenabled = 'O' AND NOT tgisinternal) <> 3 THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_PREFLIGHT: apply 20261204120000_job_lines_keep_epa_number first';
  END IF;
  IF to_regprocedure('public._epa_norm(text)') IS NULL THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_PREFLIGHT: apply 20261204120000_job_lines_keep_epa_number first';
  END IF;
  IF to_regprocedure('public._product_parent_epa_correction_enabled()') IS NOT NULL
     OR to_regprocedure('public._fill_invoice_line_epa()') IS NOT NULL THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_PREFLIGHT: this file was already applied';
  END IF;
  -- Every function re-emitted or relied on here must still be the body this file was written from.
  IF (SELECT count(*) FROM pg_proc p
       WHERE (p.oid, md5(replace(p.prosrc, chr(13), ''))) IN (
         ('public._product_parent_identity_after(public.product_parents,jsonb)'::regprocedure, '397f1abfcab8109b98d78f5ef04ba57d'),
         ('public.correct_product_parent_identity(uuid,bigint,jsonb,text,text,text)'::regprocedure, 'bfb4e966b4ea0f7a57d538ee75083f0c'),
         ('public._copy_parent_to_size(uuid,uuid,bigint,boolean,boolean,boolean)'::regprocedure, 'e2121d5ec1d23dbb4127fa8eac20c33f'))
         AND p.proowner = 'postgres'::regrole) <> 3 THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_PREFLIGHT: a re-emitted function drifted from the body this file was written from';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Invoice lines are never written without the product's EPA number
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public._fill_invoice_line_epa() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
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

CREATE TRIGGER trg_fill_invoice_line_epa BEFORE INSERT OR UPDATE ON public.invoice_items
FOR EACH ROW EXECUTE FUNCTION public._fill_invoice_line_epa();

-- ---------------------------------------------------------------------------------------------
-- 2. The parent EPA correction (switched off until the screens that read the copies ship)
-- ---------------------------------------------------------------------------------------------

-- The switch. Only a reviewed migration changes it (build sheet, PAR-1 identity correction).
CREATE FUNCTION public._product_parent_epa_correction_enabled() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $function$ SELECT false $function$;
ALTER FUNCTION public._product_parent_epa_correction_enabled() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_epa_correction_enabled() FROM PUBLIC, anon, authenticated, service_role;

-- Checks p_changes; returns the parent's identity after the change. An EPA number change is
-- refused while switched off, when it is not a valid EPA number, and while any invoice line for a
-- size whose number would change has no EPA copy of its own (that line would show the new number).
-- A line for a size with no number showed none, so giving it the corrected one changes no number
-- it showed; a reader falling back to the size then shows the added one (Mason, 2026-11-07: "Yes,
-- allow it"; DECISION_LOG).
CREATE OR REPLACE FUNCTION public._product_parent_identity_after(p_parent public.product_parents, p_changes jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_epa text := p_parent.generic_epa_registration;
  v_unsaved text;
BEGIN
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN ('formulation_type', 'safener', 'generic_epa_registration'))
     OR EXISTS (SELECT 1 FROM jsonb_each(p_changes) e WHERE jsonb_typeof(e.value) NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: the identity correction takes formulation_type, safener and generic_epa_registration';
  END IF;
  IF p_changes ? 'generic_epa_registration'
     AND public._normalize_epa_registration(p_changes->>'generic_epa_registration') IS DISTINCT FROM p_parent.generic_epa_registration THEN
    IF NOT public._product_parent_epa_correction_enabled() THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_EPA_CORRECTION_OFF: EPA number correction is switched off until the screens that keep old records'' EPA numbers are live';
    END IF;
    v_epa := public._normalize_epa_registration(p_changes->>'generic_epa_registration');
    -- The same rule every product's EPA number follows (guard_product_setup_fields).
    IF v_epa IS NOT NULL AND v_epa !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: "%" is not an EPA number (for example 524-475 or 100-1070-12345)', v_epa;
    END IF;
    SELECT string_agg(DISTINCT COALESCE(i.invoice_number, i.id::text) || ' (' || i.status || ')', ', ')
      INTO v_unsaved
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
      JOIN public.product_parent_members m ON m.product_id = ii.product_id
      JOIN public.products p ON p.id = ii.product_id
     WHERE m.parent_id = p_parent.id AND i.deleted_at IS NULL AND public._epa_norm(ii.epa_registration) IS NULL
       AND public._epa_norm(p.epa_registration) IS NOT NULL
       AND public._epa_norm(p.epa_registration) IS DISTINCT FROM v_epa;
    IF v_unsaved IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_EPA_RECORD_UNSAVED: invoice % has a line for this product with no saved EPA number, so it would change too. Open and save a draft invoice to give it one; a posted one must be unposted, saved and posted again', v_unsaved;
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'formulation_type', CASE WHEN p_changes ? 'formulation_type' THEN NULLIF(btrim(p_changes->>'formulation_type'), '') ELSE p_parent.formulation_type END,
    'safener', CASE WHEN p_changes ? 'safener' THEN NULLIF(btrim(p_changes->>'safener'), '') ELSE p_parent.safener END,
    'generic_epa_registration', v_epa);
END;
$function$;

CREATE OR REPLACE FUNCTION public.correct_product_parent_identity(p_parent_id uuid, p_expected_parent_version bigint,
  p_changes jsonb, p_reason text, p_evidence text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_receipt jsonb;
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'parent_id', p_parent_id,
    'expected_parent_version', p_expected_parent_version, 'changes', p_changes,
    'reason', btrim(p_reason), 'evidence', btrim(p_evidence))::text);
  v_existing jsonb;
  v_reason text;
  v_evidence text;
  v_before public.product_parents%ROWTYPE;
  v_parent public.product_parents%ROWTYPE;
  v_after jsonb;
  v_sizes uuid[];
  v_size uuid;
  v_event bigint;
  v_affected jsonb := '[]'::jsonb;
  v_open_lines integer := 0;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'correct_product_parent_identity', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', true);
  v_evidence := public._product_parent_reason(p_evidence, 'evidence', true);
  v_sizes := public._lock_product_parent(p_parent_id, p_expected_parent_version);
  SELECT * INTO v_before FROM public.product_parents WHERE id = p_parent_id;
  v_after := public._product_parent_identity_after(v_before, p_changes);
  IF v_after->>'formulation_type' IS NOT DISTINCT FROM v_before.formulation_type
     AND v_after->>'safener' IS NOT DISTINCT FROM v_before.safener
     AND v_after->>'generic_epa_registration' IS NOT DISTINCT FROM v_before.generic_epa_registration THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_NO_CHANGE: the correction matches the current values';
  END IF;
  UPDATE public.product_parents SET formulation_type = v_after->>'formulation_type', safener = v_after->>'safener',
    generic_epa_registration = v_after->>'generic_epa_registration',
    parent_version = parent_version + 1, updated_by = v_actor, updated_at = now()
  WHERE id = p_parent_id RETURNING * INTO v_parent;
  v_event := public._next_product_parent_event_id();
  IF v_parent.generic_epa_registration IS DISTINCT FROM v_before.generic_epa_registration THEN
    -- Lines of jobs not sprayed yet show the corrected number (they read the product's); a product a
    -- sprayed or finished job kept (job_product_epa) keeps its number.
    SELECT count(*) INTO v_open_lines FROM public.job_chemicals jc
      JOIN public.products p ON p.id = jc.product_id
      JOIN public.jobs j ON j.id = jc.job_id
     WHERE jc.product_id = ANY(v_sizes) AND j.deleted_at IS NULL
       AND public._epa_norm(p.epa_registration) IS DISTINCT FROM public._epa_norm(v_parent.generic_epa_registration)
       AND NOT EXISTS (SELECT 1 FROM public.job_product_epa k
                        WHERE k.job_id = jc.job_id AND k.product_id = jc.product_id);
    -- Every size takes the number under the copy pass (the guard refuses it on one size alone).
    FOREACH v_size IN ARRAY v_sizes LOOP
      v_affected := v_affected || public._copy_parent_to_size(p_parent_id, v_size, v_event, false, false, true);
    END LOOP;
  END IF;
  PERFORM public._product_parent_event(v_event, p_parent_id, 'identity_corrected', v_reason, v_evidence,
    public._product_parent_values(v_before), public._product_parent_values(v_parent), v_affected);
  v_receipt := jsonb_build_object('parent_id', p_parent_id, 'parent_version', v_parent.parent_version, 'event_id', v_event,
    'sizes', v_affected, 'open_job_lines', v_open_lines);
  PERFORM public.save_idempotency(p_idempotency_key, 'correct_product_parent_identity',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;

-- Postconditions: grants unchanged on the re-emitted functions; the switch is off.
DO $postflight$
BEGIN
  IF (SELECT proacl FROM pg_proc WHERE oid = 'public.correct_product_parent_identity(uuid,bigint,jsonb,text,text,text)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'authenticated=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._product_parent_identity_after(public.product_parents,jsonb)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[] THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_POSTCONDITION: a re-emitted function''s grants changed';
  END IF;
  IF public._product_parent_epa_correction_enabled() THEN
    RAISE EXCEPTION 'PARENT_EPA_CORRECTION_POSTCONDITION: EPA correction must stay off in this file';
  END IF;
END
$postflight$;
