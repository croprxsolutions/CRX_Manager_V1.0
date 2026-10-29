-- Written 2026-10-29. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (placeholder row; the landing session assigns the final row).
-- Re-read the live ledger before applying.
--
-- WHAT: a customer may take more than is left on a booking (Mason 2026-10-26: "customers can take
--   more than they booked; the extra may be at the current price"; 2026-10-27: "the rep chooses,
--   default today"). Before this, Partial Order refused anything over with BOOKING_OVERDRAWN.
--   1. _draw_down_quote_below_cost_impl_20260810 (behind draw_down_quote): a draw line may carry
--      extra_price = 'today' | 'booked'. When its quantity is over what is left (and something is
--      left), the booking part draws what is left exactly as before, and the extra is written to a
--      second, ordinary order in the same transaction (booking_draw false, no quote_id; its
--      program notes and line notes name the booking and the booking order) at today's price for
--      the quote's tier or at the booked price of the last booked line, with today's cost. Stock
--      is pre-booked with the usual shortfall warning; commission, audit and activity rows are
--      written as for the booking order. The reply adds extra_order_id, extra_order_number and
--      extra_lines only when an extra order was written.
--   2. draw_down_quote: the request fingerprint includes extra_price when it is sent, so a retry
--      that changes the choice is a different request. A request without it fingerprints exactly
--      as before.
--   Every other line of the two re-emitted functions is their current body, extracted from a
--   replayed database on main 91487a92 (pinned below; the preflight refuses any drift).
--
-- WHY A SEPARATE ORDER (Taha 2026-10-29): the booking ledger (quote_product_draws), tier
--   attribution, void, cancel, close-remainder, settlement, rollover, the fully-drawn check and
--   the nightly integrity sweep all read a booking's orders as "never more than booked". Keeping
--   the extra off the booking keeps every one of them unchanged.
--
-- NOT CHANGED: every draw without extra_price, or within what is left (byte-for-byte the same
--   path); a booking with nothing left is still refused; the below-cost approval (an extra at the
--   booked price under today's cost needs an admin's approval with a reason, as any line does);
--   _draw_down_quote_intent_impl_20260819; grants. No rows change.
--
-- ROLLBACK (its own reviewed migration): re-emit both functions from the pinned pre-image
--   (sources: the latest migrations defining each). Orders written meanwhile stay valid orders.
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE booking_over_draw_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.booking_over_draw_tx') IS NULL THEN
    RAISE EXCEPTION 'BOOKING_OVER_DRAW_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.booking_over_draw_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'BOOKING_OVER_DRAW_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;

  -- The two re-emitted functions, pinned to their current body, owner, mode, search_path and
  -- EXECUTE grants. Each has exactly one overload.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('draw_down_quote', 'public.draw_down_quote(uuid,jsonb,uuid,text,text)',
          'cd3a7b1b398d69d1f44288f160d69e3d', ARRAY['authenticated', 'postgres']),
        ('_draw_down_quote_below_cost_impl_20260810', 'public._draw_down_quote_below_cost_impl_20260810(uuid,jsonb,uuid,text)',
          'e92324844af88051c4a20f773b7ac2bb', ARRAY['postgres'])
      ) AS pin(fn, sig, body_md5, execs)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc o
             WHERE o.pronamespace = 'public'::regnamespace AND o.proname = pin.fn) <> 1
        OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
        OR p.proowner <> 'postgres'::regrole
        OR NOT p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM pin.execs
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_DRAW_FUNCTION_DRIFT: a re-emitted function differs from its pinned body, owner, mode, search_path or grants';
  END IF;
END
$preflight$;

-- 1. The request fingerprint carries the rep's choice.
CREATE OR REPLACE FUNCTION public.draw_down_quote(p_quote_id uuid, p_draws jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_below_cost_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_canonical_draws jsonb;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  -- DRAW_DOWN_INTENT_BARRIER<<<
  -- Keep the cutover barrier first. The preserved private wrapper takes the
  -- same shared lock again, which is safe for the same transaction. This outer
  -- copy prevents intent work from starting while the tier cutover is active.
  IF NOT pg_try_advisory_xact_lock_shared(20260816, 1) THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CUTOVER_IN_PROGRESS: a draw-down maintenance change is being applied right now, so this draw was not recorded. Nothing was changed. Please try again in a moment.';
  END IF;
  -- >>>DRAW_DOWN_INTENT_BARRIER

  -- DRAW_DOWN_INTENT_AUTHZ<<<
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  -- >>>DRAW_DOWN_INTENT_AUTHZ

  -- DRAW_DOWN_INTENT_KEY_LOCK<<<
  -- Take the shared idempotency-key lock before the quote row lock. The helper
  -- below takes the same transaction-scoped lock again before reading the
  -- receipt; PostgreSQL advisory locks are re-entrant for the same session.
  -- This keeps lock order consistent with the helper's other money callers and
  -- prevents a same-key/cross-operation request from forming a key/row cycle.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key COLLATE "C" !~ '^[!-~]{1,200}$' THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REQUIRED: draw_down_quote requires p_idempotency_key';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_idempotency_key, 0)
  );
  -- >>>DRAW_DOWN_INTENT_KEY_LOCK

  -- Canonicalize exactly the entries the implementation will execute. Array
  -- order and duplicates remain meaningful because they become separate draw
  -- inputs/order lines; numeric spelling does not (1, 1.0 and 1.00 are one
  -- intent). Invalid/non-positive entries are skipped exactly as the mature
  -- implementation skips them.
  IF p_draws IS NULL
     OR jsonb_typeof(p_draws) <> 'array'
     OR jsonb_array_length(p_draws) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_draws) AS d(value)
     WHERE (d.value ->> 'product_id') IS NOT NULL
       AND NOT pg_input_is_valid(d.value ->> 'product_id', 'uuid')
  ) THEN
    RAISE EXCEPTION
      'BOOKING_PRODUCT_INVALID: draw product id must be a UUID';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_draws) AS d(value)
     WHERE (d.value ->> 'quantity') IS NOT NULL
       AND NOT pg_input_is_valid(d.value ->> 'quantity', 'numeric')
  ) THEN
    RAISE EXCEPTION
      'BOOKING_QUANTITY_INVALID: draw quantity must be numeric';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_draws) AS d(value)
     WHERE (d.value ->> 'quantity') IS NOT NULL
       AND (d.value ->> 'quantity')::numeric IN (
         'NaN'::numeric,
         'Infinity'::numeric,
         '-Infinity'::numeric
       )
  ) THEN
    RAISE EXCEPTION
      'BOOKING_QUANTITY_INVALID: draw quantity must be finite';
  END IF;

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'product_id', (d.value ->> 'product_id')::uuid,
               'quantity', trim_scale((d.value ->> 'quantity')::numeric)
             )
             -- OVER-DRAW (20261029110000): the rep's price for units over the booking is part of
             -- the request, so a retry that changes it is a different request. Absent = the
             -- fingerprint is exactly what it was before this change.
             || CASE WHEN d.value ? 'extra_price'
                     THEN jsonb_build_object('extra_price', d.value ->> 'extra_price')
                     ELSE '{}'::jsonb END
             ORDER BY d.ordinality
           ),
           '[]'::jsonb
         )
    INTO v_canonical_draws
    FROM jsonb_array_elements(p_draws) WITH ORDINALITY AS d(value, ordinality)
   WHERE (d.value ->> 'product_id') IS NOT NULL
     AND COALESCE((d.value ->> 'quantity')::numeric, 0) > 0;

  IF jsonb_array_length(v_canonical_draws) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          -- p_performed_by is deliberately absent: the strict ACTOR_MISMATCH
          -- guard above proves it is either NULL or exactly v_actor. If that
          -- guard is ever relaxed, p_performed_by MUST become fingerprint input.
          'actor_id', v_actor,
          'quote_id', p_quote_id,
          'draws', v_canonical_draws
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  -- The shared helper takes a transaction-scoped lock on the key. That closes
  -- same-key races even when two requests name different quote rows.
  -- DRAW_DOWN_INTENT_REPLAY<<<
  v_replay := public.check_idempotency_intent(
    p_idempotency_key,
    'draw_down_quote',
    v_actor,
    v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object'
       OR NULLIF(v_replay -> 'result' ->> 'order_id', '') IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;
  -- >>>DRAW_DOWN_INTENT_REPLAY

  -- DRAW_DOWN_INTENT_LIVE_QUOTE<<<
  -- A committed receipt is authoritative even if its quote was soft-deleted
  -- after the draw. For a first call, authorize and lock the live booking only
  -- after the exact actor/intent replay check. There is intentionally no
  -- created_by/customer-assignment predicate: active reps may cover one
  -- another's bookings. The inner money implementation takes the same row lock
  -- again before any business write.
  PERFORM 1
    FROM public.quotes
   WHERE id = p_quote_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found';
  END IF;
  -- >>>DRAW_DOWN_INTENT_LIVE_QUOTE

  -- This preserved wrapper still owns below-cost approval and forwards to the
  -- tier-split money implementation. p_below_cost_reason is approval metadata,
  -- not mutation identity, so it is deliberately absent from the fingerprint.
  -- DRAW_DOWN_INTENT_FIRST_CALL<<<
  v_result := public._draw_down_quote_intent_impl_20260819(
    p_quote_id,
    p_draws,
    p_performed_by,
    p_idempotency_key,
    p_below_cost_reason
  );

  IF v_result IS NULL
     OR jsonb_typeof(v_result) IS DISTINCT FROM 'object'
     OR NULLIF(v_result ->> 'order_id', '') IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  -- >>>DRAW_DOWN_INTENT_FIRST_CALL

  -- DRAW_DOWN_INTENT_BIND<<<
  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'draw_down_quote';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;
  -- >>>DRAW_DOWN_INTENT_BIND

  RETURN v_result;
END;
$function$;

-- 2. The draw writes the extra to its own order.
CREATE OR REPLACE FUNCTION public._draw_down_quote_below_cost_impl_20260810(p_quote_id uuid, p_draws jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_quote record;
  v_customer record;
  v_draw jsonb;
  v_product_id uuid;
  v_product_name text;
  v_qty numeric;
  v_booked numeric;
  v_drawn numeric;
  v_remaining numeric;
  v_total_acres numeric;
  v_unit_size text;
  v_inv record;
  v_net_position numeric;
  v_order_id uuid;
  v_order_number text;
  v_total_price numeric := 0;
  v_total_cost numeric := 0;
  v_total_profit numeric;
  v_total_margin_pct numeric;
  v_line_total numeric;
  v_line_cost numeric;
  v_shortfalls text[] := '{}';
  v_lines jsonb := '[]'::jsonb;
  v_hold record;
  v_to_consume numeric;
  v_fully_drawn boolean;
  v_line_count integer := 0;
  v_result jsonb;
  v_existing jsonb;
  -- LAYER2<<< job reservations consumed against this quote (§6.5)
  v_job_drawn numeric;
  -- >>>LAYER2
  -- TIERSPLIT<<< one order line per booked price tier (replaces the weighted
  -- average that could not be expressed in whole cents)
  v_tier record;
  v_tier_units numeric;
  v_tier_cost_unit numeric;
  v_tier_acres numeric;
  v_unmatched numeric;
  v_over numeric := 0;
  v_tier_count integer;
  v_skip numeric;
  v_take numeric;
  v_alloc_left numeric;
  -- OVER-DRAW (20261029110000)
  v_extra numeric;
  v_extra_choice text;
  v_extra_price numeric;
  v_extra_cost numeric;
  v_extra_net numeric;
  v_extra_order_id uuid;
  v_extra_order_number text;
  v_extra_total_price numeric := 0;
  v_extra_total_cost numeric := 0;
  v_extra_profit numeric;
  v_extra_lines jsonb := '[]'::jsonb;
  -- >>>TIERSPLIT
BEGIN
  PERFORM set_config('crx.chicago_date_cutover', '20260905200400', true);
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Lock the quote: serializes concurrent draws on the same booking.
  --
  -- deleted_at IS NULL is REQUIRED here (adversarial review 2026-08-16,
  -- CRX-RLS-001). Quotes are soft-deleted by stamping deleted_at only --
  -- src/pages/Quotes.tsx leaves status untouched -- so a deleted booking still
  -- reads as 'sent' and would sail past the BOOKING_CLOSED guard below. Without
  -- this predicate a deleted booking stays drawable by anyone holding its id,
  -- minting order lines, commissions, inventory reservations and ledger rows
  -- against a booking the business considers gone. The pre-existing body
  -- (20260702172000) omitted it; this migration closes that hole.
  --
  -- Cross-representative access is DELIBERATE, not an oversight: any active
  -- admin or sales_rep may draw any booking (owner decision, re-confirmed
  -- 2026-08-16), so reps can cover for one another. Do not add a created_by or
  -- customer-assignment predicate here without a fresh owner decision.
  SELECT * INTO v_quote
  FROM quotes
  WHERE id = p_quote_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  -- Idempotency check AFTER the lock (2026-06-10 HIGH fix): the row lock
  -- serializes same-key duplicates so the non-atomic check/save pair cannot
  -- both pass. Kept BEFORE the status guard so a retry of the final draw
  -- (which flips status to 'accepted') returns the cached result rather than
  -- BOOKING_CLOSED.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'draw_down_quote');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF v_quote.status NOT IN ('sent', 'revised') THEN
    RAISE EXCEPTION 'BOOKING_CLOSED: quote % is % — only sent or revised quotes can be drawn down', v_quote.quote_number, v_quote.status;
  END IF;

  IF p_draws IS NULL OR jsonb_typeof(p_draws) <> 'array' OR jsonb_array_length(p_draws) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_draws) d
    WHERE (d->>'product_id') IS NOT NULL AND COALESCE((d->>'quantity')::numeric, 0) > 0
  ) THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  v_order_number := generate_order_number();
  INSERT INTO orders (order_number, quote_id, customer_id, status, commission_split,
    total_price, total_cost, total_profit, total_margin_pct, order_date, program_notes)
  VALUES (v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    v_quote.commission_split, 0, 0, 0, 0, (now() AT TIME ZONE 'America/Chicago')::date,
    (SELECT string_agg(qs.section_name || ': ' || qs.section_header_notes, E'\n')
     FROM quote_sections qs WHERE qs.quote_id = p_quote_id
       AND qs.section_header_notes IS NOT NULL AND qs.section_header_notes <> ''))
  RETURNING id INTO v_order_id;
  -- A3<<< mark this order as a booking draw so void_order/cancel_order know
  -- to reverse the quote_product_draws ledger (20260610190000). Kept as a
  -- separate statement (not folded into the INSERT) so the body above stays
  -- byte-identical to the live baseline.
  UPDATE orders SET booking_draw = true WHERE id = v_order_id;
  -- >>>A3

  FOR v_draw IN SELECT * FROM jsonb_array_elements(p_draws) LOOP
    v_product_id := (v_draw->>'product_id')::uuid;
    v_qty := COALESCE((v_draw->>'quantity')::numeric, 0);
    IF v_product_id IS NULL OR v_qty <= 0 THEN CONTINUE; END IF;

    IF EXISTS (
      SELECT 1
      FROM quote_items qi
      WHERE qi.quote_id = p_quote_id
        AND qi.product_id = v_product_id
        AND COALESCE(qi.total_units_needed, 0) > 0
        AND (qi.cost_at_quote_cents IS NULL OR qi.cost_at_quote_cents <= 0)
    ) THEN
      RAISE EXCEPTION 'COST_BASIS_REQUIRED:%', v_product_id;
    END IF;

    -- TIERSPLIT / CRX-MONEY-002: refuse a draw whose booking carries a negative
    -- or non-finite quantity for this product.
    --
    -- v_booked below sums EVERY quote line for the product, negatives included,
    -- while the tier pool further down takes only lines with
    -- total_units_needed > 0. The averaging code this replaces read one
    -- weighted price over the same negative-inclusive set, so a negative line
    -- pulled the billed price DOWN. The split cannot do that, because a
    -- negative line has no tier to be billed at. A booking of 100 units at
    -- 2.00 and -50 units at 4.00 is worth nothing and still reports 50 units
    -- drawable: the old code billed those 50 at the 0.00 average, while the
    -- split would take all 50 from the 2.00 tier and invoice 100.00 against a
    -- booking worth 0.00. The conservation assertion cannot catch it -- the
    -- excluded negative line makes the tier pool LARGER than the balance, never
    -- smaller, and that assertion only fires when the pool is too small.
    --
    -- Nothing legitimate writes a negative: every quantity is either entered as
    -- a count or computed as acres x rate. Verified read-only against
    -- production on 2026-08-16 that no quote line holds a negative or
    -- non-finite quantity, and the CHECK added at the end of this migration
    -- makes that permanent. This body still refuses rather than trusting the
    -- constraint, because a constraint can be dropped and this path prices
    -- customer money.
    --
    -- NaN is caught by the finiteness half rather than the sign half:
    -- PostgreSQL orders NaN above every number, so NaN >= 0 is TRUE and only
    -- NaN < 'Infinity' rejects it. (Codex adversarial review 2026-08-16.)
    IF EXISTS (
      SELECT 1
      FROM quote_items qi
      WHERE qi.quote_id = p_quote_id
        AND qi.product_id = v_product_id
        AND qi.total_units_needed IS NOT NULL
        AND NOT (qi.total_units_needed >= 0 AND qi.total_units_needed < 'Infinity'::numeric)
    ) THEN
      RAISE EXCEPTION
        'BOOKING_QUANTITY_INVALID: % is booked on this quote with a negative or non-finite quantity, so the booking has no honest value to draw against; correct the quote first',
        COALESCE((SELECT product_name FROM products WHERE id = v_product_id), v_product_id::text);
    END IF;

    -- Per-product booking balance (locked quote => stable within this txn).
    -- TIERSPLIT: the weighted-average price and cost that used to be computed
    -- here are gone. They were the whole defect: an average of whole-cent tier
    -- prices is generally NOT a whole-cent price, and neither rounding it nor
    -- carrying it forward is safe. Per-tier figures are read below instead.
    SELECT
      SUM(COALESCE(qi.total_units_needed, 0)),
      SUM(COALESCE(qi.acres, 0)),
      MIN(qi.unit_size)
    INTO v_booked, v_total_acres, v_unit_size
    FROM quote_items qi
    WHERE qi.quote_id = p_quote_id AND qi.product_id = v_product_id;

    SELECT product_name INTO v_product_name FROM products WHERE id = v_product_id;

    IF v_booked IS NULL OR v_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: % is not booked on this quote', COALESCE(v_product_name, v_product_id::text);
    END IF;

    -- TIERSPLIT: a booked line with no price has no tier to be drawn at. The
    -- old averaging code silently skipped such a line inside SUM() and spread
    -- its quantity across the other tiers' prices; the split would instead
    -- write an order line with a NULL unit price, whose total_price and profit
    -- both come out NULL and quietly poison the order header. Refuse the draw
    -- with a specific error naming the product so the quote can be corrected.
    -- A zero price is deliberately still allowed: free goods are a real thing
    -- and the below-cost approval gate is the control for that, not this check.
    --
    -- UNREACHABLE TODAY, kept deliberately (drift review 2026-08-16, L1 /
    -- RLS review N1): quote_items.price_per_unit is NOT NULL live, so this
    -- cannot fire against the current schema. Read the paragraph above as the
    -- reason this guard exists, not as a description of a live failure mode.
    -- It is a cheap fail-closed backstop if that NOT NULL is ever relaxed --
    -- unlike the cost half of the tier key, which IS nullable today and does
    -- get a live guard (COST_BASIS_REQUIRED, just below).
    IF EXISTS (
      SELECT 1
      FROM quote_items qi
      WHERE qi.quote_id = p_quote_id
        AND qi.product_id = v_product_id
        AND COALESCE(qi.total_units_needed, 0) > 0
        AND qi.price_per_unit IS NULL
    ) THEN
      RAISE EXCEPTION
        'BOOKED_PRICE_REQUIRED: % has a booked line with no unit price; set a price on the quote before drawing it down',
        COALESCE(v_product_name, v_product_id::text);
    END IF;

    SELECT quantity_drawn INTO v_drawn
    FROM quote_product_draws
    WHERE quote_id = p_quote_id AND product_id = v_product_id;
    v_drawn := COALESCE(v_drawn, 0);
    -- LAYER2<<< job reservations also consume the booking (§6.5): subtract live
    -- job draws so demand a job already reserved can't be re-drawn to an order
    -- (no double-fulfilment via transfer_job_to_invoice + a later order draw).
    SELECT COALESCE(SUM(quantity_drawn), 0) INTO v_job_drawn
    FROM job_product_draws
    WHERE quote_id = p_quote_id AND product_id = v_product_id;
    v_remaining := GREATEST(v_booked - v_drawn - v_job_drawn, 0);
    -- OVER-DRAW (20261029110000, Mason 2026-10-26/27): a customer may take more than is left on
    -- the booking once the rep has chosen the price for the extra: 'today' (the screen's default)
    -- or 'booked'. Everything below draws only what is left, exactly as before; the extra is
    -- written after it as an ordinary order (not a booking draw), so the booking ledger, tier
    -- attribution, voids, cancels and settlement never see more than was booked. With no choice
    -- the request is refused as before. A booking with nothing left is still refused.
    v_extra := 0;
    v_extra_choice := v_draw ->> 'extra_price';
    IF v_extra_choice IS NOT NULL AND v_extra_choice NOT IN ('today', 'booked') THEN
      RAISE EXCEPTION 'DRAW_EXTRA_PRICE_INVALID: extra_price must be today or booked';
    END IF;
    IF v_qty > v_remaining AND v_remaining > 0 AND v_extra_choice IS NOT NULL THEN
      v_extra := v_qty - v_remaining;
      v_qty := v_remaining;
    END IF;
    IF v_qty > v_remaining THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: %: requested %, only % remaining (booked %, already drawn %)',
        COALESCE(v_product_name, v_product_id::text), v_qty, v_remaining, v_booked, (v_drawn + v_job_drawn);
    END IF;
    -- >>>LAYER2  (baseline: v_remaining := GREATEST(v_booked - v_drawn, 0); and
    -- the message's last arg was v_drawn — text is unchanged, only the value.)

    -- TIERSPLIT<<< emit one order line per booked price tier.
    -- Acres are NOT prorated from a whole-draw figure any more. Each emitted
    -- line takes the share of its OWN booked line's acreage that the draw takes
    -- of that line's OWN units -- see the long note at the write site (Codex
    -- review 2026-08-16, P2 3793063419). v_total_acres is still read above for
    -- the booking-level checks; it no longer feeds the per-line figure.

    -- WHICH TIERS ARE ALREADY USED UP.
    --
    -- An earlier draft of this migration answered that by counting how many
    -- units had been drawn in total (quote_product_draws.quantity_drawn plus
    -- live job reservations) and walking that many units down the tier list.
    -- That is unsound, and the reason is worth stating plainly because it is
    -- the defect this block exists to avoid:
    --
    --   Those totals go DOWN as well as up. void_order/cancel_order subtract
    --   from quantity_drawn (20260610185806), and job_product_draws rows are
    --   deleted outright when a job is cancelled or re-reserved. A running
    --   total that moves backwards is not a position in an ordered list. Draw
    --   tier A, draw tier B, then void the FIRST order, and the total falls
    --   back to one tier's worth -- so the next draw is priced from tier B a
    --   second time. Tier A is never sold, tier B is sold twice, and 200 units
    --   quoted at 100 x $1.00 + 100 x $2.00 bill $400 instead of $300.
    --
    -- So attribution is derived instead from the order lines that ACTUALLY
    -- still bill the customer, keyed on WHICH QUOTE LINE each was drawn from.
    -- Every line this body writes stamps order_items.quote_item_id, so a tier
    -- is consumed exactly to the extent that live lines name it.
    --
    -- WHY AN IDENTITY AND NOT THE TIER KEY (Codex review 2026-08-16, P1
    -- 3792521137 / 3792687211). The previous version keyed attribution on the
    -- pair (price_per_unit, cost_at_time_cents) carried by each order line.
    -- That key is neither unique nor immutable, and both failures cost money.
    --
    -- NOT UNIQUE: two quote lines at the same price and cost collapsed into one
    -- tier, so a booking reading 100 @ A, 100 @ B, 100 @ A billed the two A
    -- lines as a single 200-unit block sitting at the FRONT of the list. The
    -- customer's own document order was not what got drawn.
    --
    -- NOT IMMUTABLE (drift review 2026-08-16, H2 and M1). The cost half of the
    -- key moves in three distinct ways, and the earlier version of this comment
    -- named only the first:
    --
    --   1. _enforce_below_cost_line fires BEFORE INSERT OR UPDATE OF
    --      product_id, price_per_unit, total_units_needed on order_items
    --      (20260812115237:561-564) and, when the declared operation is one of
    --      create_direct_order / bulk_import_order / update_order_items /
    --      price_order, overwrites cost_at_time_cents with TODAY's catalog cost
    --      (:484-490). That rewrite is gated on the declared OPERATION, not on
    --      which column changed, so an edit to ANY of those three watched
    --      columns triggers it -- and an edit to the price rewrites BOTH halves
    --      of the tier key at once, not just the cost half.
    --   2. trg_resnapshot_order_item_cost (20260812115235:97-104) fires BEFORE
    --      UPDATE ON order_items WHEN (NEW.product_id IS DISTINCT FROM
    --      OLD.product_id) and re-snapshots cost_at_time_cents to today's
    --      catalog cost. Unlike vector 1 it is NOT gated by the four-operation
    --      list -- but it IS narrower than the trigger definition alone
    --      suggests (drift review 2026-08-16, L2): its body
    --      (20260812115235:71-92) only rewrites the snapshot when the caller
    --      left it alone (NEW.cost_at_time_cents IS NOT DISTINCT FROM OLD) and
    --      NEW.product_id IS NOT NULL, and it COALESCEs back to the old
    --      snapshot when the new product's current_cost is NULL. So it cannot
    --      clobber a cost the caller set deliberately, and it never erases one.
    --      A product swap also moves the line out of the original product's
    --      attribution set entirely, since both queries below filter on
    --      oi.product_id = v_product_id.
    --   3. A direct UPDATE order_items SET cost_at_time_cents = ... fires no
    --      trigger at all. order_items carries five triggers in the migration
    --      tree and NONE of them watches cost_at_time_cents (drift review
    --      2026-08-16, L3 -- an earlier draft of this list named only three and
    --      read as exhaustive): the below-cost trigger watches product_id /
    --      price_per_unit / total_units_needed, guard_order_item_delivery_
    --      lineage watches order_id / product_id (20260721014858:734-737), the
    --      money-rounding trigger watches total_price / profit / cost_per_unit
    --      / total_units_needed (20260809230500:263-267), the resnapshot
    --      trigger in vector 2 watches product_id, and the INSERT-time snapshot
    --      trigger is INSERT-only. Repair migrations do exactly this.
    --
    -- Under the OLD key any of these orphaned a billed line from its tier. That
    -- failure was fail-CLOSED -- the tiers stopped summing to the drawn
    -- quantity, so the conservation assert refused the whole draw with
    -- DRAW_ALLOCATION_MISMATCH rather than mis-pricing or double-selling --
    -- but it refused LEGITIMATE draws until an admin intervened.
    --
    -- Keying on quote_items.id retires all three. It is a primary key: no
    -- trigger writes it, no repair migration re-snapshots it, and it does not
    -- collapse two lines into one. The vectors above are recorded because they
    -- are still true of the COLUMNS -- an admin edit still moves a line's cost
    -- snapshot, and anything else that reasons off that pair inherits the
    -- problem -- but they no longer reach tier attribution.
    --
    -- WHAT THE STAMP SURVIVES, and what still gets past it:
    -- save_quote DELETEs quote_sections on every revision, cascading to
    -- quote_items, and reinserts them. The deferred FK installed near the end
    -- of this file moves the referential check to COMMIT, and save_quote reuses
    -- the same quote_items id on both of its paths, so an ordinary revision
    -- leaves every stamp intact. A stamp can no longer be ORPHANED at all: the
    -- FK is still NO ACTION, so a save that failed to bring an id back would
    -- abort the whole transaction rather than commit a dangling reference.
    --
    -- What still lands unattributed is narrower, and both cases are covered the
    -- same way: lines written before this migration, which carry no stamp; and
    -- lines whose quote line survives but is no longer a TIER, because its
    -- total_units_needed was edited to 0. Those fall into v_unmatched below,
    -- walk off the FRONT of the list, and are REFUSED outright by
    -- DRAW_MIXED_TIER_UNMATCHED_LINE the moment the product carries more than
    -- one distinct (price, cost). So the front-walk only ever runs where every
    -- tier row shares one price and one cost, and at a single price which
    -- identically-priced line a unit came off cannot change the bill.
    --
    -- Cancelled/voided are the two reversal states in orders_status_check
    -- ('confirmed','partially_fulfilled','fulfilled','cancelled','voided'),
    -- and they reverse DIFFERENT amounts, so they are treated differently:
    --
    --   void_order   subtracts the FULL quantity from quantity_drawn
    --                (20260610185806:493-505). A voided order therefore holds
    --                no booking balance at all, so its lines drop out entirely
    --                and the whole tier returns to the pool.
    --   cancel_order subtracts only the UNDELIVERED portion
    --                (20260610185806:807-820). Delivered units stay drawn and
    --                stay billed, so they must keep holding their tier -- only
    --                the undelivered remainder returns to the pool.
    --
    -- In practice a cancel of a partially delivered order does not land in
    -- 'cancelled' at all: cancel_order routes 'partially_fulfilled' orders to
    -- _close_undelivered_order_remainder_20260718 (20260721014858:1358), which
    -- shrinks total_units_needed to quantity_delivered (:1139) and ends at
    -- 'fulfilled' (:1151) -- so those orders stay in this set at exactly their
    -- surviving quantity via the ELSE branch. The 'cancelled' CASE below is
    -- therefore a no-op on current data (verified read-only against live
    -- 2026-08-16: zero cancelled, confirmed, or voided orders carry delivered
    -- units, and zero quote/product pairs bill more units than are drawn). It
    -- is written anyway because no CHECK constraint enforces that invariant,
    -- and if it ever slipped, excluding cancelled lines outright would free a
    -- tier that is still being billed and re-sell it.
    --
    -- Soft-deleted ORDERS (orders.deleted_at -- order_items has no such column)
    -- are deliberately NOT excluded: a soft delete does not reverse
    -- quantity_drawn, so dropping those lines here would desync attribution from
    -- the balance guard above.
    --
    -- Job reservations DO consume a tier, and are taken off the front with the
    -- legacy lines below. They hold booking balance (already subtracted from
    -- v_remaining above) but they write no order_items row, so nothing in the
    -- `billed` set can see them. Leaving them out would hand the tier they are
    -- holding back to the next order -- the same unit sold twice, once on the
    -- job and once on the order.
    --
    -- Which tier a job should consume is a business choice, not a technical
    -- one. Job chemicals are billed at their own price
    -- (job_chemicals.price_per_unit_cents, 20260713060000:312,547), so the job
    -- document's total does not change either way; what changes is which tiers
    -- are left for the customer's later orders. Front-of-list is chosen here
    -- because it is the same convention the legacy averaged code implicitly
    -- used, it conserves quantity, and it is the only option that cannot
    -- re-sell a tier. If Mason wants job draws to consume the LAST tier
    -- instead (leaving the cheaper tiers for orders), that is a one-line change
    -- to the ORDER BY this skip walks -- it is not a correctness fix.
    --
    -- No live data depends on this today: verified read-only 2026-08-16 that
    -- job_product_draws is empty and no quote has more than one price tier for
    -- the same product.
    --
    -- Legacy lines drawn under the old weighted-average code carry an averaged
    -- price that matches no tier key. They are counted here and taken off the
    -- FRONT of the tier list, which is the position the averaged code
    -- implicitly assumed. It conserves quantity and degrades to a no-op once
    -- there are none. (Verified read-only against live 2026-08-15: no quote
    -- has more than one price tier for the same product, so no such line
    -- exists today -- this is a defensive path, not a live migration concern.)
    SELECT COALESCE(SUM(
             CASE WHEN o.status = 'cancelled'
                  THEN COALESCE(oi.quantity_delivered, 0)
                  ELSE COALESCE(oi.total_units_needed, 0)
             END), 0)
    INTO v_unmatched
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.quote_id = p_quote_id
      AND o.booking_draw IS TRUE
      AND o.status <> 'voided'
      AND oi.product_id = v_product_id
      -- "This billed line names no tier row that still exists." The mirror
      -- half of the LEFT JOIN further down, which is now keyed on the same
      -- identity (Codex review 2026-08-16, P1 3792521137 / 3792687211).
      --
      -- Two populations fall in here, and both want the same treatment:
      --
      --   1. quote_item_id IS NULL -- written by the pre-cutover body, which
      --      stamped nothing. `qi.id = NULL` is never true, so these are caught
      --      with no special case.
      --   2. quote_item_id names a line that survives but is no longer a tier
      --      (its total_units_needed was edited to 0 or below).
      --
      -- A third population -- "quote_item_id names a quote line that no longer
      -- exists" -- was listed here while the FK was ON DELETE SET NULL, and is
      -- now unreachable. The FK is NO ACTION DEFERRABLE INITIALLY DEFERRED, so
      -- a revision that failed to bring an id back aborts at COMMIT instead of
      -- committing an orphan. Nothing can leave a stamp pointing at a deleted
      -- quote line. This test still tolerates it (the NOT EXISTS simply
      -- matches), so the code stays correct if that ever changes -- but no live
      -- route produces it.
      --
      -- All three are counted into v_unmatched, walked off the FRONT of the
      -- document-ordered tier list by v_skip, and -- crucially -- refused
      -- outright by DRAW_MIXED_TIER_UNMATCHED_LINE below whenever the product
      -- carries more than one distinct (price, cost). That refusal is what
      -- makes the front-walk sound rather than a guess: it only ever runs on a
      -- product whose every tier row carries ONE price and ONE cost, and at a
      -- single price it cannot matter which identically-priced line a unit came
      -- off. Where the stamp is missing the fallback is therefore "match on
      -- today's price and cost", and where even that is ambiguous the draw
      -- stops instead of guessing.
      --
      -- The old form of this test compared (price_per_unit, cost_at_time_cents)
      -- with IS NOT DISTINCT FROM on both halves, mirroring the old join. That
      -- discipline is retired with the key it protected: quote_items.id is a
      -- NOT NULL primary key, so `=` is total here and the NULL-vs-NULL hazard
      -- is gone. What must still be mirrored is the PARTITION -- a billed line
      -- has to be counted by exactly one of this test and that join, or the
      -- same units are billed twice or freed while still billed. If either side
      -- is edited, edit both.
      --
      -- One asymmetry with the tiers CTE is deliberate and worth naming (drift
      -- review 2026-08-16, L6): tiers additionally INNER JOINs quote_sections
      -- for its ordering columns, and this NOT EXISTS does not. That cannot
      -- drop a row, because quote_items.section_id is NOT NULL and REFERENCES
      -- quote_sections(id) ON DELETE CASCADE (20260206172436:176), so the join
      -- is total. The partition is exact -- but it leans on that foreign key,
      -- so if it is ever dropped this test must join quote_sections too.
      AND NOT EXISTS (
        SELECT 1
        FROM quote_items qi
        WHERE qi.id = oi.quote_item_id
          AND qi.quote_id = p_quote_id
          AND qi.product_id = v_product_id
          AND COALESCE(qi.total_units_needed, 0) > 0
      );

    -- Fail closed on a mixed-tier booking whose billed lines no longer name a
    -- tier that exists. Consuming those units off the FRONT of the list, as the
    -- block above does, is only sound when they really did come off the front.
    -- That holds for the legacy averaged body, which priced a whole product at
    -- one figure, and it holds for any product whose tier rows all share one
    -- price and one cost. It does NOT hold on a genuinely mixed booking.
    --
    -- The stamp makes this rarer than it was but does not remove it, and the
    -- guard is deliberately kept exactly as fail-closed as before (this is the
    -- "keep every existing refusal" half of the 2026-08-16 provenance rework).
    -- Two live routes still land here:
    --
    --   1. Lines drawn before this migration, which carry no stamp at all.
    --   2. A quote line that survives a revision but is edited down to zero
    --      units, so it stops being a tier while lines billed against it are
    --      still standing.
    --
    -- A revision ORPHANING a stamp is no longer one of them: the deferred FK
    -- keeps the id alive across save_quote's delete-and-reinsert, and refuses
    -- to commit if it ever did not.
    --
    -- Worked example (Codex review 2026-08-16, CRX-MONEY-TIER-001, restated for
    -- the stamp): book 100 units at $1.00 and 100 at $2.00; draw the $1.00 tier
    -- in full and 50 of the $2.00 tier; void the $1.00 order, which returns
    -- that tier to the pool; revise the quote so the surviving line's stamp
    -- names a quote line that no longer exists; draw the remaining 150. Without
    -- this refusal the orphaned 50 units come off the front and the booking
    -- bills $350.00 against a $300.00 order. DRAW_ALLOCATION_MISMATCH below
    -- cannot see it: that assertion fires only when the pool is too SMALL to
    -- absorb the draw, never when it is too large.
    --
    -- This same refusal is the net under the cutover race described at the top
    -- of this file. A legacy averaged draw that commits just after the preflight
    -- scan leaves precisely this trace -- billed units naming no live tier --
    -- so the next draw on that booking stops loudly instead of quietly
    -- misbilling the remainder.
    --
    -- Still counted on (price, cost), NOT on the number of tier ROWS, and that
    -- is the point rather than a leftover: two quote lines at the SAME price
    -- and cost are now two separate tier rows, but which of them an unstamped
    -- unit came off cannot change what the customer is billed. Counting rows
    -- here would refuse a perfectly determinate draw -- e.g. the same product
    -- booked into two fields at one price, drawn once before this migration.
    -- Distinct (price, cost) is exactly the condition under which the
    -- front-walk stops being money-exact.
    SELECT count(DISTINCT (qi.price_per_unit, qi.cost_at_quote_cents))
    INTO v_tier_count
    FROM quote_items qi
    WHERE qi.quote_id = p_quote_id
      AND qi.product_id = v_product_id
      AND COALESCE(qi.total_units_needed, 0) > 0;

    IF COALESCE(v_tier_count, 0) > 1 AND COALESCE(v_unmatched, 0) > 0 THEN
      RAISE EXCEPTION
        'DRAW_MIXED_TIER_UNMATCHED_LINE: % unit(s) already billed against this booking for % do not name any of its % booked price tiers, so which tiers those units consumed is not known. Drawing more could bill the same units twice. Void and re-book the order(s) holding those units, or undo the quote revision that changed those lines, then re-try.',
        v_unmatched, COALESCE(v_product_name, v_product_id::text), v_tier_count;
    END IF;

    -- Job reservations consume from the front alongside the legacy lines.
    v_skip := COALESCE(v_unmatched, 0) + COALESCE(v_job_drawn, 0);
    v_over := 0;

    v_alloc_left := v_qty;

    FOR v_tier IN
      WITH tiers AS (
        SELECT
          -- IMMUTABLE TIER PROVENANCE (Codex review 2026-08-16, P1 x2 --
          -- 3792521137 and 3792687211). A "tier" is now ONE QUOTE LINE, not a
          -- (price, cost) bucket aggregated across lines.
          --
          -- The old GROUP BY (price, cost) merged every quote line sharing a
          -- key into a single tier, and that merge caused two distinct money
          -- defects that no amount of downstream patching could reach:
          --
          --   1. INTERLEAVING. A booking reading 100 @ A, 100 @ B, 100 @ A
          --      collapsed to A=200, B=100, and the merged A sorted to A's
          --      FIRST document position. A 150-unit draw then billed all 150
          --      at A, where consuming the document top-down owes 100 A and
          --      50 B. The customer was billed the wrong tier's price.
          --   2. ROUNDING BOUNDARY. Merging two lines moved the cumulative
          --      rounding basis off the boundary save_quote booked them at.
          --      Two 0.5-unit lines at $1.01 book 0.51 + 0.51 = $1.02; merged
          --      into one 1.0-unit tier they extend to $1.01, underbilling a
          --      cent per merged pair.
          --
          -- Keying on qi.id fixes both at the source: lines never merge, each
          -- keeps its own document position, and each rounds against its own
          -- booked extension. It also gives every line written below a real
          -- quote_item_id to stamp, which is what lets the next draw match
          -- billed lines back EXACTLY instead of guessing by (price, cost).
          qi.id                  AS quote_item_id,
          qi.price_per_unit      AS price,
          qi.cost_at_quote_cents AS cost_cents,
          COALESCE(qi.total_units_needed, 0) AS units,
          -- Per-LINE now, not per-(price,cost)-bucket. The write site below
          -- still takes COALESCE(v_tier.unit_size, v_unit_size), so a line
          -- with no pack size falls back to the product-level value exactly as
          -- before (RLS review 2026-08-16, M1).
          qi.unit_size           AS unit_size,
          -- Per-LINE booked acreage, replacing the by-quantity proration the
          -- write site used to do (Codex review 2026-08-16, P2 3793063419).
          -- Splitting one draw's acres in proportion to units is wrong the
          -- moment two lines carry different rates: 100u/100ac + 100u/10ac
          -- drew two 55-acre lines, a figure neither line was booked at, and
          -- complete_delivery copies acres into invoice_items. With the line's
          -- own identity in hand its own booked acreage is simply available.
          qi.acres               AS line_acres,
          COALESCE(qi.total_units_needed, 0) AS line_units,
          -- Document order is (section position, then line position within the
          -- section). quote_items.sort_order restarts per section, so ordering
          -- on it alone ties two lines that sit in different sections and falls
          -- through to price -- which is not the order the customer sees.
          -- Both columns are NOT NULL live, so no COALESCE is needed.
          --
          -- No longer an aggregate at all. The earlier version had to take
          -- element 1 of an array_agg to keep (section, line) an atomic pair
          -- while collapsing many lines into one tier; one row per line makes
          -- the genuine document position directly available, so the class of
          -- bug that fix defended against cannot arise here.
          qs.sort_order          AS section_ord,
          qi.sort_order          AS ord
        FROM quote_items qi
        JOIN quote_sections qs ON qs.id = qi.section_id
        WHERE qi.quote_id = p_quote_id
          AND qi.product_id = v_product_id
          -- > 0, whereas v_booked above sums over ALL of the product's quote
          -- lines with no such filter (drift review 2026-08-16, L5). A
          -- zero-unit line is harmless either way. A NEGATIVE one -- which no
          -- CHECK currently forbids on quote_items.total_units_needed -- makes
          -- the two disagree, and it is worth being precise about WHICH guard
          -- covers that, because the first version of this comment named the
          -- wrong one (RLS review 2026-08-16, M2).
          --
          -- The negative line SUBTRACTS from v_booked and is excluded from the
          -- tiers, so the tier pool comes out LARGER than the balance, never
          -- smaller: sum(tiers) >= v_booked >= v_remaining >= v_qty. The
          -- allocation assertion below fires only when the pool is too SMALL to
          -- absorb the draw, so it cannot fire on this case at all. What
          -- actually holds the line is the v_remaining balance guard further
          -- up, which caps the draw at booked-minus-drawn using the reduced
          -- v_booked -- so the customer is never billed for more units than the
          -- (negative-inclusive) booking supports, and every unit billed still
          -- comes from a real positive tier at that tier's own price.
          AND COALESCE(qi.total_units_needed, 0) > 0
      ),
      -- Units still billed to the customer. Voided orders drop out entirely;
      -- cancelled orders keep only their delivered units. Same rule as v_skip
      -- above -- see the long comment there for why the two reversal states
      -- differ.
      --
      -- KEYED BY PROVENANCE (Codex review 2026-08-16, P1 3792521137 /
      -- 3792687211). Every line this body writes carries the id of the quote
      -- line it was drawn from, so it can be matched back EXACTLY. Lines
      -- written by the OLD body carry NULL there and are handled separately
      -- below, by the same front-walk v_skip has always used.
      --
      -- SPLIT AGAIN BY PRICE (Mason's rule, 2026-08-19). Changing the price on
      -- a partly-drawn booking must not rewrite what the customer was already
      -- billed: already-drawn units KEEP the price they were billed at, and
      -- only the units still owing use the new price. A genuine early-price
      -- error is corrected with a credit memo, not by silently rebilling
      -- delivered product.
      --
      -- So each tier's history divides in two, on whether the order line was
      -- billed at the price the quote line carries TODAY:
      --
      --   * units_current / money -- billed at the current price. These are
      --     still "live" against this price, so they remain the telescoping
      --     rounding basis: the next draw bills the running total of the whole
      --     price band minus the cents already standing in it, which is what
      --     stops four 0.25-unit draws on a $1.01 tier from billing $1.00.
      --   * units_settled -- billed at some other price. These are FINISHED.
      --     They still consume the tier's capacity (the customer has had that
      --     product and been billed for it, so it is no longer available to
      --     draw), but they are never re-based and their money never enters
      --     the basis. Re-basing them is exactly the rebilling Mason ruled out.
      --
      -- The comparison is against ti.price -- the quote line's price_per_unit
      -- as it stands now -- not against a remembered figure, so it re-partitions
      -- correctly if the price is changed again, or changed back.
      --
      -- IS NOT DISTINCT FROM, not =, so a NULL price on a billed line lands in
      -- units_settled rather than vanishing from both halves. ti.price itself
      -- cannot be NULL here: BOOKED_PRICE_REQUIRED above refuses the draw on a
      -- booked line with units > 0 and no price, and tiers only carries lines
      -- with units > 0. Numeric equality is exact-decimal in PostgreSQL and
      -- ignores trailing-zero scale, so 1.00 and 1.0000 match as they should.
      --
      -- The JOIN to tiers is what makes ti.price reachable. It cannot change
      -- which rows are counted: the outer LEFT JOIN below already keeps only
      -- billed rows whose quote_item_id names a live tier, and every billed row
      -- that does NOT is counted by the v_unmatched front-walk instead. The
      -- partition against v_unmatched is therefore unchanged -- still exactly
      -- one side per billed line.
      billed_stamped AS (
        SELECT
          oi.quote_item_id       AS quote_item_id,
          -- Units billed at the tier's CURRENT price -- the live rounding basis.
          SUM(
            CASE WHEN oi.price_per_unit IS NOT DISTINCT FROM ti.price
                 THEN CASE WHEN o.status = 'cancelled'
                           THEN COALESCE(oi.quantity_delivered, 0)
                           ELSE COALESCE(oi.total_units_needed, 0)
                      END
                 ELSE 0
            END) AS units_current,
          -- Units billed at some OTHER price -- settled. Capacity only.
          SUM(
            CASE WHEN oi.price_per_unit IS DISTINCT FROM ti.price
                 THEN CASE WHEN o.status = 'cancelled'
                           THEN COALESCE(oi.quantity_delivered, 0)
                           ELSE COALESCE(oi.total_units_needed, 0)
                      END
                 ELSE 0
            END) AS units_settled,
          -- MONEY actually standing against this tier key AT THE CURRENT PRICE,
          -- in dollars, on the same surviving quantity units_current counts
          -- (Codex push-proof 2026-08-16, CRX-MONEY-LIFECYCLE-001, High).
          --
          -- The money and the units MUST describe the same surviving rows, so
          -- the cancelled branch is mirrored here: a cancelled order keeps only
          -- its delivered units, so it may keep only the value of those units,
          -- not the whole line's total_price. Valuing them at the line's own
          -- price_per_unit is exact -- that is the price they were billed at.
          --
          -- Settled money is deliberately absent. It is not zero and it is not
          -- forgotten: it stands on the invoice exactly as billed. It simply
          -- takes no part in the arithmetic for the units still owing, because
          -- those units are priced from a fresh basis at the new price.
          --
          -- Why this column has to exist at all: the previous version re-based
          -- the running total on surviving UNITS and assumed the surviving
          -- lines held ROUND(price * units, 2) cents. A void breaks that
          -- assumption. Two 0.25-unit draws at $0.50 write $0.13 and $0.12;
          -- void the FIRST and 0.25 surviving units carry $0.12, not $0.13, so
          -- a units-only basis re-billed $0.12 and left the customer charged
          -- $0.24 for half a unit that costs $0.25. Which of two identical
          -- draws was voided must not change the bill.
          SUM(
            CASE WHEN oi.price_per_unit IS NOT DISTINCT FROM ti.price
                 THEN CASE WHEN o.status = 'cancelled'
                           THEN ROUND(COALESCE(oi.price_per_unit, 0)
                                      * COALESCE(oi.quantity_delivered, 0), 2)
                           ELSE COALESCE(oi.total_price, 0)
                      END
                 ELSE 0
            END) AS money
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        JOIN tiers ti ON ti.quote_item_id = oi.quote_item_id
        WHERE o.quote_id = p_quote_id
          AND o.booking_draw IS TRUE
          AND o.status <> 'voided'
          AND oi.product_id = v_product_id
          AND oi.quote_item_id IS NOT NULL
        GROUP BY oi.quote_item_id
      )
      SELECT
        t.quote_item_id,
        t.price,
        t.cost_cents,
        t.unit_size,
        t.line_acres,
        t.line_units,
        -- What this tier still has available to draw. BOTH halves of the
        -- billed history are subtracted: units already billed at the current
        -- price, and units settled at an earlier price. A settled unit has been
        -- delivered and charged, so it is gone from the booking whatever price
        -- it went out at -- treating it as still available would sell the same
        -- product twice.
        --
        -- GREATEST(..., 0) clamps PER TIER (drift review 2026-08-16, L7) so a
        -- negative tier cannot silently eat a neighbour's units.
        --
        -- The clamp alone is NOT sufficient, and an earlier version of this
        -- comment wrongly said it was ("bounded on both sides regardless by the
        -- v_remaining balance guard and DRAW_ALLOCATION_MISMATCH"). Neither
        -- bound sees an over-billed tier. v_remaining works on PER-PRODUCT
        -- aggregates, and DRAW_ALLOCATION_MISMATCH fires only when the pool is
        -- too SMALL. So the excess this clamp discards was invisible. It is
        -- carried out as the "over" column below and refused after the loop
        -- (DRAW_TIER_OVERCONSUMED). See that guard for the worked example.
        GREATEST(
          t.units
            - COALESCE(b.units_current, 0)
            - COALESCE(b.units_settled, 0), 0) AS units,
        -- Units billed against this tier BEYOND what the tier now holds --
        -- exactly the quantity the clamp above throws away. Counted across both
        -- halves, for the same reason: an over-draw is an over-draw whether the
        -- excess was billed at today's price or an earlier one.
        GREATEST(
          COALESCE(b.units_current, 0)
            + COALESCE(b.units_settled, 0)
            - t.units, 0) AS over,
        -- Units already billed at this tier's CURRENT price by earlier draws.
        -- This is the rounding BASIS for the money below, not a quantity the
        -- loop spends. See the telescoping comment at v_line_total.
        --
        -- Settled units are excluded on purpose. That is the whole of Mason's
        -- rule in one expression: a unit billed at a price the quote no longer
        -- carries is finished, so it must not appear in a running total that
        -- the next draw subtracts money from. If it did, the new units would be
        -- billed the difference between the old and new price on quantity the
        -- customer has already paid for -- a silent rebill.
        --
        -- Clamped to the current-price budget the line still has, which is its
        -- booked units less what is settled. (The over-billed excess is refused
        -- separately by DRAW_TIER_OVERCONSUMED, and that guard aborts the whole
        -- transaction, so the clamp cannot ship a wrong number -- it only keeps
        -- this column from going out of range on a run that is about to roll
        -- back anyway.)
        LEAST(
          COALESCE(b.units_current, 0),
          GREATEST(t.units - COALESCE(b.units_settled, 0), 0)) AS prior,
        -- Cents already standing against this tier key AT THE CURRENT PRICE.
        -- Deliberately NOT clamped the way "prior" is: this is a statement of
        -- fact about money that has been billed, and shrinking it would
        -- re-invent the very assumption CRX-MONEY-LIFECYCLE-001 was about --
        -- that the surviving lines hold whatever the arithmetic says they
        -- should. The one case where it can exceed the tier's own extension is
        -- an over-billed tier, which DRAW_TIER_OVERCONSUMED refuses outright
        -- after the loop; the GREATEST at v_line_total keeps the interim value
        -- in range until that guard aborts the transaction.
        COALESCE(b.money, 0) AS money
      FROM tiers t
      LEFT JOIN billed_stamped b
        -- EXACT provenance, replacing the (price, cost) key this join used to
        -- carry (Codex review 2026-08-16, P1 3792521137 / 3792687211).
        --
        -- quote_items.id is a NOT NULL primary key and order_items.quote_item_id
        -- REFERENCES it, so plain `=` is total here and there is no NULL-vs-NULL
        -- question to get wrong -- billed_stamped already filters
        -- quote_item_id IS NOT NULL, and the tiers side is a primary key. The
        -- long-standing IS NOT DISTINCT FROM discipline that used to live in
        -- this comment existed only because the old key included a NULLABLE
        -- cost column; keying on an identity retires that hazard rather than
        -- managing it.
        --
        -- What DOES still have to be mirrored token for token is the partition
        -- rule: a billed line must be counted by EXACTLY ONE of this join and
        -- the v_unmatched front-walk above, or the same units are counted twice
        -- (double-charging) or zero times (re-selling a tier that is still
        -- billed). The mirror above is now the same test in the negative --
        -- "no tier row carries this line's quote_item_id" -- so the two split
        -- the set exactly. If either side is edited, edit both.
        ON b.quote_item_id = t.quote_item_id
      -- Document order, with the line's own id as a deterministic tiebreak.
      -- (section_ord, ord) is not unique-by-constraint, and an unstable order
      -- here would make WHICH tier a partial draw lands in vary between calls.
      ORDER BY t.section_ord, t.ord, t.quote_item_id
    LOOP
      -- Over-consumption is accumulated across EVERY tier, so this loop no
      -- longer EXITs at the allocation boundary -- it CONTINUEs, leaving the
      -- tiers past that point still inspected. Tier counts per product are in
      -- the single digits, so walking the tail costs nothing.
      v_over := v_over + COALESCE(v_tier.over, 0);
      IF v_alloc_left <= 0 THEN CONTINUE; END IF;

      v_tier_units := v_tier.units;

      -- Only legacy averaged units walk the list; everything else was already
      -- subtracted per tier by the LEFT JOIN above.
      IF v_skip > 0 THEN
        IF v_skip >= v_tier_units THEN
          v_skip := v_skip - v_tier_units;
          CONTINUE;
        END IF;
        v_tier_units := v_tier_units - v_skip;
        v_skip := 0;
      END IF;

      v_take := LEAST(v_tier_units, v_alloc_left);
      IF v_take <= 0 THEN CONTINUE; END IF;
      v_alloc_left := v_alloc_left - v_take;

      -- Exact whole-cent unit cost straight from the quote-time snapshot; no
      -- average, so nothing to round at the unit level. The division of integer
      -- cents by 100 is already exact -- ROUND here only pins the numeric SCALE
      -- to two places so the stored value looks like every other order path's,
      -- rather than carrying a long trailing-zero tail. It changes no value.
      -- Verified live 2026-08-15: _enforce_below_cost_line overwrites
      -- cost_per_unit/cost_at_time_cents only when the declared operation is one
      -- of create_direct_order, bulk_import_order, update_order_items or
      -- price_order. This path declares draw_down_quote, so the per-tier
      -- snapshot cost written here survives the trigger.
      v_tier_cost_unit := ROUND(v_tier.cost_cents::numeric / 100, 2);

      -- Money is rounded only AFTER extension by quantity, never before -- and,
      -- since the 2026-08-16 push-proof (CRX-MONEY-TIER-ROUND-001, High), the
      -- extension is CUMULATIVE per tier rather than per draw.
      --
      -- The earlier form was ROUND(price * take, 2) on each draw in isolation.
      -- That is exact for whole-unit draws, but draw quantities are genuinely
      -- fractional -- the draw box in QuoteBuilder is step="any", and so are the
      -- quote-line quantity boxes it draws against -- and on a fractional draw
      -- the per-draw rounding residual does not cancel. It ACCUMULATES across
      -- partial draws, so the tier ends up billed for more (or less) than its
      -- own authoritative extension. Worked case from the proof: 0.50 units at
      -- $0.50 plus 0.50 units at $1.50 books $1.00; drawn as four 0.25-unit
      -- draws the old form billed 2 x $0.13 + 2 x $0.38 = $1.02. Two cents
      -- invented out of rounding, and it grows with the number of partial draws.
      --
      -- The fix is to round the RUNNING TOTAL and subtract what is already
      -- charged. After this draw the tier has been billed for (prior + take)
      -- units, whose authoritative value is ROUND(price * (prior + take), 2).
      -- Subtract the money already standing against the tier and the remainder
      -- is what this line owes. Successive draws therefore telescope: whatever
      -- sequence of partial draws consumes a tier, the surviving lines sum to
      -- EXACTLY ROUND(price * units_billed_at_that_tier, 2), with no
      -- path-dependence and no accumulating residual. On a whole-unit draw this
      -- is identical to the old expression, so nothing changes for the ordinary
      -- case.
      --
      -- The subtrahend is v_tier.money -- the cents ACTUALLY standing on the
      -- surviving lines -- and NOT the computed ROUND(price * prior, 2). Those
      -- two agree in the ordinary case but diverge after a void, and using the
      -- computed figure made the final bill depend on WHICH of two identical
      -- draws had been reversed (Codex push-proof 2026-08-16,
      -- CRX-MONEY-LIFECYCLE-001, High). Reading the real money instead makes
      -- every path self-correcting, and it also repairs, on the next draw
      -- against that tier, a tier that legacy per-draw rounding had already
      -- over- or under-billed.
      --
      -- prior and money are keyed on the tier each line was WRITTEN at, not on
      -- units-drawn-from-the-product. Legacy averaged lines carry a DIFFERENT
      -- price and so land under a different key; they are handled by v_skip and
      -- correctly contribute 0 here, because this tier has genuinely not been
      -- billed for them.
      --
      -- GREATEST(..., 0): on an already over-billed tier the remainder can come
      -- out negative -- a credit. This path does not issue one. Refunding a
      -- historical over-charge belongs in a credit memo against the order that
      -- carries it, not silently inside an unrelated draw line, and a negative
      -- total_price would be refused by the whole-cent money CHECKs anyway. The
      -- clamp writes 0 and the over-charge stands, visible, on the line that
      -- created it. It hides nothing that is not already surfaced: the quantity
      -- form of the same condition is carried out as "over" and refused after
      -- the loop by DRAW_TIER_OVERCONSUMED.
      v_line_total := GREATEST(
                        ROUND(v_tier.price * (v_tier.prior + v_take), 2)
                        - v_tier.money, 0);

      -- COST is deliberately NOT telescoped. This asymmetry is load-bearing
      -- (Codex push-proof 2026-08-16, CRX-MONEY-PROFIT-001, High).
      --
      -- order_items.profit is not the caller's to choose. The canonical trigger
      -- from 20260809230500 overwrites any supplied profit with total_price -
      -- ROUND(cost_per_unit * total_units_needed, 2) -- a PER-LINE, explicitly
      -- non-cumulative cost. A cumulative v_line_cost therefore never reaches
      -- the stored line profit at all; it only desynchronises the order header
      -- and the commission basis from the lines they are meant to summarise.
      -- Measured shape: a $1.50 sale at $0.50 cost drawn as two 0.25-unit draws
      -- stores line profits of $0.25 + $0.24 = $0.49 under a header claiming
      -- $0.50.
      --
      -- So the cost basis is computed with the SAME expression the trigger
      -- uses, and the header below accumulates exactly the per-line figures the
      -- trigger will go on to store. Header, lines, and commission basis then
      -- agree by construction -- the invariant the 2026-08-09 decision exists
      -- to hold. The cost side keeps the per-draw rounding residual that the
      -- revenue side now sheds: a sub-cent artefact on internal margin, and the
      -- same one every other order path already carries. Shedding it there too
      -- means changing the shared canonical trigger for ALL order lines, which
      -- is a wider, separate change and is deliberately not made here.
      v_line_cost  := ROUND(v_tier_cost_unit * v_take, 2);

      -- ACRES COME FROM THE LINE'S OWN BOOKED RATE (Codex review 2026-08-16,
      -- P2 3793063419), not from prorating one whole-draw figure by units.
      --
      -- The previous form computed a single v_draw_acres for the product --
      -- ROUND(total_acres * qty / booked, 2) -- and handed it out in proportion
      -- to each tier's units. That is only right when every booked line for the
      -- product carries the same acres-per-unit. The moment two lines differ it
      -- invents a rate neither line was booked at: 100 units over 100 acres
      -- plus 100 units over 10 acres, drawn in full, wrote 55 acres on each of
      -- the two lines. Nothing on the booking says 55, and the figure does not
      -- stay internal -- complete_delivery copies order_items.acres straight
      -- into invoice_items, so it reaches the customer's paperwork.
      --
      -- With the quote line's own identity in hand its own booked acreage and
      -- its own booked quantity are directly available, so the line simply gets
      -- the share of ITS OWN acres that this draw takes of ITS OWN units. The
      -- two lines above now correctly read 100 and 10.
      --
      -- line_units is guaranteed > 0 by the tiers CTE filter, so the division
      -- is safe; the guard is written anyway because the filter and this
      -- division live 300 lines apart. A line booked with no acreage stays
      -- NULL rather than becoming a zero -- 0 acres and "not recorded" are
      -- different statements on a customer's order line.
      --
      -- No residual-absorbing last line any more, because there is no longer a
      -- whole-draw total the parts have to add back up to: each line's acreage
      -- is now an independent statement about its own booked line, and the only
      -- rounding is the single ROUND on that line's own figure. On a one-tier
      -- draw this is arithmetically identical to what the single-line version
      -- wrote (v_booked and v_total_acres collapse to that line's own values,
      -- and v_take = v_qty), so nothing changes for the ordinary case.
      v_tier_acres := CASE
        WHEN v_tier.line_acres IS NULL OR COALESCE(v_tier.line_units, 0) <= 0
          THEN NULL
        ELSE ROUND(v_tier.line_acres * v_take / v_tier.line_units, 2)
      END;

      -- Disclosed behaviour change (drift review 2026-08-16, NIT2): this is a
      -- single counter across the WHOLE draw, so the sort_order written below
      -- runs 1..M over every line of every product, where the single-line
      -- version wrote 1..N with one line per product. On a one-tier draw the
      -- numbering is unchanged; on a multi-tier draw the customer's order shows
      -- more lines and therefore higher line numbers. Deliberate -- lines are
      -- emitted product by product and tier by tier in document order, so a
      -- single ascending counter preserves that order exactly, whereas a
      -- per-product counter would repeat numbers across products.
      v_line_count := v_line_count + 1;

      INSERT INTO order_items (order_id, product_id, product_name,
        price_per_unit, cost_per_unit, acres,
        total_units_needed, unit_size, total_price, profit, net_margin,
        quantity_delivered, quantity_remaining, sort_order, notes,
        cost_at_time_cents, -- SNAPSHOT
        quote_item_id       -- PROVENANCE
        )
      VALUES (v_order_id, v_product_id, COALESCE(v_product_name, ''),
        v_tier.price, v_tier_cost_unit, v_tier_acres,
        v_take, COALESCE(v_tier.unit_size, v_unit_size), v_line_total,
        v_line_total - v_line_cost,
        CASE WHEN v_tier.price > 0
          THEN ROUND(((v_tier.price - v_tier_cost_unit) / v_tier.price) * 100, 2)
          ELSE 0 END,
        0, v_take, v_line_count,
        'Drawn from booking ' || v_quote.quote_number,
        -- SNAPSHOT: a partial draw is a conversion too. This tier's own
        -- quote-time cost, already integer cents, is stamped here so the line
        -- profit, the order header, the commission basis and the reports all
        -- share ONE value. Without the stamp the row inserts with a NULL
        -- cost_at_time_cents and trg_snapshot_order_item_cost writes TODAY's
        -- catalog cost, splitting the reports from the order totals. Unknown
        -- historical cost is rejected above; it must never be converted into a
        -- real zero-cost order line.
        v_tier.cost_cents,
        -- PROVENANCE: which booked quote line this order line was drawn from
        -- (Codex review 2026-08-16, P1 3792521137 / 3792687211). This is the
        -- root fix the rest of this body is built on -- the tier attribution
        -- above reads exactly this column back on the NEXT draw, so a line that
        -- fails to stamp here would be re-attributed by the front-walk and
        -- could re-sell its tier.
        --
        -- The column already existed on order_items and is already written by
        -- the FULL-conversion path (convert_quote_to_order); only this partial
        -- path left it NULL. Nothing downstream has to change to accept it:
        -- src/types/index.ts already declares quote_item_id as string | null,
        -- and every existing consumer already handles the NULL that legacy rows
        -- carry. Filling it strictly ADDS information.
        --
        -- The postflight assertion at the end of this migration re-reads the
        -- installed source and refuses the whole apply if this stamp is not
        -- present, so the body cannot ship with the attribution reading a
        -- column the writes never populate.
        v_tier.quote_item_id);

      v_total_price := v_total_price + v_line_total;
      v_total_cost := v_total_cost + v_line_cost;
    END LOOP;

    -- Fail closed when a tier is billed for more units than it now holds. That
    -- means the units already drawn can no longer be attributed to the tiers as
    -- they stand, so any further split is a guess.
    --
    -- This is reachable through a SUPPORTED workflow, not just a hand-edit
    -- (Codex review 2026-08-16, second HIGH). Revising a booking is allowed by
    -- save_quote's drawn-product guard on the PER-PRODUCT aggregate alone --
    -- 20260812115236:844 groups by product_id and compares total booked against
    -- total drawn, with no tier attribution preserved. So: book 200 units at
    -- one price, draw 150 of them, then revise the booking to 100 units at a
    -- lower price plus 100 at the original one. Booked (200) still covers drawn
    -- (150), so the revision saves. The 150 billed units still match the
    -- original tier, which now holds only 100 -- the clamp above silently
    -- discarded that 50-unit overhang, the remaining 50 units were drawn from
    -- the cheaper tier, and the booking billed more than its revised total.
    -- v_remaining could not catch it (per-product aggregate) and
    -- DRAW_ALLOCATION_MISMATCH could not catch it (the pool was large enough).
    --
    -- This guard is also the net under the coincidental-average case of the
    -- cutover race described at the top of this file: a late legacy averaged
    -- draw whose average happens to equal a real tier key escapes the unmatched
    -- -line guard, but it is attributed wholly to that one tier while it
    -- actually consumed several, so it over-bills that tier and stops here.
    --
    -- This migration now carries the provenance an earlier draft of this
    -- comment described as out of scope: every line written below stamps
    -- order_items.quote_item_id, so both scenarios are normally caught EARLIER
    -- and more precisely than here. In the revision case the stamps SURVIVE:
    -- the deferred FK installed further down lets save_quote delete and
    -- reinsert the same quote_items ids inside one transaction, so the next
    -- draw resolves attribution by identity and never reaches this net at
    -- all; in the cutover-race case a late legacy line carries no stamp and
    -- is caught the same way.
    --
    -- This refusal stays as the net beneath both, for the residue the stamp
    -- cannot reach: a product whose tiers all share ONE (price, cost) -- which
    -- the unmatched-line guard deliberately lets through as unbillable-either
    -- -way -- can still be resized below what it has already billed. It is
    -- deliberately stricter than strictly necessary rather than looser.
    IF v_over > 0 THEN
      RAISE EXCEPTION
        'DRAW_TIER_OVERCONSUMED: % unit(s) already billed against this booking for % exceed what its price tiers now hold, so which tiers the earlier draws consumed can no longer be determined. This usually follows a booking revision that repriced or resized a tier after part of it was drawn. Restore the tier quantities that were in place when those units were drawn, or void and re-book the affected orders, then re-try.',
        v_over, COALESCE(v_product_name, v_product_id::text);
    END IF;

    -- Fail closed: the split must conserve quantity exactly. If the booked tiers
    -- could not absorb the requested quantity, refuse the entire draw rather
    -- than book an order that under-bills the customer.
    IF v_alloc_left <> 0 THEN
      RAISE EXCEPTION
        'DRAW_ALLOCATION_MISMATCH: % of % units for % could not be matched to a booked price tier. This usually means an existing order for this product was edited after it was drawn, which rewrites the cost snapshot the tier is recognised by. Check recent edits to orders for this quote before re-trying.',
        v_alloc_left, v_qty, COALESCE(v_product_name, v_product_id::text);
    END IF;
    -- >>>TIERSPLIT

    -- Inventory: warn (never block) on net position, then prebook the draw.
    -- Deliberately PER PRODUCT and outside the tier loop: the full drawn
    -- quantity moves exactly once no matter how many price tiers it spans.
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_product_id AND location = 'Main Warehouse' FOR UPDATE;
    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls,
        COALESCE(v_product_name, 'Unknown product') || ': need ' || v_qty || ', net position is 0 (no inventory record)');
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (v_product_id, 'Main Warehouse', 0, v_qty, 0, v_unit_size);
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_qty THEN
        v_shortfalls := array_append(v_shortfalls,
          COALESCE(v_product_name, 'Unknown product') || ': need ' || v_qty ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
      UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_qty, updated_at = now()
      WHERE product_id = v_product_id AND location = 'Main Warehouse';
    END IF;

    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes)
    VALUES (v_product_id, 'booked', v_qty, 'Main Warehouse',
      v_order_id, v_actor, 'Pre-booked for order ' || v_order_number || ' (draw from quote ' || v_quote.quote_number || ')');

    -- Move the drawn quantity out of this quote's active holds (FIFO).
    -- Net Free = available − holds − prebooked stays constant: the quantity
    -- leaves the hold bucket and enters the prebooked bucket.
    v_to_consume := v_qty;
    FOR v_hold IN
      SELECT id, quantity FROM inventory_holds
      WHERE source_id = p_quote_id AND product_id = v_product_id AND is_active = true
      ORDER BY created_at
      FOR UPDATE
    LOOP
      EXIT WHEN v_to_consume <= 0;
      IF v_hold.quantity <= v_to_consume THEN
        UPDATE inventory_holds SET quantity = 0, is_active = false, updated_at = now()
        WHERE id = v_hold.id;
        v_to_consume := v_to_consume - v_hold.quantity;
      ELSE
        UPDATE inventory_holds SET quantity = quantity - v_to_consume, updated_at = now()
        WHERE id = v_hold.id;
        v_to_consume := 0;
      END IF;
    END LOOP;

    -- Ledger: record the draw
    INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn)
    VALUES (p_quote_id, v_product_id, v_qty)
    ON CONFLICT (quote_id, product_id)
    DO UPDATE SET quantity_drawn = quote_product_draws.quantity_drawn + EXCLUDED.quantity_drawn,
                  updated_at = now();

    -- Per-product summary for the caller. Shape unchanged on purpose: the app
    -- reads this and must not have to learn about the tier split.
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product_id,
      'product_name', v_product_name,
      'drawn', v_qty,
      'remaining', v_remaining - v_qty);

    -- OVER-DRAW (20261029110000): the extra, on its own ordinary order (one per draw).
    IF v_extra > 0 THEN
      IF v_extra_choice = 'booked' THEN
        -- The booked price of the last booked line for this product (the tier drawn last).
        SELECT qi.price_per_unit INTO v_extra_price
          FROM quote_items qi
          JOIN quote_sections qs ON qs.id = qi.section_id
         WHERE qi.quote_id = p_quote_id
           AND qi.product_id = v_product_id
           AND COALESCE(qi.total_units_needed, 0) > 0
         ORDER BY qs.sort_order DESC, qi.sort_order DESC, qi.id DESC
         LIMIT 1;
      ELSE
        -- Today's price for the quote's tier, the same rule save_quote uses for a new line.
        SELECT CASE v_quote.tier
                 WHEN 1 THEN COALESCE(p.tier1_price, 0)
                 WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
                 ELSE COALESCE(p.tier3_price, p.tier1_price, 0)
               END
          INTO v_extra_price
          FROM products p WHERE p.id = v_product_id;
      END IF;
      SELECT current_cost INTO v_extra_cost FROM products WHERE id = v_product_id;
      IF v_extra_cost IS NULL THEN
        RAISE EXCEPTION 'COST_BASIS_REQUIRED:%', v_product_id;
      END IF;
      v_extra_cost := ROUND(v_extra_cost, 2);

      IF v_extra_order_id IS NULL THEN
        v_extra_order_number := generate_order_number();
        INSERT INTO orders (order_number, quote_id, customer_id, status, commission_split,
          total_price, total_cost, total_profit, total_margin_pct, order_date, program_notes)
        VALUES (v_extra_order_number, NULL, v_quote.customer_id, 'confirmed',
          v_quote.commission_split, 0, 0, 0, 0, (now() AT TIME ZONE 'America/Chicago')::date,
          'Taken over booking ' || v_quote.quote_number || ' (booking order ' || v_order_number || ')')
        RETURNING id INTO v_extra_order_id;
      END IF;

      v_line_total := ROUND(v_extra_price * v_extra, 2);
      v_line_cost := ROUND(v_extra_cost * v_extra, 2);
      INSERT INTO order_items (order_id, product_id, product_name,
        price_per_unit, cost_per_unit, acres,
        total_units_needed, unit_size, total_price, profit, net_margin,
        quantity_delivered, quantity_remaining, sort_order, notes,
        cost_at_time_cents, quote_item_id)
      VALUES (v_extra_order_id, v_product_id, COALESCE(v_product_name, ''),
        v_extra_price, v_extra_cost, NULL,
        v_extra, v_unit_size, v_line_total, v_line_total - v_line_cost,
        CASE WHEN v_extra_price > 0
          THEN ROUND(((v_extra_price - v_extra_cost) / v_extra_price) * 100, 2)
          ELSE 0 END,
        0, v_extra, jsonb_array_length(v_extra_lines) + 1,
        'Taken over booking ' || v_quote.quote_number || ' at '
          || CASE v_extra_choice WHEN 'booked' THEN 'the booked' ELSE 'today''s' END || ' price',
        ROUND(v_extra_cost * 100)::bigint, NULL);
      v_extra_total_price := v_extra_total_price + v_line_total;
      v_extra_total_cost := v_extra_total_cost + v_line_cost;

      -- Stock as for any order: pre-book it and warn on a shortfall (never block). No booking
      -- hold to consume and no booking ledger row: these units were never booked. The booking
      -- part above already locked or created this inventory row.
      SELECT quantity_available - quantity_prebooked + COALESCE(quantity_on_order, 0)
        INTO v_extra_net
        FROM inventory
       WHERE product_id = v_product_id AND location = 'Main Warehouse'
       FOR UPDATE;
      IF COALESCE(v_extra_net, 0) < v_extra THEN
        v_shortfalls := array_append(v_shortfalls,
          COALESCE(v_product_name, 'Unknown product') || ': need ' || v_extra ||
          ' more over the booking, net position is ' || GREATEST(COALESCE(v_extra_net, 0), 0));
      END IF;
      UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_extra, updated_at = now()
       WHERE product_id = v_product_id AND location = 'Main Warehouse';
      INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location,
        order_id, performed_by, notes)
      VALUES (v_product_id, 'booked', v_extra, 'Main Warehouse',
        v_extra_order_id, v_actor, 'Pre-booked for order ' || v_extra_order_number ||
          ' (taken over booking ' || v_quote.quote_number || ')');

      v_extra_lines := v_extra_lines || jsonb_build_object(
        'product_id', v_product_id,
        'product_name', v_product_name,
        'quantity', v_extra,
        'price_per_unit', v_extra_price,
        'price_choice', v_extra_choice);
    END IF;
  END LOOP;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  -- OVER-DRAW (20261029110000): close out the extra order like the booking order below.
  IF v_extra_order_id IS NOT NULL THEN
    v_extra_profit := v_extra_total_price - v_extra_total_cost;
    UPDATE orders SET total_price = v_extra_total_price, total_cost = v_extra_total_cost,
      total_profit = v_extra_profit,
      total_margin_pct = CASE WHEN v_extra_total_price > 0
        THEN ROUND((v_extra_profit / v_extra_total_price) * 100, 2) ELSE 0 END
    WHERE id = v_extra_order_id;
    PERFORM _insert_commissions_for_order(
      v_extra_order_id, v_quote.customer_id, v_extra_profit,
      v_quote.commission_split, (now() AT TIME ZONE 'America/Chicago')::date
    );
    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
    VALUES (
      'quote_converted', 'order', v_extra_order_id, v_actor_role,
      jsonb_build_object(
        'quote_id', p_quote_id,
        'quote_number', v_quote.quote_number,
        'order_number', v_extra_order_number,
        'booking_order_number', v_order_number,
        'customer_id', v_quote.customer_id,
        'total_price_dollars', v_extra_total_price,
        'booking_draw', false,
        'over_booking', true,
        'lines', v_extra_lines
      ),
      ROUND(v_extra_total_price * 100)::bigint,
      'Order ' || v_extra_order_number || ' for the amount taken over booking ' || v_quote.quote_number
    );
    INSERT INTO activity_feed (event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id)
    VALUES ('order_created',
      'Order ' || v_extra_order_number || ' created for the amount taken over booking ' || v_quote.quote_number,
      v_actor, 'order', v_extra_order_id, v_quote.customer_id);
  END IF;

  v_total_profit := v_total_price - v_total_cost;
  v_total_margin_pct := CASE WHEN v_total_price > 0 THEN ROUND((v_total_profit / v_total_price) * 100, 2) ELSE 0 END;
  UPDATE orders SET total_price = v_total_price, total_cost = v_total_cost,
    total_profit = v_total_profit, total_margin_pct = v_total_margin_pct
  WHERE id = v_order_id;

  PERFORM _insert_commissions_for_order(
    v_order_id, v_quote.customer_id, v_total_profit,
    v_quote.commission_split, (now() AT TIME ZONE 'America/Chicago')::date
  );

  -- Fully drawn? Then the booking closes as 'accepted' (enforcer-legal from
  -- sent/revised) and the hold-release trigger clears any leftover holds.
  -- LAYER2 NOTE: this stays on ORDER draws only (quote_product_draws) by design
  -- — job draws are reversible, so letting them flip status to 'accepted' would
  -- require un-accepting on job cancel (a quote-lifecycle change out of scope).
  SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_fully_drawn
  FROM (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items WHERE quote_id = p_quote_id
    GROUP BY product_id
  ) b
  LEFT JOIN quote_product_draws d
    ON d.quote_id = p_quote_id AND d.product_id = b.product_id
  WHERE b.booked > 0;

  IF v_fully_drawn THEN
    UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;
  ELSE
    UPDATE quotes SET updated_at = now() WHERE id = p_quote_id;
  END IF;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'quote_converted', 'order', v_order_id, v_actor_role,
    jsonb_build_object(
      'quote_id', p_quote_id,
      'quote_number', v_quote.quote_number,
      'order_number', v_order_number,
      'customer_id', v_quote.customer_id,
      'customer_name', COALESCE(v_customer.farm_name, 'unknown'),
      'total_price_dollars', v_total_price,
      'booking_draw', true,
      'fully_drawn', v_fully_drawn,
      'lines', v_lines,
      'inventory_warnings', to_jsonb(v_shortfalls)
    ),
    ROUND(v_total_price * 100)::bigint,
    'Drew down quote ' || v_quote.quote_number || ' to order ' || v_order_number ||
      ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
      CASE WHEN v_fully_drawn THEN ' (booking now fully drawn)' ELSE ' (partial draw — booking stays open)' END ||
      CASE WHEN array_length(v_shortfalls, 1) > 0
        THEN ' (inventory shortfalls: ' || array_to_string(v_shortfalls, '; ') || ')'
        ELSE '' END
  );

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('order_created',
    'Order ' || v_order_number || ' created from booking ' || v_quote.quote_number ||
    ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN v_fully_drawn THEN ' — booking fully drawn' ELSE ' — partial draw' END,
    v_actor, 'order', v_order_id, v_quote.customer_id);

  v_result := jsonb_build_object(
    'success', true, 'status', 'created',
    'order_id', v_order_id, 'order_number', v_order_number,
    'warnings', to_jsonb(v_shortfalls),
    'fully_drawn', v_fully_drawn,
    'lines', v_lines)
    -- OVER-DRAW (20261029110000): present only when an extra order was written.
    || CASE WHEN v_extra_order_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
         'extra_order_id', v_extra_order_id,
         'extra_order_number', v_extra_order_number,
         'extra_lines', v_extra_lines) END;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'draw_down_quote', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('draw_down_quote', 'public.draw_down_quote(uuid,jsonb,uuid,text,text)',
          ARRAY['authenticated', 'postgres'], 'extra_price'),
        ('_draw_down_quote_below_cost_impl_20260810', 'public._draw_down_quote_below_cost_impl_20260810(uuid,jsonb,uuid,text)',
          ARRAY['postgres'], 'v_extra_order_id')
      ) AS pin(fn, sig, execs, marker)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc o
             WHERE o.pronamespace = 'public'::regnamespace AND o.proname = pin.fn) <> 1
        OR position(pin.marker IN p.prosrc) = 0
        OR p.proowner <> 'postgres'::regrole
        OR NOT p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM pin.execs
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: a re-emitted draw function lost its change, owner, mode, search_path or grants';
  END IF;
END
$postflight$;
