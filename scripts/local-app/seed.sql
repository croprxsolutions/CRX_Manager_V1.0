-- Invented data only, never a copy of live rows. Safe to run again.
-- The one test user comes from the login service in app.mjs, not from here.
INSERT INTO public.vendors (id, name)
VALUES ('c0ca1000-0000-4000-8000-000000000001', 'Test Vendor (invented)')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO public.products (id, product_name, product_form, container_type, container_size)
VALUES ('c0ca1000-0000-4000-8000-000000000002', 'Test Herbicide (invented)', 'liquid', 'Jug', 2.5)
ON CONFLICT (id) DO UPDATE SET
  product_name = EXCLUDED.product_name,
  product_form = EXCLUDED.product_form,
  container_type = EXCLUDED.container_type,
  container_size = EXCLUDED.container_size;

-- A product with stock in two places, for screens that show stock. Stock has no direct browser write.
INSERT INTO public.products (id, product_name, product_form)
VALUES ('c0ca1000-0000-4000-8000-000000000003', 'Test Stocked Product (invented)', 'liquid')
ON CONFLICT (id) DO UPDATE SET product_name = EXCLUDED.product_name;

INSERT INTO public.inventory (id, product_id, location, quantity_available, reorder_point)
VALUES
  ('c0ca1000-0000-4000-8000-000000000004', 'c0ca1000-0000-4000-8000-000000000003', 'North Barn', 12.5, 5),
  ('c0ca1000-0000-4000-8000-000000000005', 'c0ca1000-0000-4000-8000-000000000003', 'South Barn', 0.25, 0)
ON CONFLICT (id) DO UPDATE SET
  location = EXCLUDED.location,
  quantity_available = EXCLUDED.quantity_available,
  reorder_point = EXCLUDED.reorder_point;
