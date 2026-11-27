-- Count once: a job and the blend tickets linked to it take a product out of stock once, not twice.
-- Contract: docs/plans/2026-11-26-job-ticket-stock-count-once-CONTRACT.md (Mason chose "A: count once, flag", 2026-11-26).
--
-- Before: create_application_record_from_blend_ticket took every ticket line out of Main Warehouse and complete_job took
-- every job line out, neither looking at the other, so a ticket linked to a job and that job's completion took the same
-- product twice (either order).
--
-- After: for one job and one product, the total taken is the larger of the job's claim and its linked tickets' claims
-- together. Each posting line stores its link (application_record_id) and the part of its claim another posting already
-- took (already_counted); a line's claim is quantity + already_counted, frozen at posting. A later line takes only
-- max(0, larger claim - already taken) and is flagged requires_review with a note. An unlinked ticket, or a job with no
-- filed linked ticket, takes exactly what it takes today.
--   * job line:    moves max(0, max(job claims + this claim, ticket claims) - taken)
--   * ticket line: moves max(0, max(job claims, ticket claims + this claim) - taken)
-- A filed ticket's job link is already frozen (trg_linked_blend_ticket_header_lock, 20260714230100). reverse_application_record
-- reverses a ticket counted with its completed job by "smart undo" (Mason, 2026-11-26): it credits the ticket's lines in
-- full, then takes back out, on the job's own books, what the job still needs (a job row whose negative already_counted
-- keeps the job's claim unchanged); extra another ticket took because of this one comes back as a positive 'adjusted'
-- row linked to the job record, which the group counts as returned. A ticket with an active invoice is refused.
-- It takes the application-record number lock first, the lock completion and filing already take before any stock row.
--
-- Rows posted before this migration carry no link (the ledger is write-once: trg_guard_inventory_transactions_immutable
-- refuses UPDATE, so they cannot be backfilled and the link has no foreign key). The group still counts them, found the way
-- they were always found: a job's rows by job_id, a ticket's rows by the application record named in their note (as
-- reverse_application_record does). So a pair that straddles this migration also counts once.
--
-- idempotency-body-check: complete_job and create_application_record_from_blend_ticket wrappers (key check, fingerprint,
--   receipt binding) are not re-emitted; only their private bodies change, after the key checks. reverse_application_record
--   keeps its check_idempotency/save_idempotency calls unchanged; the new lock comes after the replay check.
-- auth: unchanged. Every role check in the three bodies is byte-identical. The new group helper is
--   owner-only (EXECUTE revoked from PUBLIC, anon, authenticated, service_role).
-- caller-analysis: _complete_job_replay_impl_20261015 :: called only by complete_job (grants unchanged, revoked from API roles).
--   _create_app_record_from_bt_replay_impl_20261015 :: called only by create_application_record_from_blend_ticket.
--   reverse_application_record :: public RPC, same signature, grants unchanged (authenticated, service_role); no screen caller.
--   _job_stock_group_20270310 :: called only by the two bodies above.
--
-- ROLLBACK (before first use): scripts/smoke/job-ticket-stock-count-once-reverse.sql. After the first counted posting, fix
--   forward with a new migration: the old bodies would ignore the stored credits.
--   (proven by scripts/smoke/prove-job-ticket-stock-count-once-real-schema.mjs)

SET LOCAL lock_timeout = '5s';
-- The number lock job completion, ticket filing and reversal take: wait out any posting already running.
SELECT pg_advisory_xact_lock(hashtext('next_application_record_number'));

DO $preflight$
DECLARE
  v_fn record;
  v_overlap int;
BEGIN
  FOR v_fn IN
    SELECT x.sig, x.md5, p.oid, p.prosrc, p.prosecdef, p.proconfig
      FROM (VALUES
        ('public._complete_job_replay_impl_20261015(uuid, jsonb, uuid, text)', '3bd9dfe0729d8175ffbb1cf16b258b5c'),
        ('public._create_app_record_from_bt_replay_impl_20261015(uuid, uuid, text)', '0ad9a78b900cb953e0aa7d2a0d87bda0'),
        ('public.reverse_application_record(uuid, text)', 'bb7b45f8dca986c9cf39b5b6a41aa75b')
      ) AS x(sig, md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(x.sig)
  LOOP
    IF v_fn.oid IS NULL OR md5(replace(v_fn.prosrc, chr(13), '')) IS DISTINCT FROM v_fn.md5 THEN
      RAISE EXCEPTION 'COUNT_ONCE_PREFLIGHT: % is not the reviewed body', v_fn.sig;
    END IF;
    IF NOT v_fn.prosecdef OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
      RAISE EXCEPTION 'COUNT_ONCE_PREFLIGHT: % security or search_path changed', v_fn.sig;
    END IF;
  END LOOP;
  -- The columns survive a rollback (the ledger is write-once), so only the helpers mark this as applied.
  IF to_regprocedure('public._job_stock_group_20270310(uuid, uuid)') IS NOT NULL
     OR to_regprocedure('public._job_stock_customer_20270310(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'COUNT_ONCE_PREFLIGHT: already applied';
  END IF;
  -- Old pairs (both posted before this rule) are left as they are; say how many so staging data is visible.
  SELECT count(DISTINCT jr.source_id) INTO v_overlap
    FROM public.application_records jr
    JOIN public.blend_tickets bt ON bt.job_id = jr.source_id
    JOIN public.application_records tr ON tr.source_type = 'blend_ticket' AND tr.source_id = bt.id
   WHERE jr.source_type = 'job';
  RAISE NOTICE 'COUNT_ONCE: % job(s) already have both a job record and a linked ticket record (posted before this rule, left as they are)', v_overlap;
END;
$preflight$;

ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS application_record_id uuid,
  ADD COLUMN IF NOT EXISTS already_counted numeric CHECK (already_counted IS NULL OR already_counted <> 0);
COMMENT ON COLUMN public.inventory_transactions.application_record_id IS
  'Application record this job_applied line posted for (job completion or blend-ticket filing). No foreign key: the ledger is write-once and a reversed record is deleted.';
COMMENT ON COLUMN public.inventory_transactions.already_counted IS
  'Part of this line''s claim another posting for the same job already took (count once). Claim = quantity + already_counted. Negative only on a job row a ticket reversal posted: that stock was already part of the job''s claim.';
CREATE INDEX IF NOT EXISTS idx_inv_tx_application_record ON public.inventory_transactions (application_record_id, product_id)
  WHERE application_record_id IS NOT NULL;

-- The customer a job's stock group belongs to: the customer on its job record once completed, else the job's own.
-- Only a linked ticket for this same customer counts with the job, so a job moved to another customer after a
-- ticket was linked never credits one customer's spray against another's.
CREATE FUNCTION public._job_stock_customer_20270310(p_job_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path = public, pg_temp
AS $fn$
  SELECT COALESCE(
    (SELECT ar.customer_id FROM public.application_records ar
      WHERE ar.source_type = 'job' AND ar.source_id = p_job_id
      ORDER BY ar.created_at, ar.id LIMIT 1),
    (SELECT j.customer_id FROM public.jobs j WHERE j.id = p_job_id));
$fn$;
REVOKE ALL ON FUNCTION public._job_stock_customer_20270310(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- The job/ticket group for one job and one product: the job record's claims, the linked tickets' claims, and what they took.
-- A row joins its record by application_record_id; a row posted before this migration (no link) joins by job_id for the
-- job record, or by the record id in its note for a ticket record. An 'adjusted' row linked to the job record is stock a
-- ticket reversal returned from the job: it lowers what was taken and is no one's claim.
CREATE FUNCTION public._job_stock_group_20270310(p_job_id uuid, p_product_id uuid,
  OUT job_claim numeric, OUT ticket_claim numeric, OUT taken numeric)
 LANGUAGE sql
 STABLE
 SET search_path = public, pg_temp
AS $fn$
  SELECT COALESCE(sum(it.quantity + COALESCE(it.already_counted, 0))
                    FILTER (WHERE it.transaction_type = 'job_applied' AND ar.source_type = 'job'), 0),
         COALESCE(sum(it.quantity + COALESCE(it.already_counted, 0))
                    FILTER (WHERE it.transaction_type = 'job_applied' AND ar.source_type = 'blend_ticket'), 0),
         COALESCE(sum(CASE WHEN it.transaction_type = 'adjusted' THEN -it.quantity ELSE it.quantity END), 0)
    FROM public.application_records ar
    JOIN public.inventory_transactions it
      ON it.product_id = p_product_id
     AND ((it.transaction_type = 'job_applied'
           AND (it.application_record_id = ar.id
                OR (it.application_record_id IS NULL AND ar.source_type = 'job' AND it.job_id = p_job_id)
                OR (it.application_record_id IS NULL AND ar.source_type = 'blend_ticket'
                    AND it.notes LIKE 'Blend ticket application:%'
                    AND strpos(it.notes, '(application record ' || ar.id::text || ')') > 0)))
          OR (it.transaction_type = 'adjusted' AND ar.source_type = 'job' AND it.application_record_id = ar.id))
   WHERE (ar.source_type = 'job' AND ar.source_id = p_job_id)
      OR (ar.source_type = 'blend_ticket'
          AND ar.customer_id IS NOT DISTINCT FROM public._job_stock_customer_20270310(p_job_id)
          AND ar.source_id IN (SELECT bt.id FROM public.blend_tickets bt WHERE bt.job_id = p_job_id));
$fn$;
REVOKE ALL ON FUNCTION public._job_stock_group_20270310(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._complete_job_replay_impl_20261015(p_job_id uuid, p_applied_info jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_job            record;
  v_record_number  text;
  v_record_id      uuid;
  v_product_data   jsonb;
  v_weather        jsonb;
  v_chem           record;
  v_inv            record;
  v_inv_found      boolean;
  v_jf             record;
  v_first_field_id uuid;
  v_field_count    int := 0;
  v_short_count    int := 0;
  v_new_avail      numeric;
  v_short_flag     boolean;
  v_result         jsonb;
  v_deduct_qty     numeric;
  -- Count once: this line's claim, the job/ticket group's claims and amount taken so far,
  -- and the part of the claim another posting already took.
  v_claim          numeric;
  v_cj             numeric;
  v_ct             numeric;
  v_taken          numeric;
  v_counted        numeric;
  v_counted_count  int := 0;
  -- U11<<< raw-fallback bookkeeping for unconvertible units
  v_unconverted    boolean;
  v_unconv_count   int := 0;
  -- >>>U11
  -- U12 (Codex R2 P2): running sum of the per-field acres actually recorded, so
  -- the record header can be corrected when the caller sent 'field_acres' overrides.
  v_acres_sum      numeric := 0;
  v_auto_draft_on    boolean := false;
  v_existing_invoice uuid;
  v_auto_draft_key   text;
  -- N2-7 #106a/#106b<<< actual application date + applicator snapshot locals.
  v_application_date date;
  v_applicator_id      uuid;
  v_applicator_name    text;
  v_applicator_license text;
  -- >>>N2-7
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key AND operation = 'complete_job';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT j.*, c.farm_name AS customer_name
    INTO v_job
    FROM jobs j
    JOIN customers c ON c.id = j.customer_id
   WHERE j.id = p_job_id
   FOR UPDATE OF j;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  -- U12: widened with an OR branch — but NARROWER than start_job's (Codex R1 P1,
  -- tightened again R2 P1): complete_job stamps application records + acres for
  -- EVERY field and deducts inventory for EVERY chemical on the job, so a
  -- location-only dispatchee may complete it ONLY when BOTH hold:
  --   (1) EVERY job_fields row on the job is covered by an ACTIVE dispatch owned
  --       by the caller (directly, or via active membership in the dispatched
  --       crew) — an undispatched field means someone's work isn't even assigned
  --       yet, so the whole-job close stays with the office / whole-job assignee;
  --   (2) no OTHER party holds an ACTIVE dispatch anywhere on the job.
  -- On any split/partial-dispatch job this branch stays closed — admin/sales_rep
  -- or jobs.applicator_id complete those, exactly as before this migration.
  -- Still a strict superset of live behavior.
  IF NOT (
    is_admin() OR is_sales_rep()
    -- NULL-SAFE (U12 live-verify finding): when jobs.applicator_id IS NULL this
    -- comparison yielded NULL, and IF NOT (NULL) skips the RAISE — any active
    -- applicator could start/complete a NULL-applicator job. Wrap it so the
    -- branch is FALSE, not NULL, and authorization falls through to the
    -- dispatch-based branch (which is already null-safe).
    OR public._is_job_applicator(p_job_id)  -- KI-73 part C: access ends when the job ends
    OR (
      is_applicator()
      AND public._is_dispatched_to_me(p_job_id)
      -- (1) every field on the job is actively dispatched to the caller.
      -- Crew ownership requires BOTH the membership row AND the crew itself to
      -- be active (RLS R2 M2) — matching _is_dispatched_to_me and the
      -- job_location_dispatches_select policy, so the completion power is never
      -- looser than the read power.
      AND NOT EXISTS (
        SELECT 1
          FROM job_fields jf2
         WHERE jf2.job_id = p_job_id
           AND NOT EXISTS (
             SELECT 1
               FROM job_location_dispatches d2
              WHERE d2.job_field_id = jf2.id
                AND d2.dispatch_status = 'dispatched'
                AND (
                  d2.applicator_id = v_actor
                  OR (d2.crew_id IS NOT NULL AND EXISTS (
                        SELECT 1
                          FROM ground_crew_members gcm
                          JOIN ground_crews gc ON gc.id = gcm.crew_id
                         WHERE gcm.crew_id = d2.crew_id
                           AND gcm.profile_id = v_actor
                           AND gcm.is_active
                           AND gc.is_active))
                )
           )
      )
      -- (2) and nobody ELSE holds an active dispatch on the job. The applicator
      -- comparison is wrapped null-safe (RLS R2 M1): on a crew-held dispatch
      -- d.applicator_id IS NULL, and `NULL = v_actor` would poison the NOT()
      -- into NULL and silently drop the row from the EXISTS.
      AND NOT EXISTS (
        SELECT 1
          FROM job_location_dispatches d
         WHERE d.job_id = p_job_id
           AND d.dispatch_status = 'dispatched'
           AND NOT (
             (d.applicator_id IS NOT NULL AND d.applicator_id = v_actor)
             OR (d.crew_id IS NOT NULL AND EXISTS (
                   SELECT 1
                     FROM ground_crew_members gcm
                     JOIN ground_crews gc ON gc.id = gcm.crew_id
                    WHERE gcm.crew_id = d.crew_id
                      AND gcm.profile_id = v_actor
                      AND gcm.is_active
                      AND gc.is_active))
           )
      )
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this job';
  END IF;

  IF v_job.status != 'in_progress' THEN
    RAISE EXCEPTION 'Job must be in_progress before completion. Current status: %. Use start_job() first.', v_job.status;
  END IF;

  -- Fires A4's jobs lifecycle trigger → _sync_job_holds releases this job's hold
  -- and re-syncs the parent quote (keeping the draw). The quote hold / booking is
  -- owned by A4 from here; the loop below only deducts physical stock.
  UPDATE jobs SET status = 'completed' WHERE id = p_job_id;

  INSERT INTO job_applied_info (
    job_id, actual_start_time, actual_end_time,
    wind_speed, wind_direction, temperature, humidity,
    actual_gallons_applied, notes
  ) VALUES (
    p_job_id,
    CASE WHEN p_applied_info->>'actual_start_time' IS NOT NULL
      THEN (p_applied_info->>'actual_start_time')::timestamptz ELSE NULL END,
    CASE WHEN p_applied_info->>'actual_end_time' IS NOT NULL
      THEN (p_applied_info->>'actual_end_time')::timestamptz ELSE NULL END,
    (p_applied_info->>'wind_speed')::numeric,
    p_applied_info->>'wind_direction',
    (p_applied_info->>'temperature')::numeric,
    (p_applied_info->>'humidity')::numeric,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    p_applied_info->>'notes'
  )
  ON CONFLICT (job_id) DO UPDATE SET
    actual_start_time      = COALESCE(EXCLUDED.actual_start_time,      job_applied_info.actual_start_time),
    actual_end_time        = EXCLUDED.actual_end_time,
    wind_speed             = EXCLUDED.wind_speed,
    wind_direction         = EXCLUDED.wind_direction,
    temperature            = EXCLUDED.temperature,
    humidity               = EXCLUDED.humidity,
    actual_gallons_applied = EXCLUDED.actual_gallons_applied,
    notes                  = EXCLUDED.notes;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id',       jc.product_id,
        'product_name',     p.product_name,
        'quantity',         jc.quantity,
        'unit',             jc.unit,
        'rate_per_acre',    jc.rate_per_acre,
        'rate_unit',        jc.rate_unit,
        'epa_registration', p.epa_registration,
        'is_rup',           COALESCE(p.is_rup, false),
        -- U4<<< legal record marks a grower-supplied product; the row STAYS in
        -- product_data (REI/PHI watchdog + as-applied proof still see it). (#53/#54)
        'customer_supplied', jc.customer_supplied
        -- >>>U4
      )
      ORDER BY jc.sort_order
    ),
    '[]'::jsonb
  )
  INTO v_product_data
  FROM job_chemicals jc
  LEFT JOIN products p ON p.id = jc.product_id
  WHERE jc.job_id = p_job_id;

  v_weather := jsonb_build_object(
    'wind_speed',     (p_applied_info->>'wind_speed')::numeric,
    'wind_direction', p_applied_info->>'wind_direction',
    'temperature',    (p_applied_info->>'temperature')::numeric,
    'humidity',       (p_applied_info->>'humidity')::numeric
  );

  v_record_number := next_application_record_number();

  SELECT field_id INTO v_first_field_id
    FROM job_fields
   WHERE job_id = p_job_id
   ORDER BY sort_order, id
   LIMIT 1;

  -- N2-7 #106a<<< the ACTUAL application date. The job_applied_info upsert above already
  -- merged the completer-sent start with the start_job-stamped start
  -- (COALESCE(EXCLUDED.actual_start_time, existing)), so that row's actual_start_time is
  -- the single source of truth for "when it was actually applied". Prefer the just-sent
  -- value, then the stored start, then fall back to v_job.job_date EXACTLY as before this
  -- migration when no actual start exists anywhere (byte-identical to old behavior).
  -- Codex R1 P2: cast through the BUSINESS timezone, not the session default
  -- (UTC on Supabase) — a 7:30 PM Central start is still "today" on the legal
  -- record, not tomorrow. CRX operates in US Central only (single-region ag
  -- retailer); if that ever changes this becomes an app_settings value.
  v_application_date := COALESCE(
    (
      COALESCE(
        (p_applied_info->>'actual_start_time')::timestamptz,
        (SELECT jai.actual_start_time FROM job_applied_info jai WHERE jai.job_id = p_job_id)
      ) AT TIME ZONE 'America/Chicago'
    )::date,
    v_job.job_date
  );
  -- >>>N2-7 #106a

  -- N2-7 #106b<<< snapshot the applicator's identity as-of NOW onto the legal record.
  -- Same applicator the record is attributed to (below): the completer when they're an
  -- applicator, else the job-header applicator (which may be NULL for wizard-dispatched
  -- jobs → both snapshot columns stay NULL, additive-safe).
  v_applicator_id := CASE WHEN is_applicator() THEN v_actor ELSE v_job.applicator_id END;
  IF v_applicator_id IS NOT NULL THEN
    SELECT pr.full_name, pr.applicator_license_number
      INTO v_applicator_name, v_applicator_license
      FROM profiles pr WHERE pr.id = v_applicator_id;
    -- Codex R1 P2: applicator_licenses is the CANONICAL license store for staff
    -- (the assignment gate + UI read it); profiles.applicator_license_number is
    -- not maintained by the current frontend. Prefer the newest active canonical
    -- license; keep the profiles value only as a fallback for shops that typed
    -- it there.
    SELECT COALESCE(
             (SELECT al.license_number
                FROM applicator_licenses al
               WHERE al.profile_id = v_applicator_id
                 AND al.is_active = true
               ORDER BY al.expiry_date DESC NULLS LAST
               LIMIT 1),
             v_applicator_license
           )
      INTO v_applicator_license;
  END IF;
  -- >>>N2-7 #106b

  INSERT INTO application_records (
    record_number, source_type, source_id,
    customer_id, applicator_id, field_id,
    application_date, product_data,
    total_acres, total_volume, total_volume_unit,
    vehicle_id, weather_conditions,
    notes, season, created_by,
    -- N2-7 #106b: legal-record applicator snapshot columns.
    applicator_name, applicator_license_number
  ) VALUES (
    v_record_number, 'job', p_job_id,
    v_job.customer_id,
    -- U12 (Codex R2 P1): attribute the legal application record to the person who
    -- ACTUALLY completed it when that person is an applicator — the new location-
    -- dispatch path means the completer may not be jobs.applicator_id (which can
    -- even be NULL for wizard-dispatched jobs). For the whole-job assignee this is
    -- the same value as before (v_actor = v_job.applicator_id); for office closes
    -- (admin/sales_rep) keep the job-header applicator exactly as today.
    -- N2-7: this is exactly v_applicator_id (computed above from the same CASE), so
    -- applicator_id is byte-identical to live; reusing the local keeps it in lockstep
    -- with the name/license snapshot.
    v_applicator_id,
    v_first_field_id,
    -- N2-7 #106a: actual application date (was v_job.job_date).
    v_application_date, v_product_data,
    v_job.total_acres,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    'gallons',
    v_job.vehicle_id, v_weather, v_job.notes, v_job.season,
    p_performed_by,
    -- N2-7 #106b: applicator identity snapshot.
    v_applicator_name, v_applicator_license
  )
  RETURNING id INTO v_record_id;

  FOR v_jf IN
    SELECT jf.field_id,
           -- U12 addition: an optional per-field override from
           -- p_applied_info->'field_acres' = [{"field_id":uuid,"acres_applied":n}, ...].
           -- Falls through to the ORIGINAL chain when absent/no match — byte-identical
           -- to the pre-U12 behavior for every caller that doesn't pass it.
           COALESCE(
             (SELECT GREATEST(0, (elem->>'acres_applied')::numeric)
                FROM jsonb_array_elements(COALESCE(p_applied_info->'field_acres', '[]'::jsonb)) elem
               WHERE nullif(elem->>'field_id', '')::uuid = jf.field_id
               LIMIT 1),
             jf.acres_to_treat, f.total_acres, 0
           ) AS acres,
           COALESCE(jf.sort_order, 0)                    AS sort_order
      FROM job_fields jf
      JOIN fields f ON f.id = jf.field_id
     WHERE jf.job_id = p_job_id
     ORDER BY jf.sort_order, jf.id
  LOOP
    INSERT INTO application_record_fields (application_record_id, field_id, acres, sort_order)
    VALUES (v_record_id, v_jf.field_id, v_jf.acres, v_jf.sort_order);
    v_field_count := v_field_count + 1;
    v_acres_sum   := v_acres_sum + COALESCE(v_jf.acres, 0);
  END LOOP;

  -- U12 (Codex R2 P2): when the caller sent per-field applied-acres overrides,
  -- the record HEADER must reflect what was actually recorded, not the planned
  -- job total — reports read application_records.total_acres. Only corrected
  -- when 'field_acres' was provided: callers that omit it keep today's header
  -- value byte-for-byte (v_job.total_acres), preserving backward compatibility.
  IF p_applied_info ? 'field_acres' AND v_field_count > 0 THEN
    UPDATE application_records
       SET total_acres = v_acres_sum
     WHERE id = v_record_id;
  END IF;

  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit, p.inventory_unit AS inv_unit, p.product_form AS prod_form
      FROM job_chemicals jc
      JOIN products p ON p.id = jc.product_id
     -- U4<<< skip customer-supplied lines: they came from the grower, not our
     -- shed — no stock to deduct, no 'job_applied' inventory transaction. (#53/#54)
     WHERE jc.job_id = p_job_id AND jc.quantity > 0 AND jc.customer_supplied = false
     -- >>>U4
     ORDER BY jc.sort_order, jc.id  -- count once: credit goes to lines in a fixed order
  LOOP
    -- U11<<< convert the rate-unit job-chem quantity to the product's inventory unit
    -- before deducting stock (a 16-pt line on a gallons-stocked product must remove 2
    -- gal, not 16). On an unconvertible / blank / unknown unit, DO NOT block the field
    -- job (a stuck applicator can't ship the day's work): fall back to the RAW quantity
    -- and flag the row for office review. This mirrors the hold engine EXACTLY —
    -- _sync_job_holds reserved COALESCE(field_app_priced_quantity(...), jc.quantity)
    -- inventory-units for this same line, so deducting the same fallback keeps the
    -- "reserved X → removed X" invariant intact (was: A6 hard RAISE JOB_INV_UNIT_UNCONVERTIBLE,
    -- which blocked completion of ANY job carrying an unconvertible unit).
    -- Codex P1: normalize FIRST — legacy rows may carry per-acre-suffixed units
    -- ('pt/ac'); the raw string NULLs out of the converter and would raw-deduct
    -- 16 "pt/ac" as 16 gal. normalize_rate_unit('pt/ac')='pt' → converts to 2 gal.
    -- (The hold engines share this normalization gap — queued as a follow-up;
    -- correcting the PHYSICAL deduction takes precedence over symmetry.)
    v_deduct_qty  := field_app_priced_quantity(v_chem.quantity, normalize_rate_unit(v_chem.unit), v_chem.inv_unit, v_chem.prod_form);
    v_unconverted := (v_deduct_qty IS NULL);
    IF v_unconverted THEN
      v_deduct_qty   := v_chem.quantity;      -- raw fallback, equals the reserved hold
      v_unconv_count := v_unconv_count + 1;
    END IF;
    -- >>>U11

    -- Count once: v_deduct_qty is this line's claim. Take only what the job's claims and its linked tickets'
    -- claims, whichever is larger, still need beyond what this job and its tickets already took. Earlier
    -- lines of this completion are already in the ledger and counted.
    v_claim := v_deduct_qty;
    SELECT g.job_claim, g.ticket_claim, g.taken INTO v_cj, v_ct, v_taken
      FROM public._job_stock_group_20270310(p_job_id, v_chem.product_id) g;
    -- Never more than this line claims: a ticket reversed before this rule could otherwise leave extra.
    v_deduct_qty := LEAST(v_claim, GREATEST(0, GREATEST(v_cj + v_claim, v_ct) - v_taken));
    v_counted := v_claim - v_deduct_qty;
    IF v_counted > 0 THEN
      v_counted_count := v_counted_count + 1;
    END IF;

    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_chem.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    v_inv_found := FOUND;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_deduct_qty;
    v_short_flag := v_deduct_qty > 0 AND v_new_avail < 0;  -- a line that moves nothing is not short
    IF v_short_flag THEN
      v_short_count := v_short_count + 1;
    END IF;

    -- LAYER2<<< §3.5 fix: deduct physical stock ONLY. The parent quote's holds
    -- and prebooked are owned by A4's jobs lifecycle trigger (which already fired
    -- on the status='completed' update above). The removed "Phase 7" drain
    -- (v_hold_qty / v_decrement_pb / prebooked decrement / crop_program FIFO
    -- drain) double-reduced free stock for order-drawn planned quotes.
    IF NOT v_inv_found THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_chem.product_id, 'Main Warehouse', -v_deduct_qty, 0, 0);
    ELSE
      UPDATE inventory SET
        quantity_available = quantity_available - v_deduct_qty,
        updated_at         = now()
      WHERE product_id = v_chem.product_id AND location = 'Main Warehouse';
    END IF;
    -- >>>LAYER2

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes, job_id, requires_review, application_record_id, already_counted
    ) VALUES (
      v_chem.product_id, 'job_applied', v_deduct_qty, 'Main Warehouse',
      p_performed_by,
      -- U11<<< recorded qty ALWAYS = what stock moved (converted, or raw fallback). Name
      -- the original line qty/unit when a conversion (or a raw fallback) happened, so the
      -- audit row is self-explaining and reconcilable (mirrors A5's link/audit-row lesson).
      'Job ' || v_job.job_number || ' completed — ' || v_deduct_qty || ' units applied' ||
        CASE
          WHEN v_unconverted
            THEN ' [UNIT NOT CONVERTIBLE — line ' || v_chem.quantity || ' ' || COALESCE(NULLIF(v_chem.unit, ''), '?')
                 || ' recorded raw vs inventory unit ' || COALESCE(NULLIF(v_chem.inv_unit, ''), '?') || '; review required]'
          WHEN lower(btrim(COALESCE(v_chem.unit, ''))) IS DISTINCT FROM lower(btrim(COALESCE(v_chem.inv_unit, '')))
            THEN ' (converted from ' || v_chem.quantity || ' ' || COALESCE(NULLIF(v_chem.unit, ''), '?') || ')'
          ELSE ''
        END ||
        CASE WHEN v_short_flag THEN ' [SHORT STOCK — review required]' ELSE '' END ||
        CASE WHEN v_counted > 0 THEN ' [' || v_counted || ' already counted by blend ticket(s) for this job — review]' ELSE '' END,
      p_job_id,
      (v_short_flag OR v_unconverted OR v_counted > 0),
      v_record_id, NULLIF(v_counted, 0)
      -- >>>U11
    );
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'job_completed',
    'Job ' || v_job.job_number || ' completed across ' || v_field_count || ' field(s). Application record: ' || v_record_number ||
      CASE WHEN v_short_count > 0
           THEN ' (⚠ ' || v_short_count || ' short-stock chemical(s) — review required)'
           ELSE '' END ||
      -- U11<<< surface raw-fallback lines to the office the same way short-stock is surfaced
      CASE WHEN v_unconv_count > 0
           THEN ' (⚠ ' || v_unconv_count || ' chemical(s) with non-convertible units — recorded raw, review required)'
           ELSE '' END ||
      CASE WHEN v_counted_count > 0
           THEN ' (' || v_counted_count || ' chemical line(s) already counted by blend tickets — review)'
           ELSE '' END,
      -- >>>U11
    p_performed_by, 'job', p_job_id, v_job.customer_id
  );

  v_result := jsonb_build_object(
    'success',                true,
    'job_id',                 p_job_id,
    'application_record_id',  v_record_id,
    'record_number',          v_record_number,
    'field_count',            v_field_count,
    'short_stock_count',      v_short_count
  );

  BEGIN
    SELECT (setting_value = 'true')
      INTO v_auto_draft_on
      FROM app_settings
     WHERE setting_key = 'auto_draft_invoice_on_job_completion';
    v_auto_draft_on := COALESCE(v_auto_draft_on, false);

    -- #117<<< make every skip visible. Previously: the flag-ON + non-office case
    -- (the #107 applicator gap) and the already-invoiced case both did NOTHING —
    -- silence indistinguishable from success. Now each writes an
    -- 'auto_draft_skipped' activity row. The POLICY (should applicator
    -- completions auto-draft?) is unchanged and stays an owner decision (#107).
    IF v_auto_draft_on THEN
      IF (is_admin() OR is_sales_rep()) THEN
        SELECT i.id INTO v_existing_invoice
          FROM invoices i
         WHERE i.job_id = p_job_id
           AND i.deleted_at IS NULL
           AND i.status NOT IN ('voided', 'cancelled')
         LIMIT 1;

        IF v_existing_invoice IS NULL THEN
          v_auto_draft_key := 'auto_draft_job:' || p_job_id::text;
          PERFORM transfer_job_to_invoice(p_job_id, p_performed_by, v_auto_draft_key);
        ELSE
          INSERT INTO activity_feed (
            event_type, description, performed_by,
            related_entity_type, related_entity_id, customer_id
          ) VALUES (
            'auto_draft_skipped',
            'Job ' || v_job.job_number || ' completed — automatic draft invoice skipped: '
              || 'an active invoice already exists for this job.',
            p_performed_by, 'job', p_job_id, v_job.customer_id
          );
        END IF;
      ELSE
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'auto_draft_skipped',
          'Job ' || v_job.job_number || ' completed by an applicator — automatic draft '
            || 'invoice skipped (auto-draft only runs for office completions). '
            || 'Bill this job manually.',
          p_performed_by, 'job', p_job_id, v_job.customer_id
        );
      END IF;
    END IF;
    -- >>>#117
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'auto_draft_failed',
        'Job ' || v_job.job_number || ' completed, but the automatic draft invoice could '
          || 'not be created (needs attention — bill it manually). Reason: '
          -- every active profile reads activity_feed; a below-cost detail can carry the admin's cost
          || CASE WHEN SQLERRM LIKE 'BELOW\_COST\_%' THEN split_part(SQLERRM, ':', 1) ELSE SQLERRM END,
        p_performed_by, 'job', p_job_id, v_job.customer_id
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'complete_job', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._create_app_record_from_bt_replay_impl_20261015(p_blend_ticket_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_ticket         record;
  v_product_data   jsonb;
  v_season         integer;
  v_bt_product     record;
  v_field          record;
  v_record_id      uuid;
  v_record_ids     uuid[] := '{}';
  v_record_number  text;
  v_applicator_id  uuid;
  v_inv            record;
  v_inv_found      boolean;
  v_new_avail      numeric;
  v_short_flag     boolean;
  v_short_count    int := 0;
  v_field_count    int := 0;
  v_first_field_id uuid;
  v_app_time       time;
  -- A5: quantity converted to the product's inventory unit for the stock deduction
  v_deduct_qty     numeric;
  -- Count once: this line's claim, the job/ticket group's claims and amount taken so far,
  -- and the part of the claim another posting already took.
  v_claim          numeric;
  v_cj             numeric;
  v_ct             numeric;
  v_taken          numeric;
  v_counted        numeric;
  v_counted_count  int := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required to create application records from blend tickets';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key
        AND operation = 'create_app_record_from_bt';
    IF v_existing IS NOT NULL THEN
      RETURN ARRAY(SELECT jsonb_array_elements_text(v_existing))::uuid[];
    END IF;
  END IF;

  SELECT bt.* INTO v_ticket FROM blend_tickets bt WHERE bt.id = p_blend_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id; END IF;
  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved. Current status: %', v_ticket.review_status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM application_records
    WHERE source_type = 'blend_ticket' AND source_id = p_blend_ticket_id
  ) THEN
    RAISE EXCEPTION 'Application record(s) already exist for this blend ticket';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id', btp.product_id, 'product_name', btp.product_name,
        'quantity', btp.quantity, 'unit', btp.unit,
        'rate_per_acre', btp.rate_per_acre, 'rate_unit', btp.rate_per_acre_unit,
        'epa_registration', p.epa_registration, 'is_rup', COALESCE(p.is_rup, false)
      ) ORDER BY btp.sequence_order
    ), '[]'::jsonb
  ) INTO v_product_data
  FROM blend_ticket_products btp
  LEFT JOIN products p ON p.id = btp.product_id
  WHERE btp.blend_ticket_id = p_blend_ticket_id;

  v_season := CASE
    WHEN EXTRACT(MONTH FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) >= 10
    THEN EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) + 1
    ELSE EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date)
  END;

  BEGIN
    v_app_time := NULLIF(btrim(v_ticket.ticket_time), '')::time;
  EXCEPTION WHEN OTHERS THEN
    v_app_time := NULL;
  END;

  v_applicator_id := v_ticket.applicator_id;
  IF v_applicator_id IS NULL AND v_ticket.applicator_name IS NOT NULL THEN
    SELECT id INTO v_applicator_id FROM profiles
    WHERE full_name = v_ticket.applicator_name AND role = 'applicator' LIMIT 1;
  END IF;

  SELECT btf.field_id INTO v_first_field_id
    FROM blend_ticket_fields btf
   WHERE btf.blend_ticket_id = p_blend_ticket_id
   ORDER BY btf.sort_order
   LIMIT 1;

  v_record_number := next_application_record_number();
  INSERT INTO application_records (
    record_number, source_type, source_id, customer_id, applicator_id, field_id,
    application_date, application_time, product_data, total_acres,
    total_volume, total_volume_unit, weather_conditions, notes, season, created_by
  ) VALUES (
    v_record_number, 'blend_ticket', p_blend_ticket_id,
    v_ticket.customer_id, v_applicator_id, COALESCE(v_first_field_id, v_ticket.field_id),
    COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date, v_app_time,
    v_product_data, v_ticket.total_acres,
    v_ticket.total_volume, v_ticket.total_volume_unit, NULL, v_ticket.notes, v_season, p_performed_by
  ) RETURNING id INTO v_record_id;
  v_record_ids := v_record_ids || v_record_id;

  -- B1 lot propagation (ADDED): auto-fill application_record_lots from the blend ticket's
  -- per-product lot numbers so blend-sourced applications carry lots with no re-typing.
  -- Skips null product_id and blank lot_number; dedupes identical (product_id, lot_number)
  -- component rows; source_receiving_record_id stays NULL (these came from the blend, not a
  -- receiving record). Filtering keeps this insert from ever rolling back the whole RPC.
  INSERT INTO application_record_lots (application_record_id, product_id, lot_number, created_by)
  SELECT v_record_id, d.product_id, d.lot_number, p_performed_by
  FROM (
    SELECT DISTINCT ON (btp.product_id, lower(btrim(btp.lot_number)))
           btp.product_id, btrim(btp.lot_number) AS lot_number
    FROM blend_ticket_products btp
    WHERE btp.blend_ticket_id = p_blend_ticket_id
      AND btp.product_id IS NOT NULL
      AND btp.lot_number IS NOT NULL
      AND btrim(btp.lot_number) <> ''
    ORDER BY btp.product_id, lower(btrim(btp.lot_number))
  ) d;

  FOR v_field IN
    SELECT btf.field_id,
           COALESCE(btf.actual_acres, btf.planned_acres, f.total_acres, 0) AS acres,
           COALESCE(btf.sort_order, 0) AS sort_order
    FROM blend_ticket_fields btf
    LEFT JOIN fields f ON f.id = btf.field_id
    WHERE btf.blend_ticket_id = p_blend_ticket_id ORDER BY btf.sort_order
  LOOP
    INSERT INTO application_record_fields (application_record_id, field_id, acres, sort_order)
    VALUES (v_record_id, v_field.field_id, v_field.acres, v_field.sort_order);
    v_field_count := v_field_count + 1;
  END LOOP;

  FOR v_bt_product IN
    -- A5: join products for the inventory unit + form so the deduction converts.
    SELECT btp.product_id, btp.quantity, btp.unit AS qty_unit, btp.product_name,
           p.inventory_unit, p.unit_size, p.product_form
      FROM blend_ticket_products btp
      LEFT JOIN products p ON p.id = btp.product_id
    WHERE btp.blend_ticket_id = p_blend_ticket_id AND btp.product_id IS NOT NULL AND btp.quantity > 0
    ORDER BY btp.sequence_order, btp.id  -- count once: credit goes to lines in a fixed order
  LOOP
    -- A5: deduct in the product's inventory unit. The blend line quantity may be in a
    -- different unit (e.g. pints on a gallons-stocked product) — deducting the raw
    -- number corrupts stock by the unit ratio (the complete_job bug class).
    IF v_bt_product.inventory_unit IS NULL AND v_bt_product.unit_size IS NULL THEN
      RAISE EXCEPTION 'BLEND_TICKET_UNIT_UNCONVERTIBLE: product % (id %) has inventory_unit and unit_size unset',
        v_bt_product.product_name, v_bt_product.product_id;
    ELSE
      v_deduct_qty := field_app_priced_quantity(
                        v_bt_product.quantity,
                        normalize_rate_unit(NULLIF(btrim(v_bt_product.qty_unit), '')),
                        normalize_rate_unit(COALESCE(NULLIF(btrim(v_bt_product.inventory_unit), ''), v_bt_product.unit_size)),
                        v_bt_product.product_form);
      IF v_deduct_qty IS NULL THEN
        RAISE EXCEPTION 'BLEND_TICKET_UNIT_UNCONVERTIBLE: product % quantity unit "%" cannot convert to inventory unit "%"',
          v_bt_product.product_name, v_bt_product.qty_unit, COALESCE(v_bt_product.inventory_unit, v_bt_product.unit_size);
      END IF;
    END IF;

    -- Count once: on a ticket linked to a job, take only what the job's claims and its tickets' claims,
    -- whichever is larger, still need beyond what was already taken. An unlinked ticket, or one for another customer, takes its full claim.
    -- v_ticket was read FOR UPDATE, so its job link cannot change under us.
    v_claim := v_deduct_qty;
    v_counted := 0;
    IF v_ticket.job_id IS NOT NULL
       AND v_ticket.customer_id IS NOT DISTINCT FROM public._job_stock_customer_20270310(v_ticket.job_id) THEN
      SELECT g.job_claim, g.ticket_claim, g.taken INTO v_cj, v_ct, v_taken
        FROM public._job_stock_group_20270310(v_ticket.job_id, v_bt_product.product_id) g;
      v_deduct_qty := LEAST(v_claim, GREATEST(0, GREATEST(v_cj, v_ct + v_claim) - v_taken));
      v_counted := v_claim - v_deduct_qty;
      IF v_counted > 0 THEN
        v_counted_count := v_counted_count + 1;
      END IF;
    END IF;

    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_bt_product.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    v_inv_found := FOUND;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_deduct_qty;
    v_short_flag := v_deduct_qty > 0 AND v_new_avail < 0;  -- a line that moves nothing is not short
    IF v_short_flag THEN
      v_short_count := v_short_count + 1;
    END IF;

    IF NOT v_inv_found THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_bt_product.product_id, 'Main Warehouse', -v_deduct_qty, 0, 0);
    ELSE
      UPDATE inventory
      SET quantity_available = quantity_available - v_deduct_qty,
          updated_at         = now()
      WHERE product_id = v_bt_product.product_id AND location = 'Main Warehouse';
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes, requires_review, application_record_id, already_counted
    ) VALUES (
      v_bt_product.product_id, 'job_applied', v_deduct_qty, 'Main Warehouse',
      p_performed_by,
      'Blend ticket application: ' || v_ticket.ticket_number ||
        ' (application record ' || v_record_id::text || ')' ||
        CASE WHEN v_short_flag THEN ' [SHORT STOCK — review required]' ELSE '' END ||
        CASE WHEN v_counted > 0 THEN ' [' || v_counted || ' already counted by job or blend ticket(s) for this job — review]' ELSE '' END,
      (v_short_flag OR v_counted > 0),
      v_record_id, NULLIF(v_counted, 0)
    );
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'application_record_created',
    'Application record ' || v_record_number || ' created from blend ticket ' || v_ticket.ticket_number ||
      ' (' || v_field_count || ' field(s))' ||
      CASE WHEN v_short_count > 0
           THEN ' (⚠ ' || v_short_count || ' short-stock chemical(s) — review required)'
           ELSE '' END ||
      CASE WHEN v_counted_count > 0
           THEN ' (' || v_counted_count || ' chemical line(s) already counted for this job — review)'
           ELSE '' END,
    p_performed_by, 'blend_ticket', p_blend_ticket_id, v_ticket.customer_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_app_record_from_bt', to_jsonb(v_record_ids));
  END IF;

  RETURN v_record_ids;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_application_record(p_application_record_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor                uuid := auth.uid();
  v_cached               jsonb;
  v_record               record;
  v_original_txn         record;
  v_inventory            record;
  v_expected_deductions  integer := 0;
  v_ledger_deductions    integer := 0;
  v_reversed_count       integer := 0;
  v_result               jsonb;
  v_prior_reversal       boolean := false;
  v_job_id               uuid;
  v_job_record_id        uuid;
  v_keep                 record;
  v_keep_qty             numeric;
  v_over_qty             numeric;
  v_kept_count           integer := 0;
  v_over_count           integer := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  -- Fix F: admin-only (matches the replaced admin-only app_records_delete policy).
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin role required to reverse application records';
  END IF;

  -- Canonical helper-based replay check. Bind the cached result to this RPC's
  -- sole business argument so reuse of a key for another record fails loudly.
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'reverse_application_record');
    IF v_cached IS NOT NULL THEN
      IF (v_cached->>'application_record_id')::uuid IS DISTINCT FROM p_application_record_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: key % was already used to reverse a different application record',
          p_idempotency_key;
      END IF;
      RETURN v_cached;
    END IF;
  END IF;

  -- Count once: the same lock job completion and ticket filing take, before any row is
  -- read, so the job's stock group below is settled.
  PERFORM pg_advisory_xact_lock(hashtext('next_application_record_number'));

  -- A same-key request that held the lock first has committed its receipt by now: replay it.
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'reverse_application_record');
    IF v_cached IS NOT NULL THEN
      IF (v_cached->>'application_record_id')::uuid IS DISTINCT FROM p_application_record_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: key % was already used to reverse a different application record',
          p_idempotency_key;
      END IF;
      RETURN v_cached;
    END IF;
  END IF;

  -- Serializes concurrent reversals of the same record. After the first caller
  -- commits its DELETE, a waiting caller observes no row and returns a no-op.
  SELECT ar.*
    INTO v_record
    FROM public.application_records ar
   WHERE ar.id = p_application_record_id
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.inventory_transactions it
       WHERE it.transaction_type = 'adjusted'
         AND strpos(
               COALESCE(it.notes, ''),
               '(reversed application record ' || p_application_record_id::text || ')'
             ) > 0
    )
    -- Count once: a ticket that moved nothing leaves no credit row when reversed; its own write-once
    -- job_applied rows still name the record.
    OR EXISTS (
      SELECT 1
        FROM public.inventory_transactions it
       WHERE it.transaction_type = 'job_applied'
         AND it.application_record_id = p_application_record_id
    ) INTO v_prior_reversal;

    v_result := jsonb_build_object(
      'success', true,
      'status', CASE WHEN v_prior_reversal THEN 'already_reversed' ELSE 'not_found' END,
      'application_record_id', p_application_record_id,
      'inventory_transactions_reversed', 0,
      'already_reversed', v_prior_reversal
    );

    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(
        p_idempotency_key,
        'reverse_application_record',
        v_result
      );
    END IF;
    RETURN v_result;
  END IF;

  -- This reversal is intentionally scoped to the create RPC named in Bug B.
  -- Job-sourced records have a separate job lifecycle and ledger-link shape.
  IF v_record.source_type IS DISTINCT FROM 'blend_ticket' THEN
    RAISE EXCEPTION 'APPLICATION_RECORD_NOT_REVERSIBLE: only blend_ticket application records can be reversed by this RPC';
  END IF;

  -- A billed ticket cannot be undone (Mason, 2026-11-26): its invoice keeps the job link
  -- (_blend_ticket_billed_keeps_job_20270129), so the correction could not be finished. Same test as that lock.
  -- Locking the ticket first (invoicing locks it first too) means billing cannot start until this commits.
  PERFORM 1 FROM public.blend_tickets bt WHERE bt.id = v_record.source_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.blend_tickets bt WHERE bt.id = v_record.source_id AND bt.payment_status = 'billed')
     OR EXISTS (SELECT 1 FROM public.invoices i
                 WHERE i.blend_ticket_id = v_record.source_id
                   AND COALESCE(i.status, '') NOT IN ('voided', 'cancelled')
                   AND i.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'APPLICATION_RECORD_TICKET_INVOICED: this blend ticket has an active invoice. Void the invoice first, then undo the filing.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Count once (smart undo, Mason 2026-11-26): a ticket counted with its completed job (same customer) can be
  -- reversed; whatever the job still needs stays out of stock, on the job's own books.
  SELECT bt.job_id INTO v_job_id FROM public.blend_tickets bt WHERE bt.id = v_record.source_id;
  IF v_job_id IS NOT NULL
     AND v_record.customer_id IS NOT DISTINCT FROM public._job_stock_customer_20270310(v_job_id) THEN
    SELECT jr.id INTO v_job_record_id
      FROM public.application_records jr
     WHERE jr.source_type = 'job' AND jr.source_id = v_job_id
     ORDER BY jr.created_at, jr.id
     LIMIT 1;
  END IF;

  -- The create RPC writes one deduction transaction for every positive,
  -- product-linked product_data row. Count both sides before changing stock so
  -- a missing/edited ledger cannot produce a partial credit followed by DELETE.
  SELECT count(*)::integer
    INTO v_expected_deductions
    FROM jsonb_array_elements(COALESCE(v_record.product_data, '[]'::jsonb)) AS item
   WHERE NULLIF(item->>'product_id', '') IS NOT NULL
     AND COALESCE((item->>'quantity')::numeric, 0) > 0;

  SELECT count(*)::integer
    INTO v_ledger_deductions
    FROM public.inventory_transactions it
   WHERE it.transaction_type = 'job_applied'
     AND it.from_location = 'Main Warehouse'
     AND it.quantity >= 0  -- count once: a line counted in full posts a zero row
     AND it.notes LIKE 'Blend ticket application:%'
     AND strpos(
           COALESCE(it.notes, ''),
           '(application record ' || p_application_record_id::text || ')'
         ) > 0;

  IF v_ledger_deductions IS DISTINCT FROM v_expected_deductions THEN
    RAISE EXCEPTION 'APPLICATION_RECORD_REVERSAL_LEDGER_MISMATCH: record % expects % deduction row(s), found %; record was not deleted',
      p_application_record_id, v_expected_deductions, v_ledger_deductions;
  END IF;

  -- Lock and credit products in deterministic order. quantity is the exact
  -- converted amount originally deducted; no unit conversion is repeated here.
  FOR v_original_txn IN
    SELECT it.id, it.product_id, it.quantity
      FROM public.inventory_transactions it
     WHERE it.transaction_type = 'job_applied'
       AND it.from_location = 'Main Warehouse'
       AND it.quantity > 0
       AND it.notes LIKE 'Blend ticket application:%'
       AND strpos(
             COALESCE(it.notes, ''),
             '(application record ' || p_application_record_id::text || ')'
           ) > 0
     ORDER BY it.product_id, it.id
     FOR UPDATE
  LOOP
    SELECT inv.*
      INTO v_inventory
      FROM public.inventory inv
     WHERE inv.product_id = v_original_txn.product_id
       AND inv.location = 'Main Warehouse'
     FOR UPDATE;

    IF NOT FOUND THEN
      -- The create RPC creates this row when absent. Recreate only if it was
      -- subsequently removed, preserving the same canonical warehouse shape.
      INSERT INTO public.inventory (
        product_id, location, quantity_available,
        quantity_prebooked, quantity_on_order
      ) VALUES (
        v_original_txn.product_id, 'Main Warehouse', v_original_txn.quantity,
        0, 0
      )
      ON CONFLICT (product_id, location) DO UPDATE
        SET quantity_available = public.inventory.quantity_available + EXCLUDED.quantity_available,
            updated_at = now();
    ELSE
      UPDATE public.inventory
         SET quantity_available = quantity_available + v_original_txn.quantity,
             updated_at = now()
       WHERE id = v_inventory.id;
    END IF;

    -- "adjusted" is an existing allowed inventory transaction type and is the
    -- closest available type for a non-delivery stock correction. Positive
    -- quantity + to_location mirrors the physical credit back to the warehouse.
    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      performed_by, notes, requires_review
    ) VALUES (
      v_original_txn.product_id,
      'adjusted',
      v_original_txn.quantity,
      'Main Warehouse',
      v_actor,
      'Reversed blend ticket application record ' || v_record.record_number ||
        '; original inventory transaction ' || v_original_txn.id::text ||
        ' (reversed application record ' || p_application_record_id::text || ')',
      false
    );

    v_reversed_count := v_reversed_count + 1;
  END LOOP;

  -- Count once: every line above was credited in full. For each product, take back out what the completed job
  -- still needs without this ticket (the larger of the job's claims and the other tickets' claims, less what the
  -- others took), as a job row whose negative already_counted keeps the job's claim unchanged. If other tickets
  -- took more than the job now needs (because of this ticket), that extra comes back too, as a positive 'adjusted'
  -- row linked to the job record: the ledger reads it as stock added back, and the job's group counts it as returned.
  IF v_job_record_id IS NOT NULL THEN
    FOR v_keep IN
      SELECT x.product_id, x.q, x.claim, g.job_claim, g.ticket_claim, g.taken
        FROM (SELECT it.product_id, sum(it.quantity) AS q, sum(it.quantity + COALESCE(it.already_counted, 0)) AS claim
                FROM public.inventory_transactions it
               WHERE it.transaction_type = 'job_applied'
                 AND it.notes LIKE 'Blend ticket application:%'
                 AND strpos(COALESCE(it.notes, ''), '(application record ' || p_application_record_id::text || ')') > 0
               GROUP BY it.product_id) x
        CROSS JOIN LATERAL public._job_stock_group_20270310(v_job_id, x.product_id) g
       ORDER BY x.product_id
    LOOP
      v_keep_qty := LEAST(v_keep.q, GREATEST(0, GREATEST(v_keep.job_claim, v_keep.ticket_claim - v_keep.claim) - (v_keep.taken - v_keep.q)));
      v_over_qty := GREATEST(0, (v_keep.taken - v_keep.q) - GREATEST(v_keep.job_claim, v_keep.ticket_claim - v_keep.claim));
      IF v_keep_qty > 0 THEN
        UPDATE public.inventory
           SET quantity_available = quantity_available - v_keep_qty,
               updated_at = now()
         WHERE product_id = v_keep.product_id AND location = 'Main Warehouse';
        INSERT INTO public.inventory_transactions (
          product_id, transaction_type, quantity, from_location,
          performed_by, notes, job_id, requires_review, application_record_id, already_counted
        ) VALUES (
          v_keep.product_id, 'job_applied', v_keep_qty, 'Main Warehouse',
          v_actor,
          'Kept on the job: ' || v_keep_qty || ' its completion still needs after blend ticket application record ' ||
            v_record.record_number || ' was reversed — review',
          v_job_id, true, v_job_record_id, -v_keep_qty
        );
        v_kept_count := v_kept_count + 1;
      END IF;
      IF v_over_qty > 0 THEN
        -- This ticket may have moved nothing, so the credit loop above may not have recreated a retired row.
        INSERT INTO public.inventory (
          product_id, location, quantity_available,
          quantity_prebooked, quantity_on_order
        ) VALUES (
          v_keep.product_id, 'Main Warehouse', v_over_qty,
          0, 0
        )
        ON CONFLICT (product_id, location) DO UPDATE
          SET quantity_available = public.inventory.quantity_available + EXCLUDED.quantity_available,
              updated_at = now();
        INSERT INTO public.inventory_transactions (
          product_id, transaction_type, quantity, to_location,
          performed_by, notes, job_id, requires_review, application_record_id, already_counted
        ) VALUES (
          v_keep.product_id, 'adjusted', v_over_qty, 'Main Warehouse',
          v_actor,
          'Returned from the job: other blend tickets took ' || v_over_qty || ' more than the job needs after application record ' ||
            v_record.record_number || ' was reversed — review',
          v_job_id, true, v_job_record_id, NULL
        );
        v_over_count := v_over_count + 1;
      END IF;
    END LOOP;
  END IF;

  -- Both child tables use ON DELETE CASCADE, but explicit deletes make the
  -- intended removal order clear and remain harmless if either table is empty.
  DELETE FROM public.application_record_lots
   WHERE application_record_id = p_application_record_id;
  DELETE FROM public.application_record_fields
   WHERE application_record_id = p_application_record_id;
  DELETE FROM public.application_records
   WHERE id = p_application_record_id;

  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'application_record_reversed',
    'Application record ' || v_record.record_number || ' reversed; ' ||
      v_reversed_count || ' inventory deduction(s) restored' ||
      CASE WHEN v_kept_count > 0 THEN '; ' || v_kept_count || ' chemical line(s) kept on its completed job — review' ELSE '' END ||
      CASE WHEN v_over_count > 0 THEN '; ' || v_over_count || ' chemical line(s) over-taken by other tickets returned — review' ELSE '' END,
    v_actor,
    'blend_ticket',
    v_record.source_id,
    v_record.customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'status', 'reversed',
    'application_record_id', p_application_record_id,
    'blend_ticket_id', v_record.source_id,
    'record_number', v_record.record_number,
    'inventory_transactions_reversed', v_reversed_count,
    'kept_on_job_lines', v_kept_count,
    'over_taken_lines', v_over_count,
    'already_reversed', false
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'reverse_application_record',
      v_result
    );
  END IF;

  RETURN v_result;
END;
$function$;

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  FOR v_fn IN
    SELECT x.sig, x.md5, x.api, p.oid, p.prosrc, p.prosecdef, p.proconfig
      FROM (VALUES
        ('public._complete_job_replay_impl_20261015(uuid, jsonb, uuid, text)', '0fc4e07bd31e23a56c37ca7bf8c9301b', false),
        ('public._create_app_record_from_bt_replay_impl_20261015(uuid, uuid, text)', '65ff342c6eccd4043ea3db7c4f7635d1', false),
        ('public.reverse_application_record(uuid, text)', '8f3656f84e005203248b9f933543fd7a', true)
      ) AS x(sig, md5, api)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(x.sig)
  LOOP
    IF v_fn.oid IS NULL OR md5(replace(v_fn.prosrc, chr(13), '')) IS DISTINCT FROM v_fn.md5
       OR NOT v_fn.prosecdef OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
      RAISE EXCEPTION 'COUNT_ONCE_POSTFLIGHT: % is not the reviewed body', v_fn.sig;
    END IF;
    IF has_function_privilege('anon', v_fn.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') IS DISTINCT FROM v_fn.api
       OR has_function_privilege('service_role', v_fn.oid, 'EXECUTE') IS DISTINCT FROM v_fn.api THEN
      RAISE EXCEPTION 'COUNT_ONCE_POSTFLIGHT: % grants changed', v_fn.sig;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public._job_stock_customer_20270310(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._job_stock_customer_20270310(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._job_stock_customer_20270310(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._job_stock_group_20270310(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._job_stock_group_20270310(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._job_stock_group_20270310(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'COUNT_ONCE_POSTFLIGHT: a new helper is executable by an API role';
  END IF;
END;
$postflight$;
