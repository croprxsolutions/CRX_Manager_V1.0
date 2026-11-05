-- Written 2026-11-05. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261110160000_bind_money_inventory_replay_receipts_batch4c.md.
--
-- WHAT: batch 4c of the system-wide idempotency replay-binding fix (KNOWN_ISSUES.md KI-10, "live
--   functions replay a saved result matched on the retry key alone"). This cut binds the twelve
--   remaining money, purchasing, delivery and inventory functions that still replay a stored receipt
--   matched on the key alone (read live 2026-11-05):
--     submit_purchase_order          (sends a draft purchase order to the vendor)
--     cancel_purchase_order          (cancels a purchase order)
--     delete_purchase_order          (admin deletes a purchase order)
--     duplicate_quote                (copies a quote, with its prices, into a new draft)
--     edit_delivery                  (edits a delivery's schedule, driver, address and lines)
--     reassign_delivery              (moves a delivery to another driver)
--     batch_reschedule_deliveries    (moves several deliveries to a new date)
--     confirm_delivery               (starts a delivery: scheduled -> in_progress)
--     create_delivery_with_items     (schedules a delivery against an order's lines)
--     create_followup_delivery       (schedules the remainder of a short delivery)
--     cancel_cycle_count             (admin cancels an in-progress inventory count)
--     reverse_blend_ticket_approval  (admin reverses a blend ticket's approval)
--   Each replays a stored receipt matched on the retry key alone, so a retry that reuses a key for a
--   DIFFERENT record, with other values, or from a different user, gets the first call's "done"
--   answer and the new request is never carried out (a false success; nothing is ever done twice).
--
--   The fix is batch 1's pattern (20261016060000), as in batches 2 to 4b, reusing its live helpers:
--   each live body is RENAMED unchanged to _<name>_replay_impl_20261015 (no API role may call it),
--   and a public wrapper with the identical signature, defaults, return type, owner, search_path and
--   grants takes its place. With a key, the wrapper
--     1. runs the same checks its renamed body runs before its own receipt lookup, in the same order
--        and with the same messages, so no stored result is ever returned before them. The three
--        purchase order wrappers first take the same global purchase-order lock (73492009) their
--        bodies take first, so the lock order (global, then per key) is unchanged. duplicate_quote
--        calls the same _begin_below_cost_money_write its body calls first (pinned below).
--        confirm_delivery's body looks up its receipt BEFORE its role check; the wrapper re-runs
--        that role check (same message) before handing back any replay;
--     2. computes a SHA-256 fingerprint of the actor and every request argument except the key and
--        p_performed_by (which step 1 has already proved equals the actor, or is NULL).
--        duplicate_quote's below-cost reason is left out, as in 4b: it is transport metadata that an
--        approved retry adds, not a different request;
--     3. calls check_idempotency_intent(key, op, auth.uid(), fingerprint), which takes the per-key
--        advisory lock (crx:idempotency:<key>). No receipt: run the body. Exact actor + intent
--        match: run the body, which replays its own stored answer exactly as before. Anything else
--        is refused with IDEMPOTENCY_ACTOR_MISMATCH or IDEMPOTENCY_INTENT_MISMATCH, which the app
--        maps to plain English (src/lib/idempotency.ts getIdempotencyBindingRejection,
--        src/lib/errorSanitizer.ts);
--     4. after a fresh run, stamps request_actor_id and request_fingerprint onto the receipt the body
--        just wrote (_bind_replay_receipt_20261015), and refuses (rolls the call back) if the body
--        wrote none. Every body writes a receipt on every fresh keyed success (read live 2026-11-05:
--        the purchase order bodies through their pinned _section9_*_serialized bodies, including
--        cancel's already_cancelled answer; duplicate_quote through its pinned
--        _duplicate_quote_below_cost_impl_20260810; the other eight at their single end-of-body
--        return; edit_delivery and reverse_blend_ticket_approval by a direct INSERT).
--   A key is REQUIRED from callers (IDEMPOTENCY_KEY_REQUIRED, 22023), as in batches 1 to 4b: a
--   keyless call would run with no receipt. Every app caller already sends one (caller-analysis
--   lines below).
--
--   INTERNAL CALLER: start_and_complete_delivery (already bound itself) starts a scheduled delivery
--   with a keyless confirm_delivery call, which the new wrapper would refuse. It is recreated in
--   place from its pinned live body with that ONE call retargeted to
--   _confirm_delivery_replay_impl_20261015 (batch 3b's precedent for _batch_cancel_deliveries). The
--   new body is built in the database from the pinned live text by one exact substring replacement,
--   so nothing else in it can change; the postflight proves the reverse replacement gives back the
--   pinned md5. CREATE OR REPLACE keeps its owner and its EXECUTE grants (authenticated, postgres).
--
--   Why a body's own key-only lookup cannot return ANOTHER operation's receipt on an exact match:
--   idempotency_keys has a UNIQUE index on idempotency_key, so a key has at most one row, and
--   check_idempotency_intent has already refused it (IDEMPOTENCY_CROSS_OP_KEY_REUSE) unless that row
--   is this operation's, under the lock.
--
--   COMMIT-TIME GUARD: batch 1's deferred constraint trigger require_bound_replay_receipt_20261015
--   now also covers the twelve operations. A trigger's WHEN clause cannot be altered, so the trigger
--   is dropped and recreated with the same name, function and timing, inside this transaction under
--   its ACCESS EXCLUSIVE lock on idempotency_keys (no gap is visible). No second trigger is created.
--   Only the live batch 1 to 4b trigger (41 operations, read live 2026-11-05) is accepted; any other
--   definition refuses the apply (PREFLIGHT_RECEIPT_GUARD_DRIFT), and the result covers 53.
--
-- WHAT DOES NOT CHANGE: no purchasing, quote, delivery, inventory or blend logic is retyped (the
--   twelve bodies are renamed, pinned by md5 below; start_and_complete_delivery changes by one call
--   target only); no table, row, policy or receipt changes; every keyed legitimate call (first call,
--   exact retry) returns what it returns today. A keyless call to the twelve public names is now
--   refused (IDEMPOTENCY_KEY_REQUIRED). A DIFFERENT user retrying someone else's key is refused by
--   the binding (IDEMPOTENCY_ACTOR_MISMATCH), which shows them nothing: check_idempotency_intent
--   discloses a stored result only to the same actor.
--
-- RECEIPT DISCLOSURE: as batch 1. The preflight refuses to apply while any unexpired receipt exists
--   for the twelve operations and the commit-time guard keeps an unbound one from ever committing.
--
-- ACCESS: this file narrows access, so it applies only on Mason's owner approval
--   (scripts/owner-approve-migration.mjs): the twelve renamed bodies lose EXECUTE and a keyless call
--   is refused. It widens nothing.
--
-- NOT IN THIS BATCH: the notification RPCs and the LOW functions (KI-10 batch 4d); the functions
--   KI-10 lists as accepted with a reason. The purchase order bodies' inner _section9_*_serialized
--   functions keep their key-only lookups and stay callable by service_role only (server code, which
--   never calls them); no API role reaches them.
--
-- OVERLOADS: each of the twelve has exactly one overload (read-only on live 2026-11-05); the
--   preflight refuses a second one and the postflight proves exactly one wrapper and one body per
--   name.
--
-- ROLLBACK (if ever needed, as its own reviewed migration), in this order: FIRST recreate
--   require_bound_replay_receipt_20261015 without the twelve operations (left covering them, it
--   would refuse every receipt the restored old bodies write, rolling back their work); then
--   recreate start_and_complete_delivery with its confirm_delivery call restored; then, for each
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
-- ORDERING: live high-water when restamped (read 2026-11-05): ledger 20261105213209
--   (20261110140000_rup_records_require_posted_invoice). Other stamps up to 20261110150000 exist; none touches
--   these functions, their implementations or the guard trigger. Re-read the live ledger before
--   applying.
--
-- idempotency-body-check: exempt. Every wrapper reads idempotency_keys through
--   check_idempotency_intent with its own operation literal and writes it through
--   _bind_replay_receipt_20261015; the renamed bodies keep their own operation-scoped lookups.
--
-- Grants. Every REVOKE below is either (a) on a RENAMED body, which no caller names any more, or
-- (b) the routine "FROM PUBLIC, anon" on a freshly created wrapper that is then granted to
-- authenticated and service_role, which is exactly the live ACL of the function it replaces. The app
-- keeps calling the same names with the same arguments and reaches the wrappers:
-- caller-analysis: submit_purchase_order :: src/pages/NewPurchaseOrder.tsx and src/pages/PurchaseOrderDetail.tsx call the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: cancel_purchase_order :: src/pages/PurchaseOrderDetail.tsx (key scoped to the PO and reason) and src/pages/PurchaseOrders.tsx (deterministic per-user, per-PO key, default reason) call the same name and signature; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: delete_purchase_order :: no app caller; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: duplicate_quote :: src/pages/Quotes.tsx and src/pages/CustomerDetail.tsx call the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: edit_delivery :: src/pages/DeliveryDetail.tsx calls the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: reassign_delivery :: src/pages/Deliveries.tsx and src/pages/DeliveryDetail.tsx call the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: batch_reschedule_deliveries :: src/pages/Deliveries.tsx calls the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: confirm_delivery :: src/pages/DeliveryDetail.tsx and src/pages/FieldStop.tsx call (nothing queues it offline; a stale keyless queued call would be refused) the same name and signature with a key; start_and_complete_delivery's keyless call is retargeted to the renamed body below (_complete_delivery_authorized_impl names it only inside an error message); the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: create_delivery_with_items :: src/pages/NewDelivery.tsx calls the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: create_followup_delivery :: src/pages/DeliveryDetail.tsx and src/pages/DeliveryRemainders.tsx call the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: cancel_cycle_count :: src/pages/CycleCounts.tsx calls the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: reverse_blend_ticket_approval :: no app caller; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE replay_binding_batch4c_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

-- The operations the commit-time guard covers once this file is applied, in trigger order, recorded
-- by the guard step below and read back by the postflight.
CREATE TEMP TABLE replay_binding_batch4c_guard_ops (
  ord integer PRIMARY KEY,
  operation text NOT NULL UNIQUE
) ON COMMIT DROP;

-- The twelve bodies, exactly as reviewed live on 2026-11-05 (md5 ignores carriage returns), read by
-- the preflight and the postflight.
CREATE TEMP TABLE replay_binding_batch4c_pins ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('submit_purchase_order', 'p_po_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '12d5f9374d05e7e0613bad15619426da'),
  ('cancel_purchase_order', 'p_po_id uuid, p_reason text DEFAULT ''Cancelled''::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '2b11da898a510a31133845ff4944d01b'),
  ('delete_purchase_order', 'p_po_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'c8c377d53b0b28fc1b390932c26dbc68'),
  ('duplicate_quote', 'p_source_quote_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text, p_below_cost_reason text DEFAULT NULL::text', 'jsonb', 'c4a959bbdf94498c3fd16402e982b1d1'),
  ('edit_delivery', 'p_delivery_id uuid, p_assigned_driver uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT NULL::date, p_scheduled_time text DEFAULT NULL::text, p_delivery_window_start text DEFAULT NULL::text, p_delivery_window_end text DEFAULT NULL::text, p_delivery_address_id uuid DEFAULT NULL::uuid, p_delivery_notes text DEFAULT NULL::text, p_priority text DEFAULT NULL::text, p_items jsonb DEFAULT NULL::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '942011a2bf15b83269e74830fa057377'),
  ('reassign_delivery', 'p_delivery_id uuid, p_new_driver uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '360afbcbdc92ee1d32258de0aa101f50'),
  ('batch_reschedule_deliveries', 'p_delivery_ids uuid[], p_new_date date, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'd87ef756d7e5c30e2fe9cf722e68b646'),
  ('confirm_delivery', 'p_delivery_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'e294cd40bffe58edec45fed2910b7f1f'),
  ('create_delivery_with_items', 'p_order_id uuid, p_customer_id uuid, p_scheduled_date date, p_items jsonb, p_delivery_address_id uuid DEFAULT NULL::uuid, p_assigned_driver uuid DEFAULT NULL::uuid, p_scheduled_time text DEFAULT NULL::text, p_delivery_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'c358a85be64d54153d0efe11abb6fe82'),
  ('create_followup_delivery', 'p_original_delivery_id uuid, p_scheduled_date date DEFAULT NULL::date, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'da4e748e6139cc43247fdcfbfccf5251'),
  ('cancel_cycle_count', 'p_cycle_count_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'b3376eb75f5433b9c1febebeed60c827'),
  ('reverse_blend_ticket_approval', 'p_ticket_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '661f125700477c1dab21fb8d0f39baa0')
) AS pin(name, args, ret, body_md5);

-- The inner bodies that write the receipts the wrappers bind, and the below-cost gate, read by the
-- preflight (unchanged by this file).
CREATE TEMP TABLE replay_binding_batch4c_inner_pins ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('public._section9_submit_purchase_order_serialized(uuid,uuid,text)', 'dd639711fdceb089f4eb9c466ab23bae', true, ARRAY['postgres', 'service_role']::text[]),
  ('public._section9_cancel_purchase_order_serialized(uuid,text,uuid,text)', '57bd6a9408c65daf6d82bbf3750554f9', true, ARRAY['postgres', 'service_role']::text[]),
  ('public._section9_delete_purchase_order_serialized(uuid,uuid,text)', '3c91b72ae3c97bb473e83abc89a38f00', true, ARRAY['postgres', 'service_role']::text[]),
  ('public._duplicate_quote_below_cost_impl_20260810(uuid,uuid,text)', 'b15cd71cbbee64c327a8ebe7b1509299', true, ARRAY['postgres']::text[]),
  ('public._begin_below_cost_money_write(text,uuid,jsonb)', '309a01b18f3cd94dbc0146b031978a13', false, ARRAY['postgres', 'service_role']::text[])
) AS pin(sig, body_md5, secdef, acl);

DO $preflight$
DECLARE
  v_drift text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.replay_binding_batch4c_tx') IS NULL THEN
    RAISE EXCEPTION 'REPLAY_BINDING_BATCH4C_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.replay_binding_batch4c_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'REPLAY_BINDING_BATCH4C_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- Each body is the only overload of its name, with the live owner, attributes, grants and body,
  -- and no renamed copy exists yet.
  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_drift
    FROM pg_temp.replay_binding_batch4c_pins pin
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
    RAISE EXCEPTION 'PREFLIGHT_REPLAY_BATCH4C_BODY_DRIFT: expected the exact reviewed live body (and no renamed copy yet) for: %', v_drift;
  END IF;

  -- The inner receipt writers and the below-cost gate are the reviewed live bodies, with their ACLs.
  SELECT string_agg(i.sig, ', ' ORDER BY i.sig) INTO v_drift
    FROM pg_temp.replay_binding_batch4c_inner_pins i
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(i.sig)
        AND p.proowner = 'postgres'::regrole AND p.prosecdef = i.secdef
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND md5(replace(p.prosrc, chr(13), '')) = i.body_md5
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                    FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
            IS NOT DISTINCT FROM i.acl)
      OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.proname = split_part(split_part(i.sig, '(', 1), '.', 2)) <> 1;
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REPLAY_BATCH4C_INNER_DRIFT: these inner bodies differ from their reviewed live bodies or ACLs: %', v_drift;
  END IF;

  -- start_and_complete_delivery: the reviewed live body, containing the one keyless
  -- confirm_delivery call this file retargets, exactly once.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'start_and_complete_delivery') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid = to_regprocedure('public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text)')
          AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
          AND NOT p.proisstrict AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND pg_get_function_arguments(p.oid) = 'p_delivery_id uuid, p_signed_by text, p_delivered_on date, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_evidence text DEFAULT NULL::text, p_evidence_ref text DEFAULT NULL::text'
          AND md5(replace(p.prosrc, chr(13), '')) = '59a8dc1e372beb2bd443eebaeb83dd95'
          AND array_length(string_to_array(replace(p.prosrc, chr(13), ''), 'public.confirm_delivery(p_delivery_id, v_actor, NULL)'), 1) = 2
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres']::text[]) THEN
    RAISE EXCEPTION 'PREFLIGHT_START_AND_COMPLETE_DRIFT: start_and_complete_delivery differs from its reviewed live body';
  END IF;

  -- No other database function, in ANY schema, and no pg_cron job may call the twelve by name (read
  -- live 2026-11-05: only start_and_complete_delivery, retargeted below;
  -- _complete_delivery_authorized_impl names confirm_delivery only inside an error message). Comments
  -- and string literals are stripped before matching. The match ignores case and allows a quoted or
  -- schema-qualified name. A new caller would be refused for a missing key. Limit: a name assembled
  -- at run time in dynamic SQL cannot be seen here; such a caller would fail closed
  -- (IDEMPOTENCY_KEY_REQUIRED, nothing committed).
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname) INTO v_drift
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND NOT (n.nspname = 'public' AND p.proname IN (SELECT pin.name FROM pg_temp.replay_binding_batch4c_pins pin))
     AND NOT (n.nspname = 'public' AND p.proname = 'start_and_complete_delivery')
     AND regexp_replace(regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g'), '''[^'']*''', '', 'g')
         ~* '(^|[^_a-z0-9])(submit_purchase_order|cancel_purchase_order|delete_purchase_order|duplicate_quote|edit_delivery|reassign_delivery|batch_reschedule_deliveries|confirm_delivery|create_delivery_with_items|create_followup_delivery|cancel_cycle_count|reverse_blend_ticket_approval)"?\s*\(';
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: these functions call a batch 4c function and were not reviewed: %', v_drift;
  END IF;
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $cron$SELECT string_agg(jobname, ', ' ORDER BY jobname) FROM cron.job
                  WHERE command ~* '(submit_purchase_order|cancel_purchase_order|delete_purchase_order|duplicate_quote|edit_delivery|reassign_delivery|batch_reschedule_deliveries|confirm_delivery|create_delivery_with_items|create_followup_delivery|cancel_cycle_count|reverse_blend_ticket_approval)'$cron$ INTO v_drift;
    IF v_drift IS NOT NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: these pg_cron jobs call a batch 4c function and were not reviewed: %', v_drift;
    END IF;
  END IF;

  -- What the wrappers rely on: the intent check as installed by 20260811130000 (pinned), the two
  -- binding columns, auth.uid() (pinned) and batch 1's live helpers (pinned).
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

  -- Cutover: a receipt written by an old body carries no binding, and the intent check refuses it.
  -- So apply only while no unexpired receipt exists for the twelve operations; this transaction's
  -- ACCESS EXCLUSIVE lock keeps a new one from appearing before the guard covers them.
  LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys k
              WHERE k.operation IN (SELECT pin.name FROM pg_temp.replay_binding_batch4c_pins pin)
                AND (k.expires_at IS NULL OR k.expires_at >= now())) THEN
    RAISE EXCEPTION 'PREFLIGHT_UNEXPIRED_RECEIPTS: an unexpired receipt exists for a batch 4c operation; wait for it to expire (24 hours) and apply again';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- The commit-time guard now covers the twelve operations too (same trigger, same function),
-- keeping every operation it already covers. Only the live batch 1 to 4b state is accepted.
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
    'transition_rebate_claim',
    'price_order', 'update_order_items', 'mark_inventory_row_verified'];
  v_batch4c constant text[] := ARRAY[
    'submit_purchase_order', 'cancel_purchase_order', 'delete_purchase_order', 'duplicate_quote',
    'edit_delivery', 'reassign_delivery', 'batch_reschedule_deliveries', 'confirm_delivery',
    'create_delivery_with_items', 'create_followup_delivery', 'cancel_cycle_count',
    'reverse_blend_ticket_approval'];
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

  -- Batches 1 to 4b are live: only their 41-operation trigger is accepted.
  IF v_def = 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
            || (SELECT string_agg(quote_literal(o) || '::text', ', ' ORDER BY ord) FROM unnest(v_prior) WITH ORDINALITY AS u(o, ord))
            || ']))) EXECUTE FUNCTION _require_bound_replay_receipt_20261015()' THEN
    v_ops := v_prior || v_batch4c;
  ELSE
    RAISE EXCEPTION 'PREFLIGHT_RECEIPT_GUARD_DRIFT: require_bound_replay_receipt_20261015 is not the batch 1 to 4b trigger: %', v_def;
  END IF;

  INSERT INTO pg_temp.replay_binding_batch4c_guard_ops (ord, operation)
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
-- 1. submit_purchase_order
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.submit_purchase_order(uuid, uuid, text) RENAME TO _submit_purchase_order_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._submit_purchase_order_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.submit_purchase_order(
  p_po_id uuid,
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
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: submit_purchase_order requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  PERFORM pg_advisory_xact_lock(73492009);
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'po_id', p_po_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'submit_purchase_order', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._submit_purchase_order_replay_impl_20261015(p_po_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'submit_purchase_order', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_purchase_order(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_purchase_order(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. cancel_purchase_order
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.cancel_purchase_order(uuid, text, uuid, text) RENAME TO _cancel_purchase_order_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._cancel_purchase_order_replay_impl_20261015(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.cancel_purchase_order(
  p_po_id uuid,
  p_reason text DEFAULT 'Cancelled'::text,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: cancel_purchase_order requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  PERFORM pg_advisory_xact_lock(73492009);
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins or sales reps can cancel purchase orders';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'po_id', p_po_id, 'reason', p_reason));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'cancel_purchase_order', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._cancel_purchase_order_replay_impl_20261015(p_po_id, p_reason, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'cancel_purchase_order', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_purchase_order(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order(uuid, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. delete_purchase_order
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.delete_purchase_order(uuid, uuid, text) RENAME TO _delete_purchase_order_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._delete_purchase_order_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.delete_purchase_order(
  p_po_id uuid,
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
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: delete_purchase_order requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  PERFORM pg_advisory_xact_lock(73492009);
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND role = 'admin' AND is_active = true) THEN
    RAISE EXCEPTION 'Only admins can delete purchase orders';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'po_id', p_po_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'delete_purchase_order', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._delete_purchase_order_replay_impl_20261015(p_po_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'delete_purchase_order', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_purchase_order(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_purchase_order(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. duplicate_quote
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.duplicate_quote(uuid, uuid, text, text) RENAME TO _duplicate_quote_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._duplicate_quote_replay_impl_20261015(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.duplicate_quote(
  p_source_quote_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_below_cost_reason text DEFAULT NULL::text
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: duplicate_quote requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first step, then its implementation's first checks (same messages).
  PERFORM public._begin_below_cost_money_write(
    'duplicate_quote', p_performed_by,
    jsonb_build_object('below_cost_reason', p_below_cost_reason)
  );
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  -- The approved below-cost reason is transport metadata, not a different copy request.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'source_quote_id', p_source_quote_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'duplicate_quote', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._duplicate_quote_replay_impl_20261015(p_source_quote_id, p_performed_by, p_idempotency_key, p_below_cost_reason);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'duplicate_quote', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.duplicate_quote(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.duplicate_quote(uuid, uuid, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. edit_delivery
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.edit_delivery(uuid, uuid, date, text, text, text, uuid, text, text, jsonb, uuid, text) RENAME TO _edit_delivery_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._edit_delivery_replay_impl_20261015(uuid, uuid, date, text, text, text, uuid, text, text, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.edit_delivery(
  p_delivery_id uuid,
  p_assigned_driver uuid DEFAULT NULL::uuid,
  p_scheduled_date date DEFAULT NULL::date,
  p_scheduled_time text DEFAULT NULL::text,
  p_delivery_window_start text DEFAULT NULL::text,
  p_delivery_window_end text DEFAULT NULL::text,
  p_delivery_address_id uuid DEFAULT NULL::uuid,
  p_delivery_notes text DEFAULT NULL::text,
  p_priority text DEFAULT NULL::text,
  p_items jsonb DEFAULT NULL::jsonb,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: edit_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'delivery_id', p_delivery_id,
    'assigned_driver', p_assigned_driver, 'scheduled_date', p_scheduled_date,
    'scheduled_time', p_scheduled_time, 'delivery_window_start', p_delivery_window_start,
    'delivery_window_end', p_delivery_window_end, 'delivery_address_id', p_delivery_address_id,
    'delivery_notes', p_delivery_notes, 'priority', p_priority, 'items', p_items));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'edit_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._edit_delivery_replay_impl_20261015(
    p_delivery_id, p_assigned_driver, p_scheduled_date, p_scheduled_time, p_delivery_window_start,
    p_delivery_window_end, p_delivery_address_id, p_delivery_notes, p_priority, p_items,
    p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'edit_delivery', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.edit_delivery(uuid, uuid, date, text, text, text, uuid, text, text, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_delivery(uuid, uuid, date, text, text, text, uuid, text, text, jsonb, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. reassign_delivery
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.reassign_delivery(uuid, uuid, uuid, text) RENAME TO _reassign_delivery_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._reassign_delivery_replay_impl_20261015(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.reassign_delivery(
  p_delivery_id uuid,
  p_new_driver uuid,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: reassign_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'driver'
    ) OR NOT EXISTS (
      SELECT 1 FROM public.deliveries WHERE id = p_delivery_id AND assigned_driver IS NULL
    ) THEN
      RAISE EXCEPTION 'Not authorized to reassign deliveries';
    END IF;
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'delivery_id', p_delivery_id, 'new_driver', p_new_driver));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'reassign_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._reassign_delivery_replay_impl_20261015(p_delivery_id, p_new_driver, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'reassign_delivery', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.reassign_delivery(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reassign_delivery(uuid, uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. batch_reschedule_deliveries
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.batch_reschedule_deliveries(uuid[], date, uuid, text) RENAME TO _batch_reschedule_deliveries_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._batch_reschedule_deliveries_replay_impl_20261015(uuid[], date, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.batch_reschedule_deliveries(
  p_delivery_ids uuid[],
  p_new_date date,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: batch_reschedule_deliveries requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to reschedule deliveries';
  END IF;
  -- The set of deliveries, sorted and without repeats: a screen that re-lists them in another order
  -- is the same request.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'delivery_ids', (SELECT jsonb_agg(d ORDER BY d) FROM (SELECT DISTINCT unnest(p_delivery_ids) AS d) s),
    'new_date', p_new_date));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'batch_reschedule_deliveries', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._batch_reschedule_deliveries_replay_impl_20261015(p_delivery_ids, p_new_date, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'batch_reschedule_deliveries', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.batch_reschedule_deliveries(uuid[], date, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_reschedule_deliveries(uuid[], date, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 8. confirm_delivery
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.confirm_delivery(uuid, uuid, text) RENAME TO _confirm_delivery_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._confirm_delivery_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.confirm_delivery(
  p_delivery_id uuid,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: confirm_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages. A first call reaches the body's own
  -- role check; a replay re-runs that check below before anything is returned.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'delivery_id', p_delivery_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'confirm_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  -- A replay is handed back only to someone still allowed to start this delivery (the body's own
  -- check, same message): a driver taken off the delivery gets no saved success.
  IF v_replay IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.deliveries d WHERE d.id = p_delivery_id) THEN
      RAISE EXCEPTION 'Delivery not found';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles pr, public.deliveries d
      WHERE pr.id = v_actor AND pr.is_active = true AND d.id = p_delivery_id
        AND (pr.role IN ('admin', 'sales_rep') OR (pr.role = 'driver' AND v_actor = d.assigned_driver))
    ) THEN
      RAISE EXCEPTION 'Not authorized to start this delivery';
    END IF;
  END IF;
  v_result := public._confirm_delivery_replay_impl_20261015(p_delivery_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'confirm_delivery', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_delivery(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_delivery(uuid, uuid, text) TO authenticated, service_role;

-- start_and_complete_delivery: the one keyless confirm_delivery call now reaches the renamed body
-- (no key there: no receipt is read or written, as today). Built from the pinned live text by one
-- exact replacement; CREATE OR REPLACE keeps its owner and EXECUTE grants.
DO $retarget$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT replace(p.prosrc, chr(13), '') INTO v_src
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text)');
  IF v_src IS NULL OR md5(v_src) <> '59a8dc1e372beb2bd443eebaeb83dd95' THEN
    RAISE EXCEPTION 'RETARGET_START_AND_COMPLETE_DRIFT: start_and_complete_delivery differs from its reviewed live body';
  END IF;
  v_new := replace(v_src,
    'PERFORM public.confirm_delivery(p_delivery_id, v_actor, NULL);',
    'PERFORM public._confirm_delivery_replay_impl_20261015(p_delivery_id, v_actor, NULL);');
  IF array_length(string_to_array(v_src, 'PERFORM public.confirm_delivery(p_delivery_id, v_actor, NULL);'), 1) <> 2
     OR v_new = v_src THEN
    RAISE EXCEPTION 'RETARGET_START_AND_COMPLETE_DRIFT: expected exactly one keyless confirm_delivery call';
  END IF;
  -- Split so the disk scans (rpcIdempotencyScope) do not read the next function's body as this one's.
  EXECUTE 'CREATE OR REPLACE FUNCTION '
    || 'public.start_and_complete_delivery(p_delivery_id uuid, p_signed_by text, p_delivered_on date, p_performed_by uuid DEFAULT NULL::uuid, '
    || 'p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, '
    || 'p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, '
    || 'p_evidence text DEFAULT NULL::text, p_evidence_ref text DEFAULT NULL::text) '
    || 'RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS '
    || quote_literal(v_new);
END
$retarget$;

-- ---------------------------------------------------------------------------------------------
-- 9. create_delivery_with_items
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.create_delivery_with_items(uuid, uuid, date, jsonb, uuid, uuid, text, text, text) RENAME TO _create_delivery_with_items_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._create_delivery_with_items_replay_impl_20261015(uuid, uuid, date, jsonb, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_delivery_with_items(
  p_order_id uuid,
  p_customer_id uuid,
  p_scheduled_date date,
  p_items jsonb,
  p_delivery_address_id uuid DEFAULT NULL::uuid,
  p_assigned_driver uuid DEFAULT NULL::uuid,
  p_scheduled_time text DEFAULT NULL::text,
  p_delivery_notes text DEFAULT NULL::text,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_delivery_with_items requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'ORDER_ID_REQUIRED'; END IF;
  IF p_customer_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_ID_REQUIRED'; END IF;
  IF p_scheduled_date IS NULL THEN RAISE EXCEPTION 'SCHEDULED_DATE_REQUIRED'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'ITEMS_REQUIRED';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'order_id', p_order_id, 'customer_id', p_customer_id,
    'scheduled_date', p_scheduled_date, 'items', p_items,
    'delivery_address_id', p_delivery_address_id, 'assigned_driver', p_assigned_driver,
    'scheduled_time', p_scheduled_time, 'delivery_notes', p_delivery_notes));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_delivery_with_items', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._create_delivery_with_items_replay_impl_20261015(
    p_order_id, p_customer_id, p_scheduled_date, p_items, p_delivery_address_id, p_assigned_driver,
    p_scheduled_time, p_delivery_notes, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_delivery_with_items', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_delivery_with_items(uuid, uuid, date, jsonb, uuid, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_delivery_with_items(uuid, uuid, date, jsonb, uuid, uuid, text, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 10. create_followup_delivery
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.create_followup_delivery(uuid, date, uuid, text) RENAME TO _create_followup_delivery_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._create_followup_delivery_replay_impl_20261015(uuid, date, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_followup_delivery(
  p_original_delivery_id uuid,
  p_scheduled_date date DEFAULT NULL::date,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_followup_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'original_delivery_id', p_original_delivery_id,
    'scheduled_date', p_scheduled_date));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_followup_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._create_followup_delivery_replay_impl_20261015(p_original_delivery_id, p_scheduled_date, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_followup_delivery', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_followup_delivery(uuid, date, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_followup_delivery(uuid, date, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 11. cancel_cycle_count
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.cancel_cycle_count(uuid, uuid, text) RENAME TO _cancel_cycle_count_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._cancel_cycle_count_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.cancel_cycle_count(
  p_cycle_count_id uuid,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: cancel_cycle_count requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required to cancel a cycle count';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'cycle_count_id', p_cycle_count_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'cancel_cycle_count', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._cancel_cycle_count_replay_impl_20261015(p_cycle_count_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'cancel_cycle_count', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_cycle_count(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_cycle_count(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 12. reverse_blend_ticket_approval
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.reverse_blend_ticket_approval(uuid, text, uuid, text) RENAME TO _reverse_blend_ticket_approval_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._reverse_blend_ticket_approval_replay_impl_20261015(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.reverse_blend_ticket_approval(
  p_ticket_id uuid,
  p_reason text,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: reverse_blend_ticket_approval requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The body's first steps, in its order and with its messages.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reverse a blend ticket approval';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'ticket_id', p_ticket_id, 'reason', p_reason));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'reverse_blend_ticket_approval', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._reverse_blend_ticket_approval_replay_impl_20261015(p_ticket_id, p_reason, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'reverse_blend_ticket_approval', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_blend_ticket_approval(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_blend_ticket_approval(uuid, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------------------------
DO $postflight$
DECLARE
  v_bad text;
  v_expected_def text;
  v_src text;
BEGIN
  IF to_regclass('pg_temp.replay_binding_batch4c_tx') IS NULL THEN
    RAISE EXCEPTION 'REPLAY_BINDING_BATCH4C_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.replay_binding_batch4c_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'REPLAY_BINDING_BATCH4C_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_bad
    FROM pg_temp.replay_binding_batch4c_pins pin
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
    RAISE EXCEPTION 'POSTFLIGHT_REPLAY_BATCH4C_CONTRACT: wrapper or renamed body drifted for: %', v_bad;
  END IF;

  -- start_and_complete_delivery: same owner, attributes and grants; its only change is the one
  -- retargeted call.
  SELECT replace(p.prosrc, chr(13), '') INTO v_src
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text)')
     AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
     AND NOT p.proisstrict AND NOT p.proretset AND p.prorettype = 'jsonb'::regtype
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     AND pg_get_function_arguments(p.oid) = 'p_delivery_id uuid, p_signed_by text, p_delivered_on date, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_evidence text DEFAULT NULL::text, p_evidence_ref text DEFAULT NULL::text'
     AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                 FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
         IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres']::text[];
  IF v_src IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'start_and_complete_delivery') <> 1
     OR strpos(v_src, 'public.confirm_delivery(') > 0
     OR md5(replace(v_src,
          'PERFORM public._confirm_delivery_replay_impl_20261015(p_delivery_id, v_actor, NULL);',
          'PERFORM public.confirm_delivery(p_delivery_id, v_actor, NULL);')) <> '59a8dc1e372beb2bd443eebaeb83dd95' THEN
    RAISE EXCEPTION 'POSTFLIGHT_START_AND_COMPLETE_CONTRACT: start_and_complete_delivery must differ from its reviewed body only by the retargeted confirm call';
  END IF;

  -- The commit-time guard: the one trigger running the guard function, exactly as recorded above
  -- (every previously covered operation, then these twelve), deferred AFTER INSERT OR UPDATE per row.
  IF (SELECT count(*) FROM pg_temp.replay_binding_batch4c_guard_ops) <> 53
     OR (SELECT count(*) FROM pg_temp.replay_binding_batch4c_guard_ops
          WHERE operation IN (SELECT pin.name FROM pg_temp.replay_binding_batch4c_pins pin)) <> 12 THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECEIPT_GUARD_CONTRACT: the recorded guard operation list is not a reviewed state';
  END IF;
  v_expected_def := 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
    || (SELECT string_agg(quote_literal(g.operation) || '::text', ', ' ORDER BY g.ord) FROM pg_temp.replay_binding_batch4c_guard_ops g)
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

  RAISE NOTICE 'POSTFLIGHT_OK: the twelve batch 4c functions now replay a stored result only for the same person and the exact same request';
END
$postflight$;
