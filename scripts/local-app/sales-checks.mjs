import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localSql } from './e2e/local-db.ts';
import { IS_SALES_GAUNTLET, assertCleanEnvironment } from './target.mjs';
import { interpretResult } from '../smoke/interpret-result.mjs';

assertCleanEnvironment();
assert.equal(IS_SALES_GAUNTLET, true, 'Current sales checks require the isolated sales.mjs test profile.');
const root = new URL('../../', import.meta.url);
const chains = [
  'smoke-convert-sent-quote-in-one-step.sql',
  'smoke-quote-price-trail-and-expiry.sql',
  'smoke-quote-sent-requires-version.sql',
  'smoke-save-quote-customer-row-version.sql',
  'smoke-any-rep-booked-prices.sql',
  'smoke-chemical-sales-overdraw.sql',
  'smoke-invoice-resave-keeps-line-cents.sql',
  'smoke-invoice-resave-keeps-cost.sql',
  'smoke-delivery-invoice-charge-lines.sql',
];
let failed = false;
for (const chain of chains) {
  const source = readFileSync(new URL(`scripts/smoke/${chain}`, root), 'utf8');
  // These are rolled-back, single-statement proofs, never arbitrary fixture scripts.
  assert.match(source, /RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK/);
  const fixture = `BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES ('${randomUUID()}', 'sales-guard-${randomUUID()}@example.invalid', '{"full_name":"[SMOKE] Non-office driver"}') RETURNING id;
    SET LOCAL session_replication_role = replica;
    UPDATE public.profiles SET role='driver', is_active=true WHERE full_name='[SMOKE] Non-office driver';
    SET LOCAL session_replication_role = origin;
    INSERT INTO public.customers (farm_name, is_active) VALUES ('[SMOKE] Chemical contracts fixture', true);
    DO $prices$ DECLARE actor uuid; p uuid; plan jsonb; BEGIN
      SELECT id INTO actor FROM profiles WHERE role='admin' AND is_active ORDER BY created_at LIMIT 1;
      FOR i IN 1..2 LOOP
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('crx.pricing_mode', '', true);
        INSERT INTO products (product_name, product_form, unit_size) VALUES ('[SMOKE] Current sales contract fixture ' || i, 'liquid', 'Gal') RETURNING id INTO p;
        PERFORM set_config('request.jwt.claim.sub', actor::text, true);
        PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',actor,'role','authenticated')::text, true);
        plan := preview_product_pricing_changes('product_page',NULL,
          jsonb_build_array(jsonb_build_object('product_id',p,'row_version',(SELECT pricing_version FROM products WHERE id=p),
            'pricing_mode','margin_driven','new_cost','6.00','tier1_margin_percent','20','tier2_margin_percent','25','tier3_margin_percent','30',
            'change_reason','Invented current chemical contracts fixture')), actor, 'sales-price-preview-' || p);
        PERFORM apply_product_pricing_change_set((plan->>'change_set_id')::uuid,plan->>'request_fingerprint',actor,'sales-price-apply-' || p);
      END LOOP;
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('crx.pricing_mode', '', true);
    END $prices$;
  `;
  try {
    localSql(fixture + source);
    throw new Error('The proof committed instead of reaching its terminal rollback.');
  } catch (error) {
    const output = `${error.stderr ?? ''}\n${error.stdout ?? ''}\n${error.message}`;
    const result = interpretResult(output);
    if (result.pass) console.log(`[current chemical sales] PASS (rolled back): ${chain}`);
    else {
      console.error(`[current chemical sales] FAIL: ${chain}: ${result.message}`);
      failed = true;
    }
  }
}
console.log(`Current schema source: ${fileURLToPath(root)}`);
if (failed) process.exitCode = 1;
else console.log('CURRENT_CHEMICAL_SALES_CONTRACTS_PASS');
