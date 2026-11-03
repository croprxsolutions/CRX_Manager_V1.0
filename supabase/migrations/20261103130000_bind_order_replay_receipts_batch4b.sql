-- Written 2026-11-02. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261103130000_bind_order_replay_receipts_batch4b.md.
--
-- WHAT: batch 4b of the system-wide idempotency replay-binding fix (KNOWN_ISSUES.md KI-10, "live
--   functions replay a saved result matched on the retry key alone"). This cut binds the two order
--   money functions KI-10 names and the MED inventory one Mason asked to batch with them:
--     price_order                  (prices a ship-now / price-later rush order: line prices,
--                                   commissions on the final profit, linked draft invoices swept)
--     update_order_items           (edits an order's lines: prices, quantities, products)
--     mark_inventory_row_verified  (admin clears an inventory row's manufactured-at-delivery flag)
--   price_order and mark_inventory_row_verified replay a stored receipt matched on the retry key
--   alone, so a retry that reuses a key for a DIFFERENT order or inventory row, or with other
--   prices, or from a different user, gets the first call's "done" answer and the new request is
--   never carried out (a false success; nothing is ever done twice). update_order_items already
--   compares its own stored request (actor, order, expected version, lines) and refuses a mismatch
--   with IDEMPOTENCY_PAYLOAD_CONFLICT; it is bound here so every order money path uses the one
--   batch contract and the commit-time guard below covers its receipts.
--
--   The fix is batch 1's pattern (20261016060000), reusing its live helpers: each live body is
--   RENAMED unchanged to _<name>_replay_impl_20261015 (no API role may call it), and a public wrapper
--   with the identical signature, defaults, return type, owner, search_path and grants takes its
--   place. With a key, the wrapper
--     1. runs the same auth, actor and role tests its renamed body runs first, in the same order and
--        with the same messages, so no stored result is ever returned before the role check
--        (price_order and update_order_items call the same _begin_below_cost_money_write their
--        bodies call first, pinned below; update_order_items also repeats its body's strict actor
--        test and its expected-version test);
--     2. computes a SHA-256 fingerprint of the actor and every request argument except the key and
--        p_performed_by (which step 1 has already proved equals the actor, or is NULL). The
--        below_cost_reason an approved retry adds to each line is left out of the order
--        fingerprints, exactly as the live update_order_items body already leaves it out of its
--        stored request ("transport metadata, not a different order-edit intent"): the order
--        screen's lost-reply retry re-sends the lines first WITHOUT the approved reason, and must
--        replay rather than be refused;
--     3. calls check_idempotency_intent(key, op, auth.uid(), fingerprint), which takes the per-key
--        advisory lock (crx:idempotency:<key>). No receipt: run the body. Exact actor + intent
--        match: run the body, which replays its own stored answer exactly as before. Anything else
--        is refused with IDEMPOTENCY_ACTOR_MISMATCH or IDEMPOTENCY_INTENT_MISMATCH, which the app
--        maps to plain English (src/lib/idempotency.ts getIdempotencyBindingRejection,
--        src/lib/errorSanitizer.ts);
--     4. after a fresh run, stamps request_actor_id and request_fingerprint onto the receipt the body
--        just wrote (_bind_replay_receipt_20261015), and refuses (rolls the call back) if the body
--        wrote none. Every body writes a receipt on every fresh keyed success (read live 2026-11-02:
--        price_order through _price_order_below_cost_impl_20260810's save_idempotency at its end;
--        update_order_items through its implementation's receipt, which the body then rewrites and
--        raises ORDER_EDIT_RECEIPT_MISSING without; mark_inventory_row_verified by a direct INSERT at
--        its end, including its already_verified answer).
--   A key is REQUIRED from callers (IDEMPOTENCY_KEY_REQUIRED, 22023), as in batches 1 to 4a: a
--   keyless call would run with no receipt. Every app caller already sends one (caller-analysis
--   lines below).
--
--   Why a body's own key-only lookup cannot return ANOTHER operation's receipt on an exact match:
--   idempotency_keys has a UNIQUE index on idempotency_key, so a key has at most one row, and
--   check_idempotency_intent has already refused it (IDEMPOTENCY_CROSS_OP_KEY_REUSE) unless that row
--   is this operation's, under the lock.
--
--   COMMIT-TIME GUARD: batch 1's deferred constraint trigger require_bound_replay_receipt_20261015
--   now also covers the three operations. A trigger's WHEN clause cannot be altered, so the trigger
--   is dropped and recreated with the same name, function and timing, inside this transaction under
--   its ACCESS EXCLUSIVE lock on idempotency_keys (no gap is visible). No second trigger is created.
--   Only the live batch 1 + 2 + 3a + 3b + 4a trigger (38 operations, read live 2026-11-02) is
--   accepted; any other definition refuses the apply (PREFLIGHT_RECEIPT_GUARD_DRIFT), and the result
--   covers 41.
--
-- WHAT DOES NOT CHANGE: no pricing, commission, invoice, order-line or inventory logic is retyped
--   (the three bodies are renamed, pinned by md5 below); no table, row, policy or receipt changes;
--   every keyed legitimate call (first call, exact retry) returns what it returns today. A keyless
--   call to the three public names is now refused (IDEMPOTENCY_KEY_REQUIRED). Checks that now run
--   before the renamed bodies: the key requirement, the auth/actor/role tests (same messages),
--   update_order_items' expected-version test (same message), and the actor/intent binding. A
--   DIFFERENT user retrying someone else's key is refused by the binding
--   (IDEMPOTENCY_ACTOR_MISMATCH), which shows them nothing: check_idempotency_intent discloses a
--   stored result only to the same actor.
--
-- RECEIPT DISCLOSURE: as batch 1. The preflight refuses to apply while any unexpired receipt exists
--   for the three operations (none existed when read live on 2026-11-02) and the commit-time guard
--   keeps an unbound one from ever committing.
--
-- ACCESS: this file narrows access, so it applies only on Mason's owner approval
--   (scripts/owner-approve-migration.mjs): the three renamed bodies lose EXECUTE and a keyless call
--   is refused. It widens nothing.
--
-- NOT IN THIS BATCH (KI-10 batches 4c and 4d): the notification RPCs and the remaining MED/LOW
--   functions that still read idempotency_keys directly.
--
-- OVERLOADS: each of the three has exactly one overload (read-only on live 2026-11-02); the
--   preflight refuses a second one and the postflight proves exactly one wrapper and one body per
--   name.
--
-- ROLLBACK (if ever needed, as its own reviewed migration), in this order: FIRST recreate
--   require_bound_replay_receipt_20261015 without the three operations (left covering them, it would
--   refuse every receipt the restored old bodies write, rolling back their work); then, for each
--   name, DROP the wrapper, ALTER FUNCTION public._<name>_replay_impl_20261015(...) RENAME TO <name>,
--   and restore its grants (EXECUTE to authenticated, service_role).
--
-- KNOWN LIMITS (each fails safe, nothing wrong is committed):
--   * The binding runs before the body's record checks, so a caller who retries THEIR OWN key with an
--     edited request inside 24 hours sees their own earlier result in the refusal DETAIL (batch 1 has
--     the same shape; another user never sees it).
--   * A retry under the same key with a DIFFERENT below-cost reason replays the first answer: the
--     reason only records the approval of a request that already committed.
--
-- ORDERING: strict. Live high-water when restamped (read 2026-11-02): 20261103090000 (PR #1300,
--   ledger 20261102205903); 20261102220000 (PR #1289) is also applied (ledger 20261102203702). The
--   assigned landing order after that is PR #1276 (20261103100000), Fix 2 (20261103110000), PR #1298
--   (20261103120000), then this file (20261103130000); none of them touches these functions, their
--   implementations or the guard trigger. Stamped 20261102220000, then 20261103130000, then this
--   stamp as the live high-water moved. Re-read the live ledger before applying.
--
-- idempotency-body-check: exempt. Every wrapper reads idempotency_keys through
--   check_idempotency_intent with its own operation literal and writes it through
--   _bind_replay_receipt_20261015; the renamed bodies keep their own operation-scoped lookups.
--
-- Grants. Every REVOKE below is either (a) on a RENAMED body, which no caller names any more, or
-- (b) the routine "FROM PUBLIC, anon" on a freshly created wrapper that is then granted to
-- authenticated and service_role, which is exactly the live ACL of the function it replaces. The app
-- keeps calling the same names with the same arguments and reaches the wrappers:
-- caller-analysis: price_order :: src/pages/OrderDetail.tsx calls the same name and signature with a key; no database function calls it (three bodies mention it only in comments); the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: update_order_items :: src/pages/OrderDetail.tsx and src/lib/offlineSync.ts (queued edits, stored key) call the same name and signature with a key; no database function calls it (one body mentions it only in a comment); the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: mark_inventory_row_verified :: src/components/integrity/IntegrityCleanupPanel.tsx calls the same name and signature with a fresh key per click; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE order_replay_binding_batch4b_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

-- The operations the commit-time guard covers once this file is applied, in trigger order, recorded
-- by the guard step below and read back by the postflight.
CREATE TEMP TABLE order_replay_binding_batch4b_guard_ops (
  ord integer PRIMARY KEY,
  operation text NOT NULL UNIQUE
) ON COMMIT DROP;

-- The three bodies, exactly as reviewed live on 2026-11-02 (md5 ignores carriage returns), read by
-- the preflight and the postflight.
CREATE TEMP TABLE order_replay_binding_batch4b_pins ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('price_order', 'p_order_id uuid, p_items jsonb DEFAULT ''[]''::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'ab2bcf3ac499cf78eef1f706d4e9501f'),
  ('update_order_items', 'p_order_id uuid, p_items jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text, p_expected_row_version bigint DEFAULT NULL::bigint', 'jsonb', 'a50b992fdf7635226bbd2a7938a9af8e'),
  ('mark_inventory_row_verified', 'p_inventory_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '062fffe5f01fa1873255b7e5ade308cc')
) AS pin(name, args, ret, body_md5);

DO $preflight$
DECLARE
  v_drift text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.order_replay_binding_batch4b_tx') IS NULL THEN
    RAISE EXCEPTION 'ORDER_REPLAY_BINDING_BATCH4B_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.order_replay_binding_batch4b_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'ORDER_REPLAY_BINDING_BATCH4B_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- Each body is the only overload of its name, with the live owner, attributes, grants and body,
  -- and no renamed copy exists yet.
  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_drift
    FROM pg_temp.order_replay_binding_batch4b_pins pin
   WHERE (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = pin.name) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = pin.name
           AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
           AND NOT p.proisstrict AND NOT p.proretset AND p.prokind = 'f'
           AND p.prorettype = pin.ret::regtype
           AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
           AND pg_get_function_arguments(p.oid) = pin.args
           AND md5(replace(p.prosrc, chr(13), '')) = pin.body_md5
           AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                       FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
               IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[])
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = '_' || pin.name || '_replay_impl_20261015');
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_ORDER_REPLAY_BATCH4B_BODY_DRIFT: expected the exact reviewed live body (and no renamed copy yet) for: %', v_drift;
  END IF;

  -- No other database function, in ANY schema, and no pg_cron job may call the three by name (read
  -- live 2026-11-02: none; _cancel_delivery_replay_impl_20261015, _post_invoice_impl_20260714 and
  -- _create_rush_order_below_cost_impl_20260810 mention them only in comments, which are stripped
  -- before matching). The match ignores case and allows a quoted or schema-qualified name. A new
  -- caller would be refused for a missing key. Limit: a name assembled at run time in dynamic SQL
  -- cannot be seen here; such a caller would fail closed (IDEMPOTENCY_KEY_REQUIRED, nothing
  -- committed).
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname) INTO v_drift
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND NOT (n.nspname = 'public' AND p.proname IN (SELECT pin.name FROM pg_temp.order_replay_binding_batch4b_pins pin))
     AND regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g')
         ~* '(^|[^_a-z0-9])(price_order|update_order_items|mark_inventory_row_verified)"?\s*\(';
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: these functions call a batch 4b function and were not reviewed: %', v_drift;
  END IF;
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $cron$SELECT string_agg(jobname, ', ' ORDER BY jobname) FROM cron.job
                  WHERE command ~* '(price_order|update_order_items|mark_inventory_row_verified)'$cron$ INTO v_drift;
    IF v_drift IS NOT NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: these pg_cron jobs call a batch 4b function and were not reviewed: %', v_drift;
    END IF;
  END IF;

  -- What the wrappers rely on: the intent check as installed by 20260811130000 (pinned), the two
  -- binding columns, auth.uid() (pinned), batch 1's live helpers (pinned), the below-cost gate the
  -- two order wrappers call first (pinned; invoker rights, callable only by postgres and
  -- service_role), and the price_order implementation whose save_idempotency writes the receipt the
  -- wrapper binds (pinned; definer, callable only by postgres).
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'check_idempotency_intent') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'check_idempotency_intent'
          AND pg_get_function_identity_arguments(p.oid) = 'p_key text, p_operation text, p_actor uuid, p_fingerprint text'
          AND md5(replace(p.prosrc, chr(13), '')) = 'edc73be809069669e8441eba7acf443d') THEN
    RAISE EXCEPTION 'PREFLIGHT_INTENT_CHECK_DRIFT: check_idempotency_intent differs from its reviewed body';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = 'public.idempotency_keys'::regclass AND NOT a.attisdropped
         AND ((a.attname = 'request_actor_id' AND a.atttypid = 'uuid'::regtype)
           OR (a.attname = 'request_fingerprint' AND a.atttypid = 'text'::regtype))) <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT_RECEIPT_COLUMNS_DRIFT: idempotency_keys.request_actor_id (uuid) and request_fingerprint (text) are required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('auth.uid()')
       AND NOT p.prosecdef
       AND md5(replace(p.prosrc, chr(13), '')) = 'cdef18c69c4f4cbbced2eaf81e628b49') THEN
    RAISE EXCEPTION 'PREFLIGHT_AUTH_UID_DRIFT: auth.uid() is missing or differs from its reviewed live body';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public._replay_fingerprint_20261015(jsonb)', '68d5c0c62579349ced47c89e6b65ccaf', false),
      ('public._bind_replay_receipt_20261015(text,text,text)', '722ddd3b5d9174c598735cb321088f73', false),
      ('public._require_bound_replay_receipt_20261015()', '5c0478525131ddbeb7b96ef1535ff91e', true)
    ) AS h(sig, body_md5, secdef)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid = to_regprocedure(h.sig)
          AND p.proowner = 'postgres'::regrole AND p.prosecdef = h.secdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND md5(replace(p.prosrc, chr(13), '')) = h.body_md5
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['postgres']::text[])
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_BATCH1_HELPER_DRIFT: the batch-1 replay-binding helpers differ from their reviewed live bodies or ACLs';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_begin_below_cost_money_write') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid = to_regprocedure('public._begin_below_cost_money_write(text,uuid,jsonb)')
          AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND md5(replace(p.prosrc, chr(13), '')) = '309a01b18f3cd94dbc0146b031978a13'
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['postgres', 'service_role']::text[]) THEN
    RAISE EXCEPTION 'PREFLIGHT_BELOW_COST_GATE_DRIFT: _begin_below_cost_money_write differs from its reviewed live body or ACL';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_price_order_below_cost_impl_20260810') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid = to_regprocedure('public._price_order_below_cost_impl_20260810(uuid,jsonb,uuid,text)')
          AND p.proowner = 'postgres'::regrole AND p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND md5(replace(p.prosrc, chr(13), '')) = 'bad627af481b79da93e5afbb1a3bc181'
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['postgres']::text[]) THEN
    RAISE EXCEPTION 'PREFLIGHT_PRICE_ORDER_IMPL_DRIFT: _price_order_below_cost_impl_20260810 differs from its reviewed live body or ACL';
  END IF;

  -- Cutover: a receipt written by an old body carries no binding, and the intent check refuses it.
  -- So apply only while no unexpired receipt exists for the three operations; this transaction's
  -- ACCESS EXCLUSIVE lock keeps a new one from appearing before the guard covers them.
  LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys k
              WHERE k.operation IN (SELECT pin.name FROM pg_temp.order_replay_binding_batch4b_pins pin)
                AND (k.expires_at IS NULL OR k.expires_at >= now())) THEN
    RAISE EXCEPTION 'PREFLIGHT_UNEXPIRED_RECEIPTS: an unexpired receipt exists for a batch 4b operation; wait for it to expire (24 hours) and apply again';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- The commit-time guard now covers the three operations too (same trigger, same function), keeping
-- every operation it already covers. Only the live batch-1+2+3a+3b+4a state is accepted.
-- ---------------------------------------------------------------------------------------------
DO $guard$
DECLARE
  v_prior constant text[] := ARRAY[
    'void_payment', 'delete_prepay_credit', 'edit_prepay_credit', 'apply_write_off',
    'reverse_write_off', 'apply_prepay_to_invoice', 'create_prepay_check_splits',
    'batch_apply_prepayments', 'batch_void_invoices',
    'release_inventory_hold', 'retire_inventory_item', 'reconcile_negative_inventory',
    'manual_inventory_add', 'create_order_from_blend_ticket', 'create_direct_order',
    'create_rush_order', 'close_quote_as_applied', 'close_quote_as_short',
    'create_app_record_from_bt', 'batch_cancel_deliveries', 'reverse_completed_cycle_count',
    'create_planned_holds',
    'complete_delivery', 'complete_job',
    'cancel_delivery', 'void_delivery', 'void_order',
    'unpost_invoice', 'unpost_invoice_group', 'close_accounting_period', 'reopen_accounting_period',
    'transfer_invoice_to_job', 'save_field_app_invoice', 'update_field_app_invoice_billing',
    'consolidate_draft_invoices', 'update_blend_ticket_billing_status', 'create_rebate_claim',
    'transition_rebate_claim'];
  v_batch4b constant text[] := ARRAY[
    'price_order', 'update_order_items', 'mark_inventory_row_verified'];
  v_ops text[];
  v_def text;
  v_count integer;
BEGIN
  SELECT count(*), max(pg_get_triggerdef(t.oid)) INTO v_count, v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.idempotency_keys'::regclass
     AND t.tgname = 'require_bound_replay_receipt_20261015'
     AND t.tgfoid = to_regprocedure('public._require_bound_replay_receipt_20261015()')
     AND t.tgenabled = 'O' AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred;
  -- No other trigger may run the guard function (the recreated trigger must stay the only one).
  IF v_count <> 1
     OR (SELECT count(*) FROM pg_trigger t
          WHERE t.tgfoid = to_regprocedure('public._require_bound_replay_receipt_20261015()')) <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_RECEIPT_GUARD_DRIFT: expected exactly one enabled deferred require_bound_replay_receipt_20261015 trigger';
  END IF;

  -- Batches 1, 2, 3a, 3b and 4a are live: only their 38-operation trigger is accepted.
  IF v_def = 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
            || (SELECT string_agg(quote_literal(o) || '::text', ', ' ORDER BY ord) FROM unnest(v_prior) WITH ORDINALITY AS u(o, ord))
            || ']))) EXECUTE FUNCTION _require_bound_replay_receipt_20261015()' THEN
    v_ops := v_prior || v_batch4b;
  ELSE
    RAISE EXCEPTION 'PREFLIGHT_RECEIPT_GUARD_DRIFT: require_bound_replay_receipt_20261015 is not the batch-1+2+3a+3b+4a trigger: %', v_def;
  END IF;

  INSERT INTO pg_temp.order_replay_binding_batch4b_guard_ops (ord, operation)
  SELECT u.ord, u.o FROM unnest(v_ops) WITH ORDINALITY AS u(o, ord);

  -- Same name, function and timing; only the covered list grows. Every element is a fixed literal
  -- from this block, quoted with quote_literal.
  DROP TRIGGER require_bound_replay_receipt_20261015 ON public.idempotency_keys;
  EXECUTE format(
    'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 '
    || 'AFTER INSERT OR UPDATE ON public.idempotency_keys '
    || 'DEFERRABLE INITIALLY DEFERRED '
    || 'FOR EACH ROW '
    || 'WHEN (NEW.operation IN (%s)) '
    || 'EXECUTE FUNCTION public._require_bound_replay_receipt_20261015()',
    (SELECT string_agg(quote_literal(o), ', ' ORDER BY ord) FROM unnest(v_ops) WITH ORDINALITY AS u(o, ord)));
END
$guard$;

-- ---------------------------------------------------------------------------------------------
-- 1. price_order
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.price_order(uuid, jsonb, uuid, text) RENAME TO _price_order_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._price_order_replay_impl_20261015(uuid, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.price_order(
  p_order_id uuid,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: price_order requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first step: AUTH_REQUIRED, ACTOR_MISMATCH, INSUFFICIENT_ROLE (admin, sales_rep).
  PERFORM public._begin_below_cost_money_write('price_order', p_performed_by, p_items);
  -- The approved below-cost reason is transport metadata, not a different pricing request.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'order_id', p_order_id,
    'items', CASE WHEN jsonb_typeof(p_items) = 'array' THEN
      (SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(item) = 'object' THEN item - 'below_cost_reason' ELSE item END ORDER BY ord), '[]'::jsonb)
         FROM jsonb_array_elements(p_items) WITH ORDINALITY AS lines(item, ord))
      ELSE p_items END));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'price_order', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._price_order_replay_impl_20261015(p_order_id, p_items, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'price_order', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.price_order(uuid, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.price_order(uuid, jsonb, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. update_order_items
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.update_order_items(uuid, jsonb, uuid, text, bigint) RENAME TO _update_order_items_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._update_order_items_replay_impl_20261015(uuid, jsonb, uuid, text, bigint) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.update_order_items(
  p_order_id uuid,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_expected_row_version bigint DEFAULT NULL::bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: update_order_items requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  PERFORM public._begin_below_cost_money_write('update_order_items', p_performed_by, p_items);
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 1 THEN
    RAISE EXCEPTION 'ORDER_EXPECTED_VERSION_REQUIRED';
  END IF;
  -- The approved below-cost reason is transport metadata, as the body's own stored request has it.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'order_id', p_order_id, 'expected_row_version', p_expected_row_version,
    'items', CASE WHEN jsonb_typeof(p_items) = 'array' THEN
      (SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(item) = 'object' THEN item - 'below_cost_reason' ELSE item END ORDER BY ord), '[]'::jsonb)
         FROM jsonb_array_elements(p_items) WITH ORDINALITY AS lines(item, ord))
      ELSE p_items END));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'update_order_items', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._update_order_items_replay_impl_20261015(p_order_id, p_items, p_performed_by, p_idempotency_key, p_expected_row_version);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'update_order_items', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_order_items(uuid, jsonb, uuid, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_order_items(uuid, jsonb, uuid, text, bigint) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. mark_inventory_row_verified
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.mark_inventory_row_verified(uuid, uuid, text) RENAME TO _mark_inventory_row_verified_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._mark_inventory_row_verified_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.mark_inventory_row_verified(
  p_inventory_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: mark_inventory_row_verified requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by != v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin required';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'inventory_id', p_inventory_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'mark_inventory_row_verified', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._mark_inventory_row_verified_replay_impl_20261015(p_inventory_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'mark_inventory_row_verified', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_inventory_row_verified(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_inventory_row_verified(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------------------------
DO $postflight$
DECLARE
  v_bad text;
  v_expected_def text;
BEGIN
  IF to_regclass('pg_temp.order_replay_binding_batch4b_tx') IS NULL THEN
    RAISE EXCEPTION 'ORDER_REPLAY_BINDING_BATCH4B_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.order_replay_binding_batch4b_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'ORDER_REPLAY_BINDING_BATCH4B_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_bad
    FROM pg_temp.order_replay_binding_batch4b_pins pin
   WHERE
     -- Exactly one public wrapper with the live signature, defaults and return type: definer,
     -- pinned search_path, it routes through the intent check, the receipt binder and its renamed
     -- body, and is callable by authenticated and service_role but never by anon or PUBLIC.
     (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = pin.name) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = pin.name
          AND pg_get_function_arguments(p.oid) = pin.args
          AND p.prorettype = pin.ret::regtype AND NOT p.proretset AND p.provolatile = 'v'
          AND NOT p.proisstrict AND p.prokind = 'f'
          AND p.proowner = 'postgres'::regrole AND p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND strpos(p.prosrc, 'check_idempotency_intent(p_idempotency_key, ''' || pin.name || ''',') > 0
          AND strpos(p.prosrc, '_bind_replay_receipt_20261015(p_idempotency_key, ''' || pin.name || ''',') > 0
          AND strpos(p.prosrc, '_' || pin.name || '_replay_impl_20261015(') > 0
          AND strpos(p.prosrc, 'IDEMPOTENCY_KEY_REQUIRED: ' || pin.name || ' requires p_idempotency_key') > 0
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[])
     -- Exactly one renamed body: the reviewed live body, callable only by postgres.
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = '_' || pin.name || '_replay_impl_20261015') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = '_' || pin.name || '_replay_impl_20261015'
          AND pg_get_function_arguments(p.oid) = pin.args
          AND p.prorettype = pin.ret::regtype
          AND p.proowner = 'postgres'::regrole AND p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND md5(replace(p.prosrc, chr(13), '')) = pin.body_md5
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['postgres']::text[]);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_REPLAY_BATCH4B_CONTRACT: wrapper or renamed body drifted for: %', v_bad;
  END IF;

  -- The commit-time guard: the one trigger running the guard function, exactly as recorded above
  -- (every previously covered operation, then these three), deferred AFTER INSERT OR UPDATE per row.
  IF (SELECT count(*) FROM pg_temp.order_replay_binding_batch4b_guard_ops) <> 41
     OR (SELECT count(*) FROM pg_temp.order_replay_binding_batch4b_guard_ops
          WHERE operation IN (SELECT pin.name FROM pg_temp.order_replay_binding_batch4b_pins pin)) <> 3 THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECEIPT_GUARD_CONTRACT: the recorded guard operation list is not a reviewed state';
  END IF;
  v_expected_def := 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
    || (SELECT string_agg(quote_literal(g.operation) || '::text', ', ' ORDER BY g.ord) FROM pg_temp.order_replay_binding_batch4b_guard_ops g)
    || ']))) EXECUTE FUNCTION _require_bound_replay_receipt_20261015()';
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.idempotency_keys'::regclass
         AND t.tgname = 'require_bound_replay_receipt_20261015'
         AND t.tgfoid = to_regprocedure('public._require_bound_replay_receipt_20261015()')
         AND t.tgenabled = 'O' AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
         AND (t.tgtype::int & 1) = 1      -- ROW level
         AND (t.tgtype::int & 2) = 0      -- AFTER
         AND (t.tgtype::int & 4) <> 0     -- INSERT
         AND (t.tgtype::int & 16) <> 0    -- UPDATE
         AND pg_get_triggerdef(t.oid) = v_expected_def) <> 1
     OR (SELECT count(*) FROM pg_trigger t
          WHERE t.tgfoid = to_regprocedure('public._require_bound_replay_receipt_20261015()')) <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECEIPT_GUARD_CONTRACT: require_bound_replay_receipt_20261015 is not installed as reviewed';
  END IF;

  -- The helpers are still callable by no API role.
  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY['public._replay_fingerprint_20261015(jsonb)',
                        'public._bind_replay_receipt_20261015(text,text,text)',
                        'public._require_bound_replay_receipt_20261015()']) AS h(sig)
      CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS api_role
     WHERE to_regprocedure(h.sig) IS NULL
        OR has_function_privilege(api_role, to_regprocedure(h.sig), 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_HELPER_CONTRACT: the replay-binding helpers must exist and be callable by no API role';
  END IF;

  RAISE NOTICE 'POSTFLIGHT_OK: price_order, update_order_items and mark_inventory_row_verified now replay a stored result only for the same person and the exact same request';
END
$postflight$;
