-- Written 2026-11-02. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT (KI-02 / KI-74, To-Do 11.3: cost, profit and margin are admin-only): the 2026-11-02 audit of
--   every owner-rights (SECURITY DEFINER) function a signed-in user can run
--   (docs/audits/2026-11-02-cost-margin-definer-function-audit.md) found four bodies to change so
--   cost goes only to admins. Column grants cannot do this, because the functions run as their
--   owner. Each body below is the live body (md5-pinned by the preflight) with one change:
--   1. get_dispatch_board_jobs removes jobs.total_cost_cents from its payload for every caller (no
--      screen reads it from this payload; admins read job cost through get_admin_cost_fields).
--   2. _manual_inventory_add_replay_impl_20261015 (body of manual_inventory_add) no longer appends a
--      purchase cost to inventory_transactions.notes. p_unit_cost stays in the signature (older
--      clients may still send it) and is now ignored; it was used for nothing else (20260320210000
--      already stopped it changing product cost). The Inventory screen's "Unit Cost (optional)" box
--      is removed in the same change. Existing notes are not changed (Mason, 2026-11-02).
--   3. _complete_job_replay_impl_20261015 (body of complete_job): when the automatic draft invoice
--      fails with a BELOW_COST_* error, the activity_feed entry now carries its code only (the part
--      before the first ':'); other errors are unchanged.
--   4. _create_order_from_blend_ticket_replay_impl_20261015: ORDER_HEADER_NOT_RECALCULATED carries
--      the order's totals only for an admin; others get the bare code.
--
-- WHY: Mason, 2026-10-15: cost and margin are admin-only, including on a rep's own work.
--
-- HOW: CREATE OR REPLACE of each existing signature, so owner, SECURITY DEFINER, search_path and
--   grants are unchanged (the three _impl helpers stay unexecutable by browser roles). No table,
--   column, policy or grant changes. No data changes. Non-destructive.
--
-- ROLLBACK: re-run the four bodies from their source migrations (20261013220000 for
--   get_dispatch_board_jobs; 20260702141000 manual_inventory_add and 20260722012359 complete_job,
--   each under its _replay_impl_20261015 name; 20261020210000 for the blend-ticket impl). Rollback
--   undoes these changes.
--
-- Proof: node scripts/smoke/prove-cost-definer-leaks-closed-real-schema.mjs
--
-- actor-binding-check: exempt -- the three _replay_impl_20261015 bodies are not executable by any
--   browser role; their only callers are the public wrappers manual_inventory_add,
--   create_order_from_blend_ticket and complete_job, each of which binds the actor to auth.uid() before
--   calling the body (complete_job and the blend-ticket wrapper refuse any other p_performed_by;
--   manual_inventory_add also accepts NULL and then acts as auth.uid(), the canonical pattern; read
--   live 2026-11-02). get_dispatch_board_jobs takes no actor.

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(pin.fn, ', ') INTO v_bad
  FROM (VALUES
    ('get_dispatch_board_jobs', '7a042e4597ff5cbf4910aec4d75ee11a', 'uuid, text, date, date'),
    ('_manual_inventory_add_replay_impl_20261015', 'e54402d968bd94924857f1ff69827d46',
     'uuid, text, numeric, text, uuid, text, numeric, text, numeric, numeric'),
    ('_complete_job_replay_impl_20261015', '4e4c38e3e8be66e2d24c434bb54c0521', 'uuid, jsonb, uuid, text'),
    ('_create_order_from_blend_ticket_replay_impl_20261015', '4b5ea386b9be7c70c240ffb8efae08e6',
     'uuid, text, date, text, uuid, text')
  ) AS pin(fn, body_md5, args)
  LEFT JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace AND p.proname = pin.fn
  WHERE p.oid IS NULL
     OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
     -- the exact argument list, so each CREATE OR REPLACE below replaces this function, never adds an overload
     OR oidvectortypes(p.proargtypes) IS DISTINCT FROM pin.args
     OR (SELECT count(*) FROM pg_proc q WHERE q.pronamespace = 'public'::regnamespace AND q.proname = pin.fn) <> 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'COST_DEFINER_LEAKS_PREFLIGHT: live body drifted from the audited one (re-read before applying): %', v_bad;
  END IF;
END
$preflight$;

-- 1. Dispatch board: job cost never leaves the function.
CREATE OR REPLACE FUNCTION public.get_dispatch_board_jobs(p_applicator_id uuid, p_status text DEFAULT NULL::text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date)
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- A dispatch row is VISIBLE to the caller (mirrors job_location_dispatches_select):
  --   admin/sales see all; the job's whole-job applicator sees every row on their job;
  --   otherwise a field user sees a row where they are the assignee or an active member
  --   of the assigned active crew.
  WITH matched AS (
    SELECT j.*
      FROM public.jobs j
     WHERE j.deleted_at IS NULL
       AND p_applicator_id IS NOT NULL
       AND (p_status IS NULL OR j.status = p_status)
       AND (p_start_date IS NULL OR j.job_date >= p_start_date)
       AND (p_end_date IS NULL OR j.job_date <= p_end_date)
       AND (
         -- (a) a CURRENT per-location dispatch to this applicator the CALLER can see
         EXISTS (
           SELECT 1 FROM public.job_location_dispatches d
            WHERE d.job_id = j.id
              AND d.dispatch_status = 'dispatched'
              AND d.applicator_id = p_applicator_id
              AND (
                is_admin()
                OR is_sales_rep()
                OR (is_applicator() AND j.applicator_id = (select auth.uid()))
                OR d.applicator_id = (select auth.uid())
              )
         )
         OR (
           -- (b) whole-job applicator = this one AND the job has NO per-location dispatch
           j.applicator_id = p_applicator_id
           AND NOT EXISTS (
             SELECT 1 FROM public.job_location_dispatches d2
              WHERE d2.job_id = j.id
                AND d2.dispatch_status = 'dispatched'
           )
         )
       )
       -- VISIBILITY GATE — the live jobs SELECT predicate. Never return a hidden job.
       AND (
         is_admin()
         OR is_sales_rep()
         OR (is_applicator() AND j.applicator_id = (select auth.uid()))
         OR public._is_dispatched_to_me(j.id)
       )
     ORDER BY j.job_date DESC NULLS LAST
     LIMIT 500
  )
  SELECT
    -- Job cost is admin-only and readable through get_admin_cost_fields; never send it here.
    (to_jsonb(m) - 'total_cost_cents')
    || jsonb_build_object(
         -- CUSTOMER NAME — RLS-equivalent (Codex re-review-3 P2): this function is
         -- SECURITY DEFINER, so a raw `customers` read would bypass customers_select and
         -- could leak a farm_name the caller can't otherwise see (a sales_rep is limited
         -- to assigned customers; an applicator/driver to a time-windowed set). Return the
         -- name ONLY when the caller would pass customers_select OR
         -- customers_select_location_dispatchee for THIS job's customer; else farm_name
         -- is null (the board renders 'Unknown', exactly as the unfiltered RLS embed would).
         'customer',
         (SELECT jsonb_build_object(
                   'farm_name',
                   CASE WHEN (
                     is_admin()
                     OR is_sales_rep()  -- any customer since 20261013220000 (Mason, 2026-10-13)
                     OR (is_driver() AND EXISTS (
                           SELECT 1 FROM public.deliveries d
                            WHERE d.customer_id = c.id
                              AND d.assigned_driver = (select auth.uid())
                              AND d.scheduled_date >= (CURRENT_DATE - interval '1 day')))
                     OR (is_applicator() AND EXISTS (
                           SELECT 1 FROM public.jobs j2
                            WHERE j2.customer_id = c.id
                              AND j2.applicator_id = (select auth.uid())
                              AND j2.job_date >= (CURRENT_DATE - interval '7 days')))
                     OR EXISTS (
                           SELECT 1 FROM public.jobs j3
                            WHERE j3.customer_id = c.id
                              AND public._is_dispatched_to_me(j3.id))
                   ) THEN c.farm_name ELSE NULL END)
            FROM public.customers c WHERE c.id = m.customer_id),
         -- JOB_FIELDS — job_fields_select is satisfied for every job that passed this
         -- function's visibility gate (admin/sales_rep/whole-job applicator/_is_dispatched_to_me
         -- are exactly its conditions), so listing the rows leaks nothing. field_name is
         -- gated to the fields_select predicate (admin/sales_rep/applicator) so a dispatched
         -- crew member whose role is NOT applicator doesn't get a field name they couldn't
         -- read under RLS (null → the board falls back to 'Field'). (Codex re-review-3 P2.)
         'job_fields',
         coalesce((
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', jf.id,
                      'field_id', jf.field_id,
                      'acres_to_treat', jf.acres_to_treat,
                      'sort_order', jf.sort_order,
                      'field', jsonb_build_object(
                        'id', f.id,
                        'field_name', CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                                           THEN f.field_name ELSE NULL END)
                    ) ORDER BY jf.sort_order
                  )
             FROM public.job_fields jf
             JOIN public.fields f ON f.id = jf.field_id
            WHERE jf.job_id = m.id
         ), '[]'::jsonb),
         -- per-location dispatch rows the CALLER can see, for client-side label aggregation
         '_dispatches',
         coalesce((
           SELECT jsonb_agg(jsonb_build_object('applicator_id', d.applicator_id, 'crew_id', d.crew_id))
             FROM public.job_location_dispatches d
            WHERE d.job_id = m.id
              AND d.dispatch_status = 'dispatched'
              AND (
                is_admin()
                OR is_sales_rep()
                OR (is_applicator() AND m.applicator_id = (select auth.uid()))
                OR d.applicator_id = (select auth.uid())
                OR (
                  d.crew_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM public.ground_crew_members gcm
                      JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                     WHERE gcm.crew_id = d.crew_id
                       AND gcm.profile_id = (select auth.uid())
                       AND gcm.is_active
                       AND gc.is_active
                  )
                )
              )
         ), '[]'::jsonb)
       )
    FROM matched m;
$function$;

-- 2. Manual inventory add: the purchase cost is no longer written into the history note.
CREATE OR REPLACE FUNCTION public._manual_inventory_add_replay_impl_20261015(
  p_product_id      uuid,
  p_location        text,
  p_quantity        numeric,
  p_unit_size       text    DEFAULT NULL::text,
  p_performed_by    uuid    DEFAULT NULL::uuid,
  p_notes           text    DEFAULT NULL::text,
  p_unit_cost       numeric DEFAULT NULL::numeric,
  p_idempotency_key text    DEFAULT NULL::text,
  p_reorder_point   numeric DEFAULT NULL::numeric,
  p_min_stock_level numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_existing record;
  v_product  record;
  v_note     text;
  v_idemp_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_idemp_existing := check_idempotency(p_idempotency_key, 'manual_inventory_add');
    IF v_idemp_existing IS NOT NULL THEN RETURN v_idemp_existing; END IF;
  END IF;

  SELECT * INTO v_existing
  FROM inventory WHERE product_id = p_product_id AND location = COALESCE(p_location, 'Main Warehouse');

  IF FOUND THEN
    RAISE EXCEPTION 'Inventory record already exists for this product at this location. Use Receive or Adjust instead.';
  END IF;

  SELECT * INTO v_product FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  INSERT INTO inventory (product_id, location, quantity_available, unit_size, reorder_point, min_stock_level)
  VALUES (
    p_product_id,
    COALESCE(p_location, 'Main Warehouse'),
    GREATEST(p_quantity, 0),
    COALESCE(p_unit_size, v_product.unit_size),
    GREATEST(COALESCE(p_reorder_point, 0), 0),
    GREATEST(COALESCE(p_min_stock_level, 0), 0)
  );

  -- p_unit_cost is ignored: inventory notes are readable by sales reps, and cost is admin-only.
  v_note := COALESCE(p_notes, 'Initial inventory record created with ' || p_quantity || ' units');

  IF p_quantity > 0 THEN
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      to_location, performed_by, notes
    ) VALUES (
      p_product_id, 'adjusted', p_quantity,
      COALESCE(p_location, 'Main Warehouse'), v_actor,
      v_note
    );
  END IF;

  v_result := jsonb_build_object('success', true);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'manual_inventory_add', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- 3. Job completion: a below-cost refusal is logged by its code only, never its detail.
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
    OR (is_applicator() AND v_job.applicator_id IS NOT NULL AND v_job.applicator_id = v_actor)
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

    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_chem.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    v_inv_found := FOUND;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_deduct_qty;
    v_short_flag := v_new_avail < 0;
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
      performed_by, notes, job_id, requires_review
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
        CASE WHEN v_short_flag THEN ' [SHORT STOCK — review required]' ELSE '' END,
      p_job_id,
      (v_short_flag OR v_unconverted)
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

-- 4. Blend-ticket order: the header check names cost figures to admins only.
CREATE OR REPLACE FUNCTION public._create_order_from_blend_ticket_replay_impl_20261015(p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor       uuid := auth.uid();
  v_ticket      blend_tickets%ROWTYPE;
  v_order_id    uuid;
  v_customer    customers%ROWTYPE;
  v_product     blend_ticket_products%ROWTYPE;
  v_db_product  products%ROWTYPE;
  v_item_id     uuid;
  v_tier        int;
  v_price       numeric;
  -- Goal 3 pricing (20261020210000): the products with no usable price.
  v_unpriced    text;
  v_cost        numeric;
  v_total_price numeric := 0;
  v_total_cost  numeric := 0;
  v_total_profit numeric := 0;
  v_total_margin_pct numeric := 0;
  v_expected_total_price numeric;
  v_expected_total_cost  numeric;
  v_expected_total_profit numeric;
  v_expected_margin_pct  numeric;
  v_item_count  int := 0;
  v_invalid_count int;
  v_link_result json;
  v_cached      jsonb;
  v_result      jsonb;
  -- A5: quantity converted to the product's inventory unit + the unit label to store
  v_qty_conv    numeric;
  v_unit_out    text;
  -- Per-blend-line mappings retain the ticket quantity/unit truth. The order
  -- line and inventory transaction may use a converted inventory-unit value.
  v_mappings    jsonb := '[]'::jsonb;
BEGIN
  -- A5-actor: reject a forged actor / non-admin up front, mirroring the two sibling
  -- blend-ticket RPCs (create_invoice_/create_application_record_from_blend_ticket).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required to create orders from blend tickets';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'create_order_from_blend_ticket');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached::json;
    END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.invoices
     WHERE blend_ticket_id = p_blend_ticket_id
       AND deleted_at IS NULL
       AND COALESCE(status, '') NOT IN ('voided', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_ACTIVE_INVOICE_ORDER_LOCKED';
  END IF;
  IF v_ticket.order_link_status = 'linked' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket is already linked to an order');
  END IF;
  IF v_ticket.customer_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket has no customer assigned');
  END IF;
  IF v_ticket.status <> 'completed' OR v_ticket.review_status <> 'approved' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket must be completed and approved before creating an order');
  END IF;
  IF v_ticket.payment_status <> 'unbilled' THEN
    RETURN json_build_object('success', false, 'error', 'Only an unbilled blend ticket can create an order');
  END IF;

  SELECT count(*) FILTER (
           WHERE btp.product_id IS NULL
              OR btp.quantity <= 0
              OR btp.quantity::text IN ('NaN', 'Infinity', '-Infinity')
              OR p.id IS NULL
              OR p.is_active IS DISTINCT FROM true
         )
    INTO v_invalid_count
    FROM blend_ticket_products btp
    LEFT JOIN products p ON p.id = btp.product_id
   WHERE btp.blend_ticket_id = p_blend_ticket_id;

  IF NOT EXISTS (
    SELECT 1 FROM blend_ticket_products
     WHERE blend_ticket_id = p_blend_ticket_id
  ) THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket has no products');
  END IF;
  IF v_invalid_count > 0 THEN
    RETURN json_build_object('success', false, 'error', 'Every blend-ticket product must be matched to an active catalog product with a positive quantity');
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_ticket.customer_id AND is_active = true;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Customer not found');
  END IF;
  v_tier := COALESCE(v_customer.assigned_tier, 1);

  -- Goal 3 pricing (20261020210000): an order line is never priced at $0 because a tier price
  -- is missing. The customer's tier price is used when it is above zero, otherwise the tier-1
  -- price (_blend_tier_price_cents_20261020); a product with neither is refused here, before
  -- any row is written.
  SELECT string_agg(DISTINCT p.product_name, ', ' ORDER BY p.product_name)
    INTO v_unpriced
    FROM blend_ticket_products btp
    JOIN products p ON p.id = btp.product_id
   WHERE btp.blend_ticket_id = p_blend_ticket_id
     AND public._blend_tier_price_cents_20261020(v_tier, p.tier1_price, p.tier2_price, p.tier3_price) IS NULL;
  IF v_unpriced IS NOT NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRICE_MISSING: product(s) have no price on the price list: %', v_unpriced;
  END IF;

  -- CHANGED: Removed total_paid and balance_due from INSERT (AR tracked via invoices)
  v_order_id := gen_random_uuid();
  INSERT INTO orders (id, order_number, customer_id, status, order_date, notes, season, salesman_id, total_price, total_cost, total_profit, total_margin_pct)
  VALUES (
    v_order_id,
    p_order_number,
    v_ticket.customer_id,
    'confirmed',
    p_order_date,
    COALESCE(p_notes, 'Created from blend ticket ' || v_ticket.ticket_number),
    v_ticket.season,
    v_ticket.salesman_id,
    0, 0, 0, 0
  );

  FOR v_product IN
    SELECT * FROM blend_ticket_products
    WHERE blend_ticket_id = p_blend_ticket_id
    ORDER BY sequence_order
  LOOP
    v_price := 0;
    v_cost := 0;
    -- A5: default for an unmatched product (no product row) — no price, no conversion.
    v_qty_conv := v_product.quantity;
    v_unit_out := COALESCE(v_product.unit, 'ea');

    IF v_product.product_id IS NOT NULL THEN
      SELECT * INTO v_db_product FROM products WHERE id = v_product.product_id;
      IF FOUND THEN
        -- Goal 3 pricing: the tier price, else the tier-1 price, never a missing price as $0.
        v_price := ROUND(public._blend_tier_price_cents_20261020(
          v_tier, v_db_product.tier1_price, v_db_product.tier2_price, v_db_product.tier3_price) / 100.0, 2);
        IF v_price IS NULL THEN
          RAISE EXCEPTION 'BLEND_TICKET_PRICE_MISSING: product(s) have no price on the price list: %', v_product.product_name;
        END IF;
        v_cost := COALESCE(v_db_product.current_cost, 0);
        -- A5: convert the stored quantity (in v_product.unit) to the inventory unit
        -- so total_price, prebook, and the inventory txn all use the pricing/stock unit.
        v_qty_conv := field_app_priced_quantity(
                        v_product.quantity,
                        normalize_rate_unit(NULLIF(btrim(v_product.unit), '')),
                        normalize_rate_unit(COALESCE(NULLIF(btrim(v_db_product.inventory_unit), ''), v_db_product.unit_size)),
                        v_db_product.product_form);
        IF v_qty_conv IS NULL
           OR v_qty_conv <= 0
           OR v_qty_conv::text IN ('NaN', 'Infinity', '-Infinity') THEN
          RAISE EXCEPTION 'BLEND_TICKET_UNIT_UNCONVERTIBLE: product % quantity unit "%" cannot convert to inventory unit "%"',
            v_product.product_name, v_product.unit, COALESCE(v_db_product.inventory_unit, v_db_product.unit_size);
        END IF;
        v_unit_out := COALESCE(NULLIF(btrim(v_db_product.inventory_unit), ''), v_db_product.unit_size, v_product.unit, 'ea');
      END IF;
    END IF;

    v_item_id := gen_random_uuid();
    INSERT INTO order_items (
      id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      actual_rate, rate_unit, acres, total_units_needed, unit_size,
      total_price, profit, net_margin, quantity_delivered, quantity_remaining, sort_order
    )
    VALUES (
      v_item_id,
      v_order_id,
      v_product.product_id,
      v_product.product_name,
      v_price,
      v_cost,
      v_product.rate_per_acre,
      v_product.rate_per_acre_unit,
      v_ticket.total_acres,
      v_qty_conv,
      v_unit_out,
      v_price * v_qty_conv,
      (v_price - v_cost) * v_qty_conv,
      CASE WHEN v_price > 0 THEN ((v_price - v_cost) / v_price * 100) ELSE 0 END,
      0,
      v_qty_conv,
      v_product.sequence_order
    );

    -- Preserve exact blend-line identity and source quantity for link validation.
    IF v_product.product_id IS NOT NULL THEN
      v_mappings := v_mappings || jsonb_build_object(
        'blend_product_id', v_product.id,
        'order_item_id', v_item_id,
        'quantity_applied', v_product.quantity
      );
    END IF;

    IF v_product.product_id IS NOT NULL AND v_qty_conv > 0 THEN
      INSERT INTO inventory (
        product_id, location, quantity_available,
        quantity_prebooked, quantity_on_order, unit_size, updated_at
      ) VALUES (
        v_product.product_id, 'Main Warehouse', 0,
        v_qty_conv, 0, v_unit_out, now()
      )
      ON CONFLICT (product_id, location) DO UPDATE
        SET quantity_prebooked = COALESCE(inventory.quantity_prebooked, 0)
                                 + EXCLUDED.quantity_prebooked,
            updated_at = now();

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity, to_location,
        order_id, performed_by, notes
      ) VALUES (
        v_product.product_id, 'booked', v_qty_conv, 'Main Warehouse',
        v_order_id, p_performed_by,
        'Prebooked for blend ticket order ' || p_order_number
      );
    END IF;

    v_item_count := v_item_count + 1;
  END LOOP;

  -- The AFTER-ROW trigger has already written all four header columns. Read
  -- the stored values first so v_total_price remains the value returned to the
  -- caller after the assertion proves it agrees with the inserted lines.
  SELECT COALESCE(o.total_price, 0),
         COALESCE(o.total_cost, 0),
         COALESCE(o.total_profit, 0),
         COALESCE(o.total_margin_pct, 0)
    INTO v_total_price, v_total_cost, v_total_profit, v_total_margin_pct
  FROM orders o
  WHERE o.id = v_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_HEADER_UNREADABLE';
  END IF;

  -- Mirror trg_recalc_order_totals exactly: round each line before summing,
  -- then derive profit and margin from those rounded sums.
  SELECT COALESCE(SUM(ROUND(total_price,2)),0),
         COALESCE(SUM(ROUND(COALESCE(cost_per_unit,0)*COALESCE(total_units_needed,0),2)),0)
    INTO v_expected_total_price, v_expected_total_cost
    FROM order_items WHERE order_id = v_order_id;
  v_expected_total_profit := v_expected_total_price - v_expected_total_cost;
  v_expected_margin_pct := CASE WHEN v_expected_total_price > 0
                                THEN ROUND((v_expected_total_profit / v_expected_total_price) * 100, 2) ELSE 0 END;

  -- PostgreSQL numeric NaN equals itself, so exact equality alone would let a
  -- NaN header pass. Reject non-finite values explicitly, and require every
  -- computed money total to be exact whole cents before comparing the stored
  -- header with exact numeric equality (no tolerance).
  IF v_expected_total_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_expected_total_cost::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_expected_total_profit::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_expected_total_price IS DISTINCT FROM ROUND(v_expected_total_price, 2)
     OR v_expected_total_cost IS DISTINCT FROM ROUND(v_expected_total_cost, 2)
     OR v_expected_total_profit IS DISTINCT FROM ROUND(v_expected_total_profit, 2)
     OR v_total_price IS DISTINCT FROM v_expected_total_price
     OR v_total_cost IS DISTINCT FROM v_expected_total_cost
     OR v_total_profit IS DISTINCT FROM v_expected_total_profit
     OR v_total_margin_pct IS DISTINCT FROM v_expected_margin_pct THEN
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'ORDER_HEADER_NOT_RECALCULATED';
    END IF;
    RAISE EXCEPTION 'ORDER_HEADER_NOT_RECALCULATED: observed total_price=%, total_cost=%, total_profit=%, total_margin_pct=%; expected total_price=%, total_cost=%, total_profit=%, total_margin_pct=%',
      v_total_price, v_total_cost, v_total_profit, v_total_margin_pct,
      v_expected_total_price, v_expected_total_cost, v_expected_total_profit, v_expected_margin_pct;
  END IF;

  v_link_result := link_blend_ticket_to_order(p_blend_ticket_id, v_order_id, v_mappings, p_performed_by);
  IF COALESCE((v_link_result->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'BLEND_TICKET_ORDER_LINK_FAILED: %', COALESCE(v_link_result->>'error', 'unknown link failure');
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'order_created_from_blend_ticket',
    'Order ' || p_order_number || ' created from blend ticket ' || v_ticket.ticket_number,
    p_performed_by,
    'order',
    v_order_id
  );

  v_result := jsonb_build_object(
     'success', true,
     'order_id', v_order_id,
     'order_number', p_order_number,
     'items_created', v_item_count,
     'total_price', v_total_price
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'create_order_from_blend_ticket',
      v_result
    );
  END IF;

  RETURN v_result::json;
END;
$function$;

DO $postflight$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(chk.why, '; ') INTO v_bad
  FROM (
    SELECT format('%s now has %s overloads or a changed argument list', pin.fn, count(p.oid)) AS why
      FROM (VALUES
        ('get_dispatch_board_jobs', 'uuid, text, date, date'),
        ('_manual_inventory_add_replay_impl_20261015', 'uuid, text, numeric, text, uuid, text, numeric, text, numeric, numeric'),
        ('_complete_job_replay_impl_20261015', 'uuid, jsonb, uuid, text'),
        ('_create_order_from_blend_ticket_replay_impl_20261015', 'uuid, text, date, text, uuid, text')
      ) AS pin(fn, args)
      LEFT JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace AND p.proname = pin.fn
     GROUP BY pin.fn, pin.args
    HAVING count(p.oid) <> 1 OR bool_or(oidvectortypes(p.proargtypes) IS DISTINCT FROM pin.args)
    UNION ALL
    SELECT 'dispatch board still returns job cost'
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                         AND p.proname = 'get_dispatch_board_jobs'
                         AND p.prosrc LIKE '%(to_jsonb(m) - ''total_cost_cents'')%'
                         -- and no second, unstripped copy of the whole row
                         AND (length(p.prosrc) - length(replace(p.prosrc, 'to_jsonb(m)', '')))
                           = (length(p.prosrc) - length(replace(p.prosrc, '(to_jsonb(m) - ''total_cost_cents'')', ''))) * length('to_jsonb(m)')
                             / length('(to_jsonb(m) - ''total_cost_cents'')'))
    UNION ALL
    SELECT 'manual inventory add still writes cost into notes'
     WHERE EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                     AND p.proname = '_manual_inventory_add_replay_impl_20261015'
                     AND p.prosrc LIKE '%purchased @%')
    UNION ALL
    SELECT 'complete_job still logs a below-cost detail'
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                         AND p.proname = '_complete_job_replay_impl_20261015'
                         AND position($chk$WHEN SQLERRM LIKE 'BELOW\_COST\_%' THEN split_part(SQLERRM, ':', 1)$chk$ IN p.prosrc) > 0
                         -- and no other path still appends the raw error to the shared feed
                         AND position('|| SQLERRM,' IN p.prosrc) = 0)
    UNION ALL
    SELECT 'blend-ticket header check still shows cost to non-admins'
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                         AND p.proname = '_create_order_from_blend_ticket_replay_impl_20261015'
                         AND p.prosrc LIKE '%IF NOT public.is_admin() THEN%RAISE EXCEPTION ''ORDER_HEADER_NOT_RECALCULATED'';%')
    UNION ALL
    SELECT format('%s lost SECURITY DEFINER or its search_path', p.proname)
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('get_dispatch_board_jobs', '_manual_inventory_add_replay_impl_20261015',
                         '_complete_job_replay_impl_20261015', '_create_order_from_blend_ticket_replay_impl_20261015')
       AND (NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'])
    UNION ALL
    SELECT format('%s is executable by a browser role', p.proname)
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('_manual_inventory_add_replay_impl_20261015', '_complete_job_replay_impl_20261015',
                         '_create_order_from_blend_ticket_replay_impl_20261015')
       AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
    UNION ALL
    SELECT 'get_dispatch_board_jobs lost its authenticated grant or gained anon'
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                         AND p.proname = 'get_dispatch_board_jobs'
                         AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) chk;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'COST_DEFINER_LEAKS_POSTFLIGHT: %', v_bad;
  END IF;
END
$postflight$;
