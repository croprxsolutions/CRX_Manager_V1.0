-- Written 2026-11-02. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: batch 4a of the system-wide idempotency replay-binding fix (KNOWN_ISSUES.md KI-10 / KI-75,
--   "live functions replay a saved result matched on the retry key alone"). This cut binds the
--   remaining HIGH money functions on invoices, accounting periods and rebates:
--     unpost_invoice                      (posted invoice back to unposted: payments, prepay, credit
--                                          and RUP records reversed)
--     unpost_invoice_group                (every member of a field-billing invoice group, all or none)
--     close_accounting_period             (locks a month for posting)
--     reopen_accounting_period            (unlocks a closed month, with a reason)
--     transfer_invoice_to_job             (draft field invoice back to a scheduled job)
--     save_field_app_invoice              (create or edit a field-application invoice: lines, cost)
--     update_field_app_invoice_billing    (PO, terms, notes, due date and Discount Earned)
--     consolidate_draft_invoices          (merges an order's draft invoices into one)
--     update_blend_ticket_billing_status  (blend ticket payment status)
--     create_rebate_claim                 (new manufacturer rebate claim)
--     transition_rebate_claim             (claim submitted / approved / paid / rejected)
--   Each replays a stored receipt matched on the retry key alone (unpost_invoice_group also checks
--   its group id, but not the person), so a retry that reuses a key for a DIFFERENT invoice, month,
--   order, ticket or claim, or with edited values, or from a different user, gets the first call's
--   "done" answer and the new request is never carried out (a false success; nothing is ever done
--   twice).
--
--   The fix is batch 1's pattern (20261016060000), reusing its live helpers: each live body is
--   RENAMED unchanged to _<name>_replay_impl_20261015 (no API role may call it), and a public wrapper
--   with the identical signature, defaults, return type, owner, search_path and grants takes its
--   place. With a key, the wrapper
--     1. runs the same auth, actor and role tests its renamed body runs, in the same order and with
--        the same messages, so no stored result is ever returned before the role check;
--     2. computes a SHA-256 fingerprint of the actor and every request argument except the key and
--        p_performed_by (which step 1 has already proved equals the actor, or is NULL);
--     3. calls check_idempotency_intent(key, op, auth.uid(), fingerprint), which takes the per-key
--        advisory lock (crx:idempotency:<key>). No receipt: run the body. Exact actor + intent
--        match: run the body, which replays its own stored answer exactly as before. Anything else
--        is refused with IDEMPOTENCY_ACTOR_MISMATCH or IDEMPOTENCY_INTENT_MISMATCH, which the app
--        maps to plain English (src/lib/idempotency.ts getIdempotencyBindingRejection,
--        src/lib/errorSanitizer.ts);
--     4. after a fresh run, stamps request_actor_id and request_fingerprint onto the receipt the body
--        just wrote (_bind_replay_receipt_20261015), and refuses (rolls the call back) if the body
--        wrote none. Every body writes a receipt on every fresh keyed success (read live 2026-11-02:
--        save_idempotency or a direct INSERT at the end of each; save_field_app_invoice's through
--        _save_field_app_invoice_impl_20260714's INSERT). One body answers WITHOUT a receipt:
--        update_blend_ticket_billing_status returns {success: false, error: ...} (ticket not found,
--        or 'billed' with no linked order or invoice) before any write; its wrapper binds only when
--        success is not false, as batch 2 did for create_order_from_blend_ticket. A retry of that
--        refusal simply gets the same refusal again.
--   A key is REQUIRED from callers (IDEMPOTENCY_KEY_REQUIRED, 22023), as in batches 1 to 3b: a
--   keyless call would run with no receipt. Every app caller already sends one (caller-analysis lines
--   below); update_blend_ticket_billing_status has no app caller at all.
--
--   The one internal keyless caller: unpost_invoice_group's body calls unpost_invoice once per group
--   member with NO key. Its renamed body is recreated below from the pinned live body with that one
--   call retargeted to _unpost_invoice_replay_impl_20261015 (the renamed body, same arguments), as
--   batch 2 did for revert_quote_status and batch 3b for the batch-cancel body. So a group unpost
--   behaves exactly as before: same per-member checks and work, no per-member receipt;
--   unpost_invoice_group's own wrapper binds the group receipt.
--
--   Why a body's own key-only lookup cannot return ANOTHER operation's receipt on an exact match:
--   idempotency_keys has a UNIQUE index on idempotency_key, so a key has at most one row, and
--   check_idempotency_intent has already refused it (IDEMPOTENCY_CROSS_OP_KEY_REUSE) unless that row
--   is this operation's, under the lock.
--
--   COMMIT-TIME GUARD: batch 1's deferred constraint trigger require_bound_replay_receipt_20261015
--   now also covers the eleven operations. A trigger's WHEN clause cannot be altered, so the trigger
--   is dropped and recreated with the same name, function and timing, inside this transaction under
--   its ACCESS EXCLUSIVE lock on idempotency_keys (no gap is visible). No second trigger is created.
--   Only the live batch 1 + 2 + 3a + 3b trigger (27 operations, read live 2026-11-02) is accepted;
--   any other definition refuses the apply (PREFLIGHT_RECEIPT_GUARD_DRIFT), and the result covers 38.
--
-- WHAT DOES NOT CHANGE: no money, period, invoice, rebate or blend-ticket logic is retyped (the
--   eleven bodies are renamed, pinned by md5 below; unpost_invoice_group's differs only by its one
--   retargeted call); no table, row, policy or receipt changes; every keyed legitimate call (first
--   call, exact retry) returns what it returns today. A keyless call to the eleven public names is
--   now refused (IDEMPOTENCY_KEY_REQUIRED). Checks that now run before the renamed bodies: the key
--   requirement, the auth/actor/role tests (same messages), and the actor/intent binding. A
--   DIFFERENT user retrying someone else's key is refused by the binding
--   (IDEMPOTENCY_ACTOR_MISMATCH), which shows them nothing: check_idempotency_intent discloses a
--   stored result only to the same actor.
--
-- RECEIPT DISCLOSURE: as batch 1. The preflight refuses to apply while any unexpired receipt exists
--   for the eleven operations (none existed when read live on 2026-11-02) and the commit-time guard
--   keeps an unbound one from ever committing.
--
-- ACCESS: this file narrows access, so it applies only on Mason's owner approval
--   (scripts/owner-approve-migration.mjs): the eleven renamed bodies lose EXECUTE and a keyless call
--   is refused. It widens nothing.
--
-- NOT IN THIS BATCH (KI-10 batch 4b, 4c, 4d and the PARTIAL group): the credit-memo apply / unapply
--   / reverse functions, save_field_app_split_invoice, create_invoice_from_blend_ticket and
--   admin_update_profile (their target is already checked; the gap is the person), and the quote,
--   order, purchase-order, inventory, delivery, job and MED/LOW groups.
--
-- OVERLOADS: each of the eleven has exactly one overload (read-only on live 2026-11-02); the
--   preflight refuses a second one and the postflight proves exactly one wrapper and one body per
--   name.
--
-- ROLLBACK (if ever needed, as its own reviewed migration), in this order: FIRST recreate
--   require_bound_replay_receipt_20261015 without the eleven operations (left covering them, it would
--   refuse every receipt the restored old bodies write, rolling back their work); then, for each
--   name, DROP the wrapper, ALTER FUNCTION public._<name>_replay_impl_20261015(...) RENAME TO <name>,
--   and restore its grants (EXECUTE to authenticated, service_role); finally restore
--   unpost_invoice_group's call to the public unpost_invoice.
--
-- KNOWN LIMITS (each fails safe, nothing wrong is committed):
--   * The binding runs before the body's record checks, so a caller who retries THEIR OWN key with an
--     edited request inside 24 hours sees their own earlier result in the refusal DETAIL (batch 1 has
--     the same shape; another user never sees it). The field-invoice screen uses exactly that: when
--     its retry with edited values is refused, it reads the invoice the earlier attempt saved from
--     the DETAIL and saves the current values onto it under a new key.
--   * The fingerprint covers the arguments as sent. save_field_app_invoice's non-admin chemical cost
--     is replaced by the server inside the body; the replaced value is not part of the request.
--
-- ORDERING: strict. Live high-water when written: ledger 20261102144057 (20261102100000); then
--   20261102102000 (PR #1272) applied as ledger 20261102155933, and 20261102140000 (PR #1284,
--   cancel_delivery bodies only) as ledger 20261102174004. Renumbered from 20261102110000 to sit
--   above that live high-water; none of these touches these functions or the guard trigger.
--   Re-read the live ledger before applying.
--
-- idempotency-body-check: exempt. Every wrapper reads idempotency_keys through
--   check_idempotency_intent with its own operation literal and writes it through
--   _bind_replay_receipt_20261015; the renamed bodies keep their own operation-scoped lookups.
--
-- Grants. Every REVOKE below is either (a) on a RENAMED body, which no caller names any more, or
-- (b) the routine "FROM PUBLIC, anon" on a freshly created wrapper that is then granted to
-- authenticated and service_role, which is exactly the live ACL of the function it replaces. The app
-- keeps calling the same names with the same arguments and reaches the wrappers:
-- caller-analysis: unpost_invoice :: src/pages/InvoiceDetail.tsx, src/pages/FieldApplicationInvoice.tsx and src/components/field-invoices/FieldInvoicesPostedPanel.tsx call the same name and signature with a key; unpost_invoice_group's renamed body (postgres-owned definer) now calls the renamed body directly; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: unpost_invoice_group :: src/pages/InvoiceDetail.tsx and src/pages/FieldApplicationInvoice.tsx call the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: close_accounting_period :: src/pages/MonthEndClose.tsx calls the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: reopen_accounting_period :: src/pages/MonthEndClose.tsx calls the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: transfer_invoice_to_job :: src/pages/InvoiceDetail.tsx and src/pages/FieldApplicationInvoice.tsx call the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: save_field_app_invoice :: src/pages/FieldApplicationInvoice.tsx calls the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: update_field_app_invoice_billing :: src/pages/FieldApplicationInvoice.tsx calls the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: consolidate_draft_invoices :: src/pages/OrderDetail.tsx calls the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: update_blend_ticket_billing_status :: no app, edge-function, script or database caller; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: create_rebate_claim :: src/pages/Rebates.tsx calls the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: transition_rebate_claim :: src/pages/Rebates.tsx calls the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE money_replay_binding_batch4a_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

-- The operations the commit-time guard covers once this file is applied, in trigger order, recorded
-- by the guard step below and read back by the postflight.
CREATE TEMP TABLE money_replay_binding_batch4a_guard_ops (
  ord integer PRIMARY KEY,
  operation text NOT NULL UNIQUE
) ON COMMIT DROP;

-- The eleven bodies, exactly as reviewed live on 2026-11-02 (md5 ignores carriage returns), read by
-- the preflight and the postflight.
CREATE TEMP TABLE money_replay_binding_batch4a_pins ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('unpost_invoice', 'p_invoice_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '161f18c3ccd6126a6fb683c5160f82dc'),
  ('unpost_invoice_group', 'p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'dc476e07621c4c7dc86595442ed1a9f0'),
  ('close_accounting_period', 'p_period_end date, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'f29caf0f2bf34e8710dd538d091e4188'),
  ('reopen_accounting_period', 'p_period_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '94386f316a04f9042f4d045b297912c3'),
  ('transfer_invoice_to_job', 'p_invoice_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '7394bd0343c19e98bf746576a56bf6e4'),
  ('save_field_app_invoice', 'p_invoice_id uuid, p_invoice jsonb, p_locations jsonb, p_chemicals jsonb, p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '49d9d50da55cfb74c527eaf1f69da236'),
  ('update_field_app_invoice_billing', 'p_invoice_ids uuid[], p_purchase_order_ref text DEFAULT NULL::text, p_payment_terms text DEFAULT NULL::text, p_header_notes text DEFAULT NULL::text, p_due_date date DEFAULT NULL::date, p_footer_notes text DEFAULT NULL::text, p_internal_notes text DEFAULT NULL::text, p_discounts jsonb DEFAULT ''{}''::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '34695e4be9724bf46dc5e962f8f0e478'),
  ('consolidate_draft_invoices', 'p_order_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '0c8394691ef461ba780fd4ba0e770c51'),
  ('update_blend_ticket_billing_status', 'p_blend_ticket_id uuid, p_payment_status text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text', 'json', '6c57e538532ec7bc69d0bd641701f786'),
  ('create_rebate_claim', 'p_program_id uuid, p_quantity numeric, p_claim_amount_cents bigint, p_order_id uuid DEFAULT NULL::uuid, p_customer_id uuid DEFAULT NULL::uuid, p_product_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '1cb36f7b9a9b2df8d3637ce058f10394'),
  ('transition_rebate_claim', 'p_claim_id uuid, p_new_status text, p_paid_amount_cents bigint DEFAULT NULL::bigint, p_manufacturer_ref text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'de22ed84218873c02023720f5f4d06e1')
) AS pin(name, args, ret, body_md5);

DO $preflight$
DECLARE
  v_drift text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.money_replay_binding_batch4a_tx') IS NULL THEN
    RAISE EXCEPTION 'MONEY_REPLAY_BINDING_BATCH4A_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.money_replay_binding_batch4a_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'MONEY_REPLAY_BINDING_BATCH4A_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- Each body is the only overload of its name, with the live owner, attributes, grants and body,
  -- and no renamed copy exists yet.
  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_drift
    FROM pg_temp.money_replay_binding_batch4a_pins pin
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
    RAISE EXCEPTION 'PREFLIGHT_MONEY_REPLAY_BATCH4A_BODY_DRIFT: expected the exact reviewed live body (and no renamed copy yet) for: %', v_drift;
  END IF;

  -- No other database function, in ANY schema, and no pg_cron job may call the eleven by name (read
  -- live 2026-11-02: only unpost_invoice_group calls unpost_invoice, retargeted below; no cron job).
  -- The match ignores case and allows a quoted or schema-qualified name. A new caller would be
  -- refused for a missing key. Limit: a name assembled at run time in dynamic SQL cannot be seen
  -- here; such a caller would fail closed (IDEMPOTENCY_KEY_REQUIRED, nothing committed).
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname) INTO v_drift
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND NOT (n.nspname = 'public' AND p.proname IN (SELECT pin.name FROM pg_temp.money_replay_binding_batch4a_pins pin))
     AND p.prosrc ~* '(^|[^_a-z0-9])(unpost_invoice|unpost_invoice_group|close_accounting_period|reopen_accounting_period|transfer_invoice_to_job|save_field_app_invoice|update_field_app_invoice_billing|consolidate_draft_invoices|update_blend_ticket_billing_status|create_rebate_claim|transition_rebate_claim)"?\s*\(';
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: these functions call a batch 4a function and were not reviewed: %', v_drift;
  END IF;
  -- The one reviewed internal caller: unpost_invoice_group's body makes exactly one unpost_invoice
  -- call (its md5 is pinned above), the one retargeted below.
  IF (SELECT count(*) FROM regexp_matches(
        (SELECT replace(p.prosrc, chr(13), '') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'unpost_invoice_group'),
        '(^|[^_a-z0-9])unpost_invoice\s*\(', 'g')) <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: unpost_invoice_group must call unpost_invoice exactly once';
  END IF;
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $cron$SELECT string_agg(jobname, ', ' ORDER BY jobname) FROM cron.job
                  WHERE command ~* '(unpost_invoice|close_accounting_period|reopen_accounting_period|transfer_invoice_to_job|save_field_app_invoice|update_field_app_invoice_billing|consolidate_draft_invoices|update_blend_ticket_billing_status|create_rebate_claim|transition_rebate_claim)'$cron$ INTO v_drift;
    IF v_drift IS NOT NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: these pg_cron jobs call a batch 4a function and were not reviewed: %', v_drift;
    END IF;
  END IF;

  -- What the wrappers rely on: the intent check as installed by 20260811130000 (pinned), the two
  -- binding columns, auth.uid() (pinned), and batch 1's live helpers (pinned).
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
  -- So apply only while no unexpired receipt exists for the eleven operations; this transaction's
  -- ACCESS EXCLUSIVE lock keeps a new one from appearing before the guard covers them.
  LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys k
              WHERE k.operation IN (SELECT pin.name FROM pg_temp.money_replay_binding_batch4a_pins pin)
                AND (k.expires_at IS NULL OR k.expires_at >= now())) THEN
    RAISE EXCEPTION 'PREFLIGHT_UNEXPIRED_RECEIPTS: an unexpired receipt exists for a batch 4a operation; wait for it to expire (24 hours) and apply again';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- The commit-time guard now covers the eleven operations too (same trigger, same function), keeping
-- every operation it already covers. Only the live batch-1+2+3a+3b state is accepted.
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
    'cancel_delivery', 'void_delivery', 'void_order'];
  v_batch4a constant text[] := ARRAY[
    'unpost_invoice', 'unpost_invoice_group', 'close_accounting_period', 'reopen_accounting_period',
    'transfer_invoice_to_job', 'save_field_app_invoice', 'update_field_app_invoice_billing',
    'consolidate_draft_invoices', 'update_blend_ticket_billing_status', 'create_rebate_claim',
    'transition_rebate_claim'];
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

  -- Batches 1, 2, 3a and 3b are live: only their 27-operation trigger is accepted.
  IF v_def = 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
            || (SELECT string_agg(quote_literal(o) || '::text', ', ' ORDER BY ord) FROM unnest(v_prior) WITH ORDINALITY AS u(o, ord))
            || ']))) EXECUTE FUNCTION _require_bound_replay_receipt_20261015()' THEN
    v_ops := v_prior || v_batch4a;
  ELSE
    RAISE EXCEPTION 'PREFLIGHT_RECEIPT_GUARD_DRIFT: require_bound_replay_receipt_20261015 is not the batch-1+2+3a+3b trigger: %', v_def;
  END IF;

  INSERT INTO pg_temp.money_replay_binding_batch4a_guard_ops (ord, operation)
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
-- 1. unpost_invoice (also called, keyless, by unpost_invoice_group's body: see 2.)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.unpost_invoice(uuid, uuid, text) RENAME TO _unpost_invoice_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._unpost_invoice_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.unpost_invoice(
  p_invoice_id uuid,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: unpost_invoice requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'invoice_id', p_invoice_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'unpost_invoice', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._unpost_invoice_replay_impl_20261015(p_invoice_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'unpost_invoice', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.unpost_invoice(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unpost_invoice(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. unpost_invoice_group. Its renamed body is then recreated from its pinned live body with ONE
--    change: the per-member unpost_invoice(...) call retargeted to the renamed body (same arguments,
--    still keyless). CREATE OR REPLACE keeps its owner and its postgres-only EXECUTE.
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.unpost_invoice_group(uuid, uuid, text) RENAME TO _unpost_invoice_group_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._unpost_invoice_group_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._unpost_invoice_group_replay_impl_20261015(p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_inv            record;
  v_unposted_ids   uuid[] := '{}';
  v_total_cents    bigint := 0;
  v_member_count   int := 0;
  v_result         jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to unpost invoice groups';
  END IF;

  IF p_invoice_group_id IS NULL THEN RAISE EXCEPTION 'invoice_group_id is required'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'unpost_invoice_group';
    IF v_existing IS NOT NULL THEN
      -- Replay-safety: only return a cached result that belongs to the SAME group
      -- (the page-level idempotency key persists across navigations; if group A's call
      -- succeeded but the client timed out before reset and the user then unposts group
      -- B under the SAME key, a blind replay would report A's success while B stays
      -- posted). Refuse a mismatched replay with an honest error instead of a silent
      -- wrong-group success (Codex).
      IF (v_existing->>'invoice_group_id') IS DISTINCT FROM p_invoice_group_id::text THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: this key was already used for a different invoice group';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  -- Lock the group's members for the duration of the transaction.
  PERFORM 1 FROM invoices WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL FOR UPDATE;

  SELECT COUNT(*) INTO v_member_count FROM invoices WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL;
  IF v_member_count = 0 THEN RAISE EXCEPTION 'No invoices found in group %', p_invoice_group_id; END IF;

  -- Unpost EVERY member in this single transaction. unpost_invoice enforces, per member,
  -- the status/money/closed-period guards and writes the append-only audit row; if ANY
  -- member cannot be unposted it RAISES and the whole transaction rolls back (all-or-nothing).
  FOR v_inv IN SELECT * FROM invoices WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL ORDER BY invoice_number
  LOOP
    PERFORM _unpost_invoice_replay_impl_20261015(v_inv.id, p_performed_by, NULL);
    v_unposted_ids := array_append(v_unposted_ids, v_inv.id);
    v_total_cents := v_total_cents + COALESCE(v_inv.total_amount_cents, 0);
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('invoice_group_unposted',
          'Unposted ' || v_member_count || ' invoice(s) in group — total $' ||
            (v_total_cents / 100.0)::numeric(12,2),
          p_performed_by, 'invoice', v_unposted_ids[1]);

  v_result := jsonb_build_object(
    'success',              true,
    'unposted_invoice_ids', to_jsonb(v_unposted_ids),
    'invoice_group_id',     p_invoice_group_id,
    'total_unposted_cents', v_total_cents,
    'member_count',         v_member_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'unpost_invoice_group', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE FUNCTION public.unpost_invoice_group(
  p_invoice_group_id uuid,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: unpost_invoice_group requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to unpost invoice groups';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'invoice_group_id', p_invoice_group_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'unpost_invoice_group', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._unpost_invoice_group_replay_impl_20261015(p_invoice_group_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'unpost_invoice_group', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.unpost_invoice_group(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unpost_invoice_group(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. close_accounting_period
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.close_accounting_period(date, uuid, text) RENAME TO _close_accounting_period_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._close_accounting_period_replay_impl_20261015(date, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.close_accounting_period(
  p_period_end date,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: close_accounting_period requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND role = 'admin' AND is_active = true) THEN
    RAISE EXCEPTION 'Only admin users can close accounting periods';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'period_end', p_period_end));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'close_accounting_period', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._close_accounting_period_replay_impl_20261015(p_period_end, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'close_accounting_period', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.close_accounting_period(date, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_accounting_period(date, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. reopen_accounting_period
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.reopen_accounting_period(uuid, text, uuid, text) RENAME TO _reopen_accounting_period_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._reopen_accounting_period_replay_impl_20261015(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.reopen_accounting_period(
  p_period_id uuid,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: reopen_accounting_period requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'period_id', p_period_id, 'reason', p_reason));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'reopen_accounting_period', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._reopen_accounting_period_replay_impl_20261015(p_period_id, p_reason, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'reopen_accounting_period', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.reopen_accounting_period(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_accounting_period(uuid, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. transfer_invoice_to_job
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.transfer_invoice_to_job(uuid, uuid, text) RENAME TO _transfer_invoice_to_job_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._transfer_invoice_to_job_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.transfer_invoice_to_job(
  p_invoice_id uuid,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: transfer_invoice_to_job requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'invoice_id', p_invoice_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'transfer_invoice_to_job', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._transfer_invoice_to_job_replay_impl_20261015(p_invoice_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'transfer_invoice_to_job', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.transfer_invoice_to_job(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_invoice_to_job(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. save_field_app_invoice (its renamed body still delegates to _save_field_app_invoice_cost_step2_impl)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, uuid, text) RENAME TO _save_field_app_invoice_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._save_field_app_invoice_replay_impl_20261015(uuid, jsonb, jsonb, jsonb, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.save_field_app_invoice(
  p_invoice_id uuid,
  p_invoice jsonb,
  p_locations jsonb,
  p_chemicals jsonb,
  p_performed_by uuid,
  p_application_service_id uuid DEFAULT NULL::uuid,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: save_field_app_invoice requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL OR p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: active admin or sales role required to save field application invoices';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'invoice_id', p_invoice_id, 'invoice', p_invoice,
    'locations', p_locations, 'chemicals', p_chemicals,
    'application_service_id', p_application_service_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'save_field_app_invoice', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._save_field_app_invoice_replay_impl_20261015(
    p_invoice_id, p_invoice, p_locations, p_chemicals, p_performed_by,
    p_application_service_id, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'save_field_app_invoice', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. update_field_app_invoice_billing
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.update_field_app_invoice_billing(uuid[], text, text, text, date, text, text, jsonb, uuid, text) RENAME TO _update_field_app_invoice_billing_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._update_field_app_invoice_billing_replay_impl_20261015(uuid[], text, text, text, date, text, text, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.update_field_app_invoice_billing(
  p_invoice_ids uuid[],
  p_purchase_order_ref text DEFAULT NULL::text,
  p_payment_terms text DEFAULT NULL::text,
  p_header_notes text DEFAULT NULL::text,
  p_due_date date DEFAULT NULL::date,
  p_footer_notes text DEFAULT NULL::text,
  p_internal_notes text DEFAULT NULL::text,
  p_discounts jsonb DEFAULT '{}'::jsonb,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: update_field_app_invoice_billing requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match the authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save invoice billing details';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'invoice_ids', to_jsonb(p_invoice_ids),
    'purchase_order_ref', p_purchase_order_ref, 'payment_terms', p_payment_terms,
    'header_notes', p_header_notes, 'due_date', p_due_date, 'footer_notes', p_footer_notes,
    'internal_notes', p_internal_notes, 'discounts', p_discounts));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'update_field_app_invoice_billing', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._update_field_app_invoice_billing_replay_impl_20261015(
    p_invoice_ids, p_purchase_order_ref, p_payment_terms, p_header_notes, p_due_date,
    p_footer_notes, p_internal_notes, p_discounts, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'update_field_app_invoice_billing', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_field_app_invoice_billing(uuid[], text, text, text, date, text, text, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_field_app_invoice_billing(uuid[], text, text, text, date, text, text, jsonb, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 8. consolidate_draft_invoices
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.consolidate_draft_invoices(uuid, uuid, text) RENAME TO _consolidate_draft_invoices_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._consolidate_draft_invoices_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.consolidate_draft_invoices(
  p_order_id uuid,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: consolidate_draft_invoices requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'order_id', p_order_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'consolidate_draft_invoices', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._consolidate_draft_invoices_replay_impl_20261015(p_order_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'consolidate_draft_invoices', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.consolidate_draft_invoices(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidate_draft_invoices(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 9. update_blend_ticket_billing_status (returns json, as its body does)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.update_blend_ticket_billing_status(uuid, text, uuid, text) RENAME TO _update_blend_ticket_billing_status_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._update_blend_ticket_billing_status_replay_impl_20261015(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.update_blend_ticket_billing_status(
  p_blend_ticket_id uuid,
  p_payment_status text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT auth.uid(),
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result json;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: update_blend_ticket_billing_status requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'blend_ticket_id', p_blend_ticket_id, 'payment_status', p_payment_status));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'update_blend_ticket_billing_status', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._update_blend_ticket_billing_status_replay_impl_20261015(p_blend_ticket_id, p_payment_status, p_performed_by, p_idempotency_key);
  -- A {success: false} answer is returned before any write, with no receipt: nothing to bind.
  IF v_replay IS NULL AND (v_result::jsonb -> 'success') IS DISTINCT FROM 'false'::jsonb THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'update_blend_ticket_billing_status', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_blend_ticket_billing_status(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_blend_ticket_billing_status(uuid, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 10. create_rebate_claim
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.create_rebate_claim(uuid, numeric, bigint, uuid, uuid, uuid, text, text) RENAME TO _create_rebate_claim_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._create_rebate_claim_replay_impl_20261015(uuid, numeric, bigint, uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_rebate_claim(
  p_program_id uuid,
  p_quantity numeric,
  p_claim_amount_cents bigint,
  p_order_id uuid DEFAULT NULL::uuid,
  p_customer_id uuid DEFAULT NULL::uuid,
  p_product_id uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_rebate_claim requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'program_id', p_program_id, 'quantity', p_quantity,
    'claim_amount_cents', p_claim_amount_cents, 'order_id', p_order_id,
    'customer_id', p_customer_id, 'product_id', p_product_id, 'notes', p_notes));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_rebate_claim', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._create_rebate_claim_replay_impl_20261015(
    p_program_id, p_quantity, p_claim_amount_cents, p_order_id, p_customer_id, p_product_id,
    p_notes, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_rebate_claim', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_rebate_claim(uuid, numeric, bigint, uuid, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_rebate_claim(uuid, numeric, bigint, uuid, uuid, uuid, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 11. transition_rebate_claim
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.transition_rebate_claim(uuid, text, bigint, text, text) RENAME TO _transition_rebate_claim_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._transition_rebate_claim_replay_impl_20261015(uuid, text, bigint, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.transition_rebate_claim(
  p_claim_id uuid,
  p_new_status text,
  p_paid_amount_cents bigint DEFAULT NULL::bigint,
  p_manufacturer_ref text DEFAULT NULL::text,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: transition_rebate_claim requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'claim_id', p_claim_id, 'new_status', p_new_status,
    'paid_amount_cents', p_paid_amount_cents, 'manufacturer_ref', p_manufacturer_ref));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'transition_rebate_claim', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._transition_rebate_claim_replay_impl_20261015(
    p_claim_id, p_new_status, p_paid_amount_cents, p_manufacturer_ref, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'transition_rebate_claim', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.transition_rebate_claim(uuid, text, bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_rebate_claim(uuid, text, bigint, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------------------------
DO $postflight$
DECLARE
  v_bad text;
  v_expected_def text;
  v_group_src text;
BEGIN
  IF to_regclass('pg_temp.money_replay_binding_batch4a_tx') IS NULL THEN
    RAISE EXCEPTION 'MONEY_REPLAY_BINDING_BATCH4A_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.money_replay_binding_batch4a_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'MONEY_REPLAY_BINDING_BATCH4A_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_bad
    FROM pg_temp.money_replay_binding_batch4a_pins pin
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
     -- Exactly one renamed body: the reviewed live body (unpost_invoice_group's differs only by its
     -- retargeted call, undone here before the md5), callable only by postgres.
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = '_' || pin.name || '_replay_impl_20261015') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = '_' || pin.name || '_replay_impl_20261015'
          AND pg_get_function_arguments(p.oid) = pin.args
          AND p.prorettype = pin.ret::regtype
          AND p.proowner = 'postgres'::regrole AND p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND md5(replace(replace(p.prosrc, chr(13), ''),
                          'PERFORM _unpost_invoice_replay_impl_20261015(v_inv.id', 'PERFORM unpost_invoice(v_inv.id')) = pin.body_md5
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['postgres']::text[]);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_MONEY_REPLAY_BATCH4A_CONTRACT: wrapper or renamed body drifted for: %', v_bad;
  END IF;

  -- The group body's one change is the retargeted call: it calls the renamed unpost_invoice body
  -- and never the public wrapper (which would refuse the keyless call).
  SELECT replace(p.prosrc, chr(13), '') INTO v_group_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_unpost_invoice_group_replay_impl_20261015';
  IF v_group_src IS NULL
     OR strpos(v_group_src, 'PERFORM _unpost_invoice_replay_impl_20261015(v_inv.id, p_performed_by, NULL);') = 0
     OR v_group_src ~ '(^|[^_a-z0-9])unpost_invoice\s*\(' THEN
    RAISE EXCEPTION 'POSTFLIGHT_UNPOST_GROUP_CONTRACT: _unpost_invoice_group_replay_impl_20261015 must call the renamed unpost_invoice body';
  END IF;

  -- The commit-time guard: the one trigger running the guard function, exactly as recorded above
  -- (every previously covered operation, then these eleven), deferred AFTER INSERT OR UPDATE per row.
  IF (SELECT count(*) FROM pg_temp.money_replay_binding_batch4a_guard_ops) <> 38
     OR (SELECT count(*) FROM pg_temp.money_replay_binding_batch4a_guard_ops
          WHERE operation IN (SELECT pin.name FROM pg_temp.money_replay_binding_batch4a_pins pin)) <> 11 THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECEIPT_GUARD_CONTRACT: the recorded guard operation list is not a reviewed state';
  END IF;
  v_expected_def := 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
    || (SELECT string_agg(quote_literal(g.operation) || '::text', ', ' ORDER BY g.ord) FROM pg_temp.money_replay_binding_batch4a_guard_ops g)
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

  RAISE NOTICE 'POSTFLIGHT_OK: the eleven batch 4a money functions now replay a stored result only for the same person and the exact same request';
END
$postflight$;
