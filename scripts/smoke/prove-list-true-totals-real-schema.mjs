#!/usr/bin/env node
/**
 * Real-schema proof for 20261114080000_list_true_totals.sql (Goal 4). Builds the checked-in baseline plus
 * every post-baseline migration on this checkout (the candidate included) in a network-disabled PostgreSQL
 * container (scripts/smoke/undo-paths/harness.mjs), seeds 250 unassigned customers and 520 jobs for one
 * applicator (both past the 200 / 500 cuts), then checks, signed in as admin:
 *   - each call list returns exactly the old body's rows, and total_count equals the number of rows the
 *     old body returns with its LIMIT lifted (zero for a list with no matches);
 *   - the dispatch board returns the same 500 jobs as the old body, now in (job_date, id) DESC order, and
 *     every row's _total_count equals the row count with the LIMIT lifted;
 *   - a driver is still refused by the call lists and sees no hidden job on the board;
 *   - applying the candidate a second time is refused by its preflight.
 * The old bodies come from the migrations that last defined them, installed beside the new ones under
 * other names.
 *
 * Run: node scripts/smoke/prove-list-true-totals-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a built database: UNDO_PATHS_CONTAINER=<name> LIST_TOTALS_PROOF_REUSE=1 (left running).
 * Prints LIST_TRUE_TOTALS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, psql, scalar, attempt, asUser, refuse, claims, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = '20261114080000_list_true_totals.sql';
const reuse = process.env.LIST_TOTALS_PROOF_REUSE === '1';
const read = (f) => readFileSync(path.join(MIGRATIONS, f), 'utf8').replaceAll('\r\n', '\n');
const candidate = read(CANDIDATE);
const CUSTOMERS = 250;
const JOBS = 520;
const P = '7c7a0000-0000-4000-8000-00000012'; // seeded ids: P + 4 hex digits
const FARM = `${P}c001`;

const LISTS = [
  'get_call_list_prepay_prospects',
  'get_call_list_no_recent_contact',
  'get_call_list_stale_quotes',
  'get_call_list_lapsed_products',
  'get_call_list_unassigned_accounts',
];
const BOARD = (fn) => `public.${fn}('${USERS.applicator}')`;

/** Installs the last-applied body of `name` from `file` as zz_old_<name> and, with its LIMIT lifted, zz_all_<name>. */
function installOld(file, name, end, limit) {
  const src = read(file);
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `${name} not found in ${file}`);
  const def = src.slice(start, src.indexOf(end, start) + end.length);
  assert.equal(def.split(`LIMIT ${limit}\n`).length, 2, `${name}: old body must contain LIMIT ${limit} once`);
  psql(def.replace(`public.${name}(`, `public.zz_old_${name}(`));
  psql(def.replace(`public.${name}(`, `public.zz_all_${name}(`).replace(`LIMIT ${limit}\n`, 'LIMIT 1000000\n'));
}

function seed() {
  // Triggers are off for the seed only (replica role), so fixtures need no full lifecycle. Customers and
  // jobs share timestamps and dates in pairs, so only the id breaks the tie.
  const g = (n) => `generate_series(1, ${n}) g`;
  const hex = (base) => `('${P}' || lpad(to_hex(${base} + g), 4, '0'))::uuid`;
  const sql = `
${claims(USERS.admin)}
SET session_replication_role = replica;
INSERT INTO public.customers (id, farm_name) VALUES ('${FARM}', '[LT] Job Farm');
INSERT INTO public.customers (id, farm_name, is_active, assigned_sales_rep, created_at)
SELECT ${hex(0)}, '[LT] Farm ' || g, true, NULL, timestamptz '2026-01-01' + ((g / 2) || ' hours')::interval FROM ${g(CUSTOMERS)};
INSERT INTO public.jobs (id, job_number, customer_id, applicator_id, job_date, status)
SELECT ${hex(4096)}, 'LT-' || g, '${FARM}', '${USERS.applicator}', date '2026-01-01' + (g / 2), 'scheduled' FROM ${g(JOBS)};
SET session_replication_role = origin;`;
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
    { input: sql, allowFailure: true });
  assert.equal(r.status, 0, `seed failed:\n${r.stderr}`);
}

const probe = (uid, body) => {
  const out = attempt(uid, body);
  assert.ok(out.startsWith('ok|'), `probe as ${uid} failed: ${out}`);
  return out.slice(3);
};

try {
  if (!reuse) { buildContainer(); seedUsers(); }
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${path.basename(CANDIDATE, '.sql')}';`), '1',
    'the candidate must have replayed (its preflight and postflight passed)');
  if (scalar(`SELECT count(*) FROM customers WHERE id = '${FARM}';`) === '0') seed();
  for (const name of LISTS) installOld('20260716214423_crm_call_lists.sql', name, '\n$$;', 200);
  installOld('20261102200000_cost_definer_leaks_closed.sql', 'get_dispatch_board_jobs', '\n$function$;', 500);

  // 1. Call lists: same rows as the old body; total_count = rows with the limit lifted.
  for (const name of LISTS) {
    const v = probe(USERS.admin, asUser(`r := public.${name}(); r2 := public.zz_old_${name}(); r3 := public.zz_all_${name}();`)
      + ` v := concat_ws('|', (r->'rows' = r2->'rows'), r->>'total_count', jsonb_array_length(r3->'rows'), jsonb_array_length(r->'rows'), r->>'success');`);
    const [same, total, all, shown, success] = v.split('|');
    assert.equal(same, 't', `${name}: rows differ from the old body`);
    assert.equal(success, 'true', `${name}: payload lost its success key`);
    assert.equal(total, all, `${name}: total_count ${total} but ${all} rows match`);
    assert.equal(Number(shown), Math.min(Number(all), 200), `${name}: shows ${shown} of ${all}`);
    console.log(`[list-totals] ${name}: shows ${shown}, total_count ${total} (= ${all} matching rows)`);
  }
  const unassigned = probe(USERS.admin, `${asUser('r := public.get_call_list_unassigned_accounts();')} v := r->>'total_count';`);
  assert.ok(Number(unassigned) >= CUSTOMERS, `the unassigned list must count every seeded customer, got ${unassigned}`);

  // 2. Dispatch board: the newest 500 of the old body's full result (the old body broke date ties in no
  // fixed order, so its own 500 can differ at the cut), (job_date, id) DESC order, _total_count on every row.
  const board = probe(USERS.admin, asUser(`
    SELECT jsonb_agg(x ORDER BY o) INTO r FROM ${BOARD('get_dispatch_board_jobs')} WITH ORDINALITY t(x, o);
    SELECT jsonb_agg(x) INTO r2 FROM (SELECT x FROM ${BOARD('zz_all_get_dispatch_board_jobs')} t(x)
      ORDER BY (x->>'job_date')::date DESC NULLS LAST, (x->>'id')::uuid DESC LIMIT 500) top;
    SELECT count(*) INTO n FROM ${BOARD('zz_all_get_dispatch_board_jobs')};`) + `
    v := concat_ws('|',
      jsonb_array_length(r), n,
      (SELECT count(DISTINCT e->>'_total_count') FROM jsonb_array_elements(r) e),
      (SELECT min(e->>'_total_count') FROM jsonb_array_elements(r) e),
      (SELECT array_agg(e - '_total_count' ORDER BY e->>'id') FROM jsonb_array_elements(r) e)
        = (SELECT array_agg(e ORDER BY e->>'id') FROM jsonb_array_elements(r2) e),
      (SELECT string_agg(e->>'id', ',' ORDER BY o) FROM jsonb_array_elements(r) WITH ORDINALITY q(e, o))
        = (SELECT string_agg(e->>'id', ',' ORDER BY e->>'job_date' DESC, e->>'id' DESC) FROM jsonb_array_elements(r) e));`);
  const [shown, all, distinctTotals, total, sameJobs, ordered] = board.split('|');
  assert.equal(all, String(JOBS), `board: expected ${JOBS} matching jobs, got ${all}`);
  assert.equal(shown, '500', `board: expected 500 rows shown, got ${shown}`);
  assert.equal(distinctTotals, '1', 'board: every row must carry the same _total_count');
  assert.equal(total, String(JOBS), `board: _total_count ${total}, expected ${JOBS}`);
  assert.equal(sameJobs, 't', 'board: rows differ from the newest 500 of the old body full result (apart from _total_count)');
  assert.equal(ordered, 't', 'board: rows are not in (job_date, id) DESC order');
  console.log(`[list-totals] get_dispatch_board_jobs: shows ${shown}, _total_count ${total}, the newest 500 jobs, id tie-break order`);

  // 3. Role gates unchanged.
  for (const name of LISTS) {
    const refused = attempt(USERS.driver, `${refuse(`PERFORM public.${name}();`)} v := t;`);
    assert.match(refused, /CALL_LIST_ACCESS_DENIED/, `${name}: a driver must still be refused`);
  }
  const driverRows = probe(USERS.driver, `${asUser(`SELECT count(*) INTO n FROM ${BOARD('get_dispatch_board_jobs')};`)} v := n;`);
  assert.equal(driverRows, '0', 'board: a driver must see no job that is not theirs');
  console.log('[list-totals] driver refused by all five call lists; sees 0 board jobs');

  // 3b. The live smoke chain passes here first (it must end in SMOKE_PASS_ROLLBACK).
  const chain = readFileSync(path.join(ROOT, 'scripts', 'smoke', 'smoke-goal4-list-totals.sql'), 'utf8');
  const smoked = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-1'], { input: chain, allowFailure: true });
  assert.match(smoked.stderr, /SMOKE_PASS_ROLLBACK/, `smoke-goal4-list-totals.sql did not pass:\n${smoked.stderr}`);
  console.log('[list-totals] smoke-goal4-list-totals.sql: PASS (rolled back)');

  // 4. A second apply is refused by the preflight and changes nothing.
  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/lt-candidate.sql'], { input: candidate });
  const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/lt-candidate.sql'], { allowFailure: true });
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.stderr, /LIST_TRUE_TOTALS_BASELINE_DRIFT/);

  // 5. Post-apply cost-exposure keys for the replaced functions, from the sweep's own expression.
  const costSql = readFileSync(path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'cost-exposure-review.sql'), 'utf8').replace(/;\s*$/, '');
  console.log('[list-totals] cost-exposure keys:', scalar(`SELECT string_agg(violation_key, ' ; ') FROM (${costSql}) s WHERE violation_key LIKE 'get_dispatch_board_jobs(%' OR violation_key LIKE 'get_call_list_%';`) || '<none>');
  console.log('\nLIST_TRUE_TOTALS_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
