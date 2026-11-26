-- KI-85 requires this warehouse name and an active row. Its ID and code are invented.
INSERT INTO public.warehouses (id, name, code, is_active, is_default)
VALUES ('c0ca1000-0000-4000-8000-000000000006', 'Main Warehouse', 'TEST', true, true);

INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes)
VALUES ('c0ca1000-0000-4000-8000-000000000007', 'Gal', 128, 'liquid', 'Test unit (invented)');
