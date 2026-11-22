-- ============================================================================
-- 20270216110000_purchasing_plan_booking_reservations
-- Bookings Phase A follow-up, #1989 rebuilt (contract docs/plans/2026-11-21-booking-reservations-CONTRACT.md,
-- v4, approved by Mason 2026-11-21, "Yes, build it"; first build per product, "Per product").
--
-- WHY: the old #1989 design let crop-program hold rows claim PO stock, so the plan had to guess which
-- hold belonged to which booking line and PO (a new Sol HIGH in rounds 5-7 and on Nov 20). Here the
-- booking LINE is the reservation; the plan never reads a counted booking's or active job's own holds.
-- WHAT (get_purchasing_plan re-emitted; read-only; same signature, security, grants; JSON keys added):
--   1. Open bookings: sent, revised, accepted and not converted (#1990's rule kept), and a draft
--      Planned booking (Mason, 2026-11-21: counts exactly like a sent one). Quote deleted_at IS NULL.
--   2. One allocation per product gives both coverage and buying. Supply: shelf (max(on hand, 0), today),
--      then every open non-draft PO line's unreceived quantity by expected date, PO number, line (no
--      horizon limit; a past date counts today, flagged; an undated PO is late supply after every dated
--      one). Demand groups in rank order: shelf-only holds, stock deficit (max(-on hand, 0), today),
--      committed (orders, active jobs, manual holds, Firm lines), could add (Likely/unset), shown (Maybe).
--      Within a group, by need date: each need takes the latest supply arriving by its date, then the
--      earliest later supply (late), the rest is not covered (Mason, 2026-11-21: Firm always first).
--   3. Buying: suggested = the deficit and committed groups' not-covered parts in the horizon, dated at
--      their need dates; could_add = the could-add group's. Late cover never adds a buy (Mason,
--      2026-11-21: a late PO keeps its claim; reverses buying for a late PO, 20270127110000).
--   4. Shelf-only holds (a crop-program or job hold whose booking or job is not counted; never a manual
--      hold) take shelf stock only and never buy; the unbacked part is reported as hold_unbacked. A counted
--      booking's or active job's own holds are ignored entirely, with no exception (any product or line).
--   5. A booking line 14 or more days past its section need date is flagged overdue_followup.
--   6. Kept from #1989 head 30f880e70: the safe draw guess (least sure, latest first), the draw lists,
--      the timing-window fixes and the estimated flag (now also per product).
-- Undated and Check-units lines reserve nothing. The horizon filters what is shown and summed only.
-- ROLLBACK: re-run the get_purchasing_plan CREATE OR REPLACE from 20270129160000 (line 1138), then
--   DROP FUNCTION public._purchasing_allocate(jsonb, jsonb) (read-only functions; no data to restore).
--   If #1980 has shipped, hide its cover columns first.
-- ============================================================================

DO $preflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.get_purchasing_plan(integer)'))
     IS DISTINCT FROM 'c36fde7853b4bc1297d8fc70200a459d' THEN
    RAISE EXCEPTION 'PREFLIGHT_PLAN_DRIFT: get_purchasing_plan is not the released 20270129160000 body';
  END IF;
  IF to_regprocedure('public._purchasing_allocate(jsonb, jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_ALLOCATE_EXISTS: _purchasing_allocate already exists';
  END IF;
END;
$preflight$;

-- Pure allocation for one product. p_supply: entries in supply order {d (date, null = undated), q, shelf};
-- p_demand: entries in rank and need-date order {r (rank 1 = shelf-only holds), d, q}. Returns each demand
-- entry with on_time, late, nc (not covered) and aw (awards {k = 1-based supply index, q, late}).
CREATE FUNCTION public._purchasing_allocate(p_supply jsonb, p_demand jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path = public, pg_temp
AS $function$
DECLARE
  n int := COALESCE(jsonb_array_length(p_supply), 0);
  sd date[] := ARRAY[]::date[];
  sq numeric[] := ARRAY[]::numeric[];
  ss boolean[] := ARRAY[]::boolean[];
  i int; j int; a int; b int;
  dem jsonb; need date; rnk int; rem numeric; take numeric; ontime numeric; late numeric; aw jsonb;
  res jsonb := '[]'::jsonb;
BEGIN
  FOR i IN 1..n LOOP
    sd[i] := (p_supply->(i - 1)->>'d')::date;
    sq[i] := GREATEST(COALESCE((p_supply->(i - 1)->>'q')::numeric, 0), 0);
    -- Not real stock: a NaN or infinite quantity (NaN sorts above Infinity), or a supply dated +/- infinity.
    IF sq[i] >= 'Infinity'::numeric OR NOT COALESCE(isfinite(sd[i]), true) THEN sq[i] := 0; END IF;
    ss[i] := COALESCE((p_supply->(i - 1)->>'shelf')::boolean, false);
  END LOOP;
  FOR i IN 0..COALESCE(jsonb_array_length(p_demand), 0) - 1 LOOP
    dem := p_demand->i;
    need := (dem->>'d')::date; rnk := (dem->>'r')::int;
    rem := GREATEST(COALESCE((dem->>'q')::numeric, 0), 0); ontime := 0; late := 0; aw := '[]'::jsonb;
    IF rem >= 'Infinity'::numeric THEN
      NULL;  -- a NaN or infinite need takes no supply, so it cannot drain cover from the needs after it
    ELSIF rnk = 1 THEN
      -- Shelf-only holds take the shelf and nothing else.
      FOR j IN 1..n LOOP
        EXIT WHEN rem <= 0;
        CONTINUE WHEN NOT ss[j] OR sq[j] <= 0;
        take := LEAST(rem, sq[j]); sq[j] := sq[j] - take; rem := rem - take; ontime := ontime + take;
        aw := aw || jsonb_build_object('k', j, 'q', take, 'late', false);
      END LOOP;
    ELSIF need IS NOT NULL THEN
      -- On time: the latest date arriving by the need date first; within one date, supply order (shelf first).
      b := n;
      WHILE b >= 1 AND rem > 0 LOOP
        IF sd[b] IS NULL OR sd[b] > need THEN b := b - 1; CONTINUE; END IF;
        a := b;
        WHILE a > 1 AND sd[a - 1] = sd[b] LOOP a := a - 1; END LOOP;
        FOR j IN a..b LOOP
          EXIT WHEN rem <= 0;
          CONTINUE WHEN sq[j] <= 0;
          take := LEAST(rem, sq[j]); sq[j] := sq[j] - take; rem := rem - take; ontime := ontime + take;
          aw := aw || jsonb_build_object('k', j, 'q', take, 'late', false);
        END LOOP;
        b := a - 1;
      END LOOP;
      -- Late: the earliest later supply (undated last).
      FOR j IN 1..n LOOP
        EXIT WHEN rem <= 0;
        CONTINUE WHEN sq[j] <= 0 OR (sd[j] IS NOT NULL AND sd[j] <= need);
        take := LEAST(rem, sq[j]); sq[j] := sq[j] - take; rem := rem - take; late := late + take;
        aw := aw || jsonb_build_object('k', j, 'q', take, 'late', true);
      END LOOP;
    END IF;
    res := res || jsonb_build_array(dem || jsonb_build_object('on_time', ontime, 'late', late, 'nc', rem, 'aw', aw));
  END LOOP;
  RETURN res;
END;
$function$;

REVOKE ALL ON FUNCTION public._purchasing_allocate(jsonb, jsonb) FROM PUBLIC, anon, authenticated;

-- Read-only buy plan. Everything is in each product's stock unit. Today is the Chicago date.
-- STABLE: every statement reads the calling query's snapshot.
CREATE OR REPLACE FUNCTION public.get_purchasing_plan(p_months_ahead integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM profiles
     WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required' USING ERRCODE = '42501';
  END IF;

  RETURN (
  WITH
  prm AS (
    SELECT t.today, t.months,
           -- Impossible stored values are skipped and flagged (Mason, 2026-11-22): a date outside 2000-2099, or a
           -- quantity that is not a finite number. The row (or only its date) leaves the math and is listed in check_data.
           '2000-01-01'::date AS d_lo, '2099-12-31'::date AS d_hi,
           (date_trunc('month', t.today) + make_interval(months => t.months) - interval '1 day')::date AS horizon_end,
           COALESCE((SELECT CASE WHEN btrim(a.setting_value) ~ '^[0-9]{1,3}$' AND btrim(a.setting_value)::int <= 120
                                 THEN btrim(a.setting_value)::int END
                       FROM app_settings a WHERE a.setting_key = 'purchasing_lead_days'
                      ORDER BY a.updated_at DESC NULLS LAST LIMIT 1), 14) AS lead_days
      FROM (SELECT (now() AT TIME ZONE 'America/Chicago')::date AS today,
                   LEAST(GREATEST(COALESCE(p_months_ahead, 6), 1), 12) AS months) t
  ),
  -- Timing windows: a missing, invalid or impossible month-day falls back to that timing's default.
  win_json AS (
    SELECT CASE WHEN pg_input_is_valid(a.setting_value, 'jsonb') THEN a.setting_value::jsonb END AS j
      FROM app_settings a WHERE a.setting_key = 'booking_timing_windows'
     ORDER BY a.updated_at DESC NULLS LAST LIMIT 1
  ),
  -- A window is taken from settings only when both its start and end are valid (as the Quote Builder's
  -- parseTimingWindows does); otherwise both fall back to that timing's default.
  win AS (
    SELECT d.timing, d.dflt_start, d.dflt_end,
           bool_and(CASE WHEN x.v ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
                         THEN substr(x.v, 4, 2)::int
                              <= extract(day from make_date(2001, substr(x.v, 1, 2)::int, 1) + interval '1 month - 1 day')::int
                         ELSE false END) AS ok,
           max(x.v) FILTER (WHERE x.k = 'start') AS start_md,
           max(x.v) FILTER (WHERE x.k = 'end') AS end_md
      FROM (VALUES ('pre_plant', '03-01', '05-15'), ('in_season', '05-16', '07-15'), ('late_summer', '07-16', '09-15'))
             d(timing, dflt_start, dflt_end)
      CROSS JOIN (VALUES ('start'), ('end')) k(k)
      LEFT JOIN win_json w ON true
      CROSS JOIN LATERAL (
        SELECT k.k, CASE WHEN jsonb_typeof(w.j) = 'object' AND jsonb_typeof(w.j -> d.timing) = 'object'
                              AND jsonb_typeof(w.j -> d.timing -> k.k) = 'string'
                         THEN w.j -> d.timing ->> k.k END AS v
      ) x
     GROUP BY d.timing, d.dflt_start, d.dflt_end
  ),
  win_end AS (
    SELECT timing,
           CASE WHEN COALESCE(ok, false) THEN start_md ELSE dflt_start END AS start_md,
           CASE WHEN COALESCE(ok, false) THEN end_md ELSE dflt_end END AS end_md
      FROM win
  ),
  -- Bookings that still promise product: their lines are the reservation.
  eq AS (
    SELECT q.id, q.quote_number, q.customer_id
      FROM quotes q
     WHERE q.deleted_at IS NULL
       AND (q.status IN ('sent', 'revised')
            -- A draft Planned booking counts exactly like a sent one (Mason, 2026-11-21, decision 2).
            OR (q.status = 'draft' AND q.is_planned IS TRUE)
            -- #1990 Sol: a soft-deleted order no longer stands for the booking (as 20270128140000 counts it), unless
            -- product was drawn from the booking (a voided whole conversion keeps its draw: the booking stays converted).
            OR (q.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.quote_id = q.id
                  AND (o.deleted_at IS NULL OR EXISTS (SELECT 1 FROM quote_product_draws d WHERE d.quote_id = q.id AND d.quantity_drawn > 0
                                     AND d.quantity_drawn < 'Infinity'::numeric)))))
  ),
  bla AS (
    SELECT qi.id AS item_id, eq.id AS quote_id, qi.product_id, s.id AS section_id,
           -- An impossible date ('infinity', or outside 2000-2099) counts as no date (listed in check_data).
           CASE WHEN s.needed_by_date BETWEEN (SELECT d_lo FROM prm) AND (SELECT d_hi FROM prm) THEN s.needed_by_date END AS needed_by_date,
           s.timing, s.confidence, COALESCE(s.sort_order, 0) AS s_sort, COALESCE(qi.sort_order, 0) AS i_sort,
           GREATEST(COALESCE(qi.total_units_needed, 0), 0) AS qty,
           -- A line saved in a unit that no longer matches the stock unit is set aside (Mason, 2026-11-18):
           -- listed under Check units only; it absorbs no draw and covers no hold.
           NOT _unit_matches_stock_unit(qi.unit_size, COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)) AS unit_problem
      FROM eq
      JOIN quote_items qi ON qi.quote_id = eq.id
      JOIN products p ON p.id = qi.product_id
      LEFT JOIN quote_sections s ON s.id = qi.section_id
     WHERE qi.product_id IS NOT NULL AND abs(COALESCE(qi.total_units_needed, 0)) < 'Infinity'::numeric
  ),
  bl AS (
    SELECT * FROM bla WHERE NOT bla.unit_problem
  ),
  -- Active job lines, with the reservation engine's own quantity (20261107070000).
  jcl AS (
    SELECT jc.id AS line_id, jc.job_id, jc.product_id,
           -- An impossible job date counts as today, so the line is never bought late (listed in check_data).
           CASE WHEN j.job_date BETWEEN (SELECT d_lo FROM prm) AND (SELECT d_hi FROM prm) THEN j.job_date ELSE (SELECT today FROM prm) END AS job_date,
           j.quote_id, j.quote_section_id, j.customer_id,
           COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity) AS qty,
           (field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form) IS NULL
            AND NOT _unit_matches_stock_unit(jc.unit, COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size))) AS unit_problem
      FROM jobs j
      JOIN job_chemicals jc ON jc.job_id = j.id
      JOIN products p ON p.id = jc.product_id
     WHERE j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress')
       AND jc.customer_supplied IS NOT TRUE AND COALESCE(jc.quantity, 0) > 0 AND abs(jc.quantity) < 'Infinity'::numeric
  ),
  -- Draws. A job draw belongs to the job's section when that section is on the same booking;
  -- an order draw (quote_product_draws) never records a section. An active job whose line for
  -- the product cannot be converted (Check units, not counted) draws nothing here, so the
  -- booking's demand stays counted instead of vanishing into an uncounted job.
  -- An active job with a line of the product holding an impossible quantity (skipped, flagged): its draw counts
  -- only up to its valid lines of the product, so the booking never loses demand the job no longer carries.
  jd AS (
    SELECT x.quote_id, x.product_id, x.section_id,
           CASE WHEN x.cap IS NULL THEN x.q
                ELSE LEAST(x.q, GREATEST(0, x.cap - (SUM(x.q) OVER (PARTITION BY x.job_id, x.product_id
                                                                   ORDER BY x.id ROWS UNBOUNDED PRECEDING) - x.q))) END AS qty
      FROM (SELECT jpd.id, jpd.job_id, jpd.quote_id, jpd.product_id, s.id AS section_id,
                   COALESCE(jpd.quantity_drawn, 0) AS q,
                   CASE WHEN j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress')
                         AND EXISTS (SELECT 1 FROM job_chemicals jc WHERE jc.job_id = jpd.job_id AND jc.product_id = jpd.product_id
                                        AND jc.customer_supplied IS NOT TRUE
                                        AND NOT abs(COALESCE(jc.quantity, 0)) < 'Infinity'::numeric)
                        THEN COALESCE((SELECT SUM(jcl.qty) FROM jcl
                                        WHERE jcl.job_id = jpd.job_id AND jcl.product_id = jpd.product_id), 0) END AS cap
              FROM job_product_draws jpd
              JOIN eq ON eq.id = jpd.quote_id
              JOIN jobs j ON j.id = jpd.job_id
              LEFT JOIN quote_sections s ON s.id = j.quote_section_id AND s.quote_id = jpd.quote_id
             WHERE NOT EXISTS (SELECT 1 FROM jcl WHERE jcl.job_id = jpd.job_id AND jcl.product_id = jpd.product_id AND jcl.unit_problem)
               AND abs(COALESCE(jpd.quantity_drawn, 0)) < 'Infinity'::numeric) x
  ),
  alld AS (
    SELECT qpd.quote_id, qpd.product_id, NULL::uuid AS section_id, COALESCE(qpd.quantity_drawn, 0) AS qty
      FROM quote_product_draws qpd JOIN eq ON eq.id = qpd.quote_id
     WHERE abs(COALESCE(qpd.quantity_drawn, 0)) < 'Infinity'::numeric
    UNION ALL
    SELECT quote_id, product_id, section_id, qty FROM jd
  ),
  dt AS (
    SELECT quote_id, product_id, SUM(qty) AS total,
           COALESCE(SUM(qty) FILTER (WHERE section_id IS NULL), 0) AS unknown
      FROM alld GROUP BY quote_id, product_id
  ),
  kd AS (
    SELECT quote_id, product_id, section_id, SUM(qty) AS drawn
      FROM jd WHERE section_id IS NOT NULL GROUP BY quote_id, product_id, section_id
  ),
  -- Step 1: a job draw comes off its own section first.
  s1 AS (
    SELECT bl.*,
           bl.qty - LEAST(bl.qty, GREATEST(0, COALESCE(kd.drawn, 0)
             - (SUM(bl.qty) OVER (PARTITION BY bl.quote_id, bl.product_id, bl.section_id
                                  ORDER BY bl.i_sort, bl.item_id ROWS UNBOUNDED PRECEDING) - bl.qty))) AS rem1
      FROM bl
      LEFT JOIN kd ON kd.quote_id = bl.quote_id AND kd.product_id = bl.product_id AND kd.section_id = bl.section_id
  ),
  ap1 AS (
    SELECT quote_id, product_id, SUM(qty - rem1) AS applied, SUM(qty) AS booked FROM s1 GROUP BY quote_id, product_id
  ),
  -- Step 2: every other draw (order draws, and job draws beyond their section) comes off the
  -- LATEST-needed lines first. Totals stay exact and needs can only move earlier, so the plan
  -- never buys short or late while the real section of an order draw is unknown (Phase B records it).
  -- Undated lines come off last, so a Firm line with no date stays on the needs-a-date list.
  -- Less sure lines come off before surer ones (Maybe, then Likely or unset, then Firm), so an
  -- unknown draw never erases Firm demand while a Maybe line of the same product stays.
  s2a AS (
    SELECT s1.*, GREATEST(COALESCE(dt.total, 0) - COALESCE(ap1.applied, 0), 0) AS pool
      FROM s1
      LEFT JOIN dt ON dt.quote_id = s1.quote_id AND dt.product_id = s1.product_id
      LEFT JOIN ap1 ON ap1.quote_id = s1.quote_id AND ap1.product_id = s1.product_id
  ),
  s2 AS (
    SELECT s2a.*,
           s2a.rem1 - LEAST(s2a.rem1, GREATEST(0, s2a.pool
             - (SUM(s2a.rem1) OVER (PARTITION BY s2a.quote_id, s2a.product_id
                                    ORDER BY CASE s2a.confidence WHEN 'maybe' THEN 0 WHEN 'firm' THEN 2 ELSE 1 END,
                                             s2a.needed_by_date DESC NULLS LAST, s2a.s_sort DESC, s2a.i_sort DESC, s2a.item_id DESC
                                    ROWS UNBOUNDED PRECEDING) - s2a.rem1))) AS rem
      FROM s2a
  ),
  -- Over-drawn: drawn beyond every line of the product, set-aside lines included (a draw against a line
  -- set aside for its unit is not over-drawn: that line is listed under Check units until it is fixed).
  bkall AS (SELECT quote_id, product_id, SUM(qty) AS booked FROM bla GROUP BY quote_id, product_id),
  overdrawn AS (
    SELECT dt.quote_id, dt.product_id, dt.total - COALESCE(bk.booked, 0) AS qty
      FROM dt LEFT JOIN bkall bk ON bk.quote_id = dt.quote_id AND bk.product_id = dt.product_id
     WHERE dt.total > COALESCE(bk.booked, 0)
  ),
  onhand AS (
    SELECT i.product_id, SUM(COALESCE(i.quantity_available, 0)) AS qty
      FROM inventory i WHERE i.location = 'Main Warehouse'
       AND abs(COALESCE(i.quantity_available, 0)) < 'Infinity'::numeric  -- not real stock: NaN or +/- infinity
     GROUP BY i.product_id
  ),
  -- Live holds. An expired hold reserves nothing (as in the inventory position, 20261204100000).
  -- 'manual': committed, today. 'ignored': a crop-program hold whose booking is counted and has a line of the
  -- product (any line: zero, set aside or drawn), or a job hold whose active job has a line of the product;
  -- the booking or job line is the reservation, so its hold rows are never read. 'shelf': every other hold
  -- (booking or job gone, closed, converted, or without a line of the product): shelf stock only.
  hraw AS (
    SELECT ih.id AS hold_id, ih.product_id, ih.quantity, ih.customer_id, ih.hold_type,
           CASE WHEN ih.hold_type = 'manual' THEN 'manual'
                WHEN ih.hold_type = 'crop_program'
                 AND EXISTS (SELECT 1 FROM eq WHERE eq.id = ih.source_id)
                  THEN 'ignored'  -- a counted booking's own holds, with no exception: its lines are the reservation
                WHEN ih.hold_type = 'job'
                 AND EXISTS (SELECT 1 FROM jobs j
                              WHERE j.id = ih.source_id AND j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress'))
                  THEN 'ignored'  -- an active job's own holds: its lines are the reservation
                ELSE 'shelf'
           END AS hold_use
      FROM inventory_holds ih
     WHERE ih.is_active = true AND ih.quantity > 0 AND ih.quantity < 'Infinity'::numeric  -- (also excludes NaN)
       -- An impossible expiry (outside 2000-2099) counts as no expiry, so the hold is never dropped (flagged).
       AND (ih.expires_at IS NULL OR ih.expires_at >= (SELECT today FROM prm)
            OR NOT ih.expires_at BETWEEN (SELECT d_lo FROM prm) AND (SELECT d_hi FROM prm))
       AND ih.hold_type IN ('manual', 'crop_program', 'job')
  ),
  po AS (
    SELECT poi.product_id, poi.id AS line_id, p.id AS po_id, p.po_number, p.status, p.expected_delivery_date AS raw_date,
           poi.quantity_ordered - COALESCE(poi.quantity_received, 0) AS qty,
           CASE WHEN p.status = 'draft' THEN 'draft'
                WHEN p.expected_delivery_date IS NULL THEN 'undated'
                WHEN p.expected_delivery_date < prm.today THEN 'late'
                ELSE 'counted' END AS flag,
           GREATEST(p.expected_delivery_date, prm.today) AS eff_date
      FROM purchase_order_items poi
      JOIN purchase_orders p ON p.id = poi.purchase_order_id
      CROSS JOIN prm
     WHERE p.status IN ('draft', 'submitted', 'partially_received') AND poi.product_id IS NOT NULL
       AND poi.quantity_ordered - COALESCE(poi.quantity_received, 0) > 0
       AND poi.quantity_ordered - COALESCE(poi.quantity_received, 0) < 'Infinity'::numeric  -- (also excludes NaN)
       -- An impossible date (+/- infinity, or outside 2000-2099): the PO is not counted (listed in check_data).
       AND (p.expected_delivery_date IS NULL OR p.expected_delivery_date BETWEEN prm.d_lo AND prm.d_hi)
  ),
  -- Records holding an impossible value (see prm), skipped above and listed in check_data.
  bad AS (
    SELECT qi.product_id, 'booking_line'::text AS kind, qi.id
      FROM eq JOIN quote_items qi ON qi.quote_id = eq.id LEFT JOIN quote_sections s ON s.id = qi.section_id CROSS JOIN prm
     WHERE qi.product_id IS NOT NULL
       AND (NOT abs(COALESCE(qi.total_units_needed, 0)) < 'Infinity'::numeric OR NOT s.needed_by_date BETWEEN prm.d_lo AND prm.d_hi)
    UNION ALL
    SELECT jc.product_id, 'job_line', jc.id
      FROM jobs j JOIN job_chemicals jc ON jc.job_id = j.id CROSS JOIN prm
     WHERE j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress') AND jc.customer_supplied IS NOT TRUE
       AND jc.product_id IS NOT NULL
       AND (NOT abs(COALESCE(jc.quantity, 0)) < 'Infinity'::numeric OR NOT j.job_date BETWEEN prm.d_lo AND prm.d_hi)
    UNION ALL
    SELECT qpd.product_id, 'draw', qpd.id FROM quote_product_draws qpd JOIN eq ON eq.id = qpd.quote_id
     WHERE NOT abs(COALESCE(qpd.quantity_drawn, 0)) < 'Infinity'::numeric
    UNION ALL
    SELECT jpd.product_id, 'draw', jpd.id FROM job_product_draws jpd JOIN eq ON eq.id = jpd.quote_id
     WHERE NOT abs(COALESCE(jpd.quantity_drawn, 0)) < 'Infinity'::numeric
    UNION ALL
    SELECT i.product_id, 'stock', i.id FROM inventory i
     WHERE i.location = 'Main Warehouse' AND NOT abs(COALESCE(i.quantity_available, 0)) < 'Infinity'::numeric
    UNION ALL
    SELECT ih.product_id, 'hold', ih.id FROM inventory_holds ih
     WHERE ih.is_active = true AND ih.hold_type IN ('manual', 'crop_program', 'job')
       AND (NOT ih.expires_at BETWEEN (SELECT d_lo FROM prm) AND (SELECT d_hi FROM prm)
            OR NOT abs(COALESCE(ih.quantity, 0)) < 'Infinity'::numeric)
    UNION ALL
    SELECT poi.product_id, 'po_line', poi.id
      FROM purchase_order_items poi JOIN purchase_orders p ON p.id = poi.purchase_order_id CROSS JOIN prm
     WHERE p.status IN ('draft', 'submitted', 'partially_received') AND poi.product_id IS NOT NULL
       AND (NOT abs(poi.quantity_ordered - COALESCE(poi.quantity_received, 0)) < 'Infinity'::numeric
            OR NOT p.expected_delivery_date BETWEEN prm.d_lo AND prm.d_hi)
    UNION ALL
    SELECT oi.product_id, 'order_line', oi.id FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.deleted_at IS NULL AND o.status IN ('confirmed', 'partially_fulfilled') AND oi.product_id IS NOT NULL
       AND NOT abs(COALESCE(oi.quantity_remaining, 0)) < 'Infinity'::numeric
    UNION ALL
    SELECT oi.product_id, 'delivery', d.id
      FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id
      JOIN order_items oi ON oi.id = di.order_item_id JOIN orders o ON o.id = oi.order_id CROSS JOIN prm
     WHERE o.deleted_at IS NULL AND o.status IN ('confirmed', 'partially_fulfilled') AND oi.product_id IS NOT NULL
       AND d.deleted_at IS NULL AND d.status IN ('scheduled', 'in_progress')
       AND (NOT d.scheduled_date BETWEEN prm.d_lo AND prm.d_hi OR NOT abs(COALESCE(di.quantity, 0)) < 'Infinity'::numeric)
  ),
  -- Every demand row, in stock units. A counted booking line (after draws) is its own reservation.
  dem AS (
    SELECT s2.product_id, 'booking'::text AS kind,
           CASE s2.confidence WHEN 'firm' THEN 'committed' WHEN 'maybe' THEN 'shown' ELSE 'could_add' END AS cls,
           s2.needed_by_date AS raw_date, s2.rem AS qty, s2.quote_id, NULL::uuid AS order_id, NULL::uuid AS job_id,
           s2.section_id, s2.confidence, (s2.rem < s2.rem1) AS estimated, false AS unit_problem,
           (SELECT eq.customer_id FROM eq WHERE eq.id = s2.quote_id) AS customer_id,
           (s2.needed_by_date IS NOT NULL AND (SELECT today FROM prm) - 14 >= s2.needed_by_date) AS followup,
           s2.item_id AS src_id  -- the source row's id: the last tie-breaker wherever rows are listed
      FROM s2 WHERE s2.rem > 0
    UNION ALL
    -- Set-aside lines (unit does not match stock): Check units, in full; they reserve nothing.
    SELECT bla.product_id, 'booking',
           CASE bla.confidence WHEN 'firm' THEN 'committed' WHEN 'maybe' THEN 'shown' ELSE 'could_add' END,
           bla.needed_by_date, bla.qty, bla.quote_id, NULL::uuid, NULL::uuid,
           bla.section_id, bla.confidence, false, true,
           (SELECT eq.customer_id FROM eq WHERE eq.id = bla.quote_id),
           (bla.needed_by_date IS NOT NULL AND (SELECT today FROM prm) - 14 >= bla.needed_by_date), bla.item_id
      FROM bla WHERE bla.unit_problem AND bla.qty > 0
    UNION ALL
    -- Open orders: dated by the earliest scheduled, undelivered delivery of the line only when the
    -- scheduled deliveries cover all of what remains; otherwise today, so the plan never buys late.
    SELECT oi.product_id, 'order', 'committed',
           COALESCE((SELECT MIN(d.scheduled_date)
                       FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id
                      WHERE di.order_item_id = oi.id AND d.deleted_at IS NULL
                        AND d.status IN ('scheduled', 'in_progress')
                        -- a delivery with an impossible date or quantity is left out (flagged); the rest still date the order
                        AND d.scheduled_date BETWEEN (SELECT d_lo FROM prm) AND (SELECT d_hi FROM prm)
                        AND abs(COALESCE(di.quantity, 0)) < 'Infinity'::numeric
                     HAVING SUM(COALESCE(di.quantity, 0)) >= oi.quantity_remaining),
                    (SELECT today FROM prm)),
           oi.quantity_remaining, o.quote_id, o.id, NULL::uuid, NULL::uuid, NULL::text, false, false, o.customer_id, false, oi.id
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.deleted_at IS NULL AND o.status IN ('confirmed', 'partially_fulfilled')
       AND oi.product_id IS NOT NULL AND oi.quantity_remaining > 0 AND oi.quantity_remaining < 'Infinity'::numeric
    UNION ALL
    -- Active jobs (a line that cannot be converted goes to Check units and reserves nothing).
    SELECT x.product_id, 'job', 'committed', x.job_date, x.qty, x.quote_id, NULL::uuid, x.job_id,
           x.quote_section_id, NULL::text, false, x.unit_problem, x.customer_id, false, x.line_id
      FROM jcl x WHERE x.qty > 0 AND x.qty < 'Infinity'::numeric
    UNION ALL
    -- Manual holds: committed today. Shelf-only holds: shelf stock only (class shelf_hold), never bought for.
    SELECT h.product_id, 'hold', CASE h.hold_use WHEN 'manual' THEN 'committed' ELSE 'shelf_hold' END,
           (SELECT today FROM prm), h.quantity, NULL::uuid, NULL::uuid, NULL::uuid,
           NULL::uuid, NULL::text, false, false, h.customer_id, false, h.hold_id
      FROM hraw h WHERE h.hold_use IN ('manual', 'shelf')
    UNION ALL
    -- Negative on hand: a committed stock deficit today (the shelf counts as 0).
    SELECT oh.product_id, 'deficit', 'committed', (SELECT today FROM prm), -oh.qty, NULL::uuid, NULL::uuid, NULL::uuid,
           NULL::uuid, NULL::text, false, false, NULL::uuid, false, NULL::uuid
      FROM onhand oh WHERE oh.qty < 0
  ),
  demb AS (
    SELECT dem.*,
           CASE WHEN dem.unit_problem THEN 'check_units'
                WHEN dem.raw_date IS NULL THEN 'needs_date'
                WHEN dem.raw_date > prm.horizon_end THEN 'later'
                ELSE 'dated' END AS bucket,
           GREATEST(dem.raw_date, prm.today) AS need_date,
           (dem.raw_date < prm.today) AS overdue,
           CASE WHEN dem.cls = 'shelf_hold' THEN 1 WHEN dem.kind = 'deficit' THEN 2 WHEN dem.cls = 'committed' THEN 3
                WHEN dem.cls = 'could_add' THEN 4 ELSE 5 END AS rnk
      FROM dem CROSS JOIN prm
  ),
  prod AS (
    SELECT p.id AS product_id, p.product_name, p.sku, p.container_size, p.unit_size,
           COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size) AS stock_unit,
           COALESCE(oh.qty, 0) AS on_hand
      FROM products p LEFT JOIN onhand oh ON oh.product_id = p.id
     WHERE EXISTS (SELECT 1 FROM demb WHERE demb.product_id = p.id)
        OR EXISTS (SELECT 1 FROM po WHERE po.product_id = p.id)
        OR EXISTS (SELECT 1 FROM overdrawn WHERE overdrawn.product_id = p.id)
        OR EXISTS (SELECT 1 FROM bad WHERE bad.product_id = p.id)
        OR COALESCE(oh.qty, 0) < 0
  ),
  -- Supply in order: shelf (today), then PO lines by date, PO number, line; undated POs last.
  sup AS (
    SELECT x.product_id,
           jsonb_agg(jsonb_build_object('d', x.d, 'q', x.qty, 'shelf', x.shelf, 'po_id', x.po_id, 'po_number', x.po_number,
                                        'expected_date', x.raw_date, 'po_overdue', x.po_overdue, 'po_undated', x.po_undated)
                     ORDER BY x.d NULLS LAST, x.shelf DESC, x.po_number, x.po_id, x.line_id) AS s
      FROM (
        SELECT oh.product_id, (SELECT today FROM prm) AS d, oh.qty, true AS shelf, NULL::uuid AS po_id, NULL::text AS po_number,
               NULL::uuid AS line_id, NULL::date AS raw_date, false AS po_overdue, false AS po_undated
          FROM onhand oh WHERE oh.qty > 0
        UNION ALL
        SELECT po.product_id, CASE WHEN po.raw_date IS NOT NULL THEN po.eff_date END, po.qty, false, po.po_id, po.po_number,
               po.line_id, po.raw_date, po.flag = 'late', po.flag = 'undated'
          FROM po WHERE po.flag <> 'draft'
      ) x
     GROUP BY x.product_id
  ),
  -- Demand in rank order, then need date (one entry per rank and date). Undated and Check-units rows reserve
  -- nothing. Rows past the horizon still take their supply: the horizon only filters what is shown.
  dbk AS (
    SELECT g.product_id, jsonb_agg(jsonb_build_object('r', g.rnk, 'd', g.need_date, 'q', g.qty) ORDER BY g.rnk, g.need_date) AS b
      FROM (SELECT product_id, rnk, need_date, SUM(qty) AS qty FROM demb
             WHERE bucket IN ('dated', 'later') AND qty > 0 GROUP BY product_id, rnk, need_date) g
     GROUP BY g.product_id
  ),
  alloc AS (
    SELECT prod.product_id, COALESCE(sup.s, '[]'::jsonb) AS s,
           _purchasing_allocate(COALESCE(sup.s, '[]'::jsonb), COALESCE(dbk.b, '[]'::jsonb)) AS a
      FROM prod LEFT JOIN sup ON sup.product_id = prod.product_id LEFT JOIN dbk ON dbk.product_id = prod.product_id
  ),
  -- Allocation results inside the horizon.
  ab AS (
    SELECT al.product_id, (e->>'r')::int AS rnk, (e->>'d')::date AS d, (e->>'q')::numeric AS q,
           (e->>'on_time')::numeric AS on_time, (e->>'late')::numeric AS late, (e->>'nc')::numeric AS nc, e->'aw' AS aw, al.s
      FROM alloc al CROSS JOIN LATERAL jsonb_array_elements(al.a) e CROSS JOIN prm
     WHERE (e->>'d')::date <= prm.horizon_end
  ),
  awd AS (
    SELECT ab.product_id, ab.rnk, (w->>'q')::numeric AS q, (w->>'late')::boolean AS late, ab.s->((w->>'k')::int - 1) AS src
      FROM ab CROSS JOIN LATERAL jsonb_array_elements(ab.aw) w
  ),
  grp AS (
    SELECT ab.product_id, ab.rnk,
           (ARRAY['shelf_hold', 'deficit', 'committed', 'could_add', 'shown'])[ab.rnk] AS name,
           SUM(ab.q) AS booked, SUM(ab.on_time) AS on_time, SUM(ab.late) AS late, SUM(ab.nc) AS not_covered
      FROM ab GROUP BY ab.product_id, ab.rnk
  ),
  -- Buying: the deficit's and committed group's not-covered parts, at their need dates (late cover never buys).
  sugg AS (
    SELECT product_id, d, SUM(nc) AS qty FROM ab WHERE rnk IN (2, 3) AND nc > 0 GROUP BY product_id, d
  ),
  totals AS (
    SELECT product_id,
           COALESCE(SUM(nc) FILTER (WHERE rnk IN (2, 3)), 0) AS suggested,
           COALESCE(SUM(nc) FILTER (WHERE rnk = 4), 0) AS could_add,
           COALESCE(SUM(nc) FILTER (WHERE rnk = 1), 0) AS hold_unbacked,
           COALESCE(bool_or(late > 0) FILTER (WHERE rnk > 1), false) AS has_late_cover
      FROM ab GROUP BY product_id
  ),
  reasons AS (
    SELECT prod.product_id, array_remove(ARRAY[
             -- A Firm line with no date (as the Firm-needs-a-date list).
             CASE WHEN EXISTS (SELECT 1 FROM s2 WHERE s2.product_id = prod.product_id AND s2.rem > 0 AND s2.confidence = 'firm' AND s2.needed_by_date IS NULL) THEN 'needs_date' END,
             CASE WHEN EXISTS (SELECT 1 FROM demb WHERE demb.product_id = prod.product_id AND demb.cls = 'committed' AND demb.bucket = 'check_units') THEN 'check_units' END,
             CASE WHEN EXISTS (SELECT 1 FROM demb WHERE demb.product_id = prod.product_id AND demb.cls = 'committed' AND demb.bucket = 'later') THEN 'later' END,
             CASE WHEN EXISTS (SELECT 1 FROM overdrawn WHERE overdrawn.product_id = prod.product_id) THEN 'over_drawn' END,
             CASE WHEN EXISTS (SELECT 1 FROM po WHERE po.product_id = prod.product_id AND po.flag = 'late') THEN 'late_po' END,
             CASE WHEN EXISTS (SELECT 1 FROM po WHERE po.product_id = prod.product_id AND po.flag = 'undated') THEN 'undated_po' END,
             CASE WHEN EXISTS (SELECT 1 FROM bad WHERE bad.product_id = prod.product_id) THEN 'check_data' END
           ], NULL) AS list
      FROM prod
  ),
  months AS (
    SELECT prod.product_id, gs.m::date AS m FROM prod
     CROSS JOIN prm
     CROSS JOIN LATERAL generate_series(date_trunc('month', prm.today), date_trunc('month', prm.horizon_end), interval '1 month') gs(m)
  ),
  -- Review list: a section with a needed-by date (A-R2) and something still to deliver, from 14 days
  -- before the end of its timing window (in the needed-by date's year; the next year when the window crosses
  -- New Year and the date is on or after its start), or of its needed-by date when untimed.
  rev AS (
    SELECT s2.quote_id, s2.section_id, s2.timing, s2.confidence, s2.needed_by_date,
           CASE WHEN we.end_md IS NOT NULL
                THEN make_date(extract(year FROM s2.needed_by_date)::int
                                 -- (date parts, not to_char, so any finite date works; no year 0 or past the date range)
                                 + CASE WHEN we.end_md COLLATE "C" < we.start_md COLLATE "C"
                                         AND extract(month FROM s2.needed_by_date) * 100 + extract(day FROM s2.needed_by_date)
                                             >= substr(we.start_md, 1, 2)::int * 100 + substr(we.start_md, 4, 2)::int
                                         AND extract(year FROM s2.needed_by_date) BETWEEN 1 AND 5874896
                                        THEN 1 ELSE 0 END,
                               substr(we.end_md, 1, 2)::int, substr(we.end_md, 4, 2)::int)
                ELSE s2.needed_by_date END AS window_end,
           jsonb_agg(jsonb_build_object('product_id', s2.product_id, 'product_name', p.product_name, 'quantity', s2.rem)
                     ORDER BY p.product_name, s2.product_id, s2.item_id) AS products
      FROM s2
      JOIN products p ON p.id = s2.product_id
      LEFT JOIN win_end we ON we.timing = s2.timing
     WHERE s2.rem > 0 AND s2.needed_by_date IS NOT NULL AND s2.section_id IS NOT NULL
     GROUP BY s2.quote_id, s2.section_id, s2.timing, s2.confidence, s2.needed_by_date, we.end_md, we.start_md
  )
  SELECT jsonb_build_object(
    'today', prm.today,
    'horizon_end', prm.horizon_end,
    'months_ahead', prm.months,
    'lead_days', prm.lead_days,
    -- Every undated Firm booking line, a set-aside (Check units) one included.
    'firm_needs_date', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'quote_id', demb.quote_id, 'quote_number', eq.quote_number, 'customer_name', c.farm_name,
               'section_name', qs.section_name, 'product_id', demb.product_id, 'product_name', p.product_name,
               'quantity', demb.qty) ORDER BY c.farm_name, eq.quote_number, qs.section_name, p.product_name, demb.qty, demb.src_id)
        FROM demb
        JOIN eq ON eq.id = demb.quote_id
        LEFT JOIN customers c ON c.id = eq.customer_id
        LEFT JOIN quote_sections qs ON qs.id = demb.section_id
        JOIN products p ON p.id = demb.product_id
       WHERE demb.kind = 'booking' AND demb.confidence = 'firm' AND demb.raw_date IS NULL AND demb.qty > 0), '[]'::jsonb),
    -- Records holding an impossible value, left out of the math until someone fixes them.
    'check_data', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('kind', b.kind, 'id', b.id, 'product_id', b.product_id, 'product_name', p.product_name)
                       ORDER BY p.product_name, b.product_id, b.kind, b.id)
        FROM (SELECT DISTINCT product_id, kind, id FROM bad) b LEFT JOIN products p ON p.id = b.product_id), '[]'::jsonb),
    'drawn_section_unknown', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'quote_id', dt.quote_id, 'quote_number', eq.quote_number, 'customer_name', c.farm_name,
               'product_id', dt.product_id, 'product_name', p.product_name, 'quantity', dt.total - COALESCE(ap1.applied, 0))
               ORDER BY eq.quote_number, p.product_name, dt.quote_id, dt.product_id)
        FROM dt JOIN eq ON eq.id = dt.quote_id
        -- Every draw not taken off its own job's section: an order's, and a job's beyond its section (Sol on #1989).
        LEFT JOIN ap1 ON ap1.quote_id = dt.quote_id AND ap1.product_id = dt.product_id
        LEFT JOIN customers c ON c.id = eq.customer_id
        JOIN products p ON p.id = dt.product_id
       WHERE dt.total - COALESCE(ap1.applied, 0) > 0), '[]'::jsonb),
    'review', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'quote_id', rev.quote_id, 'quote_number', eq.quote_number, 'customer_name', c.farm_name,
               'section_id', rev.section_id, 'section_name', qs.section_name, 'timing', rev.timing,
               'confidence', rev.confidence, 'needed_by_date', rev.needed_by_date, 'window_end', rev.window_end,
               'products', rev.products) ORDER BY rev.window_end, eq.quote_number, qs.section_name, rev.quote_id, rev.section_id)
        FROM rev JOIN eq ON eq.id = rev.quote_id
        LEFT JOIN customers c ON c.id = eq.customer_id
        LEFT JOIN quote_sections qs ON qs.id = rev.section_id
       WHERE prm.today >= rev.window_end - 14), '[]'::jsonb),
    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'product_id', prod.product_id, 'product_name', prod.product_name, 'sku', prod.sku,
               'stock_unit', prod.stock_unit, 'container_size', prod.container_size, 'unit_size', prod.unit_size,
               'on_hand', prod.on_hand,
               'incoming', COALESCE((SELECT SUM(po.qty) FROM po WHERE po.product_id = prod.product_id AND po.flag <> 'draft'), 0),
               'drafted', COALESCE((SELECT SUM(po.qty) FROM po WHERE po.product_id = prod.product_id AND po.flag = 'draft'), 0),
               'committed', COALESCE((SELECT SUM(demb.qty) FROM demb WHERE demb.product_id = prod.product_id AND demb.cls = 'committed' AND demb.bucket = 'dated'), 0),
               'suggested', COALESCE(t.suggested, 0),
               'could_add', COALESCE(t.could_add, 0),
               'hold_unbacked', COALESCE(t.hold_unbacked, 0),
               'over_drawn', COALESCE((SELECT SUM(od.qty) FROM overdrawn od WHERE od.product_id = prod.product_id), 0),
               'not_complete', cardinality(r.list) > 0,
               'reasons', to_jsonb(r.list),
               'has_late_cover', COALESCE(t.has_late_cover, false),
               'has_followup', EXISTS (SELECT 1 FROM demb WHERE demb.product_id = prod.product_id AND demb.followup),
               'estimated', EXISTS (SELECT 1 FROM s2 WHERE s2.product_id = prod.product_id AND s2.rem < s2.rem1),  -- from s2: a line the guess used up has no row left
               -- Coverage per demand group (horizon only): on time + late + not covered = booked.
               'coverage', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'group', g.name, 'booked', g.booked, 'on_time', g.on_time, 'late', g.late, 'not_covered', g.not_covered,
                          'from_shelf', COALESCE((SELECT SUM(w.q) FROM awd w WHERE w.product_id = g.product_id AND w.rnk = g.rnk
                                                     AND (w.src->>'shelf')::boolean), 0),
                          'pos', COALESCE((
                            SELECT jsonb_agg(jsonb_build_object(
                                     'po_id', x.po_id, 'po_number', x.po_number, 'qty', x.q, 'expected_date', x.expected_date,
                                     'late', x.late, 'po_overdue', x.po_overdue, 'po_undated', x.po_undated)
                                     ORDER BY x.expected_date NULLS LAST, x.po_number, x.po_id, x.late)
                              FROM (SELECT (w.src->>'po_id')::uuid AS po_id, w.src->>'po_number' AS po_number,
                                           (w.src->>'expected_date')::date AS expected_date, w.late,
                                           (w.src->>'po_overdue')::boolean AS po_overdue, (w.src->>'po_undated')::boolean AS po_undated,
                                           SUM(w.q) AS q
                                      FROM awd w
                                     WHERE w.product_id = g.product_id AND w.rnk = g.rnk AND NOT (w.src->>'shelf')::boolean
                                     GROUP BY 1, 2, 3, 4, 5, 6) x), '[]'::jsonb))
                          ORDER BY g.rnk)
                   FROM grp g WHERE g.product_id = prod.product_id), '[]'::jsonb),
               'suggestions', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'need_date', sg.d,
                          'order_by', GREATEST(sg.d - prm.lead_days, prm.today),
                          'order_now', sg.d - prm.lead_days <= prm.today,
                          'quantity', sg.qty)
                          ORDER BY sg.d)
                   FROM sugg sg WHERE sg.product_id = prod.product_id), '[]'::jsonb),
               'months', (
                 SELECT jsonb_agg(jsonb_build_object(
                          'month', mo.m,
                          'committed', COALESCE((SELECT SUM(qty) FROM demb WHERE demb.product_id = mo.product_id AND demb.bucket = 'dated' AND demb.cls = 'committed' AND date_trunc('month', demb.need_date) = mo.m), 0),
                          'could_add', COALESCE((SELECT SUM(qty) FROM demb WHERE demb.product_id = mo.product_id AND demb.bucket = 'dated' AND demb.cls = 'could_add' AND date_trunc('month', demb.need_date) = mo.m), 0),
                          'maybe', COALESCE((SELECT SUM(qty) FROM demb WHERE demb.product_id = mo.product_id AND demb.bucket = 'dated' AND demb.cls = 'shown' AND date_trunc('month', demb.need_date) = mo.m), 0),
                          'incoming', COALESCE((SELECT SUM(qty) FROM po WHERE po.product_id = mo.product_id AND po.flag IN ('counted', 'late')
                                             AND po.eff_date >= mo.m AND po.eff_date < (mo.m + interval '1 month')::date), 0))  -- date-only: a year-300000 PO is valid but past the timestamp range
                          ORDER BY mo.m)
                   FROM months mo WHERE mo.product_id = prod.product_id),
               'rows', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'kind', demb.kind, 'class', demb.cls, 'bucket', demb.bucket,
                          'need_date', CASE WHEN demb.bucket = 'needs_date' OR (demb.kind = 'booking' AND demb.raw_date IS NULL)
                                            THEN NULL ELSE demb.need_date END,
                          'raw_date', demb.raw_date, 'overdue', COALESCE(demb.overdue, false),
                          'overdue_followup', demb.followup,
                          'quantity', demb.qty, 'confidence', demb.confidence, 'estimated', demb.estimated,
                          'quote_id', demb.quote_id, 'quote_number', q.quote_number,
                          'order_id', demb.order_id, 'order_number', o.order_number,
                          'job_id', demb.job_id, 'job_number', j.job_number,
                          'customer_name', c.farm_name, 'section_name', qs.section_name)
                          ORDER BY demb.raw_date NULLS FIRST, demb.kind, c.farm_name, demb.qty, demb.quote_id, demb.order_id, demb.job_id, demb.section_id, demb.src_id)
                   FROM demb
                   LEFT JOIN quotes q ON q.id = demb.quote_id
                   LEFT JOIN orders o ON o.id = demb.order_id
                   LEFT JOIN jobs j ON j.id = demb.job_id
                   LEFT JOIN customers c ON c.id = demb.customer_id
                   LEFT JOIN quote_sections qs ON qs.id = demb.section_id
                  WHERE demb.product_id = prod.product_id), '[]'::jsonb),
               'purchase_orders', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'po_id', po.po_id, 'po_number', po.po_number, 'status', po.status,
                          'expected_date', po.raw_date, 'flag', po.flag, 'quantity', po.qty)
                          ORDER BY po.raw_date NULLS LAST, po.po_number, po.po_id, po.line_id)
                   FROM po WHERE po.product_id = prod.product_id), '[]'::jsonb))
             ORDER BY (cardinality(r.list) > 0 OR COALESCE(t.suggested, 0) > 0) DESC, prod.product_name, prod.product_id)
        FROM prod
        LEFT JOIN totals t ON t.product_id = prod.product_id
        LEFT JOIN reasons r ON r.product_id = prod.product_id), '[]'::jsonb)
  )
  FROM prm
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_purchasing_plan(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_purchasing_plan(integer) TO authenticated;

DO $postflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
      WHERE p.oid = 'public.get_purchasing_plan(integer)'::regprocedure)
     IS DISTINCT FROM 'c1684a7ac1bb9d380f7b4e0e957f92fa' THEN
    RAISE EXCEPTION 'POSTFLIGHT_PLAN: get_purchasing_plan did not install';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid = 'public.get_purchasing_plan(integer)'::regprocedure
        AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SECURITY: security definer or search_path is not as written';
  END IF;
  IF has_function_privilege('anon', 'public.get_purchasing_plan(integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_purchasing_plan(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANTS: get_purchasing_plan must run for authenticated only';
  END IF;
  IF has_function_privilege('anon', 'public._purchasing_allocate(jsonb, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._purchasing_allocate(jsonb, jsonb)', 'EXECUTE')
     OR (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public._purchasing_allocate(jsonb, jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTFLIGHT_ALLOCATE: _purchasing_allocate must be invoker-rights and not callable by clients';
  END IF;
END;
$postflight$;
