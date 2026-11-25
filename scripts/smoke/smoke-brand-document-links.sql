-- Brand document lifecycle. All rows are synthetic and the final error rolls them back.
-- Anonymous execution is denied. The actor is derived from the session, so no actor is supplied.
DO $smoke$
DECLARE
  v_admin uuid;
  v_staff uuid;
  v_size uuid := gen_random_uuid();
  v_brand uuid;
  v_link uuid;
  v_hidden_link uuid;
  v_suffix text := substr(md5(random()::text), 1, 12);
  v_key text := 'smoke:brand-documents:' || v_suffix;
  v_save jsonb := '[{"action":"save","kind":"sds","url":"HTTPS://Manufacturer.example:443/sds"}]';
  v_report jsonb;
  v_payload jsonb;
  v_group_tag text := translate(substr(md5(random()::text), 1, 10), '0123456789', 'ghijklmnop');
  v_epa text := '9' || (10000 + floor(random() * 89999))::integer || '-7';
  v_sizes uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  v_brands uuid[] := ARRAY[]::uuid[];
  v_parent uuid;
  v_move_target uuid;
  v_move_brand uuid;
  v_retired_source uuid;
  v_second_retired_source uuid;
  v_retired_link uuid;
  v_proposal jsonb;
  v_group public.product_parent_proposal_groups%ROWTYPE;
  v_entry jsonb;
  v_group_link public.brand_document_links%ROWTYPE;
  v_source_report public.brand_document_links%ROWTYPE;
  v_group_brand_id uuid;
  v_group_brand_version integer;
  v_original_report_time timestamptz := now() - interval '1 hour';
  v_supplement jsonb := '[{"action":"save","kind":"supplemental","url":"https://manufacturer.example/supplement","state":"MN","expires_on":"2027-11-30"}]';
  v_extra_supplement jsonb := '[{"action":"save","kind":"supplemental","url":"https://manufacturer.example/extra-supplement","state":"IA","expires_on":"2027-11-30"}]';
  v_index integer;
  v_bad_url text;
  v_action text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_staff FROM public.profiles WHERE role <> 'admin' AND is_active ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL OR v_staff IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: need an admin and another active staff role';
  END IF;

  INSERT INTO public.products (id, product_name, sku, category, product_form, inventory_unit, is_active)
  SELECT v_size, '[SMOKE] Brand Documents ' || v_suffix, 'SMOKE-DOC-' || v_suffix, name, 'liquid', 'Gal', true
    FROM public.product_categories WHERE is_active ORDER BY name LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'SMOKE_SETUP: need an active category'; END IF;

  IF has_function_privilege('anon', 'public.change_brand_document_links(uuid,boolean,integer,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.preview_brand_document_links(uuid,boolean,integer,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_brand_document_workspace(boolean,uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._process_brand_document_links(uuid,boolean,integer,jsonb,boolean)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.brand_document_links', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.brand_document_link_events', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: direct document writes are available';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_brand := (public.upsert_product_brand(v_size, '[SMOKE] Brand', NULL, 'Smoke Co', true, NULL, NULL,
                                        NULL, NULL, v_key || ':brand')->>'id')::uuid;

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.change_brand_document_links(v_brand, false, 1, v_save, v_key || ':no-auth');
    RAISE EXCEPTION 'SMOKE_FAIL: no-auth save succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'NOT_AUTHORIZED' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  BEGIN
    PERFORM public.change_brand_document_links(v_brand, false, 1, v_save, v_key || ':staff-save');
    RAISE EXCEPTION 'SMOKE_FAIL: staff edited a document';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'ADMIN_REQUIRED' THEN RAISE; END IF;
  END;
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.preview_brand_document_links(v_brand, false, 1, v_save);
    RAISE EXCEPTION 'SMOKE_FAIL: staff previewed an import';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'ADMIN_REQUIRED' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.get_brand_document_workspace(false);
    RAISE EXCEPTION 'SMOKE_FAIL: staff opened the admin workspace';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'ADMIN_REQUIRED' THEN RAISE; END IF;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SET LOCAL ROLE authenticated;
  IF public.preview_brand_document_links(v_brand, false, 1, v_save) IS DISTINCT FROM '{"success":true}'::jsonb
     OR EXISTS (SELECT 1 FROM public.brand_document_links WHERE legacy_brand_id = v_brand) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: valid preview did not succeed without saving';
  END IF;
  FOREACH v_bad_url IN ARRAY ARRAY['https://user:pass@manufacturer.example/sds', 'https://',
    'https://manufacturer.example:0/sds', 'https://' || repeat('a', 64) || '.example/sds',
    'http://manufacturer.example/sds'] LOOP
    BEGIN
      PERFORM public.preview_brand_document_links(v_brand, false, 1,
        jsonb_set(v_save, '{0,url}', to_jsonb(v_bad_url)));
      RAISE EXCEPTION 'SMOKE_FAIL: an invalid URL passed preview';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'BRAND_DOCUMENT_URL_INVALID%' THEN RAISE; END IF;
    END;
  END LOOP;
  BEGIN
    PERFORM public.preview_brand_document_links(v_brand, false, 1,
      jsonb_set(v_supplement, '{0,state}', '"m1"'));
    RAISE EXCEPTION 'SMOKE_FAIL: invalid state passed preview';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'BRAND_DOCUMENT_INVALID' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.preview_brand_document_links(v_brand, false, 0, v_save);
    RAISE EXCEPTION 'SMOKE_FAIL: a stale brand passed preview';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM NOT LIKE 'BRAND_CHANGED%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.preview_brand_document_links(v_brand, false, 1, v_save || v_save);
    RAISE EXCEPTION 'SMOKE_FAIL: duplicate primary links passed preview';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM NOT LIKE 'BRAND_DOCUMENT_CHANGED%' THEN RAISE; END IF;
  END;
  RESET ROLE;
  BEGIN
    PERFORM public.change_brand_document_links(v_brand, false, 1, v_save ||
      '[{"action":"save","kind":"specimen","url":"https://www.CDMS.net./example"}]'::jsonb, v_key || ':unsafe');
    RAISE EXCEPTION 'SMOKE_FAIL: blocked host accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BRAND_DOCUMENT_URL_BLOCKED%' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.brand_document_links WHERE legacy_brand_id = v_brand) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused save left a document behind';
  END IF;
  BEGIN
    PERFORM public.change_brand_document_links(v_brand, false, 1,
      jsonb_set(v_supplement, '{0,expires_on}', '"infinity"'), v_key || ':invalid-expiry');
    RAISE EXCEPTION 'SMOKE_FAIL: a non-calendar expiry was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'BRAND_DOCUMENT_INVALID' THEN RAISE; END IF;
  END;

  SET LOCAL ROLE authenticated;
  v_payload := public.change_brand_document_links(v_brand, false, 1, v_save, v_key || ':save');
  IF v_payload IS DISTINCT FROM '{"success":true}'::jsonb OR v_payload IS DISTINCT FROM
     public.change_brand_document_links(v_brand, false, 1, v_save, v_key || ':save') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save and replay disagree';
  END IF;
  BEGIN
    PERFORM public.upsert_product_brand(v_size, '[SMOKE] Brand', '99999-7', 'Smoke Co', true, NULL, NULL,
      v_brand, 1, v_key || ':legacy-identity');
    RAISE EXCEPTION 'SMOKE_FAIL: standalone EPA edit kept the previous brand documents';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'BRAND_DOCUMENT_IDENTITY_CHANGED%' THEN RAISE; END IF;
  END;
  RESET ROLE;
  SELECT id INTO STRICT v_link FROM public.brand_document_links
   WHERE legacy_brand_id = v_brand AND url = 'https://manufacturer.example/sds' AND row_version = 1;
  BEGIN
    PERFORM public.preview_brand_document_links(v_brand, false, 1, v_save);
    RAISE EXCEPTION 'SMOKE_FAIL: an insert duplicating a current link passed preview';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM NOT LIKE 'BRAND_DOCUMENT_CHANGED%' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(public.get_brand_document_workspace(false)) b WHERE b->>'id' = v_brand::text
  ) THEN RAISE EXCEPTION 'SMOKE_FAIL: admin workbook missed the saved link'; END IF;
  v_report := jsonb_build_array(jsonb_build_object('action', 'report', 'id', v_link, 'version', 1));

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  SET LOCAL ROLE authenticated;
  IF NOT EXISTS (SELECT 1 FROM public.brand_document_links WHERE id = v_link)
     OR EXISTS (SELECT 1 FROM public.brand_document_link_events WHERE link_id = v_link) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: staff could not read a visible standalone link or could read editor history';
  END IF;
  IF has_column_privilege(current_user, 'public.brand_document_links', 'reported_by', 'SELECT')
     OR has_column_privilege(current_user, 'public.brand_document_links', 'reported_at', 'SELECT') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: staff can read the raw report metadata';
  END IF;
  RESET ROLE;
  BEGIN
    PERFORM public.change_brand_document_links(v_brand, false, 1,
      jsonb_build_array(jsonb_build_object('action', 'report', 'id', v_link, 'version', 1,
        'reason', 'Unexpected free text')), v_key || ':report-with-reason');
    RAISE EXCEPTION 'SMOKE_FAIL: a report accepted an unsupported reason';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'BRAND_DOCUMENT_INVALID' THEN RAISE; END IF;
  END;
  PERFORM public.change_brand_document_links(v_brand, false, 1, v_report, v_key || ':report');
  PERFORM public.change_brand_document_links(v_brand, false, 1, v_report, v_key || ':report');
  IF NOT EXISTS (SELECT 1 FROM public.brand_document_links WHERE id = v_link AND reported_by = v_staff AND row_version = 2) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: staff report lost or repeated';
  END IF;
  BEGIN
    PERFORM public.change_brand_document_links(v_brand, false, 1, v_report, v_key || ':staff-stale-report');
    RAISE EXCEPTION 'SMOKE_FAIL: a stale report succeeded';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM NOT LIKE 'BRAND_DOCUMENT_CHANGED%' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SET LOCAL ROLE authenticated;
  v_payload := public.get_brand_document_workspace(true, ARRAY[v_brand]);
  IF jsonb_array_length(v_payload) <> 1 OR v_payload->0->>'id' IS DISTINCT FROM v_brand::text
     OR v_payload->0->'links'->0->>'reported_by' IS DISTINCT FROM v_staff::text
     OR v_payload->0->'links'->0->>'reported_at' IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated admin could not read the scoped report';
  END IF;
  RESET ROLE;
  FOREACH v_action IN ARRAY ARRAY['hide', 'dismiss'] LOOP
    BEGIN
      PERFORM public.change_brand_document_links(v_brand, false, 1,
        jsonb_build_array(jsonb_build_object('action', v_action, 'id', v_link, 'version', 2, 'reason', E' \t\r\n')),
        v_key || ':no-reason');
      RAISE EXCEPTION 'SMOKE_FAIL: a link action was saved without a reason';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'BRAND_DOCUMENT_REASON_REQUIRED%' THEN RAISE; END IF;
    END;
  END LOOP;
  BEGIN
    PERFORM public.change_brand_document_links(v_brand, false, 1,
      jsonb_build_array(jsonb_build_object('action', 'save', 'kind', 'sds', 'id', v_link,
        'version', 2, 'url', 'https://manufacturer.example/sds-replacement')), v_key || ':replace-reported');
    IF NOT EXISTS (SELECT 1 FROM public.brand_document_links WHERE id = v_link AND reported_at IS NULL
                   AND url = 'https://manufacturer.example/sds-replacement')
       OR (SELECT count(*) FROM public.brand_document_link_events WHERE link_id = v_link) <> 3 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: replacement left the report open or lost its history';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0091', MESSAGE = 'SMOKE_REPLACE_ROLLBACK';
  EXCEPTION WHEN SQLSTATE 'P0091' THEN
    IF SQLERRM <> 'SMOKE_REPLACE_ROLLBACK' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.change_brand_document_links(v_brand, false, 1,
      jsonb_build_array(jsonb_build_object('action', 'hide', 'id', v_link, 'version', 1, 'reason', 'Stale')),
      v_key || ':stale');
    RAISE EXCEPTION 'SMOKE_FAIL: stale hide succeeded';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM NOT LIKE 'BRAND_DOCUMENT_CHANGED%' THEN RAISE; END IF;
  END;
  PERFORM public.change_brand_document_links(v_brand, false, 1,
    jsonb_build_array(jsonb_build_object('action', 'dismiss', 'id', v_link, 'version', 2, 'reason', 'Working link')),
    v_key || ':dismiss');
  PERFORM public.change_brand_document_links(v_brand, false, 1,
    jsonb_build_array(jsonb_build_object('action', 'hide', 'id', v_link, 'version', 3, 'reason', 'Wrong label')),
    v_key || ':hide');
  v_hidden_link := v_link;
  PERFORM public.upsert_product_brand(v_size, '[SMOKE] Brand', '99999-7', 'Smoke Co', true, NULL, NULL,
    v_brand, 1, v_key || ':legacy-identity-after-hide');
  IF NOT EXISTS (SELECT 1 FROM public.brand_document_links WHERE id = v_link AND hidden_at IS NOT NULL
                  AND reported_at IS NULL AND url = 'https://manufacturer.example/sds')
     OR (SELECT count(*) FROM public.brand_document_link_events WHERE link_id = v_link) <> 4
     OR NOT EXISTS (SELECT 1 FROM public.brand_document_link_events WHERE link_id = v_link
                     AND action = 'dismissed' AND reason = 'Working link')
     OR NOT EXISTS (SELECT 1 FROM public.brand_document_link_events WHERE link_id = v_link
                     AND action = 'hidden' AND reason = 'Wrong label' AND before_value->>'url' = 'https://manufacturer.example/sds') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: link or audit history was lost';
  END IF;
  BEGIN
    UPDATE public.brand_document_link_events SET reason = 'Changed later' WHERE link_id = v_link;
    RAISE EXCEPTION 'SMOKE_FAIL: an audit event was editable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'BRAND_DOCUMENT_LINK_EVENTS_ARE_APPEND_ONLY' THEN RAISE; END IF;
  END;

  -- The real grouping approval rolls the whole group back on conflicting documents.
  FOR v_index IN 1..2 LOOP
    INSERT INTO public.products (id, product_name, sku, category, epa_registration, product_form, inventory_unit,
                                 is_active, container_size, container_unit)
    SELECT v_sizes[v_index], '[SMOKE] Link Group ' || v_group_tag || ' ' || v_index || ' gal',
           'SMOKE-LINK-GROUP-' || v_group_tag || '-' || v_index, name, v_epa, 'liquid', 'Gal', true, v_index, 'Gal'
      FROM public.product_categories WHERE is_active ORDER BY name LIMIT 1;
    v_brands := array_append(v_brands, (public.upsert_product_brand(v_sizes[v_index], '[SMOKE] Group Brand',
      v_epa, 'Smoke Co', v_index = 1, NULL, NULL, NULL, NULL, v_key || ':groupbrand:' || v_index)->>'id')::uuid);
    PERFORM public.change_brand_document_links(v_brands[v_index], false, 1,
      jsonb_build_array(jsonb_build_object('action', 'save', 'kind', 'sds',
        'url', 'https://manufacturer.example/group-' || v_index)), v_key || ':grouplink:' || v_index);
  END LOOP;
  v_retired_source := (public.upsert_product_brand(v_sizes[2], '[SMOKE] Separate Brand',
    v_epa, 'Other Smoke Co', false, NULL, NULL, NULL, NULL, v_key || ':retired-brand')->>'id')::uuid;
  PERFORM public.change_brand_document_links(v_retired_source, false, 1,
    '[{"action":"save","kind":"sds","url":"https://manufacturer.example/retired-sds"}]'::jsonb, v_key || ':retired-link');
  v_second_retired_source := (public.upsert_product_brand(v_sizes[1], '[SMOKE] Separate Brand',
    v_epa, 'Other Smoke Co', false, NULL, NULL, NULL, NULL, v_key || ':second-retired-brand')->>'id')::uuid;
  BEGIN
    PERFORM public.change_brand_document_links(v_brands[1], false, 0, v_save, v_key || ':stale-brand');
    RAISE EXCEPTION 'SMOKE_FAIL: a stale brand version edited a document';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM NOT LIKE 'BRAND_CHANGED%' THEN RAISE; END IF;
  END;
  SELECT id INTO STRICT v_link FROM public.brand_document_links WHERE legacy_brand_id = v_brands[1] AND document_kind = 'sds';
  BEGIN
    PERFORM public.change_brand_document_links(v_brands[2], false, 1,
      jsonb_build_array(jsonb_build_object('action', 'report', 'id', v_link, 'version', 1)), v_key || ':wrong-brand');
    RAISE EXCEPTION 'SMOKE_FAIL: a brand accepted another brand''s document';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM NOT LIKE 'BRAND_DOCUMENT_CHANGED%' THEN RAISE; END IF;
  END;
  v_proposal := public.build_product_parent_proposal(v_key || ':proposal');
  SELECT g.* INTO STRICT v_group FROM public.product_parent_proposal_groups g
   WHERE g.proposal_id = (v_proposal->>'proposal_id')::uuid
     AND g.members @> jsonb_build_array(jsonb_build_object('product_id', v_sizes[1]), jsonb_build_object('product_id', v_sizes[2]));
  v_entry := jsonb_build_object('group_id', v_group.id, 'group_fingerprint', v_group.group_fingerprint, 'name', v_group.suggested_name,
    'brands', jsonb_build_object(
      '[smoke] group brand', jsonb_build_object('keep', true, 'source_brand_id', v_brands[1]),
      '[smoke] separate brand', jsonb_build_object('keep', false)));
  BEGIN
    PERFORM public.approve_product_parent_groups((v_proposal->>'proposal_id')::uuid,
      (v_proposal->>'proposal_version')::bigint, jsonb_build_array(v_entry), v_key || ':conflict');
    SET CONSTRAINTS public.carry_grouped_brand_document_links IMMEDIATE;
    RAISE EXCEPTION 'SMOKE_FAIL: grouping accepted conflicting links';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BRAND_DOCUMENT_GROUP_CONFLICT%' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.product_parent_members WHERE product_id = ANY(v_sizes)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: conflicting grouping left a member behind';
  END IF;

  SELECT * INTO STRICT v_group_link FROM public.brand_document_links WHERE legacy_brand_id = v_brands[2];
  -- Try the same real approval with only one linked source, then rewind the
  -- fixture so the matching-link and report case can use both original sources.
  BEGIN
    PERFORM public.change_brand_document_links(v_brands[2], false, 1,
      jsonb_build_array(jsonb_build_object('action', 'hide', 'id', v_group_link.id,
        'version', v_group_link.row_version, 'reason', 'Wrong source')), v_key || ':single-source-hide');
    BEGIN
      PERFORM public.change_brand_document_links(v_second_retired_source, false, 1, v_save, v_key || ':conflicting-retired-link');
      PERFORM public.approve_product_parent_groups((v_proposal->>'proposal_id')::uuid,
        (v_proposal->>'proposal_version')::bigint, jsonb_build_array(v_entry), v_key || ':retired-conflict');
      SET CONSTRAINTS public.carry_grouped_brand_document_links IMMEDIATE;
      RAISE EXCEPTION 'SMOKE_FAIL: conflicting links on the same retired variant passed grouping';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'BRAND_DOCUMENT_GROUP_CONFLICT%Separate Brand%' THEN RAISE; END IF;
    END;
    v_payload := public.approve_product_parent_groups((v_proposal->>'proposal_id')::uuid,
      (v_proposal->>'proposal_version')::bigint, jsonb_build_array(v_entry), v_key || ':single-source');
    SET CONSTRAINTS public.carry_grouped_brand_document_links IMMEDIATE;
    v_parent := (v_payload->'groups'->0->>'parent_id')::uuid;
    IF (SELECT array_agg(l.url) FROM public.brand_document_links l
          JOIN public.product_parent_brands b ON b.id = l.parent_brand_id
         WHERE b.parent_id = v_parent AND b.status = 'active'
           AND l.document_kind = 'sds' AND l.hidden_at IS NULL)
       IS DISTINCT FROM ARRAY['https://manufacturer.example/group-1']::text[] THEN
      RAISE EXCEPTION 'SMOKE_FAIL: single-source grouping lost or duplicated the visible SDS';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0091', MESSAGE = 'SMOKE_SINGLE_SOURCE_ROLLBACK';
  EXCEPTION WHEN SQLSTATE 'P0091' THEN
    IF SQLERRM <> 'SMOKE_SINGLE_SOURCE_ROLLBACK' THEN RAISE; END IF;
  END;
  FOR v_index IN 1..2 LOOP
    PERFORM public.change_brand_document_links(v_brands[v_index], false, 1, v_supplement, v_key || ':supplement:' || v_index);
  END LOOP;
  PERFORM public.change_brand_document_links(v_brands[2], false, 1, v_extra_supplement, v_key || ':extra-supplement');
  PERFORM public.change_brand_document_links(v_brands[2], false, 1,
    jsonb_build_array(jsonb_build_object('action', 'save', 'kind', 'sds', 'id', v_group_link.id,
      'version', v_group_link.row_version, 'url', 'https://manufacturer.example/group-1')), v_key || ':reconciled');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.change_brand_document_links(v_brands[2], false, 1,
    jsonb_build_array(jsonb_build_object('action', 'report', 'id', v_group_link.id, 'version', 2)), v_key || ':group-report');
  RESET ROLE;
  -- Give the original report a different time from the synthetic move transaction.
  UPDATE public.brand_document_links SET reported_at = v_original_report_time WHERE id = v_group_link.id;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_payload := public.approve_product_parent_groups((v_proposal->>'proposal_id')::uuid,
    (v_proposal->>'proposal_version')::bigint, jsonb_build_array(v_entry), v_key || ':approved');
  SET CONSTRAINTS public.carry_grouped_brand_document_links IMMEDIATE;
  v_parent := (v_payload->'groups'->0->>'parent_id')::uuid;
  BEGIN
    PERFORM public.change_brand_document_links(v_brands[1], false, 1, v_save, v_key || ':grouped-legacy-brand');
    RAISE EXCEPTION 'SMOKE_FAIL: a grouped legacy brand accepted a document save';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM NOT LIKE 'BRAND_CHANGED%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.brand_document_links l JOIN public.product_parent_brands b ON b.id = l.parent_brand_id
        WHERE b.parent_id = v_parent AND b.status = 'active' AND l.url = 'https://manufacturer.example/group-1'
          AND l.reported_at = v_original_report_time AND l.reported_by = v_staff) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.brand_document_links WHERE id = v_group_link.id AND reported_at IS NULL) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: grouping lost or duplicated the document report';
  END IF;
  IF (SELECT array_agg(l.url ORDER BY l.url) FROM public.brand_document_links l
        JOIN public.product_parent_brands b ON b.id = l.parent_brand_id
       WHERE b.parent_id = v_parent AND b.status = 'active' AND l.hidden_at IS NULL AND l.document_kind = 'supplemental')
     IS DISTINCT FROM ARRAY['https://manufacturer.example/extra-supplement', 'https://manufacturer.example/supplement']::text[] THEN
    RAISE EXCEPTION 'SMOKE_FAIL: grouping lost or duplicated a matching supplemental link';
  END IF;
  SELECT l.id INTO STRICT v_retired_link FROM public.brand_document_links l
    JOIN public.product_parent_brands b ON b.id = l.parent_brand_id
    JOIN public.product_parent_brand_sources s ON s.parent_brand_id = b.id
   WHERE b.parent_id = v_parent AND b.status = 'retired' AND s.legacy_brand_id = v_retired_source
     AND l.url = 'https://manufacturer.example/retired-sds';
  SELECT b.id, b.row_version INTO STRICT v_group_brand_id, v_group_brand_version FROM public.product_parent_brands b
   WHERE b.parent_id = v_parent AND b.status = 'active';
  SELECT l.* INTO STRICT v_source_report FROM public.brand_document_links l
   WHERE l.parent_brand_id = v_group_brand_id AND l.document_kind = 'sds' AND l.reported_by = v_staff;
  IF NOT EXISTS (SELECT 1 FROM public.brand_document_link_events e WHERE e.link_id = v_source_report.id
                  AND e.action = 'carried' AND e.changed_by = v_admin AND e.reason = 'Copied from link ' || v_group_link.id)
     OR NOT EXISTS (SELECT 1 FROM public.brand_document_link_events e WHERE e.link_id = v_group_link.id
                     AND e.action = 'carried' AND e.changed_by = v_admin
                     AND e.reason = 'Report moved to link ' || v_source_report.id
                     AND e.before_value->>'reported_by' = v_staff::text
                     AND (e.before_value->>'reported_at')::timestamptz = v_original_report_time) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: grouping did not preserve report transfer history';
  END IF;
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.upsert_parent_brand(v_parent, v_sizes[1], '[SMOKE] Group Brand', '99999-7', 'Smoke Co', true,
      NULL, NULL, v_group_brand_id, v_group_brand_version, false, NULL, v_key || ':parent-identity');
    RAISE EXCEPTION 'SMOKE_FAIL: grouped EPA edit kept the previous brand documents';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'BRAND_DOCUMENT_IDENTITY_CHANGED%' THEN RAISE; END IF;
  END;
  RESET ROLE;

  INSERT INTO public.product_parents
    (name, product_form, generic_epa_registration, category, rate_per_acre, rate_unit, suggested_rate, created_by, updated_by)
  SELECT '[SMOKE] Move Target ' || v_group_tag, product_form, generic_epa_registration, category,
         rate_per_acre, rate_unit, suggested_rate, v_admin, v_admin
    FROM public.product_parents WHERE id = v_parent RETURNING id INTO v_move_target;
  INSERT INTO public.product_parent_brands
    (parent_id, brand_name, epa_registration, manufacturer, is_currently_sourced, is_rup, signal_word, created_by, updated_by)
  SELECT v_move_target, brand_name, epa_registration, manufacturer, is_currently_sourced, is_rup, signal_word, v_admin, v_admin
    FROM public.product_parent_brands WHERE parent_id = v_parent AND status = 'active' RETURNING id INTO v_move_brand;
  PERFORM public.change_brand_document_links(v_move_brand, true, 1,
    '[{"action":"save","kind":"sds","url":"https://manufacturer.example/different-sds"}]'::jsonb ||
      v_supplement || v_extra_supplement, v_key || ':target');
  v_payload := public.preview_move_product_size(v_sizes[1], v_move_target);
  IF coalesce(v_payload->>'refusal', '') NOT LIKE 'BRAND_DOCUMENT_MOVE_CONFLICT%sds links for%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: move preview did not name the different document: %', v_payload->>'refusal';
  END IF;
  BEGIN
    PERFORM public.move_product_size(v_sizes[1], v_move_target, (v_payload->>'from_parent_version')::bigint,
      (v_payload->>'to_parent_version')::bigint, v_payload->>'size_fingerprint', 'Test a move with different links',
      'Compared the two groups and their manufacturer documents', '{}'::jsonb, v_key || ':move');
    RAISE EXCEPTION 'SMOKE_FAIL: move accepted differing links';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BRAND_DOCUMENT_MOVE_CONFLICT%' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.product_parent_members WHERE product_id = v_sizes[1] AND parent_id = v_parent) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: refused move changed the product group';
  END IF;
  SELECT id INTO STRICT v_link FROM public.brand_document_links WHERE parent_brand_id = v_move_brand AND document_kind = 'sds';
  PERFORM public.change_brand_document_links(v_move_brand, true, 1,
    jsonb_build_array(jsonb_build_object('action', 'save', 'kind', 'sds', 'id', v_link,
      'version', 1, 'url', 'https://manufacturer.example/group-1')), v_key || ':target-reconciled');
  v_payload := public.preview_move_product_size(v_sizes[1], v_move_target);
  IF v_payload->>'refusal' IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: move preview refused matching links: %', v_payload->>'refusal';
  END IF;
  PERFORM public.move_product_size(v_sizes[1], v_move_target, (v_payload->>'from_parent_version')::bigint,
    (v_payload->>'to_parent_version')::bigint, v_payload->>'size_fingerprint', 'Test a move with matching links',
    'Compared the two groups and their manufacturer documents', v_payload->'prices', v_key || ':move-matching');
  IF NOT EXISTS (SELECT 1 FROM public.product_parent_members WHERE product_id = v_sizes[1] AND parent_id = v_move_target) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: matching links blocked the ordinary move';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.brand_document_links WHERE id = v_source_report.id AND reported_by = v_staff)
     OR EXISTS (SELECT 1 FROM public.brand_document_links WHERE id = v_link AND reported_at IS NOT NULL) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a move with sizes remaining transferred the report';
  END IF;
  v_payload := public.preview_move_product_size(v_sizes[2], v_move_target);
  PERFORM public.move_product_size(v_sizes[2], v_move_target, (v_payload->>'from_parent_version')::bigint,
    (v_payload->>'to_parent_version')::bigint, v_payload->>'size_fingerprint', 'Test a move with matching links',
    'Compared the two groups and their manufacturer documents', v_payload->'prices', v_key || ':move-last');
  IF NOT EXISTS (SELECT 1 FROM public.brand_document_links WHERE id = v_link AND reported_by = v_source_report.reported_by
                  AND reported_at = v_source_report.reported_at AND row_version = 3)
     OR EXISTS (SELECT 1 FROM public.brand_document_links WHERE id = v_source_report.id AND reported_at IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM public.brand_document_link_events WHERE link_id = v_link AND action = 'carried'
                     AND changed_by = v_admin AND reason = 'Report moved from link ' || v_source_report.id)
     OR NOT EXISTS (SELECT 1 FROM public.brand_document_link_events e WHERE e.link_id = v_source_report.id
                     AND e.action = 'carried' AND e.changed_by = v_admin AND e.reason = 'Report moved to link ' || v_link
                     AND e.before_value->>'reported_by' = v_staff::text
                     AND (e.before_value->>'reported_at')::timestamptz = v_original_report_time)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.get_brand_document_workspace(true)) b
                     WHERE b->>'id' = v_move_brand::text AND b->'links' @> jsonb_build_array(jsonb_build_object('id', v_link))) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the last size move lost a broken-link report';
  END IF;
  PERFORM public.change_brand_document_links(v_move_brand, true, 1,
    jsonb_build_array(jsonb_build_object('action', 'dismiss', 'id', v_link, 'version', 3, 'reason', 'Test staff report')),
    v_key || ':dismiss-moved-report');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM public.change_brand_document_links(v_move_brand, true, 1,
    jsonb_build_array(jsonb_build_object('action', 'report', 'id', v_link, 'version', 4)), v_key || ':parent-report');
  IF NOT EXISTS (SELECT 1 FROM public.brand_document_links WHERE id = v_link AND reported_by = v_staff) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: grouped staff report was lost';
  END IF;
  SET LOCAL ROLE authenticated;
  IF NOT EXISTS (SELECT 1 FROM public.brand_document_links WHERE id = v_link)
     OR EXISTS (SELECT 1 FROM public.brand_document_links
                 WHERE id IN (v_hidden_link, v_retired_link) OR legacy_brand_id = ANY(v_brands))
     OR EXISTS (SELECT 1 FROM public.brand_document_link_events WHERE link_id = v_link) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: staff did not see the effective grouped link or saw a hidden or historical link';
  END IF;
  RESET ROLE;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
