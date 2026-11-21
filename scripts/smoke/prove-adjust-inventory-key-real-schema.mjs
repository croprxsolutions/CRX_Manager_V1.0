#!/usr/bin/env node
/**
 * Real-schema proof for 20270201140000_adjust_inventory_key_printable_only.sql (#1912). Builds the checked-in
 * baseline plus every post-baseline migration on this checkout (the candidate included, so its preflight and
 * postflight ran) in a network-disabled PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), seeds one
 * stock row, and calls adjust_inventory as the signed-in admin:
 *   1. an app-shaped key ('adjust_inventory:<user>:<uuid>') and a batch row key ('<batch key>:<inventory id>')
 *      adjust stock; a same-key retry returns the first answer and writes nothing more;
 *   2. keys with a newline, tab, control character, space or non-ASCII letter, a blank key and NULL are refused
 *      with IDEMPOTENCY_KEY_REQUIRED, and nothing changes (no stock, ledger or receipt row);
 *   3. a second apply is refused by the preflight.
 *
 * Run: node scripts/smoke/prove-adjust-inventory-key-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a built database: UNDO_PATHS_CONTAINER=<name> ADJUST_KEY_PROOF_REUSE=1 (left running).
 * Prints ADJUST_INVENTORY_KEY_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, scalar, attempt, asUser, refuse, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270201140000_adjust_inventory_key_printable_only.sql';
const reuse = process.env.ADJUST_KEY_PROOF_REUSE === '1';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PROD = '7c7a0000-0000-4000-8000-000019120001';
const INV = '7c7a0000-0000-4000-8000-000019120002';
const { admin: ADMIN } = USERS;
const APP_KEY = `adjust_inventory:${ADMIN}:0b6f8a52-4e3c-4a8e-9f2a-1d2c3b4a5e6f`;
const BATCH_KEY = `adjust_inventory_batch:${ADMIN}:5d1e2f3a-6b7c-4d8e-9fa0-b1c2d3e4f5a6:${INV}`;

const state = `(SELECT (SELECT quantity_available::text FROM public.inventory WHERE id = '${INV}')
  || '/ledger=' || (SELECT count(*) FROM public.inventory_transactions WHERE product_id = '${PROD}')
  || '/receipts=' || (SELECT count(*) FROM public.idempotency_keys WHERE operation = 'adjust_inventory'))`;
const adjust = (keySql) => `public.adjust_inventory('${INV}', 1, '[1912] key check', '${ADMIN}', ${keySql})`;
const show = (label, got) => { console.log(`[adjust-key] ${label}: ${got}`); return got; };

try {
  if (!reuse) { buildContainer(); seedUsers(); }
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${path.basename(CANDIDATE, '.sql')}';`), '1',
    'the candidate must have replayed (its preflight and postflight passed)');
  if (scalar(`SELECT count(*) FROM public.inventory WHERE id = '${INV}';`) === '0') {
    const r = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], { allowFailure: true, input: `
INSERT INTO public.products (id, product_name, is_active, product_form, inventory_unit) VALUES ('${PROD}', '[1912] product', true, 'liquid', 'Gal');
INSERT INTO public.inventory (id, product_id, location, quantity_available, quantity_prebooked, quantity_on_order) VALUES ('${INV}', '${PROD}', 'Main Warehouse', 10, 0, 0);` });
    assert.equal(r.status, 0, `seed failed:\n${r.stderr}`);
  }

  // 1. Real app key shapes work; a same-key retry replays the first answer and writes nothing more.
  const c1 = show('normal keys', attempt(ADMIN, `
    f0 := ${state};
    ${asUser(`r := ${adjust(`'${APP_KEY}'`)};`)} f1 := ${state};
    ${asUser(`r2 := ${adjust(`'${APP_KEY}'`)};`)} f2 := ${state};
    ${asUser(`r3 := ${adjust(`'${BATCH_KEY}'`)};`)}
    v := f0 || ' -> ' || f1 || '|replay_same=' || (r = r2) || '|after_replay=' || f2 || '|batch=' || (r3->>'status') || '|end=' || ${state};`));
  assert.match(c1, /^ok\|10(\.0+)?\/ledger=0\/receipts=0 -> 11(\.0+)?\/ledger=1\/receipts=1\|replay_same=true\|after_replay=11(\.0+)?\/ledger=1\/receipts=1\|batch=adjusted\|end=12(\.0+)?\/ledger=2\/receipts=2$/);

  // 2. Every key with a character outside printable ASCII, a blank key and NULL is refused; nothing changes.
  const BAD = {
    newline: `'abc' || E'\\n'`,
    tab: `E'abc\\tdef'`,
    control: `E'abc\\x01'`,
    'carriage return': `E'abc\\r'`,
    space: `'abc def'`,
    'non-ASCII': `'cl' || chr(233)`,
    'newline after app key': `'${APP_KEY}' || E'\\n'`,
    blank: `'   '`,
    null: 'NULL',
  };
  for (const [label, keySql] of Object.entries(BAD)) {
    const got = show(`refuse ${label}`, attempt(ADMIN, `f0 := ${state}; ${refuse(`r := ${adjust(keySql)};`)}
      v := t || '|unchanged=' || (f0 = ${state});`));
    assert.equal(got, 'ok|IDEMPOTENCY_KEY_REQUIRED: adjust_inventory requires p_idempotency_key|unchanged=true', label);
  }

  // 3. A second apply is refused by the preflight.
  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/ak-candidate.sql'], { input: candidate });
  const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/ak-candidate.sql'], { allowFailure: true });
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.stderr, /ADJUST_INVENTORY_KEY_1912_BASELINE_DRIFT/);
  console.log('[adjust-key] second apply refused by the preflight');
  console.log('\nADJUST_INVENTORY_KEY_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
