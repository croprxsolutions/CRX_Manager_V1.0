#!/usr/bin/env node
/**
 * Real-schema proof for 20270228130000_purchasing_plan_requires_inventory_page.sql (release #2388 Sol HIGH 2).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), then:
 *   1. BEFORE: a sales rep with the Inventory page turned off still gets the purchasing plan (the hole).
 *   2. The candidate applies; a second apply is refused by its preflight (PREFLIGHT_PLAN_DRIFT).
 *   3. AFTER: that rep is refused PAGE_ACCESS_DENIED: inventory; a rep with Inventory on, a rep with only the report
 *      pages off, and an admin (even with a stale denied list naming inventory) still get the plan; an applicator and
 *      a session with no user are still refused with the old message; the report pages' rule is unchanged; every
 *      existing purchasing-plan and page-access chain ends exactly as it did before the fix (the page-access and
 *      reservations chains pass); security, search_path and grants hold.
 * Every probe rolls back.
 *
 * Run: node scripts/smoke/prove-purchasing-plan-inventory-page-real-schema.mjs   (needs Docker; never touches live)
 * Prints PURCHASING_PLAN_INVENTORY_PAGE_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, id, USERS, ROOT, NAME, docker, psql, scalar, claims } from './undo-paths/harness.mjs';

const CANDIDATE = '20270228130000_purchasing_plan_requires_inventory_page.sql';
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
const REP_NO_INV = id('c3');
const REP_NO_REPORTS = id('c4');

// A rolled-back call as a signed-in user (or with no user when uid is null).
function probe(sql, uid) {
  const who = uid ? claims(uid) : "SELECT set_config('request.jwt.claims', '', true);";
  return run(`BEGIN;\n${who}\nSET LOCAL ROLE authenticated;\n${sql}\nROLLBACK;\n`, ['-A', '-t']);
}
const PLAN = 'SELECT jsonb_typeof(public.get_purchasing_plan(6));';
function gets(uid, who) {
  const r = probe(PLAN, uid);
  assert.equal(r.status, 0, `${who}: ${r.output}`);
  assert.match(r.output, /^object$/m, `${who} must get the plan: ${r.output}`);
  console.log(`[case] ${who}: gets the plan`);
}
function refused(sql, pattern, uid, who) {
  const r = probe(sql, uid);
  assert.notEqual(r.status, 0, `${who} must be refused: ${r.output}`);
  assert.match(r.output, pattern, `${who}: ${r.output}`);
  console.log(`[case] ${who}: refused (${r.output.match(pattern)[0]})`);
}
const CHAINS = ['smoke-purchasing-plan.sql', 'smoke-purchasing-plan-reservations.sql', 'smoke-booking-planning-fields.sql', 'smoke-page-access-locks-reports.sql'];
function chain(file) {
  const r = run(lf(path.join(ROOT, 'scripts', 'smoke', file)), ONE_TX);
  return (r.output.split(/\r?\n/).find((l) => /ERROR:/.test(l)) ?? `(no error, status ${r.status})`).replace(/^.*?ERROR:\s*/, '');
}

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${REP_NO_INV}', 'ppip-noinv@example.invalid', '{"full_name":"[PPIP] Rep no inventory","role":"sales_rep"}'::jsonb),
    ('${REP_NO_REPORTS}', 'ppip-noreports@example.invalid', '{"full_name":"[PPIP] Rep no reports","role":"sales_rep"}'::jsonb);`);
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET is_active = true, denied_pages = '{}' WHERE id IN ('${REP}', '${APPL}');
    UPDATE public.profiles SET is_active = true, denied_pages = ARRAY['inventory'] WHERE id IN ('${REP_NO_INV}', '${ADMIN}');
    UPDATE public.profiles SET is_active = true, denied_pages = ARRAY['reports', 'sales-reports'] WHERE id = '${REP_NO_REPORTS}';
    -- smoke-page-access-locks-reports.sql needs one active customer and one order.
    INSERT INTO public.customers (id, farm_name, is_active, assigned_sales_rep) VALUES ('${id('c9')}', '[PPIP] Farm', true, '${REP}');
    INSERT INTO public.orders (id, order_number, customer_id) VALUES ('${id('c8')}', 'PPIP-O1', '${id('c9')}');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  const seeded = scalar(`SELECT string_agg(id::text || '=' || role || ':' || is_active || ':' || array_to_string(denied_pages, '+'), ',' ORDER BY id)
      FROM public.profiles WHERE id IN ('${ADMIN}', '${REP}', '${APPL}', '${REP_NO_INV}', '${REP_NO_REPORTS}');`);
  for (const [uid, want] of [[ADMIN, 'admin:true:inventory'], [REP, 'sales_rep:true:'], [APPL, 'applicator:true:'],
    [REP_NO_INV, 'sales_rep:true:inventory'], [REP_NO_REPORTS, 'sales_rep:true:reports+sales-reports']]) {
    assert.ok(seeded.split(',').includes(`${uid}=${want}`), `seeded profile ${uid} must be ${want}: ${seeded}`);
  }

  // 1. BEFORE: the hole, and each existing chain's outcome on the unfixed body.
  gets(REP_NO_INV, 'BEFORE: rep with Inventory turned off');
  const before = Object.fromEntries(CHAINS.map((c) => [c, chain(c)]));
  for (const c of CHAINS) console.log(`[case] BEFORE: ${c}: ${before[c].slice(0, 160)}`);

  // 2. Apply (as the apply path does: one transaction, stop on error), then a second apply is refused.
  const first = run(candidate, ONE_TX);
  assert.equal(first.status, 0, first.output);
  const second = run(candidate, ONE_TX);
  assert.notEqual(second.status, 0);
  assert.match(second.output, /PREFLIGHT_PLAN_DRIFT/);
  console.log('[case] the candidate applies; a second apply stops at its preflight');

  // 3. AFTER
  refused(PLAN, /PAGE_ACCESS_DENIED: inventory/, REP_NO_INV, 'AFTER: rep with Inventory turned off');
  gets(REP, 'AFTER: rep with Inventory on');
  gets(REP_NO_REPORTS, 'AFTER: rep with only the report pages off');
  gets(ADMIN, 'AFTER: admin (stale denied list naming inventory)');
  refused(PLAN, /Access denied: admin or sales_rep role required/, APPL, 'AFTER: applicator');
  refused(PLAN, /Access denied: admin or sales_rep role required/, null, 'AFTER: no signed-in user');
  refused("SELECT public._require_page_access('reports');", /PAGE_ACCESS_DENIED: reports/, REP_NO_REPORTS, 'AFTER: report page still locked for a rep without it');
  const reportsOk = probe("SELECT public._require_page_access('reports') IS NULL;", REP_NO_INV);
  assert.equal(reportsOk.status, 0, reportsOk.output);
  console.log('[case] AFTER: a rep with only Inventory off still passes the report page check');
  refused("SELECT public._require_page_access('inventory');", /PAGE_ACCESS_DENIED: inventory/, APPL, 'AFTER: inventory page check, applicator');
  refused("SELECT public._require_page_access('customers');", /PAGE_ACCESS_UNKNOWN_PAGE: customers/, ADMIN, 'AFTER: any other page name');
  // The fix changes no chain's outcome: a chain that passed still passes, one that stopped stops identically
  // (a run id or fixture number in the message is masked).
  const mask = (s) => s.replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|\b[0-9a-f]{8}\b/g, '#');
  for (const c of CHAINS) {
    const o = chain(c);
    assert.equal(mask(o), mask(before[c]), `${c} changed outcome: before ${before[c]} / after ${o}`);
    console.log(`[case] AFTER: ${c}: same outcome (${/^SMOKE_PASS_ROLLBACK/.test(o) ? 'PASS' : 'stops identically before and after'})`);
  }
  assert.match(before['smoke-page-access-locks-reports.sql'], /^SMOKE_PASS_ROLLBACK/, 'the page-access chain must pass');
  assert.match(before['smoke-purchasing-plan-reservations.sql'], /^SMOKE_PASS_ROLLBACK/, 'the reservations chain must pass');
  assert.match(before['smoke-booking-planning-fields.sql'], /^SMOKE_PASS_ROLLBACK/, 'the planning-fields chain must pass');
  // smoke-purchasing-plan.sql stops in its own P9b setup (#2393); its outcome must only stay the same.
  assert.match(before['smoke-purchasing-plan.sql'], /^DELIVERY_OVER_ORDER: \[SMOKE\] P9b /, 'the plan chain must stop only at its known P9b setup (#2393)');
  for (const sig of ['public.get_purchasing_plan(integer)', 'public._require_page_access(text)']) {
    assert.equal(scalar(`SELECT p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public, pg_temp']
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = '${sig}'::regprocedure;`), 't', sig);
  }
  console.log('[case] AFTER: both functions SECURITY DEFINER, STABLE, search_path pinned, anon refused, authenticated allowed');
  console.log('PURCHASING_PLAN_INVENTORY_PAGE_PROOF_PASS');
} finally {
  if (process.env.CRX_PROVER_KEEP_CONTAINER !== '1') removeContainer();
}
