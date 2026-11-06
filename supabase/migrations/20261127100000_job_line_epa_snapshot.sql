-- idempotency-body-check: exempt
-- (correct_product_parent_identity checks its retry key through _product_parent_replay, which calls
--  check_idempotency, and saves its receipt with save_idempotency last, in the same transaction;
--  the same pattern as 20261108120000_product_parents.sql.)
--
-- Written 2026-11-06. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261127100000_job_line_epa_snapshot.md.
-- Re-read the live ledger before applying.
--
-- WHY (Mason, 2026-11-06: "yes i want to be able to fix epa issues"): a parent's EPA number can be
--   corrected only once every old record that shows an EPA number keeps its own copy (build sheet
--   docs/plans/2026-11-04-product-stage2-BUILD-SHEET.md, PAR-1 identity correction; DECISION_LOG
--   2026-10-30). The reader trace is in docs/reference/product-corrections-record-map.md. This file
--   adds the missing copies and the correction itself; the switch stays OFF here. A later migration
--   (with the screens that read job_chemicals.epa_registration) turns it on.
--
-- WHAT:
--   - New column job_chemicals.epa_registration: the EPA number a spray-job line carries. A trigger
--     sets it from the product whenever a line is inserted or its product changes, whichever path
--     writes the line (save_job, recipes, quote sections). A line inserted into a sprayed or finished
--     job keeps a number its writer supplies (no app role can write this column; the screens PR has
--     save_job pass each line's number back); otherwise it takes the product's. Existing lines get their product's number
--     today, which is what every printout shows today. Read-only to the app (SELECT grant only).
--   - invoice_items: a line written with no EPA number, saved with none on a draft or unposted invoice,
--     or moved to another product without one, gets the product's number (chemical-sale lines were still
--     made blank, and blank lines print the product's current number). A posted invoice's blank line is
--     never filled by an unrelated edit. No existing invoice line is written by this file.
--   - No reader changes here (Mason, 2026-11-06, simpler plan): every printout, the sent proof and the
--     year-end summary still show what they show today. The screens PR switches the readers to the
--     copies and has the job screen send each line's number back on save.
--   - The parent identity correction can change the generic EPA number: the parent, every size
--     (under the parent copy pass) and the lines of jobs not sprayed yet (scheduled or in progress
--     with no spray recorded) take the new number, in one transaction with one logged event. Sprayed
--     and finished jobs, invoices and restricted-use records keep the number they were made with. It is refused while any invoice line for
--     one of the sizes has no EPA copy of its own (that line would follow the change); the message
--     names the invoices. And it stays refused while _product_parent_epa_correction_enabled() is
--     false, which this file creates as false.
--   - "New product" and "Add a size" (create_product_with_parent, add_product_size, through
--     _insert_parent_size) also take the size's quoting_notes and internal_notes and write them in
--     the same transaction, so a new product is never live without its notes (PR #1553 Sol round 2,
--     Mason 2026-11-06: "Yes, add it there"). Same signatures; a call without them is unchanged.
--
-- NOT CHANGED: purchase orders show the product's current number (a buying request, not a
--   compliance record; record map). Restricted-use sale records still copy the product's number
--   when posted. The job and invoice writers, prices, costs and inventory.
--
-- SIDE EFFECT, named: when a product's EPA number changes, updating its unsprayed jobs' lines runs the
--   existing statement trigger trg_sync_job_holds_upd, which rebuilds those jobs' inventory holds and
--   booking draws from their unchanged lines, as a save of each of those jobs does. The one-time
--   backfill pauses that trigger: it changes only the new column.
--
-- ROLLBACK (its own reviewed migration): re-emit _insert_parent_size and the parent-correction functions
--   from their previous bodies, drop the three triggers and their functions, the switch and
--   _job_line_epa_follows_product, drop the column.
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE job_line_epa_snapshot_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Two steps: outside a transaction the ON COMMIT DROP table is already gone.
  IF to_regclass('pg_temp.job_line_epa_snapshot_tx') IS NULL THEN
    RAISE EXCEPTION 'JOB_LINE_EPA_SNAPSHOT_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.job_line_epa_snapshot_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'JOB_LINE_EPA_SNAPSHOT_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'job_chemicals' AND column_name = 'epa_registration') THEN
    RAISE EXCEPTION 'JOB_LINE_EPA_SNAPSHOT_PREFLIGHT: job_chemicals.epa_registration already exists';
  END IF;
  IF to_regprocedure('public._product_parent_epa_correction_enabled()') IS NOT NULL THEN
    RAISE EXCEPTION 'JOB_LINE_EPA_SNAPSHOT_PREFLIGHT: _product_parent_epa_correction_enabled already exists';
  END IF;
  -- Every function re-emitted here must still be the body this file was written from.
  IF (SELECT count(*) FROM pg_proc p
       WHERE (p.oid, md5(replace(p.prosrc, chr(13), ''))) IN (
         ('public._product_parent_identity_after(public.product_parents,jsonb)'::regprocedure, '397f1abfcab8109b98d78f5ef04ba57d'),
         ('public.correct_product_parent_identity(uuid,bigint,jsonb,text,text,text)'::regprocedure, 'bfb4e966b4ea0f7a57d538ee75083f0c'),
         ('public._copy_parent_to_size(uuid,uuid,bigint,boolean,boolean,boolean)'::regprocedure, 'e2121d5ec1d23dbb4127fa8eac20c33f'),
         ('public._insert_parent_size(public.product_parents,jsonb,text)'::regprocedure, 'becb1e0659f77f00a8cd511dcc9da264'))
         AND p.proowner = 'postgres'::regrole) <> 4 THEN
    RAISE EXCEPTION 'JOB_LINE_EPA_SNAPSHOT_PREFLIGHT: a re-emitted function drifted from the body this file was written from';
  END IF;
  -- The column takes the table's read grants only; that is safe only while the table grants no
  -- table-wide SELECT, INSERT or UPDATE (the column grants are the whole story).
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
              WHERE table_schema = 'public' AND table_name = 'job_chemicals'
                AND grantee IN ('authenticated', 'anon') AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')) THEN
    RAISE EXCEPTION 'JOB_LINE_EPA_SNAPSHOT_PREFLIGHT: job_chemicals has table-wide write or read grants; re-plan the column grants';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Spray-job lines keep their EPA number
-- ---------------------------------------------------------------------------------------------

ALTER TABLE public.job_chemicals ADD COLUMN epa_registration text;
COMMENT ON COLUMN public.job_chemicals.epa_registration IS
  'EPA number this line carries: set from the product by trg_job_chemical_epa on insert or product change, and by a parent EPA correction on open jobs. Finished jobs keep it.';
GRANT SELECT (epa_registration) ON public.job_chemicals TO authenticated;
GRANT REFERENCES (epa_registration) ON public.job_chemicals TO authenticated;
GRANT SELECT (epa_registration) ON public.job_chemicals TO anon;

-- Whether a job's lines still follow their products' EPA numbers: a live job that is scheduled or in
-- progress with no spray recorded yet. Any other job's lines keep the number they carry.
CREATE FUNCTION public._job_line_epa_follows_product(p_job_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT EXISTS (SELECT 1 FROM public.jobs j
                  WHERE j.id = p_job_id AND j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress'))
     AND NOT EXISTS (SELECT 1 FROM public.job_applied_records r WHERE r.job_id = p_job_id);
$function$;
ALTER FUNCTION public._job_line_epa_follows_product(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_line_epa_follows_product(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- No guessing on a re-save: save_job deletes a job's lines and inserts them again with no line identity,
-- so a line inserted into a sprayed or finished job keeps only a number its writer supplies (no app role
-- holds INSERT or UPDATE on this column; the screens PR has save_job pass each line's number back) and
-- otherwise takes the product's number. A line whose product is unchanged keeps its number.
-- FOR SHARE: a line written while a parent EPA correction holds the product waits for it and then
-- takes the corrected number; a correction that starts after the line waits for the line's save, so
-- its open-job update sees the line. Either way no unsprayed job keeps the old number.
CREATE FUNCTION public._job_chemical_epa() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id THEN
    NEW.epa_registration := OLD.epa_registration;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NULLIF(btrim(NEW.epa_registration), '') IS NOT NULL
     AND NOT public._job_line_epa_follows_product(NEW.job_id) THEN
    NEW.epa_registration := btrim(NEW.epa_registration);
    RETURN NEW;
  END IF;
  NEW.epa_registration := (SELECT NULLIF(btrim(p.epa_registration), '') FROM public.products p
                            WHERE p.id = NEW.product_id FOR SHARE);
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._job_chemical_epa() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_chemical_epa() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_job_chemical_epa BEFORE INSERT OR UPDATE OF product_id ON public.job_chemicals
FOR EACH ROW EXECUTE FUNCTION public._job_chemical_epa();

-- Existing lines: the number every printout shows today. Only the new column changes, so the
-- statement trigger that rebuilds inventory holds is paused for this one statement; ADD COLUMN above
-- already holds this table's ACCESS EXCLUSIVE lock, so no other writer can slip past it.
ALTER TABLE public.job_chemicals DISABLE TRIGGER trg_sync_job_holds_upd;
-- Existing lines: the number every printout shows today.
UPDATE public.job_chemicals jc SET epa_registration = NULLIF(btrim(p.epa_registration), '')
  FROM public.products p
 WHERE p.id = jc.product_id AND NULLIF(btrim(p.epa_registration), '') IS NOT NULL;
ALTER TABLE public.job_chemicals ENABLE TRIGGER trg_sync_job_holds_upd;

-- A product's EPA number edited anywhere (Product Detail, setup workbook, import, a parent correction)
-- reaches the lines of jobs not sprayed yet, as printouts did before this file. Sprayed, finished and
-- deleted jobs keep theirs.
CREATE FUNCTION public._product_epa_to_unsprayed_job_lines() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  UPDATE public.job_chemicals jc SET epa_registration = NULLIF(btrim(NEW.epa_registration), '')
   WHERE jc.product_id = NEW.id
     AND jc.epa_registration IS DISTINCT FROM NULLIF(btrim(NEW.epa_registration), '')
     AND public._job_line_epa_follows_product(jc.job_id);
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public._product_epa_to_unsprayed_job_lines() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_epa_to_unsprayed_job_lines() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_product_epa_to_unsprayed_job_lines AFTER UPDATE OF epa_registration ON public.products
FOR EACH ROW WHEN (NULLIF(btrim(OLD.epa_registration), '') IS DISTINCT FROM NULLIF(btrim(NEW.epa_registration), ''))
EXECUTE FUNCTION public._product_epa_to_unsprayed_job_lines();

-- ---------------------------------------------------------------------------------------------
-- 2. Invoice lines are never written without the product's EPA number
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public._fill_invoice_line_epa() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    -- Moved to another product: keep a number the writer sent with it, else the new product's.
    IF NEW.epa_registration IS DISTINCT FROM OLD.epa_registration AND NULLIF(btrim(NEW.epa_registration), '') IS NOT NULL THEN
      RETURN NEW;
    END IF;
  ELSIF NULLIF(btrim(NEW.epa_registration), '') IS NOT NULL THEN
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND NOT EXISTS (SELECT 1 FROM public.invoices i
                                          WHERE i.id = NEW.invoice_id AND i.status IN ('draft', 'unposted')) THEN
    -- A posted invoice's blank line keeps falling back as before; an unrelated edit never freezes
    -- today's number onto it.
    RETURN NEW;
  END IF;
  -- A line with no number, or a line moved to another product: the product's number.
  NEW.epa_registration := (SELECT NULLIF(btrim(p.epa_registration), '') FROM public.products p
                            WHERE p.id = NEW.product_id FOR SHARE);
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._fill_invoice_line_epa() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._fill_invoice_line_epa() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_fill_invoice_line_epa BEFORE INSERT OR UPDATE ON public.invoice_items
FOR EACH ROW EXECUTE FUNCTION public._fill_invoice_line_epa();

-- ---------------------------------------------------------------------------------------------
-- 3. The parent EPA correction (switched off until the screens that read the copies ship)
-- ---------------------------------------------------------------------------------------------

-- The switch. Only a reviewed migration changes it (build sheet, PAR-1 identity correction).
CREATE FUNCTION public._product_parent_epa_correction_enabled() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $function$ SELECT false $function$;
ALTER FUNCTION public._product_parent_epa_correction_enabled() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_epa_correction_enabled() FROM PUBLIC, anon, authenticated, service_role;

-- Checks p_changes; returns the parent's identity after the change. An EPA number change is
-- refused while switched off, when it is not a valid EPA number, and while any invoice line for a
-- size has no EPA copy of its own (that line would show the new number).
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
     WHERE m.parent_id = p_parent.id AND i.deleted_at IS NULL AND NULLIF(btrim(ii.epa_registration), '') IS NULL;
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
    -- Lines of jobs not sprayed yet print the corrected number (written by the products trigger as each
    -- size takes it). Sprayed or finished jobs keep theirs.
    SELECT count(*) INTO v_open_lines FROM public.job_chemicals jc
     WHERE jc.product_id = ANY(v_sizes)
       AND jc.epa_registration IS DISTINCT FROM v_parent.generic_epa_registration
       AND public._job_line_epa_follows_product(jc.job_id);
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

-- ---------------------------------------------------------------------------------------------
-- 4. A new size saves its quoting and internal notes in the same step (body of 20261110150000,
--    plus the two notes)
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._insert_parent_size(p_parent public.product_parents, p_size jsonb, p_key text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_fields jsonb;
  v_saved jsonb;
  v_product uuid;
  v_refusal text;
BEGIN
  IF p_size IS NULL OR jsonb_typeof(p_size) <> 'object' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_SIZE_REQUIRED: send the new size''s fields';
  END IF;
  IF p_size ?| ARRAY['category', 'use_timing', 'use_timings', 'rate_per_acre', 'rate_unit', 'suggested_rate', 'rates'] THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_SIZE_COPIED_VALUE: category, use timing and rates come from the parent; leave them off the size';
  END IF;
  IF jsonb_typeof(p_size->'quoting_notes') NOT IN ('string', 'null') OR jsonb_typeof(p_size->'internal_notes') NOT IN ('string', 'null')
     OR length(p_size->>'quoting_notes') > 5000 OR length(p_size->>'internal_notes') > 5000 THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: quoting_notes and internal_notes are text of at most 5000 characters';
  END IF;
  IF p_size ? 'product_form' AND (p_size->>'product_form') IS DISTINCT FROM p_parent.product_form THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_FORM_MISMATCH: every size of "%" is %', p_parent.name, p_parent.product_form;
  END IF;
  -- Every size carries its parent's EPA number, or none does (build sheet §4.1).
  IF public._normalize_epa_registration(p_size->>'epa_registration') IS DISTINCT FROM p_parent.generic_epa_registration
     AND public._normalize_epa_registration(p_size->>'epa_registration') IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_EPA_MISMATCH: "%" has %', p_parent.name,
      COALESCE('EPA number ' || p_parent.generic_epa_registration, 'no EPA number; set it on the parent first');
  END IF;
  v_fields := (p_size - 'size_role' - 'quoting_notes' - 'internal_notes')
    || jsonb_build_object('product_form', p_parent.product_form, 'category', p_parent.category);
  -- The size stores the parent's normalized number, never a spaced or lower-case spelling of it.
  IF p_parent.generic_epa_registration IS NOT NULL THEN
    v_fields := v_fields || jsonb_build_object('epa_registration', p_parent.generic_epa_registration);
  END IF;
  -- A fresh key: a retry is answered by the caller's own receipt before it gets here, so no setup
  -- receipt (for example one an admin saved under '<key>:insert') can hand back an existing product.
  v_saved := public.apply_product_setup(jsonb_build_array(jsonb_build_object('insert', v_fields)), auth.uid(),
    'product_parent_size:' || gen_random_uuid()::text);
  v_product := (v_saved->'rows'->0->>'product_id')::uuid;
  -- The notes go on in the same transaction (the setup insert does not take them), trimmed as the setup
  -- update stores them; blank is none.
  IF NULLIF(btrim(p_size->>'quoting_notes'), '') IS NOT NULL OR NULLIF(btrim(p_size->>'internal_notes'), '') IS NOT NULL THEN
    UPDATE public.products SET quoting_notes = NULLIF(btrim(p_size->>'quoting_notes'), ''),
      internal_notes = NULLIF(btrim(p_size->>'internal_notes'), '')
    WHERE id = v_product;
  END IF;
  -- A seed or each parent's one rate is per stock unit, so every size must be stocked in the same unit.
  v_refusal := public._product_parent_unit_refusal(p_parent, (SELECT inventory_unit FROM public.products WHERE id = v_product), v_product);
  IF v_refusal IS NOT NULL THEN RAISE EXCEPTION '%', v_refusal; END IF;
  RETURN v_product;
END;
$function$;

-- Postconditions: grants unchanged on the re-emitted functions; the switch is off.
DO $postflight$
BEGIN
  IF (SELECT proacl FROM pg_proc WHERE oid = 'public.correct_product_parent_identity(uuid,bigint,jsonb,text,text,text)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'authenticated=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._product_parent_identity_after(public.product_parents,jsonb)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public._insert_parent_size(public.product_parents,jsonb,text)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     THEN
    RAISE EXCEPTION 'JOB_LINE_EPA_SNAPSHOT_POSTCONDITION: a re-emitted function''s grants changed';
  END IF;
  IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.job_chemicals'::regclass AND tgname = 'trg_sync_job_holds_upd')
       IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'JOB_LINE_EPA_SNAPSHOT_POSTCONDITION: trg_sync_job_holds_upd must be enabled';
  END IF;
  IF public._product_parent_epa_correction_enabled() THEN
    RAISE EXCEPTION 'JOB_LINE_EPA_SNAPSHOT_POSTCONDITION: EPA correction must stay off in this file';
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_chemicals jc JOIN public.products p ON p.id = jc.product_id
              WHERE jc.epa_registration IS DISTINCT FROM NULLIF(btrim(p.epa_registration), '')) THEN
    RAISE EXCEPTION 'JOB_LINE_EPA_SNAPSHOT_POSTCONDITION: a job line does not carry its product''s EPA number';
  END IF;
END
$postflight$;
