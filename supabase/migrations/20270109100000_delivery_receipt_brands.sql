-- Written 2026-11-12. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270109100000_delivery_receipt_brands.md. Re-read the live ledger before applying.
--
-- WHY (Brand PR B, part B-3; build sheet docs/plans/2026-11-08-product-BRAND-PRB-BUILD-SHEET.md sections 3.5, 6, 15.10
--   Sol round 2, 16.8; issue #1833):
--   1. The customer's delivery receipt email is built from a snapshot saved at completion (_enqueue_delivery_receipt).
--      B-1a left it unchanged on purpose (Sol round 2: unconfirmed picks must not reach the customer, and the receipt,
--      its sender and its correction handling ship together). B-3 adds each line's delivered brands to that snapshot;
--      the send-delivery-receipts Edge Function (same PR) prints them.
--   2. #1833: get_epa_sales_to_check kept a brand "not reviewed" when the product itself has no EPA number, because the
--      missing product registration read as unknown. Posted captures are frozen, so the row never cleared.
--
-- WHAT:
--   1. _enqueue_delivery_receipt re-issued (md5 pinned; same signature, owner, SECURITY DEFINER, search_path, no app
--      grants). Each receipt line also carries, read from the current picks and the delivery's latest 'completed'
--      brand event, in the same transaction as the completion:
--        - picks that add up to the delivered amount (4 places): brands [{name, epa_registration, quantity}];
--        - picks that do not add up: brands [{name, epa_registration}] (no amounts, never a guessed split) and
--          brand_picked_quantity (what the picks add up to);
--        - no pick on a line that had a brand list at completion: brand_recorded false;
--        - an unbranded line, a delivery with no 'completed' event (completed before B-1a), or a completion from an
--          out-of-date screen (picks_confirmed false: the office list flags it, and the customer is never sent a
--          brand the completing screen did not confirm): no brand keys, so the line prints exactly as before.
--      A snapshot queued before this file has no brand keys and prints exactly as before.
--   2. get_epa_sales_to_check re-issued (md5 pinned) from 20270106110000's body with one change: a brand row is listed
--      not_reviewed because of the product's registration only when the product has an EPA number.
--
-- NOT CHANGED: every amount, quantity, stock, invoice and record function; the receipt queue's claim, confirm and
--   finish functions; the office resend (it is built in the app from the current picks, so it carries a correction).
--
-- ROLLBACK (its own reviewed migration, a forward repair): re-issue _enqueue_delivery_receipt from
--   20261113140000_delivery_receipt_queue.sql (lines 185-243) and get_epa_sales_to_check from
--   20270106110000_invoice_brands_rup.sql (lines 1058-1193). Snapshots already queued keep their brand keys; the
--   Edge Function from before B-3 ignores them.
--
-- ORDERING: after 20270106110000 (B-1b, live). Independent of 20270107100000 and 20270108100000.
--
-- caller-analysis: _enqueue_delivery_receipt :: called only by complete_delivery's evidence body (20270104120000 _complete_delivery_evidence_impl_20270104); same signature, owner, mode and grants (none for app roles); only the saved snapshot gains keys inside each line
-- caller-analysis: get_epa_sales_to_check :: EpaRegistrationSetup.tsx (through epaRegistrationSeed.ts) reads it; same signature, grant (authenticated) and row shape; only the not_reviewed condition for brand rows changes
-- caller-analysis: all-functions :: no new function

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE delivery_receipt_brands_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_pin record;
BEGIN
  IF to_regclass('pg_temp.delivery_receipt_brands_tx') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_RECEIPT_BRANDS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.delivery_receipt_brands_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'DELIVERY_RECEIPT_BRANDS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regclass('public.invoice_line_brand_rup_captures') IS NULL OR to_regclass('public.delivery_brand_events') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_RECEIPT_BRANDS_PREFLIGHT: apply 20270104120000 and 20270106110000 first';
  END IF;
  IF position('brand_recorded' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public._enqueue_delivery_receipt(uuid,uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'DELIVERY_RECEIPT_BRANDS_PREFLIGHT: this file was already applied';
  END IF;
  FOR v_pin IN SELECT * FROM (VALUES
      ('public._enqueue_delivery_receipt(uuid,uuid)', 'edd5ddb32392517994c6587654c9cbc7'),
      ('public.get_epa_sales_to_check()', 'c7a03b22eba061edba4c809006ba62d0')) v(sig, body_md5)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig)
                      AND md5(replace(p.prosrc, chr(13), '')) = v_pin.body_md5 AND p.proowner = 'postgres'::regrole) THEN
      RAISE EXCEPTION 'DELIVERY_RECEIPT_BRANDS_PREFLIGHT: % drifted from the body this file was written from', v_pin.sig;
    END IF;
  END LOOP;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. The receipt snapshot carries each line's delivered brands.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._enqueue_delivery_receipt(p_delivery_id uuid, p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_delivery record;
  v_worker_on boolean;
  -- Brand PR B-3 (20270109100000): the completion's brand event, read in the completion's own transaction.
  v_brand_event jsonb;
BEGIN
  SELECT d.id, d.delivery_number, d.customer_id, d.signed_by, d.completed_at, c.contact_name,
         NULLIF(btrim(COALESCE(c.email, '')), '') AS email
    INTO v_delivery
    FROM public.deliveries d JOIN public.customers c ON c.id = d.customer_id
   WHERE d.id = p_delivery_id AND d.status = 'completed' AND d.deleted_at IS NULL;
  IF v_delivery.id IS NULL THEN
    RETURN;
  END IF;
  -- No customer email on file now (removed after the screen checked), or the sender is not switched on yet (its two
  -- Vault secrets, as the timer reads them): the office follows up instead of a row waiting with nobody to send it.
  v_worker_on := EXISTS (SELECT 1 FROM vault.decrypted_secrets s WHERE s.name = 'delivery_receipt_worker_url')
             AND EXISTS (SELECT 1 FROM vault.decrypted_secrets s WHERE s.name = 'delivery_receipt_worker_secret');
  -- No event (completed before brand capture) or a completion from an out-of-date screen: no brand keys at all, so
  -- the customer is never sent a brand the completing screen did not confirm (B-1a Sol round 2).
  v_brand_event := (SELECT e.details FROM public.delivery_brand_events e
                     WHERE e.delivery_id = p_delivery_id AND e.event_type = 'completed'
                     ORDER BY e.seq DESC LIMIT 1);
  IF v_brand_event ->> 'picks_confirmed' = 'false' THEN
    v_brand_event := NULL;
  END IF;
  INSERT INTO public.delivery_receipt_queue (delivery_id, customer_id, requested_by, status, last_error, receipt)
  VALUES (
    p_delivery_id,
    v_delivery.customer_id,
    p_actor,
    CASE WHEN v_delivery.email IS NULL OR NOT v_worker_on THEN 'needs_check' ELSE 'pending' END,
    CASE WHEN v_delivery.email IS NULL THEN 'The customer has no email on file; the receipt was not sent.'
         WHEN NOT v_worker_on THEN 'The receipt sender is not switched on; the receipt was not sent.' END,
    jsonb_build_object(
      'delivery_number', COALESCE(v_delivery.delivery_number, ''),
      'delivered_on', to_char((v_delivery.completed_at AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD'),
      'signed_by', v_delivery.signed_by,
      'contact_name', v_delivery.contact_name,
      'is_partial', EXISTS (SELECT 1 FROM public.delivery_items di
                             WHERE di.delivery_id = p_delivery_id
                               AND COALESCE(di.quantity_delivered, di.quantity) < di.quantity)
                    OR EXISTS (SELECT 1 FROM public.delivery_remainders r WHERE r.original_delivery_id = p_delivery_id),
      'lines', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('name', COALESCE(p.product_name, 'Product'),
                                            'qty', COALESCE(di.quantity_delivered, di.quantity))
                         || CASE
                              WHEN v_brand_event IS NULL THEN '{}'::jsonb
                              WHEN k.with_qty IS NULL THEN
                                CASE WHEN COALESCE((SELECT (l ->> 'brand_list_size')::integer
                                                      FROM jsonb_array_elements(v_brand_event -> 'lines') l
                                                     WHERE l ->> 'delivery_item_id' = di.id::text LIMIT 1), 0) > 0
                                     THEN jsonb_build_object('brand_recorded', false) ELSE '{}'::jsonb END
                              -- picks hold 4 places: the same 4-place rule as the office list and corrections
                              WHEN k.picked = round(COALESCE(di.quantity_delivered, di.quantity), 4)
                                THEN jsonb_build_object('brands', k.with_qty)
                              ELSE jsonb_build_object('brands', k.without_qty, 'brand_picked_quantity', k.picked)
                            END
                         ORDER BY p.product_name, di.id)
          FROM public.delivery_items di LEFT JOIN public.products p ON p.id = di.product_id
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object('name', b.brand_name, 'epa_registration', b.epa_registration,
                                                'quantity', b.quantity)
                             ORDER BY lower(b.brand_name), b.epa_registration NULLS FIRST, b.id) AS with_qty,
                   jsonb_agg(jsonb_build_object('name', b.brand_name, 'epa_registration', b.epa_registration)
                             ORDER BY lower(b.brand_name), b.epa_registration NULLS FIRST, b.id) AS without_qty,
                   sum(b.quantity) AS picked
              FROM public.delivery_item_brands b
             WHERE b.delivery_item_id = di.id AND b.superseded_at IS NULL) k ON true
         WHERE di.delivery_id = p_delivery_id AND COALESCE(di.quantity_delivered, di.quantity) > 0
      ), '[]'::jsonb)
    )
  )
  -- A delivery completed again after its receipt was cancelled (nothing was ever sent) owes a fresh one; any
  -- other existing row (owed, sent or on the office list) stands.
  ON CONFLICT (delivery_id) DO UPDATE
     SET customer_id = EXCLUDED.customer_id, requested_by = EXCLUDED.requested_by, status = EXCLUDED.status,
         last_error = EXCLUDED.last_error, receipt = EXCLUDED.receipt, attempts = 0, next_attempt_at = now(),
         attempt_to = NULL, send_authorized_at = NULL, send_confirmed_token = NULL, created_at = now()
   WHERE delivery_receipt_queue.status = 'cancelled' AND delivery_receipt_queue.send_authorized_at IS NULL;
END;
$function$;
ALTER FUNCTION public._enqueue_delivery_receipt(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._enqueue_delivery_receipt(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. #1833: a numberless product never keeps a brand listed not reviewed.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_epa_sales_to_check() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_out jsonb;
BEGIN
  PERFORM public._product_parent_require_admin();
  IF NOT public._epa_registrations_seeded() THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_NOT_SEEDED: registrations are not switched on yet';
  END IF;
  WITH posted AS (
    SELECT ii.id AS line_id, ii.invoice_id, i.invoice_number, i.invoice_date, ii.product_id, p.product_name,
           public._normalize_epa_registration(ii.epa_registration) AS saved_number, ii.quantity, ii.brand_lines,
           COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(ii.brand_lines) = 'array' THEN ii.brand_lines END), 0) > 0 AS branded,
           p.is_rup AS product_is_rup, public._normalize_epa_registration(p.epa_registration) AS product_number,
           ii.order_item_id
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN products p ON p.id = ii.product_id
     -- a return credit is never a sale to record (Mason, 2026-11-10); neither is a zero or negative line
     WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL AND i.invoice_type <> 'credit_memo'
       AND ii.quantity > 0
  ), lines AS (
    -- #1746's per-line rows, for lines with NULL or [] brands.
    SELECT l.line_id, l.invoice_id, l.invoice_number, l.invoice_date, l.product_id, l.product_name,
           c.epa_registration, l.saved_number, l.quantity, c.rup_status, c.source AS capture_source,
           -- any Yes now: the product's tick, or the registration of the captured number, the number saved on the
           -- line, or the product's number today (Mason, 2026-11-10, Sol r10)
           COALESCE(l.product_is_rup, false) OR r.rup_status = 'yes' OR lr.rup_status = 'yes' OR pr.rup_status = 'yes' AS yes_now,
           r.rup_status AS registration_rup_status_now, lr.rup_status AS saved_registration_rup_status_now,
           EXISTS (SELECT 1 FROM rup_sales_records s WHERE s.invoice_item_id = l.line_id AND s.voided_at IS NULL) AS has_record
      FROM posted l
      LEFT JOIN invoice_line_rup_captures c ON c.invoice_item_id = l.line_id
      LEFT JOIN epa_registrations r ON r.epa_registration = c.epa_registration
      LEFT JOIN epa_registrations lr ON lr.epa_registration = l.saved_number
      LEFT JOIN epa_registrations pr ON pr.epa_registration = l.product_number
     WHERE NOT l.branded
  ), judged AS (
    SELECT l.*,
           CASE WHEN rup_status IS NULL THEN 'not_captured'
                WHEN rup_status = 'yes' AND NOT has_record THEN 'restricted_use_to_record'
                WHEN rup_status = 'yes' AND epa_registration IS NULL THEN 'no_epa_number'
                WHEN rup_status = 'yes' OR has_record THEN NULL
                WHEN yes_now THEN 'now_restricted_use'
                WHEN rup_status = 'unknown'
                 AND ((epa_registration IS NOT NULL AND COALESCE(registration_rup_status_now, 'unknown') = 'unknown')
                      OR (saved_number IS NOT NULL AND COALESCE(saved_registration_rup_status_now, 'unknown') = 'unknown'))
                  THEN 'not_reviewed'
                ELSE NULL END AS reason
      FROM lines l
  ), alloc AS (
    SELECT l.*, public._invoice_line_brand_allocation(l.line_id) AS a FROM posted l WHERE l.branded
  ), brands AS (
    -- One row per brand with a positive share on a branded line without a problem.
    SELECT al.line_id, al.invoice_id, al.invoice_number, al.invoice_date, al.product_id, al.product_name,
           c.epa_registration, al.saved_number, al.quantity, c.rup_status, c.source AS capture_source,
           COALESCE(al.product_is_rup, false) OR r.rup_status = 'yes' OR pr.rup_status = 'yes'
             OR EXISTS (SELECT 1 FROM public._invoice_line_brand_keys(al.brand_lines) k
                         WHERE k.brand_key = b.value ->> 'brand_key' AND k.ticked) AS yes_now,
           r.rup_status AS registration_rup_status_now, pr.rup_status AS product_registration_rup_status_now,
           al.product_number,
           EXISTS (SELECT 1 FROM rup_sales_records s WHERE s.invoice_item_id = al.line_id AND s.voided_at IS NULL
                      AND s.brand_key = b.value ->> 'brand_key') AS has_record,
           b.value ->> 'brand_key' AS brand_key, b.value ->> 'brand_name' AS brand_name,
           (b.value ->> 'quantity')::numeric AS allocated_quantity,
           b.value ->> 'brand_key' LIKE 'b:%' AND public._normalize_epa_registration(b.value ->> 'epa_registration') IS NULL AS brand_has_no_number
      FROM alloc al
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN al.a ->> 'problem' IS NULL THEN al.a -> 'brands' ELSE '[]'::jsonb END) b
      LEFT JOIN invoice_line_brand_rup_captures c ON c.invoice_item_id = al.line_id AND c.brand_key = b.value ->> 'brand_key'
      LEFT JOIN epa_registrations r ON r.epa_registration = c.epa_registration
      LEFT JOIN epa_registrations pr ON pr.epa_registration = al.product_number
     WHERE (b.value ->> 'quantity')::numeric > 0
  ), all_rows AS (
    SELECT line_id, invoice_id, invoice_number, invoice_date, product_id, product_name, epa_registration, saved_number,
           quantity, rup_status, capture_source, registration_rup_status_now, has_record,
           NULL::text AS brand_key, NULL::text AS brand_name, NULL::numeric AS allocated_quantity, reason
      FROM judged WHERE reason IS NOT NULL
    UNION ALL
    SELECT line_id, invoice_id, invoice_number, invoice_date, product_id, product_name, epa_registration, saved_number,
           quantity, rup_status, capture_source, registration_rup_status_now, has_record, brand_key, brand_name,
           allocated_quantity,
           CASE WHEN rup_status IS NULL THEN 'not_captured'
                WHEN rup_status = 'yes' AND NOT has_record THEN 'restricted_use_to_record'
                WHEN rup_status = 'yes' AND epa_registration IS NULL THEN 'no_epa_number'
                WHEN rup_status = 'yes' OR has_record THEN NULL
                WHEN yes_now THEN 'now_restricted_use'
                WHEN rup_status = 'unknown' AND epa_registration IS NOT NULL
                 AND (COALESCE(registration_rup_status_now, 'unknown') = 'unknown'
                      -- #1833: the product's registration counts only when the product has a number
                      -- (as _invoice_brand_rup_facts reads it); a numberless product never keeps a brand listed.
                      OR (product_number IS NOT NULL
                          AND COALESCE(product_registration_rup_status_now, 'unknown') = 'unknown')) THEN 'not_reviewed'
                ELSE NULL END
      FROM brands
    UNION ALL
    SELECT line_id, invoice_id, invoice_number, invoice_date, product_id, product_name, epa_registration, saved_number,
           quantity, rup_status, capture_source, registration_rup_status_now, has_record, brand_key, brand_name,
           allocated_quantity, 'brand_no_epa_number'
      FROM brands WHERE brand_has_no_number
    UNION ALL
    -- Line-level brand reasons: a brand problem, a snapshot that no longer matches the picks, no brand recorded, or a
    -- sibling payer changed after this line posted so its records no longer match its allocation.
    SELECT l.line_id, l.invoice_id, l.invoice_number, l.invoice_date, l.product_id, l.product_name,
           NULL::text, l.saved_number, l.quantity, NULL::text, NULL::text, NULL::text,
           EXISTS (SELECT 1 FROM rup_sales_records s WHERE s.invoice_item_id = l.line_id AND s.voided_at IS NULL),
           NULL::text, NULL::text, NULL::numeric, f.reason
      FROM posted l
      LEFT JOIN alloc al ON al.line_id = l.line_id
     CROSS JOIN LATERAL (VALUES
       (al.a ->> 'problem'),
       (CASE WHEN l.order_item_id IS NOT NULL
                  AND l.brand_lines IS DISTINCT FROM public._invoice_line_brand_lines(l.invoice_id, l.order_item_id, l.product_id)
             THEN 'brand_lines_stale' END),
       (CASE WHEN jsonb_typeof(l.brand_lines) = 'array'
                  AND (jsonb_array_length(l.brand_lines) = 0 OR l.brand_lines @> '[{"brand_key": "n:"}]'::jsonb)
             THEN 'brand_not_recorded' END),
       (CASE WHEN al.a ->> 'problem' IS NULL AND EXISTS (
               SELECT 1 FROM rup_sales_records s
                WHERE s.invoice_item_id = l.line_id AND s.voided_at IS NULL AND s.brand_key IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(al.a -> 'brands') b
                                   WHERE b.value ->> 'brand_key' = s.brand_key
                                     AND (b.value ->> 'quantity')::numeric = s.quantity))
             THEN 'payer_split_changed' END)) f(reason)
     -- Every brand problem is listed, restricted or not (Mason, 2026-11-11): brands never block, so a
     -- few extra lines to check beat a restricted sale hidden by a filter.
     WHERE f.reason IS NOT NULL
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'line_id', line_id, 'invoice_id', invoice_id, 'invoice_number', invoice_number, 'invoice_date', invoice_date,
           'product_id', product_id, 'product_name', product_name, 'epa_registration', epa_registration,
           'saved_number', saved_number, 'quantity', quantity, 'captured_rup_status', rup_status,
           'capture_source', capture_source, 'registration_rup_status', registration_rup_status_now,
           'has_record', has_record, 'reason', reason,
           'brand_key', brand_key, 'brand_name', brand_name, 'allocated_quantity', allocated_quantity)
           ORDER BY invoice_date, invoice_number, line_id, brand_key NULLS FIRST, reason), '[]'::jsonb)
    INTO v_out
    FROM all_rows
   WHERE reason IS NOT NULL;
  RETURN v_out;
END;
$function$;
ALTER FUNCTION public.get_epa_sales_to_check() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_epa_sales_to_check() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_epa_sales_to_check() TO authenticated;

DO $postflight$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, 'public._enqueue_delivery_receipt(uuid,uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_RECEIPT_BRANDS: % can run _enqueue_delivery_receipt', v_role;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.oid IN ('public._enqueue_delivery_receipt(uuid,uuid)'::regprocedure, 'public.get_epa_sales_to_check()'::regprocedure)
                AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_epa_sales_to_check()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_epa_sales_to_check()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_RECEIPT_BRANDS: a function lost or gained a grant';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('public._enqueue_delivery_receipt(uuid,uuid)'::regprocedure, 'public.get_epa_sales_to_check()'::regprocedure)
                AND (NOT p.prosecdef OR p.proowner <> 'postgres'::regrole
                     OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) s WHERE replace(s, '"', '') = 'search_path=public, pg_temp'))) THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_RECEIPT_BRANDS: a function is not SECURITY DEFINER, owned by postgres, with its search_path';
  END IF;
  IF position('brand_recorded' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public._enqueue_delivery_receipt(uuid,uuid)'::regprocedure)) = 0
     OR position('product_number IS NOT NULL' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_epa_sales_to_check()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_RECEIPT_BRANDS: a new body is missing';
  END IF;
END
$postflight$;
