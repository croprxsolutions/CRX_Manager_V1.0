import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rateReviewTouch } from './rate-review-later-migrations.mjs';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'supabase', 'migrations');
const file = (name) => readFileSync(path.join(MIGRATIONS, name), 'utf8');

// Every file the prover's old hand-kept LATER_READ_ONLY list allowed is read-only, including the one that refused on 2026-11-17.
for (const name of ['20270104120000_delivery_brands.sql', '20270105110000_epa_chemistry_proposals.sql',
  '20270106110000_invoice_brands_rup.sql', '20270108100000_ingredient_modes_of_action.sql',
  '20270109100000_delivery_receipt_brands.sql', '20270115100000_moa_group_code_equivalence.sql',
  '20270119160000_registration_adjuvants.sql']) {
  assert.equal(rateReviewTouch(file(name)), null, name);
}
// The real follow-ups redefine rate-review functions: refused.
assert.ok(rateReviewTouch(file('20270110110000_inactive_rate_review_cleanup.sql')));
assert.ok(rateReviewTouch(file('20270120100000_priority_integrity_followups.sql')));

const fn = (body) => `CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $fn$\nBEGIN\n${body}\nEND;\n$fn$;`;
const readOnly = [
  fn("PERFORM public._product_parent_require_admin();\n  v := public._product_parent_replay(k, 's', fp);"),
  fn('SELECT _product_parent_replay(k, s, f) INTO v;'),
  "-- ALTER FUNCTION _product_parent_replay(text,text,text) in a comment\n/* DROP TABLE product_rates; */ SELECT 1;",
  "DO $$ BEGIN IF to_regprocedure('public._product_parent_replay(text,text,text)') IS NULL THEN RAISE EXCEPTION 'x'; END IF; END $$;",
  "SELECT * FROM (VALUES ('_product_parent_replay', '62880d61a470c2eeca02de7bc11c76be')) v(proname, md5);",
];
for (const sql of readOnly) assert.equal(rateReviewTouch(sql), null, sql);

const refused = [
  'CREATE OR REPLACE FUNCTION public._product_parent_replay(p text, s text, f text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;',
  "UPDATE public.product_rates SET status = 'draft';",
  fn("UPDATE product_rates SET status = 'draft';"),
  fn("INSERT INTO public.product_parent_rate_outcomes (parent_id) VALUES (p);"),
  'DELETE FROM public.product_rates;',
  'ALTER FUNCTION public._product_parent_replay(text,text,text) SET search_path = public;',
  'DROP FUNCTION IF EXISTS public._product_parent_require_admin();',
  'GRANT EXECUTE ON FUNCTION public.foo(), public._product_parent_replay(text,text,text) TO authenticated;',
  'REVOKE ALL ON FUNCTION public.get_rate_review_workbook() FROM PUBLIC;',
  'CREATE POLICY p ON public.product_parent_rate_outcomes FOR SELECT USING (true);',
  'CREATE TRIGGER t AFTER INSERT ON public.x FOR EACH ROW EXECUTE FUNCTION public._product_rates_clear_outcome();',
  'ALTER TABLE public."product_rates" ADD COLUMN x int;',
  "DO $$ BEGIN EXECUTE 'DROP FUNCTION public._product_parent_replay(text,text,text)'; END $$;",
  "DO $$ BEGIN EXECUTE format('ALTER FUNCTION %s OWNER TO x', 'public._product_parent_replay(text,text,text)'); END $$;",
];
for (const sql of refused) assert.ok(rateReviewTouch(sql), `should refuse: ${sql}`);

console.log('rate-review-later-migrations: ok');
