-- Run as the owner in the disposable prover. Always roll back the fixture rows.
BEGIN;

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('233f33c0-68c9-4a4c-a13f-8799d3d3fe91', 'pricing-history@example.invalid', '{"full_name":"Pricing History","role":"admin"}');

INSERT INTO public.products (id, product_name, product_form, inventory_unit, unit_size)
VALUES ('a1e458b4-cb5b-45fb-8989-0d279046054d', '[PROVER] Product', 'liquid', 'Gal', 'Gal');

INSERT INTO public.customers (id, farm_name)
VALUES ('252afddf-b474-41ae-bcab-233dd39090d7', '[PROVER] Farm');

INSERT INTO public.quotes (id, quote_number, customer_id, created_by)
VALUES ('888d6e58-4d94-4529-8bdb-826e54513020', '[PROVER] Quote',
  '252afddf-b474-41ae-bcab-233dd39090d7', '233f33c0-68c9-4a4c-a13f-8799d3d3fe91');

INSERT INTO public.pricing_change_sets (id, created_by, source, request_fingerprint, preview_idempotency_key, submitted_row_count)
VALUES ('91a1f30a-d3cc-42c9-adb0-f16a44b5fe8f', '233f33c0-68c9-4a4c-a13f-8799d3d3fe91',
  'product_page', 'pricing-history-smoke', 'pricing-history-smoke', 1);

INSERT INTO public.cost_history (product_id, changed_by, change_source, change_set_id, old_cost, new_cost, price_source)
VALUES ('a1e458b4-cb5b-45fb-8989-0d279046054d', '233f33c0-68c9-4a4c-a13f-8799d3d3fe91', 'product_page',
  '91a1f30a-d3cc-42c9-adb0-f16a44b5fe8f', 10.00, 11.00, 'Vendor price list');

INSERT INTO public.quote_price_changes (quote_id, quote_item_id, product_id, changed_by, old_price_cents, new_price_cents, sent_version)
VALUES ('888d6e58-4d94-4529-8bdb-826e54513020', '2996d027-2e06-430f-82a8-096a46f257f2',
  'a1e458b4-cb5b-45fb-8989-0d279046054d', '233f33c0-68c9-4a4c-a13f-8799d3d3fe91', 1400, 1300, 1);

CREATE FUNCTION pg_temp.assert_history_write_refused(statement text, error_code text)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN raise_exception THEN
    IF split_part(SQLERRM, ':', 1) = error_code THEN
      RETURN;
    END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'SMOKE_FAIL: expected %, but % succeeded', error_code, split_part(statement, ' ', 1);
END;
$function$;

SELECT pg_temp.assert_history_write_refused('UPDATE public.cost_history SET new_cost = 12.00', 'COST_HISTORY_APPEND_ONLY');
SELECT pg_temp.assert_history_write_refused('DELETE FROM public.cost_history', 'COST_HISTORY_APPEND_ONLY');
SELECT pg_temp.assert_history_write_refused('TRUNCATE public.cost_history', 'COST_HISTORY_APPEND_ONLY');
SELECT pg_temp.assert_history_write_refused('UPDATE public.quote_price_changes SET new_price_cents = 1200', 'QUOTE_PRICE_HISTORY_APPEND_ONLY');
SELECT pg_temp.assert_history_write_refused('DELETE FROM public.quote_price_changes', 'QUOTE_PRICE_HISTORY_APPEND_ONLY');
SELECT pg_temp.assert_history_write_refused('TRUNCATE public.quote_price_changes', 'QUOTE_PRICE_HISTORY_APPEND_ONLY');

UPDATE public.quotes SET deleted_at = now() WHERE id = '888d6e58-4d94-4529-8bdb-826e54513020';
SELECT pg_temp.assert_history_write_refused(
  $$DELETE FROM public.quotes WHERE id = '888d6e58-4d94-4529-8bdb-826e54513020'$$, 'QUOTE_PRICE_HISTORY_APPEND_ONLY');
SELECT pg_temp.assert_history_write_refused(
  $$DELETE FROM public.pricing_change_sets WHERE id = '91a1f30a-d3cc-42c9-adb0-f16a44b5fe8f'$$, 'COST_HISTORY_APPEND_ONLY');

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.cost_history WHERE new_cost = 11.00 AND price_source = 'Vendor price list')
     OR NOT EXISTS (SELECT 1 FROM public.quote_price_changes WHERE new_price_cents = 1300) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an inserted history row is missing or changed';
  END IF;
END;
$verify$;
SELECT 'PRICING_HISTORY_APPEND_ONLY_SMOKE_PASS';
ROLLBACK;
