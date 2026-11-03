-- WP-PM-15a: the legacy-vendor proposal list (DATA-11).
--
-- A read-only, admin-only report: for every active product, how its legacy vendor text
-- resolves to a vendor record, which links it already has, and what purchasing evidence
-- exists for the fields a confirmed link needs. Quote-sheet rows can only be staged against
-- an existing link, so sheet evidence appears only where a link exists or once existed; for
-- unlinked products the PO history is the evidence. It writes nothing and changes no vendor
-- behaviour. Confirming a proposal stays with the existing upsert_product_supplier_link,
-- which already refuses a link without SKU, unit, pack and supplier product name.
-- The preferred-vendor copy rule and every refusal wait for WP-PM-15b.
--
-- Grants: EXECUTE to authenticated only (the body refuses non-admins); nothing else changes.
-- No cost or price field is returned.

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
           (array_agg(l.vendor_id) FILTER (WHERE l.is_active AND l.link_status = 'confirmed' AND l.is_preferred))[1]
             AS preferred_vendor_id,
           -- Every active link by name, so a reviewer sees existing vendors before proposing another.
           jsonb_agg(jsonb_build_object('vendor_name', lv.name, 'link_status', l.link_status,
               'is_preferred', l.is_preferred, 'supplier_sku', l.supplier_sku)
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
           -- placeholder. Products that already have a confirmed link need no new one.
           'missing_fields', CASE WHEN c.confirmed_links > 0 THEN '[]'::jsonb ELSE to_jsonb(array_remove(ARRAY[
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
