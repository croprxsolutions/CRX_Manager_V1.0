-- Invented data only, never a copy of live rows. Safe to run again.
-- The one test user comes from the login service in app.mjs, not from here.
INSERT INTO public.vendors (id, name)
VALUES ('c0ca1000-0000-4000-8000-000000000001', 'Test Vendor (invented)')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- One unit of each type the table allows. The factors are ordinary measures, not business data.
INSERT INTO public.unit_conversions (unit, factor_oz, unit_type, notes)
VALUES
  ('Gal', 128, 'liquid', 'Test unit (invented)'),
  ('fl oz', 1, 'liquid', 'Test unit (invented)'),
  ('Lb', 16, 'dry', 'Test unit (invented)'),
  ('Ea', 1, 'both', 'Test unit (invented)')
ON CONFLICT (unit) DO UPDATE SET
  factor_oz = EXCLUDED.factor_oz,
  unit_type = EXCLUDED.unit_type,
  notes = EXCLUDED.notes;

INSERT INTO public.products (id, product_name, product_form, container_type, container_size)
VALUES ('c0ca1000-0000-4000-8000-000000000002', 'Test Herbicide (invented)', 'liquid', 'Jug', 2.5)
ON CONFLICT (id) DO UPDATE SET
  product_name = EXCLUDED.product_name,
  product_form = EXCLUDED.product_form,
  container_type = EXCLUDED.container_type,
  container_size = EXCLUDED.container_size;
