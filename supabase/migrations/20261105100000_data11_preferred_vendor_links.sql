-- WP-PM-15b data step (DATA-11): give every active product its preferred vendor link, exactly as
-- Mason approved on 2026-11-03 (decisions 2, 3 and 4). REQUIRES 20261105090000.
--
-- What it writes, and nothing else:
--   * a vendor-only link (item details not yet known), marked preferred, for each active product
--     with no link whose vendor text names exactly one vendor: the vendor it already shows;
--   * a vendor-only preferred link for the two products with no vendor text that Mason assigned by
--     hand (product and vendor ids below; names stay in his private review list);
--   * "preferred" on each product's single confirmed link where none is preferred yet.
--   * the vendor text of those two hand-assigned products, which is blank, becomes the vendor's
--     name, so every active product's vendor text matches its preferred vendor.
-- It changes no other products.vendor text, no other link, no vendor and no price.
--
-- Bound to the approved list: the plan below is fingerprinted over every active product, and the
-- migration refuses (changing nothing) unless it equals the plan Mason approved, read live on
-- 2026-11-03: 596 active products, 586 new links, 10 preferred flags. Any product, vendor, alias
-- or link change that alters what it would write makes it stop for a fresh review. Afterwards every active product
-- must have exactly one active, confirmed, preferred link to a live vendor.
-- The links are recorded as confirmed by Mason, whose approval this is.

DO $data11$
DECLARE
  c_approver constant uuid := '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f';
  c_fingerprint constant text := '2ea5e0659601e7c5858df86fd3602349';
  v_fingerprint text;
  v_total bigint;
  v_links bigint;
  v_prefers bigint;
  v_inserted bigint;
  v_updated bigint;
  v_named bigint;
  v_bad bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = c_approver AND role = 'admin' AND is_active) THEN
    RAISE EXCEPTION 'DATA11_APPROVER_NOT_ACTIVE_ADMIN';
  END IF;
  -- Serialize with every link and product writer for the length of the step.
  LOCK TABLE public.product_supplier_links IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;
  -- The names the plan resolves through stay put until it is written.
  LOCK TABLE public.vendors, public.vendor_aliases, public.legacy_vendor_resolution IN SHARE MODE;

  CREATE TEMP TABLE data11_plan ON COMMIT DROP AS
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
  ),
  resolved AS (
    SELECT normalized, count(DISTINCT vendor_id) AS vendor_count, min(vendor_id::text)::uuid AS vendor_id
    FROM name_map GROUP BY normalized
  ),
  link_summary AS (
    SELECT l.product_id,
           count(*) AS any_links,
           count(*) FILTER (WHERE l.is_active AND l.link_status = 'confirmed') AS confirmed_links,
           count(*) FILTER (WHERE l.is_active AND l.link_status = 'confirmed' AND l.is_preferred) AS preferred_links,
           min(l.vendor_id::text) FILTER (WHERE l.is_active AND l.link_status = 'confirmed')::uuid AS confirmed_vendor_id
    FROM public.product_supplier_links l
    JOIN public.vendors v ON v.id = l.vendor_id AND v.deleted_at IS NULL
    GROUP BY l.product_id
  ),
  explicit(product_id, vendor_id) AS (VALUES
    ('1a3c082a-1603-4eff-a4db-316af555ff87'::uuid, '54f3e209-c3f9-44f1-98ff-2cb062838b7c'::uuid),
    ('4983d7c2-45cc-4acd-b915-45e92184c563'::uuid, '3c2f7804-72f3-4311-af61-2be4c4a7f0af'::uuid)
  )
  SELECT p.id AS product_id,
         CASE
           WHEN COALESCE(ls.any_links, 0) = 0 AND e.vendor_id IS NOT NULL AND NULLIF(btrim(p.vendor), '') IS NULL THEN 'link'
           WHEN e.vendor_id IS NULL AND ls.confirmed_links = 1 AND ls.preferred_links = 0 THEN 'prefer'
           WHEN e.vendor_id IS NULL AND COALESCE(ls.any_links, 0) = 0 AND r.vendor_count = 1 THEN 'link'
         END AS action,
         CASE
           WHEN e.vendor_id IS NOT NULL THEN e.vendor_id
           WHEN ls.confirmed_links = 1 THEN ls.confirmed_vendor_id
           ELSE r.vendor_id
         END AS vendor_id
  FROM public.products p
  LEFT JOIN resolved r ON r.normalized = public.normalize_vendor_alias(NULLIF(btrim(p.vendor), ''))
  LEFT JOIN link_summary ls ON ls.product_id = p.id
  LEFT JOIN explicit e ON e.product_id = p.id
  WHERE p.is_active;

  SELECT count(*),
         count(*) FILTER (WHERE action = 'link'),
         count(*) FILTER (WHERE action = 'prefer'),
         md5(string_agg(product_id::text || ':' || coalesce(vendor_id::text, '-') || ':' || coalesce(action, '-'), ',' ORDER BY product_id))
    INTO v_total, v_links, v_prefers, v_fingerprint
  FROM data11_plan;
  IF v_fingerprint IS DISTINCT FROM c_fingerprint THEN
    RAISE EXCEPTION 'DATA11_PLAN_CHANGED: % products, % links, % preferred flags, fingerprint % (approved %); re-run the review',
      v_total, v_links, v_prefers, v_fingerprint, c_fingerprint;
  END IF;

  INSERT INTO public.product_supplier_links(
    product_id, vendor_id, comparison_status, link_status, is_preferred,
    confirmed_by, confirmed_at, created_by
  )
  SELECT product_id, vendor_id, 'pending', 'confirmed', true, c_approver, now(), c_approver
  FROM data11_plan
  WHERE action = 'link';
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE public.product_supplier_links l
  SET is_preferred = true
  FROM data11_plan d
  WHERE d.action = 'prefer'
    AND l.product_id = d.product_id
    AND l.vendor_id = d.vendor_id
    AND l.is_active
    AND l.link_status = 'confirmed'
    AND NOT l.is_preferred;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Only the hand-assigned products, and only while their vendor text is still blank.
  UPDATE public.products p
  SET vendor = v.name
  FROM data11_plan d
  JOIN public.vendors v ON v.id = d.vendor_id
  WHERE d.product_id = p.id
    AND d.action = 'link'
    AND d.product_id IN ('1a3c082a-1603-4eff-a4db-316af555ff87', '4983d7c2-45cc-4acd-b915-45e92184c563')
    AND NULLIF(btrim(p.vendor), '') IS NULL;
  GET DIAGNOSTICS v_named = ROW_COUNT;

  IF v_inserted <> 586 OR v_updated <> 10 OR v_named <> 2 THEN
    RAISE EXCEPTION 'DATA11_COUNT_MISMATCH: inserted %, preferred %, named %', v_inserted, v_updated, v_named;
  END IF;

  -- Every active product now has exactly one active, confirmed, preferred link to a live vendor.
  SELECT count(*) INTO v_bad
  FROM public.products p
  WHERE p.is_active
    AND (SELECT count(*) FROM public.product_supplier_links l
         JOIN public.vendors v ON v.id = l.vendor_id AND v.deleted_at IS NULL
         WHERE l.product_id = p.id AND l.is_active AND l.link_status = 'confirmed' AND l.is_preferred) <> 1;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'DATA11_PREFERRED_INVARIANT: % active products without exactly one preferred link', v_bad;
  END IF;
END
$data11$;
