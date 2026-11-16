#!/usr/bin/env node
/**
 * Real-schema proof for 20270113100000_stock_checks_negative_onorder_chicago.sql (repair step 5, part 1:
 * KI-139, KI-141, KI-162). Builds the checked-in baseline plus every post-baseline migration on this checkout
 * (the candidate included, so its preflight and postflight ran) in a network-disabled PostgreSQL container
 * (scripts/smoke/undo-paths/harness.mjs), seeds test rows, and calls the PUBLIC wrappers as the signed-in user:
 *   1. reconcile fixes a row at -10 (row and ledger change); a same-key retry returns the first answer; a new
 *      key on the now-zero row is refused;
 *   2. reconcile refuses a row at 0 and a row at +5, and NaN / Infinity, changing nothing;
 *   3. retire deletes a row with nothing on order, and refuses one with 4 on order (row kept);
 *   4. a sales rep is refused by both;
 *   5. while another session holds the on-order recompute lock, retire is refused at once (no wait, no
 *      deadlock) and changes nothing; after that session commits, the same retire succeeds;
 *   5b. while another session holds the row itself (e.g. receiving into it), retire is refused at once too,
 *      so a retire never waits on a row while holding the recompute lock (no deadlock);
 *   6. the Receiving Log's From/To filter uses the Chicago business day (19:30 and 23:59:59 Central on Nov 1
 *      are Nov 1; 00:00 Central on Nov 2 is Nov 2), on both sides of each bound;
 *   7. a second apply is refused by the preflight.
 * It also prints the post-apply allowlist keys for get_receiving_log, from the sweep's own expressions.
 *
 * Run: node scripts/smoke/prove-stock-checks-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a built database: UNDO_PATHS_CONTAINER=<name> STOCK_CHECKS_PROOF_REUSE=1 (left running).
 * Prints STOCK_CHECKS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, psql, scalar, attempt, asUser, refuse, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';
import { functionContractSql } from '../../.claude/hooks/live-testdata-lib.mjs';

const CANDIDATE = '20270113100000_stock_checks_negative_onorder_chicago.sql';
const reuse = process.env.STOCK_CHECKS_PROOF_REUSE === '1';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const P = '7c7a0000-0000-4000-8000-00000013';
const id = (n) => `${P}${n.toString(16).padStart(4, '0')}`;
// Products / inventory rows: neg -10, zero 0, pos +5, free (retire ok), onord (4 on order), lock (retire under lock).
const ROWS = { neg: [1, -10, 0], zero: [2, 0, 0], pos: [3, 5, 0], free: [4, 7, 0], onord: [5, 3, 4], lock: [6, 2, 0], rowlk: [7, 1, 0] };
const prod = (k) => id(0xd000 + ROWS[k][0]);
const inv = (k) => id(0xa000 + ROWS[k][0]);
const { admin: ADMIN, rep: REP } = USERS;
const PO = id(0xe001);
const RECEIPTS = { a: '2026-11-02 01:30:00+00', c: '2026-11-02 05:59:59+00', b: '2026-11-02 06:00:00+00' };

function seed() {
  const prods = Object.keys(ROWS).map((k) => `('${prod(k)}', '[SC] ${k}', true, 'liquid')`).join(', ');
  const rows = Object.keys(ROWS).map((k) => `('${inv(k)}', '${prod(k)}', 'Main Warehouse', ${ROWS[k][1]}, 0, ${ROWS[k][2]})`).join(', ');
  const recs = Object.entries(RECEIPTS).map(([k, at], i) =>
    `('${id(0xb001 + i)}', '${PO}', '${id(0xe002)}', '${prod('free')}', 1, '${at}', '${ADMIN}', '${k}')`).join(', ');
  // Triggers off for the seed only (replica role): fixtures need no PO lifecycle.
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'], { allowFailure: true, input: `
SET session_replication_role = replica;
INSERT INTO public.products (id, product_name, is_active, product_form) VALUES ${prods};
INSERT INTO public.inventory (id, product_id, location, quantity_available, quantity_prebooked, quantity_on_order) VALUES ${rows};
INSERT INTO public.purchase_orders (id, po_number, vendor, created_by) VALUES ('${PO}', 'SC-PO-1', '[SC] Vendor', '${ADMIN}');
INSERT INTO public.receiving_records (id, purchase_order_id, po_item_id, product_id, quantity_received, received_at, received_by, notes) VALUES ${recs};
SET session_replication_role = origin;` });
  assert.equal(r.status, 0, `seed failed:\n${r.stderr}`);
}

const row = (k) => `(SELECT COALESCE((SELECT quantity_available::text || '/' || quantity_on_order::text FROM public.inventory WHERE id = '${inv(k)}'), 'gone'))`;
const ledger = (k) => `(SELECT count(*) FROM public.inventory_transactions WHERE product_id = '${prod(k)}')`;
const reconcile = (k, qty, key) => `public.reconcile_negative_inventory('${inv(k)}', ${qty}, '[SC] counted', '${ADMIN}', '${key}')`;
const retire = (k, key, who = ADMIN) => `public.retire_inventory_item('${inv(k)}', '${who}', '${key}')`;
const show = (label, got) => { console.log(`[stock-checks] ${label}: ${got}`); return got; };

try {
  if (!reuse) { buildContainer(); seedUsers(); }
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${path.basename(CANDIDATE, '.sql')}';`), '1',
    'the candidate must have replayed (its preflight and postflight passed)');
  if (scalar(`SELECT count(*) FROM public.inventory WHERE id = '${inv('neg')}';`) === '0') seed();

  // 1. A negative row is fixed once; a same-key retry returns the first answer; a new key is refused on the fixed row.
  const c1 = show('reconcile -10', attempt(ADMIN, `
    f0 := ${row('neg')}; n := ${ledger('neg')};
    ${asUser(`r := ${reconcile('neg', 0, 'sc-rec-1')};`)} f1 := ${row('neg')};
    ${asUser(`r2 := ${reconcile('neg', 0, 'sc-rec-1')};`)}
    ${refuse(`r3 := ${reconcile('neg', 3, 'sc-rec-2')};`)}
    v := f0 || ' -> ' || f1 || '|ledger+' || (${ledger('neg')} - n) || '|delta=' || (r->>'delta') || '|replay_same=' || (r = r2)
      || '|after=' || ${row('neg')} || '|again=' || t;`));
  assert.equal(c1, 'ok|-10/0 -> 0/0|ledger+1|delta=10|replay_same=true|after=0/0'
    + '|again=Only stock below zero can be reconciled here; this item has 0 on hand. Use a count or an adjustment instead.');

  // 2. Rows at 0 and +5, and non-numbers, are refused and nothing changes.
  const c2 = show('reconcile refusals', attempt(ADMIN, `
    f0 := ${row('zero')} || ',' || ${row('pos')} || ',' || ${row('neg')}; n := ${ledger('zero')} + ${ledger('pos')} + ${ledger('neg')};
    ${refuse(`r := ${reconcile('zero', 4, 'sc-rec-3')};`)} t2 := t;
    ${refuse(`r := ${reconcile('pos', 0, 'sc-rec-4')};`)} t2 := t2 || '|' || t;
    ${refuse(`r := ${reconcile('neg', "'NaN'", 'sc-rec-5')};`)} t2 := t2 || '|' || t;
    ${refuse(`r := ${reconcile('neg', "'Infinity'", 'sc-rec-6')};`)} t2 := t2 || '|' || t;
    v := t2 || '|unchanged=' || (f0 = ${row('zero')} || ',' || ${row('pos')} || ',' || ${row('neg')}) || '|ledger+' || (${ledger('zero')} + ${ledger('pos')} + ${ledger('neg')} - n);`));
  assert.equal(c2, 'ok|Only stock below zero can be reconciled here; this item has 0 on hand. Use a count or an adjustment instead.'
    + '|Only stock below zero can be reconciled here; this item has 5 on hand. Use a count or an adjustment instead.'
    + '|New quantity must be a number|New quantity must be a number|unchanged=true|ledger+0');

  // 3. Retire: nothing on order -> deleted; 4 on order -> refused, row kept.
  const c3 = show('retire', attempt(ADMIN, `
    ${asUser(`r := ${retire('free', 'sc-ret-1')};`)} f1 := ${row('free')};
    f0 := ${row('onord')}; ${refuse(`r2 := ${retire('onord', 'sc-ret-2')};`)}
    v := 'free=' || f1 || '|retired=' || (r->>'retired_quantity') || '|onord=' || t || '|kept=' || (f0 = ${row('onord')});`));
  assert.equal(c3, 'ok|free=gone|retired=7|onord=Cannot delete: 4 unit(s) are still on order on an open purchase order. Receive or cancel them first.|kept=true');

  // 4. A sales rep is refused by both (admin only, unchanged).
  const c4 = show('sales rep', attempt(REP, `
    ${refuse(`r := public.reconcile_negative_inventory('${inv('neg')}', 0, '[SC] rep', '${REP}', 'sc-rep-1');`)} t2 := t;
    ${refuse(`r := ${retire('free', 'sc-rep-2', REP)};`)}
    v := t2 || '|' || t || '|unchanged=' || (${row('neg')} = '-10/0') || (${row('free')} = '7/0');`));
  assert.equal(c4, 'ok|Admin access required to reconcile inventory|Admin access required to retire an inventory item|unchanged=truetrue');

  // 5. Another session holds the on-order recompute lock: retire is refused at once and changes nothing; once that
  //    session commits, the same call (a fresh probe) succeeds.
  const hold = (sql) => {
    const h = spawn('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    h.stdin.end(`BEGIN; ${sql}; SELECT pg_sleep(6); COMMIT;\n`);
    return h;
  };
  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  const holder = hold('SELECT pg_advisory_xact_lock(73492009)');
  const held = () => scalar(`SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 73492009 AND granted;`) === '1';
  for (let i = 0; i < 50 && !held(); i += 1) pause();
  assert.ok(held(), 'the holder session must hold the lock');
  const started = Date.now();
  const c5a = show('retire under lock', attempt(ADMIN, `f0 := ${row('lock')}; ${refuse(`r := ${retire('lock', 'sc-ret-lock')};`)}
    v := t || '|unchanged=' || (f0 = ${row('lock')});`));
  const waitedMs = Date.now() - started;
  assert.equal(c5a, 'ok|Cannot delete right now: a purchase order is being saved. Try again in a moment.|unchanged=true');
  assert.ok(waitedMs < 4000, `retire must not wait for the lock (took ${waitedMs} ms)`);
  await new Promise((resolve) => holder.on('close', resolve));
  const c5b = show('retire after lock released', attempt(ADMIN, `${asUser(`r := ${retire('lock', 'sc-ret-lock')};`)} v := ${row('lock')} || '|' || (r->>'success');`));
  assert.equal(c5b, 'ok|gone|true');

  // 5b. Another session holds the inventory row: retire is refused at once (NOWAIT), changes nothing, then succeeds.
  const rowHolder = hold(`SELECT 1 FROM public.inventory WHERE id = '${inv('rowlk')}' FOR UPDATE`);
  const rowHeld = () => scalar(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(6)%' AND state = 'active' AND pid <> pg_backend_pid();`) === '1';
  for (let i = 0; i < 50 && !rowHeld(); i += 1) pause();
  assert.ok(rowHeld(), 'the holder session must hold the row');
  const started2 = Date.now();
  const c5c = show('retire while row held', attempt(ADMIN, `f0 := ${row('rowlk')}; ${refuse(`r := ${retire('rowlk', 'sc-ret-row')};`)}
    v := t || '|unchanged=' || (f0 = ${row('rowlk')});`));
  const waited2 = Date.now() - started2;
  assert.equal(c5c, 'ok|Cannot delete right now: this stock is being changed by someone else. Try again in a moment.|unchanged=true');
  assert.ok(waited2 < 4000, `retire must not wait for the row (took ${waited2} ms)`);
  await new Promise((resolve) => rowHolder.on('close', resolve));
  const c5d = show('retire after row released', attempt(ADMIN, `${asUser(`r := ${retire('rowlk', 'sc-ret-row')};`)} v := ${row('rowlk')} || '|' || (r->>'success');`));
  assert.equal(c5d, 'ok|gone|true');

  // 6. Receiving Log: Chicago business day on both bounds (Nov 1, 2026 is the first CST day; Chicago = UTC-6).
  const logIds = (from, to) => attempt(ADMIN, asUser(`SELECT string_agg(e->>'notes', ',' ORDER BY e->>'notes') INTO v
    FROM jsonb_array_elements(public.get_receiving_log(100, 0, '[SC] Vendor', NULL, NULL, ${from}, ${to})) e;`));
  const c6 = show('receiving log', [
    logIds("'2026-11-01'", "'2026-11-01'"), logIds("'2026-11-02'", "'2026-11-02'"),
    logIds("'2026-11-02'", 'NULL'), logIds('NULL', "'2026-11-01'"), logIds("'2026-10-31'", "'2026-10-31'"),
  ].join(' ; '));
  assert.equal(c6, 'ok|a,c ; ok|b ; ok|b ; ok|a,c ; ok|<null>');

  // 7. A second apply is refused by the preflight and changes nothing.
  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/sc-candidate.sql'], { input: candidate });
  const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/sc-candidate.sql'], { allowFailure: true });
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.stderr, /STOCK_CHECKS_STEP5_BASELINE_DRIFT/);
  console.log('[stock-checks] second apply refused by the preflight');

  // Post-apply allowlist keys, from the sweep's own expressions.
  const costSql = readFileSync(path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'cost-exposure-review.sql'), 'utf8').replace(/;\s*$/, '');
  console.log('[stock-checks] cost-exposure key:', scalar(`SELECT violation_key FROM (${costSql}) s WHERE violation_key LIKE 'get_receiving_log(%';`));
  const keySig = 'public.get_receiving_log(p_limit integer, p_offset integer, p_vendor text, p_condition text, p_received_by uuid, p_date_from date, p_date_to date)';
  console.log('[stock-checks] actor-forgery contracts:', scalar(`SELECT string_agg(function_key || '=' || contract_md5, ' ; ') FROM (${functionContractSql([keySig, 'auth.uid()'])}) s;`));
  console.log('\nSTOCK_CHECKS_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
