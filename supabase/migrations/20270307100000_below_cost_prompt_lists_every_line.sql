-- Pricing audit fix 1 (Mason, 2026-11-25, Q1: its own database-first PR, applied nowhere until he approves):
-- the below-cost approval prompt lists EVERY below-cost line in a save, not only the first.
-- actor-binding-check: exempt -- trigger functions only (EXECUTE only postgres and service_role); the trigger reads
-- auth.uid() itself, and the public wrappers keep p_idempotency_key text DEFAULT NULL and ACTOR_MISMATCH; unchanged.
--
-- WHY: _enforce_below_cost_line (20270201180000, md5 5fa0a5f975dc2a84b3c6599a84b8cc55) is a row trigger. When an admin
-- saves without a reason it raised BELOW_COST_REASON_REQUIRED at the FIRST below-cost row, so the prompt could name only
-- that line, while the retry with a reason logs every below-cost row under it. A list worked out on the screen is wrong in
-- both directions (server re-pricing, exempt order-linked lines, total-cost fee lines, restore and draw-down rows).
--
-- WHAT:
-- 1. _enforce_below_cost_line is re-created from the 20270201180000 body with two additions. (a) At the top: forget any
--    earlier note of this row, since it is judged afresh. (b) In the admin "no reason" branch only: instead of raising,
--    note the row's detail (today's detail plus quantity, line shortfall = the approval log's formula, and per =
--    unit|line) in the transaction-local setting app.crx_below_cost_pending, keyed by table and line id, and let the row
--    write. Every other branch (exemptions, context, admin-only, grower share, approval logging) is unchanged.
-- 2. New trigger function _raise_below_cost_reason_list() and a CONSTRAINT TRIGGER, AFTER INSERT OR UPDATE, DEFERRABLE
--    INITIALLY DEFERRED, on order_items, quote_items and invoice_items, queued only while that setting is set. At commit
--    (after the RPC returns) it keeps the noted lines whose row still exists and raises ONE BELOW_COST_REASON_REQUIRED
--    whose JSON keeps today's top-level fields (the first line written, so the deployed screen still works) and adds
--    lines (every one, in the order written), line_count, more_count (always 0) and total_shortfall_cents.
--    The save rolls back, as before. A rep still gets BELOW_COST_ADMIN_REQUIRED at once; no context still fails at once.
--    Another error the save hits before commit (stock, validation) is shown first, with no prompt, as a rollback.
-- No row, column, grant or approval-row change. The blend-ticket RPC's own $0-line prompt is unchanged.
--
-- ROLLBACK: scripts/smoke/below-cost-prompt-lists-every-line-reverse.sql drops the three triggers and the new function and
-- restores the 20270201180000 body, proven by scripts/smoke/prove-below-cost-prompt-lists-every-line-real-schema.mjs.

DO $preflight$
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
    RAISE EXCEPTION 'BELOW_COST_LIST_PREFLIGHT: _enforce_below_cost_line is not the reviewed 20270201180000 body, or its header or grants changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_raise_below_cost_reason_list')
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zzz_crx_below_cost_reason_list') THEN
    RAISE EXCEPTION 'BELOW_COST_LIST_PREFLIGHT: _raise_below_cost_reason_list or its triggers already exist';
  END IF;
  PERFORM set_config('crx.bcl_xid', pg_current_xact_id()::text, true);
  PERFORM set_config('crx.bcl_acl', (SELECT coalesce(proacl::text, '') FROM pg_proc WHERE oid = 'public._enforce_below_cost_line()'::regprocedure), true);
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
  v_pending jsonb;
  v_pending_key text;
  v_carried jsonb;
  v_shortfall_cents bigint;
BEGIN
  -- Pricing audit fix 1: this row is judged afresh below, so forget any earlier note of it. A line raised to cost or
  -- made exempt later in the same save then no longer asks for a reason; a line still below cost is noted again.
  -- A row whose id changes leaves its old note behind too, except one case: save_invoice re-inserts a kept invoice line
  -- under a new id, then restores its saved id with the same product, price, cost and no more quantity (#13). Before
  -- this fix that insert refused the save, so that line's note moves to the restored id and stays.
  IF COALESCE(current_setting('app.crx_below_cost_pending', true), '') <> '' THEN
    v_pending := current_setting('app.crx_below_cost_pending', true)::jsonb
      #- ARRAY['lines', TG_TABLE_NAME || ':' || COALESCE(NEW.id::text, '')];
    IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
      v_carried := v_pending -> 'lines' -> (TG_TABLE_NAME || ':' || COALESCE(OLD.id::text, ''));
      v_pending := v_pending #- ARRAY['lines', TG_TABLE_NAME || ':' || COALESCE(OLD.id::text, '')];
      -- Nested so NEW's invoice columns are read only on an invoice_items row.
      IF v_carried IS NOT NULL AND TG_TABLE_NAME = 'invoice_items' THEN
        IF NEW.product_id IS NOT DISTINCT FROM OLD.product_id
           AND NEW.unit_price_cents IS NOT DISTINCT FROM OLD.unit_price_cents
           AND NEW.cost_cents IS NOT DISTINCT FROM OLD.cost_cents
           AND COALESCE(NEW.is_application_fee, false) IS NOT DISTINCT FROM COALESCE(OLD.is_application_fee, false)
           AND COALESCE(NEW.quantity, 0) <= COALESCE(OLD.quantity, 0) THEN
          v_pending := jsonb_set(v_pending, ARRAY['lines', TG_TABLE_NAME || ':' || COALESCE(NEW.id::text, '')],
            v_carried || jsonb_build_object('line_id', NEW.id));
        END IF;
      END IF;
    END IF;
    PERFORM set_config('app.crx_below_cost_pending', v_pending::text, true);
    v_pending := NULL;
  END IF;

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
    -- Pricing audit fix 1 (Mason, 2026-11-25): instead of stopping at this first line, note it and
    -- let the save write on. _raise_below_cost_reason_list (a deferred trigger) then refuses the
    -- save ONCE, after the RPC returns, listing every below-cost line it wrote; the whole save rolls
    -- back as before. Only an active admin reaches this branch, so the noted detail may carry cost.
    -- A line written twice in one save is noted once, with its latest values (the note was dropped
    -- at the top of this function). Every line is listed; the shortfall is the approval log's.
    v_shortfall_cents := round((v_cost_cents - v_price_cents) * v_quantity)::bigint;
    v_pending := COALESCE(
      NULLIF(current_setting('app.crx_below_cost_pending', true), '')::jsonb,
      '{"seq": 0, "lines": {}}'::jsonb);
    v_pending_key := TG_TABLE_NAME || ':' || COALESCE(v_line_id::text, '');
    v_pending := jsonb_set(v_pending, ARRAY['lines', v_pending_key], v_detail || jsonb_build_object(
      'quantity', v_quantity,
      'line_shortfall_cents', v_shortfall_cents,
      'per', CASE WHEN TG_TABLE_NAME = 'invoice_items' AND v_product_id IS NULL THEN 'line' ELSE 'unit' END,
      'seq', (v_pending ->> 'seq')::bigint));
    v_pending := jsonb_set(v_pending, '{seq}', to_jsonb((v_pending ->> 'seq')::bigint + 1));
    PERFORM set_config('app.crx_below_cost_pending', v_pending::text, true);
    RETURN NEW;
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

-- Runs at commit, after the RPC has returned, for a row written while a below-cost line was noted. It keeps only the
-- noted lines whose row still exists (a line deleted later in the save, or an insert an ON CONFLICT turned into an update,
-- is not a sale). If any remain, it raises ONE refusal listing them in the order written; the save rolls back. If none
-- remain, it clears the note so the save's later queued events return at once. SECURITY DEFINER: a deferred trigger does
-- not run with the RPC's rights (gotchas.md), and the browser roles cannot read invoice_items.
CREATE FUNCTION public._raise_below_cost_reason_list()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pending jsonb := NULLIF(current_setting('app.crx_below_cost_pending', true), '')::jsonb;
  v_lines jsonb;
  v_total_cents bigint;
BEGIN
  IF v_pending IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT jsonb_agg(e.value - 'seq' ORDER BY (e.value ->> 'seq')::bigint),
         sum((e.value ->> 'line_shortfall_cents')::bigint)
    INTO v_lines, v_total_cents
    FROM jsonb_each(v_pending -> 'lines') AS e
   WHERE split_part(e.key, ':', 2) = ''
      OR CASE split_part(e.key, ':', 1)
           WHEN 'order_items' THEN EXISTS (SELECT 1 FROM public.order_items x WHERE x.id = split_part(e.key, ':', 2)::uuid)
           WHEN 'quote_items' THEN EXISTS (SELECT 1 FROM public.quote_items x WHERE x.id = split_part(e.key, ':', 2)::uuid)
           WHEN 'invoice_items' THEN EXISTS (SELECT 1 FROM public.invoice_items x WHERE x.id = split_part(e.key, ':', 2)::uuid)
           ELSE true
         END;
  IF v_lines IS NULL THEN
    PERFORM set_config('app.crx_below_cost_pending', '', true);
    RETURN NULL;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'BELOW_COST_REASON_REQUIRED:' || (
      ((v_lines -> 0) - 'quantity' - 'line_shortfall_cents' - 'per')
      || jsonb_build_object(
           'lines', v_lines,
           'line_count', jsonb_array_length(v_lines),
           'more_count', 0,
           'total_shortfall_cents', v_total_cents)
    )::text;
END;
$function$;

ALTER FUNCTION public._raise_below_cost_reason_list() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._raise_below_cost_reason_list() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._raise_below_cost_reason_list() TO service_role;

CREATE CONSTRAINT TRIGGER zzz_crx_below_cost_reason_list
  AFTER INSERT OR UPDATE ON public.order_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (COALESCE(current_setting('app.crx_below_cost_pending', true), '') <> '')
  EXECUTE FUNCTION public._raise_below_cost_reason_list();

CREATE CONSTRAINT TRIGGER zzz_crx_below_cost_reason_list
  AFTER INSERT OR UPDATE ON public.quote_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (COALESCE(current_setting('app.crx_below_cost_pending', true), '') <> '')
  EXECUTE FUNCTION public._raise_below_cost_reason_list();

CREATE CONSTRAINT TRIGGER zzz_crx_below_cost_reason_list
  AFTER INSERT OR UPDATE ON public.invoice_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (COALESCE(current_setting('app.crx_below_cost_pending', true), '') <> '')
  EXECUTE FUNCTION public._raise_below_cost_reason_list();

DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._enforce_below_cost_line()')
       AND ((SELECT count(*) FROM pg_proc o
              WHERE o.pronamespace = 'public'::regnamespace AND o.proname = '_enforce_below_cost_line') <> 1
        OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM '0490ba18edd0a9338e3329c6c984ff19'
        OR p.proowner <> 'postgres'::regrole
        OR NOT p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR p.provolatile <> 'v' OR p.proisstrict OR p.proleakproof OR p.proretset
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM ARRAY['postgres', 'service_role'])
  ) OR to_regprocedure('public._enforce_below_cost_line()') IS NULL THEN
    RAISE EXCEPTION 'BELOW_COST_LIST_POSTFLIGHT: _enforce_below_cost_line is not the body this file installs, or its header or grants changed';
  END IF;
  IF (SELECT coalesce(proacl::text, '') FROM pg_proc WHERE oid = 'public._enforce_below_cost_line()'::regprocedure)
       IS DISTINCT FROM current_setting('crx.bcl_acl', true) THEN
    RAISE EXCEPTION 'BELOW_COST_LIST_POSTFLIGHT: the ACL of _enforce_below_cost_line changed across the replacement';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._raise_below_cost_reason_list()')
       AND p.proowner = 'postgres'::regrole AND p.prosecdef
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres', 'service_role'])
  THEN
    RAISE EXCEPTION 'BELOW_COST_LIST_POSTFLIGHT: _raise_below_cost_reason_list has the wrong owner, settings or grants';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgname = 'zzz_crx_below_cost_reason_list'
         AND t.tgrelid IN ('public.order_items'::regclass, 'public.quote_items'::regclass, 'public.invoice_items'::regclass)
         AND t.tgfoid = 'public._raise_below_cost_reason_list()'::regprocedure
         AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled = 'O'
         AND t.tgqual IS NOT NULL) <> 3
     OR (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid = 'public._raise_below_cost_reason_list()'::regprocedure) <> 3 THEN
    RAISE EXCEPTION 'BELOW_COST_LIST_POSTFLIGHT: expected exactly three deferred list triggers (order, quote and invoice lines)';
  END IF;
  IF current_setting('crx.bcl_xid', true) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'BELOW_COST_LIST_POSTFLIGHT: the preflight did not run in this transaction; apply this file as ONE transaction';
  END IF;
END;
$postflight$;
