-- #1990 Sol HIGH (20270120150000:1000; Mason, 2026-11-20, chose "Reps if price covers cost"): a sales rep may save a
-- field-application invoice whose chemicals are included in the grower's per-acre price only when that per-acre price
-- covers the chemicals' cost. Otherwise only an admin may save it. Admins are unchanged.
-- actor-binding-check: exempt -- trigger function (EXECUTE only postgres and service_role); it reads auth.uid() itself.
-- The public wrapper save_field_app_invoice raises ACTOR_MISMATCH and keeps p_idempotency_key text DEFAULT NULL; unchanged.
--
-- WHY: 20270120150000 let an active admin OR sales rep save the $0 "included in grower share" chemical line, logging the
-- approval under that user, without comparing the per-acre price with the included chemicals' cost. Live 2026-11-20: 0 grower-share fields, 0 such
-- invoice lines, so nothing in use changes.
--
-- WHAT: _enforce_below_cost_line is re-created from its 20270120150000 body (md5 1069cd1451454030627b250db7b729d1) with
-- one added check, in the grower-share branch only: when the signed-in user is not an admin, the line saves only if
-- (booked cost of this invoice's $0 grower-share lines already written in this save + this line's booked cost + 51
-- cents per such line) <= (sum of this invoice's per-acre grower-share lines). The 51-cent cushion per line (Mason,
-- 2026-11-21, "Add a cushion") covers the up-to-50-cent rounding the save allows on each line. Otherwise FIELD_APP_GROWER_SHARE_BELOW_COST and the whole save rolls back.
-- _save_field_app_invoice_impl_20260714 (the only writer of this context; the split save refuses grower-share fields)
-- deletes an invoice's lines first and writes every per-acre line before any $0 line, so the last $0 line's check is
-- the whole-invoice check. Browser roles cannot write invoice_items or below_cost_approvals. Nothing else changes.
--
-- ROLLBACK: scripts/smoke/grower-share-rep-cover-reverse.sql restores the 20270120150000 body, proven by
-- scripts/smoke/prove-grower-share-rep-cover-real-schema.mjs.

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._enforce_below_cost_line()')
       AND ((SELECT count(*) FROM pg_proc o
              WHERE o.pronamespace = 'public'::regnamespace AND o.proname = '_enforce_below_cost_line') <> 1
        OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM '1069cd1451454030627b250db7b729d1'
        OR p.proowner <> 'postgres'::regrole
        OR NOT p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR p.provolatile <> 'v' OR p.proisstrict OR p.proleakproof OR p.proretset
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM ARRAY['postgres', 'service_role'])
  ) OR to_regprocedure('public._enforce_below_cost_line()') IS NULL THEN
    RAISE EXCEPTION 'GROWER_SHARE_REP_COVER_PREFLIGHT: _enforce_below_cost_line is not the reviewed 20270120150000 body, or its header or grants changed';
  END IF;
  PERFORM set_config('crx.gsrc_xid', pg_current_xact_id()::text, true);
  PERFORM set_config('crx.gsrc_acl', (SELECT coalesce(proacl::text, '') FROM pg_proc WHERE oid = 'public._enforce_below_cost_line()'::regprocedure), true);
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._enforce_below_cost_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_operation text := current_setting('app.crx_below_cost_operation', true);
  v_reason text := NULLIF(btrim(current_setting('app.crx_below_cost_reason', true)), '');
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_product_name text;
  v_cost numeric;
  v_cost_cents bigint;
  v_price_cents bigint;
  v_quantity numeric;
  v_entity_type text;
  v_entity_id uuid;
  v_line_id uuid;
  v_product_id uuid;
  v_is_application_fee boolean;
  v_detail jsonb;
  v_grower_share boolean := false;
BEGIN
  -- KI-156 (Mason, 2026-11-15: "Admins and reps"): _save_field_app_invoice_impl_20260714 declares
  -- 'field_app_grower_share' around its $0 "included in grower share" line only. That line is not a
  -- below-cost sale; it is judged at the refusal below. For every other check this context counts as none.
  IF v_operation = 'field_app_grower_share' THEN
    v_grower_share := TG_TABLE_NAME = 'invoice_items' AND TG_OP = 'INSERT';
    v_operation := NULL;
  END IF;

  IF TG_TABLE_NAME = 'order_items' THEN
    -- Delivery completion and cancellation update fulfillment counters on an
    -- already-approved sale. They do not make a new pricing decision. Let
    -- context-free bookkeeping (and exposure-reducing quantity corrections)
    -- proceed, while a product/price change or quantity increase still reaches
    -- the fail-closed approval wall below.
    IF TG_OP = 'UPDATE'
       AND COALESCE(v_operation, '') = ''
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.price_per_unit IS NOT DISTINCT FROM OLD.price_per_unit
       AND COALESCE(NEW.total_units_needed, 0)
           <= COALESCE(OLD.total_units_needed, 0) THEN
      RETURN NEW;
    END IF;
    -- Rush orders intentionally carry zero prices until price_order. They are
    -- not sales decisions yet, so defer the wall to the pricing RPC.
    IF NEW.pricing_pending = true AND NEW.price_per_unit = 0 THEN
      RETURN NEW;
    END IF;
    IF NEW.price_per_unit IS NULL
       OR NEW.price_per_unit::text IN ('NaN', 'Infinity', '-Infinity')
       OR NEW.price_per_unit <> round(NEW.price_per_unit, 2) THEN
      RAISE EXCEPTION 'INVALID_UNIT_PRICE_CENTS';
    END IF;
    v_entity_type := 'order';
    v_entity_id := NEW.order_id;
    v_line_id := NEW.id;
    v_product_id := NEW.product_id;
    v_price_cents := round(NEW.price_per_unit * 100)::bigint;
    v_quantity := NEW.total_units_needed;
  ELSIF TG_TABLE_NAME = 'invoice_items' THEN
    -- complete_delivery can materialize an invoice line from an already-made
    -- order pricing decision. Permit only an exact, exposure-bounded descendant
    -- of that governed order line; a caller cannot use this hatch to substitute
    -- another Product, price, cost snapshot, or larger quantity. Browser roles
    -- also have no direct INSERT privilege on invoice_items.
    -- save_invoice rebuilds a draft's lines; an order-linked line it writes back
    -- unchanged is the same descendant and is judged the same way (#13), not
    -- against today's product cost. A draft line repriced above its order price
    -- (checked against cost when it was repriced) keeps that higher price: it
    -- is less exposed below cost than the order decision it descends from.
    IF TG_OP = 'INSERT'
       AND COALESCE(v_operation, '') IN ('', 'save_invoice')
       AND NEW.order_item_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM public.order_items oi
         WHERE oi.id = NEW.order_item_id
           AND oi.product_id IS NOT DISTINCT FROM NEW.product_id
           AND (round(oi.price_per_unit * 100)::bigint = NEW.unit_price_cents
                OR (COALESCE(v_operation, '') = 'save_invoice'
                    AND NEW.unit_price_cents > round(oi.price_per_unit * 100)::bigint))
           AND round(COALESCE(oi.cost_per_unit, 0) * 100)::bigint = NEW.cost_cents
           AND COALESCE(NEW.quantity, 0) >= 0
           AND COALESCE(NEW.quantity, 0) <= COALESCE(oi.total_units_needed, 0)
       ) THEN
      RETURN NEW;
    END IF;
    -- Partial delivery can reduce a draft invoice line and tote-copy updates
    -- bookkeeping only. Neither increases the approved below-cost exposure.
    -- save_invoice restores a rebuilt line's identity the same way (#13).
    IF TG_OP = 'UPDATE'
       AND COALESCE(v_operation, '') IN ('', 'save_invoice')
       AND NEW.product_id IS NOT NULL
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.order_item_id IS NOT DISTINCT FROM OLD.order_item_id
       AND NEW.unit_price_cents IS NOT DISTINCT FROM OLD.unit_price_cents
       AND NEW.cost_cents IS NOT DISTINCT FROM OLD.cost_cents
       AND COALESCE(NEW.is_application_fee, false)
           IS NOT DISTINCT FROM COALESCE(OLD.is_application_fee, false)
       AND COALESCE(NEW.quantity, 0) <= COALESCE(OLD.quantity, 0) THEN
      RETURN NEW;
    END IF;
    v_is_application_fee := COALESCE(NEW.is_application_fee, false);
    IF v_is_application_fee AND NEW.product_id IS NOT NULL THEN
      RAISE EXCEPTION 'APPLICATION_FEE_PRODUCT_INVALID';
    END IF;
    v_entity_type := 'invoice';
    v_entity_id := NEW.invoice_id;
    v_line_id := NEW.id;
    v_product_id := NEW.product_id;
    IF v_product_id IS NULL THEN
      -- A non-product line has no catalog row to lock, but save_invoice lets a
      -- caller supply cost_cents. Zero-cost fees/miscellaneous charges are not
      -- below cost. Positive-cost lines compare their total stored revenue to
      -- total stored cost and use quantity=1 in the approval audit so neither
      -- an application fee nor a null-product misc line can bypass the wall.
      IF COALESCE(NEW.cost_cents, 0) < 0 THEN
        RAISE EXCEPTION 'INVALID_COST';
      END IF;
      IF NEW.quantity IS NULL
         OR NEW.quantity::text IN ('NaN', 'Infinity', '-Infinity')
         OR NEW.quantity <= 0 THEN
        RAISE EXCEPTION 'INVALID_QUANTITY';
      END IF;
      IF COALESCE(NEW.cost_cents, 0) = 0 THEN
        RETURN NEW;
      END IF;
      v_product_name := COALESCE(
        NULLIF(btrim(NEW.description), ''),
        CASE WHEN v_is_application_fee
          THEN 'Application fee'
          ELSE 'Non-product invoice line'
        END
      );
      v_price_cents := COALESCE(
        NEW.extended_cents,
        round(COALESCE(NEW.unit_price_cents, 0) * COALESCE(NEW.quantity, 0))::bigint
      );
      v_cost_cents := CASE
        WHEN v_is_application_fee THEN NEW.cost_cents
        ELSE round(NEW.cost_cents * COALESCE(NEW.quantity, 0))::bigint
      END;
      v_quantity := 1;
    ELSE
      v_price_cents := NEW.unit_price_cents;
      v_quantity := NEW.quantity;
    END IF;
  ELSIF TG_TABLE_NAME = 'quote_items' THEN
    -- save_quote first inserts the client shape and then, in the same
    -- transaction, recomputes every line from the locked Product row. App
    -- roles cannot insert quote_items directly. Defer this private transient
    -- INSERT so the authoritative UPDATE below is the single enforcement and
    -- approval-audit point; any failure there rolls the entire save back.
    IF TG_OP = 'INSERT' AND v_operation = 'save_quote' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND COALESCE(v_operation, '') = ''
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.price_per_unit IS NOT DISTINCT FROM OLD.price_per_unit
       AND COALESCE(NEW.total_units_needed, 0)
           <= COALESCE(OLD.total_units_needed, 0) THEN
      RETURN NEW;
    END IF;
    IF NEW.price_per_unit IS NULL
       OR NEW.price_per_unit::text IN ('NaN', 'Infinity', '-Infinity')
       OR NEW.price_per_unit <> round(NEW.price_per_unit, 2) THEN
      RAISE EXCEPTION 'INVALID_UNIT_PRICE_CENTS';
    END IF;
    v_entity_type := 'quote';
    v_entity_id := NEW.quote_id;
    v_line_id := NEW.id;
    v_product_id := NEW.product_id;
    v_price_cents := round(NEW.price_per_unit * 100)::bigint;
    v_quantity := COALESCE(NEW.total_units_needed, 0);
  ELSE
    RAISE EXCEPTION 'BELOW_COST_TRIGGER_TABLE_INVALID';
  END IF;

  IF v_price_cents < 0 THEN RAISE EXCEPTION 'INVALID_PRICE'; END IF;

  IF v_product_id IS NOT NULL THEN
    -- FOR SHARE prevents products.current_cost from changing between the check
    -- and the line write, while allowing unrelated product rows to proceed.
    SELECT p.product_name, p.current_cost
      INTO v_product_name, v_cost
    FROM public.products p
    WHERE p.id = v_product_id
    FOR SHARE;

    IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND'; END IF;
    IF v_cost IS NULL
       OR v_cost::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_cost <= 0 THEN
      RAISE EXCEPTION 'COST_BASIS_REQUIRED:%', v_product_id;
    END IF;
    IF v_cost <> round(v_cost, 2) THEN
      RAISE EXCEPTION 'COST_BASIS_CENTS_REQUIRED:%', v_product_id;
    END IF;

    v_cost_cents := round(v_cost * 100)::bigint;
  END IF;

  -- update_order_items previously trusted p_items.cost_per_unit, and
  -- price_order previously reused an older snapshot. Both must write the same
  -- locked current cost used by this guard, including every dependent amount.
  IF TG_TABLE_NAME = 'order_items'
     AND v_operation IN (
       'create_direct_order', 'bulk_import_order',
       'update_order_items', 'price_order'
     ) THEN
    NEW.cost_per_unit := v_cost_cents::numeric / 100;
    NEW.cost_at_time_cents := v_cost_cents;
    -- This trigger sorts after trg_order_items_round_money, so it must preserve
    -- that canonical whole-cent invariant after replacing caller/stale cost.
    NEW.total_price := round(NEW.price_per_unit * NEW.total_units_needed, 2);
    NEW.profit := NEW.total_price
                  - round(NEW.cost_per_unit * NEW.total_units_needed, 2);
    NEW.net_margin := CASE
      WHEN NEW.price_per_unit > 0
        THEN round(((NEW.price_per_unit - NEW.cost_per_unit) / NEW.price_per_unit) * 100, 2)
      ELSE 0
    END;
  END IF;

  IF v_price_cents >= v_cost_cents THEN
    RETURN NEW;
  END IF;

  -- KI-156: the declared $0 grower-share line (no price, no amount, not a fee, not from an order) saves for an
  -- active admin or sales rep. Nested so NEW's invoice columns are read only on an invoice_items row.
  IF v_grower_share THEN
    IF NEW.unit_price_cents = 0
       AND COALESCE(NEW.extended_cents, 0) = 0
       AND NOT COALESCE(NEW.is_application_fee, false)
       AND NEW.order_item_id IS NULL
       AND (public.is_admin() OR public.is_sales_rep()) THEN
      -- #1990 Sol (Mason, 2026-11-20: "Reps if price covers cost"): a sales rep's grower-share chemicals must be
      -- paid for by the per-acre price. The save writes this invoice's per-acre lines (no product, acres set, not a
      -- fee) before any $0 line, so these sums are the whole invoice's by its last $0 line. Earlier $0 lines are
      -- counted from their approval rows whose line still exists (a re-save deletes the old lines). An admin may
      -- save it uncovered, as before. The message never states a cost (cost is admin-only, 2026-10-15).
      -- Mason, 2026-11-21 (#2068 Sol round 3, chose "Add a cushion"): each $0 line's cost is counted as it is
      -- booked (rounded per line, as the invoice records it) plus 51 cents. The save already refuses a line whose
      -- booked cost differs from its exact cost by more than 50 cents (20270129171000), so the per-acre total then
      -- covers the chemicals' exact cost however the lines are split or rounded.
      IF NOT public.is_admin()
         AND (SELECT COALESCE(sum(a.total_shortfall_cents + 51), 0)
                FROM public.below_cost_approvals a
               WHERE a.operation = 'field_app_grower_share'
                 AND a.entity_type = 'invoice'
                 AND a.entity_id = NEW.invoice_id
                 AND EXISTS (SELECT 1 FROM public.invoice_items ii
                              WHERE ii.id = a.line_id AND ii.invoice_id = NEW.invoice_id))
             + round((v_cost_cents - v_price_cents) * v_quantity)::bigint + 51
           > (SELECT COALESCE(sum(ii.extended_cents), 0)
                FROM public.invoice_items ii
               WHERE ii.invoice_id = NEW.invoice_id
                 AND ii.product_id IS NULL
                 AND ii.acres IS NOT NULL
                 AND NOT COALESCE(ii.is_application_fee, false)
                 AND ii.order_item_id IS NULL) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'FIELD_APP_GROWER_SHARE_BELOW_COST: the grower''s per-acre price on this invoice does not cover the cost of the chemicals included in it, with a small allowance for rounding. Raise the per-acre price, bill the chemicals on their own lines, or ask an admin to save this invoice.';
      END IF;
      -- Mason, 2026-11-16 ("Yes, record it"): log who approved this $0 line, in this transaction.
      INSERT INTO public.below_cost_approvals (
        operation, entity_type, entity_id, line_id, product_id, actor_user_id,
        reason, unit_price_cents, locked_unit_cost_cents, quantity,
        total_shortfall_cents
      ) VALUES (
        'field_app_grower_share', v_entity_type, v_entity_id, v_line_id, v_product_id, v_actor,
        'Included in the grower''s per-acre price', v_price_cents, v_cost_cents, v_quantity,
        round((v_cost_cents - v_price_cents) * v_quantity)::bigint
      );
      RETURN NEW;
    END IF;
  END IF;

  -- Cost is admin-only (Mason, 2026-10-15). Look the caller up BEFORE the
  -- refusal detail is built: the detail travels back to the browser in the
  -- error message, so it may carry the locked cost only for an active admin.
  -- Without this, a sales rep could type a one-cent price and read the exact
  -- product cost out of BELOW_COST_ADMIN_REQUIRED.
  SELECT p.role INTO v_actor_role
  FROM public.profiles p
  WHERE p.id = v_actor
    AND p.is_active = true;

  v_detail := jsonb_build_object(
    'operation', v_operation,
    'entity_type', v_entity_type,
    'entity_id', v_entity_id,
    'line_id', v_line_id,
    'product_id', v_product_id,
    'product_name', v_product_name,
    'unit_price_cents', v_price_cents,
    'locked_unit_cost_cents', v_cost_cents
  );
  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    v_detail := v_detail - 'locked_unit_cost_cents';
  END IF;

  -- There are many owner-run RPCs and triggers that can write these shared line
  -- tables. A missing context may proceed above cost, but it can never create a
  -- below-cost sale. Known customer-facing paths declare context through thin
  -- wrappers below; any missed future path fails closed here automatically.
  IF v_operation IS NULL OR v_operation = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_CONTEXT_REQUIRED:' || v_detail::text;
  END IF;

  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_ADMIN_REQUIRED:' || v_detail::text;
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_REASON_REQUIRED:' || v_detail::text;
  END IF;

  INSERT INTO public.below_cost_approvals (
    operation, entity_type, entity_id, line_id, product_id, actor_user_id,
    reason, unit_price_cents, locked_unit_cost_cents, quantity,
    total_shortfall_cents
  ) VALUES (
    v_operation, v_entity_type, v_entity_id, v_line_id, v_product_id, v_actor,
    left(v_reason, 1000), v_price_cents, v_cost_cents, v_quantity,
    round((v_cost_cents - v_price_cents) * v_quantity)::bigint
  );

  RETURN NEW;
END;
$function$;

DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._enforce_below_cost_line()')
       AND ((SELECT count(*) FROM pg_proc o
              WHERE o.pronamespace = 'public'::regnamespace AND o.proname = '_enforce_below_cost_line') <> 1
        OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM '5fa0a5f975dc2a84b3c6599a84b8cc55'
        OR p.proowner <> 'postgres'::regrole
        OR NOT p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR p.provolatile <> 'v' OR p.proisstrict OR p.proleakproof OR p.proretset
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM ARRAY['postgres', 'service_role'])
  ) OR to_regprocedure('public._enforce_below_cost_line()') IS NULL THEN
    RAISE EXCEPTION 'GROWER_SHARE_REP_COVER_POSTFLIGHT: _enforce_below_cost_line is not the body this file installs, or its header or grants changed';
  END IF;
  IF current_setting('crx.gsrc_xid', true) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'GROWER_SHARE_REP_COVER_POSTFLIGHT: the preflight did not run in this transaction; apply this file as ONE transaction';
  END IF;
  IF (SELECT coalesce(proacl::text, '') FROM pg_proc WHERE oid = 'public._enforce_below_cost_line()'::regprocedure)
       IS DISTINCT FROM current_setting('crx.gsrc_acl', true) THEN
    RAISE EXCEPTION 'GROWER_SHARE_REP_COVER_POSTFLIGHT: the ACL changed across the replacement';
  END IF;
END;
$postflight$;
