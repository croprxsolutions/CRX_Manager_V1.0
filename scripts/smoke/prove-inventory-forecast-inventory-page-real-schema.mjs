#!/usr/bin/env node
/**
 * Real-schema proof for 20270302140000_inventory_forecast_requires_inventory_page.sql (#2394 follow-up).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), then:
 *   1. BEFORE: a sales rep with the Inventory page turned off still gets the forecast (the hole).
 *   2. The candidate applies; a second apply is refused by its preflight (PREFLIGHT_FORECAST_DRIFT).
 *   3. AFTER: that rep is refused PAGE_ACCESS_DENIED: inventory for the forecast but still reads stock position
 *      (get_inventory_position, used by New Order, Quick Delivery, Receiving and others); a rep with Inventory on, a
 *      rep with only the report pages off and an admin (even with a stale denied list naming inventory) still get the
 *      forecast, and a seeded planned hold still shows in it; an applicator and a session with no user are refused with
 *      the old message; the page-access chain ends as it did before; security, volatility, search_path and grants hold.
 * Every probe rolls back.
 *
 * Run: node scripts/smoke/prove-inventory-forecast-inventory-page-real-schema.mjs   (needs Docker; never touches live)
 * Prints INVENTORY_FORECAST_INVENTORY_PAGE_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, id, USERS, ROOT, NAME, docker, psql, scalar, claims } from './undo-paths/harness.mjs';

const CANDIDATE = '20270302140000_inventory_forecast_requires_inventory_page.sql';
const lf = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const candidate = lf(path.join(ROOT, 'supabase', 'migrations', CANDIDATE));
// psql -1 makes one transaction only with -f or -c, so stdin is read through -f -.
const ONE_TX = ['-1', '-f', '-'];
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
function run(sql, flags = []) {
  const r = docker([...PSQL, ...flags], { input: sql, allowFailure: true });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

const ADMIN = USERS.admin;
const REP = USERS.rep;
const APPL = USERS.applicator;
const REP_NO_INV = id('d3');
const REP_NO_REPORTS = id('d4');
const PRODUCT = id('d7');

function probe(sql, uid) {
  const who = uid ? claims(uid) : "SELECT set_config('request.jwt.claims', '', true);";
  return run(`BEGIN;\n${who}\nSET LOCAL ROLE authenticated;\n${sql}\nROLLBACK;\n`, ['-A', '-t']);
}
// The forecast is an array; the seeded hold's product must be in it (so a passing caller sees real rows).
const FORECAST = `SELECT jsonb_typeof(f) || ':' || (f @> '[{"product_id":"${PRODUCT}"}]')::text FROM public.get_inventory_forecast(6) f;`;
const POSITION = 'SELECT jsonb_typeof(public.get_inventory_position());';
function gets(uid, who) {
  const r = probe(FORECAST, uid);
  assert.equal(r.status, 0, `${who}: ${r.output}`);
  assert.match(r.output, /^array:true$/m, `${who} must get the forecast with the seeded hold: ${r.output}`);
  console.log(`[case] ${who}: gets the forecast`);
}
function refused(sql, pattern, uid, who) {
  const r = probe(sql, uid);
  assert.notEqual(r.status, 0, `${who} must be refused: ${r.output}`);
  assert.match(r.output, pattern, `${who}: ${r.output}`);
  console.log(`[case] ${who}: refused (${r.output.match(pattern)[0]})`);
}
const CHAIN = 'smoke-page-access-locks-reports.sql';
function chain() {
  const r = run(lf(path.join(ROOT, 'scripts', 'smoke', CHAIN)), ONE_TX);
  return (r.output.split(/\r?\n/).find((l) => /ERROR:/.test(l)) ?? `(no error, status ${r.status})`).replace(/^.*?ERROR:\s*/, '');
}

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${REP_NO_INV}', 'ifip-noinv@example.invalid', '{"full_name":"[IFIP] Rep no inventory","role":"sales_rep"}'::jsonb),
    ('${REP_NO_REPORTS}', 'ifip-noreports@example.invalid', '{"full_name":"[IFIP] Rep no reports","role":"sales_rep"}'::jsonb);`);
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET is_active = true, denied_pages = '{}' WHERE id IN ('${REP}', '${APPL}');
    UPDATE public.profiles SET is_active = true, denied_pages = ARRAY['inventory'] WHERE id IN ('${REP_NO_INV}', '${ADMIN}');
    UPDATE public.profiles SET is_active = true, denied_pages = ARRAY['reports', 'sales-reports'] WHERE id = '${REP_NO_REPORTS}';
    INSERT INTO public.customers (id, farm_name, is_active, assigned_sales_rep) VALUES ('${id('d9')}', '[IFIP] Farm', true, '${REP}');
    INSERT INTO public.orders (id, order_number, customer_id) VALUES ('${id('d8')}', 'IFIP-O1', '${id('d9')}');
    INSERT INTO public.products (id, product_name, sku) VALUES ('${PRODUCT}', '[IFIP] Product', 'IFIP-1');
    INSERT INTO public.inventory_holds (product_id, customer_id, source_id, quantity, hold_type, is_active, expires_at)
      VALUES ('${PRODUCT}', '${id('d9')}', '${id('d6')}', 5, 'crop_program', true, now() + interval '30 days');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  const seeded = scalar(`SELECT string_agg(id::text || '=' || role || ':' || is_active || ':' || array_to_string(denied_pages, '+'), ',' ORDER BY id)
      FROM public.profiles WHERE id IN ('${ADMIN}', '${REP}', '${APPL}', '${REP_NO_INV}', '${REP_NO_REPORTS}');`);
  for (const [uid, want] of [[ADMIN, 'admin:true:inventory'], [REP, 'sales_rep:true:'], [APPL, 'applicator:true:'],
    [REP_NO_INV, 'sales_rep:true:inventory'], [REP_NO_REPORTS, 'sales_rep:true:reports+sales-reports']]) {
    assert.ok(seeded.split(',').includes(`${uid}=${want}`), `seeded profile ${uid} must be ${want}: ${seeded}`);
  }

  // 1. BEFORE: the hole.
  gets(REP_NO_INV, 'BEFORE: rep with Inventory turned off');
  const before = chain();
  console.log(`[case] BEFORE: ${CHAIN}: ${before.slice(0, 160)}`);

  // 2. Apply (as the apply path does: one transaction, stop on error), then a second apply is refused.
  const first = run(candidate, ONE_TX);
  assert.equal(first.status, 0, first.output);
  const second = run(candidate, ONE_TX);
  assert.notEqual(second.status, 0);
  assert.match(second.output, /PREFLIGHT_FORECAST_DRIFT/);
  console.log('[case] the candidate applies; a second apply stops at its preflight');

  // 3. AFTER
  refused(FORECAST, /PAGE_ACCESS_DENIED: inventory/, REP_NO_INV, 'AFTER: rep with Inventory turned off, forecast');
  for (const [uid, who] of [[REP_NO_INV, 'rep with Inventory turned off'], [REP, 'rep with Inventory on'], [ADMIN, 'admin']]) {
    const r = probe(POSITION, uid);
    assert.equal(r.status, 0, `${who} stock position: ${r.output}`);
    assert.match(r.output, /^array$/m, `${who} must still read stock position: ${r.output}`);
    console.log(`[case] AFTER: ${who}: stock position still readable`);
  }
  gets(REP, 'AFTER: rep with Inventory on');
  gets(REP_NO_REPORTS, 'AFTER: rep with only the report pages off');
  gets(ADMIN, 'AFTER: admin (stale denied list naming inventory)');
  refused(FORECAST, /Access denied: admin or sales_rep role required/, APPL, 'AFTER: applicator');
  refused(FORECAST, /Access denied: admin or sales_rep role required/, null, 'AFTER: no signed-in user');
  refused('SELECT public.get_purchasing_plan(6);', /PAGE_ACCESS_DENIED: inventory/, REP_NO_INV, 'AFTER: purchasing plan still locked the same way');
  const mask = (s) => s.replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|\b[0-9a-f]{8}\b/g, '#');
  const after = chain();
  assert.equal(mask(after), mask(before), `${CHAIN} changed outcome: before ${before} / after ${after}`);
  assert.match(after, /^SMOKE_PASS_ROLLBACK/, 'the page-access chain must pass');
  console.log(`[case] AFTER: ${CHAIN}: PASS, same as before`);
  assert.equal(scalar(`SELECT p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
      FROM pg_proc p WHERE p.oid = 'public.get_inventory_forecast(integer)'::regprocedure;`), 't');
  console.log('[case] AFTER: forecast SECURITY DEFINER, volatility unchanged, search_path pinned, anon refused, authenticated allowed');
  console.log('INVENTORY_FORECAST_INVENTORY_PAGE_PROOF_PASS');
} finally {
  if (process.env.CRX_PROVER_KEEP_CONTAINER !== '1') removeContainer();
}
