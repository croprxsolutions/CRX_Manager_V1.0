-- KI-114 / #1958: read-only sweep, run right after 20270228180000_piksi_mg_to_grams is applied (and again a day later).
-- The migration refused if any Piksi quote, quote version, job or invoice line existed, so every row this finds was
-- saved after the apply from a screen still holding MG (Sol HIGH Mason accepted; lasting fix #2261).
-- Expect ZERO rows. Any row: fix that line's unit/quantity by hand before it is sent, invoiced or delivered.
WITH p(id) AS (VALUES ('36732b8d-b4ed-4643-8a13-d793975d13c7'::uuid),
                      ('c22ce37d-cb11-4145-be9a-5469e453bca1'::uuid),
                      ('9a1716a2-8ac3-42e6-887b-64795fca3a57'::uuid))
SELECT 'product' AS kind, id FROM public.products
 WHERE id IN (SELECT id FROM p)
   AND 'mg' IN (lower(inventory_unit), lower(unit_size), lower(rate_unit), lower(container_unit))
UNION ALL SELECT 'quote line', id FROM public.quote_items
 WHERE product_id IN (SELECT id FROM p) AND 'mg' IN (lower(unit_size), lower(rate_unit), lower(price_unit))
UNION ALL SELECT 'quote version', v.id FROM public.quote_versions v
 WHERE EXISTS (SELECT 1 FROM p WHERE strpos(v.snapshot_data::text, p.id::text) > 0)
   AND lower(v.snapshot_data::text) LIKE '%"mg"%'
UNION ALL SELECT 'job line', id FROM public.job_chemicals
 WHERE product_id IN (SELECT id FROM p) AND 'mg' IN (lower(unit), lower(rate_unit))
UNION ALL SELECT 'order line', id FROM public.order_items
 WHERE product_id IN (SELECT id FROM p) AND 'mg' IN (lower(unit_size), lower(rate_unit))
UNION ALL SELECT 'invoice line', id FROM public.invoice_items
 WHERE product_id IN (SELECT id FROM p) AND 'mg' IN (lower(unit_size), lower(rate_unit), lower(total_applied_unit));
