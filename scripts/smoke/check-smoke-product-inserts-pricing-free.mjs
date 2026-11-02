#!/usr/bin/env node

// Since 20260718190000_supplier_pricing_phase1a_cutover, require_governed_product_pricing()
// refuses any products INSERT that sets a pricing column, so a smoke chain doing that dies at setup.
// A chain that proves the refusal, or runs only before the cutover in a disposable proof database,
// opts out with this marker comment (plus its reason) anywhere in the file.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OPT_OUT = 'smoke-allow-priced-product-insert';
const PRICING_COLUMNS = ['current_cost', 'tier1_margin', 'tier2_margin', 'tier3_margin', 'tier1_price', 'tier2_price', 'tier3_price'];

export function pricedProductInserts(sql) {
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const hits = [];
  for (const m of code.matchAll(/\bINSERT\s+INTO\s+(?:public\.)?"?products"?\s*\(([^)]*)\)/gi)) {
    const cols = m[1].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase());
    const priced = cols.filter((c) => PRICING_COLUMNS.includes(c));
    if (priced.length) hits.push({ line: code.slice(0, m.index).split('\n').length, priced });
  }
  return hits;
}

// Self-check so a broken regex cannot silently pass every file.
const selfCheck = [
  ['INSERT INTO public.products (product_name,\n  current_cost) VALUES (1, 2);', 1],
  ['INSERT INTO products(product_name, tier2_price) VALUES (1, 2);', 1],
  ['INSERT INTO public.products (product_name, unit_size) VALUES (1, 2);', 0],
  ['INSERT INTO public.products_archive (current_cost) VALUES (1);', 0],
  ['-- INSERT INTO products (current_cost) VALUES (1);', 0],
];
for (const [sql, want] of selfCheck) {
  if (pricedProductInserts(sql).length !== want) throw new Error(`self-check failed for: ${sql}`);
}

const dir = process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url));
const failures = [];
for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(path.join(dir, name), 'utf8');
  if (sql.includes(OPT_OUT)) continue;
  for (const hit of pricedProductInserts(sql)) failures.push(`${name}:${hit.line} sets ${hit.priced.join(', ')}`);
}

if (failures.length) {
  console.error('FAIL: smoke chains insert priced products (PRODUCT_PRICING_GOVERNED_PATH_REQUIRED on live):');
  for (const f of failures) console.error(`  ${f}`);
  console.error(`Create the product as a pricing-free shell, then set pricing separately; or add "-- ${OPT_OUT}: <reason>" if the chain proves the refusal or runs only before the cutover.`);
  process.exit(1);
}
console.log('PASS: no smoke chain inserts a priced product.');
