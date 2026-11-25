-- Keep an unresolved URL report when an admin corrects supplemental metadata.
-- Replacing the normalized URL continues to resolve the report.
CREATE OR REPLACE FUNCTION public._process_brand_document_links(
  p_brand_id uuid, p_parent_brand boolean, p_brand_version integer, p_changes jsonb,
  p_preview boolean
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_admin boolean := public.is_admin();
  v_owner_id uuid;
  v_brand_version integer;
  v_change jsonb;
  v_action text;
  v_kind text;
  v_url text;
  v_state text;
  v_expiry_input text;
  v_expiry date;
  v_reason text;
  v_id uuid;
  v_version bigint;
  v_link public.brand_document_links%ROWTYPE;
  v_before jsonb;
  v_document_key jsonb;
  v_preview_keys jsonb := '[]'::jsonb;
  v_preview_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF v_actor IS NULL OR NOT public.is_active_profile() THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF p_brand_id IS NULL OR p_parent_brand IS NULL OR p_brand_version IS NULL
     OR jsonb_typeof(p_changes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'BRAND_DOCUMENT_INVALID';
  END IF;
  IF jsonb_array_length(p_changes) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'BRAND_DOCUMENT_INVALID';
  END IF;
  IF NOT v_admin AND (p_preview OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_changes) c WHERE c->>'action' IS DISTINCT FROM 'report'
  )) THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;

  -- Use the same owner lock as grouping and brand edits, before rechecking membership.
  IF NOT p_preview AND current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_READ_COMMITTED_REQUIRED';
  END IF;
  IF p_parent_brand THEN
    SELECT parent_id INTO v_owner_id FROM public.product_parent_brands WHERE id = p_brand_id;
    IF NOT p_preview THEN
      PERFORM 1 FROM public.product_parents WHERE id = v_owner_id FOR UPDATE;
      PERFORM 1 FROM public.product_parent_brands WHERE id = p_brand_id FOR UPDATE;
    END IF;
    SELECT b.row_version INTO v_brand_version
      FROM public.product_parent_brands b JOIN public.product_parents p ON p.id = b.parent_id
     WHERE b.id = p_brand_id AND b.parent_id = v_owner_id AND b.status = 'active' AND p.is_active;
  ELSE
    SELECT product_id INTO v_owner_id FROM public.product_brands WHERE id = p_brand_id;
    IF NOT p_preview THEN
      PERFORM 1 FROM public.products WHERE id = v_owner_id FOR NO KEY UPDATE;
      PERFORM 1 FROM public.product_brands WHERE id = p_brand_id FOR UPDATE;
    END IF;
    SELECT b.row_version INTO v_brand_version FROM public.product_brands b
     WHERE b.id = p_brand_id AND b.product_id = v_owner_id AND NOT EXISTS (
       SELECT 1 FROM public.product_parent_members WHERE product_id = v_owner_id
     );
  END IF;
  IF v_brand_version IS DISTINCT FROM p_brand_version THEN
    RAISE EXCEPTION 'BRAND_CHANGED: reload this brand before changing its document links' USING ERRCODE = '40001';
  END IF;

  FOR v_change IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
    v_action := v_change->>'action';
    v_kind := v_change->>'kind';
    v_reason := nullif(regexp_replace(v_change->>'reason', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
    BEGIN
      v_id := (v_change->>'id')::uuid;
      v_version := (v_change->>'version')::bigint;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'BRAND_DOCUMENT_INVALID';
    END;
    v_before := NULL;
    IF v_action IS NULL OR v_action NOT IN ('save', 'report', 'hide', 'dismiss') THEN
      RAISE EXCEPTION 'BRAND_DOCUMENT_INVALID';
    END IF;
    IF p_preview AND v_action <> 'save' THEN
      RAISE EXCEPTION 'BRAND_DOCUMENT_INVALID';
    END IF;
    IF v_action IN ('save', 'report') AND v_reason IS NOT NULL THEN
      RAISE EXCEPTION 'BRAND_DOCUMENT_INVALID';
    END IF;
    IF v_action = 'report' AND (v_change - ARRAY['action', 'id', 'version'] <> '{}'::jsonb
       OR length(v_change->>'id') > 36 OR length(v_change->>'version') > 20) THEN
      RAISE EXCEPTION 'BRAND_DOCUMENT_INVALID';
    END IF;
    IF v_id IS NOT NULL THEN
      IF NOT p_preview THEN
        PERFORM 1 FROM public.brand_document_links WHERE id = v_id AND hidden_at IS NULL AND
          CASE WHEN p_parent_brand THEN parent_brand_id = p_brand_id ELSE legacy_brand_id = p_brand_id END
        FOR UPDATE;
      END IF;
      SELECT * INTO v_link FROM public.brand_document_links
       WHERE id = v_id AND hidden_at IS NULL AND
         CASE WHEN p_parent_brand THEN parent_brand_id = p_brand_id ELSE legacy_brand_id = p_brand_id END;
      IF NOT FOUND OR v_link.row_version IS DISTINCT FROM v_version THEN
        RAISE EXCEPTION 'BRAND_DOCUMENT_CHANGED: reload this link before changing it' USING ERRCODE = '40001';
      END IF;
      v_before := to_jsonb(v_link);
    ELSIF v_action <> 'save' OR v_version IS NOT NULL THEN
      RAISE EXCEPTION 'BRAND_DOCUMENT_INVALID';
    END IF;

    IF v_action = 'save' THEN
      v_url := public._normalize_brand_document_url(v_change->>'url');
      v_state := nullif(upper(btrim(v_change->>'state')), '');
      v_expiry_input := v_change->>'expires_on';
      IF v_expiry_input IS NOT NULL AND v_expiry_input !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'BRAND_DOCUMENT_INVALID';
      END IF;
      BEGIN
        v_expiry := v_expiry_input::date;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'BRAND_DOCUMENT_INVALID';
      END;
      IF v_kind IS NULL OR v_kind NOT IN ('specimen', 'sds', 'supplemental')
         OR (v_id IS NOT NULL AND v_link.document_kind <> v_kind)
         OR (v_kind = 'supplemental' AND (v_state IS NULL OR v_state !~ '^[A-Z]{2}$' OR v_expiry IS NULL))
         OR (v_kind <> 'supplemental' AND (v_state IS NOT NULL OR v_expiry IS NOT NULL)) THEN
        RAISE EXCEPTION 'BRAND_DOCUMENT_INVALID';
      END IF;
      IF p_preview THEN
        v_document_key := CASE WHEN v_kind = 'supplemental' THEN
          jsonb_build_array(v_kind, v_url, v_state, v_expiry) ELSE jsonb_build_array(v_kind) END;
        IF v_id = ANY(v_preview_ids) OR v_preview_keys @> jsonb_build_array(v_document_key) OR EXISTS (
          SELECT 1 FROM public.brand_document_links l WHERE l.hidden_at IS NULL AND l.id IS DISTINCT FROM v_id
            AND NOT (l.id = ANY(v_preview_ids))
            AND CASE WHEN p_parent_brand THEN l.parent_brand_id = p_brand_id ELSE l.legacy_brand_id = p_brand_id END
            AND l.document_kind = v_kind AND (v_kind <> 'supplemental' OR
              (l.url, l.state_code, l.expires_on) = (v_url, v_state, v_expiry))
        ) THEN
          RAISE EXCEPTION 'BRAND_DOCUMENT_CHANGED: a matching document link already exists; reload this brand' USING ERRCODE = '40001';
        END IF;
        v_preview_keys := v_preview_keys || jsonb_build_array(v_document_key);
        IF v_id IS NOT NULL THEN v_preview_ids := array_append(v_preview_ids, v_id); END IF;
        CONTINUE;
      END IF;
      IF v_id IS NULL THEN
        INSERT INTO public.brand_document_links
          (legacy_brand_id, parent_brand_id, document_kind, url, state_code, expires_on)
        VALUES (CASE WHEN NOT p_parent_brand THEN p_brand_id END, CASE WHEN p_parent_brand THEN p_brand_id END,
                v_kind, v_url, v_state, v_expiry)
        RETURNING * INTO v_link;
      ELSE
        IF (v_link.url, v_link.state_code, v_link.expires_on)
           IS NOT DISTINCT FROM (v_url, v_state, v_expiry) THEN CONTINUE; END IF;
        UPDATE public.brand_document_links SET url = v_url, state_code = v_state, expires_on = v_expiry,
            reported_at = CASE WHEN v_link.url = v_url THEN v_link.reported_at END,
            reported_by = CASE WHEN v_link.url = v_url THEN v_link.reported_by END,
            row_version = row_version + 1
         WHERE id = v_id RETURNING * INTO v_link;
      END IF;
    ELSIF v_action = 'report' THEN
      IF v_link.reported_at IS NOT NULL THEN CONTINUE; END IF;
      UPDATE public.brand_document_links SET reported_at = now(), reported_by = v_actor, row_version = row_version + 1
       WHERE id = v_id RETURNING * INTO v_link;
    ELSE
      IF v_reason IS NULL OR length(v_reason) > 1000 THEN
        RAISE EXCEPTION 'BRAND_DOCUMENT_REASON_REQUIRED: enter a reason';
      END IF;
      IF v_action = 'dismiss' AND v_link.reported_at IS NULL THEN CONTINUE; END IF;
      UPDATE public.brand_document_links SET reported_at = NULL, reported_by = NULL, row_version = row_version + 1,
          hidden_at = CASE WHEN v_action = 'hide' THEN now() ELSE hidden_at END
       WHERE id = v_id RETURNING * INTO v_link;
    END IF;
    INSERT INTO public.brand_document_link_events (link_id, action, changed_by, reason, before_value, after_value)
    VALUES (v_link.id, CASE v_action WHEN 'save' THEN 'saved' WHEN 'report' THEN 'reported'
                        WHEN 'hide' THEN 'hidden' ELSE 'dismissed' END,
            v_actor, v_reason, v_before, to_jsonb(v_link));
  END LOOP;
  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'BRAND_DOCUMENT_CHANGED: a matching document link already exists; reload this brand' USING ERRCODE = '40001';
END;
$function$;
