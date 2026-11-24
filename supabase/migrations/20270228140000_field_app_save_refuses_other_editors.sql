-- Written 2026-11-23. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270228140000_field_app_save_refuses_other_editors.md.
--
-- WHY (release #2388 Sol HIGH 3): save_field_app_invoice rebuilds an invoice from the fields it is sent and the payers
--   Field Setup lists for them: it deletes every group member's lines, cancels each member whose farm is not in that
--   list and creates a draft for any new farm (20270205100000 lines 151-307). A job's invoices are made from the payers
--   saved on the job (20270226150000), a blend ticket's from its ticket, and a Split Billing set's from its own lines.
--   Saving one of those here (a job billed Farms A and B, Field Setup now lists Farm C at 100%) cancels A's and B's
--   invoices and bills C. The screen already sends these invoices elsewhere (src/pages/FieldApplicationInvoice.tsx
--   loadInvoice); the server did not refuse them.
--
-- WHAT: for a NEW write to an existing invoice (a replay of an earlier successful save still returns its receipt), the
--   public wrapper takes the same locks as the save's lock layer (group advisory lock, then the member rows), then
--   refuses with FIELD_APP_WRONG_EDITOR, before any write, when the invoice or a live member of its group belongs to a
--   Split Billing set, or the invoice (standalone) / group carries none of this editor's field rows
--   (field_app_locations). Every invoice this editor saves carries them; a field-app invoice later linked to a job
--   keeps them and saves as before. Contract: docs/plans/2026-11-23-field-app-save-refuses-other-editors-CONTRACT.md.
--   Because the check trusts field rows, signed-in users lose direct INSERT/UPDATE/DELETE/TRUNCATE on
--   field_app_locations and field_app_location_shares (SELECT is untouched; live, the only writers are the two
--   SECURITY DEFINER save functions, which keep their owner rights; service_role is unchanged), as 20260721014858 did
--   for invoices. Live 2026-11-23: authenticated held all three; no column-level grants exist.
--   Live 2026-11-23 (read-only): 3 field-application invoices; 0 Split Billing members, 0 job-made groups, 0 past
--   orphan cancellations; 1 editable job-made single invoice (no field rows; the screen opens it in the invoice editor).
--
-- NOT CHANGED: the rest of the wrapper body, its owner, SECURITY DEFINER, search_path and grants (CREATE OR REPLACE
--   keeps them), every function it calls, every row and policy, and every other table grant.
--
-- ROLLBACK (its own reviewed migration): re-emit the wrapper body pinned by the preflight below (the
--   20261102180000_bind_money_replay_receipts_batch4a.sql wrapper) and re-grant the revoked table writes to
--   authenticated. It reopens the gap.
--
-- ORDERING: after 20261102180000. Not re-runnable (preflight refuses). Postflight pins the new body.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.save_field_app_invoice(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)'))
     IS DISTINCT FROM '6f73d91a1ba621ec6db56a3cb606d948' THEN
    RAISE EXCEPTION 'FIELD_APP_WRONG_EDITOR_PREFLIGHT: save_field_app_invoice is not the reviewed body (missing, drifted or already replaced)';
  END IF;
  -- The check below trusts field rows, and until the revoke below anyone signed in could write them. An editable
  -- job- or blend-made invoice carrying field rows would pass it (live 2026-11-23: none); stop for review instead.
  IF EXISTS (SELECT 1 FROM public.invoices i
              WHERE i.deleted_at IS NULL AND i.status IN ('draft', 'unposted')
                AND (i.job_id IS NOT NULL OR i.blend_ticket_id IS NOT NULL)
                AND EXISTS (SELECT 1 FROM public.field_app_locations l
                             WHERE l.invoice_id = i.id
                                OR (i.invoice_group_id IS NOT NULL AND l.invoice_group_id = i.invoice_group_id))) THEN
    RAISE EXCEPTION 'FIELD_APP_WRONG_EDITOR_PREFLIGHT: an editable job- or blend-ticket invoice carries field rows; review them before applying';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.save_field_app_invoice(
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
  v_group uuid;
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
  -- Release #2388 Sol HIGH 3: a new save rebuilds only invoices this editor built (they carry its field rows); a job's,
  -- blend ticket's or Split Billing set's would have its payers cancelled and re-billed from Field Setup. Locks as the
  -- save's lock layer does (same order), so the group checked is the group rebuilt.
  IF v_replay IS NULL AND p_invoice_id IS NOT NULL THEN
    SELECT invoice_group_id INTO v_group FROM public.invoices WHERE id = p_invoice_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
    END IF;
    IF v_group IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(v_group::text, 0));
      PERFORM 1 FROM public.invoices WHERE invoice_group_id = v_group AND deleted_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE;
      PERFORM 1 FROM public.invoices WHERE invoice_group_id = v_group AND deleted_at IS NULL ORDER BY id FOR UPDATE;
    ELSE
      PERFORM 1 FROM public.invoices WHERE id = p_invoice_id AND deleted_at IS NULL FOR UPDATE;
    END IF;
    -- Re-read under the locks, as the lock layer does: the target still exists and is still in the group checked.
    IF NOT EXISTS (SELECT 1 FROM public.invoices WHERE id = p_invoice_id AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
    END IF;
    IF (SELECT invoice_group_id FROM public.invoices WHERE id = p_invoice_id) IS DISTINCT FROM v_group THEN
      RAISE EXCEPTION 'Invoice group changed while saving; reload and try again';
    END IF;
    IF EXISTS (SELECT 1 FROM public.invoices
                WHERE (id = p_invoice_id OR (v_group IS NOT NULL AND invoice_group_id = v_group AND deleted_at IS NULL))
                  AND field_app_billing_set_id IS NOT NULL) THEN
      RAISE EXCEPTION 'FIELD_APP_WRONG_EDITOR: Nothing was saved. This invoice was made by Split Billing, so it cannot be changed on the field application invoice screen.'
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.field_app_locations l
                    WHERE (v_group IS NULL AND l.invoice_id = p_invoice_id)
                       OR (v_group IS NOT NULL AND l.invoice_group_id = v_group)) THEN
      RAISE EXCEPTION 'FIELD_APP_WRONG_EDITOR: Nothing was saved. This invoice has no fields from the field application invoice screen (it was made from a job or a blend ticket, or it is no longer active), so its farms and lines cannot be rebuilt here.'
        USING ERRCODE = 'P0001';
    END IF;
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

-- The check above trusts field rows: only the save functions (owner rights) may write them.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.field_app_locations, public.field_app_location_shares
  FROM PUBLIC, anon, authenticated;

DO $postflight$
DECLARE
  v_role text;
  v_table text;
  v_priv text;
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.save_field_app_invoice(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)'))
     IS DISTINCT FROM 'a583c46ce9b52ee9bb8968ae15566fac' THEN
    RAISE EXCEPTION 'FIELD_APP_WRONG_EDITOR_POSTFLIGHT: save_field_app_invoice is not the reviewed new body';
  END IF;
  IF has_function_privilege('anon', 'public.save_field_app_invoice(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.save_field_app_invoice(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FIELD_APP_WRONG_EDITOR_POSTFLIGHT: save_field_app_invoice EXECUTE is not authenticated-only';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['public.field_app_locations', 'public.field_app_location_shares'] LOOP
    IF NOT has_table_privilege('authenticated', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'FIELD_APP_WRONG_EDITOR_POSTFLIGHT: authenticated lost SELECT on %', v_table;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(v_role, v_table, v_priv) THEN
          RAISE EXCEPTION 'FIELD_APP_WRONG_EDITOR_POSTFLIGHT: % can still % %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_table::regclass AND a.attnum > 0 AND a.attacl IS NOT NULL) THEN
      RAISE EXCEPTION 'FIELD_APP_WRONG_EDITOR_POSTFLIGHT: % has column-level grants', v_table;
    END IF;
  END LOOP;
END;
$postflight$;
