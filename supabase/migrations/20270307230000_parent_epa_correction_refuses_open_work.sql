-- Written 2026-11-25. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270307230000_parent_epa_correction_refuses_open_work.md. Re-read the live ledger before applying.
--
-- #2579 (Mason, 2026-11-25: "go ahead with 2579"): refuse a parent EPA-number correction while any size of the parent
-- has work in progress, and name that work. Contract: docs/plans/2026-11-25-par1-epa-refuse-open-work-CONTRACT.md.
--
-- WHY: after a correction, an in-progress record picked up the new number when it was finished (Sol rounds 11-16 on
--   #2381): completing a sprayed job, a late first spray entry, an application record from a blend ticket, posting an
--   untouched draft, an open field-invoice form, Split Billing / Create Invoice, a split invoice re-saved while
--   unposted. One refusal at the correction closes them at the source.
--
-- WHAT (no rows written): _product_parent_identity_after re-emitted from the 20270307180000 body with one added check,
--   only when the EPA number changes, PRODUCT_PARENT_EPA_OPEN_WORK, while any size of the parent has:
--     a job (not deleted) scheduled or in progress, or completed with no invoice (the Unbilled Applications list);
--     a blend ticket (not deleted, not rejected) still unbilled or with no application record yet (one can be made
--       from an approved ticket at any time, billed or not: 20260713060200);
--     an invoice (not deleted) in draft or unposted.
--   It lists up to 10 by number and state, then "and N more". It runs last in the EPA branch, so the existing,
--   more specific refusals (e.g. PRODUCT_PARENT_EPA_RUP_DRAFT, whose remedy is "do not post it") still win. preview_product_parent_identity_correction and
--   correct_product_parent_identity both call this function, so the Preview button and the save refuse alike.
--
-- NOT CHANGED: every other function, table, row, grant and policy; formulation and safener corrections.
--
-- LOCKS: none added. The save locks the parent and every size FOR UPDATE first (_lock_product_parent), which conflicts
--   with the FOR KEY SHARE that adding a job, blend-ticket or invoice line for a size takes (its foreign key): such
--   a line waits for the correction, or the correction waits for it and then sees it (READ COMMITTED, each statement
--   a new snapshot). A status change on existing work (reopening, unposting) takes no product lock and can overlap;
--   that work then behaves as before this file (the accepted race, Luna 2026-11-07). Preview takes no lock.
--
-- ROLLBACK (its own reviewed migration): switch the correction off (_product_parent_epa_correction_enabled() SELECT
--   false, as 20270307180000 says). Never re-emit the 20270307180000 helper while the switch is on.
--
-- ORDERING: right after 20270307180000, in the same release, so the switch is never on in production without this.

CREATE TEMP TABLE parent_epa_open_work_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Two statements: outside a transaction the table is already dropped, and the second would fail to plan.
  IF to_regclass('pg_temp.parent_epa_open_work_tx') IS NULL THEN
    RAISE EXCEPTION 'PARENT_EPA_OPEN_WORK_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.parent_epa_open_work_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PARENT_EPA_OPEN_WORK_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  -- The identity check this file re-emits is exactly 20270307180000's, with its attributes (a second apply stops here).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public._product_parent_identity_after(public.product_parents,jsonb)')
                    AND md5(replace(p.prosrc, chr(13), '')) = 'b97145311af25c6ac873f78aa44bf2ac'
                    AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef AND p.provolatile = 'v'
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'PARENT_EPA_OPEN_WORK_PREFLIGHT: _product_parent_identity_after is not the 20270307180000 body; apply that file first';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public._product_parent_identity_after(p_parent public.product_parents, p_changes jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $function$
DECLARE
  v_epa text := p_parent.generic_epa_registration;
  v_unsaved text;
BEGIN
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN ('formulation_type', 'safener', 'generic_epa_registration'))
     OR EXISTS (SELECT 1 FROM jsonb_each(p_changes) e WHERE jsonb_typeof(e.value) NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: the identity correction takes formulation_type, safener and generic_epa_registration';
  END IF;
  IF p_changes ? 'generic_epa_registration'
     AND public._normalize_epa_registration(p_changes->>'generic_epa_registration') IS DISTINCT FROM p_parent.generic_epa_registration THEN
    IF NOT public._product_parent_epa_correction_enabled() THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_EPA_CORRECTION_OFF: EPA number correction is switched off until the screens that keep old records'' EPA numbers are live';
    END IF;
    v_epa := public._normalize_epa_registration(p_changes->>'generic_epa_registration');
    -- PAR-1 7.7 (Mason, 2026-11-23, Sol r1 #1): a number is corrected, never cleared; a cleared number would also
    -- stop restricted-use sales of a size flagged only through it from being recorded.
    IF v_epa IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: an EPA number cannot be cleared; type the correct number';
    END IF;
    -- The same rule every product's EPA number follows (guard_product_setup_fields).
    IF v_epa IS NOT NULL AND v_epa !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: "%" is not an EPA number (for example 524-475 or 100-1070-12345)', v_epa;
    END IF;
    SELECT string_agg(DISTINCT COALESCE(i.invoice_number, i.id::text) || ' (' || i.status || ')', ', ')
      INTO v_unsaved
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
      JOIN public.product_parent_members m ON m.product_id = ii.product_id
      JOIN public.products p ON p.id = ii.product_id
     WHERE m.parent_id = p_parent.id AND i.deleted_at IS NULL AND public._epa_norm(ii.epa_registration) IS NULL
       AND public._epa_norm(p.epa_registration) IS NOT NULL
       AND public._epa_norm(p.epa_registration) IS DISTINCT FROM v_epa;
    IF v_unsaved IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_EPA_RECORD_UNSAVED: invoice % has a line for this product with no saved EPA number, so it would change too. Open and save a draft invoice to give it one; a posted one must be unposted, saved and posted again (a paid or void invoice cannot be, so ask a developer to save that line''s number)', v_unsaved;
    END IF;
    -- Sol r2 #1: a size that is restricted-use only through its current number's registration would lose that status
    -- (future invoice lines would capture 'unknown', and no restricted-use sales record is made for those).
    -- The shared registration lock first, as the invoice capture takes it, so a registration edit cannot interleave.
    PERFORM public._epa_registration_lock(false);
    SELECT string_agg(DISTINCT p.product_name, ', ')
      INTO v_unsaved
      FROM public.product_parent_members m
      JOIN public.products p ON p.id = m.product_id
      JOIN public.epa_registrations r
        ON r.epa_registration = public._normalize_epa_registration(p.epa_registration) AND r.rup_status = 'yes'
     WHERE m.parent_id = p_parent.id AND NOT COALESCE(p.is_rup, false)
       AND NOT EXISTS (SELECT 1 FROM public.epa_registrations r2 WHERE r2.epa_registration = v_epa AND r2.rup_status = 'yes');
    IF v_unsaved IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_EPA_RUP_LOST: % is restricted-use only through its current EPA number. Mark it restricted-use first, then correct the number', v_unsaved;
    END IF;
    -- Taha review of 78c34a1f3: the gain direction. A draft or unposted line keeps its saved number and capture, so a
    -- correction to a restricted-use number would let it post a restricted-use sale with no restricted-use record.
    SELECT string_agg(DISTINCT COALESCE(i.invoice_number, i.id::text) || ' (' || i.status || ')', ', ')
      INTO v_unsaved
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
      JOIN public.product_parent_members m ON m.product_id = ii.product_id
      JOIN public.products p ON p.id = ii.product_id
     WHERE m.parent_id = p_parent.id AND i.deleted_at IS NULL AND i.status IN ('draft', 'unposted')
       AND NOT COALESCE(p.is_rup, false)
       AND EXISTS (SELECT 1 FROM public.epa_registrations r WHERE r.epa_registration = v_epa AND r.rup_status = 'yes')
       AND NOT EXISTS (SELECT 1 FROM public.epa_registrations r
                        WHERE r.epa_registration = public._normalize_epa_registration(ii.epa_registration) AND r.rup_status = 'yes');
    IF v_unsaved IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_EPA_RUP_DRAFT: invoice % has a line for this product saved under a number that is not restricted-use, so posting it, before or after this correction, would make no restricted-use record. Do not post it: delete that draft or remove that line, correct the number, then add the line again', v_unsaved;
    END IF;
    -- #2579 (Mason, 2026-11-25): no correction while a size has work in progress, which would pick up the new number
    -- when finished. Every size counts: the correction writes them all. Last, so the more specific refusals above
    -- (and their remedies, e.g. RUP_DRAFT's "do not post it") win.
    -- One entry per record (its id is carried so two records sharing a number both count).
    WITH sizes AS (SELECT m.product_id FROM public.product_parent_members m WHERE m.parent_id = p_parent.id),
    work AS (
      SELECT DISTINCT 1 AS kind, j.id, 'job ' || COALESCE(j.job_number::text, j.id::text) || ' ('
               || CASE WHEN j.status = 'completed' THEN 'completed, not invoiced' ELSE replace(j.status, '_', ' ') END || ')' AS label
        FROM public.jobs j JOIN public.job_chemicals jc ON jc.job_id = j.id JOIN sizes s ON s.product_id = jc.product_id
       WHERE j.deleted_at IS NULL
         AND (j.status IN ('scheduled', 'in_progress') OR (j.status = 'completed'
              AND NOT EXISTS (SELECT 1 FROM public.invoices ji WHERE ji.id = j.invoice_id AND ji.deleted_at IS NULL
                                AND ji.status NOT IN ('voided', 'cancelled'))
              -- Billed through its blend ticket instead (Sol r1): job invoicing then refuses (BLEND_TICKET_ALREADY_BILLED).
              AND NOT EXISTS (SELECT 1 FROM public.blend_tickets jb JOIN public.invoices jbi ON jbi.blend_ticket_id = jb.id
                               WHERE jb.job_id = j.id AND jbi.deleted_at IS NULL AND jbi.status NOT IN ('voided', 'cancelled'))))
      UNION
      SELECT 2, b.id, 'blend ticket ' || COALESCE(b.ticket_number::text, b.id::text) || ' ('
               || CASE WHEN b.payment_status = 'unbilled' THEN 'unbilled' ELSE 'no application record' END || ')'
        FROM public.blend_tickets b JOIN public.blend_ticket_products bp ON bp.blend_ticket_id = b.id
        JOIN sizes s ON s.product_id = bp.product_id
       WHERE b.deleted_at IS NULL AND b.review_status IS DISTINCT FROM 'rejected'
         -- A ticket for a live job is that job's work and is counted through it; its own application record would
         -- deduct the job's stock a second time (Sol r1).
         AND NOT EXISTS (SELECT 1 FROM public.jobs bj WHERE bj.id = b.job_id AND bj.deleted_at IS NULL AND bj.status <> 'cancelled')
         AND (b.payment_status = 'unbilled'
              OR NOT EXISTS (SELECT 1 FROM public.application_records ar WHERE ar.source_type = 'blend_ticket' AND ar.source_id = b.id))
      UNION
      SELECT 3, i.id, 'invoice ' || COALESCE(i.invoice_number, i.id::text) || ' (' || i.status || ')'
        FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice_id = i.id JOIN sizes s ON s.product_id = ii.product_id
       WHERE i.deleted_at IS NULL AND i.status IN ('draft', 'unposted')),
    numbered AS (SELECT label, row_number() OVER (ORDER BY kind, label, id) AS n, count(*) OVER () AS total FROM work)
    SELECT string_agg(label, ', ' ORDER BY n) FILTER (WHERE n <= 10)
           || CASE WHEN max(total) > 10 THEN ' and ' || (max(total) - 10) || ' more' ELSE '' END
      INTO v_unsaved FROM numbered;
    IF v_unsaved IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_EPA_OPEN_WORK: finish this work first so it keeps the number it was done under, then correct the number (a job: once sprayed, complete it and invoice it or its blend ticket; if it will not be sprayed, cancel it or take this product off it; a blend ticket not tied to a job: reject it, or approve it, make its application record and bill it; an invoice: post or delete it): %', v_unsaved;
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'formulation_type', CASE WHEN p_changes ? 'formulation_type' THEN NULLIF(btrim(p_changes->>'formulation_type'), '') ELSE p_parent.formulation_type END,
    'safener', CASE WHEN p_changes ? 'safener' THEN NULLIF(btrim(p_changes->>'safener'), '') ELSE p_parent.safener END,
    'generic_epa_registration', v_epa);
END;
$function$;

DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public._product_parent_identity_after(public.product_parents,jsonb)'::regprocedure
                    AND md5(replace(p.prosrc, chr(13), '')) = '61d76303832274b0664a127835d78595'
                    AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef AND p.provolatile = 'v'
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]) THEN
    RAISE EXCEPTION 'PARENT_EPA_OPEN_WORK_POSTFLIGHT: the identity check is not the open-work body, or its grants changed';
  END IF;
END
$postflight$;
