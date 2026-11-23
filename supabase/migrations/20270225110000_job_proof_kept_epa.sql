-- 20270225110000_job_proof_kept_epa.sql
--
-- KI-195 (GitHub #2183): the "your field was sprayed" proof prints the EPA number the job kept.
--
-- WHY: a sprayed or finished job keeps each product's EPA number in job_product_epa (20261204120000,
--   live since 2026-11-07), but get_job_proof_data still returned products.epa_registration, so after a
--   catalog correction the proof would name a number the job was not sprayed under.
--
-- WHAT: CREATE OR REPLACE of get_job_proof_data(uuid, uuid), same signature, role gate, SECURITY DEFINER,
--   search_path and grants. Only the products block changes (the rest is copied unchanged from
--   20260630160000, whose body matched live on 2026-11-23):
--     epa_registration = the kept number when the job has a row for the product (NULL kept too), else
--                        _epa_norm(products.epa_registration);
--     epa_kept         = the job has a kept row for the product;
--     epa_not_recorded = that row is "Not recorded" (job sprayed before numbers were kept).
--   The app prints a kept NULL as "Unknown" and not_recorded as "Not recorded", never the catalog number.
--
-- Read-only (STABLE, no writes), so no idempotency key. The already-deployed app ignores the two new keys.
-- ROLLBACK: re-run the function body of 20260630160000 (CREATE OR REPLACE, same signature).

-- Preflight: the body being replaced is exactly the 20260630160000 one (source md5, CR stripped; live on
-- 2026-11-23) with its definer rights and search_path, so this file never overwrites a newer change; a
-- second apply stops here too.
DO $preflight$
BEGIN
  IF to_regprocedure('public.get_job_proof_data(uuid,uuid)') IS NULL
     OR NOT EXISTS (
          SELECT 1 FROM pg_proc p
           WHERE p.oid = to_regprocedure('public.get_job_proof_data(uuid,uuid)')
             AND md5(replace(p.prosrc, chr(13), '')) = 'e4ec151e7306b61962fd16251f47af76'
             AND p.prosecdef
             AND p.proowner = 'postgres'::regrole
             AND p.proconfig = ARRAY['search_path=public, extensions, pg_temp'])
     OR to_regclass('public.job_product_epa') IS NULL
     OR to_regprocedure('public._epa_norm(text)') IS NULL THEN
    RAISE EXCEPTION 'JOB_PROOF_KEPT_EPA_PREFLIGHT: get_job_proof_data is not the 20260630160000 body, or job_product_epa or _epa_norm is missing';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.get_job_proof_data(
  p_job_id      uuid,
  p_customer_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
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
  -- the job line's captured value, else the product master. The EPA number is the one the job
  -- kept (job_product_epa, 20261204120000), else the product's (KI-195).
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
      -- KI-195: the number the job kept for this product (NULL kept too), else the catalog's.
      'epa_registration', CASE WHEN k.job_id IS NULL THEN _epa_norm(p.epa_registration) ELSE k.epa_registration END,
      'epa_kept',         k.job_id IS NOT NULL,
      'epa_not_recorded', COALESCE(k.not_recorded, false),
      'sort_order',       jc.sort_order
    ) AS pr
    FROM job_chemicals jc
    JOIN products p ON p.id = jc.product_id
    LEFT JOIN job_product_epa k ON k.job_id = jc.job_id AND k.product_id = jc.product_id
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
$$;

-- caller-analysis: get_job_proof_data :: grants unchanged from 20260630160000; its only callers (FieldApplicationInvoice.tsx preview and per-recipient send) run as authenticated admin/sales_rep and keep EXECUTE
REVOKE EXECUTE ON FUNCTION public.get_job_proof_data(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_job_proof_data(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_job_proof_data(uuid, uuid) IS
  'Beyond-parity §6 (per-customer + applied acres): read-only gatherer for the "your field '
  'was sprayed" proof. p_customer_id scopes the returned fields to ONE billed customer '
  '(job_field_shares -> field_billing_defaults -> primary precedence) so a split-billed '
  'recipient never sees another customer''s field; NULL = whole job (office preview). '
  'Per-field acres = job_applied_record_fields.applied_acres (real sprayed acres) when '
  'present, else the field''s effective acres. Product EPA numbers are the ones the job kept '
  '(job_product_epa) with epa_kept / epa_not_recorded, else the product''s (KI-195, 20270225110000). '
  'STABLE; SECURITY DEFINER; admin/sales_rep only.';

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND proname = 'get_job_proof_data') <> 1 THEN
    RAISE EXCEPTION 'JOB_PROOF_KEPT_EPA_POSTFLIGHT: get_job_proof_data must have exactly one overload';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.get_job_proof_data(uuid,uuid)'::regprocedure AND prosecdef
                    AND proconfig = ARRAY['search_path=public, extensions, pg_temp'])
     OR has_function_privilege('anon', 'public.get_job_proof_data(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_job_proof_data(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'JOB_PROOF_KEPT_EPA_POSTFLIGHT: definer rights, search_path or grants are not as planned';
  END IF;
END $$;
