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
--     writes the line (save_job, recipes, quote sections). Existing lines get their product's number
--     today, which is what every printout shows today. Read-only to the app (SELECT grant only).
--   - invoice_items: a line written or saved (any edit) with no EPA number, or moved to another product
--     without one, gets the product's number (chemical-sale lines were still made blank, and blank lines
--     print the product's current number). No existing invoice line is written by this file.
--   - get_job_proof_data reads the job line's copy; get_customer_year_end_summary reads the invoice
--     line's copy first. Each is re-emitted from its live body (pinned below) with that one change.
--   - The parent identity correction can change the generic EPA number: the parent, every size
--     (under the parent copy pass) and the lines of jobs not sprayed yet (scheduled or in progress
--     with no spray recorded) take the new number, in one transaction with one logged event. Sprayed
--     and finished jobs, invoices and restricted-use records keep the number they were made with; a
--     sprayed or finished job re-saved keeps its lines' numbers (save_job re-inserts lines). It is refused while any invoice line for
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
-- ROLLBACK (its own reviewed migration): re-emit _insert_parent_size, the parent-correction functions and the two
--   readers from their previous bodies, drop the three triggers and their functions, the switch and
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
         ('public.get_job_proof_data(uuid,uuid)'::regprocedure, 'e4ec151e7306b61962fd16251f47af76'),
         ('public.get_customer_year_end_summary(uuid,integer)'::regprocedure, '04524d3562036cc5a4770d132391d0b3'),
         ('public._product_parent_identity_after(public.product_parents,jsonb)'::regprocedure, '397f1abfcab8109b98d78f5ef04ba57d'),
         ('public.correct_product_parent_identity(uuid,bigint,jsonb,text,text,text)'::regprocedure, 'bfb4e966b4ea0f7a57d538ee75083f0c'),
         ('public._copy_parent_to_size(uuid,uuid,bigint,boolean,boolean,boolean)'::regprocedure, 'e2121d5ec1d23dbb4127fa8eac20c33f'),
         ('public._insert_parent_size(public.product_parents,jsonb,text)'::regprocedure, 'becb1e0659f77f00a8cd511dcc9da264'))
         AND p.proowner = 'postgres'::regrole) <> 6 THEN
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

-- save_job deletes a job's lines and inserts them again. A deleted line leaves its number for the rest
-- of the transaction (transaction-local settings: one per job, product and sort order, and a list per
-- job and product), so a sprayed or finished job re-saved keeps its lines' numbers. Each remembered
-- number is used once: the line at the same sort order takes its own, other lines of that product take
-- the rest in order, and a line beyond the deleted count takes the product's number today. A line whose
-- product is unchanged keeps its number.
-- FOR SHARE: a line written while a parent EPA correction holds the product waits for it and then
-- takes the corrected number; a correction that starts after the line waits for the line's save, so
-- its open-job update sees the line. Either way no unsprayed job keeps the old number.
CREATE FUNCTION public._job_chemical_epa() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_job uuid;
  v_product uuid;
  v_sort text;
  v_key text;
  v_line_key text;
  v_kept text;
  v_list jsonb;
  v_idx int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_job := OLD.job_id; v_product := OLD.product_id; v_sort := OLD.sort_order::text;
  ELSE
    v_job := NEW.job_id; v_product := NEW.product_id; v_sort := NEW.sort_order::text;
  END IF;
  v_key := 'crx_job_line_epa.k' || md5(COALESCE(v_job::text, '') || ':' || COALESCE(v_product::text, ''));
  v_line_key := 'crx_job_line_epa.l' || md5(COALESCE(v_job::text, '') || ':' || COALESCE(v_product::text, '') || ':' || COALESCE(v_sort, ''));
  IF TG_OP = 'DELETE' THEN
    v_list := COALESCE(NULLIF(current_setting(v_key, true), '')::jsonb, '[]'::jsonb);
    PERFORM set_config(v_key, (v_list || to_jsonb(COALESCE(OLD.epa_registration, '')))::text, true);
    PERFORM set_config(v_line_key, 'v:' || COALESCE(OLD.epa_registration, ''), true);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id THEN
    NEW.epa_registration := OLD.epa_registration;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NOT public._job_line_epa_follows_product(NEW.job_id) THEN
    v_list := COALESCE(NULLIF(current_setting(v_key, true), '')::jsonb, '[]'::jsonb);
    v_kept := current_setting(v_line_key, true);
    v_idx := NULL;
    IF v_kept LIKE 'v:%' THEN
      SELECT e.ord - 1 INTO v_idx FROM jsonb_array_elements_text(v_list) WITH ORDINALITY e(v, ord)
       WHERE e.v = substr(v_kept, 3) ORDER BY e.ord LIMIT 1;
      PERFORM set_config(v_line_key, '', true);
    END IF;
    IF v_idx IS NULL AND jsonb_array_length(v_list) > 0 THEN
      v_idx := 0;
    END IF;
    IF v_idx IS NOT NULL THEN
      NEW.epa_registration := NULLIF(v_list->>v_idx, '');
      PERFORM set_config(v_key, (v_list - v_idx)::text, true);
      RETURN NEW;
    END IF;
  END IF;
  NEW.epa_registration := (SELECT NULLIF(btrim(p.epa_registration), '') FROM public.products p
                            WHERE p.id = NEW.product_id FOR SHARE);
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._job_chemical_epa() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_chemical_epa() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_job_chemical_epa BEFORE INSERT OR UPDATE OF product_id OR DELETE ON public.job_chemicals
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
-- 3. Readers of old records use the copies (live bodies, one change each)
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_job_proof_data(p_job_id uuid, p_customer_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor               uuid;
  v_role                text;
  v_primary_customer_id uuid;
  v_job                 record;
  v_season              int;
  v_fields              jsonb := '[]'::jsonb;
  v_products            jsonb := '[]'::jsonb;
  v_weather             jsonb := NULL;
  v_result              jsonb;
BEGIN
  -- Role gate (office sending tool — admin/sales_rep). First executable statement.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;

  -- Job header + applicator display name. Validates the job exists.
  SELECT j.id, j.job_number, j.status, j.job_date, j.season, j.customer_id, j.applicator_id,
         pr.full_name AS applicator_name
  INTO v_job
  FROM jobs j
  LEFT JOIN profiles pr ON pr.id = j.applicator_id
  WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOB_NOT_FOUND: job % does not exist', p_job_id;
  END IF;
  v_season := v_job.season;
  v_primary_customer_id := v_job.customer_id;

  -- ── Resolve each job field to its OWNING customer (same precedence as the recipient
  -- resolver / get_job_billed_customers): explicit job_field_shares, else
  -- field_billing_defaults, else the job's primary customer. One row per (field) with the
  -- resolved customer_id, so we can filter to p_customer_id when scoping a recipient's proof.
  -- ── Per-field APPLIED acres come from job_applied_record_fields (the real sprayed acres,
  -- the §2/§5 source) joined via job_applied_records; fall back to the field's effective
  -- acres (override > measured > total) only when no applied record treated that field.
  SELECT COALESCE(jsonb_agg(fr ORDER BY (fr->>'sort_order')::int NULLS LAST, fr->>'field_name'), '[]'::jsonb)
  INTO v_fields
  FROM (
    SELECT jsonb_build_object(
      'field_id',         f.id,
      'field_name',       f.field_name,
      'county',           f.county,
      'state',            f.state,
      'acres',            CASE
                            WHEN applied.applied_acres IS NOT NULL
                              THEN GREATEST(applied.applied_acres, 0)
                            ELSE GREATEST(COALESCE(f.override_acres, f.measured_acres, f.total_acres, 0), 0)
                          END,
      'acres_source',     CASE
                            WHEN applied.applied_acres IS NOT NULL THEN 'applied'
                            WHEN f.override_acres IS NOT NULL THEN 'override'
                            WHEN f.measured_acres IS NOT NULL THEN 'measured'
                            WHEN f.total_acres   IS NOT NULL THEN 'total'
                            ELSE NULL END,
      'centroid_geojson', ST_AsGeoJSON(f.centroid)::text,
      'boundary_geojson', ST_AsGeoJSON(COALESCE(f.boundary_geom, f.boundary::geometry))::text,
      'harvest_date',     (
                            SELECT to_char(fch.harvest_date, 'YYYY-MM-DD')
                            FROM field_crop_history fch
                            WHERE fch.field_id = f.id
                              AND (v_season IS NULL OR fch.season = v_season)
                              AND fch.harvest_date IS NOT NULL
                            ORDER BY fch.season DESC NULLS LAST, fch.harvest_date DESC
                            LIMIT 1
                          ),
      'sort_order',       jf.sort_order
    ) AS fr
    FROM job_fields jf
    JOIN fields f ON f.id = jf.field_id
    -- the real sprayed acres for this field on this job (NULL when none recorded)
    LEFT JOIN LATERAL (
      SELECT SUM(rf.applied_acres) AS applied_acres
      FROM job_applied_records r
      JOIN job_applied_record_fields rf
        ON rf.application_record_id = r.id AND rf.field_id = f.id
      WHERE r.job_id = p_job_id AND rf.applied_acres IS NOT NULL
      HAVING SUM(rf.applied_acres) > 0
    ) applied ON true
    WHERE jf.job_id = p_job_id
      -- Scope to a recipient (P1 leak fix), but a field SHARED across MULTIPLE customers must
      -- appear for EACH of its billed customers (not collapse to one owner). Include field f for
      -- p_customer_id when: whole-job preview (NULL); OR p_customer_id holds an explicit share of f;
      -- OR f has NO explicit shares and p_customer_id is f's billing-default; OR f has neither and
      -- p_customer_id is the job's primary customer. A customer with NO claim to f never sees it.
      AND (
        p_customer_id IS NULL
        OR EXISTS (
             SELECT 1 FROM job_field_shares jfs
             WHERE jfs.job_id = p_job_id AND jfs.field_id = f.id AND jfs.customer_id = p_customer_id
           )
        OR (
          NOT EXISTS (SELECT 1 FROM job_field_shares jfs2 WHERE jfs2.job_id = p_job_id AND jfs2.field_id = f.id)
          AND (
            EXISTS (SELECT 1 FROM field_billing_defaults fbd WHERE fbd.field_id = f.id AND fbd.customer_id = p_customer_id)
            OR (
              NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd2 WHERE fbd2.field_id = f.id)
              AND p_customer_id = v_primary_customer_id
            )
          )
        )
      )
  ) s;

  -- ── Products applied (job-wide — the same tank mix went on every field). REI/PHI prefer
  -- the job line's captured value, else the product master. The EPA number is the job line's
  -- own copy (20261127100000), so a later parent correction leaves a sent proof as it was.
  SELECT COALESCE(jsonb_agg(pr ORDER BY (pr->>'sort_order')::int NULLS LAST, pr->>'product_name'), '[]'::jsonb)
  INTO v_products
  FROM (
    SELECT jsonb_build_object(
      'product_name',     p.product_name,
      'rate_per_acre',    jc.rate_per_acre,
      'rate_unit',        jc.rate_unit,
      'rei_hours',        COALESCE(jc.rei_hours, p.rei_hours),
      'phi_days',         COALESCE(jc.phi_days, p.phi_days),
      'signal_word',      p.signal_word,
      'epa_registration', jc.epa_registration,
      'sort_order',       jc.sort_order
    ) AS pr
    FROM job_chemicals jc
    JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id
  ) s;

  -- ── Weather at application (job-wide). Graceful NULL when not captured. Unchanged.
  SELECT jsonb_build_object(
           'temperature',    ja.temperature,
           'wind_speed',     ja.wind_speed,
           'wind_direction', ja.wind_direction,
           'humidity',       ja.humidity,
           'actual_start',   ja.actual_start_time,
           'actual_end',     ja.actual_end_time
         )
  INTO v_weather
  FROM job_applied_info ja
  WHERE ja.job_id = p_job_id
    AND (ja.temperature IS NOT NULL
         OR ja.wind_speed IS NOT NULL
         OR ja.wind_direction IS NOT NULL
         OR ja.humidity IS NOT NULL)
  ORDER BY ja.updated_at DESC NULLS LAST, ja.created_at DESC
  LIMIT 1;

  v_result := jsonb_build_object(
    'job_id',           v_job.id,
    'job_number',       v_job.job_number,
    'status',           v_job.status,
    'application_date', to_char(v_job.job_date, 'YYYY-MM-DD'),
    'applicator_name',  v_job.applicator_name,
    'scoped_customer_id', p_customer_id,   -- echoes the scope (NULL = whole job)
    'fields',           v_fields,
    'products',         v_products,
    'weather',          v_weather
  );

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_year_end_summary(p_customer_id uuid, p_season integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cust record;
  v_season_start date;
  v_season_end date;
  v_financial jsonb;
  v_product_usage jsonb;
  v_acreage jsonb;
  v_invoices jsonb;
  v_shares jsonb;
  v_prior_season jsonb;
BEGIN
  PERFORM public.require_admin_or_sales_rep();
  -- Reps read ANY customer's year-end summary (Mason, 2026-10-13); the
  -- assigned-rep check is removed by 20261013220000.

  SELECT * INTO v_cust FROM public.customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;
  v_season_start := public.season_start_date(p_season);
  v_season_end := public.season_end_date(p_season);

  SELECT jsonb_build_object(
    'total_invoiced_cents', COALESCE(SUM(total_amount_cents), 0),
    'total_paid_cents', COALESCE(SUM(paid_amount_cents), 0),
    'prepay_applied_cents', COALESCE(SUM(prepay_applied_cents), 0),
    'outstanding_balance_cents', COALESCE(SUM(balance_cents), 0),
    'invoice_count', COUNT(*)
  ) INTO v_financial
  FROM public.invoices
  WHERE customer_id = p_customer_id AND season = p_season
    AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL;

  -- The EPA number is the invoice line's own copy (the product's only for a line made without
  -- one; a parent correction refuses while such a line exists: 20261127100000).
  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.category, t.product_name), '[]'::jsonb)
  INTO v_product_usage
  FROM (
    SELECT COALESCE(p.category, 'Uncategorized') AS category,
      COALESCE(p.product_name, ii.description) AS product_name,
      COALESCE(NULLIF(btrim(ii.epa_registration), ''), p.epa_registration) AS epa_registration,
      SUM(ii.quantity) AS total_quantity,
      MAX(ii.unit_size) AS unit_size,
      CASE WHEN SUM(COALESCE(ii.acres, 0)) > 0 THEN ROUND(AVG(ii.rate_per_acre)::numeric, 2) ELSE NULL END AS avg_rate_per_acre,
      MAX(ii.rate_unit) AS rate_unit, SUM(COALESCE(ii.acres, 0)) AS total_acres_treated,
      SUM(ii.extended_cents) AS total_cost_cents,
      SUM(COALESCE(ii.total_applied, 0)) AS total_applied,
      MAX(ii.total_applied_unit) AS total_applied_unit,
      SUM(COALESCE(ii.total_applied_gl_lb, 0)) AS total_applied_gl_lb,
      MAX(ii.gl_lb_unit) AS gl_lb_unit, ii.is_application_fee
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
    LEFT JOIN public.products p ON p.id = ii.product_id
    WHERE i.customer_id = p_customer_id AND i.season = p_season
      AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL
    GROUP BY COALESCE(p.category, 'Uncategorized'), COALESCE(p.product_name, ii.description),
      COALESCE(NULLIF(btrim(ii.epa_registration), ''), p.epa_registration), ii.is_application_fee
  ) t;

  SELECT jsonb_build_object(
    'total_acres', COALESCE(SUM(i.total_acres), 0),
    'by_crop', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('crop_type', sub.crop_type, 'acres', sub.total_acres) ORDER BY sub.total_acres DESC)
      FROM (
        SELECT COALESCE(crop_type, 'Unknown') AS crop_type, SUM(total_acres) AS total_acres
        FROM public.invoices
        WHERE customer_id = p_customer_id AND season = p_season AND invoice_type = 'field_application'
          AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL AND total_acres IS NOT NULL
        GROUP BY COALESCE(crop_type, 'Unknown')
      ) sub
    ), '[]'::jsonb)
  ) INTO v_acreage
  FROM public.invoices i
  WHERE i.customer_id = p_customer_id AND i.season = p_season AND i.invoice_type = 'field_application'
    AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'invoice_number', i.invoice_number, 'invoice_date', i.invoice_date, 'invoice_type', i.invoice_type,
    'field_names', i.field_names, 'total_acres', i.total_acres, 'crop_type', i.crop_type,
    'total_amount_cents', i.total_amount_cents, 'balance_cents', i.balance_cents, 'status', i.status
  ) ORDER BY i.invoice_date, i.created_at), '[]'::jsonb)
  INTO v_invoices
  FROM public.invoices i
  WHERE i.customer_id = p_customer_id AND i.season = p_season
    AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'invoice_number', i.invoice_number, 'field_names', i.field_names,
    'share_customer_name', s.customer_name, 'split_percentage', s.split_percentage,
    'acres', s.acres, 'amount_cents', s.amount_cents,
    'price_per_acre_cents', s.price_per_acre_cents, 'pricing_note', s.pricing_note
  ) ORDER BY i.invoice_date, s.sort_order), '[]'::jsonb)
  INTO v_shares
  FROM public.invoice_shares s JOIN public.invoices i ON i.id = s.invoice_id
  WHERE i.customer_id = p_customer_id AND i.season = p_season
    AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL;

  SELECT CASE WHEN COUNT(*) > 0 THEN jsonb_build_object(
    'total_invoiced_cents', COALESCE(SUM(total_amount_cents), 0),
    'total_paid_cents', COALESCE(SUM(paid_amount_cents), 0), 'invoice_count', COUNT(*),
    'total_acres', COALESCE((
      SELECT SUM(total_acres) FROM public.invoices
      WHERE customer_id = p_customer_id AND season = p_season - 1 AND invoice_type = 'field_application'
        AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL
    ), 0)
  ) ELSE NULL END INTO v_prior_season
  FROM public.invoices
  WHERE customer_id = p_customer_id AND season = p_season - 1
    AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'customer', jsonb_build_object('id', v_cust.id, 'farm_name', v_cust.farm_name,
      'contact_name', v_cust.contact_name, 'account_number', v_cust.account_number,
      'email', v_cust.email, 'phone', v_cust.phone, 'billing_address', v_cust.billing_address,
      'city', v_cust.city, 'state', v_cust.state, 'zip', v_cust.zip,
      'assigned_tier', v_cust.assigned_tier, 'payment_terms', v_cust.payment_terms),
    'season', p_season, 'season_start', v_season_start, 'season_end', v_season_end,
    'financial', v_financial, 'product_usage', v_product_usage, 'acreage', v_acreage,
    'invoices', v_invoices, 'shares', v_shares, 'prior_season', v_prior_season
  );
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 4. The parent EPA correction (switched off until the screens that read the copies ship)
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
-- 5. A new size saves its quoting and internal notes in the same step (body of 20261110150000,
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
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public.get_job_proof_data(uuid,uuid)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR (SELECT proacl FROM pg_proc WHERE oid = 'public.get_customer_year_end_summary(uuid,integer)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[] THEN
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
