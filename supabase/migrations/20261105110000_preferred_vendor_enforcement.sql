-- WP-PM-15b enforcement: the product's vendor follows its preferred vendor link.
-- REQUIRES 20261105090000 (vendor-only links) and 20261105100000 (DATA-11), and refuses to finish
-- unless DATA-11's result still holds (checked at the end).
--
-- Rules, all in the database so every writer (current and older app builds) obeys them:
--   * A product with active confirmed links has exactly one preferred link (checked at commit, so a
--     writer may switch the preferred vendor in two steps). Unlinking or deactivating the preferred
--     link is refused until another vendor is preferred.
--   * products.vendor is a read-only copy of the preferred vendor's name: it follows a preferred
--     change and a vendor rename. A direct edit of the text is refused with an actionable message.
--   * A new product's vendor text still saves; when it names exactly one vendor, that vendor becomes
--     the product's preferred vendor-only link.
--   * A new confirmed link becomes preferred when the product has none. A full link to a vendor that
--     already has a vendor-only link for the product replaces it (and keeps its preferred flag).
--   * A vendor that is any product's preferred vendor cannot be deleted.
--   * get_product_vendors lists a product's vendors for any active staff profile; cost is returned to
--     admins only. unlink_product_vendor removes a non-preferred vendor (admin, idempotent).
--   * get_vendor_link_proposals says whether each link's item details are known and still lists the
--     missing fields for a product whose only links are vendor-only.
-- No existing row is changed by this migration.

-- One vendor for a piece of vendor text: its name, an approved alias or an approved legacy
-- resolution; NULL when it names none or several.
CREATE OR REPLACE FUNCTION public._vendor_id_for_text(p_text text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  WITH name_map AS (
    SELECT public.normalize_vendor_alias(v.name) AS normalized, v.id AS vendor_id
    FROM public.vendors v WHERE v.deleted_at IS NULL
    UNION
    SELECT a.alias_normalized, a.vendor_id
    FROM public.vendor_aliases a JOIN public.vendors v ON v.id = a.vendor_id AND v.deleted_at IS NULL
    WHERE a.review_status = 'approved'
    UNION
    SELECT r.normalized_text, r.vendor_id
    FROM public.legacy_vendor_resolution r JOIN public.vendors v ON v.id = r.vendor_id AND v.deleted_at IS NULL
    WHERE r.review_status = 'approved'
  )
  SELECT CASE WHEN count(DISTINCT vendor_id) = 1 THEN min(vendor_id::text)::uuid END
  FROM name_map
  WHERE normalized = public.normalize_vendor_alias(NULLIF(btrim(p_text), ''));
$function$;

-- Copies the preferred vendor's name into products.vendor. A product with no preferred link keeps
-- its text (the commit-time check refuses a product left with links but no preferred one).
CREATE OR REPLACE FUNCTION public._sync_product_vendor_copy(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Waits out a rename of the preferred vendor, so the name copied below is the committed one.
  PERFORM 1
  FROM public.vendors v
  JOIN public.product_supplier_links l ON l.vendor_id = v.id
  WHERE l.product_id = p_product_id
    AND l.is_active AND l.link_status = 'confirmed' AND l.is_preferred
  FOR SHARE OF v;
  UPDATE public.products p
  SET vendor = v.name, updated_at = now()
  FROM public.product_supplier_links l
  JOIN public.vendors v ON v.id = l.vendor_id
  WHERE p.id = p_product_id
    AND l.product_id = p_product_id
    AND l.is_active AND l.link_status = 'confirmed' AND l.is_preferred
    AND p.vendor IS DISTINCT FROM v.name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prepare_product_supplier_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_vendor_only_id uuid;
  v_vendor_only_preferred boolean;
BEGIN
  -- One link writer per product at a time.
  PERFORM 1 FROM public.products WHERE id = NEW.product_id FOR UPDATE;

  IF NEW.is_active AND NEW.link_status = 'confirmed' THEN
    -- Waits out a vendor delete in progress, then refuses a link to the deleted vendor.
    PERFORM 1 FROM public.vendors WHERE id = NEW.vendor_id AND deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VENDOR_DELETED: this vendor was deleted; choose another vendor' USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.supplier_product_name IS NOT NULL THEN
      SELECT id, is_preferred INTO v_vendor_only_id, v_vendor_only_preferred
      FROM public.product_supplier_links
      WHERE product_id = NEW.product_id AND vendor_id = NEW.vendor_id
        AND supplier_product_name IS NULL AND is_active AND link_status = 'confirmed'
      FOR UPDATE;
      IF FOUND THEN
        UPDATE public.product_supplier_links
        SET is_active = false, is_preferred = false
        WHERE id = v_vendor_only_id;
        IF v_vendor_only_preferred THEN NEW.is_preferred := true; END IF;
      END IF;
    END IF;

    IF NOT NEW.is_preferred AND NOT EXISTS (
      SELECT 1 FROM public.product_supplier_links
      WHERE product_id = NEW.product_id AND is_active AND link_status = 'confirmed' AND is_preferred
    ) THEN
      NEW.is_preferred := true;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_product_vendor_from_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._sync_product_vendor_copy(NEW.product_id);
  IF TG_OP = 'UPDATE' AND OLD.product_id IS DISTINCT FROM NEW.product_id THEN
    PERFORM public._sync_product_vendor_copy(OLD.product_id);
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.require_one_preferred_vendor_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_product_id uuid;
  v_links bigint;
  v_preferred bigint;
BEGIN
  FOR v_product_id IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.product_id END,
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.product_id END
    ]) AS x WHERE x IS NOT NULL
  LOOP
    SELECT count(*) FILTER (WHERE is_active AND link_status = 'confirmed'),
           count(*) FILTER (WHERE is_active AND link_status = 'confirmed' AND is_preferred)
      INTO v_links, v_preferred
    FROM public.product_supplier_links
    WHERE product_id = v_product_id;
    -- Deleting, deactivating, unconfirming or moving a product's only (preferred) link is refused
    -- too, unless the product itself is gone.
    IF (v_links > 0 AND v_preferred <> 1)
       OR (TG_OP <> 'INSERT' AND OLD.product_id = v_product_id AND OLD.is_preferred AND OLD.is_active
           AND OLD.link_status = 'confirmed' AND v_links = 0
           AND EXISTS (SELECT 1 FROM public.products WHERE id = v_product_id)) THEN
      RAISE EXCEPTION 'PREFERRED_VENDOR_REQUIRED: this product has vendors but no preferred vendor; make another vendor preferred before removing this one'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_product_vendor_copy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Depth 1 is a direct write; the copy itself arrives from the link and vendor triggers below.
  IF NEW.vendor IS DISTINCT FROM OLD.vendor AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'PRODUCT_VENDOR_FOLLOWS_PREFERRED_VENDOR: the vendor comes from the preferred vendor; change it in the Vendors section of the product page'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.link_new_product_vendor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_vendor_id uuid;
BEGIN
  -- Only an admin's new product gets a confirmed link; anyone else's keeps its text, unlinked.
  IF v_actor IS NULL OR NOT public.is_admin() OR NULLIF(btrim(NEW.vendor), '') IS NULL THEN RETURN NULL; END IF;
  v_vendor_id := public._vendor_id_for_text(NEW.vendor);
  IF v_vendor_id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.product_supplier_links(
    product_id, vendor_id, comparison_status, link_status, is_preferred,
    confirmed_by, confirmed_at, created_by
  ) VALUES (NEW.id, v_vendor_id, 'pending', 'confirmed', true, v_actor, now(), v_actor);
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_product_vendor_on_vendor_rename()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    -- Lock the products first and re-read in the next statement, so a preferred-vendor switch that
    -- committed while this waited is seen and that product keeps its new vendor's name.
    PERFORM 1 FROM public.products p
    WHERE p.id IN (SELECT l.product_id FROM public.product_supplier_links l
                   WHERE l.vendor_id = NEW.id AND l.is_active AND l.link_status = 'confirmed' AND l.is_preferred)
    ORDER BY p.id
    FOR UPDATE OF p;
    UPDATE public.products p
    SET vendor = NEW.name, updated_at = now()
    FROM public.product_supplier_links l
    WHERE l.product_id = p.id AND l.vendor_id = NEW.id
      AND l.is_active AND l.link_status = 'confirmed' AND l.is_preferred
      AND p.vendor IS DISTINCT FROM NEW.name;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_preferred_vendor_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_products bigint;
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    SELECT count(*) INTO v_products
    FROM public.product_supplier_links
    WHERE vendor_id = OLD.id AND is_active AND link_status = 'confirmed' AND is_preferred;
    IF v_products > 0 THEN
      RAISE EXCEPTION 'VENDOR_IS_PREFERRED: % products have this vendor as their preferred vendor; choose another preferred vendor for them first', v_products
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_product_supplier_links_prepare ON public.product_supplier_links;
CREATE TRIGGER trg_product_supplier_links_prepare
  BEFORE INSERT ON public.product_supplier_links
  FOR EACH ROW EXECUTE FUNCTION public.prepare_product_supplier_link();

DROP TRIGGER IF EXISTS trg_product_supplier_links_sync_vendor ON public.product_supplier_links;
CREATE TRIGGER trg_product_supplier_links_sync_vendor
  AFTER INSERT OR UPDATE OF is_preferred, is_active, link_status, vendor_id, product_id
  ON public.product_supplier_links
  FOR EACH ROW EXECUTE FUNCTION public.sync_product_vendor_from_links();

DROP TRIGGER IF EXISTS trg_product_supplier_links_one_preferred ON public.product_supplier_links;
CREATE CONSTRAINT TRIGGER trg_product_supplier_links_one_preferred
  AFTER INSERT OR UPDATE OR DELETE ON public.product_supplier_links
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.require_one_preferred_vendor_link();

DROP TRIGGER IF EXISTS trigger_guard_product_vendor_copy ON public.products;
CREATE TRIGGER trigger_guard_product_vendor_copy
  BEFORE UPDATE OF vendor ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_vendor_copy();

DROP TRIGGER IF EXISTS trigger_link_new_product_vendor ON public.products;
CREATE TRIGGER trigger_link_new_product_vendor
  AFTER INSERT ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.link_new_product_vendor();

DROP TRIGGER IF EXISTS trg_vendors_sync_product_vendor ON public.vendors;
CREATE TRIGGER trg_vendors_sync_product_vendor
  AFTER UPDATE OF name ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.sync_product_vendor_on_vendor_rename();

DROP TRIGGER IF EXISTS trg_vendors_guard_preferred_delete ON public.vendors;
CREATE TRIGGER trg_vendors_guard_preferred_delete
  BEFORE UPDATE OF deleted_at ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.guard_preferred_vendor_delete();

-- Removes one vendor from a product. The preferred vendor cannot be removed: make another vendor
-- preferred first (link_product_vendor with p_make_preferred).
CREATE OR REPLACE FUNCTION public.unlink_product_vendor(
  p_link_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_link public.product_supplier_links%ROWTYPE;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_link_id IS NULL THEN RAISE EXCEPTION 'SUPPLIER_LINK_NOT_FOUND'; END IF;

  v_request_fp := md5(jsonb_build_object('actor_id', v_actor, 'link_id', p_link_id)::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'unlink_product_vendor');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  SELECT * INTO v_link FROM public.product_supplier_links WHERE id = p_link_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SUPPLIER_LINK_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.products WHERE id = v_link.product_id FOR UPDATE;
  SELECT * INTO v_link FROM public.product_supplier_links WHERE id = p_link_id FOR UPDATE;
  IF NOT v_link.is_active THEN RAISE EXCEPTION 'SUPPLIER_LINK_NOT_FOUND'; END IF;
  IF v_link.is_preferred THEN
    RAISE EXCEPTION 'PREFERRED_VENDOR_REQUIRED: this is the preferred vendor; make another vendor preferred before removing it';
  END IF;

  UPDATE public.product_supplier_links SET is_active = false WHERE id = p_link_id;

  v_result := jsonb_build_object('id', v_link.id, 'product_id', v_link.product_id,
    'vendor_id', v_link.vendor_id, 'is_active', false);
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'unlink_product_vendor',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_request_fp, 'response', v_result)
  );
  RETURN v_result;
END;
$function$;

-- A product's active confirmed vendors, preferred first. Cost is the newest current price
-- observation for that link, per inventory unit when the link's conversion is comparable; it is
-- returned to admins only.
CREATE OR REPLACE FUNCTION public.get_product_vendors(p_product_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_business_date date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_admin boolean;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  v_admin := public.is_admin();

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'link_id', l.id,
           'vendor_id', l.vendor_id,
           'vendor_name', v.name,
           'is_preferred', l.is_preferred,
           'item_details_known', l.supplier_product_name IS NOT NULL,
           'supplier_sku', l.supplier_sku,
           'supplier_product_name', l.supplier_product_name,
           'supplier_uom', l.supplier_uom,
           'supplier_pack_description', l.supplier_pack_description,
           'last_cost_cents', CASE WHEN v_admin THEN o.normalized_cost_cents END,
           'last_quoted_package_cost_cents', CASE WHEN v_admin THEN o.cost_cents END,
           'last_cost_as_of', CASE WHEN v_admin THEN o.effective_from END
         ) ORDER BY l.is_preferred DESC, lower(v.name), l.id), '[]'::jsonb)
    INTO v_result
  FROM public.product_supplier_links l
  JOIN public.vendors v ON v.id = l.vendor_id AND v.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT obs.cost_cents, obs.effective_from,
           CASE WHEN l.comparison_status = 'comparable' AND l.inventory_units_per_supplier_unit > 0
                THEN round(obs.cost_cents::numeric / obs.package_quantity / l.inventory_units_per_supplier_unit)::bigint
           END AS normalized_cost_cents
    FROM public.supplier_price_observations obs
    WHERE obs.product_supplier_link_id = l.id
      AND obs.effective_from <= v_business_date
      AND (obs.effective_to IS NULL OR obs.effective_to >= v_business_date)
      AND NOT EXISTS (SELECT 1 FROM public.supplier_price_observations c WHERE c.supersedes_observation_id = obs.id)
    ORDER BY obs.effective_from DESC, obs.observed_at DESC, obs.id DESC
    LIMIT 1
  ) o ON true
  WHERE l.product_id = p_product_id AND l.is_active AND l.link_status = 'confirmed';

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._vendor_id_for_text(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._sync_product_vendor_copy(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_product_supplier_link() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sync_product_vendor_from_links() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.require_one_preferred_vendor_link() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_product_vendor_copy() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.link_new_product_vendor() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sync_product_vendor_on_vendor_rename() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_preferred_vendor_delete() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.unlink_product_vendor(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unlink_product_vendor(uuid, uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.get_product_vendors(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_product_vendors(uuid) TO authenticated;

-- 20261104180000's report, now telling vendor-only links apart (item details not yet known).
CREATE OR REPLACE FUNCTION public.get_vendor_link_proposals()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;

  WITH name_map AS (
    -- Every way a piece of vendor text can name an active vendor.
    SELECT public.normalize_vendor_alias(v.name) AS normalized, v.id AS vendor_id, 'vendor_name' AS source
    FROM public.vendors v
    WHERE v.deleted_at IS NULL
    UNION
    SELECT a.alias_normalized, a.vendor_id, 'vendor_alias'
    FROM public.vendor_aliases a
    JOIN public.vendors v ON v.id = a.vendor_id AND v.deleted_at IS NULL
    WHERE a.review_status = 'approved'
    UNION
    SELECT r.normalized_text, r.vendor_id, 'legacy_resolution'
    FROM public.legacy_vendor_resolution r
    JOIN public.vendors v ON v.id = r.vendor_id AND v.deleted_at IS NULL
    WHERE r.review_status = 'approved'
  ),
  resolved AS (
    SELECT normalized,
           count(DISTINCT vendor_id) AS vendor_count,
           min(vendor_id::text)::uuid AS vendor_id,
           array_agg(DISTINCT vendor_id) AS candidate_vendor_ids,
           array_agg(DISTINCT source ORDER BY source) AS sources
    FROM name_map
    GROUP BY normalized
  ),
  product_base AS (
    SELECT p.id, p.product_name, p.sku, p.inventory_unit,
           NULLIF(btrim(p.vendor), '') AS legacy_vendor_text,
           r.vendor_count, r.vendor_id AS text_vendor_id, r.candidate_vendor_ids, r.sources
    FROM public.products p
    LEFT JOIN resolved r
      ON r.normalized = public.normalize_vendor_alias(NULLIF(btrim(p.vendor), ''))
    WHERE p.is_active
  ),
  link_summary AS (
    SELECT l.product_id,
           count(*) FILTER (WHERE l.is_active AND l.link_status = 'confirmed') AS confirmed_links,
           count(*) FILTER (WHERE l.is_active AND l.link_status = 'pending') AS pending_links,
           count(*) FILTER (WHERE l.is_active AND l.link_status = 'confirmed' AND l.supplier_product_name IS NOT NULL)
             AS full_links,
           (array_agg(l.vendor_id) FILTER (WHERE l.is_active AND l.link_status = 'confirmed' AND l.is_preferred))[1]
             AS preferred_vendor_id,
           -- Every active link by name, so a reviewer sees existing vendors before proposing another.
           jsonb_agg(jsonb_build_object('vendor_name', lv.name, 'link_status', l.link_status,
               'is_preferred', l.is_preferred, 'supplier_sku', l.supplier_sku,
               'item_details_known', l.supplier_product_name IS NOT NULL)
             ORDER BY l.is_preferred DESC, lower(lv.name), l.id) FILTER (WHERE l.is_active) AS links
    FROM public.product_supplier_links l
    -- A link to a deleted vendor counts as no link: it could never become the vendor copy.
    JOIN public.vendors lv ON lv.id = l.vendor_id AND lv.deleted_at IS NULL
    GROUP BY l.product_id
  ),
  classified AS (
    SELECT b.*,
           COALESCE(ls.confirmed_links, 0) AS confirmed_links,
           COALESCE(ls.pending_links, 0) AS pending_links,
           COALESCE(ls.full_links, 0) AS full_links,
           ls.preferred_vendor_id,
           COALESCE(ls.links, '[]'::jsonb) AS links,
           CASE
             WHEN ls.preferred_vendor_id IS NOT NULL
                  AND (b.legacy_vendor_text IS NULL OR (b.text_vendor_id = ls.preferred_vendor_id AND b.vendor_count = 1))
               THEN 'linked'
             -- The preferred vendor exists, but the legacy text names another, several or no vendor.
             WHEN ls.preferred_vendor_id IS NOT NULL THEN 'linked_text_differs'
             WHEN COALESCE(ls.confirmed_links, 0) > 0 THEN 'linked_no_preferred'
             WHEN b.legacy_vendor_text IS NULL THEN 'no_vendor'
             WHEN b.vendor_count = 1 THEN 'proposed'
             WHEN b.vendor_count > 1 THEN 'ambiguous'
             ELSE 'unresolved'
           END AS status,
           -- The vendor the evidence is gathered for: the preferred link, else the text's match.
           COALESCE(ls.preferred_vendor_id, CASE WHEN b.vendor_count = 1 THEN b.text_vendor_id END) AS evidence_vendor_id
    FROM product_base b
    LEFT JOIN link_summary ls ON ls.product_id = b.id
  ),
  po_evidence AS (
    -- Sent (not draft or cancelled) purchase orders for this product whose vendor text names
    -- the same vendor. Dates are Chicago business days.
    SELECT c.id AS product_id,
           count(DISTINCT po.id) AS po_count,
           max(COALESCE(po.submitted_date, (po.created_at AT TIME ZONE 'America/Chicago')::date)) AS last_po_date,
           (array_agg(NULLIF(btrim(poi.unit_size), '')
              ORDER BY COALESCE(po.submitted_date, (po.created_at AT TIME ZONE 'America/Chicago')::date) DESC, po.created_at DESC, poi.id DESC)
              FILTER (WHERE NULLIF(btrim(poi.unit_size), '') IS NOT NULL))[1] AS last_po_unit_size
    FROM classified c
    JOIN public.purchase_order_items poi ON poi.product_id = c.id
    JOIN public.purchase_orders po
      ON po.id = poi.purchase_order_id AND po.status NOT IN ('draft', 'cancelled')
    JOIN resolved pr
      ON pr.normalized = public.normalize_vendor_alias(NULLIF(btrim(po.vendor), ''))
     AND pr.vendor_count = 1
     AND pr.vendor_id = c.evidence_vendor_id
    GROUP BY c.id
  ),
  sheet_evidence AS (
    -- The newest approved vendor quote-sheet row for this product and vendor. Price corrections
    -- ('quick_quote' imports) carry no SKU or name, so they are not evidence here.
    SELECT DISTINCT ON (c.id)
           c.id AS product_id,
           NULLIF(btrim(ir.supplier_sku), '') AS supplier_sku,
           NULLIF(btrim(ir.supplier_product_name), '') AS supplier_product_name,
           NULLIF(btrim(ir.price_unit), '') AS supplier_uom,
           ir.package_quantity,
           i.document_date
    FROM classified c
    JOIN public.supplier_price_import_rows ir
      ON ir.product_id = c.id AND ir.vendor_id = c.evidence_vendor_id AND ir.row_status = 'approved'
    JOIN public.supplier_price_imports i ON i.id = ir.import_id AND i.ingestion_method = 'quote_sheet'
    ORDER BY c.id, i.document_date DESC, ir.created_at DESC, ir.row_number DESC, ir.id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', c.id,
           'product_name', c.product_name,
           'sku', c.sku,
           'inventory_unit', c.inventory_unit,
           'legacy_vendor_text', c.legacy_vendor_text,
           'status', c.status,
           'match_sources', to_jsonb(c.sources),
           'proposed_vendor_id', c.evidence_vendor_id,
           'proposed_vendor_name', ev.name,
           'text_vendor_name', tv.name,
           -- Every vendor an ambiguous text names, so the reviewer can choose between them.
           'candidate_vendor_names', (SELECT COALESCE(jsonb_agg(cv.name ORDER BY lower(cv.name)), '[]'::jsonb)
                                      FROM public.vendors cv WHERE cv.id = ANY (c.candidate_vendor_ids)),
           'links', c.links,
           'confirmed_links', c.confirmed_links,
           'pending_links', c.pending_links,
           'po_count', COALESCE(pe.po_count, 0),
           'last_po_date', pe.last_po_date,
           'last_po_unit_size', pe.last_po_unit_size,
           'sheet_supplier_sku', se.supplier_sku,
           'sheet_supplier_product_name', se.supplier_product_name,
           'sheet_supplier_uom', se.supplier_uom,
           'sheet_package_quantity', se.package_quantity,
           'sheet_document_date', se.document_date,
           -- Fields a new link would need that no record supplies; Mason provides them, never a
           -- placeholder. Products with a confirmed link that knows its item details need no new
           -- one; a vendor-only link (item details not yet known) still lists them.
           'missing_fields', CASE WHEN c.full_links > 0 THEN '[]'::jsonb ELSE to_jsonb(array_remove(ARRAY[
             CASE WHEN se.supplier_sku IS NULL THEN 'supplier_sku' END,
             CASE WHEN se.supplier_product_name IS NULL THEN 'supplier_product_name' END,
             CASE WHEN se.supplier_uom IS NULL THEN 'supplier_uom' END,
             'supplier_pack_description'
           ], NULL)) END
         ) ORDER BY array_position(ARRAY['ambiguous', 'unresolved', 'no_vendor', 'linked_text_differs',
             'linked_no_preferred', 'proposed', 'linked'], c.status), lower(c.product_name), c.id), '[]'::jsonb)
  INTO v_rows
  FROM classified c
  LEFT JOIN public.vendors ev ON ev.id = c.evidence_vendor_id
  LEFT JOIN public.vendors tv ON tv.id = CASE WHEN c.vendor_count = 1 THEN c.text_vendor_id END
  LEFT JOIN po_evidence pe ON pe.product_id = c.id
  LEFT JOIN sheet_evidence se ON se.product_id = c.id;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'summary', (
      SELECT COALESCE(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
      FROM (SELECT r->>'status' AS status, count(*) AS n FROM jsonb_array_elements(v_rows) r GROUP BY 1) s
    ),
    'rows', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_vendor_link_proposals() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_vendor_link_proposals() TO authenticated;

-- DATA-11's result must still hold: every product with links has exactly one preferred link, and
-- every product with a preferred link already shows that vendor's name. Nothing here rewrites a row.
DO $check$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad FROM (
    SELECT product_id FROM public.product_supplier_links
    GROUP BY product_id
    HAVING count(*) FILTER (WHERE is_active AND link_status = 'confirmed') > 0
       AND count(*) FILTER (WHERE is_active AND link_status = 'confirmed' AND is_preferred) <> 1
  ) x;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'PREFERRED_VENDOR_ENFORCEMENT_NOT_READY: % products with links lack exactly one preferred link; run DATA-11 first', v_bad;
  END IF;
  SELECT count(*) INTO v_bad
  FROM public.products p
  JOIN public.product_supplier_links l
    ON l.product_id = p.id AND l.is_active AND l.link_status = 'confirmed' AND l.is_preferred
  JOIN public.vendors v ON v.id = l.vendor_id
  WHERE p.vendor IS DISTINCT FROM v.name;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'PREFERRED_VENDOR_ENFORCEMENT_NOT_READY: % products show a vendor other than their preferred vendor', v_bad;
  END IF;
  SELECT count(*) INTO v_bad
  FROM public.product_supplier_links l
  JOIN public.vendors v ON v.id = l.vendor_id
  WHERE l.is_active AND l.link_status = 'confirmed' AND l.is_preferred AND v.deleted_at IS NOT NULL;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'PREFERRED_VENDOR_ENFORCEMENT_NOT_READY: % preferred links point to a deleted vendor', v_bad;
  END IF;
END
$check$;
