-- ============================================================================
-- 20261021030000_void_order_governed_split_draft_claims
--
-- WHAT: void_order can void a fulfilled order whose draft invoices are GOVERNED split drafts (made
-- by create_split_invoices_from_order, each with a split_invoice_provenance row).
--
-- WHY: replay-binding batch 3b (20261019235000, PR #967) made void_order's inner body cancel a draft
-- invoice the way cancel_order does: status 'cancelled' with total, paid, prepay and write-off cents
-- zeroed. For a governed split draft, guard_split_invoice_provenance_identity refuses any change to
-- its total unless a same-transaction split_invoice_mutation_claims row names that invoice, so the
-- void rolled back with SPLIT_INVOICE_PROVENANCE_IMMUTABLE (Codex GitHub review on #967; recorded in
-- docs/manual/KNOWN_ISSUES.md). cancel_order already solves this in
-- _cancel_order_provenance_wrapper_20260719: lock the order, lock the governed invoices, write the
-- claims, run the body, refresh the provenance rows, verify the refresh, drop the claims and verify
-- the count. Live impact when written: none (live had 0 split_invoice_provenance rows, 2026-10-20);
-- it must land before split billing is used.
--
-- WHAT CHANGES: only the public void_order wrapper (CREATE OR REPLACE, same signature, same owner,
-- attributes and grants). Its batch-3b contract is unchanged and runs first: key required, actor and
-- role checks, fingerprint {actor_id, order_id, reason}, check_idempotency_intent, receipt binding
-- after the body. On a fresh (non-replay) call it now also:
--   1. locks the order, then every non-deleted governed DRAFT invoice of the order (FOR UPDATE, by id),
--      which is exactly the set the inner body's draft branch will cancel;
--   2. writes one 'cancel_order' claim per such invoice for this transaction;
--   3. runs the renamed body (_void_order_replay_impl_20261015, unchanged);
--   4. refreshes each claimed invoice's provenance (total_amount_cents and content_claim through
--      _split_invoice_content_claim) and refuses unless every claimed invoice is now 'cancelled' with
--      a provenance row that matches it exactly (SPLIT_INVOICE_VOID_ORDER_PROVENANCE_REFRESH_FAILED);
--   5. deletes its claims and refuses unless it deleted exactly as many as it wrote
--      (SPLIT_INVOICE_VOID_ORDER_CLAIM_LOST).
-- An exact replay (a stored receipt for the same person and request) skips all of this: the body
-- returns the stored result and writes nothing, as before.
--
-- WHY REUSE 'cancel_order' AS THE CLAIM OPERATION (no CHECK or guard change). The guard accepts a
-- 'cancel_order' claim only through its exact-cancel shape: OLD.status draft/unposted, NEW.status
-- 'cancelled', total, paid, prepay and write-off cents all zero, and invoice number, salesperson,
-- invoice date, header notes and pricing_pending unchanged. That is exactly the one invoice write
-- void_order's inner body makes (status, void_reason, the four zeroed money fields, updated_at), and
-- its WHERE already requires paid, prepay, write-off and credit cents to be zero. A new 'void_order'
-- operation would need the claims CHECK and the shared guard (used by save_invoice, delete_invoices,
-- void_invoice and cancel_order) rewritten to grant exactly the same shape, for no added protection.
-- The claim rows live only inside this transaction (deleted before it returns), so the label is never
-- stored. Claims are written only for governed DRAFTS, never for posted ones the body only flags.
--
-- PROOF: scripts/smoke/prove-void-order-governed-split-drafts-real-schema.mjs (Docker, real schema):
-- the new chain fails first (SPLIT_INVOICE_PROVENANCE_IMMUTABLE), passes after; the batch-3b chain
-- still passes; each of the claim write, the provenance refresh and the claim delete, taken out, makes
-- the chain fail at the step that proves it.
--
-- ROLLBACK: CREATE OR REPLACE public.void_order with its batch-3b body (section 3 of
-- 20261019235000_bind_delivery_order_void_replay_receipts_batch3b.sql, md5
-- 5329fcd3cbab202136587a93d51f339d); grants are unchanged. That only restores the failure above.
--
-- ORDERING: needs 20261019235000 applied (live ledger 20261021024020). Re-read the live ledger and
-- the pinned bodies before applying.
--
-- idempotency-body-check: exempt. void_order keeps batch 3b's check_idempotency_intent with its own
-- operation literal and _bind_replay_receipt_20261015; the renamed bodies are unchanged.
--
-- Grants: unchanged and not restated. CREATE OR REPLACE keeps the live ACL (EXECUTE to authenticated,
-- service_role and postgres), which the preflight pins and the postflight re-checks.
-- caller-analysis: void_order :: src/pages/OrderDetail.tsx calls the same name and signature with a key; no database function calls it; same grants
-- ============================================================================

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE void_order_split_claims_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_drift text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.void_order_split_claims_tx') IS NULL THEN
    RAISE EXCEPTION 'VOID_ORDER_SPLIT_CLAIMS_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.void_order_split_claims_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'VOID_ORDER_SPLIT_CLAIMS_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- Batch 3b is applied.
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
                  WHERE name = '20261019235000_bind_delivery_order_void_replay_receipts_batch3b') THEN
    RAISE EXCEPTION 'PREFLIGHT_BATCH3B_NOT_APPLIED: 20261019235000 must be applied first';
  END IF;

  -- The bodies this change relies on, exactly as reviewed live on 2026-10-21 (md5 ignores carriage
  -- returns), each the only overload of its name, postgres-owned security definers with the live
  -- search_path and EXECUTE grants.
  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_drift
    FROM (VALUES
      ('void_order', 'p_order_id uuid, p_performed_by uuid, p_reason text DEFAULT ''Voided by admin''::text, p_idempotency_key text DEFAULT NULL::text', '5329fcd3cbab202136587a93d51f339d', ARRAY['authenticated', 'postgres', 'service_role']::text[]),
      ('_void_order_replay_impl_20261015', 'p_order_id uuid, p_performed_by uuid, p_reason text DEFAULT ''Voided by admin''::text, p_idempotency_key text DEFAULT NULL::text', 'bb220157f3cd56d28e9efe88dafba896', ARRAY['postgres']::text[]),
      ('_void_order_impl_20260714', 'p_order_id uuid, p_performed_by uuid, p_reason text DEFAULT ''Voided by admin''::text, p_idempotency_key text DEFAULT NULL::text', 'a2dd87f5ebfffe7a7a328acce66ee528', ARRAY['postgres']::text[]),
      ('guard_split_invoice_provenance_identity', '', '639875d6641556c78c25d633c67821f1', NULL::text[]),
      ('_split_invoice_content_claim', 'p_invoice_id uuid', 'b9fb02bee41aa5c57702edc231d03644', ARRAY['postgres']::text[])
    ) AS pin(name, args, body_md5, acl)
   WHERE (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = pin.name) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = pin.name
           AND p.proowner = 'postgres'::regrole AND p.prosecdef
           AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
           AND pg_get_function_arguments(p.oid) = pin.args
           AND md5(replace(p.prosrc, chr(13), '')) = pin.body_md5
           AND (pin.acl IS NULL OR
                ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                        FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
                IS NOT DISTINCT FROM pin.acl));
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_VOID_ORDER_SPLIT_BODY_DRIFT: these differ from their reviewed live definitions: %', v_drift;
  END IF;

  -- The provenance guard runs on every invoice UPDATE and DELETE.
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.invoices'::regclass
         AND t.tgfoid = 'public.guard_split_invoice_provenance_identity()'::regprocedure
         AND t.tgenabled = 'O'
         AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER guard_split_invoice_provenance_identity BEFORE DELETE OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_split_invoice_provenance_identity()') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_SPLIT_GUARD_DRIFT: guard_split_invoice_provenance_identity is not installed as reviewed';
  END IF;

  -- The claims table still accepts exactly the four reviewed operations, 'cancel_order' among them.
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.split_invoice_mutation_claims'::regclass
         AND c.conname = 'split_invoice_mutation_claims_operation_check')
     IS DISTINCT FROM 'CHECK ((operation = ANY (ARRAY[''save_invoice''::text, ''delete_invoices''::text, ''void_invoice''::text, ''cancel_order''::text])))' THEN
    RAISE EXCEPTION 'PREFLIGHT_SPLIT_CLAIMS_DRIFT: split_invoice_mutation_claims_operation_check is not the reviewed list';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.void_order(
  p_order_id uuid,
  p_performed_by uuid,
  p_reason text DEFAULT 'Voided by admin'::text,
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
  v_governed_ids uuid[] := '{}'::uuid[];
  v_claim_count integer := 0;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: void_order requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- Same tests and messages as the renamed body (which also checks them before its replay).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'order_id', p_order_id,
    'reason', p_reason
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'void_order', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;

  -- Governed split drafts (split_invoice_provenance rows) may be cancelled only under a
  -- same-transaction claim, as cancel_order does. Lock the order, then the governed drafts the
  -- body's draft branch will cancel, and claim them. 'cancel_order' is the guard's exact-cancel
  -- shape (draft -> cancelled, money zeroed, content unchanged), which is the one write the body
  -- makes. An exact replay writes nothing, so it claims nothing.
  IF v_replay IS NULL THEN
    PERFORM 1 FROM public.orders o WHERE o.id = p_order_id FOR UPDATE;

    SELECT COALESCE(array_agg(locked.invoice_id ORDER BY locked.invoice_id), '{}'::uuid[])
      INTO v_governed_ids
      FROM (
        SELECT i.id AS invoice_id
          FROM public.invoices i
          JOIN public.split_invoice_provenance p ON p.invoice_id = i.id
         WHERE i.order_id = p_order_id
           AND i.deleted_at IS NULL
           AND i.status = 'draft'
         ORDER BY i.id
         FOR UPDATE OF i
      ) locked;

    INSERT INTO public.split_invoice_mutation_claims (transaction_id, invoice_id, operation)
    SELECT pg_current_xact_id(), governed.invoice_id, 'cancel_order'
      FROM unnest(v_governed_ids) AS governed(invoice_id);
  END IF;

  v_result := public._void_order_replay_impl_20261015(p_order_id, p_performed_by, p_reason, p_idempotency_key);

  IF v_replay IS NULL THEN
    -- Refresh each claimed invoice's provenance to the cancelled invoice, then prove every claimed
    -- invoice was cancelled and matches its provenance exactly.
    UPDATE public.split_invoice_provenance p
       SET total_amount_cents = i.total_amount_cents,
           content_claim = public._split_invoice_content_claim(i.id)
      FROM public.invoices i
     WHERE p.invoice_id = i.id
       AND p.invoice_id = ANY(v_governed_ids)
       AND p.order_id = i.order_id
       AND p.invoice_group_id = i.invoice_group_id
       AND p.customer_id = i.customer_id
       AND p.invoice_type = i.invoice_type
       AND p.season = i.season
       AND i.status = 'cancelled';

    IF EXISTS (
      SELECT 1
        FROM unnest(v_governed_ids) AS governed(invoice_id)
        LEFT JOIN public.invoices i ON i.id = governed.invoice_id
        LEFT JOIN public.split_invoice_provenance p ON p.invoice_id = governed.invoice_id
       WHERE i.status IS DISTINCT FROM 'cancelled'
          OR p.total_amount_cents IS DISTINCT FROM i.total_amount_cents
          OR p.content_claim IS DISTINCT FROM public._split_invoice_content_claim(i.id)
    ) THEN
      RAISE EXCEPTION 'SPLIT_INVOICE_VOID_ORDER_PROVENANCE_REFRESH_FAILED';
    END IF;

    DELETE FROM public.split_invoice_mutation_claims claim
     WHERE claim.transaction_id = pg_current_xact_id()
       AND claim.operation = 'cancel_order'
       AND claim.invoice_id = ANY(v_governed_ids);
    GET DIAGNOSTICS v_claim_count = ROW_COUNT;
    IF v_claim_count IS DISTINCT FROM cardinality(v_governed_ids) THEN
      RAISE EXCEPTION 'SPLIT_INVOICE_VOID_ORDER_CLAIM_LOST';
    END IF;

    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'void_order', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

DO $postflight$
BEGIN
  -- void_order is the reviewed new body, still the only overload, with the same owner, attributes
  -- and grants.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'void_order') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'void_order'
          AND p.proowner = 'postgres'::regrole AND p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND md5(replace(p.prosrc, chr(13), '')) = '960b73061ab7bcd169f54b68b6bde626'
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]) THEN
    RAISE EXCEPTION 'POSTFLIGHT_VOID_ORDER_CONTRACT: void_order is not the reviewed body with its live grants';
  END IF;

  -- Nothing else changed.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('_void_order_replay_impl_20261015', 'bb220157f3cd56d28e9efe88dafba896'),
        ('_void_order_impl_20260714', 'a2dd87f5ebfffe7a7a328acce66ee528'),
        ('guard_split_invoice_provenance_identity', '639875d6641556c78c25d633c67821f1'),
        ('_split_invoice_content_claim', 'b9fb02bee41aa5c57702edc231d03644')
      ) AS pin(name, body_md5)
     WHERE (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = pin.name) IS DISTINCT FROM pin.body_md5
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_PINNED_BODIES_CHANGED: a pinned body changed during this migration';
  END IF;

  RAISE NOTICE 'POSTFLIGHT_OK: void_order claims, cancels and re-records governed split drafts';
END
$postflight$;
