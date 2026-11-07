-- 20261204120000_job_lines_keep_epa_number.sql
--
-- Written 2026-11-06. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261204120000_job_lines_keep_epa_number.md.
-- Re-read the live ledger before applying.
--
-- WHY: a spray job's printouts look up the product's CURRENT EPA number. Once a product's EPA number
--   can be corrected, a job that was already sprayed would show the corrected number instead of the
--   one it was sprayed with. This file records, once per job and product, the number a sprayed job
--   used, so the follow-up that moves the printouts has it to read. It starts recording at deploy:
--   history not recorded now could not be recovered later.
--
-- RULE (Mason, 2026-11-06, "Yes, lock per product"): once a job is sprayed, every product already on
--   that job keeps the EPA number the job recorded for it, however its line is edited, deleted or
--   re-added. Only a product never on the job takes the product's current number. On a conflict the
--   older number wins. The lock survives a spray record being deleted and re-entered.
--
-- WHAT:
--   1. job_epa_sprayed: one row per job once it is sprayed (a spray record is saved) or finished
--      (status completed or invoiced, including a job created that way). Never removed by the app, so
--      deleting a spray record does not reopen the job. Internal: only the owner can read or write it.
--   2. job_product_epa: one row per (job, product) of a sprayed or finished job, with the EPA number
--      the job keeps for it (NULL is a kept value too). Rows are only ever inserted ON CONFLICT DO
--      NOTHING, so the first number written (the older one) wins and is never replaced. Neither table
--      has a foreign key, on purpose: deleting a product or a job never erases a kept number; guards on
--      jobs and products refuse a new row taking, or a row changing to or from, an ID that has history.
--      not_recorded true means "Not recorded" (NULL number): every product of a job sprayed or
--      finished before this file, or of a job a spray record was moved onto before it was sprayed or
--      finished itself (Mason, 2026-11-06), including one added to it later (it may have been on the job
--      then and removed; no history exists). Never the product's current number, which cannot prove what
--      was sprayed (REG-1 build sheet section 7). Signed-in users may read the rows of jobs they can
--      see (jobs' own policies; EPA numbers are public regulatory data); only the owner can write them.
--   3. When a job is first sprayed or finished, every product on its lines is locked at the product's
--      number at that moment. A product added later to a sprayed job is locked at its number when added.
--      save_job's delete-and-rewrite of lines changes nothing: locks are keyed by product, not line.
--   4. The number a job shows for a product: the lock row's number when one exists, else
--      _epa_norm(product's current number); signed-in users may call _epa_norm for that read. Products not locked read
--      the product's number, exactly as every printout does today, so no copy has to follow product edits.
--   5. PERMISSION (Mason, 2026-11-06: "Yes, remove it"): signed-in users (and anon) can no longer
--      INSERT, UPDATE, DELETE or TRUNCATE job_chemicals directly. The app never writes it directly:
--      save_job, create_job_from_quote_section and the quote functions write it with definer rights and
--      are unaffected. Reads are unchanged. service_role (the server key) is not changed.
--   6. No printout reads the locks yet: every printout keeps reading the product's number, as today. A
--      follow-up change moves the sent proof, applicator sheet, chemical application report and WPS
--      notice onto it.
--
-- NOT CHANGED: save_job and every function that writes job lines; inventory holds; products; invoices.
--   No column is added to job_chemicals and nothing UPDATEs it.
--
-- LOCKS: a freeze takes its job row FOR NO KEY UPDATE (compatible with the KEY SHARE a spray record's
--   foreign key already holds, so two spray saves on one job wait in turn instead of deadlocking). A
--   written job line takes its job row FOR SHARE before checking whether the job is sprayed, which
--   conflicts with the freeze's lock: a freeze and a line write on the same job run one after the other
--   and the later one sees the earlier one's rows. This needs READ COMMITTED (each statement takes a
--   fresh snapshot), which every app path uses; a REPEATABLE READ or SERIALIZABLE writer is not
--   supported. Every app writer of job lines locks or creates the job first: save_job's implementation
--   locks the job FOR UPDATE before deleting and re-writing lines, and the quote path writes lines only
--   on the job it just created; nothing updates job lines in place, and app roles cannot write them
--   (item 5). So two writers never hold one job's lines or lock rows while waiting for each other.
--   A freeze takes FOR KEY SHARE on the products of its job's lines (what a line's own foreign key already
--   takes), so a product cannot be deleted or change its ID while its history is being written. A plain
--   EPA update does not conflict; an edit path that locks the product FOR UPDATE waits for a spray save
--   in flight, exactly as it already waits for a job save. The one products trigger fires only on insert
--   or an ID change.
--
-- NAMED LIMITS: "sprayed" means a spray record is saved (or the job is finished): a correction made
--   between the physical spray and the record being entered reaches the job. Products removed from a
--   finished job before this file are unknown, and the products still on such jobs are kept as "Not
--   recorded" (no history exists; live has 1 finished job, 0 spray records; its one product has no EPA
--   number either, matching its invoice line). A spray entered and removed
--   before this file leaves nothing to detect. Numbers are trimmed of spaces, tabs and line breaks.
--   load_recipe_into_job (no app access) deletes and re-writes lines before locking its job:
--   two concurrent runs on one line-less job could deadlock; Postgres rolls one back whole.
--
-- ROLLBACK (its own reviewed migration): drop the three recording triggers (trg_job_epa_freeze_on_spray,
--   trg_job_epa_freeze_on_finish, trg_job_line_epa_lock) and their three functions; keep both tables as
--   history, and keep both ID guards and _epa_norm for as long as the tables exist (without the guards a
--   reused ID would inherit kept numbers). While rolled back nothing is recorded: a new spray, a product
--   added to a marked job, and a product edited or removed meanwhile are lost to the record. Re-granting
--   direct writes on job_chemicals (the INSERT and UPDATE column lists of 20261022101000, DELETE) is a
--   permission change that needs Mason's approval. Roll forward is a new migration that re-creates the
--   recording triggers, then sets not_recorded = true on EVERY existing marker (a product first locked on
--   such a job afterwards may have been used while rolled back, so it is "Not recorded"; existing lock rows
--   are kept), then re-runs section 4: markers for newly qualifying jobs and NULL locks for the products of
--   EVERY marked job (ON CONFLICT DO NOTHING).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE job_lines_keep_epa_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Two steps: outside a transaction the ON COMMIT DROP table is already gone.
  -- (separate IFs: an OR does not stop the missing table being resolved when the query is prepared).
  IF to_regclass('pg_temp.job_lines_keep_epa_tx') IS NULL THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.job_lines_keep_epa_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regclass('public.job_epa_sprayed') IS NOT NULL OR to_regclass('public.job_product_epa') IS NOT NULL
     OR to_regprocedure('public._epa_norm(text)') IS NOT NULL
     OR to_regprocedure('public._job_epa_freeze(uuid)') IS NOT NULL
     OR to_regprocedure('public._trg_job_epa_id_guard()') IS NOT NULL
     OR to_regprocedure('public._trg_product_epa_id_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_PREFLIGHT: a table or function this file creates already exists';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. No direct job line writes by app roles (item 5)
-- ---------------------------------------------------------------------------------------------
-- Both REVOKEs are needed: the table-level one, and the column-level one naming every column
-- (20261022101000 granted INSERT and UPDATE column lists). The postflight checks no column is left writable.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.job_chemicals FROM PUBLIC, authenticated, anon;
DO $revoke_cols$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
    FROM pg_attribute
   WHERE attrelid = 'public.job_chemicals'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE INSERT (%1$s), UPDATE (%1$s) ON public.job_chemicals FROM PUBLIC, authenticated, anon', v_cols);
END
$revoke_cols$;

-- ---------------------------------------------------------------------------------------------
-- 2. The two tables
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.job_epa_sprayed (
  job_id        uuid PRIMARY KEY,  -- no foreign key: deleting a job never erases its EPA history
  recorded_at   timestamptz NOT NULL DEFAULT clock_timestamp(),  -- when recorded, not when sprayed
  not_recorded boolean NOT NULL DEFAULT false
);
COMMENT ON TABLE public.job_epa_sprayed IS
  'Jobs that were sprayed (a spray record saved) or finished; their products keep the EPA number in job_product_epa. Never removed by the app (20261204120000).';
ALTER TABLE public.job_epa_sprayed ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_epa_sprayed_no_app_access ON public.job_epa_sprayed
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE TABLE public.job_product_epa (
  job_id           uuid NOT NULL,  -- no foreign key: deleting a job never erases its EPA history
  product_id       uuid NOT NULL,  -- no foreign key: a product delete never erases a kept number
  epa_registration text,
  recorded_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  not_recorded    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (job_id, product_id)
);
CREATE INDEX job_product_epa_product_id_idx ON public.job_product_epa (product_id);
COMMENT ON TABLE public.job_product_epa IS
  'EPA number a sprayed or finished job keeps for each product it had (NULL kept too). Insert-only, first number wins; a job''s other products read products.epa_registration (20261204120000).';
ALTER TABLE public.job_product_epa ENABLE ROW LEVEL SECURITY;
-- Readable where the caller can see the job (jobs' own policies decide that, the same roles that see its
-- lines), so removing every line hides nothing. Rows of a deleted job stay, readable by the owner only.
CREATE POLICY job_product_epa_select ON public.job_product_epa
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_product_epa.job_id));
-- New tables in public inherit default grants (live: anon, authenticated, service_role, metabase_ro).
-- Strip every grant but the owner's, then let signed-in users read the kept numbers only.
DO $strip_grants$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT DISTINCT c.relname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END AS who
             FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
             LEFT JOIN pg_roles g ON g.oid = a.grantee
            WHERE c.oid IN ('public.job_epa_sprayed'::regclass, 'public.job_product_epa'::regclass)
              AND a.grantee <> c.relowner LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM %s', r.relname, r.who);
  END LOOP;
END
$strip_grants$;
GRANT SELECT ON public.job_product_epa TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Recording the numbers
-- ---------------------------------------------------------------------------------------------
-- The one normalizer every path (and the follow-up readers) uses: trim spaces, tabs and line breaks;
-- blank is "no number". Pure and invoker-rights, so signed-in users may call it to read.
CREATE FUNCTION public._epa_norm(p_epa text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT NULLIF(btrim(p_epa, E' \t\r\n'), '');
$function$;
ALTER FUNCTION public._epa_norm(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._epa_norm(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._epa_norm(text) TO authenticated;

-- Mark a job sprayed and lock every product on its lines at the product's current number; on a job
-- sprayed or finished before this file, as "Not recorded" (NULL, not_recorded): see section 4.
CREATE FUNCTION public._job_epa_freeze(p_job_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_unknown boolean;
BEGIN
  IF p_job_id IS NULL THEN
    RETURN;
  END IF;
  -- Serializes with line writes (they take this row FOR SHARE); see LOCKS in the header.
  PERFORM 1 FROM public.jobs WHERE id = p_job_id FOR NO KEY UPDATE;
  INSERT INTO public.job_epa_sprayed (job_id) VALUES (p_job_id) ON CONFLICT (job_id) DO NOTHING;
  SELECT not_recorded INTO v_unknown FROM public.job_epa_sprayed WHERE job_id = p_job_id;
  -- KEY SHARE, as a job line's own foreign key takes: no product being locked here can be deleted or change
  -- its ID until this commits, so the ID guard always sees this history. A non-key edit (an EPA number) does
  -- not conflict; an edit path that locks the product FOR UPDATE waits for this save, as it already does for
  -- a job save's lines.
  PERFORM 1 FROM public.products p
   WHERE p.id IN (SELECT jc.product_id FROM public.job_chemicals jc WHERE jc.job_id = p_job_id)
   ORDER BY p.id FOR KEY SHARE;
  INSERT INTO public.job_product_epa (job_id, product_id, epa_registration, not_recorded)
  SELECT DISTINCT jc.job_id, jc.product_id, CASE WHEN v_unknown THEN NULL ELSE public._epa_norm(p.epa_registration) END,
         v_unknown
    FROM public.job_chemicals jc JOIN public.products p ON p.id = jc.product_id
   WHERE jc.job_id = p_job_id
  ON CONFLICT (job_id, product_id) DO NOTHING;
END;
$function$;
ALTER FUNCTION public._job_epa_freeze(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_epa_freeze(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._trg_job_epa_freeze() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_TABLE_NAME = 'jobs' THEN
    IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
      RETURN NULL;
    END IF;
    PERFORM public._job_epa_freeze(NEW.id);
  ELSE
    -- A spray record moved onto a job proves nothing about which numbers that job used (Mason, 2026-11-06:
    -- a moved spray record makes the job "Not recorded", never a number). A job already marked keeps its own.
    IF TG_OP = 'UPDATE' AND NEW.job_id IS NOT NULL AND OLD.job_id IS DISTINCT FROM NEW.job_id THEN
      PERFORM 1 FROM public.jobs WHERE id = NEW.job_id FOR NO KEY UPDATE;
      INSERT INTO public.job_epa_sprayed (job_id, not_recorded) VALUES (NEW.job_id, true)
      ON CONFLICT (job_id) DO NOTHING;
    END IF;
    PERFORM public._job_epa_freeze(NEW.job_id);
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public._trg_job_epa_freeze() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._trg_job_epa_freeze() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_job_epa_freeze_on_spray AFTER INSERT OR UPDATE OF job_id ON public.job_applied_records
FOR EACH ROW EXECUTE FUNCTION public._trg_job_epa_freeze();
CREATE TRIGGER trg_job_epa_freeze_on_finish AFTER INSERT OR UPDATE OF status ON public.jobs
FOR EACH ROW WHEN (NEW.status IN ('completed', 'invoiced')) EXECUTE FUNCTION public._trg_job_epa_freeze();

-- A line written on a sprayed or finished job locks its product, if not locked yet, at the product's
-- current number. A product already locked keeps its number. On a job sprayed or finished before this
-- file the product may have been on it then and removed (no history), so it is "Not recorded" instead.
CREATE FUNCTION public._trg_job_line_epa_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_unknown boolean;
BEGIN
  -- Conflicts with a freeze's FOR NO KEY UPDATE: whichever commits first, the other then sees it.
  PERFORM 1 FROM public.jobs WHERE id = NEW.job_id FOR SHARE;
  SELECT not_recorded INTO v_unknown FROM public.job_epa_sprayed WHERE job_id = NEW.job_id;
  IF FOUND THEN
    INSERT INTO public.job_product_epa (job_id, product_id, epa_registration, not_recorded)
    SELECT NEW.job_id, p.id, CASE WHEN v_unknown THEN NULL ELSE public._epa_norm(p.epa_registration) END, v_unknown
      FROM public.products p WHERE p.id = NEW.product_id
    ON CONFLICT (job_id, product_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public._trg_job_line_epa_lock() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._trg_job_line_epa_lock() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_job_line_epa_lock AFTER INSERT OR UPDATE OF job_id, product_id ON public.job_chemicals
FOR EACH ROW EXECUTE FUNCTION public._trg_job_line_epa_lock();

-- History outlives a deleted job (no foreign key), so a job ID that has EPA history can never be taken by
-- a new job, and no job with history changes its ID: either would attach one job's kept numbers to another.
-- AFTER, not BEFORE: an insert reusing an ID that another transaction is deleting waits on the primary key
-- first, so the check runs after that transaction commits and sees any history it wrote (READ COMMITTED).
CREATE FUNCTION public._trg_job_epa_id_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id IS NOT DISTINCT FROM OLD.id THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_epa_sprayed WHERE job_id = NEW.id)
     OR (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM public.job_epa_sprayed WHERE job_id = OLD.id)) THEN
    RAISE EXCEPTION 'JOB_EPA_HISTORY_ID: this job ID carries kept EPA numbers; use a new job ID' USING ERRCODE = '23505';
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public._trg_job_epa_id_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._trg_job_epa_id_guard() FROM PUBLIC, anon, authenticated, service_role;

-- Named to sort before trg_job_epa_freeze_on_finish: AFTER triggers on one row fire in name order, and a
-- job created already finished must be checked before its own marker is written.
CREATE TRIGGER trg_job_epa_a_id_guard AFTER INSERT OR UPDATE OF id ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public._trg_job_epa_id_guard();

-- The same for products: kept numbers outlive a deleted product, so a product ID that has one can never be
-- taken by a new product, and no product with one changes its ID. Fires only on insert or an ID change, so a
-- product EPA edit never runs it.
CREATE FUNCTION public._trg_product_epa_id_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id IS NOT DISTINCT FROM OLD.id THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_product_epa WHERE product_id = NEW.id)
     OR (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM public.job_product_epa WHERE product_id = OLD.id)) THEN
    RAISE EXCEPTION 'PRODUCT_EPA_HISTORY_ID: this product ID carries kept EPA numbers; use a new product ID' USING ERRCODE = '23505';
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public._trg_product_epa_id_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._trg_product_epa_id_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_product_epa_id_guard AFTER INSERT OR UPDATE OF id ON public.products
FOR EACH ROW EXECUTE FUNCTION public._trg_product_epa_id_guard();

-- ---------------------------------------------------------------------------------------------
-- 4. Jobs already sprayed or finished
-- ---------------------------------------------------------------------------------------------
-- Runs after the triggers exist (each CREATE TRIGGER holds a lock that blocks job, line and spray writes
-- until commit), so nothing written meanwhile is missed. Locks cover the products of EVERY marked job.
-- The number is NULL ("Not recorded"): what was sprayed before this file was never captured.
INSERT INTO public.job_epa_sprayed (job_id, not_recorded)
SELECT j.id, true FROM public.jobs j
 WHERE j.status IN ('completed', 'invoiced')
    OR EXISTS (SELECT 1 FROM public.job_applied_records r WHERE r.job_id = j.id)
ON CONFLICT (job_id) DO NOTHING;
INSERT INTO public.job_product_epa (job_id, product_id, epa_registration, not_recorded)
SELECT DISTINCT jc.job_id, jc.product_id, NULL::text, true
  FROM public.job_chemicals jc
  JOIN public.job_epa_sprayed s ON s.job_id = jc.job_id
ON CONFLICT (job_id, product_id) DO NOTHING;

DO $postflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public.jobs j
              WHERE (j.status IN ('completed', 'invoiced')
                     OR EXISTS (SELECT 1 FROM public.job_applied_records r WHERE r.job_id = j.id))
                AND NOT EXISTS (SELECT 1 FROM public.job_epa_sprayed s WHERE s.job_id = j.id))
     OR EXISTS (SELECT 1 FROM public.job_chemicals jc JOIN public.job_epa_sprayed s ON s.job_id = jc.job_id
                 WHERE NOT EXISTS (SELECT 1 FROM public.job_product_epa l
                                    WHERE l.job_id = jc.job_id AND l.product_id = jc.product_id)) THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_POSTFLIGHT: a sprayed or finished job is missing its marker or a product lock';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['authenticated', 'anon', 'public']) r(role), unnest(ARRAY['INSERT', 'UPDATE']) v(priv)
              WHERE has_any_column_privilege(r.role, 'public.job_chemicals', v.priv))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['authenticated', 'anon', 'public']) r(role), unnest(ARRAY['DELETE', 'TRUNCATE']) v(priv)
                 WHERE has_table_privilege(r.role, 'public.job_chemicals', v.priv))
     OR NOT has_column_privilege('authenticated', 'public.job_chemicals', 'product_id', 'SELECT') THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_POSTFLIGHT: an app role can still write job_chemicals directly, or lost its read grant';
  END IF;
  -- The only grant on the new tables besides the owner's: authenticated SELECT on job_product_epa.
  IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
              WHERE c.oid IN ('public.job_epa_sprayed'::regclass, 'public.job_product_epa'::regclass)
                AND a.grantee <> c.relowner
                AND NOT (c.oid = 'public.job_product_epa'::regclass AND a.grantee = 'authenticated'::regrole
                         AND a.privilege_type = 'SELECT'))
     OR NOT has_table_privilege('authenticated', 'public.job_product_epa', 'SELECT')
     OR EXISTS (SELECT 1 FROM pg_class
                 WHERE oid IN ('public.job_epa_sprayed'::regclass, 'public.job_product_epa'::regclass)
                   AND NOT relrowsecurity)
     OR has_schema_privilege('authenticated', 'public', 'CREATE')
     OR has_schema_privilege('anon', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_POSTFLIGHT: the new tables have grants beyond plan or lack RLS, or app roles can create in public';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'public']) r(role),
                    unnest(ARRAY['public._job_epa_freeze(uuid)',
                                 'public._trg_job_epa_freeze()', 'public._trg_job_line_epa_lock()',
                                 'public._trg_job_epa_id_guard()', 'public._trg_product_epa_id_guard()']) f(sig)
              WHERE has_function_privilege(r.role, f.sig, 'EXECUTE'))
     OR has_function_privilege('anon', 'public._epa_norm(text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._epa_norm(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_POSTFLIGHT: an app role can run a new helper';
  END IF;
END
$postflight$;
