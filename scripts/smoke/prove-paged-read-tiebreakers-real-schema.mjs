#!/usr/bin/env node
/**
 * Real-schema proof for 20261111110000_paged_read_tiebreakers.sql (Goal 4 part 4). Builds the checked-in
 * baseline plus every post-baseline migration on this checkout (the candidate included) in a
 * network-disabled PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), seeds 25 rows that tie on
 * each function's old sort key, then checks:
 *   - each function returns exactly the rows the old body returns (installed beside it under another
 *     name, rebuilt from the candidate by reversing only its ORDER BY line), now in (key, id) order;
 *   - reading in pages of 7 returns every row once (the order is total, so pages cannot overlap);
 *   - a driver is still refused by all three;
 *   - applying the candidate a second time is refused by its preflight.
 * It also prints the post-apply allowlist keys for get_receiving_log (cost-exposure-review key and the
 * actor-forgery contract digest), computed with the sweep's own expressions.
 *
 * Run: node scripts/smoke/prove-paged-read-tiebreakers-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a built database: UNDO_PATHS_CONTAINER=<name> TIEBREAKER_PROOF_REUSE=1 (left running).
 * Prints PAGED_READ_TIEBREAKERS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, psql, scalar, attempt, asUser, refuse, claims, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';
import { functionContractSql } from '../../.claude/hooks/live-testdata-lib.mjs';

const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = '20261111110000_paged_read_tiebreakers.sql';
const reuse = process.env.TIEBREAKER_PROOF_REUSE === '1';
const candidate = readFileSync(path.join(MIGRATIONS, CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const N = 25;
const PAGE = 7;
const P = '7c7a0000-0000-4000-8000-00000011'; // seeded ids: P + 4 hex digits
const id = (n) => `${P}${n.toString(16).padStart(4, '0')}`;
const FARM = id(0xc001);

const FNS = [
  { name: 'get_receiving_log', args: 'integer,integer,text,text,uuid,date,date', desc: true,
    newOrder: 'ORDER BY rr.received_at DESC, rr.id DESC\n', oldOrder: 'ORDER BY rr.received_at DESC\n',
    // jsonb result; the function pages itself with p_limit/p_offset.
    rows: (fn, lim, off) => `SELECT string_agg(e->>'id', ',' ORDER BY o) FROM jsonb_array_elements(public.${fn}(${lim}, ${off}, '[TB] Vendor')) WITH ORDINALITY x(e, o)` },
  { name: 'get_watchdog_flags', args: 'uuid,uuid,text,boolean', desc: true,
    newOrder: 'ORDER BY wf.created_at DESC, wf.id DESC;', oldOrder: 'ORDER BY wf.created_at DESC;',
    rows: (fn, lim, off) => `SELECT string_agg(s.id::text, ',' ORDER BY s.o) FROM (SELECT f.id, row_number() OVER () o FROM public.${fn}(p_job_id => '${FARM}') f LIMIT ${lim} OFFSET ${off}) s` },
  { name: 'get_fields_with_geojson', args: 'uuid', desc: false,
    newOrder: 'ORDER BY f.field_name, f.id;', oldOrder: 'ORDER BY f.field_name;',
    rows: (fn, lim, off) => `SELECT string_agg(s.id::text, ',' ORDER BY s.o) FROM (SELECT f.id, row_number() OVER () o FROM public.${fn}('${FARM}') f LIMIT ${lim} OFFSET ${off}) s` },
];

function installOldBodies() {
  for (const f of FNS) {
    const start = candidate.indexOf(`CREATE OR REPLACE FUNCTION public.${f.name}(`);
    const end = candidate.indexOf('$function$;', start) + '$function$;'.length;
    const def = candidate.slice(start, end);
    assert.equal(def.split(f.newOrder).length, 2, `${f.name}: candidate must contain its new ORDER BY once`);
    psql(def.replace(f.newOrder, f.oldOrder).replace(`public.${f.name}(`, `public.zz_old_${f.name}(`));
  }
}

function seed() {
  // Triggers are off for the seed only (replica role), so fixtures need no full lifecycle. Every row in a
  // group shares one timestamp or name, so only the id can order them.
  const series = `generate_series(1, ${N}) g`;
  const hex = (base) => `('${P}' || lpad(to_hex(${base} + g), 4, '0'))::uuid`;
  const sql = `
${claims(USERS.admin)}
SET session_replication_role = replica;
INSERT INTO public.customers (id, farm_name) VALUES ('${FARM}', '[TB] Proof Farm');
INSERT INTO public.products (id, product_name, is_active) VALUES ('${id(0xd001)}', '[TB] Product', true);
INSERT INTO public.purchase_orders (id, po_number, vendor, created_by) VALUES ('${id(0xe001)}', 'TB-PO-1', '[TB] Vendor', '${USERS.admin}');
INSERT INTO public.receiving_records (id, purchase_order_id, po_item_id, product_id, quantity_received, received_at, received_by)
SELECT ${hex(0)}, '${id(0xe001)}', '${id(0xe002)}', '${id(0xd001)}', g, '2026-11-01 12:00:00+00', '${USERS.admin}' FROM ${series};
INSERT INTO public.watchdog_flags (id, flag_type, severity, entity_type, entity_id, job_id, message, created_at)
SELECT ${hex(256)}, 'acre_divergence', 'warning', 'job', '${FARM}', '${FARM}', 'tie ' || g, '2026-11-01 12:00:00+00' FROM ${series};
INSERT INTO public.fields (id, customer_id, field_name)
SELECT ${hex(512)}, '${FARM}', 'North 80' FROM ${series};
SET session_replication_role = origin;`;
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
    { input: sql, allowFailure: true });
  assert.equal(r.status, 0, `seed failed:\n${r.stderr}`);
}

function readIds(uid, fn, f, lim, off) {
  const out = attempt(uid, asUser(`SELECT (${f.rows(fn, lim, off)}) INTO v;`));
  assert.ok(out.startsWith('ok|'), `${fn} as ${uid} failed: ${out}`);
  const v = out.slice(3);
  return v === '<null>' ? [] : v.split(',');
}

try {
  if (!reuse) { buildContainer(); seedUsers(); }
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${path.basename(CANDIDATE, '.sql')}';`), '1',
    'the candidate must have replayed (its preflight and postflight passed)');
  if (scalar(`SELECT count(*) FROM customers WHERE id = '${FARM}';`) === '0') seed();
  installOldBodies();

  for (const f of FNS) {
    const all = readIds(USERS.admin, f.name, f, 1000, 0);
    const old = readIds(USERS.admin, `zz_old_${f.name}`, f, 1000, 0);
    // 1. Same rows as the old body; now ordered by id inside the tie.
    assert.equal(all.length, N, `${f.name}: expected ${N} seeded rows, got ${all.length}`);
    assert.deepEqual([...all].sort(), [...old].sort(), `${f.name}: rows differ from the old body`);
    const byId = [...all].sort();
    assert.deepEqual(all, f.desc ? byId.reverse() : byId, `${f.name}: tied rows are not in id order`);
    // 2. Pages of 7 cover every row exactly once.
    const paged = [];
    for (let off = 0; off < N; off += PAGE) paged.push(...readIds(USERS.admin, f.name, f, PAGE, off));
    assert.deepEqual(paged, all, `${f.name}: paged read does not equal the one-shot read`);
    // 3. A driver is still refused.
    const refused = attempt(USERS.driver, `${refuse(`PERFORM (${f.rows(f.name, 1, 0)});`)} v := t;`);
    assert.notEqual(refused, 'ok|NOT REFUSED', `${f.name}: a driver must still be refused`);
    console.log(`[tiebreakers] ${f.name}: ${N} tied rows, id order, ${Math.ceil(N / PAGE)} pages complete; driver: ${refused.slice(0, 70)}`);
    psql(`DROP FUNCTION public.zz_old_${f.name}(${f.args});`);
  }

  // 4. A second apply is refused by the preflight and changes nothing.
  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/tb-candidate.sql'], { input: candidate });
  const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/tb-candidate.sql'], { allowFailure: true });
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.stderr, /PAGED_READ_TIEBREAKERS_BASELINE_DRIFT/);

  // 5. Post-apply allowlist keys, from the sweep's own expressions.
  const costSql = readFileSync(path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'cost-exposure-review.sql'), 'utf8').replace(/;\s*$/, '');
  console.log('[tiebreakers] cost-exposure key:', scalar(`SELECT violation_key FROM (${costSql}) s WHERE violation_key LIKE 'get_receiving_log(%';`));
  const keySig = 'public.get_receiving_log(p_limit integer, p_offset integer, p_vendor text, p_condition text, p_received_by uuid, p_date_from date, p_date_to date)';
  console.log('[tiebreakers] actor-forgery contracts:', scalar(`SELECT string_agg(function_key || '=' || contract_md5, ' ; ') FROM (${functionContractSql([keySig, 'auth.uid()'])}) s;`));
  console.log('\nPAGED_READ_TIEBREAKERS_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
