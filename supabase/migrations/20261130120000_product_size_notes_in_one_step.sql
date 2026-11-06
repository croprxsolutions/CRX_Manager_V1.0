-- Written 2026-11-06. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261127110000_product_size_notes_in_one_step.md. Re-read the live ledger before applying.
--
-- WHY (PR #1553 Sol round 2; Mason, 2026-11-06: "Yes, add it there"; split out of the parent EPA
--   correction work, Mason, 2026-11-06: "Yes, split it"): "New product" and "Add a size" saved a
--   size's quoting and internal notes in a second call after the product was made, so a product could
--   be live without its notes when that second call failed.
--
-- WHAT: _insert_parent_size (the one size writer behind create_product_with_parent and
--   add_product_size) also takes quoting_notes and internal_notes from p_size and writes them in the
--   same transaction as the product. Each is text or null, at most 5000 characters, stored trimmed;
--   blank is none (the same as the product setup update stores them). Re-emitted from its live body
--   (pinned below) with that one change. Same signatures; a call without the notes is unchanged.
--
-- NOT CHANGED: grants, the two public functions, their retry keys (their fingerprint already covers
--   p_size whole, so a retry with different notes is refused), and every other product field.
--
-- ROLLBACK (its own reviewed migration): re-emit _insert_parent_size from 20261110150000.
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  -- The function re-emitted here must still be the body this file was written from.
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.oid = 'public._insert_parent_size(public.product_parents,jsonb,text)'::regprocedure
         AND md5(replace(p.prosrc, chr(13), '')) = 'becb1e0659f77f00a8cd511dcc9da264'
         AND p.proowner = 'postgres'::regrole) <> 1 THEN
    RAISE EXCEPTION 'PRODUCT_SIZE_NOTES_PREFLIGHT: _insert_parent_size drifted from the body this file was written from';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public._insert_parent_size(p_parent public.product_parents, p_size jsonb, p_key text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_fields jsonb;
  v_saved jsonb;
  v_product uuid;
  v_refusal text;
BEGIN
  IF p_size IS NULL OR jsonb_typeof(p_size) <> 'object' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_SIZE_REQUIRED: send the new size''s fields';
  END IF;
  IF p_size ?| ARRAY['category', 'use_timing', 'use_timings', 'rate_per_acre', 'rate_unit', 'suggested_rate', 'rates'] THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_SIZE_COPIED_VALUE: category, use timing and rates come from the parent; leave them off the size';
  END IF;
  IF jsonb_typeof(p_size->'quoting_notes') NOT IN ('string', 'null') OR jsonb_typeof(p_size->'internal_notes') NOT IN ('string', 'null')
     OR length(p_size->>'quoting_notes') > 5000 OR length(p_size->>'internal_notes') > 5000 THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: quoting_notes and internal_notes are text of at most 5000 characters';
  END IF;
  IF p_size ? 'product_form' AND (p_size->>'product_form') IS DISTINCT FROM p_parent.product_form THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_FORM_MISMATCH: every size of "%" is %', p_parent.name, p_parent.product_form;
  END IF;
  -- Every size carries its parent's EPA number, or none does (build sheet §4.1).
  IF public._normalize_epa_registration(p_size->>'epa_registration') IS DISTINCT FROM p_parent.generic_epa_registration
     AND public._normalize_epa_registration(p_size->>'epa_registration') IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_EPA_MISMATCH: "%" has %', p_parent.name,
      COALESCE('EPA number ' || p_parent.generic_epa_registration, 'no EPA number; set it on the parent first');
  END IF;
  v_fields := (p_size - 'size_role' - 'quoting_notes' - 'internal_notes')
    || jsonb_build_object('product_form', p_parent.product_form, 'category', p_parent.category);
  -- The size stores the parent's normalized number, never a spaced or lower-case spelling of it.
  IF p_parent.generic_epa_registration IS NOT NULL THEN
    v_fields := v_fields || jsonb_build_object('epa_registration', p_parent.generic_epa_registration);
  END IF;
  -- A fresh key: a retry is answered by the caller's own receipt before it gets here, so no setup
  -- receipt (for example one an admin saved under '<key>:insert') can hand back an existing product.
  v_saved := public.apply_product_setup(jsonb_build_array(jsonb_build_object('insert', v_fields)), auth.uid(),
    'product_parent_size:' || gen_random_uuid()::text);
  v_product := (v_saved->'rows'->0->>'product_id')::uuid;
  -- The notes go on in the same transaction (the setup insert does not take them), trimmed as the setup
  -- update stores them; blank is none.
  IF NULLIF(btrim(p_size->>'quoting_notes'), '') IS NOT NULL OR NULLIF(btrim(p_size->>'internal_notes'), '') IS NOT NULL THEN
    UPDATE public.products SET quoting_notes = NULLIF(btrim(p_size->>'quoting_notes'), ''),
      internal_notes = NULLIF(btrim(p_size->>'internal_notes'), '')
    WHERE id = v_product;
  END IF;
  -- A seed or each parent's one rate is per stock unit, so every size must be stocked in the same unit.
  v_refusal := public._product_parent_unit_refusal(p_parent, (SELECT inventory_unit FROM public.products WHERE id = v_product), v_product);
  IF v_refusal IS NOT NULL THEN RAISE EXCEPTION '%', v_refusal; END IF;
  RETURN v_product;
END;
$function$;

-- Postcondition: grants unchanged (postgres only; the public functions call it).
DO $postflight$
BEGIN
  IF (SELECT proacl FROM pg_proc WHERE oid = 'public._insert_parent_size(public.product_parents,jsonb,text)'::regprocedure)
       IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[] THEN
    RAISE EXCEPTION 'PRODUCT_SIZE_NOTES_POSTCONDITION: _insert_parent_size''s grants changed';
  END IF;
END
$postflight$;
