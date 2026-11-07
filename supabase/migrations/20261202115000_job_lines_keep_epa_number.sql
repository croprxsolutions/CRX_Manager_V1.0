-- 20261202115000_job_lines_keep_epa_number.sql
--
-- Written 2026-11-06. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261202115000_job_lines_keep_epa_number.md.
-- Re-read the live ledger before applying.
--
-- WHY (Mason, 2026-11-06: "Yes, start it"): a spray job's printouts look up the product's CURRENT EPA
--   number, and save_job erases a job's chemical lines and writes them again. So once a product's EPA
--   number can be corrected (parked work, branch claude/sweet-bun-f7920f), a job that was already
--   sprayed would show the corrected number instead of the one actually used. This file gives every
--   job line its own EPA number and makes a re-save keep it. It is the "job lines keep their EPA
--   number" half of the parked 20261127100000_job_line_epa_snapshot, with no guessing on re-save:
--   a line is matched only by the line id the screen sends back.
--
-- WHAT:
--   1. New column job_chemicals.epa_registration, read-only to the app. Any line written, by any
--      path (save_job, recipes, quote close), or moved to another product, takes the product's number.
--   2. Existing lines get their product's number now: exactly what every printout shows today, so no
--      printout changes (legacy rows, decided in the plan). A product with no number leaves NULL.
--   3. A product's EPA number edited anywhere reaches the lines of jobs not sprayed yet (scheduled or
--      in progress, not deleted, no spray recorded), as their printouts follow it today. Sprayed,
--      finished, invoiced, cancelled and deleted jobs keep theirs.
--   4. save_job: a line the screen sends back with its line id (a line of THIS job with the SAME
--      product) keeps the number stored on that line, when the job is sprayed or finished after the
--      save. The database reads the stored number itself; nothing a caller sends sets it. A new line,
--      a line whose product changed, a line moved to another job, two written lines sharing a
--      position, and any line of a job not sprayed yet take the product's number. A direct write
--      (outside save_job) that changes a line's product or moves it between jobs is refused when
--      either job is sprayed or finished, so a sprayed line never swaps back to its product's
--      current number; save_job (which deletes and re-writes) is the way to change those lines.
--      The job screen sends each saved line's id from this same change (an older save_job ignores
--      the key, so the screen can ship with or before this file). On a sprayed or finished job, a
--      sent line id that is no longer a line of that job (a second tab or device saved meanwhile) is
--      refused with "Reload the job", so a stale screen never silently swaps in the product's number;
--      a replay of a stored save (same idempotency key) goes through. The screen sends an "id" key on
--      every line (null for a new one); a save of a sprayed or finished job with a line lacking that
--      key (an older cached build, which could not keep the numbers), or with an id that is not a
--      line id at all, is refused with "Reload the app".
--   6. PERMISSION (Mason, 2026-11-06: "Yes, remove it"): signed-in users (and anon) can no longer
--      INSERT, UPDATE, DELETE or TRUNCATE job_chemicals directly. The app never writes it directly:
--      save_job, create_job_from_quote_section, load_recipe_into_job and the quote functions write it
--      with definer rights and are unaffected. Without direct writes a sprayed line cannot be deleted
--      and re-added, or changed in place, to pick up a product's newer EPA number. Reads are unchanged.
--   5. No printout reads the new column yet: every printout keeps reading the product's number, so
--      they all agree. A follow-up change moves the sent proof, applicator sheet, chemical
--      application report and WPS notice onto the line's number together.
--
-- NOT CHANGED: _save_job_cost_step2_impl and every check save_job makes (units, totals, idempotency,
--   roles); invoices and restricted-use records; prices, costs and inventory. _trg_sync_job_holds is
--   re-emitted with one added early return (see (a)); what it rebuilds, and when, is otherwise unchanged.
--
-- SIDE EFFECTS, named: (a) restoring kept numbers in step 4, and a product EPA edit reaching open jobs
--   in step 3, are UPDATEs of job_chemicals that change only the EPA number. They set the
--   transaction-local flag crx.job_line_epa_only for that one statement, and the statement trigger
--   trg_sync_job_holds_upd skips its hold rebuild while it is set: no demand changed, so holds keep
--   their ids, times and creators, and an EPA edit never fails on an unrelated job's hold. (b) Lock order is always
--   the product, then the job, then its lines. A product EPA edit holds its product row, then locks
--   the open jobs using it (FOR UPDATE, in id order) before updating their lines. A line write reads
--   its product FOR SHARE, so an edit in flight finishes first and an edit starting later waits for
--   the line (a first line on a new job included); save_job takes those product locks, in id order,
--   before its job lock. A spray record's foreign key takes the job FOR KEY SHARE. So an EPA edit and
--   a spray, save or line write run one after the other: whichever commits first is seen by the other.
--   (c) save_job now locks the job row before the impl does (FOR UPDATE, the lock the save already takes later), so
--   the lines it reads are the ones it replaces; only an active admin or sales rep gets that far.
-- RARE WAIT: an EPA edit waits for in-flight saves and line writes using that product, and the
--   reverse; other product edits (price, name) wait for those too. lock_timeout, or a deadlock with a
--   writer that locks a job before writing its lines outside save_job, rolls one back whole (retry).
--
-- ROLLBACK (its own reviewed migration): re-emit save_job from its previous body (20261019230000) and
--   _trg_sync_job_holds from 20260702174000, drop the two triggers, the five functions and the column,
--   and re-grant authenticated DELETE and TRUNCATE on job_chemicals and the INSERT and UPDATE column
--   lists of 20261022101000 (a permission change: needs Mason's approval).
--
-- ORDERING: apply after every older pending migration. The parked 20261127100000 must drop its own
--   copy of steps 1-3 and restamp after this file.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE job_lines_keep_epa_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Two steps: outside a transaction the ON COMMIT DROP table is already gone.
  IF to_regclass('pg_temp.job_lines_keep_epa_tx') IS NULL THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.job_lines_keep_epa_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'job_chemicals' AND column_name = 'epa_registration') THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_PREFLIGHT: job_chemicals.epa_registration already exists';
  END IF;
  -- Every function re-emitted here must still be the body this file was written from.
  IF (SELECT count(*) FROM pg_proc p
       WHERE (p.oid, md5(replace(p.prosrc, chr(13), ''))) IN (
         ('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)'::regprocedure, '88ca038686daffbbb2c7a46a05d37e5d'),
         -- Step 4 relies on these: every line deleted and re-written at COALESCE(sort_order, 0).
         ('public._save_job_cost_step2_impl(uuid,jsonb,jsonb,jsonb,uuid,text)'::regprocedure, '8acf34542105a90212ddb0a5e7c5d272'),
         ('public._cost_step2_job_chemicals(uuid,jsonb)'::regprocedure, '5b5dfff699afa368f5f4a7cb72020f38'),
         -- Re-emitted below with one early return (20260702174000).
         ('public._trg_sync_job_holds()'::regprocedure, 'f27618de61e5a9f040b355db278415fa'))
         AND p.proowner = 'postgres'::regrole) <> 4 THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_PREFLIGHT: save_job, the save it wraps or the hold trigger drifted from the body this file was written from';
  END IF;
  -- The column takes only the grants below; that holds only while the app roles have no table-wide
  -- SELECT, INSERT or UPDATE on job_chemicals.
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['authenticated', 'anon']) r(role), unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) v(priv)
              WHERE has_table_privilege(r.role, 'public.job_chemicals', v.priv)) THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_PREFLIGHT: job_chemicals has table-wide app grants; re-plan the column grants';
  END IF;
  -- Step 2 pauses and re-enables this trigger; ENABLE restores the ordinary mode only.
  IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.job_chemicals'::regclass
        AND tgname = 'trg_sync_job_holds_upd') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_PREFLIGHT: trg_sync_job_holds_upd is missing or not in its ordinary mode';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Each job line carries its own EPA number
-- ---------------------------------------------------------------------------------------------

ALTER TABLE public.job_chemicals ADD COLUMN epa_registration text;
COMMENT ON COLUMN public.job_chemicals.epa_registration IS
  'EPA number this line carries: the product''s when the line is written or its product changes; follows product edits only while the job is not sprayed yet; save_job keeps it for a returned line of a sprayed or finished job.';
-- The same read grants the table's other columns have; no app role may write it.
GRANT SELECT (epa_registration) ON public.job_chemicals TO authenticated;
GRANT REFERENCES (epa_registration) ON public.job_chemicals TO authenticated;
GRANT SELECT (epa_registration) ON public.job_chemicals TO anon;
-- Item 6: no direct writes by app roles (table-level REVOKE also removes the column-level grants).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.job_chemicals FROM authenticated, anon;

-- Whether a job's lines still follow their products' EPA numbers: a live job, scheduled or in
-- progress, with no spray recorded. Any other job's lines keep the number they carry.
CREATE FUNCTION public._job_line_epa_follows_product(p_job_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT EXISTS (SELECT 1 FROM public.jobs j
                  WHERE j.id = p_job_id AND j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress'))
     AND NOT EXISTS (SELECT 1 FROM public.job_applied_records r WHERE r.job_id = p_job_id);
$function$;
ALTER FUNCTION public._job_line_epa_follows_product(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_line_epa_follows_product(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- The body of 20260702174000 with one early return: an UPDATE that changes only lines' EPA numbers
-- (steps 3 and 4 set crx.job_line_epa_only for that one statement) changes no demand, so holds stay.
CREATE OR REPLACE FUNCTION public._trg_sync_job_holds()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('crx.job_line_epa_only', true) = 'on' THEN
    RETURN NULL;
  END IF;
  FOR r IN SELECT DISTINCT job_id FROM affected WHERE job_id IS NOT NULL LOOP
    PERFORM _sync_job_holds(r.job_id, auth.uid());
  END LOOP;
  RETURN NULL;  -- AFTER STATEMENT: return value ignored
END;
$function$;

-- A written line takes its product's number, read with the product row locked FOR SHARE (see (b)).
CREATE FUNCTION public._job_chemical_epa() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.job_id IS NOT DISTINCT FROM OLD.job_id THEN
    NEW.epa_registration := OLD.epa_registration;
    RETURN NEW;
  END IF;
  -- A line of a sprayed or finished job keeps its number: changing its product or job in place would
  -- give it some product's current number. App roles cannot write lines directly (item 6) and no
  -- server function updates these columns; this guards a future one or a SQL fix.
  IF TG_OP = 'UPDATE' AND (NOT public._job_line_epa_follows_product(OLD.job_id)
                           OR NOT public._job_line_epa_follows_product(NEW.job_id)) THEN
    RAISE EXCEPTION 'A line on a sprayed or finished job cannot change product or move to another job. Edit the job and save it instead.'
      USING ERRCODE = '55000';
  END IF;
  -- FOR SHARE on the product: an EPA edit in flight finishes first and this reads its number, and an
  -- edit that starts later waits until this line commits, so it sees the line (even on a new job).
  -- trg_guard_seed_each_job_chemical_units (20261104150000) takes the same lock; this one does not rely on it.
  SELECT NULLIF(btrim(p.epa_registration), '') INTO NEW.epa_registration
    FROM public.products p WHERE p.id = NEW.product_id FOR SHARE;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._job_chemical_epa() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_chemical_epa() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_job_chemical_epa BEFORE INSERT OR UPDATE OF product_id, job_id ON public.job_chemicals
FOR EACH ROW EXECUTE FUNCTION public._job_chemical_epa();

-- ---------------------------------------------------------------------------------------------
-- 2. Existing lines: the number every printout shows today
-- ---------------------------------------------------------------------------------------------
-- Only the new column changes, so the statement trigger that rebuilds inventory holds is paused for
-- this one statement; ADD COLUMN above already holds this table's ACCESS EXCLUSIVE lock.
ALTER TABLE public.job_chemicals DISABLE TRIGGER trg_sync_job_holds_upd;
UPDATE public.job_chemicals jc SET epa_registration = NULLIF(btrim(p.epa_registration), '')
  FROM public.products p
 WHERE p.id = jc.product_id AND NULLIF(btrim(p.epa_registration), '') IS NOT NULL;
ALTER TABLE public.job_chemicals ENABLE TRIGGER trg_sync_job_holds_upd;

-- ---------------------------------------------------------------------------------------------
-- 3. A product EPA edit reaches jobs not sprayed yet
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public._product_epa_to_unsprayed_job_lines() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  -- Lock every open job using this product first, in id order: a spray, save or line write in flight
  -- on one of them finishes before the update below, which then sees it (a new statement).
  PERFORM 1 FROM public.jobs j
   WHERE j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress')
     AND EXISTS (SELECT 1 FROM public.job_chemicals jc WHERE jc.job_id = j.id AND jc.product_id = NEW.id)
   ORDER BY j.id FOR UPDATE;
  PERFORM set_config('crx.job_line_epa_only', 'on', true);
  UPDATE public.job_chemicals jc SET epa_registration = NULLIF(btrim(NEW.epa_registration), '')
   WHERE jc.product_id = NEW.id
     AND jc.epa_registration IS DISTINCT FROM NULLIF(btrim(NEW.epa_registration), '')
     AND public._job_line_epa_follows_product(jc.job_id);
  PERFORM set_config('crx.job_line_epa_only', 'off', true);
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public._product_epa_to_unsprayed_job_lines() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_epa_to_unsprayed_job_lines() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_product_epa_to_unsprayed_job_lines AFTER UPDATE OF epa_registration ON public.products
FOR EACH ROW WHEN (NULLIF(btrim(OLD.epa_registration), '') IS DISTINCT FROM NULLIF(btrim(NEW.epa_registration), ''))
EXECUTE FUNCTION public._product_epa_to_unsprayed_job_lines();

-- ---------------------------------------------------------------------------------------------
-- 4. save_job keeps a returned line's number
-- ---------------------------------------------------------------------------------------------

-- Before the save: lock the job, then list each sent line that names a line of this job by its
-- "id" and keeps the same product: its sort_order (the key the save writes it under), product and
-- stored number. A line id or sort_order sent twice keeps nothing (it would be ambiguous), and a
-- malformed value keeps nothing and is left to save_job's own refusals.
-- Scope: this guards a line's identity, not the whole job. A save that sends no old line ids (all new
-- lines, or none) replaces the job's lines like any edit does; no line claims to be an old one, so
-- each new line takes its product's current number, the same as adding a line by hand.
CREATE FUNCTION public._job_line_epa_kept(p_job_id uuid, p_chemicals jsonb, p_replay boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  IF p_job_id IS NULL OR jsonb_typeof(p_chemicals) IS DISTINCT FROM 'array' THEN
    RETURN '[]'::jsonb;
  END IF;
  PERFORM 1 FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  -- A sprayed or finished job: a sent line id that is no longer a line of this job means the screen is
  -- stale (another tab or device saved since it loaded). Refuse, so it reloads instead of the save
  -- silently giving that line the product's current number. A replay of a stored save goes through
  -- (p_replay: save_job reads its receipt after taking this same job lock).
  IF NOT p_replay AND NOT public._job_line_epa_follows_product(p_job_id) THEN
    -- The job screen sends an "id" key on every line (null for a new line); an older cached build
    -- sends none, so it could not keep a sprayed job's numbers. Refuse it until the app reloads.
    -- A non-null id that is not a line id at all is no screen's: refuse it the same way.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_chemicals) e
                WHERE jsonb_typeof(e.value) = 'object'
                  AND (NOT (e.value ? 'id')
                       OR (jsonb_typeof(e.value->'id') <> 'null'
                           AND (jsonb_typeof(e.value->'id') <> 'string' OR NOT ((e.value->>'id') ~ v_uuid))))) THEN
      RAISE EXCEPTION 'This screen is out of date. Reload the app, then save this job again.'
        USING ERRCODE = '40001';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_chemicals) e
                WHERE jsonb_typeof(e.value) = 'object' AND (e.value->>'id') ~ v_uuid
                  AND NOT EXISTS (SELECT 1 FROM public.job_chemicals jc
                                   WHERE jc.id = (e.value->>'id')::uuid AND jc.job_id = p_job_id)) THEN
      RAISE EXCEPTION 'This job was saved somewhere else since you opened it. Reload the job, then make your changes again.'
        USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN COALESCE((
    WITH sent AS (
      SELECT e.value->>'id' AS line_id, e.value->>'product_id' AS product_id,
             -- save_job writes COALESCE(sort_order, 0)
             CASE WHEN e.value->>'sort_order' IS NULL THEN 0
                  WHEN (e.value->>'sort_order') ~ '^[+-]?[0-9]{1,9}$' THEN (e.value->>'sort_order')::integer
             END AS sort_order
        FROM jsonb_array_elements(p_chemicals) e
       WHERE jsonb_typeof(e.value) = 'object'
    ), counted AS (
      SELECT s.*, count(*) OVER (PARTITION BY s.sort_order) AS n_sort,
             count(*) OVER (PARTITION BY lower(s.line_id)) AS n_id
        FROM sent s
    ), clear AS (
      SELECT c.* FROM counted c
       WHERE c.sort_order IS NOT NULL AND c.line_id ~ v_uuid AND c.product_id ~ v_uuid
         AND c.n_sort = 1 AND c.n_id = 1
    )
    SELECT jsonb_agg(jsonb_build_object('sort_order', c.sort_order, 'product_id', jc.product_id,
                                        'epa_registration', jc.epa_registration))
      FROM clear c
      JOIN public.job_chemicals jc ON jc.id = c.line_id::uuid AND jc.job_id = p_job_id
                                  AND jc.product_id = c.product_id::uuid
  ), '[]'::jsonb);
END;
$function$;
ALTER FUNCTION public._job_line_epa_kept(uuid, jsonb, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_line_epa_kept(uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- After the save: when the job is sprayed or finished, each rewritten line at a kept sort_order with
-- the same product takes back its stored number. A job not sprayed yet follows its products.
CREATE FUNCTION public._job_line_epa_restore(p_job_id uuid, p_kept jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF p_job_id IS NULL OR jsonb_array_length(p_kept) = 0 OR public._job_line_epa_follows_product(p_job_id) THEN
    RETURN;
  END IF;
  -- Only when a number differs (an ordinary re-save writes nothing here).
  IF NOT EXISTS (SELECT 1 FROM public.job_chemicals jc
                   JOIN jsonb_to_recordset(p_kept) k(sort_order integer, product_id uuid, epa_registration text)
                     ON jc.sort_order = k.sort_order AND jc.product_id = k.product_id
                  WHERE jc.job_id = p_job_id AND jc.epa_registration IS DISTINCT FROM k.epa_registration
                    AND NOT EXISTS (SELECT 1 FROM public.job_chemicals d
                                     WHERE d.job_id = jc.job_id AND d.sort_order = jc.sort_order AND d.id <> jc.id)) THEN
    RETURN;
  END IF;
  PERFORM set_config('crx.job_line_epa_only', 'on', true);
  UPDATE public.job_chemicals jc SET epa_registration = k.epa_registration
    FROM jsonb_to_recordset(p_kept) k(sort_order integer, product_id uuid, epa_registration text)
   WHERE jc.job_id = p_job_id AND jc.sort_order = k.sort_order AND jc.product_id = k.product_id
     AND jc.epa_registration IS DISTINCT FROM k.epa_registration
     -- A position written twice (a sort_order spelling the helper did not read) is ambiguous: keep nothing.
     AND NOT EXISTS (SELECT 1 FROM public.job_chemicals d
                      WHERE d.job_id = jc.job_id AND d.sort_order = jc.sort_order AND d.id <> jc.id);
  PERFORM set_config('crx.job_line_epa_only', 'off', true);
END;
$function$;
ALTER FUNCTION public._job_line_epa_restore(uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_line_epa_restore(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- The body of 20261019230000, with the kept numbers read before the save and restored after it.
CREATE OR REPLACE FUNCTION public.save_job(
  p_job_id uuid, p_job_payload jsonb, p_fields jsonb, p_chemicals jsonb,
  p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_kept jsonb;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()' USING ERRCODE = 'P0001';
  END IF;
  -- A sprayed or finished job's returned lines keep their EPA number (20261202115000).
  -- Only staff reach the job lock; anyone else is refused by the impl's own role check.
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active = true
                AND role IN ('admin', 'sales_rep')) THEN
    -- Products before the job: the order an EPA edit takes them (its product row, then the jobs).
    PERFORM 1 FROM public.products p
     WHERE p.id::text IN (SELECT lower(e->>'product_id') FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p_chemicals) = 'array' THEN p_chemicals ELSE '[]'::jsonb END) e)
     ORDER BY p.id FOR SHARE;
    -- The job lock before the receipt read: an identical keyed save in flight commits first, so its
    -- receipt is seen and this call replays it (the impl checks the replay's actor and payload).
    PERFORM 1 FROM public.jobs WHERE id = p_job_id FOR UPDATE;
    v_kept := public._job_line_epa_kept(p_job_id, p_chemicals,
      -- An expired receipt is not a replay: check_idempotency deletes it (expires_at < now()) and the
      -- save runs again, so it gets the stale-line checks too.
      p_idempotency_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.idempotency_keys
                                                WHERE idempotency_key = p_idempotency_key AND operation = 'save_job'
                                                  AND NOT (expires_at < now())));
  END IF;
  -- Cost is admin-only (Mason, 2026-10-15): a non-admin's chemical cost comes from the server.
  -- The impl keeps every check it had (actor, role, units, totals, idempotency).
  IF public.is_admin() THEN
    v_result := public._save_job_cost_step2_impl(
      p_job_id, p_job_payload, p_fields, p_chemicals, p_performed_by, p_idempotency_key);
  ELSE
    v_result := public._save_job_cost_step2_impl(
      p_job_id, p_job_payload, p_fields,
      public._cost_step2_job_chemicals(p_job_id, p_chemicals),
      p_performed_by, p_idempotency_key);
  END IF;
  PERFORM public._job_line_epa_restore(p_job_id, v_kept);
  RETURN v_result;
END;
$function$;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM public.job_chemicals jc JOIN public.products p ON p.id = jc.product_id
       WHERE jc.epa_registration IS DISTINCT FROM NULLIF(btrim(p.epa_registration), '')) <> 0 THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_POSTFLIGHT: a job line does not carry its product''s EPA number';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['authenticated', 'anon']) r(role), unnest(ARRAY['INSERT', 'UPDATE']) v(priv)
              WHERE has_column_privilege(r.role, 'public.job_chemicals', 'epa_registration', v.priv)) THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_POSTFLIGHT: an app role can write job_chemicals.epa_registration';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['authenticated', 'anon']) r(role), unnest(ARRAY['INSERT', 'UPDATE']) v(priv)
              WHERE has_any_column_privilege(r.role, 'public.job_chemicals', v.priv))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['authenticated', 'anon']) r(role), unnest(ARRAY['DELETE', 'TRUNCATE']) v(priv)
                 WHERE has_table_privilege(r.role, 'public.job_chemicals', v.priv))
     OR NOT has_column_privilege('authenticated', 'public.job_chemicals', 'product_id', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.job_chemicals', 'epa_registration', 'SELECT') THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_POSTFLIGHT: an app role can still write job_chemicals directly, or lost its read grants';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)', 'EXECUTE')
     THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_POSTFLIGHT: save_job grants changed';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r(role),
                    unnest(ARRAY['public._job_line_epa_follows_product(uuid)', 'public._job_chemical_epa()',
                                 'public._product_epa_to_unsprayed_job_lines()', 'public._job_line_epa_kept(uuid,jsonb,boolean)',
                                 'public._job_line_epa_restore(uuid,jsonb)']) f(sig)
              WHERE has_function_privilege(r.role, f.sig, 'EXECUTE')) THEN
    RAISE EXCEPTION 'JOB_LINES_KEEP_EPA_POSTFLIGHT: an app role can run a new helper';
  END IF;
END
$postflight$;
