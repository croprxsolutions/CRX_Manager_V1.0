-- WP-PM-15b step 1: a vendor-only product link (Mason, 2026-11-03, DATA-11 decision 1).
--
-- A link may say only "we buy this product from this vendor", with the vendor's item name,
-- item number, unit and pack not yet known. Nothing is invented for them: they stay NULL until
-- an admin fills them in through upsert_product_supplier_link, which still requires all four.
-- A vendor-only link is never reusable (is_reusable needs SKU, unit and pack), so price imports,
-- quote sheets and cost comparisons keep refusing it exactly as they refuse any incomplete link.
--
-- New: link_product_vendor(product, vendor, make_preferred), admin-only. It reuses the product's
-- active confirmed link to that vendor, or records a vendor-only one, and sets the preferred link
-- in the same transaction under a lock on the product row. A product with no preferred link gets
-- this one as preferred automatically, so a product with links never ends with none preferred
-- through this writer.
--
-- Unchanged: products.vendor and every app writer of it, upsert_product_supplier_link, existing
-- grants and policies. The copy rule and refusals wait for the WP-PM-15b enforcement step.
-- Grants: EXECUTE on the new function to authenticated only (the body refuses non-admins).

ALTER TABLE public.product_supplier_links
  ALTER COLUMN supplier_product_name DROP NOT NULL;

-- A missing item name means "item details not yet known": then none of the item facts may be set.
ALTER TABLE public.product_supplier_links
  DROP CONSTRAINT IF EXISTS product_supplier_links_vendor_only_shape;
ALTER TABLE public.product_supplier_links
  ADD CONSTRAINT product_supplier_links_vendor_only_shape CHECK (
    supplier_product_name IS NOT NULL
    OR (
      supplier_sku IS NULL
      AND supplier_uom IS NULL
      AND supplier_pack_description IS NULL
      AND inventory_units_per_supplier_unit IS NULL
      AND conversion_unit IS NULL
      AND comparison_status = 'pending'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_supplier_links_vendor_only
  ON public.product_supplier_links(product_id, vendor_id)
  WHERE supplier_product_name IS NULL AND is_active AND link_status = 'confirmed';

COMMENT ON COLUMN public.product_supplier_links.supplier_product_name IS
  'The vendor''s name for the item. NULL means a vendor-only link: item details not yet known.';

CREATE OR REPLACE FUNCTION public.link_product_vendor(
  p_product_id uuid,
  p_vendor_id uuid,
  p_make_preferred boolean,
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
  v_created boolean := false;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_product_id IS NULL OR p_vendor_id IS NULL OR p_make_preferred IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_VENDOR_AND_PREFERRED_REQUIRED';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'product_id', p_product_id,
    'vendor_id', p_vendor_id,
    'make_preferred', p_make_preferred
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'link_product_vendor');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- One preferred-link change per product at a time.
  PERFORM 1 FROM public.products WHERE id = p_product_id AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;

  -- Reuse the product's active confirmed link to this vendor; a full link wins over a vendor-only one.
  SELECT * INTO v_link
  FROM public.product_supplier_links
  WHERE product_id = p_product_id
    AND vendor_id = p_vendor_id
    AND is_active
    AND link_status = 'confirmed'
  ORDER BY (supplier_product_name IS NOT NULL) DESC, is_preferred DESC, created_at, id
  LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO public.product_supplier_links(
      product_id, vendor_id, comparison_status, link_status, is_preferred,
      confirmed_by, confirmed_at, created_by
    ) VALUES (
      p_product_id, p_vendor_id, 'pending', 'confirmed', false,
      v_actor, now(), v_actor
    ) RETURNING * INTO v_link;
    v_created := true;
  END IF;

  IF NOT v_link.is_preferred AND (
    p_make_preferred
    OR NOT EXISTS (
      SELECT 1
      FROM public.product_supplier_links l
      JOIN public.vendors v ON v.id = l.vendor_id AND v.deleted_at IS NULL
      WHERE l.product_id = p_product_id
        AND l.is_active
        AND l.link_status = 'confirmed'
        AND l.is_preferred
    )
  ) THEN
    UPDATE public.product_supplier_links
    SET is_preferred = false
    WHERE product_id = p_product_id
      AND is_preferred
      AND id <> v_link.id;
    UPDATE public.product_supplier_links
    SET is_preferred = true
    WHERE id = v_link.id
    RETURNING * INTO v_link;
  END IF;

  v_result := jsonb_build_object(
    'id', v_link.id,
    'product_id', v_link.product_id,
    'vendor_id', v_link.vendor_id,
    'is_preferred', v_link.is_preferred,
    'item_details_known', v_link.supplier_product_name IS NOT NULL,
    'created', v_created
  );

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'link_product_vendor',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_result
    )
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.link_product_vendor(uuid, uuid, boolean, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.link_product_vendor(uuid, uuid, boolean, uuid, text)
  TO authenticated;
