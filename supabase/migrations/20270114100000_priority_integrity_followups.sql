-- Priority follow-ups: preserve reviewed brand identities, accurate automatic rate attribution,
-- deterministic rate reasons, and existing closed-order/photo invariants. Candidate only; no data rewrite.
SET LOCAL lock_timeout = '5s';
DO $preflight$
DECLARE r record; v_oid oid; v_constraint oid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('_guard_closed_po_item()', '9cc9b05b3f74c2dd1a5c4cd27ebb9c74', '{postgres=X/postgres}'),
    ('_guard_delivery_photo_uploader()', 'd3e539abe6a51b931078f00bfb6bd820', '{postgres=X/postgres}'),
    ('_product_rate_review_reopen(uuid,bigint,text,uuid)', '7afefb2fe6d2c180c6c35fae178d989c', '{postgres=X/postgres}'),
    ('_product_rates_clear_outcome()', '0ece8928863bf41f1fe3f0c322a74a16', '{postgres=X/postgres}'),
    ('correct_delivery_brands(uuid,jsonb,text,bigint,text)', 'ac2dd087b286d93cc1245d0bebf471e7', '{postgres=X/postgres,authenticated=X/postgres}'),
    ('_delivery_brand_insert(uuid,uuid,uuid,jsonb)', 'e132e911f8e5a2dc00800a73e1280bf2', '{postgres=X/postgres}'),
    ('save_draft_product_rate(uuid,uuid,bigint,text,text,numeric,numeric,numeric,text,boolean,text,text)', 'd19353cf1880bc8c571d72bcfb392bc3', '{postgres=X/postgres,authenticated=X/postgres}'),
    ('delete_draft_product_rate(uuid,bigint,text,text)', '7462ee246187f07c682e14d06b387838', '{postgres=X/postgres,authenticated=X/postgres}')
  ) expected(signature, body_md5, acl) LOOP
    v_oid := to_regprocedure('public.' || r.signature);
    IF v_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
       AND md5(p.prosrc) = r.body_md5 AND p.proacl::text = r.acl
       AND p.proowner = 'postgres'::regrole
       AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
      RAISE EXCEPTION 'PRIORITY_PREFLIGHT_DRIFT: %', r.signature;
    END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname=split_part(r.signature,'(',1)) <> 1 THEN
      RAISE EXCEPTION 'PRIORITY_PREFLIGHT_OVERLOAD: %', r.signature;
    END IF;
  END LOOP;
  SELECT c.oid INTO STRICT v_constraint FROM pg_constraint c
   WHERE c.conrelid='public.product_rates'::regclass AND c.contype='c'
     AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                           WHERE attrelid='public.product_rates'::regclass AND attname='over_label_reason')]::smallint[];
  IF md5(pg_get_constraintdef(v_constraint)) <> 'aab299789c1c80e7f7a60cde9afd1c30' THEN
    RAISE EXCEPTION 'PRIORITY_PREFLIGHT_REASON_CHECK_DRIFT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.product_rate_draft_events'::regclass
                  AND attname='changed_by' AND attnotnull) THEN
    RAISE EXCEPTION 'PRIORITY_PREFLIGHT_ACTOR_DRIFT';
  END IF;
  IF to_regprocedure('public._product_rate_reason_trim(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'PRIORITY_PREFLIGHT_HELPER_EXISTS';
  END IF;
END;
$preflight$;

-- Private: boundary trimming is shared by writers and the constraint; meaningful interior text stays intact.
CREATE FUNCTION public._product_rate_reason_trim(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SECURITY INVOKER SET search_path = public, pg_temp
AS $function$
  SELECT btrim(p_text, U&'\0009\000a\000b\000c\000d\0020\0085\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\00ad\200b\200c\200d\2060\feff');
$function$;
ALTER FUNCTION public._product_rate_reason_trim(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_rate_reason_trim(text) FROM PUBLIC, anon, authenticated, service_role;

DO $reason_check$
DECLARE v_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.product_rates WHERE over_label_reason IS NOT NULL AND
    (public._product_rate_reason_trim(over_label_reason) = ''
      OR over_label_reason IS DISTINCT FROM public._product_rate_reason_trim(over_label_reason)
      OR length(over_label_reason) > 500)) THEN
    RAISE EXCEPTION 'PRIORITY_EXISTING_REASON_INVALID: review existing rate reasons before applying';
  END IF;
  SELECT conname INTO STRICT v_name FROM pg_constraint
   WHERE conrelid='public.product_rates'::regclass AND contype='c'
     AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.product_rates'::regclass
                         AND attname='over_label_reason')]::smallint[];
  EXECUTE format('ALTER TABLE public.product_rates DROP CONSTRAINT %I', v_name);
  EXECUTE format('ALTER TABLE public.product_rates ADD CONSTRAINT %I CHECK (over_label_reason IS NULL OR
    (public._product_rate_reason_trim(over_label_reason) <> ''''
     AND over_label_reason = public._product_rate_reason_trim(over_label_reason)
     AND length(over_label_reason) <= 500))', v_name);
END;
$reason_check$;

ALTER TABLE public.product_rate_draft_events ALTER COLUMN changed_by DROP NOT NULL;
ALTER TABLE public.product_rate_draft_events ADD CONSTRAINT product_rate_draft_events_actor_required
  CHECK (changed_by IS NOT NULL OR (event_type = 'outcome_cleared'
    AND reason IS NOT DISTINCT FROM 'the parent''s rates changed'));
COMMENT ON COLUMN public.product_rate_draft_events.changed_by IS
  'Signed-in actor; NULL means System only for the automatic parent-rates-changed outcome-clear event.';

CREATE OR REPLACE FUNCTION public._guard_closed_po_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Cost raises stay allowed on a closed PO (set_purchase_order_item_costs); unit_cost_cents is generated.
  c_cost CONSTANT text[] := ARRAY['unit_cost', 'unit_cost_cents', 'cost_needs_review', 'cost_provenance',
                                  'cost_snapshot_at', 'product_supplier_link_id', 'supplier_price_observation_id'];
  v_same_line boolean := false;
  v_closed text;
  v_received_cents bigint;
  v_billed_cents bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Every column but cost and received is frozen on a closed PO's line (fires before the other BEFORE triggers).
    v_same_line := (to_jsonb(NEW) - c_cost - 'quantity_received') IS NOT DISTINCT FROM (to_jsonb(OLD) - c_cost - 'quantity_received');
    IF v_same_line AND NEW.quantity_received IS NOT DISTINCT FROM OLD.quantity_received THEN
      -- Only cost columns changed. A raise is fine; a cut (received or not) is refused below if the PO is closed.
      IF COALESCE(NEW.unit_cost, 0) >= COALESCE(OLD.unit_cost, 0) THEN
        RETURN NEW;
      END IF;
      -- A cost cut is checked after the parent is locked.
    END IF;
  END IF;
  -- FOR SHARE waits for a close in flight, so a line change never slips in beside it. Both parents of a moved line.
  SELECT string_agg(po.po_number, ', ' ORDER BY po.po_number) INTO v_closed
    FROM (SELECT p.po_number, p.status FROM public.purchase_orders p
           WHERE p.id = ANY (CASE TG_OP
                               WHEN 'INSERT' THEN ARRAY[NEW.purchase_order_id]
                               WHEN 'DELETE' THEN ARRAY[OLD.purchase_order_id]
                               ELSE ARRAY[OLD.purchase_order_id, NEW.purchase_order_id] END)
           ORDER BY p.id FOR SHARE) po
   WHERE po.status = 'closed';
  IF v_closed IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(NEW.unit_cost, 0) < COALESCE(OLD.unit_cost, 0) THEN
    -- Mason 2026-11-11: a closed PO's costs never go down; a price mistake is fixed on the bill or by a vendor credit.
    RAISE EXCEPTION 'PO_CLOSED_COST_CUT: purchase order % was closed short; its line costs cannot be lowered (correct the vendor bill or take a vendor credit)',
      v_closed USING ERRCODE = '55000';
  END IF;
  IF v_same_line
     AND COALESCE(NEW.quantity_received, 0) < COALESCE(OLD.quantity_received, 0)
     AND current_setting('app.reversal_rpc_active', true) = 'true' THEN
    -- reverse_receiving_record taking a wrong receipt back off a closed PO lowers received value; a closed PO's bills
    -- stay at or under it (the close's rule).
    SELECT COALESCE(SUM(round(COALESCE(poi.quantity_received, 0) * COALESCE(poi.unit_cost, 0) * 100)), 0)::bigint
      INTO v_received_cents
      FROM public.purchase_order_items poi
     WHERE poi.purchase_order_id = NEW.purchase_order_id AND poi.id <> NEW.id;
    v_received_cents := v_received_cents + round(COALESCE(NEW.quantity_received, 0) * COALESCE(NEW.unit_cost, 0) * 100)::bigint;
    SELECT COALESCE(SUM(vb.total_cents), 0)::bigint INTO v_billed_cents
      FROM public.vendor_bills vb
     WHERE vb.purchase_order_id = NEW.purchase_order_id AND vb.deleted_at IS NULL AND vb.status <> 'voided';
    IF v_billed_cents > v_received_cents THEN
      RAISE EXCEPTION 'PO_CLOSE_BILLED_OVER_RECEIVED: this change would put vendor bills on closed PO % above what was received; correct the bill first',
        v_closed USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PO_CLOSED: purchase order % was closed short; its lines cannot be added, removed, changed or received into', v_closed;
END;
$function$;

CREATE OR REPLACE FUNCTION public._guard_delivery_photo_uploader()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_file_created timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
       OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
       OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
       OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
      RAISE EXCEPTION 'DELIVERY_PHOTO_PROVENANCE_LOCKED: a delivery photo''s delivery, file, uploader and upload time cannot change'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- No signed-in user: service role, dashboard or a migration (KI-77 accepted limit).
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.uploaded_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'DELIVERY_PHOTO_UPLOADER_MISMATCH: a delivery photo is recorded under the person who uploads it'
      USING ERRCODE = '23514';
  END IF;
  IF split_part(NEW.storage_path, '/', 1) IS DISTINCT FROM 'delivery-photos'
     OR split_part(NEW.storage_path, '/', 2) IS DISTINCT FROM NEW.delivery_id::text THEN
    RAISE EXCEPTION 'DELIVERY_PHOTO_FOLDER_MISMATCH: record the photo under this delivery''s folder'
      USING ERRCODE = '23514';
  END IF;
  SELECT o.created_at INTO v_file_created
    FROM storage.objects o
   WHERE o.bucket_id = 'delivery-photos'
     AND o.name = NEW.storage_path
     AND o.owner_id = v_actor::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELIVERY_PHOTO_FILE_NOT_YOURS: the photo file must be one you uploaded'
      USING ERRCODE = '23514';
  END IF;
  -- Match completion's folder rule; preserve the file's actual upload time.
  NEW.uploaded_at := coalesce(v_file_created, now());
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_draft_product_rate(p_parent_id uuid, p_rate_id uuid, p_expected_row_version bigint, p_basis text, p_source text, p_low numeric, p_recommended numeric, p_high numeric, p_unit text, p_is_quoting_default boolean, p_over_label_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_fp text;
  v_existing jsonb;
  v_unit public.product_rate_units%ROWTYPE;
  v_unit_text text := btrim(COALESCE(p_unit, ''));
  v_reason text := NULLIF(public._product_rate_reason_trim(COALESCE(p_over_label_reason, '')), '');
  v_default boolean := COALESCE(p_is_quoting_default, false);
  v_parent public.product_parents%ROWTYPE;
  v_old public.product_rates%ROWTYPE;
  v_new public.product_rates%ROWTYPE;
  v_other uuid;
  v_check jsonb;
  v_result jsonb;
BEGIN
  v_actor := public._product_parent_require_admin();
  v_fp := md5(jsonb_build_object('actor_id', v_actor, 'parent_id', p_parent_id, 'rate_id', p_rate_id,
    'expected_row_version', p_expected_row_version, 'basis', p_basis, 'source', p_source, 'low', p_low,
    'recommended', p_recommended, 'high', p_high, 'unit', p_unit, 'is_quoting_default', p_is_quoting_default,
    'over_label_reason', p_over_label_reason)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'save_draft_product_rate', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  -- Shapes. A negative value passes here and is refused as a range below (sheet 3.4 and R6).
  IF p_basis IS NULL OR p_basis NOT IN ('per_acre', 'per_100_gal', 'per_unit', 'per_cwt_seed', 'per_seed_unit') THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: basis must be per_acre, per_100_gal, per_unit, per_cwt_seed or per_seed_unit';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('label', 'house_standard') THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: source must be label or house_standard';
  END IF;
  IF NOT (public._product_rate_number_ok(abs(p_low)) AND public._product_rate_number_ok(abs(p_recommended))
          AND public._product_rate_number_ok(abs(p_high))) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_INVALID: a rate must be a number below 1000000000 with at most 6 decimals';
  END IF;
  SELECT * INTO v_unit FROM public.product_rate_units u WHERE u.code = v_unit_text;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_RATE_UNIT_UNKNOWN: "%" is not a rate unit', v_unit_text; END IF;
  IF length(v_reason) > 500 THEN RAISE EXCEPTION 'PRODUCT_RATE_INVALID: keep the over-label reason to 500 characters'; END IF;

  -- Locks (sheet 3.6): REG-1 pair shared, the parent, the parent's rate rows.
  PERFORM pg_advisory_xact_lock_shared(20261210, hashtext('crx_epa_registration'));
  SELECT * INTO v_parent FROM public.product_parents WHERE id = p_parent_id AND is_active FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PARENT_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.product_rates WHERE parent_id = p_parent_id ORDER BY id FOR UPDATE;

  IF p_rate_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.product_rates WHERE id = p_rate_id AND parent_id = p_parent_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_FOUND'; END IF;
    IF v_old.status <> 'draft' THEN RAISE EXCEPTION 'PRODUCT_RATE_APPROVED: send it back to draft first'; END IF;
    IF p_expected_row_version IS DISTINCT FROM v_old.row_version THEN
      RAISE EXCEPTION 'PRODUCT_RATE_STALE: this rate changed since you opened it; reload and try again';
    END IF;
  END IF;

  -- Sheet 3.4, in table order (the unit's existence was checked above).
  IF v_default THEN
    SELECT id INTO v_other FROM public.product_rates
     WHERE parent_id = p_parent_id AND is_quoting_default AND id IS DISTINCT FROM p_rate_id;
    IF FOUND THEN
      RAISE EXCEPTION 'PRODUCT_RATE_DEFAULT_EXISTS: % already has a quoting default (rate %); clear it first', v_parent.name, v_other;
    END IF;
    IF p_basis <> 'per_acre' THEN RAISE EXCEPTION 'PRODUCT_RATE_DEFAULT_NOT_PER_ACRE: only a per-acre rate can be the quoting default'; END IF;
    IF p_recommended IS NULL THEN RAISE EXCEPTION 'PRODUCT_RATE_DEFAULT_NEEDS_RECOMMENDED: the quoting default needs a recommended rate'; END IF;
    -- Only a house rate is checked against the label maximum, so only a house rate may be quoted by default.
    IF p_source <> 'house_standard' THEN
      RAISE EXCEPTION 'PRODUCT_RATE_DEFAULT_NOT_HOUSE: only a house rate can be the quoting default';
    END IF;
  END IF;
  IF NOT public._product_rate_unit_fits(v_parent.product_form, p_basis, v_unit.kind) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_UNIT_NOT_FOR_BASIS: % is not allowed for % on a % product', v_unit.code, p_basis, v_parent.product_form;
  END IF;
  IF (p_low IS NULL AND p_recommended IS NULL AND p_high IS NULL)
     OR p_low < 0 OR p_recommended < 0 OR p_high < 0
     OR p_low > p_high OR p_low > p_recommended OR p_recommended > p_high THEN
    RAISE EXCEPTION 'PRODUCT_RATE_RANGE_INVALID: give at least one rate, none below 0, with low <= recommended <= high';
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_rates WHERE parent_id = p_parent_id AND source = p_source AND basis = p_basis
              AND id IS DISTINCT FROM p_rate_id) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_DUPLICATE: % already has a % % rate', v_parent.name, p_source, p_basis;
  END IF;

  -- Label check on the proposed values (a save confirms the basis). Warns, never blocks, once a reason is given.
  v_check := public._product_rate_check_values(p_parent_id, p_source, p_basis, v_unit.code, p_low, p_recommended, p_high,
    true, v_reason);
  IF v_check->>'status' = 'above' AND v_reason IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED: % % is above the label maximum % % on EPA %; give a reason to save it',
      greatest(p_low, p_recommended, p_high), v_unit.label, v_check->'above'->0->>'max_label_rate',
      v_check->'above'->0->>'max_label_rate_unit', v_check->'above'->0->>'epa_registration';
  END IF;

  IF p_rate_id IS NULL THEN
    INSERT INTO public.product_rates (parent_id, basis, source, low, recommended, high, unit, is_quoting_default,
      origin, basis_confirmed, over_label_reason, created_by, updated_by)
    VALUES (p_parent_id, p_basis, p_source, p_low, p_recommended, p_high, v_unit.code, v_default,
      'manual', true, v_reason, v_actor, v_actor)
    RETURNING * INTO v_new;
  ELSE
    UPDATE public.product_rates SET basis = p_basis, source = p_source, low = p_low, recommended = p_recommended,
      high = p_high, unit = v_unit.code, is_quoting_default = v_default, basis_confirmed = true,
      over_label_reason = v_reason, row_version = row_version + 1, updated_by = v_actor
     WHERE id = p_rate_id
    RETURNING * INTO v_new;
  END IF;
  INSERT INTO public.product_rate_draft_events (parent_id, rate_id, event_type, before_values, after_values, changed_by)
  VALUES (p_parent_id, v_new.id, 'saved', CASE WHEN p_rate_id IS NOT NULL THEN to_jsonb(v_old) END, to_jsonb(v_new), v_actor);

  v_result := jsonb_build_object('rate_id', v_new.id, 'row_version', v_new.row_version, 'label_check', v_check);
  PERFORM public.save_idempotency(p_idempotency_key, 'save_draft_product_rate',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_draft_product_rate(p_rate_id uuid, p_expected_row_version bigint, p_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_fp text;
  v_existing jsonb;
  v_reason text := public._product_rate_reason_trim(COALESCE(p_reason, ''));
  v_parent_id uuid;
  v_old public.product_rates%ROWTYPE;
  v_result jsonb;
BEGIN
  v_actor := public._product_parent_require_admin();
  v_fp := md5(jsonb_build_object('actor_id', v_actor, 'rate_id', p_rate_id,
    'expected_row_version', p_expected_row_version, 'reason', p_reason)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'delete_draft_product_rate', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF v_reason = '' OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'PRODUCT_RATE_REASON_REQUIRED: say why, in 1 to 500 characters';
  END IF;

  -- parent_id never changes (trigger), so this read names the parent to lock first.
  SELECT parent_id INTO v_parent_id FROM public.product_rates WHERE id = p_rate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.product_parents WHERE id = v_parent_id FOR NO KEY UPDATE;
  SELECT * INTO v_old FROM public.product_rates WHERE id = p_rate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_FOUND'; END IF;
  IF v_old.status <> 'draft' THEN RAISE EXCEPTION 'PRODUCT_RATE_APPROVED: send it back to draft first'; END IF;
  IF p_expected_row_version IS DISTINCT FROM v_old.row_version THEN
    RAISE EXCEPTION 'PRODUCT_RATE_STALE: this rate changed since you opened it; reload and try again';
  END IF;

  DELETE FROM public.product_rates WHERE id = p_rate_id;
  INSERT INTO public.product_rate_draft_events (parent_id, rate_id, event_type, before_values, reason, changed_by)
  VALUES (v_old.parent_id, v_old.id, 'deleted', to_jsonb(v_old), v_reason, v_actor);

  v_result := jsonb_build_object('rate_id', p_rate_id, 'deleted', true);
  PERFORM public.save_idempotency(p_idempotency_key, 'delete_draft_product_rate',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._product_rate_review_reopen(p_rate_id uuid, p_expected_row_version bigint, p_reason text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_reason text := public._product_rate_reason_trim(COALESCE(p_reason, ''));
  v_old public.product_rates%ROWTYPE;
  v_new public.product_rates%ROWTYPE;
BEGIN
  IF v_reason = '' OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'PRODUCT_RATE_REASON_REQUIRED: say why, in 1 to 500 characters';
  END IF;
  v_old := public._product_rate_review_lock(p_rate_id);
  IF v_old.status <> 'approved' THEN RAISE EXCEPTION 'PRODUCT_RATE_NOT_APPROVED: this rate is already a draft'; END IF;
  IF p_expected_row_version IS DISTINCT FROM v_old.row_version THEN
    RAISE EXCEPTION 'PRODUCT_RATE_STALE: this rate changed since you opened it; reload and try again';
  END IF;
  UPDATE public.product_rates SET status = 'draft', approved_by = NULL, approved_at = NULL,
         row_version = row_version + 1, updated_by = p_actor
   WHERE id = p_rate_id
  RETURNING * INTO v_new;
  INSERT INTO public.product_rate_draft_events (parent_id, rate_id, event_type, before_values, after_values, reason, changed_by)
  VALUES (v_new.parent_id, v_new.id, 'reopened', to_jsonb(v_old), to_jsonb(v_new), v_reason, p_actor);
  RETURN jsonb_build_object('rate_id', v_new.id, 'row_version', v_new.row_version);
END;
$function$;

CREATE OR REPLACE FUNCTION public._product_rates_clear_outcome()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row public.product_rates%ROWTYPE;
  v_old public.product_parent_rate_outcomes%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
  SELECT * INTO v_old FROM public.product_parent_rate_outcomes WHERE parent_id = v_row.parent_id FOR UPDATE;
  INSERT INTO public.product_parent_rate_outcomes AS o (parent_id) VALUES (v_row.parent_id)
  ON CONFLICT (parent_id) DO UPDATE SET outcome = NULL, note = NULL, decided_by = NULL, decided_at = NULL,
    outcome_version = o.outcome_version + 1, updated_at = now();
  IF v_old.outcome IS NOT NULL THEN
    INSERT INTO public.product_rate_draft_events (parent_id, rate_id, event_type, before_values, reason, changed_by)
    VALUES (v_row.parent_id, v_row.id, 'outcome_cleared', to_jsonb(v_old), 'the parent''s rates changed',
      auth.uid());
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public._delivery_brand_insert(p_line_id uuid, p_delivery_id uuid, p_product_id uuid, p_rows jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  INSERT INTO public.delivery_item_brands
    (id, delivery_item_id, delivery_id, product_id, source, parent_id, parent_brand_id, legacy_brand_id, brand_name,
     epa_registration, manufacturer, signal_word, quantity, review_state, review_note, review_brand_ref, review_reason, reviewed_by, reviewed_at, entered_by, entered_at)
  SELECT (r ->> 'id')::uuid, p_line_id, p_delivery_id, p_product_id, r ->> 'source', (r ->> 'parent_id')::uuid,
         (r ->> 'parent_brand_id')::uuid, (r ->> 'legacy_brand_id')::uuid, r ->> 'brand_name',
         r ->> 'epa_registration', r ->> 'manufacturer', r ->> 'signal_word', (r ->> 'quantity')::numeric,
         r ->> 'review_state', r ->> 'review_note', (r ->> 'review_brand_ref')::uuid,
         r ->> 'review_reason', (r ->> 'reviewed_by')::uuid, (r ->> 'reviewed_at')::timestamptz,
         COALESCE((r ->> 'entered_by')::uuid, auth.uid()), COALESCE((r ->> 'entered_at')::timestamptz, now())
    FROM jsonb_array_elements(p_rows) r;
$function$;

CREATE OR REPLACE FUNCTION public.correct_delivery_brands(p_delivery_id uuid, p_lines jsonb, p_reason text, p_base_event_seq bigint, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_delivery record;
  v_fp text;
  v_existing jsonb;
  v_reason text;
  v_line jsonb;
  v_item record;
  v_rows jsonb;
  v_resolved jsonb;
  v_pick record;
  v_old_pick jsonb;
  v_line_before jsonb;
  v_plan jsonb := '[]'::jsonb;
  v_after jsonb := '[]'::jsonb;
  v_step jsonb;
  v_line_ids uuid[] := '{}';
  v_order_items uuid[] := '{}';
  v_invoice record;
  v_invoice_ids uuid[] := '{}';
  v_before jsonb;
  v_seq bigint;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT id, status INTO v_delivery FROM public.deliveries
   WHERE id = p_delivery_id AND deleted_at IS NULL FOR UPDATE;
  IF v_delivery.id IS NULL THEN RAISE EXCEPTION 'DELIVERY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED: only an admin can correct delivered brands' USING ERRCODE = '42501';
  END IF;
  v_fp := md5(jsonb_build_array(p_delivery_id, p_lines, p_reason, p_base_event_seq)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'correct_delivery_brands', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  IF v_delivery.status <> 'completed' THEN
    RAISE EXCEPTION 'DELIVERY_NOT_COMPLETED: brands are corrected only on a completed delivery (this one is %)', v_delivery.status;
  END IF;
  v_reason := btrim(regexp_replace(COALESCE(p_reason, ''), '[[:space:]]+', ' ', 'g'));
  IF v_reason = '' THEN RAISE EXCEPTION 'BRAND_CORRECTION_REASON_REQUIRED: say why the brands are being corrected' USING ERRCODE = '22023'; END IF;
  IF char_length(v_reason) > 1000 THEN RAISE EXCEPTION 'BRAND_CORRECTION_REASON_TOO_LONG: keep the reason to 1,000 characters' USING ERRCODE = '22023'; END IF;
  IF p_base_event_seq IS NULL THEN RAISE EXCEPTION 'BRAND_BASE_SEQ_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_base_event_seq IS DISTINCT FROM public._delivery_brand_max_seq(p_delivery_id) THEN
    RAISE EXCEPTION 'BRAND_PICKS_CHANGED: someone else changed this delivery''s brands; reload and try again';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'BRAND_LINES_REQUIRED: name at least one delivery line' USING ERRCODE = '22023';
  END IF;

  -- Validate every line and resolve its picks before anything is written.
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT di.id, di.order_item_id, di.product_id, COALESCE(di.quantity_delivered, di.quantity) AS delivered
      INTO v_item FROM public.delivery_items di
     WHERE di.delivery_id = p_delivery_id AND di.id::text = (v_line ->> 'delivery_item_id');
    IF v_item.id IS NULL THEN
      RAISE EXCEPTION 'DELIVERY_ITEM_NOT_ON_DELIVERY: % is not a line of this delivery', v_line ->> 'delivery_item_id'
        USING ERRCODE = '22023';
    END IF;
    IF v_item.id = ANY (v_line_ids) THEN RAISE EXCEPTION 'BRAND_LINE_DUPLICATE: a line is named twice' USING ERRCODE = '22023'; END IF;
    v_line_ids := v_line_ids || v_item.id;
    IF v_item.order_item_id IS NOT NULL THEN v_order_items := v_order_items || v_item.order_item_id; END IF;
    v_resolved := public._delivery_brand_resolve_picks(v_item.product_id, v_line -> 'picks');
    v_line_before := public._delivery_brand_rows(p_delivery_id, ARRAY[v_item.id]);
    v_rows := '[]'::jsonb;
    FOR v_pick IN
      SELECT submitted.value AS submitted, resolved.value AS resolved
        FROM jsonb_array_elements(v_line -> 'picks') WITH ORDINALITY submitted(value, ord)
        JOIN jsonb_array_elements(v_resolved) WITH ORDINALITY resolved(value, ord) USING (ord)
    LOOP
      v_old_pick := NULL;
      IF NULLIF(btrim(COALESCE(v_pick.submitted ->> 'brand_id', '')), '') IS NULL THEN
        SELECT old.value INTO v_old_pick FROM jsonb_array_elements(v_line_before) old
         WHERE old.value ->> 'source' = 'typed'
           AND lower(old.value ->> 'brand_name') = lower(btrim(regexp_replace(
                 COALESCE(v_pick.submitted ->> 'typed_name', ''), '[[:space:]]+', ' ', 'g')))
           AND (old.value ->> 'epa_registration') IS NOT DISTINCT FROM
                 public._normalize_epa_registration(v_pick.submitted ->> 'typed_epa')
           AND (old.value ->> 'manufacturer') IS NOT DISTINCT FROM NULLIF(btrim(regexp_replace(
                 COALESCE(v_pick.submitted ->> 'typed_manufacturer', ''), '[[:space:]]+', ' ', 'g')), '');
      END IF;
      IF v_old_pick IS NOT NULL AND (v_old_pick ->> 'review_state' <> 'pending'
                                    OR v_pick.resolved ->> 'source' = 'typed') THEN
        -- The identity's review and original entry are server-owned; only the amount and snapshot id change.
        v_rows := v_rows || jsonb_build_array(v_old_pick || jsonb_build_object(
          'id', v_pick.resolved -> 'id', 'quantity', v_pick.resolved -> 'quantity',
          'review_note', CASE WHEN v_old_pick ->> 'review_state' = 'pending'
                              THEN v_pick.resolved -> 'review_note' ELSE v_old_pick -> 'review_note' END));
      ELSE
        v_rows := v_rows || jsonb_build_array(v_pick.resolved);
      END IF;
    END LOOP;
    IF jsonb_array_length(v_rows) > 0
       AND (SELECT sum((r ->> 'quantity')::numeric) FROM jsonb_array_elements(v_rows) r) IS DISTINCT FROM round(v_item.delivered, 4) THEN
      RAISE EXCEPTION 'BRAND_SPLIT_NOT_DELIVERED: the corrected brand amounts must add up to the % delivered', v_item.delivered
        USING ERRCODE = '22023';
    END IF;
    v_plan := v_plan || jsonb_build_array(jsonb_build_object('line_id', v_item.id, 'product_id', v_item.product_id,
      'rows', v_rows));
    SELECT v_after || COALESCE(jsonb_agg(r || jsonb_build_object('delivery_item_id', v_item.id,
             'product_id', v_item.product_id)), '[]'::jsonb)
      INTO v_after FROM jsonb_array_elements(v_rows) r;
  END LOOP;

  -- Posted invoices are never changed (REG-1): every live invoice that carries these lines is locked after the
  -- delivery row, in id order, and re-read. Posting never locks a delivery, so this order cannot cycle with it.
  FOR v_invoice IN
    SELECT i.id, i.status, i.invoice_number FROM public.invoices i
     WHERE i.deleted_at IS NULL AND i.invoice_type <> 'credit_memo' AND i.status NOT IN ('voided', 'cancelled')
       AND (i.delivery_id = p_delivery_id
            OR (i.delivery_id IS NULL AND EXISTS (SELECT 1 FROM public.invoice_items ii
                                                   WHERE ii.invoice_id = i.id AND ii.order_item_id = ANY (v_order_items))))
     ORDER BY i.id
     FOR UPDATE OF i
  LOOP
    IF v_invoice.status IN ('posted', 'overdue', 'paid') THEN
      RAISE EXCEPTION 'INVOICE_POSTED: void % and reissue it first', COALESCE(v_invoice.invoice_number, v_invoice.id::text);
    END IF;
    v_invoice_ids := v_invoice_ids || v_invoice.id;
  END LOOP;

  -- The event first, so the superseded picks can point at it; its after_rows carry the new picks' ids. Nothing
  -- else can read the unfinished state: the delivery row is locked until commit.
  v_before := public._delivery_brand_rows(p_delivery_id, v_line_ids);
  v_seq := public._delivery_brand_event(p_delivery_id, 'corrected', v_reason, v_invoice_ids, v_before, v_after,
    '{}'::jsonb);
  UPDATE public.delivery_item_brands
     SET superseded_at = now(), superseded_by = v_actor, supersede_reason = v_reason, superseded_by_event_seq = v_seq
   WHERE delivery_item_id = ANY (v_line_ids) AND superseded_at IS NULL;
  FOR v_step IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    PERFORM public._delivery_brand_insert((v_step ->> 'line_id')::uuid, p_delivery_id, (v_step ->> 'product_id')::uuid,
      v_step -> 'rows');
  END LOOP;

  v_result := jsonb_build_object('delivery_id', p_delivery_id, 'event_seq', v_seq, 'invoice_ids', to_jsonb(v_invoice_ids),
    'picks', public._delivery_brand_rows(p_delivery_id));
  PERFORM public.save_idempotency(p_idempotency_key, 'correct_delivery_brands',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
