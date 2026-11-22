-- ============================================================================
-- 20270206130000_purchasing_plan_held_stock_never_free
-- Bookings Phase A follow-up (contract docs/plans/2026-11-18-purchasing-held-stock-CONTRACT.md).
--
-- WHY: get_purchasing_plan (20270127110000; re-created with #1990's order fix by 20270129160000) dropped a crop-program hold whose booking books
-- the product and then counted that booking's Maybe lines as shown only, so stock held for a
-- Planned Maybe booking read as free (Sol round 2 HIGH on #1980). Mason, 2026-11-18: held stock
-- always counts as spoken for, but a booking's hold never makes the plan buy on its own.
-- WHAT (get_purchasing_plan re-emitted; read-only; same signature, security, grants, JSON keys):
--   1. Such a hold is backed by stock on the shelf (on hand less the holds still counted as
--      before); the backed part covers the booking's lines (earliest need first, Firm first) and
--      is listed as a committed hold row dated today; the rest of each line is unchanged.
--   2. The Firm-needs-a-date list reads the lines before that split (a held undated Firm line stays).
--   3. Timing windows (#1977 MEDs): a window comes from settings only when both its start and end
--      are valid month-days, else both fall back to the default (as the Quote Builder does); a
--      window whose end is before its start ends in the next year for a needed-by date on or
--      after its start.
--   4. A hold still counted as before (manual, or a crop-program hold not covering its booking's own
--      line, e.g. a draft booking's) counts today only up to the stock on the shelf (manual holds
--      first); the rest of a crop-program hold counts at its booking's need date (its expiry less
--      14 days, as _sync_planned_holds sets it), so it never makes the plan "order now" by itself
--      (Mason, 2026-11-18, "I agree cap it").
--   5. Draws keep 110000's rule: a draw that is not a job's own section comes off the least-sure,
--      latest-needed lines first, so it never erases Firm demand (Mason, 2026-11-19, after Sol
--      round 5 on #1989: the safe guess, over matching each order to its line).
--   6. The part of a hold not yet on the shelf takes incoming purchase-order stock first, on each
--      PO's date, as the hold does when the stock is received; only the rest of a PO is free for
--      other demand (Mason, 2026-11-19, after Sol round 5 on #1989; kept by Mason 2026-11-21).
--      Rebuild after the Nov 20 Sol review: a hold claims only stock arriving by its own expiry
--      (earliest-expiring first); a Maybe, Likely, unset or undated line's claimed part keeps its own
--      class and date and only reserves the PO stock; a hold whose booking or job is gone, closed or
--      converted, or beside a line set aside for its unit, reserves shelf stock only (never buys or
--      claims a PO); a job hold on a line with a unit problem still reserves its shelf stock.
--   7. Built on #1990's body (20270129160000): its soft-deleted-order rule for accepted bookings is kept.
--   8. A draw against a line set aside for its unit is not over-drawn; the Drawn-section-unknown list
--      includes a job's draw beyond its own section; held rows keep the line's estimated flag.
-- ROLLBACK: re-run the get_purchasing_plan CREATE OR REPLACE from 20270129160000 (line 1138)
--   (read-only function; no data to restore).
-- ============================================================================

DO $preflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.get_purchasing_plan(integer)'))
     IS DISTINCT FROM 'c36fde7853b4bc1297d8fc70200a459d' THEN
    RAISE EXCEPTION 'PREFLIGHT_PLAN_DRIFT: get_purchasing_plan is not the released 20270129160000 body';
  END IF;
END;
$preflight$;

-- Read-only buy plan (bookings Phase A; contract section 2 with the v4 amendments and plan v2/v3 Phase A).
-- Everything is in each product's stock unit. Today is the Chicago date. One SQL statement, one snapshot.
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
  -- Rule 1: bookings that still promise product.
  eq AS (
    SELECT q.id, q.quote_number, q.customer_id
      FROM quotes q
     WHERE q.deleted_at IS NULL
       AND (q.status IN ('sent', 'revised')
            -- #1990 Sol: a soft-deleted order no longer stands for the booking (as 20270128140000 counts it), unless
            -- product was drawn from the booking (a voided whole conversion keeps its draw: the booking stays converted).
            OR (q.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.quote_id = q.id
                  AND (o.deleted_at IS NULL OR EXISTS (SELECT 1 FROM quote_product_draws d WHERE d.quote_id = q.id AND d.quantity_drawn > 0)))))
  ),
  bla AS (
    SELECT qi.id AS item_id, eq.id AS quote_id, qi.product_id, s.id AS section_id,
           -- A non-finite date ('infinity') counts as no date, so one bad section cannot fail the plan.
           CASE WHEN isfinite(s.needed_by_date) THEN s.needed_by_date END AS needed_by_date,
           s.timing, s.confidence, COALESCE(s.sort_order, 0) AS s_sort, COALESCE(qi.sort_order, 0) AS i_sort,
           GREATEST(COALESCE(qi.total_units_needed, 0), 0) AS qty,
           -- A line saved in a unit that no longer matches the stock unit is set aside (Mason, 2026-11-18):
           -- listed under Check units only; it absorbs no draw and covers no hold.
           NOT _unit_matches_stock_unit(qi.unit_size, COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)) AS unit_problem
      FROM eq
      JOIN quote_items qi ON qi.quote_id = eq.id
      JOIN products p ON p.id = qi.product_id
      LEFT JOIN quote_sections s ON s.id = qi.section_id
     WHERE qi.product_id IS NOT NULL
  ),
  bl AS (
    SELECT * FROM bla WHERE NOT bla.unit_problem
  ),
  -- Active job lines, with the reservation engine's own quantity (20261107070000).
  jcl AS (
    SELECT jc.id AS line_id, jc.job_id, jc.product_id, j.job_date, j.quote_id, j.quote_section_id, j.customer_id,
           COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity) AS qty,
           (field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form) IS NULL
            AND NOT _unit_matches_stock_unit(jc.unit, COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size))) AS unit_problem
      FROM jobs j
      JOIN job_chemicals jc ON jc.job_id = j.id
      JOIN products p ON p.id = jc.product_id
     WHERE j.deleted_at IS NULL AND j.status IN ('scheduled', 'in_progress')
       AND jc.customer_supplied IS NOT TRUE AND COALESCE(jc.quantity, 0) > 0
  ),
  -- Draws. A job draw belongs to the job's section when that section is on the same booking;
  -- an order draw (quote_product_draws) never records a section. An active job whose line for
  -- the product cannot be converted (Check units, not counted) draws nothing here, so the
  -- booking's demand stays counted instead of vanishing into an uncounted job.
  jd AS (
    SELECT jpd.quote_id, jpd.product_id, s.id AS section_id, COALESCE(jpd.quantity_drawn, 0) AS qty
      FROM job_product_draws jpd
      JOIN eq ON eq.id = jpd.quote_id
      JOIN jobs j ON j.id = jpd.job_id
      LEFT JOIN quote_sections s ON s.id = j.quote_section_id AND s.quote_id = jpd.quote_id
     WHERE NOT EXISTS (SELECT 1 FROM jcl WHERE jcl.job_id = jpd.job_id AND jcl.product_id = jpd.product_id AND jcl.unit_problem)
  ),
  alld AS (
    SELECT qpd.quote_id, qpd.product_id, NULL::uuid AS section_id, COALESCE(qpd.quantity_drawn, 0) AS qty
      FROM quote_product_draws qpd JOIN eq ON eq.id = qpd.quote_id
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
      FROM inventory i WHERE i.location = 'Main Warehouse' GROUP BY i.product_id
  ),
  -- Live holds. An expired hold reserves nothing (as in the inventory position, 20261204100000).
  -- 'covered': its own source's counted lines of the product are its demand (a crop-program hold
  --   whose booking counts a line of the product and has no set-aside line of it, or a job hold whose
  --   active job has a convertible line of the product and none that cannot be converted). Not
  --   counted again; its stock is set aside below.
  -- 'now': a manual hold, or a draft Planned booking's hold on a product the booking books, every
  --   line in the stock unit (the hold stands in for that booking's demand until it is sent).
  -- 'shelf': every other hold (its booking or job gone, closed, converted or no longer booking the
  --   product, or beside a line set aside for its unit). It reserves stock already on the shelf only:
  --   it never claims a PO and never makes the plan buy (Sol on #1989, 2026-11-20). Integrity
  --   Cleanup lists the stale program holds.
  hraw AS (
    SELECT ih.id AS hold_id, ih.product_id, ih.quantity, ih.source_id, ih.customer_id, ih.hold_type, ih.expires_at,
           CASE WHEN ih.hold_type = 'crop_program'
                 AND EXISTS (SELECT 1 FROM bl WHERE bl.quote_id = ih.source_id AND bl.product_id = ih.product_id AND bl.qty > 0)
                 AND NOT EXISTS (SELECT 1 FROM bla WHERE bla.quote_id = ih.source_id AND bla.product_id = ih.product_id
                                                     AND bla.unit_problem AND bla.qty > 0)
                  THEN 'covered'
                WHEN ih.hold_type = 'job'
                 AND EXISTS (SELECT 1 FROM jcl WHERE jcl.job_id = ih.source_id AND jcl.product_id = ih.product_id AND NOT jcl.unit_problem)
                 AND NOT EXISTS (SELECT 1 FROM jcl WHERE jcl.job_id = ih.source_id AND jcl.product_id = ih.product_id AND jcl.unit_problem)
                  THEN 'covered'
                WHEN ih.hold_type = 'manual' THEN 'now'
                WHEN ih.hold_type = 'crop_program'
                 AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = ih.source_id AND q.deleted_at IS NULL
                                AND q.is_planned AND q.status = 'draft')
                 AND EXISTS (SELECT 1 FROM quote_items qi WHERE qi.quote_id = ih.source_id AND qi.product_id = ih.product_id
                                AND COALESCE(qi.total_units_needed, 0) > 0)
                 AND NOT EXISTS (SELECT 1 FROM quote_items qi JOIN products p ON p.id = qi.product_id
                                  WHERE qi.quote_id = ih.source_id AND qi.product_id = ih.product_id
                                    AND NOT _unit_matches_stock_unit(qi.unit_size, COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)))
                  THEN 'now'
                ELSE 'shelf'
           END AS hold_use
      FROM inventory_holds ih
     WHERE ih.is_active = true AND ih.quantity > 0 AND ih.quantity < 'Infinity'::numeric  -- (also excludes NaN)
       AND (ih.expires_at IS NULL OR ih.expires_at >= (SELECT today FROM prm))
       AND ih.hold_type IN ('manual', 'crop_program', 'job')
  ),
  hcov AS (
    SELECT hold_type, source_id, product_id, SUM(quantity) AS held
      FROM hraw WHERE hold_use = 'covered' GROUP BY hold_type, source_id, product_id
  ),
  -- Holds that count now take the shelf first (manual, then a draft booking's by need date, then
  -- shelf-only holds), but only up to the stock on it (Mason, 2026-11-18, "I agree cap it"): the rest
  -- of a draft booking's hold falls to its need date (the hold sync sets the expiry date = need date
  -- + 14 days), as it would once the booking is sent. A manual hold and an infinite expiry stay today.
  hnow0 AS (
    SELECT h.*,
           CASE WHEN h.hold_use = 'now' AND h.hold_type = 'crop_program' AND isfinite(h.expires_at)
                     AND h.expires_at > (SELECT today FROM prm)
                THEN GREATEST((SELECT today FROM prm), h.expires_at - 14)
                ELSE (SELECT today FROM prm) END AS rest_date
      FROM hraw h WHERE h.hold_use IN ('now', 'shelf')
  ),
  hnow AS (
    SELECT h.*,
           LEAST(h.quantity, GREATEST(0, COALESCE(oh.qty, 0) - (SUM(h.quantity) OVER w - h.quantity))) AS on_shelf,
           ROW_NUMBER() OVER w AS ord
      FROM hnow0 h LEFT JOIN onhand oh ON oh.product_id = h.product_id
    WINDOW w AS (PARTITION BY h.product_id
                 ORDER BY CASE WHEN h.hold_use = 'shelf' THEN 2 WHEN h.hold_type = 'manual' THEN 0 ELSE 1 END,
                          h.rest_date, h.source_id, h.hold_id
                 ROWS UNBOUNDED PRECEDING)
  ),
  -- Held stock never reads as free, but a hold never makes the plan buy on its own (Mason, 2026-11-18):
  -- covered holds are backed only by the stock on the shelf left after the holds above.
  hback AS (
    SELECT c.product_id,
           LEAST(c.held, GREATEST(COALESCE((SELECT oh.qty FROM onhand oh WHERE oh.product_id = c.product_id), 0)
                                  - COALESCE((SELECT SUM(h.on_shelf) FROM hnow h WHERE h.product_id = c.product_id), 0),
                                  0)) AS qty
      FROM (SELECT product_id, SUM(held) AS held FROM hcov GROUP BY product_id) c
  ),
  -- The lines a covered hold is for: its booking's counted lines, or its job's lines. rnk: Firm and
  -- job lines first, then Likely or unset, then Maybe, so stock held for a booking backs its surest
  -- demand and a Maybe line never leaves a Firm one to buy. A hold larger than its lines (a stale
  -- or fully drawn line) keeps the rest as a last line of its own, so no held stock is lost.
  hcl0 AS (
    SELECT 'crop_program'::text AS hold_type, s2.quote_id AS source_id, s2.product_id, s2.item_id AS line_id,
           CASE s2.confidence WHEN 'firm' THEN 0 WHEN 'maybe' THEN 2 ELSE 1 END AS rnk,
           s2.needed_by_date AS d, s2.s_sort, s2.section_id AS sec, s2.i_sort, s2.rem AS qty
      FROM s2 WHERE s2.rem > 0
    UNION ALL
    SELECT 'job', x.job_id, x.product_id, x.line_id, 0, x.job_date, 0, NULL::uuid, 0, x.qty
      FROM jcl x WHERE NOT x.unit_problem AND x.qty > 0
  ),
  hsum AS (
    SELECT hold_type, source_id, product_id, SUM(qty) AS qty FROM hcl0 GROUP BY hold_type, source_id, product_id
  ),
  hcl AS (
    SELECT l.* FROM hcl0 l
      JOIN hcov c ON c.hold_type = l.hold_type AND c.source_id = l.source_id AND c.product_id = l.product_id
    UNION ALL
    SELECT c.hold_type, c.source_id, c.product_id, NULL::uuid, 3, NULL::date, 0, NULL::uuid, 0, c.held - COALESCE(s.qty, 0)
      FROM hcov c
      LEFT JOIN hsum s ON s.hold_type = c.hold_type AND s.source_id = c.source_id AND s.product_id = c.product_id
     WHERE c.held > COALESCE(s.qty, 0)
  ),
  -- Each line takes at most its quantity and its own hold's remainder, then at most the product's
  -- backed stock remainder, in one order (rnk, need date with undated last, source, section, line).
  hl1 AS (
    SELECT hcl.*,
           LEAST(hcl.qty, GREATEST(0, c.held - (SUM(hcl.qty) OVER wq - hcl.qty))) AS h1
      FROM hcl JOIN hcov c ON c.hold_type = hcl.hold_type AND c.source_id = hcl.source_id AND c.product_id = hcl.product_id
    WINDOW wq AS (PARTITION BY hcl.hold_type, hcl.source_id, hcl.product_id
                  ORDER BY hcl.rnk, hcl.d NULLS LAST, hcl.s_sort, hcl.sec, hcl.i_sort, hcl.line_id
                  ROWS UNBOUNDED PRECEDING)
  ),
  hl AS (
    SELECT hl1.hold_type, hl1.source_id, hl1.product_id, hl1.line_id, hl1.h1,
           hl1.rnk, hl1.d, hl1.s_sort, hl1.sec, hl1.i_sort,
           LEAST(hl1.h1, GREATEST(0, hb.qty - (SUM(hl1.h1) OVER wp - hl1.h1))) AS held
      FROM hl1 JOIN hback hb ON hb.product_id = hl1.product_id
    WINDOW wp AS (PARTITION BY hl1.product_id
                  ORDER BY hl1.rnk, hl1.d NULLS LAST, hl1.hold_type, hl1.source_id, hl1.s_sort, hl1.sec, hl1.i_sort, hl1.line_id
                  ROWS UNBOUNDED PRECEDING)
  ),
  po AS (
    SELECT poi.product_id, p.id AS po_id, p.po_number, p.status, p.expected_delivery_date AS raw_date,
           poi.quantity_ordered - COALESCE(poi.quantity_received, 0) AS qty,
           CASE WHEN p.status = 'draft' THEN 'draft'
                WHEN p.expected_delivery_date IS NULL THEN 'undated'
                WHEN p.expected_delivery_date > prm.horizon_end THEN 'later'
                WHEN p.expected_delivery_date < prm.today THEN 'late'
                ELSE 'counted' END AS flag,
           GREATEST(p.expected_delivery_date, prm.today) AS eff_date
      FROM purchase_order_items poi
      JOIN purchase_orders p ON p.id = poi.purchase_order_id
      CROSS JOIN prm
     WHERE p.status IN ('draft', 'submitted', 'partially_received') AND poi.product_id IS NOT NULL
       AND poi.quantity_ordered - COALESCE(poi.quantity_received, 0) > 0
  ),
  -- Rule 6: the part of each hold not on the shelf takes incoming PO stock first, as the hold does
  -- on receipt (Mason, 2026-11-19, after Sol round 5 on #1989), but only stock arriving on or before
  -- the hold's own expiry (Sol on #1989, 2026-11-20): a later PO stays free for other demand.
  -- A covered group's shelf part goes to its earliest-expiring holds; each hold may claim only up to
  -- its share of the group's lines still to back (the part beyond its lines claims nothing).
  hgrp AS (
    SELECT hold_type, source_id, product_id, SUM(held) AS shelf,
           COALESCE(SUM(h1 - held) FILTER (WHERE line_id IS NOT NULL), 0) AS line_un
      FROM hl GROUP BY hold_type, source_id, product_id
  ),
  hcovh AS (
    SELECT h.hold_id, h.product_id, h.expires_at,
           GREATEST(0, LEAST(SUM(h.quantity) OVER w, g.shelf + g.line_un)
                       - GREATEST(SUM(h.quantity) OVER w - h.quantity, g.shelf)) AS un
      FROM hraw h
      JOIN hgrp g ON g.hold_type = h.hold_type AND g.source_id = h.source_id AND g.product_id = h.product_id
     WHERE h.hold_use = 'covered'
    WINDOW w AS (PARTITION BY h.hold_type, h.source_id, h.product_id
                 ORDER BY h.expires_at NULLS LAST, h.hold_id ROWS UNBOUNDED PRECEDING)
  ),
  cl0 AS (
    SELECT h.product_id, h.hold_id, 'now'::text AS src, h.expires_at, 0 AS grp, h.ord, h.quantity - h.on_shelf AS un
      FROM hnow h WHERE h.hold_use = 'now' AND h.quantity > h.on_shelf
    UNION ALL
    SELECT c.product_id, c.hold_id, 'covered', c.expires_at, 1, 0, c.un FROM hcovh c WHERE c.un > 0
  ),
  -- Earliest-expiring holds claim first. cap = the incoming stock arriving by the hold's expiry; caps
  -- only grow in this order, so the claimed total through each hold is min over k (cap_k + U - U_k).
  cl1 AS (
    SELECT cl0.*,
           SUM(cl0.un) OVER w AS u,
           COALESCE((SELECT SUM(po.qty) FROM po
                      WHERE po.product_id = cl0.product_id AND po.flag IN ('counted', 'late')
                        AND (cl0.expires_at IS NULL OR po.eff_date <= cl0.expires_at)), 0) AS cap
      FROM cl0
    WINDOW w AS (PARTITION BY cl0.product_id ORDER BY cl0.expires_at NULLS LAST, cl0.grp, cl0.ord, cl0.hold_id
                 ROWS UNBOUNDED PRECEDING)
  ),
  cl2 AS (
    SELECT cl1.*,
           cl1.u + LEAST(0, MIN(cl1.cap - cl1.u) OVER w) AS t
      FROM cl1
    WINDOW w AS (PARTITION BY cl1.product_id ORDER BY cl1.expires_at NULLS LAST, cl1.grp, cl1.ord, cl1.hold_id
                 ROWS UNBOUNDED PRECEDING)
  ),
  clc AS (
    SELECT cl2.*,
           COALESCE(LAG(cl2.t) OVER (PARTITION BY cl2.product_id
                                     ORDER BY cl2.expires_at NULLS LAST, cl2.grp, cl2.ord, cl2.hold_id), 0) AS a
      FROM cl2
  ),
  poc AS (
    SELECT po.product_id, po.eff_date, po.qty,
           SUM(po.qty) OVER (PARTITION BY po.product_id ORDER BY po.eff_date, po.po_id, po.qty ROWS UNBOUNDED PRECEDING) - po.qty AS b
      FROM po WHERE po.flag IN ('counted', 'late')
  ),
  -- Each hold's claim, split by the PO dates it takes.
  clm AS (
    SELECT c.product_id, c.hold_id, c.src, p.eff_date AS d,
           LEAST(c.t, p.b + p.qty) - GREATEST(c.a, p.b) AS q
      FROM clc c JOIN poc p ON p.product_id = c.product_id
     WHERE c.t > c.a AND LEAST(c.t, p.b + p.qty) > GREATEST(c.a, p.b)
  ),
  -- A covered group's claims go to its lines still to back, PO dates in order, in the lines' own order.
  gseg AS (
    SELECT h.hold_type, h.source_id, m.product_id, m.d, m.q,
           SUM(m.q) OVER w - m.q AS gb
      FROM clm m JOIN hraw h ON h.hold_id = m.hold_id
     WHERE m.src = 'covered'
    WINDOW w AS (PARTITION BY h.hold_type, h.source_id, m.product_id ORDER BY m.d, m.hold_id ROWS UNBOUNDED PRECEDING)
  ),
  lun AS (
    SELECT hl.hold_type, hl.source_id, hl.product_id, hl.line_id, hl.h1 - hl.held AS un,
           SUM(hl.h1 - hl.held) OVER w - (hl.h1 - hl.held) AS la
      FROM hl WHERE hl.line_id IS NOT NULL AND hl.h1 > hl.held
    WINDOW w AS (PARTITION BY hl.hold_type, hl.source_id, hl.product_id
                 ORDER BY hl.rnk, hl.d NULLS LAST, hl.s_sort, hl.sec, hl.i_sort, hl.line_id
                 ROWS UNBOUNDED PRECEDING)
  ),
  lcl AS (
    SELECT l.hold_type, l.line_id, l.product_id, g.d,
           LEAST(l.la + l.un, g.gb + g.q) - GREATEST(l.la, g.gb) AS q
      FROM lun l
      JOIN gseg g ON g.hold_type = l.hold_type AND g.source_id = l.source_id AND g.product_id = l.product_id
     WHERE LEAST(l.la + l.un, g.gb + g.q) > GREATEST(l.la, g.gb)
  ),
  clt AS (SELECT hold_type, line_id, SUM(q) AS q FROM lcl GROUP BY hold_type, line_id),
  nclt AS (SELECT hold_id, SUM(q) AS q FROM clm WHERE src = 'now' GROUP BY hold_id),
  -- A claimed part of a dated Firm line or a job line is committed on its PO's date, or on its own
  -- earlier date, so a late PO never makes a need look timely. Any other line's claimed part (Maybe,
  -- Likely or unset, or undated) keeps the line's own class and date and only reserves its PO stock:
  -- it is left out of the buying walk, and that PO stock is taken out of supply (Sol on #1989).
  lclr AS (
    SELECT lcl.product_id, lcl.d, lcl.q, lcl.hold_type, lcl.line_id,
           (lcl.hold_type = 'crop_program' AND (s2.confidence IS DISTINCT FROM 'firm' OR s2.needed_by_date IS NULL)) AS reserved
      FROM lcl LEFT JOIN s2 ON lcl.hold_type = 'crop_program' AND s2.item_id = lcl.line_id
  ),
  -- Each counted booking line, split into its held part (hq), its part claiming incoming stock, and the rest (qty_left).
  s3 AS (
    SELECT s2.*, COALESCE(hl.held, 0) AS hq, s2.rem - COALESCE(hl.held, 0) - COALESCE(t.q, 0) AS qty_left
      FROM s2 LEFT JOIN hl ON hl.hold_type = 'crop_program' AND hl.line_id = s2.item_id
      LEFT JOIN clt t ON t.hold_type = 'crop_program' AND t.line_id = s2.item_id
  ),
  -- Each active job line, split the same way.
  jcl2 AS (
    SELECT x.*, COALESCE(hl.held, 0) AS hq, x.qty - COALESCE(hl.held, 0) - COALESCE(t.q, 0) AS qty_left
      FROM jcl x LEFT JOIN hl ON hl.hold_type = 'job' AND hl.line_id = x.line_id
      LEFT JOIN clt t ON t.hold_type = 'job' AND t.line_id = x.line_id
  ),
  -- Every demand row, in stock units. reserved: shown, but left out of the buying walk (its PO stock is reserved).
  dem AS (
    SELECT s3.product_id, 'booking'::text AS kind,
           CASE s3.confidence WHEN 'firm' THEN 'committed' WHEN 'maybe' THEN 'shown' ELSE 'could_add' END AS cls,
           s3.needed_by_date AS raw_date, s3.qty_left AS qty, s3.quote_id, NULL::uuid AS order_id, NULL::uuid AS job_id,
           s3.section_id, s3.confidence, (s3.rem < s3.rem1) AS estimated, s3.unit_problem,
           (SELECT eq.customer_id FROM eq WHERE eq.id = s3.quote_id) AS customer_id, false AS reserved
      FROM s3 WHERE s3.qty_left > 0
    UNION ALL
    -- Held stock: on the shelf and already spoken for, so committed today. A booking line's held part
    -- keeps its booking, section, confidence and estimate; a job line's its job; a hold's rest beyond its lines its source.
    SELECT s3.product_id, 'hold', 'committed', (SELECT today FROM prm), s3.hq, s3.quote_id, NULL::uuid, NULL::uuid,
           s3.section_id, s3.confidence, (s3.rem < s3.rem1), false,
           (SELECT eq.customer_id FROM eq WHERE eq.id = s3.quote_id), false
      FROM s3 WHERE s3.hq > 0
    UNION ALL
    SELECT x.product_id, 'hold', 'committed', (SELECT today FROM prm), x.hq, x.quote_id, NULL::uuid, x.job_id,
           x.quote_section_id, NULL::text, false, false, x.customer_id, false
      FROM jcl2 x WHERE x.hq > 0
    UNION ALL
    SELECT hl.product_id, 'hold', 'committed', (SELECT today FROM prm), hl.held,
           CASE WHEN hl.hold_type = 'crop_program' THEN hl.source_id END, NULL::uuid,
           CASE WHEN hl.hold_type = 'job' THEN hl.source_id END,
           NULL::uuid, NULL::text, false, false,
           CASE WHEN hl.hold_type = 'crop_program' THEN (SELECT eq.customer_id FROM eq WHERE eq.id = hl.source_id)
                ELSE (SELECT j.customer_id FROM jobs j WHERE j.id = hl.source_id) END, false
      FROM hl WHERE hl.line_id IS NULL AND hl.held > 0
    UNION ALL
    -- Set-aside lines (unit does not match stock): Check units, in full.
    SELECT bla.product_id, 'booking',
           CASE bla.confidence WHEN 'firm' THEN 'committed' WHEN 'maybe' THEN 'shown' ELSE 'could_add' END,
           bla.needed_by_date, bla.qty, bla.quote_id, NULL::uuid, NULL::uuid,
           bla.section_id, bla.confidence, false, true,
           (SELECT eq.customer_id FROM eq WHERE eq.id = bla.quote_id), false
      FROM bla WHERE bla.unit_problem AND bla.qty > 0
    UNION ALL
    -- Open orders: dated by the earliest scheduled, undelivered delivery of the line only when the
    -- scheduled deliveries cover all of what remains; otherwise today, so the plan never buys late.
    SELECT oi.product_id, 'order', 'committed',
           COALESCE((SELECT MIN(d.scheduled_date)
                       FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id
                      WHERE di.order_item_id = oi.id AND d.deleted_at IS NULL
                        AND d.status IN ('scheduled', 'in_progress') AND d.scheduled_date IS NOT NULL
                     HAVING SUM(COALESCE(di.quantity, 0)) >= oi.quantity_remaining),
                    (SELECT today FROM prm)),
           oi.quantity_remaining, o.quote_id, o.id, NULL::uuid, NULL::uuid, NULL::text, false, false, o.customer_id, false
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.deleted_at IS NULL AND o.status IN ('confirmed', 'partially_fulfilled')
       AND oi.product_id IS NOT NULL AND oi.quantity_remaining > 0
    UNION ALL
    -- Active jobs (jcl), less any held part listed above.
    SELECT x.product_id, 'job', 'committed', x.job_date, x.qty_left, x.quote_id, NULL::uuid, x.job_id,
           x.quote_section_id, NULL::text, false, x.unit_problem, x.customer_id, false
      FROM jcl2 x WHERE x.qty_left > 0
    UNION ALL
    -- Holds that count now, and shelf-only holds: the part on the shelf today.
    SELECT h.product_id, 'hold', 'committed', (SELECT today FROM prm), h.on_shelf, NULL::uuid, NULL::uuid, NULL::uuid,
           NULL::uuid, NULL::text, false, false, h.customer_id, false
      FROM hnow h WHERE h.on_shelf > 0
    UNION ALL
    -- The rest of a hold that counts now (never a shelf-only hold's), by its date.
    SELECT h.product_id, 'hold', 'committed', h.rest_date, h.quantity - h.on_shelf - COALESCE(t.q, 0),
           NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, false, false, h.customer_id, false
      FROM hnow h LEFT JOIN nclt t ON t.hold_id = h.hold_id
     WHERE h.hold_use = 'now' AND h.quantity - h.on_shelf - COALESCE(t.q, 0) > 0
    UNION ALL
    -- Rule 6: a hold that counts now, its part claiming incoming stock, committed on its PO's date or its own earlier date.
    SELECT h.product_id, 'hold', 'committed', LEAST(m.d, h.rest_date), m.q,
           NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, false, false, h.customer_id, false
      FROM clm m JOIN hnow h ON h.hold_id = m.hold_id
     WHERE m.src = 'now'
    UNION ALL
    -- Rule 6: a covered line's part claiming incoming stock (see lclr).
    SELECT r.product_id, 'hold',
           CASE WHEN r.hold_type = 'job' THEN 'committed'
                ELSE CASE s2.confidence WHEN 'firm' THEN 'committed' WHEN 'maybe' THEN 'shown' ELSE 'could_add' END END,
           CASE WHEN r.reserved THEN s2.needed_by_date ELSE LEAST(r.d, s2.needed_by_date, x.job_date) END, r.q,
           COALESCE(s2.quote_id, x.quote_id), NULL::uuid, x.job_id,
           COALESCE(s2.section_id, x.quote_section_id), s2.confidence, COALESCE(s2.rem < s2.rem1, false), false,
           COALESCE((SELECT eq.customer_id FROM eq WHERE eq.id = s2.quote_id), x.customer_id), r.reserved
      FROM lclr r
      LEFT JOIN s2 ON r.hold_type = 'crop_program' AND s2.item_id = r.line_id
      LEFT JOIN jcl x ON r.hold_type = 'job' AND x.line_id = r.line_id
  ),
  demb AS (
    SELECT dem.*,
           CASE WHEN dem.unit_problem THEN 'check_units'
                WHEN dem.raw_date IS NULL THEN 'needs_date'
                WHEN dem.raw_date > prm.horizon_end THEN 'later'
                ELSE 'dated' END AS bucket,
           GREATEST(dem.raw_date, prm.today) AS need_date,
           (dem.raw_date < prm.today) AS overdue
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
        OR COALESCE(oh.qty, 0) < 0
  ),
  -- Rule 5: per product and date, supply before demand, starting at on hand.
  ev AS (
    SELECT product_id, need_date AS d,
           COALESCE(SUM(qty) FILTER (WHERE cls = 'committed'), 0) AS dc,
           COALESCE(SUM(qty) FILTER (WHERE cls IN ('committed', 'could_add')), 0) AS da,
           0::numeric AS s
      FROM demb WHERE bucket = 'dated' AND NOT reserved GROUP BY product_id, need_date
    UNION ALL
    SELECT product_id, eff_date, 0, 0, SUM(qty) FROM po WHERE flag IN ('counted', 'late') GROUP BY product_id, eff_date
    UNION ALL
    -- PO stock reserved by a held line that is not in the walk (lclr) is not supply for anyone else.
    SELECT product_id, d, 0, 0, -SUM(q) FROM lclr WHERE reserved GROUP BY product_id, d
    UNION ALL
    SELECT product_id, (SELECT today FROM prm), 0, 0, 0 FROM prod
  ),
  evd AS (SELECT product_id, d, SUM(dc) AS dc, SUM(da) AS da, SUM(s) AS s FROM ev GROUP BY product_id, d),
  walk AS (
    SELECT evd.*,
           prod.on_hand + SUM(evd.s - evd.dc) OVER w AS bal_c,
           prod.on_hand + SUM(evd.s - evd.da) OVER w AS bal_a
      FROM evd JOIN prod USING (product_id)
    WINDOW w AS (PARTITION BY evd.product_id ORDER BY evd.d ROWS UNBOUNDED PRECEDING)
  ),
  walk2 AS (
    SELECT walk.*,
           MAX(GREATEST(0, -bal_c)) OVER w AS cum_c,
           MAX(GREATEST(0, -bal_a)) OVER w AS cum_a
      FROM walk
    WINDOW w AS (PARTITION BY product_id ORDER BY d ROWS UNBOUNDED PRECEDING)
  ),
  sugg AS (
    SELECT product_id, d, cum_c - COALESCE(LAG(cum_c) OVER (PARTITION BY product_id ORDER BY d), 0) AS qty
      FROM walk2
  ),
  totals AS (
    SELECT product_id, MAX(cum_c) AS suggested, MAX(cum_a) - MAX(cum_c) AS could_add FROM walk2 GROUP BY product_id
  ),
  -- Rule 6 reasons.
  reasons AS (
    SELECT prod.product_id, array_remove(ARRAY[
             -- A Firm line with no date, held or not (as the Firm-needs-a-date list).
             CASE WHEN EXISTS (SELECT 1 FROM s2 WHERE s2.product_id = prod.product_id AND s2.rem > 0 AND s2.confidence = 'firm' AND s2.needed_by_date IS NULL) THEN 'needs_date' END,
             CASE WHEN EXISTS (SELECT 1 FROM demb WHERE demb.product_id = prod.product_id AND demb.cls = 'committed' AND demb.bucket = 'check_units') THEN 'check_units' END,
             CASE WHEN EXISTS (SELECT 1 FROM demb WHERE demb.product_id = prod.product_id AND demb.cls = 'committed' AND demb.bucket = 'later') THEN 'later' END,
             CASE WHEN EXISTS (SELECT 1 FROM overdrawn WHERE overdrawn.product_id = prod.product_id) THEN 'over_drawn' END,
             CASE WHEN EXISTS (SELECT 1 FROM po WHERE po.product_id = prod.product_id AND po.flag = 'late') THEN 'late_po' END,
             CASE WHEN EXISTS (SELECT 1 FROM po WHERE po.product_id = prod.product_id AND po.flag = 'undated') THEN 'undated_po' END
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
                     ORDER BY p.product_name) AS products
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
    -- Counted lines before the held split, so a held undated Firm line is still listed.
    'firm_needs_date', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'quote_id', s2.quote_id, 'quote_number', eq.quote_number, 'customer_name', c.farm_name,
               'section_name', qs.section_name, 'product_id', s2.product_id, 'product_name', p.product_name,
               'quantity', s2.rem) ORDER BY c.farm_name, eq.quote_number, qs.section_name, p.product_name)
        FROM s2
        JOIN eq ON eq.id = s2.quote_id
        LEFT JOIN customers c ON c.id = eq.customer_id
        LEFT JOIN quote_sections qs ON qs.id = s2.section_id
        JOIN products p ON p.id = s2.product_id
       WHERE s2.rem > 0 AND s2.confidence = 'firm' AND s2.needed_by_date IS NULL), '[]'::jsonb),
    'drawn_section_unknown', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'quote_id', dt.quote_id, 'quote_number', eq.quote_number, 'customer_name', c.farm_name,
               'product_id', dt.product_id, 'product_name', p.product_name, 'quantity', dt.total - COALESCE(ap1.applied, 0))
               ORDER BY eq.quote_number, p.product_name)
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
               'products', rev.products) ORDER BY rev.window_end, eq.quote_number, qs.section_name)
        FROM rev JOIN eq ON eq.id = rev.quote_id
        LEFT JOIN customers c ON c.id = eq.customer_id
        LEFT JOIN quote_sections qs ON qs.id = rev.section_id
       WHERE prm.today >= rev.window_end - 14), '[]'::jsonb),
    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'product_id', prod.product_id, 'product_name', prod.product_name, 'sku', prod.sku,
               'stock_unit', prod.stock_unit, 'container_size', prod.container_size, 'unit_size', prod.unit_size,
               'on_hand', prod.on_hand,
               'incoming', COALESCE((SELECT SUM(po.qty) FROM po WHERE po.product_id = prod.product_id AND po.flag IN ('counted', 'late')), 0),
               'drafted', COALESCE((SELECT SUM(po.qty) FROM po WHERE po.product_id = prod.product_id AND po.flag = 'draft'), 0),
               'committed', COALESCE((SELECT SUM(demb.qty) FROM demb WHERE demb.product_id = prod.product_id AND demb.cls = 'committed' AND demb.bucket = 'dated'), 0),
               'suggested', COALESCE(t.suggested, 0),
               'could_add', COALESCE(t.could_add, 0),
               'over_drawn', COALESCE((SELECT SUM(od.qty) FROM overdrawn od WHERE od.product_id = prod.product_id), 0),
               'not_complete', cardinality(r.list) > 0,
               'reasons', to_jsonb(r.list),
               'suggestions', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'need_date', sg.d,
                          'order_by', GREATEST(sg.d - prm.lead_days, prm.today),
                          'order_now', sg.d - prm.lead_days <= prm.today,
                          -- No "expedite a later PO instead" alternative (Mason, 2026-11-18): it could not show
                          -- the shortage that moving a PO earlier leaves behind. Open POs stay listed.
                          'quantity', sg.qty)
                          ORDER BY sg.d)
                   FROM sugg sg WHERE sg.product_id = prod.product_id AND sg.qty > 0), '[]'::jsonb),
               'months', (
                 SELECT jsonb_agg(jsonb_build_object(
                          'month', mo.m,
                          'committed', COALESCE((SELECT SUM(qty) FROM demb WHERE demb.product_id = mo.product_id AND demb.bucket = 'dated' AND demb.cls = 'committed' AND date_trunc('month', demb.need_date) = mo.m), 0),
                          'could_add', COALESCE((SELECT SUM(qty) FROM demb WHERE demb.product_id = mo.product_id AND demb.bucket = 'dated' AND demb.cls = 'could_add' AND date_trunc('month', demb.need_date) = mo.m), 0),
                          'maybe', COALESCE((SELECT SUM(qty) FROM demb WHERE demb.product_id = mo.product_id AND demb.bucket = 'dated' AND demb.cls = 'shown' AND date_trunc('month', demb.need_date) = mo.m), 0),
                          'incoming', COALESCE((SELECT SUM(qty) FROM po WHERE po.product_id = mo.product_id AND po.flag IN ('counted', 'late') AND date_trunc('month', po.eff_date) = mo.m), 0))
                          ORDER BY mo.m)
                   FROM months mo WHERE mo.product_id = prod.product_id),
               'rows', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'kind', demb.kind, 'class', demb.cls, 'bucket', demb.bucket,
                          'need_date', CASE WHEN demb.bucket = 'needs_date' THEN NULL ELSE demb.need_date END,
                          'raw_date', demb.raw_date, 'overdue', COALESCE(demb.overdue, false),
                          'quantity', demb.qty, 'confidence', demb.confidence, 'estimated', demb.estimated,
                          'quote_id', demb.quote_id, 'quote_number', q.quote_number,
                          'order_id', demb.order_id, 'order_number', o.order_number,
                          'job_id', demb.job_id, 'job_number', j.job_number,
                          'customer_name', c.farm_name, 'section_name', qs.section_name)
                          ORDER BY demb.raw_date NULLS FIRST, demb.kind, c.farm_name)
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
                          ORDER BY po.raw_date NULLS LAST, po.po_number)
                   FROM po WHERE po.product_id = prod.product_id), '[]'::jsonb))
             ORDER BY (cardinality(r.list) > 0 OR COALESCE(t.suggested, 0) > 0) DESC, prod.product_name)
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
     IS DISTINCT FROM '50c3779f1b10b1ec71e92ee4dce1eab9' THEN
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
END;
$postflight$;
