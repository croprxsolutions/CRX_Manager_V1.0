-- Field application FP-1 (docs/plans/field-application/CONTRACT-who-pays.md › FP-1): one split per field, with history.
--
-- WHY: a field's split (who pays and what share) lived only in field_billing_defaults, rewritten in place on every
--   Field Setup save, so the split in force on an earlier spray date was lost and a 0% payer could not be stored.
--
-- WHAT:
--   1. field_billing_split_versions + field_billing_split_payers: append-only history. Each version starts on a date
--      the office picks (past or future) and carries two share sets, product and application, in micro-percent
--      (100,000,000 = 100%), each totalling exactly 100,000,000 (deferred check at commit). A payer may be 0% on one
--      side or both. UPDATE, DELETE and TRUNCATE are refused, and a payer can only be added to a version created in
--      the same transaction.
--   2. field_payer_notes: plain editable notes per field and customer (not versioned).
--   3. set_field_billing_split(...): the office writer (replay-safe), and field_split_as_of(...): the office resolver.
--      Both SECURITY DEFINER, admin or sales rep only; the writer, the resolver, save_field and the three new tables' read rules also refuse a rep with
--      Fields & Maps turned off in Settings > Page Access (PAGE_ACCESS_DENIED). save_field now writes through the same internal writer.
--   4. field_billing_defaults becomes a read-only COPY of the version in force today (Central date, product shares
--      above 0%; primary = the owner when paying, else the largest share), rewritten by the writer and by a pg_cron job just after Central midnight. Its
--      browser and service_role writes (INSERT, UPDATE, DELETE, TRUNCATE) are revoked and the three write policies dropped (I approve: access
--      change). Nothing in the app writes it directly (save_field was its only writer). Applicators keep reading it
--      through fbd_select (unchanged); they get no access to the new tables.
--   5. fields.customer_id: ON DELETE CASCADE -> RESTRICT (I approve: constraint change). No customer-delete flow
--      exists in the app; deleting a customer who owns or pays on a field is now refused.
--   6. Backfill: each field's current split becomes version 1 (history_known = false, from 1900-01-01, both share
--      sets = today's percent x 1,000,000, any rounding difference to the largest share, lowest customer id on a tie).
--   7. Until FP-4: each payer's product and application shares must be equal (FIELD_SPLIT_SHARES_MUST_MATCH_UNTIL_FP4),
--      because job billing still falls back to the copy, which holds one share per payer.
--
-- save_field changes (same signature, wrapper unchanged; only _save_field_replay_impl_20261015 is replaced):
--   - a NULL p_billing_defaults leaves the split and notes as they are (field details only; before: NULL deleted the split);
--   - an empty p_billing_defaults on a field with a split in force is refused (FIELD_SPLIT_CLEAR_REFUSED; before: it
--     deleted the split and Create Invoice then stopped for that field); on a field with no split in force it writes nothing;
--   - a split equal to today's in-force product shares (payers above 0%) writes no version (an old-screen name-only
--     save); a different one writes a version starting Central today with product = application shares;
--   - each element's notes go to field_payer_notes; is_primary is ignored (the copy marks the owner primary when paying, else the largest share);
--   - a price_override_cents or pricing_note is refused (per-acre pricing is retired, 20270224110000).
--
-- CUTOVER (rule 6, inside this transaction after the locks): stops if any field_billing_defaults row carries a
--   per-acre price or note, a primary mark the copy would move (owner if paying, else largest share), or a
--   rounding difference over 10,000 micro-percent. Permitted live counts (read-only 2026-11-24): 5 fields with a split,
--   6 rows, 0 of each stop condition. Staging (2026-11-24): TEST fields only, incl. a non-owner 100% primary (kept).
--
-- NOT CHANGED: every reader of field_billing_defaults (they read the copy until FP-4 moves them), fbd_select, the
--   sum-100 trigger, save_field's wrapper and grants, fields policies.
--
-- KNOWN EFFECT: deleting a field that has a split is refused (its versions are history) until FP-3 adds archiving;
--   the office marks such a field inactive instead. A field with no split still deletes as before.
--
-- ROLLBACK (its own reviewed migration): restore _save_field_replay_impl_20261015 to the 20261107140000 body, the three
--   fbd write policies and grants, fields_customer_id_fkey ON DELETE CASCADE; unschedule 'field-split-copy-refresh';
--   drop the new functions, field_billing_defaults.source_split_version_id and the three new tables (history lost).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE field_split_versions_20270303_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.field_split_versions_20270303_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.field_split_versions_20270303_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regclass('public.field_billing_split_versions') IS NOT NULL
     OR to_regclass('public.field_billing_split_payers') IS NOT NULL
     OR to_regclass('public.field_payer_notes') IS NOT NULL THEN
    RAISE EXCEPTION 'FIELD_SPLIT_BASELINE_DRIFT: the split history tables already exist (already applied?)';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public._save_field_replay_impl_20261015(uuid,jsonb,jsonb,uuid,text)'))
     IS DISTINCT FROM 'b540e435969d29de542ef9ccddaddc31' THEN
    RAISE EXCEPTION 'FIELD_SPLIT_BASELINE_DRIFT: _save_field_replay_impl_20261015 is not the 20261107140000 body';
  END IF;
  IF (SELECT md5(coalesce(string_agg(policyname || ':' || cmd || ':' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ';' ORDER BY policyname), ''))
        FROM pg_policies WHERE schemaname = 'public' AND tablename = 'field_billing_defaults')
     IS DISTINCT FROM '6b4289f5b113ec1f8b56dd82ba47a366' THEN
    RAISE EXCEPTION 'FIELD_SPLIT_BASELINE_DRIFT: field_billing_defaults policies are not the expected four';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.fields'::regclass AND conname = 'fields_customer_id_fkey')
     IS DISTINCT FROM 'FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE' THEN
    RAISE EXCEPTION 'FIELD_SPLIT_BASELINE_DRIFT: fields_customer_id_fkey is not ON DELETE CASCADE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.field_billing_defaults'::regclass
                   AND conname = 'field_billing_defaults_no_per_acre_price' AND convalidated) THEN
    RAISE EXCEPTION 'FIELD_SPLIT_BASELINE_DRIFT: 20270224110000 (no per-acre price) must be applied first';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'field-split-copy-refresh') THEN
    RAISE EXCEPTION 'FIELD_SPLIT_BASELINE_DRIFT: cron job field-split-copy-refresh already exists';
  END IF;
END;
$preflight$;

-- Fields before splits: the order save_field takes them (UPDATE fields, then the split rows). Customers and profiles
-- last, for the new foreign keys; nothing takes them and then fields.
LOCK TABLE public.fields, public.field_billing_defaults IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.customers, public.profiles IN SHARE ROW EXCLUSIVE MODE;

-- Cutover inventory (rule 6): after the locks, so nothing changes between the count and the change.
DO $cutover$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(DISTINCT field_id::text, ', ') INTO v_bad FROM public.field_billing_defaults
   WHERE price_override_cents IS NOT NULL OR pricing_note IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FIELD_SPLIT_CUTOVER_STOP: per-acre price or pricing note on field(s) %', v_bad;
  END IF;
  -- The copy marks the owner primary when the owner pays, else the largest share (lowest customer id on a tie). Stop
  -- rather than silently move today's primary mark (a non-owner primary while the owner pays, or no single primary).
  SELECT string_agg(DISTINCT fbd.field_id::text, ', ') INTO v_bad
    FROM public.field_billing_defaults fbd JOIN public.fields f ON f.id = fbd.field_id
   WHERE fbd.is_primary IS DISTINCT FROM (fbd.customer_id = (
           SELECT q.customer_id FROM public.field_billing_defaults q WHERE q.field_id = fbd.field_id
            ORDER BY (q.customer_id = f.customer_id) DESC, q.split_pct DESC, q.customer_id LIMIT 1));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FIELD_SPLIT_CUTOVER_STOP: the primary payer on field(s) % is not the one the copy will mark (the owner if paying, else the largest share)', v_bad;
  END IF;
  SELECT string_agg(DISTINCT field_id::text, ', ') INTO v_bad FROM public.field_billing_defaults WHERE length(notes) > 2000;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FIELD_SPLIT_CUTOVER_STOP: a payer note over 2000 characters on field(s) %', v_bad;
  END IF;
  RAISE NOTICE 'FIELD_SPLIT_CUTOVER: % field(s) with a split, % split row(s)',
    (SELECT count(DISTINCT field_id) FROM public.field_billing_defaults), (SELECT count(*) FROM public.field_billing_defaults);
END;
$cutover$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE public.field_billing_split_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id uuid NOT NULL REFERENCES public.fields(id) ON DELETE RESTRICT,
  version_number integer NOT NULL CHECK (version_number >= 1),
  effective_from date NOT NULL,
  history_known boolean NOT NULL DEFAULT true,
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  created_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE (field_id, version_number)
);
CREATE INDEX field_billing_split_versions_lookup_idx
  ON public.field_billing_split_versions (field_id, effective_from DESC, version_number DESC);

CREATE TABLE public.field_billing_split_payers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES public.field_billing_split_versions(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  product_share_micro_pct integer NOT NULL CHECK (product_share_micro_pct BETWEEN 0 AND 100000000),
  application_share_micro_pct integer NOT NULL CHECK (application_share_micro_pct BETWEEN 0 AND 100000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, customer_id)
);
CREATE INDEX field_billing_split_payers_customer_idx ON public.field_billing_split_payers (customer_id);

CREATE TABLE public.field_payer_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id uuid NOT NULL REFERENCES public.fields(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  pricing_note text CHECK (pricing_note IS NULL OR length(pricing_note) <= 2000),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (field_id, customer_id)
);
CREATE INDEX field_payer_notes_customer_idx ON public.field_payer_notes (customer_id);

ALTER TABLE public.field_billing_defaults
  ADD COLUMN source_split_version_id uuid REFERENCES public.field_billing_split_versions(id) ON DELETE RESTRICT;
COMMENT ON COLUMN public.field_billing_defaults.source_split_version_id IS
  'FP-1: the split version this copy row was written from. field_billing_defaults is a read-only copy of the version in force today.';

-- Access: office reads all; nobody writes directly (the SECURITY DEFINER writer does). anon gets nothing.
ALTER TABLE public.field_billing_split_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_billing_split_payers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_payer_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.field_billing_split_versions, public.field_billing_split_payers, public.field_payer_notes
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.field_billing_split_versions, public.field_billing_split_payers, public.field_payer_notes
  TO authenticated;
GRANT SELECT ON public.field_billing_split_versions, public.field_billing_split_payers, public.field_payer_notes
  TO service_role;
CREATE POLICY field_billing_split_versions_select ON public.field_billing_split_versions
  FOR SELECT TO authenticated USING ((public.is_admin() OR public.is_sales_rep())
    AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IS DISTINCT FROM 'admin'
                    AND 'fields' = ANY (COALESCE(p.denied_pages, ARRAY[]::text[]))));
CREATE POLICY field_billing_split_payers_select ON public.field_billing_split_payers
  FOR SELECT TO authenticated USING ((public.is_admin() OR public.is_sales_rep())
    AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IS DISTINCT FROM 'admin'
                    AND 'fields' = ANY (COALESCE(p.denied_pages, ARRAY[]::text[]))));
CREATE POLICY field_payer_notes_select ON public.field_payer_notes
  FOR SELECT TO authenticated USING ((public.is_admin() OR public.is_sales_rep())
    AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IS DISTINCT FROM 'admin'
                    AND 'fields' = ANY (COALESCE(p.denied_pages, ARRAY[]::text[]))));

CREATE TRIGGER set_field_payer_notes_updated_at BEFORE UPDATE ON public.field_payer_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------------------------------------------------------
-- 2. History is append-only
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public._field_split_history_append_only_20270303()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'FIELD_SPLIT_HISTORY_APPEND_ONLY: % on % is refused; save a new split version instead', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$function$;
REVOKE ALL ON FUNCTION public._field_split_history_append_only_20270303() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER field_billing_split_versions_append_only BEFORE UPDATE OR DELETE ON public.field_billing_split_versions
  FOR EACH ROW EXECUTE FUNCTION public._field_split_history_append_only_20270303();
CREATE TRIGGER field_billing_split_versions_no_truncate BEFORE TRUNCATE ON public.field_billing_split_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public._field_split_history_append_only_20270303();
CREATE TRIGGER field_billing_split_payers_append_only BEFORE UPDATE OR DELETE ON public.field_billing_split_payers
  FOR EACH ROW EXECUTE FUNCTION public._field_split_history_append_only_20270303();
CREATE TRIGGER field_billing_split_payers_no_truncate BEFORE TRUNCATE ON public.field_billing_split_payers
  FOR EACH STATEMENT EXECUTE FUNCTION public._field_split_history_append_only_20270303();

CREATE FUNCTION public._field_split_payer_same_transaction_20270303()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.field_billing_split_versions v
                  WHERE v.id = NEW.version_id AND v.created_txid = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'FIELD_SPLIT_VERSION_CLOSED: payers are added only with their version; save a new split version instead'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public._field_split_payer_same_transaction_20270303() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER field_billing_split_payers_same_transaction BEFORE INSERT ON public.field_billing_split_payers
  FOR EACH ROW EXECUTE FUNCTION public._field_split_payer_same_transaction_20270303();

-- At commit: every version has a payer, and each share set totals exactly 100,000,000.
CREATE FUNCTION public._field_split_version_totals_20270303()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  v_version uuid;
  v_count bigint;
  v_product bigint;
  v_application bigint;
BEGIN
  -- Separate branches: PL/pgSQL resolves NEW.version_id even in a CASE branch that is not taken.
  IF TG_TABLE_NAME = 'field_billing_split_versions' THEN
    v_version := NEW.id;
  ELSE
    v_version := NEW.version_id;
  END IF;
  SELECT count(*), COALESCE(sum(product_share_micro_pct), 0), COALESCE(sum(application_share_micro_pct), 0)
    INTO v_count, v_product, v_application
    FROM public.field_billing_split_payers WHERE version_id = v_version;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'FIELD_SPLIT_NO_PAYERS: split version % has no payers', v_version USING ERRCODE = '23514';
  END IF;
  IF v_product <> 100000000 OR v_application <> 100000000 THEN
    RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: split version % totals % product and % application micro-percent; each must be exactly 100,000,000',
      v_version, v_product, v_application USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public._field_split_version_totals_20270303() FROM PUBLIC, anon, authenticated, service_role;
CREATE CONSTRAINT TRIGGER field_billing_split_versions_totals AFTER INSERT ON public.field_billing_split_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public._field_split_version_totals_20270303();
CREATE CONSTRAINT TRIGGER field_billing_split_payers_totals AFTER INSERT ON public.field_billing_split_payers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public._field_split_version_totals_20270303();

-- ---------------------------------------------------------------------------------------------------------------
-- 3. The transition copy (field_billing_defaults = the version in force today, Central)
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public._field_split_today_20270303()
RETURNS date LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $function$ SELECT (now() AT TIME ZONE 'America/Chicago')::date $function$;
REVOKE ALL ON FUNCTION public._field_split_today_20270303() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._field_split_in_force_20270303(p_field_id uuid, p_on_date date)
RETURNS uuid LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $function$
  SELECT v.id FROM public.field_billing_split_versions v
   WHERE v.field_id = p_field_id AND v.effective_from <= p_on_date
   ORDER BY v.effective_from DESC, v.version_number DESC LIMIT 1
$function$;
REVOKE ALL ON FUNCTION public._field_split_in_force_20270303(uuid, date) FROM PUBLIC, anon, authenticated, service_role;

-- What the copy should hold for a field today, and what it holds; equal means nothing to rewrite.
CREATE FUNCTION public._field_billing_copy_expected_20270303(p_field_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $function$
  -- Primary: the owner when the owner pays product, otherwise the largest product share (lowest customer id on a tie).
  WITH paying AS (
    SELECT p.customer_id, p.product_share_micro_pct, p.version_id, f.id AS field_id, f.customer_id AS owner_id
      FROM public.fields f
      JOIN public.field_billing_split_payers p
        ON p.version_id = public._field_split_in_force_20270303(f.id, public._field_split_today_20270303())
     WHERE f.id = p_field_id AND p.product_share_micro_pct > 0
  ), pri AS (
    SELECT customer_id FROM paying
     ORDER BY (customer_id = owner_id) DESC, product_share_micro_pct DESC, customer_id LIMIT 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'c', y.customer_id, 'pct', (y.product_share_micro_pct::numeric / 1000000)::numeric(9,6),
           'pri', y.customer_id = (SELECT customer_id FROM pri), 'n', n.notes, 's', y.version_id) ORDER BY y.customer_id), '[]'::jsonb)
    FROM paying y
    LEFT JOIN public.field_payer_notes n ON n.field_id = y.field_id AND n.customer_id = y.customer_id
$function$;
REVOKE ALL ON FUNCTION public._field_billing_copy_expected_20270303(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._field_billing_copy_actual_20270303(p_field_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'c', d.customer_id, 'pct', d.split_pct::numeric(9,6), 'pri', d.is_primary, 'n', d.notes,
           's', d.source_split_version_id) ORDER BY d.customer_id), '[]'::jsonb)
    FROM public.field_billing_defaults d WHERE d.field_id = p_field_id
$function$;
REVOKE ALL ON FUNCTION public._field_billing_copy_actual_20270303(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Caller holds the field row FOR UPDATE.
CREATE FUNCTION public._refresh_field_billing_defaults_copy_20270303(p_field_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  v_expected jsonb := public._field_billing_copy_expected_20270303(p_field_id);
BEGIN
  IF v_expected = public._field_billing_copy_actual_20270303(p_field_id) THEN
    RETURN false;
  END IF;
  DELETE FROM public.field_billing_defaults WHERE field_id = p_field_id;
  INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, notes, source_split_version_id)
  SELECT p_field_id, (e->>'c')::uuid, (e->>'pct')::numeric, (e->>'pri')::boolean, e->>'n', (e->>'s')::uuid
    FROM jsonb_array_elements(v_expected) e;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public._refresh_field_billing_defaults_copy_20270303(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- pg_cron, just after Central midnight (05:10 and 06:10 UTC cover both CST and CDT; a missed run is caught by the next).
CREATE FUNCTION public._refresh_all_field_billing_copies_20270303()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '30s'
AS $function$
DECLARE
  v_field uuid;
  v_changed integer := 0;
BEGIN
  FOR v_field IN
    SELECT f.id FROM public.fields f
     WHERE (EXISTS (SELECT 1 FROM public.field_billing_split_versions v WHERE v.field_id = f.id)
            OR EXISTS (SELECT 1 FROM public.field_billing_defaults d WHERE d.field_id = f.id))
       AND public._field_billing_copy_expected_20270303(f.id) IS DISTINCT FROM public._field_billing_copy_actual_20270303(f.id)
     ORDER BY f.id
  LOOP
    -- A field row someone holds (an invoice draft, a split save) is skipped, never waited on while this run holds
    -- field_billing_defaults rows: waiting could deadlock with an order invoice that locks a field and then the table.
    -- The next run (or that field's next save) refreshes it.
    PERFORM 1 FROM public.fields WHERE id = v_field FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN NOT FOUND;
    IF public._refresh_field_billing_defaults_copy_20270303(v_field) THEN
      v_changed := v_changed + 1;
    END IF;
  END LOOP;
  RETURN v_changed;
END;
$function$;
ALTER FUNCTION public._refresh_all_field_billing_copies_20270303() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._refresh_all_field_billing_copies_20270303() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. The internal writer (set_field_billing_split, save_field and the Chem Man import all call it)
-- ---------------------------------------------------------------------------------------------------------------
-- p_payers NULL = no split sent (notes only). p_notes NULL = leave notes as they are; per element, a key that is
-- present sets that note (null clears it), a missing key leaves it. p_actor must be the signed-in user (or NULL for
-- a run with no signed-in user: the backfill below and the one-time import).
CREATE FUNCTION public._set_field_billing_split_20270303(
  p_field_id uuid, p_effective_from date, p_payers jsonb, p_notes jsonb, p_reason text, p_actor uuid,
  p_history_known boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_owner uuid;
  v_in_force uuid;
  v_in_force_from date;
  v_new jsonb;
  v_old jsonb;
  v_version uuid;
  v_number integer;
  v_bad text;
  v_notes_changed integer := 0;
BEGIN
  IF p_actor IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: the split is saved as the signed-in user' USING ERRCODE = '42501';
  END IF;

  IF length(btrim(p_reason)) > 500 THEN
    RAISE EXCEPTION 'FIELD_SPLIT_REASON_TOO_LONG: the reason is at most 500 characters' USING ERRCODE = '22023';
  END IF;

  SELECT customer_id INTO v_owner FROM public.fields WHERE id = p_field_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FIELD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF p_payers IS NOT NULL THEN
    IF p_effective_from IS NULL OR NOT isfinite(p_effective_from) THEN
      RAISE EXCEPTION 'FIELD_SPLIT_DATE_REQUIRED: a split needs the date it starts' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_payers) <> 'array' OR jsonb_array_length(p_payers) = 0 THEN
      RAISE EXCEPTION 'FIELD_SPLIT_NO_PAYERS: a split needs at least one payer' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_payers) e
       WHERE jsonb_typeof(e) <> 'object'
          OR jsonb_typeof(e->'customer_id') IS DISTINCT FROM 'string'
          OR (e->>'customer_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR jsonb_typeof(e->'product_share_micro_pct') IS DISTINCT FROM 'number'
          OR jsonb_typeof(e->'application_share_micro_pct') IS DISTINCT FROM 'number') THEN
      RAISE EXCEPTION 'FIELD_SPLIT_INVALID_SHARE: each payer needs a customer and two whole-number shares from 0 to 100,000,000'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_payers) e
       WHERE (e->>'product_share_micro_pct')::numeric NOT BETWEEN 0 AND 100000000
          OR (e->>'application_share_micro_pct')::numeric NOT BETWEEN 0 AND 100000000
          OR (e->>'product_share_micro_pct')::numeric <> trunc((e->>'product_share_micro_pct')::numeric)
          OR (e->>'application_share_micro_pct')::numeric <> trunc((e->>'application_share_micro_pct')::numeric)) THEN
      RAISE EXCEPTION 'FIELD_SPLIT_INVALID_SHARE: each payer needs a customer and two whole-number shares from 0 to 100,000,000'
        USING ERRCODE = '22023';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('c', c, 'p', p, 'a', a) ORDER BY c) INTO v_new
      FROM (SELECT (e->>'customer_id')::uuid c, (e->>'product_share_micro_pct')::numeric::integer p,
                   (e->>'application_share_micro_pct')::numeric::integer a FROM jsonb_array_elements(p_payers) e) s;
    IF (SELECT count(DISTINCT x->>'c') FROM jsonb_array_elements(v_new) x) <> jsonb_array_length(v_new) THEN
      RAISE EXCEPTION 'FIELD_SPLIT_DUPLICATE_PAYER: a customer is listed twice' USING ERRCODE = '22023';
    END IF;
    IF (SELECT sum((x->>'p')::bigint) FROM jsonb_array_elements(v_new) x) <> 100000000
       OR (SELECT sum((x->>'a')::bigint) FROM jsonb_array_elements(v_new) x) <> 100000000 THEN
      RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: product shares and application shares must each total exactly 100%%'
        USING ERRCODE = '22023';
    END IF;
    -- shortcut: until FP-4 moves job billing off field_billing_defaults (one share per payer, so transfer_job_to_invoice
    -- would bill application at the product share), each payer's two shares must match. FP-4 removes this check.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_new) x WHERE (x->>'p')::integer <> (x->>'a')::integer) THEN
      RAISE EXCEPTION 'FIELD_SPLIT_SHARES_MUST_MATCH_UNTIL_FP4: until job billing reads split history, each payer''s product and application shares must be equal'
        USING ERRCODE = '22023';
    END IF;

    SELECT v.id, v.effective_from INTO v_in_force, v_in_force_from FROM public.field_billing_split_versions v
     WHERE v.id = public._field_split_in_force_20270303(p_field_id, p_effective_from);
    -- A payer must be an active customer, unless it is the field's owner or already on the split in force on that date.
    SELECT string_agg(x->>'c', ', ') INTO v_bad FROM jsonb_array_elements(v_new) x
     WHERE (x->>'c')::uuid IS DISTINCT FROM v_owner
       AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = (x->>'c')::uuid AND c.is_active)
       AND NOT EXISTS (SELECT 1 FROM public.field_billing_split_payers p
                        WHERE p.version_id = v_in_force AND p.customer_id = (x->>'c')::uuid);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'FIELD_SPLIT_PAYER_NOT_ACTIVE: customer(s) % are not active customers', v_bad USING ERRCODE = '22023';
    END IF;

    SELECT jsonb_agg(jsonb_build_object('c', customer_id, 'p', product_share_micro_pct, 'a', application_share_micro_pct)
                     ORDER BY customer_id) INTO v_old
      FROM public.field_billing_split_payers WHERE version_id = v_in_force;
    -- Same payers starting on the in-force version's own date: nothing new. A dated change with the same payers is kept.
    IF v_in_force IS NULL OR v_old IS DISTINCT FROM v_new OR v_in_force_from <> p_effective_from THEN
      SELECT COALESCE(max(version_number), 0) + 1 INTO v_number
        FROM public.field_billing_split_versions WHERE field_id = p_field_id;
      INSERT INTO public.field_billing_split_versions (field_id, version_number, effective_from, history_known, reason, created_by)
      VALUES (p_field_id, v_number, p_effective_from, COALESCE(p_history_known, true), NULLIF(btrim(p_reason), ''), v_actor)
      RETURNING id INTO v_version;
      INSERT INTO public.field_billing_split_payers (version_id, customer_id, product_share_micro_pct, application_share_micro_pct)
      SELECT v_version, (x->>'c')::uuid, (x->>'p')::integer, (x->>'a')::integer FROM jsonb_array_elements(v_new) x;
    END IF;
  END IF;

  IF p_notes IS NOT NULL THEN
    IF jsonb_typeof(p_notes) <> 'array' OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_notes) e
          WHERE jsonb_typeof(e) <> 'object' OR jsonb_typeof(e->'customer_id') IS DISTINCT FROM 'string'
             OR (e->>'customer_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             OR (e ? 'notes' AND jsonb_typeof(e->'notes') NOT IN ('string', 'null'))
             OR (e ? 'pricing_note' AND jsonb_typeof(e->'pricing_note') NOT IN ('string', 'null'))) THEN
      RAISE EXCEPTION 'FIELD_PAYER_NOTES_INVALID: notes are a list of {customer_id, notes, pricing_note}' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(DISTINCT e->>'customer_id') FROM jsonb_array_elements(p_notes) e) <> jsonb_array_length(p_notes) THEN
      RAISE EXCEPTION 'FIELD_PAYER_NOTES_INVALID: a customer is listed twice' USING ERRCODE = '22023';
    END IF;
    -- Notes belong to the field's owner, a customer on one of its split versions, or a customer who already has a
    -- note here (a former owner's note stays editable after the field changes hands).
    SELECT string_agg(e->>'customer_id', ', ') INTO v_bad FROM jsonb_array_elements(p_notes) e
     WHERE (e->>'customer_id')::uuid IS DISTINCT FROM v_owner
       AND NOT EXISTS (SELECT 1 FROM public.field_payer_notes n
                        WHERE n.field_id = p_field_id AND n.customer_id = (e->>'customer_id')::uuid)
       AND NOT EXISTS (SELECT 1 FROM public.field_billing_split_payers p
                        JOIN public.field_billing_split_versions v ON v.id = p.version_id
                       WHERE v.field_id = p_field_id AND p.customer_id = (e->>'customer_id')::uuid);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'FIELD_PAYER_NOTES_NOT_ON_FIELD: customer(s) % are not on this field', v_bad USING ERRCODE = '22023';
    END IF;
    WITH incoming AS (
      SELECT (e->>'customer_id')::uuid AS customer_id, e ? 'notes' AS has_notes, NULLIF(btrim(e->>'notes'), '') AS notes,
             e ? 'pricing_note' AS has_pricing, NULLIF(btrim(e->>'pricing_note'), '') AS pricing_note
        FROM jsonb_array_elements(p_notes) e
       WHERE e ? 'notes' OR e ? 'pricing_note'
    ), current_notes AS (
      SELECT i.*, n.id AS note_id, n.notes AS old_notes, n.pricing_note AS old_pricing
        FROM incoming i LEFT JOIN public.field_payer_notes n ON n.field_id = p_field_id AND n.customer_id = i.customer_id
    ), wanted AS (
      SELECT customer_id, note_id,
             CASE WHEN has_notes THEN notes ELSE old_notes END AS notes,
             CASE WHEN has_pricing THEN pricing_note ELSE old_pricing END AS pricing_note,
             old_notes, old_pricing
        FROM current_notes
    ), upserted AS (
      INSERT INTO public.field_payer_notes AS n (field_id, customer_id, notes, pricing_note, updated_by)
      SELECT p_field_id, w.customer_id, w.notes, w.pricing_note, v_actor
        FROM wanted w
       WHERE (w.note_id IS NULL AND (w.notes IS NOT NULL OR w.pricing_note IS NOT NULL))
          OR (w.note_id IS NOT NULL AND (w.notes, w.pricing_note) IS DISTINCT FROM (w.old_notes, w.old_pricing))
      ON CONFLICT (field_id, customer_id) DO UPDATE
        SET notes = EXCLUDED.notes, pricing_note = EXCLUDED.pricing_note, updated_by = EXCLUDED.updated_by
      RETURNING 1
    )
    SELECT count(*) INTO v_notes_changed FROM upserted;
  END IF;

  PERFORM public._refresh_field_billing_defaults_copy_20270303(p_field_id);

  -- A notes-only save still reports the split in force on that date.
  v_in_force := COALESCE(v_in_force, public._field_split_in_force_20270303(p_field_id, COALESCE(p_effective_from, public._field_split_today_20270303())));
  RETURN jsonb_build_object(
    'field_id', p_field_id,
    'wrote_version', v_version IS NOT NULL,
    'version_id', COALESCE(v_version, v_in_force),
    'version_number', COALESCE(v_number, (SELECT version_number FROM public.field_billing_split_versions WHERE id = v_in_force)),
    'notes_changed', v_notes_changed);
END;
$function$;
REVOKE ALL ON FUNCTION public._set_field_billing_split_20270303(uuid, date, jsonb, jsonb, text, uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Office entry points
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.set_field_billing_split(
  p_field_id uuid, p_effective_from date, p_payers jsonb, p_notes jsonb DEFAULT NULL, p_reason text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501'; END IF;
  PERFORM public.require_admin_or_sales_rep();
  -- Settings > Page Access: a sales rep with Fields & Maps turned off is refused (the _require_page_access rule).
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_actor AND p.role IS DISTINCT FROM 'admin'
              AND 'fields' = ANY (COALESCE(p.denied_pages, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'PAGE_ACCESS_DENIED: fields' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR p_idempotency_key COLLATE "C" ~ '[^ -~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: set_field_billing_split requires a printable p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fields WHERE id = p_field_id) THEN
    RAISE EXCEPTION 'FIELD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_payers IS NULL AND p_notes IS NULL THEN
    RAISE EXCEPTION 'FIELD_SPLIT_NOTHING_TO_SAVE: send a split, notes, or both' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'p_field_id', p_field_id, 'p_effective_from', p_effective_from, 'p_payers', p_payers,
    'p_notes', p_notes, 'p_reason', p_reason));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'set_field_billing_split', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay -> 'result';
  END IF;

  v_result := public._set_field_billing_split_20270303(p_field_id, p_effective_from, p_payers, p_notes, p_reason, v_actor, true);

  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('field_split_saved',
          CASE WHEN (v_result->>'wrote_version')::boolean
               THEN format('Field split version %s saved, starting %s', v_result->>'version_number', p_effective_from)
               ELSE 'Field split saved (no change to who pays)' END,
          v_actor, 'field', p_field_id);

  PERFORM public.save_idempotency(p_idempotency_key, 'set_field_billing_split', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_field_billing_split', v_fingerprint);
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.set_field_billing_split(uuid, date, jsonb, jsonb, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_field_billing_split(uuid, date, jsonb, jsonb, text, text) TO authenticated;

-- Who pays for each field on a date. Billing calls it inside the invoice transaction after FOR SHARE on each field
-- row (id order); the writer holds FOR UPDATE, so a split save and an invoice draft on one field run one after the other.
CREATE FUNCTION public.field_split_as_of(p_field_ids uuid[], p_on_date date)
RETURNS TABLE (field_id uuid, has_split boolean, version_id uuid, version_number integer, effective_from date,
               history_known boolean, payers jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
#variable_conflict use_column
DECLARE
  v_unknown text;
BEGIN
  PERFORM public.require_admin_or_sales_rep();
  -- Settings > Page Access: a sales rep with Fields & Maps turned off cannot read splits either (Sol r3 HIGH).
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IS DISTINCT FROM 'admin'
              AND 'fields' = ANY (COALESCE(p.denied_pages, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'PAGE_ACCESS_DENIED: fields' USING ERRCODE = '42501';
  END IF;
  IF p_on_date IS NULL THEN
    RAISE EXCEPTION 'FIELD_SPLIT_DATE_REQUIRED: a date is required' USING ERRCODE = '22023';
  END IF;
  IF p_field_ids IS NULL OR cardinality(p_field_ids) = 0 OR array_position(p_field_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'FIELD_SPLIT_FIELDS_REQUIRED: a non-empty list of field ids with no blanks is required' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(DISTINCT u) FROM unnest(p_field_ids) u) <> cardinality(p_field_ids) THEN
    RAISE EXCEPTION 'FIELD_SPLIT_DUPLICATE_FIELD: a field is listed twice' USING ERRCODE = '22023';
  END IF;
  SELECT string_agg(u::text, ', ') INTO v_unknown FROM unnest(p_field_ids) u
   WHERE NOT EXISTS (SELECT 1 FROM public.fields f WHERE f.id = u);
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'FIELD_NOT_FOUND: %', v_unknown USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  SELECT u.fid, v.id IS NOT NULL, v.id, v.version_number, v.effective_from, v.history_known,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('customer_id', p.customer_id,
                                                       'product_share_micro_pct', p.product_share_micro_pct,
                                                       'application_share_micro_pct', p.application_share_micro_pct)
                                    ORDER BY p.customer_id)
                     FROM public.field_billing_split_payers p WHERE p.version_id = v.id), '[]'::jsonb)
    FROM unnest(p_field_ids) WITH ORDINALITY AS u(fid, ord)
    LEFT JOIN public.field_billing_split_versions v ON v.id = public._field_split_in_force_20270303(u.fid, p_on_date)
   ORDER BY u.ord;
END;
$function$;
REVOKE ALL ON FUNCTION public.field_split_as_of(uuid[], date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.field_split_as_of(uuid[], date) TO authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. save_field writes through the same writer (wrapper unchanged; same signature, owner and grants)
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._save_field_replay_impl_20261015(p_field_id uuid, p_field_payload jsonb, p_billing_defaults jsonb DEFAULT '[]'::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_field_id uuid;
  v_existing jsonb;
  v_payers jsonb;
  v_notes jsonb;
  v_today date := public._field_split_today_20270303();
  v_in_force uuid;
  v_current jsonb;
  v_sent jsonb;
  v_diff bigint;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();
  -- Settings > Page Access: every save_field caller is on Fields & Maps; a rep with it turned off is refused.
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_actor AND p.role IS DISTINCT FROM 'admin'
              AND 'fields' = ANY (COALESCE(p.denied_pages, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'PAGE_ACCESS_DENIED: fields' USING ERRCODE = '42501';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_field');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'field_id')::uuid; END IF;
  END IF;

  -- NULL = field details only: the split and notes are left as they are (the new Field Setup screen saves them
  -- through set_field_billing_split). A list is the whole split, as the old screen sends it.
  IF p_billing_defaults IS NOT NULL AND jsonb_typeof(p_billing_defaults) <> 'array' THEN
    RAISE EXCEPTION 'FIELD_SPLIT_INVALID_SHARE: billing splits must be a list' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_billing_defaults) > 0 THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_billing_defaults) e
                WHERE jsonb_typeof(e) <> 'object'
                   OR (e->>'price_override_cents') IS NOT NULL OR NULLIF(btrim(e->>'pricing_note'), '') IS NOT NULL) THEN
      RAISE EXCEPTION 'PER_ACRE_PRICING_RETIRED: a field split carries no per-acre price or pricing note' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_billing_defaults) e
                WHERE jsonb_typeof(e->'customer_id') IS DISTINCT FROM 'string'
                   OR (e->>'customer_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'FIELD_SPLIT_INVALID_SHARE: each split row needs a customer' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_billing_defaults) e
                WHERE jsonb_typeof(e->'split_pct') IS DISTINCT FROM 'number'
                  AND jsonb_typeof(e->'split_pct') IS DISTINCT FROM 'string') THEN
      RAISE EXCEPTION 'FIELD_SPLIT_INVALID_SHARE: each share must be above 0%% and at most 100%%' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_billing_defaults) e
                WHERE (e->>'split_pct') !~ '^\s*[0-9]+(\.[0-9]+)?\s*$') THEN
      RAISE EXCEPTION 'FIELD_SPLIT_INVALID_SHARE: each share must be above 0%% and at most 100%%' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_billing_defaults) e
                WHERE (e->>'split_pct')::numeric <= 0 OR (e->>'split_pct')::numeric > 100) THEN
      RAISE EXCEPTION 'FIELD_SPLIT_INVALID_SHARE: each share must be above 0%% and at most 100%%' USING ERRCODE = '22023';
    END IF;
    -- Percent x 1,000,000; the rounding difference to exactly 100% goes to the largest share (lowest customer id on a tie).
    SELECT jsonb_agg(jsonb_build_object('customer_id', e->>'customer_id',
                                        'product_share_micro_pct', round((e->>'split_pct')::numeric * 1000000),
                                        'application_share_micro_pct', round((e->>'split_pct')::numeric * 1000000))
                     ORDER BY round((e->>'split_pct')::numeric * 1000000) DESC, e->>'customer_id')
      INTO v_payers FROM jsonb_array_elements(p_billing_defaults) e;
    v_diff := 100000000 - (SELECT sum((x->>'product_share_micro_pct')::bigint) FROM jsonb_array_elements(v_payers) x);
    IF abs(v_diff) > 10000 THEN
      RAISE EXCEPTION 'Billing splits must total 100%% (got %)',
        trim_scale((100000000 - v_diff)::numeric / 1000000) USING ERRCODE = '22023';
    END IF;
    IF v_diff <> 0 THEN
      v_payers := jsonb_set(jsonb_set(v_payers, '{0,product_share_micro_pct}',
                    to_jsonb((v_payers->0->>'product_share_micro_pct')::bigint + v_diff)),
                    '{0,application_share_micro_pct}', to_jsonb((v_payers->0->>'application_share_micro_pct')::bigint + v_diff));
    END IF;
    SELECT jsonb_agg(jsonb_build_object('customer_id', e->>'customer_id', 'notes', e->'notes'))
      INTO v_notes FROM jsonb_array_elements(p_billing_defaults) e WHERE e ? 'notes';
  END IF;

  IF p_field_id IS NULL THEN
    INSERT INTO fields (
      customer_id, field_name, legal_description, county, state,
      total_acres, fsa_farm_number, fsa_tract_number, fsa_field_number,
      crop_type, soil_type, irrigation, notes, is_active
    )
    SELECT
      (p_field_payload->>'customer_id')::uuid,
      p_field_payload->>'field_name',
      p_field_payload->>'legal_description',
      p_field_payload->>'county',
      COALESCE(p_field_payload->>'state', 'IL'),
      (p_field_payload->>'total_acres')::numeric,
      p_field_payload->>'fsa_farm_number',
      p_field_payload->>'fsa_tract_number',
      p_field_payload->>'fsa_field_number',
      p_field_payload->>'crop_type',
      p_field_payload->>'soil_type',
      COALESCE((p_field_payload->>'irrigation')::boolean, false),
      p_field_payload->>'notes',
      COALESCE((p_field_payload->>'is_active')::boolean, true)
    RETURNING id INTO v_field_id;
  ELSE
    UPDATE fields SET
      customer_id = (p_field_payload->>'customer_id')::uuid,
      field_name = p_field_payload->>'field_name',
      legal_description = p_field_payload->>'legal_description',
      county = p_field_payload->>'county',
      state = COALESCE(p_field_payload->>'state', 'IL'),
      total_acres = (p_field_payload->>'total_acres')::numeric,
      fsa_farm_number = p_field_payload->>'fsa_farm_number',
      fsa_tract_number = p_field_payload->>'fsa_tract_number',
      fsa_field_number = p_field_payload->>'fsa_field_number',
      crop_type = p_field_payload->>'crop_type',
      soil_type = p_field_payload->>'soil_type',
      irrigation = COALESCE((p_field_payload->>'irrigation')::boolean, false),
      notes = p_field_payload->>'notes',
      is_active = COALESCE((p_field_payload->>'is_active')::boolean, true)
    WHERE id = p_field_id;
    -- KI-31: an id that matches no field is an error, not a silent success.
    IF NOT FOUND THEN RAISE EXCEPTION 'FIELD_NOT_FOUND'; END IF;
    v_field_id := p_field_id;
  END IF;

  -- Every payer removed while a split is in force: refused. A field with no split stops Create Invoice by name and never
  -- falls back to a payer (20270226150000), and history cannot express "nobody pays", so the office names the payer.
  -- A field with no split in force writes nothing.
  IF p_field_id IS NOT NULL AND jsonb_array_length(p_billing_defaults) = 0
     AND public._field_split_in_force_20270303(v_field_id, v_today) IS NOT NULL THEN
    RAISE EXCEPTION 'FIELD_SPLIT_CLEAR_REFUSED: who pays for this field is already set and has history; it cannot be left blank. Enter who pays now.' USING ERRCODE = '22023';
  END IF;

  -- This screen shows product shares above 0% only: when those match today's split, the save carries no split change
  -- (a name-only or notes-only save), so no version is written and a 0% or application-only payer is kept.
  IF v_payers IS NOT NULL THEN
    v_in_force := public._field_split_in_force_20270303(v_field_id, v_today);
    SELECT jsonb_agg(jsonb_build_object('c', customer_id, 'p', product_share_micro_pct) ORDER BY customer_id) INTO v_current
      FROM public.field_billing_split_payers WHERE version_id = v_in_force AND product_share_micro_pct > 0;
    SELECT jsonb_agg(jsonb_build_object('c', (x->>'customer_id')::uuid, 'p', (x->>'product_share_micro_pct')::integer)
                     ORDER BY (x->>'customer_id')::uuid) INTO v_sent
      FROM jsonb_array_elements(v_payers) x;
    IF v_current IS NOT DISTINCT FROM v_sent THEN
      v_payers := NULL;
    END IF;
  END IF;
  IF v_payers IS NOT NULL OR v_notes IS NOT NULL THEN
    PERFORM public._set_field_billing_split_20270303(v_field_id, v_today, v_payers, v_notes, 'Saved from Field Setup', v_actor, true);
  ELSE
    -- The owner may have changed: re-mark the copy's primary row.
    PERFORM public._refresh_field_billing_defaults_copy_20270303(v_field_id);
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    'field_saved', 'Field saved: ' || (p_field_payload->>'field_name'),
    v_actor, 'field', v_field_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field', jsonb_build_object('field_id', v_field_id));
  END IF;
  RETURN v_field_id;
END;
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Access and constraint changes (I approve)
-- ---------------------------------------------------------------------------------------------------------------
DROP POLICY fbd_insert ON public.field_billing_defaults;
DROP POLICY fbd_update ON public.field_billing_defaults;
DROP POLICY fbd_delete ON public.field_billing_defaults;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.field_billing_defaults FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.fields
  DROP CONSTRAINT fields_customer_id_fkey,
  ADD CONSTRAINT fields_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------------------------------------------
-- 8. Backfill: today's split becomes version 1 (history before this migration unknown)
-- ---------------------------------------------------------------------------------------------------------------
DO $backfill$
DECLARE
  v_field uuid;
  v_payers jsonb;
  v_diff bigint;
  v_version uuid;
BEGIN
  FOR v_field IN SELECT DISTINCT field_id FROM public.field_billing_defaults ORDER BY field_id LOOP
    SELECT jsonb_agg(jsonb_build_object('c', customer_id, 'm', round(split_pct * 1000000)::bigint)
                     ORDER BY round(split_pct * 1000000) DESC, customer_id)
      INTO v_payers FROM public.field_billing_defaults WHERE field_id = v_field;
    v_diff := 100000000 - (SELECT sum((x->>'m')::bigint) FROM jsonb_array_elements(v_payers) x);
    IF abs(v_diff) > 10000 THEN
      RAISE EXCEPTION 'FIELD_SPLIT_CUTOVER_STOP: field % split is % micro-percent away from 100%%', v_field, v_diff;
    END IF;
    v_payers := jsonb_set(v_payers, '{0,m}', to_jsonb((v_payers->0->>'m')::bigint + v_diff));
    INSERT INTO public.field_billing_split_versions (field_id, version_number, effective_from, history_known, reason, created_by)
    VALUES (v_field, 1, DATE '1900-01-01', false, 'Imported: the split saved before split history existed', NULL)
    RETURNING id INTO v_version;
    INSERT INTO public.field_billing_split_payers (version_id, customer_id, product_share_micro_pct, application_share_micro_pct)
    SELECT v_version, (x->>'c')::uuid, (x->>'m')::integer, (x->>'m')::integer FROM jsonb_array_elements(v_payers) x;
    INSERT INTO public.field_payer_notes (field_id, customer_id, notes)
    SELECT field_id, customer_id, notes FROM public.field_billing_defaults
     WHERE field_id = v_field AND NULLIF(btrim(notes), '') IS NOT NULL;
    PERFORM public._refresh_field_billing_defaults_copy_20270303(v_field);
  END LOOP;
END;
$backfill$;

SELECT cron.schedule('field-split-copy-refresh', '10 5,6 * * *', $$SELECT public._refresh_all_field_billing_copies_20270303()$$);

-- ---------------------------------------------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------------------------------------------
DO $postflight$
BEGIN
  SET CONSTRAINTS public.field_billing_split_versions_totals, public.field_billing_split_payers_totals IMMEDIATE;
  IF (SELECT count(DISTINCT field_id) FROM public.field_billing_defaults)
     <> (SELECT count(*) FROM public.field_billing_split_versions WHERE version_number = 1 AND NOT history_known)
     OR EXISTS (SELECT 1 FROM public.field_billing_split_versions WHERE version_number <> 1) THEN
    RAISE EXCEPTION 'FIELD_SPLIT_POSTFLIGHT: version-1 count does not match the fields with a split';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fields f
              WHERE public._field_billing_copy_expected_20270303(f.id) IS DISTINCT FROM public._field_billing_copy_actual_20270303(f.id)) THEN
    RAISE EXCEPTION 'FIELD_SPLIT_POSTFLIGHT: a field_billing_defaults copy does not match its version';
  END IF;
  IF has_table_privilege('authenticated', 'public.field_billing_defaults', 'INSERT')
     OR has_table_privilege('authenticated', 'public.field_billing_defaults', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.field_billing_defaults', 'DELETE')
     OR has_table_privilege('authenticated', 'public.field_billing_defaults', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.field_billing_defaults', 'INSERT')
     OR has_table_privilege('service_role', 'public.field_billing_defaults', 'DELETE')
     OR has_table_privilege('authenticated', 'public.field_billing_split_versions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.field_payer_notes', 'INSERT')
     OR has_table_privilege('service_role', 'public.field_billing_split_payers', 'INSERT')
     OR has_table_privilege('anon', 'public.field_billing_split_versions', 'SELECT')
     OR has_table_privilege('authenticated', 'public.field_billing_split_payers', 'INSERT')
     OR has_function_privilege('authenticated', 'public._set_field_billing_split_20270303(uuid,date,jsonb,jsonb,text,uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_field_billing_split(uuid,date,jsonb,jsonb,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.field_split_as_of(uuid[],date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_field_billing_split(uuid,date,jsonb,jsonb,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.field_split_as_of(uuid[],date)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public._refresh_field_billing_defaults_copy_20270303(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public._field_billing_copy_expected_20270303(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FIELD_SPLIT_POSTFLIGHT: grants are not as intended';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.fields'::regclass AND conname = 'fields_customer_id_fkey')
     IS DISTINCT FROM 'FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT' THEN
    RAISE EXCEPTION 'FIELD_SPLIT_POSTFLIGHT: fields_customer_id_fkey is not RESTRICT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'field-split-copy-refresh' AND schedule = '10 5,6 * * *'
                   AND username = 'postgres' AND database = 'postgres' AND active) THEN
    RAISE EXCEPTION 'FIELD_SPLIT_POSTFLIGHT: the nightly copy refresh is not scheduled';
  END IF;
  SET CONSTRAINTS public.field_billing_split_versions_totals, public.field_billing_split_payers_totals DEFERRED;
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
