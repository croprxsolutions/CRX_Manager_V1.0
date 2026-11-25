-- Manufacturer document links for standalone and grouped brands. Existing EPA links
-- and brand metadata keep their own lifecycle. Writes and history are atomic.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('public._product_size_move_refusal(uuid,uuid)')
      AND md5(replace(p.prosrc, chr(13), '')) = '12ca9e0df00ca7f35cc8da321090a0e3'
      AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']
      AND p.proowner = 'postgres'::regrole
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_BRAND_DOCUMENT_MOVE_HELPER_CHANGED';
  END IF;
END;
$preflight$;

CREATE TABLE public.brand_document_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_brand_id uuid REFERENCES public.product_brands(id) ON DELETE RESTRICT,
  parent_brand_id uuid REFERENCES public.product_parent_brands(id) ON DELETE RESTRICT,
  document_kind text NOT NULL CHECK (document_kind IN ('specimen', 'sds', 'supplemental')),
  url text NOT NULL,
  state_code text,
  expires_on date,
  row_version bigint NOT NULL DEFAULT 1,
  hidden_at timestamptz,
  reported_at timestamptz,
  reported_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(legacy_brand_id, parent_brand_id) = 1),
  CHECK (CASE WHEN document_kind = 'supplemental'
              THEN state_code IS NOT NULL AND state_code ~ '^[A-Z]{2}$' AND expires_on IS NOT NULL
              ELSE state_code IS NULL AND expires_on IS NULL END),
  CHECK ((reported_at IS NULL) = (reported_by IS NULL))
);

CREATE INDEX brand_document_links_legacy ON public.brand_document_links (legacy_brand_id)
  WHERE legacy_brand_id IS NOT NULL;
CREATE INDEX brand_document_links_parent ON public.brand_document_links (parent_brand_id)
  WHERE parent_brand_id IS NOT NULL;
CREATE UNIQUE INDEX brand_document_links_one_primary ON public.brand_document_links
  (legacy_brand_id, parent_brand_id, document_kind) NULLS NOT DISTINCT
  WHERE hidden_at IS NULL AND document_kind IN ('specimen', 'sds');
CREATE UNIQUE INDEX brand_document_links_one_supplemental ON public.brand_document_links
  (legacy_brand_id, parent_brand_id, url, state_code, expires_on) NULLS NOT DISTINCT
  WHERE hidden_at IS NULL AND document_kind = 'supplemental';

CREATE TRIGGER set_brand_document_links_updated_at
  BEFORE UPDATE ON public.brand_document_links
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE public.brand_document_link_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.brand_document_links(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('saved', 'reported', 'hidden', 'dismissed', 'carried')),
  changed_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reason text,
  before_value jsonb,
  after_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX brand_document_link_events_link ON public.brand_document_link_events (link_id, created_at DESC);
CREATE FUNCTION public.refuse_brand_document_link_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'BRAND_DOCUMENT_LINK_EVENTS_ARE_APPEND_ONLY';
END;
$function$;
ALTER FUNCTION public.refuse_brand_document_link_event_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_brand_document_link_event_mutation()
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER brand_document_link_events_append_only
  BEFORE UPDATE OR DELETE ON public.brand_document_link_events
  FOR EACH ROW EXECUTE FUNCTION public.refuse_brand_document_link_event_mutation();
CREATE TRIGGER brand_document_link_events_no_truncate
  BEFORE TRUNCATE ON public.brand_document_link_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_brand_document_link_event_mutation();

ALTER TABLE public.brand_document_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_document_link_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY brand_document_links_select ON public.brand_document_links
  FOR SELECT TO authenticated USING (
    (SELECT public.is_admin()) OR (
      (SELECT public.is_active_profile()) AND hidden_at IS NULL AND (
        EXISTS (SELECT 1 FROM public.product_parent_brands b
                JOIN public.product_parents p ON p.id = b.parent_id
                WHERE b.id = parent_brand_id AND b.status = 'active' AND p.is_active)
        OR EXISTS (SELECT 1 FROM public.product_brands b
                   WHERE b.id = legacy_brand_id AND NOT EXISTS (
                     SELECT 1 FROM public.product_parent_members m WHERE m.product_id = b.product_id
                   ))
      )
    )
  );
CREATE POLICY brand_document_link_events_select ON public.brand_document_link_events
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
REVOKE ALL ON public.brand_document_links, public.brand_document_link_events
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT (id, legacy_brand_id, parent_brand_id, document_kind, url, state_code, expires_on, row_version, hidden_at)
  ON public.brand_document_links TO authenticated;
GRANT SELECT ON public.brand_document_link_events TO authenticated;

-- A brand ID survives edits, but its documents may belong to the previous identity.
CREATE FUNCTION public.refuse_brand_identity_with_documents() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF (lower(btrim(NEW.brand_name)), public._normalize_epa_registration(NEW.epa_registration), lower(btrim(NEW.manufacturer)))
     IS DISTINCT FROM
     (lower(btrim(OLD.brand_name)), public._normalize_epa_registration(OLD.epa_registration), lower(btrim(OLD.manufacturer)))
     AND EXISTS (
       SELECT 1 FROM public.brand_document_links WHERE hidden_at IS NULL AND
         CASE WHEN TG_TABLE_NAME = 'product_parent_brands' THEN parent_brand_id = OLD.id ELSE legacy_brand_id = OLD.id END
     ) THEN
    RAISE EXCEPTION 'BRAND_DOCUMENT_IDENTITY_CHANGED: hide the old document links before changing the brand identity';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.refuse_brand_identity_with_documents() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_brand_identity_with_documents()
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER refuse_legacy_brand_identity_with_documents
  BEFORE UPDATE OF brand_name, epa_registration, manufacturer ON public.product_brands
  FOR EACH ROW EXECUTE FUNCTION public.refuse_brand_identity_with_documents();
CREATE TRIGGER refuse_parent_brand_identity_with_documents
  BEFORE UPDATE OF brand_name, epa_registration, manufacturer ON public.product_parent_brands
  FOR EACH ROW EXECUTE FUNCTION public.refuse_brand_identity_with_documents();

CREATE FUNCTION public._normalize_brand_document_url(p_url text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_url text := btrim(p_url);
  v_parts text[];
  v_host text;
BEGIN
  IF v_url IS NULL OR octet_length(v_url) > 2048 OR v_url ~ '[[:space:][:cntrl:]]'
     OR strpos(v_url, chr(92)) > 0 THEN
    RAISE EXCEPTION 'BRAND_DOCUMENT_URL_INVALID: enter an HTTPS document link';
  END IF;
  v_parts := regexp_match(v_url, '(?i)^https://([a-z0-9.-]+)(?::([0-9]{1,5}))?([/?#].*)?$');
  v_host := lower(rtrim(v_parts[1], '.'));
  IF v_parts IS NULL OR length(v_host) > 253 OR v_host ~ '(^|\.)[^.]{64}'
     OR v_host !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
     OR right(v_parts[1], 2) = '..' OR v_parts[2]::integer NOT BETWEEN 1 AND 65535 THEN
    RAISE EXCEPTION 'BRAND_DOCUMENT_URL_INVALID: enter an HTTPS document link';
  END IF;
  IF v_host ~ '(^|\.)(cdms\.net|greenbook\.net)$' THEN
    RAISE EXCEPTION 'BRAND_DOCUMENT_URL_BLOCKED: use a manufacturer link instead of CDMS or Greenbook';
  END IF;
  RETURN 'https://' || v_host ||
         CASE WHEN v_parts[2]::integer = 443 OR v_parts[2] IS NULL THEN '' ELSE ':' || v_parts[2]::integer END ||
         CASE WHEN coalesce(v_parts[3], '') ~ '^/' THEN v_parts[3] ELSE '/' || coalesce(v_parts[3], '') END;
END;
$function$;
ALTER FUNCTION public._normalize_brand_document_url(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._normalize_brand_document_url(text)
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- The app can read the tables but cannot write into them or invent the history actor.
-- Preview and save share validation. Only save takes locks and writes receipts or links.
CREATE FUNCTION public._process_brand_document_links(
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
            reported_at = NULL, reported_by = NULL, row_version = row_version + 1
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

ALTER FUNCTION public._process_brand_document_links(uuid, boolean, integer, jsonb, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._process_brand_document_links(uuid, boolean, integer, jsonb, boolean)
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE FUNCTION public.change_brand_document_links(
  p_brand_id uuid, p_parent_brand boolean, p_brand_version integer, p_changes jsonb,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_intent jsonb := jsonb_build_array(v_actor, p_brand_id, p_parent_brand, p_brand_version, p_changes);
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR NOT public.is_active_profile() THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  v_existing := public.check_idempotency(p_idempotency_key, 'change_brand_document_links');
  IF v_existing IS NOT NULL THEN
    IF v_existing->'intent' IS DISTINCT FROM v_intent THEN
      RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH';
    END IF;
    IF NOT public.is_admin() AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_changes) c WHERE c->>'action' IS DISTINCT FROM 'report'
    ) THEN
      RAISE EXCEPTION 'ADMIN_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RETURN v_existing->'response';
  END IF;
  v_result := public._process_brand_document_links(p_brand_id, p_parent_brand, p_brand_version, p_changes, false);
  PERFORM public.save_idempotency(p_idempotency_key, 'change_brand_document_links',
    jsonb_build_object('intent', v_intent, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.change_brand_document_links(uuid, boolean, integer, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.change_brand_document_links(uuid, boolean, integer, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.change_brand_document_links(uuid, boolean, integer, jsonb, text) TO authenticated;

CREATE FUNCTION public.preview_brand_document_links(
  p_brand_id uuid, p_parent_brand boolean, p_brand_version integer, p_changes jsonb
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT public._process_brand_document_links(p_brand_id, p_parent_brand, p_brand_version, p_changes, true);
$function$;
ALTER FUNCTION public.preview_brand_document_links(uuid, boolean, integer, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_brand_document_links(uuid, boolean, integer, jsonb)
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.preview_brand_document_links(uuid, boolean, integer, jsonb) TO authenticated;

-- Admin brand detail, workbook and fix list share one read with report metadata.
CREATE FUNCTION public.get_brand_document_workspace(
  p_reported_only boolean DEFAULT false, p_brand_ids uuid[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  RETURN (
    WITH brands AS (
      SELECT b.id, false AS parent_brand, b.row_version AS brand_version,
             b.brand_name, p.id AS product_id, p.product_name AS owner_name
        FROM public.product_brands b JOIN public.products p ON p.id = b.product_id
       WHERE (p_brand_ids IS NULL OR b.id = ANY(p_brand_ids))
         AND NOT EXISTS (SELECT 1 FROM public.product_parent_members m WHERE m.product_id = b.product_id)
      UNION ALL
      SELECT b.id, true, b.row_version, b.brand_name, m.product_id, p.name
        FROM public.product_parent_brands b JOIN public.product_parents p ON p.id = b.parent_id
        JOIN LATERAL (
          SELECT m.product_id FROM public.product_parent_members m
           WHERE m.parent_id = p.id ORDER BY m.product_id LIMIT 1
        ) m ON true
       WHERE (p_brand_ids IS NULL OR b.id = ANY(p_brand_ids)) AND b.status = 'active' AND p.is_active
    ), entries AS (
      SELECT b.*, coalesce(d.links, '[]'::jsonb) AS links
        FROM brands b
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(to_jsonb(l) ORDER BY l.document_kind, l.state_code, l.expires_on, l.id) AS links
            FROM public.brand_document_links l
           WHERE CASE WHEN b.parent_brand THEN l.parent_brand_id = b.id ELSE l.legacy_brand_id = b.id END
             AND l.hidden_at IS NULL AND (NOT p_reported_only OR l.reported_at IS NOT NULL)
        ) d ON true
       WHERE NOT p_reported_only OR d.links IS NOT NULL
    )
    SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.owner_name, e.brand_name, e.id), '[]'::jsonb)
      FROM entries e
  );
END;
$function$;

ALTER FUNCTION public.get_brand_document_workspace(boolean, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_brand_document_workspace(boolean, uuid[])
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.get_brand_document_workspace(boolean, uuid[]) TO authenticated;

-- A grouping writes the legacy-to-parent map while it holds the original size
-- locks. After it has picked every active variant, use those proven identities.
CREATE FUNCTION public.carry_grouped_brand_document_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_mapped public.product_parent_brands%ROWTYPE;
  v_target_id uuid;
  v_source public.brand_document_links%ROWTYPE;
  v_target public.brand_document_links%ROWTYPE;
  v_before jsonb;
BEGIN
  SELECT * INTO STRICT v_mapped FROM public.product_parent_brands WHERE id = NEW.parent_brand_id;
  v_target_id := v_mapped.id;
  IF v_mapped.status <> 'active' AND v_mapped.epa_registration IS NOT NULL AND v_mapped.manufacturer IS NOT NULL THEN
    SELECT id INTO v_target_id FROM public.product_parent_brands
     WHERE parent_id = v_mapped.parent_id AND status = 'active' AND lower(brand_name) = lower(v_mapped.brand_name)
       AND epa_registration = v_mapped.epa_registration AND lower(manufacturer) = lower(v_mapped.manufacturer);
    v_target_id := coalesce(v_target_id, v_mapped.id);
  END IF;

  FOR v_source IN SELECT * FROM public.brand_document_links
    WHERE legacy_brand_id = NEW.legacy_brand_id AND hidden_at IS NULL ORDER BY id FOR UPDATE
  LOOP
    SELECT * INTO v_target FROM public.brand_document_links
     WHERE parent_brand_id = v_target_id AND hidden_at IS NULL AND document_kind = v_source.document_kind
       AND (document_kind <> 'supplemental' OR
            (url, state_code, expires_on) = (v_source.url, v_source.state_code, v_source.expires_on))
     FOR UPDATE;
    IF FOUND AND v_target.url IS DISTINCT FROM v_source.url THEN
      RAISE EXCEPTION 'BRAND_DOCUMENT_GROUP_CONFLICT: % has different % links for %; reconcile the links before grouping',
        (SELECT name FROM public.product_parents WHERE id = v_mapped.parent_id),
        v_source.document_kind, v_mapped.brand_name;
    END IF;

    v_before := NULL;
    IF NOT FOUND THEN
      INSERT INTO public.brand_document_links
        (parent_brand_id, document_kind, url, state_code, expires_on, reported_at, reported_by)
      VALUES (v_target_id, v_source.document_kind, v_source.url, v_source.state_code, v_source.expires_on,
              v_source.reported_at, v_source.reported_by)
      RETURNING * INTO v_target;
    ELSE
      v_before := to_jsonb(v_target);
      IF v_target.reported_at IS NULL AND v_source.reported_at IS NOT NULL THEN
        UPDATE public.brand_document_links SET reported_at = v_source.reported_at,
            reported_by = v_source.reported_by, row_version = row_version + 1
         WHERE id = v_target.id RETURNING * INTO v_target;
      END IF;
    END IF;
    INSERT INTO public.brand_document_link_events (link_id, action, changed_by, reason, before_value, after_value)
      VALUES (v_target.id, 'carried', NEW.mapped_by, 'Copied from link ' || v_source.id, v_before, to_jsonb(v_target));

    IF v_source.reported_at IS NOT NULL THEN
      v_before := to_jsonb(v_source);
      UPDATE public.brand_document_links SET reported_at = NULL, reported_by = NULL, row_version = row_version + 1
       WHERE id = v_source.id RETURNING * INTO v_source;
      INSERT INTO public.brand_document_link_events (link_id, action, changed_by, reason, before_value, after_value)
        VALUES (v_source.id, 'carried', NEW.mapped_by, 'Report moved to link ' || v_target.id, v_before, to_jsonb(v_source));
    END IF;
  END LOOP;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.carry_grouped_brand_document_links() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.carry_grouped_brand_document_links()
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE CONSTRAINT TRIGGER carry_grouped_brand_document_links
  AFTER INSERT ON public.product_parent_brand_sources DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.carry_grouped_brand_document_links();

-- The move RPC holds both parents and has already checked that their links agree.
-- This runs before it retires the emptied parent's brands.
CREATE FUNCTION public.carry_last_size_document_reports() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_pair record;
  v_actor uuid;
  v_after jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.product_parent_members WHERE parent_id = OLD.parent_id) THEN
    RETURN NULL;
  END IF;
  FOR v_pair IN
    SELECT s.id AS source_id, t.id AS target_id, s.reported_at, s.reported_by,
           t.reported_at AS target_reported_at, to_jsonb(s) AS source_before, to_jsonb(t) AS target_before
      FROM public.product_parent_brands a
      JOIN public.product_parent_brands b ON b.parent_id = NEW.parent_id AND b.status = 'active'
                                         AND lower(b.brand_name) = lower(a.brand_name)
      JOIN public.brand_document_links s ON s.parent_brand_id = a.id AND s.hidden_at IS NULL AND s.reported_at IS NOT NULL
      JOIN public.brand_document_links t ON t.parent_brand_id = b.id AND t.hidden_at IS NULL
                                       AND (t.document_kind, t.url) = (s.document_kind, s.url)
                                       AND (t.state_code, t.expires_on) IS NOT DISTINCT FROM (s.state_code, s.expires_on)
     WHERE a.parent_id = OLD.parent_id AND a.status = 'active'
     ORDER BY s.id
  LOOP
    v_actor := public._product_parent_require_admin();
    IF v_pair.target_reported_at IS NULL THEN
      UPDATE public.brand_document_links t
         SET reported_at = v_pair.reported_at, reported_by = v_pair.reported_by, row_version = row_version + 1
       WHERE id = v_pair.target_id RETURNING to_jsonb(t) INTO v_after;
      INSERT INTO public.brand_document_link_events (link_id, action, changed_by, reason, before_value, after_value)
      VALUES (v_pair.target_id, 'carried', v_actor, 'Report moved from link ' || v_pair.source_id, v_pair.target_before, v_after);
    END IF;
    UPDATE public.brand_document_links s SET reported_at = NULL, reported_by = NULL, row_version = row_version + 1
     WHERE id = v_pair.source_id RETURNING to_jsonb(s) INTO v_after;
    INSERT INTO public.brand_document_link_events (link_id, action, changed_by, reason, before_value, after_value)
    VALUES (v_pair.source_id, 'carried', v_actor, 'Report moved to link ' || v_pair.target_id, v_pair.source_before, v_after);
  END LOOP;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.carry_last_size_document_reports() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.carry_last_size_document_reports()
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER carry_last_size_document_reports
  AFTER UPDATE OF parent_id ON public.product_parent_members
  FOR EACH ROW WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id)
  EXECUTE FUNCTION public.carry_last_size_document_reports();

-- Compare effective links on corresponding active brands after the existing move
-- checks have confirmed matching brand records. Both move and preview use this.
CREATE FUNCTION public._brand_document_move_refusal(p_from_parent_id uuid, p_to_parent_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $function$
  SELECT 'BRAND_DOCUMENT_MOVE_CONFLICT: reconcile the ' ||
         string_agg(d.document_kind || ' links for ' || d.brand_name, ', ' ORDER BY d.brand_name, d.document_kind)
         || ' before moving this size'
    FROM (
      SELECT l.brand_name, k.document_kind
        FROM public.product_parent_brands l
        JOIN public.product_parent_brands r ON r.parent_id = p_to_parent_id AND r.status = 'active'
                                           AND lower(r.brand_name) = lower(l.brand_name)
        CROSS JOIN (VALUES ('specimen'), ('sds'), ('supplemental')) k(document_kind)
       WHERE l.parent_id = p_from_parent_id AND l.status = 'active'
         AND (SELECT jsonb_agg(jsonb_build_array(d.url, d.state_code, d.expires_on)
                              ORDER BY d.url, d.state_code, d.expires_on)
                FROM public.brand_document_links d
               WHERE d.parent_brand_id = l.id AND d.hidden_at IS NULL AND d.document_kind = k.document_kind)
            IS DISTINCT FROM
             (SELECT jsonb_agg(jsonb_build_array(d.url, d.state_code, d.expires_on)
                               ORDER BY d.url, d.state_code, d.expires_on)
                FROM public.brand_document_links d
               WHERE d.parent_brand_id = r.id AND d.hidden_at IS NULL AND d.document_kind = k.document_kind)
    ) d;
$function$;

ALTER FUNCTION public._brand_document_move_refusal(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._brand_document_move_refusal(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Keep the existing move preflight and extend its final check to document links.
CREATE OR REPLACE FUNCTION public._product_size_move_refusal(p_product_id uuid, p_to_parent_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_member public.product_parent_members%ROWTYPE;
  v_to public.product_parents%ROWTYPE;
  v_size record;
BEGIN
  SELECT * INTO v_member FROM public.product_parent_members WHERE product_id = p_product_id;
  IF NOT FOUND THEN RETURN 'PRODUCT_PARENT_NOT_GROUPED: this size has no parent'; END IF;
  SELECT * INTO v_to FROM public.product_parents WHERE id = p_to_parent_id;
  IF NOT FOUND THEN RETURN 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  IF v_member.parent_id = p_to_parent_id THEN RETURN 'PRODUCT_PARENT_SAME: the size already belongs to this parent'; END IF;
  IF NOT v_to.is_active THEN RETURN format('PRODUCT_PARENT_INACTIVE: "%s" is inactive', v_to.name); END IF;
  SELECT p.product_form, p.epa_registration, p.rate_per_acre, p.rate_unit, p.suggested_rate, p.inventory_unit
    INTO v_size FROM public.products p WHERE p.id = p_product_id;
  IF v_size.product_form IS DISTINCT FROM v_to.product_form THEN
    RETURN format('PRODUCT_PARENT_FORM_MISMATCH: every size of "%s" is %s', v_to.name, v_to.product_form);
  END IF;
  IF public._normalize_epa_registration(v_size.epa_registration) IS DISTINCT FROM v_to.generic_epa_registration
     AND public._normalize_epa_registration(v_size.epa_registration) IS NOT NULL THEN
    RETURN format('PRODUCT_PARENT_EPA_MISMATCH: "%s" has %s', v_to.name,
      COALESCE('EPA number ' || v_to.generic_epa_registration, 'no EPA number; set it on the parent first'));
  END IF;
  IF public._product_parent_unit_refusal(v_to, v_size.inventory_unit, p_product_id) IS NOT NULL THEN
    RETURN public._product_parent_unit_refusal(v_to, v_size.inventory_unit, p_product_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_parent_members t WHERE t.fill_source_product_id = p_product_id) THEN
    RETURN 'PRODUCT_PARENT_FILL_SOURCE_IN_USE: a tote is filled from this bulk size; change the tote''s fill source first';
  END IF;
  IF v_member.fill_source_product_id IS NOT NULL THEN
    RETURN 'PRODUCT_PARENT_FILL_SOURCE_STAYS: this tote is filled from its parent''s bulk size; clear its fill source first';
  END IF;
  IF v_member.size_role = 'bulk' AND EXISTS (SELECT 1 FROM public.product_parent_members b
                                              WHERE b.parent_id = p_to_parent_id AND b.size_role = 'bulk') THEN
    RETURN format('PRODUCT_PARENT_ONE_BULK: "%s" already has a bulk size', v_to.name);
  END IF;
  IF COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id), true)
     AND (v_size.rate_per_acre IS DISTINCT FROM v_to.rate_per_acre
          OR NULLIF(btrim(v_size.suggested_rate), '') IS DISTINCT FROM v_to.suggested_rate
          OR (v_size.product_form NOT IN ('seed', 'each') AND NULLIF(v_size.rate_unit, '') IS DISTINCT FROM v_to.rate_unit)) THEN
    RETURN 'PRODUCT_RATES_LOCKED: the move would change this size''s live rate; correct its rate to match the parent first, or unlock rates';
  END IF;
  -- A grouped size's brands are its parent's list, so a move must not change them silently.
  IF (SELECT COALESCE(jsonb_agg(jsonb_build_array(b.brand_name, b.epa_registration, b.manufacturer, b.is_currently_sourced,
                b.is_rup, b.signal_word) ORDER BY lower(b.brand_name), b.brand_name), '[]'::jsonb)
        FROM public.product_parent_brands b WHERE b.parent_id = v_member.parent_id AND b.status = 'active')
     IS DISTINCT FROM
     (SELECT COALESCE(jsonb_agg(jsonb_build_array(b.brand_name, b.epa_registration, b.manufacturer, b.is_currently_sourced,
                b.is_rup, b.signal_word) ORDER BY lower(b.brand_name), b.brand_name), '[]'::jsonb)
        FROM public.product_parent_brands b WHERE b.parent_id = p_to_parent_id AND b.status = 'active') THEN
    RETURN format('PRODUCT_PARENT_BRANDS_DIFFER: "%s" and "%s" list different brands; make their brand lists match before moving a size',
      (SELECT name FROM public.product_parents WHERE id = v_member.parent_id), v_to.name);
  END IF;
  RETURN public._brand_document_move_refusal(v_member.parent_id, p_to_parent_id);
END;
$function$;
