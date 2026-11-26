#!/usr/bin/env node
/**
 * Real-schema proof for 20270311100000_job_ticket_stock_count_once: a job and the blend tickets linked to it take a
 * product out of stock once (the larger claim), not twice; the later posting takes only the difference and is flagged.
 * Builds the baseline plus every migration before the candidate (shared undo-paths harness), then:
 *   BEFORE: a linked ticket plus its job take the same product twice (the bug).
 *   APPLY:  commits in one transaction with a NOTICE counting that old pair; a second apply stops at its preflight.
 *   AS THE REAL CALLERS (a sales rep files tickets, an admin completes jobs and reverses): contract cases 1-12, a
 *     multi-product ticket, a ticket moved between open jobs before filing, and two races (filing and reversing while
 *     a completion holds the lock). A filed ticket's job link stays frozen by the existing header lock. After every case each warehouse balance equals the expected total and the ledger.
 *   GRANTS and ROLLBACK: the helper is owner-only; wrapper grants unchanged; the rollback script refuses once counted
 *     rows exist, and otherwise restores the previous bodies.
 *
 * Run: node scripts/smoke/prove-job-ticket-stock-count-once-real-schema.mjs   (needs Docker)
 * Prints JOB_TICKET_COUNT_ONCE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

process.env.UNDO_PATHS_CONTAINER ||= `crx-countonce-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, psql, scalar, docker, USERS, id, NAME, ROOT } = await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270311100000_job_ticket_stock_count_once.sql';
const ROLLBACK = path.join(ROOT, 'scripts', 'smoke', 'job-ticket-stock-count-once-reverse.sql');
const CUST = id('c1'), FIELD = id('c2');
const PRE = { job: '3bd9dfe0729d8175ffbb1cf16b258b5c', bt: '0ad9a78b900cb953e0aa7d2a0d87bda0', rev: 'bb7b45f8dca986c9cf39b5b6a41aa75b' };
const SIG = {
  job: 'public._complete_job_replay_impl_20261015(uuid, jsonb, uuid, text)',
  bt: 'public._create_app_record_from_bt_replay_impl_20261015(uuid, uuid, text)',
  rev: 'public.reverse_application_record(uuid, text)',
};
const WRAPPERS = ['public.complete_job(uuid, jsonb, uuid, text)', 'public.create_application_record_from_blend_ticket(uuid, uuid, text)'];

// Ids: products p<n>, jobs j<n>, tickets t<n> (hex-safe: id() pads digits/letters a-f only).
const P = (n) => id(`b0${n}`), J = (n) => id(`d0${n}`), T = (n) => id(`e0${n}`);

const run = (sql) => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
  { input: sql, allowFailure: true });
const out = (r) => `${r.stdout}${r.stderr}`;
const signedIn = (uid) => `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', false);
  SELECT set_config('request.jwt.claim.sub', '${uid}', false); SET ROLE authenticated;`;
const as = (uid, sql) => `${signedIn(uid)} BEGIN; ${sql} COMMIT;`;
const ok = (uid, sql) => { const r = run(as(uid, sql)); assert.equal(r.status, 0, out(r)); return r.stdout.trim(); };
const refused = (uid, sql, re) => { const r = run(as(uid, sql)); assert.notEqual(r.status, 0, `expected a refusal: ${sql}`); assert.match(out(r), re); };
const seed = (sql) => psql(`SET session_replication_role = replica; ${sql}`);
let k = 0;
const key = () => `count-once-${(k += 1)}`;

const fileSql = (t) => `SELECT public.create_application_record_from_blend_ticket('${t}', '${USERS.rep}', '${key()}');`;
const completeSql = (j) => `SELECT public.complete_job('${j}', '{}'::jsonb, '${USERS.admin}', '${key()}');`;
const recordOf = (t) => `(SELECT id FROM public.application_records WHERE source_type = 'blend_ticket' AND source_id = '${t}')`;
const reverseSql = (t) => `SELECT public.reverse_application_record(${recordOf(t)}, '${key()}');`;
const relinkSql = (t, j) => `UPDATE public.blend_tickets SET job_id = ${j ? `'${j}'` : 'NULL'} WHERE id = '${t}';`;
const file = (t) => ok(USERS.rep, fileSql(t));
const complete = (j) => ok(USERS.admin, completeSql(j));

function product(n, unit = 'Gal') {
  seed(`INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
      rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ('${P(n)}', '[PROVER] Count once ${n}', 'CO-${n}', 'liquid', '${unit}', '${unit}', '${unit}', '${unit}', 1, 24, 30, 30, 30, 1, true);
    INSERT INTO public.inventory (product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES ('${P(n)}', 'Main Warehouse', '${unit}', 100, 0, 0);`);
}
/** lines: [productN, qty, unit = 'Gal', customerSupplied = false] in sort order. */
function job(n, lines, status = 'in_progress') {
  seed(`INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, created_by)
      VALUES ('${J(n)}', 'CO-J${n}', '${CUST}', current_date, '${status}', '${USERS.admin}');
    ${lines.map(([p, q, u = 'Gal', s = false], i) => `INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, sort_order, customer_supplied)
      VALUES ('${J(n)}', '${P(p)}', ${q}, '${u}', ${i + 1}, ${s});`).join('\n')}`);
}
/** lines: [productN, qty, unit = 'Gal'] in sequence order. */
function ticket(n, jobN, lines) {
  seed(`INSERT INTO public.blend_tickets (id, ticket_number, uploaded_by, status, review_status, customer_id, season, ticket_date, total_acres, job_id)
      VALUES ('${T(n)}', 'CO-T${n}', '${USERS.admin}', 'completed', 'approved', '${CUST}', 2027, current_date, 1, ${jobN == null ? 'NULL' : `'${J(jobN)}'`});
    INSERT INTO public.blend_ticket_fields (blend_ticket_id, field_id, customer_id, planned_acres) VALUES ('${T(n)}', '${FIELD}', '${CUST}', 1);
    ${lines.map(([p, q, u = 'Gal'], i) => `INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, sequence_order)
      VALUES ('${T(n)}', '${P(p)}', '[PROVER] Count once ${p}', ${q}, '${u}', ${i + 1});`).join('\n')}`);
}

const onHand = (p) => Number(scalar(`SELECT quantity_available FROM public.inventory WHERE product_id = '${P(p)}' AND location = 'Main Warehouse';`));
// Every job_applied row for a product, oldest first: quantity/already_counted/requires_review/source.
const rows = (p) => scalar(`SELECT coalesce(string_agg(it.quantity::numeric(12,4)::float8 || '/' || coalesce(it.already_counted::numeric(12,4)::float8::text, '-') || '/'
    || it.requires_review || '/' || coalesce(ar.source_type, 'none'), ' ' ORDER BY it.created_at, it.ctid), '')
  FROM public.inventory_transactions it LEFT JOIN public.application_records ar ON ar.id = it.application_record_id
  WHERE it.product_id = '${P(p)}' AND it.transaction_type = 'job_applied';`);
// Independent checks: the warehouse moved exactly `out` from its opening 100, and the ledger says the same.
function balance(p, outQty, what) {
  assert.equal(onHand(p), 100 - outQty, `${what}: warehouse should be ${100 - outQty}`);
  const ledger = Number(scalar(`SELECT coalesce(sum(CASE WHEN transaction_type = 'job_applied' THEN quantity WHEN transaction_type = 'adjusted' THEN -quantity END), 0)
    FROM public.inventory_transactions WHERE product_id = '${P(p)}';`));
  assert.equal(ledger, outQty, `${what}: ledger history should total ${outQty}`);
  console.log(`[COUNT-ONCE] ${what}: ${outQty} out (warehouse and ledger agree)`);
}
const md5 = (sig) => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
const acl = (sig) => scalar(`SELECT coalesce(proacl::text, '<default>') FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);

// A second signed-in psql session, for races; `delayMs` lets the first session take its locks first.
function session(uid, sql, delayMs = 0) {
  return new Promise((resolve) => setTimeout(() => {
    const c = spawn('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { cwd: ROOT });
    let text = '';
    c.stdout.on('data', (d) => { text += d; }); c.stderr.on('data', (d) => { text += d; });
    c.on('close', (code) => resolve({ code, text }));
    c.stdin.end(`${signedIn(uid)} ${sql}`);
  }, delayMs));
}
// Completion holds its locks for 2 s; `other` starts 0.6 s later and must wait for it, then see the committed job record.
async function whileCompleting(j, uid, otherSql) {
  const [a, b] = await Promise.all([
    session(USERS.admin, `BEGIN; ${completeSql(j)} SELECT pg_sleep(2); SELECT 'A-done ' || extract(epoch FROM clock_timestamp()); COMMIT;`),
    session(uid, `BEGIN; SELECT 'B ' || extract(epoch FROM clock_timestamp()); ${otherSql} SELECT 'B-done ' || extract(epoch FROM clock_timestamp()); COMMIT;`, 600),
  ]);
  assert.equal(a.code, 0, a.text);
  const started = Number((b.text.match(/^B ([0-9.]+)$/m) ?? [])[1]);
  const ended = Number((a.text.match(/^A-done ([0-9.]+)$/m) ?? [])[1]);
  assert.ok(started < ended, `the second session must start while the completion still holds its lock:
${a.text}
${b.text}`);
  return b;
}

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  seed(`INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Count Once Farm', true);
    INSERT INTO public.fields (id, customer_id, field_name) VALUES ('${FIELD}', '${CUST}', '[PROVER] Count Once Field');`);
  for (let n = 0; n <= 9; n += 1) product(n);
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 20, 21]) product(n);
  const wrapperAcl = WRAPPERS.map(acl);

  // BEFORE: the bug. Ticket 6 on an in-progress job, then the job's 10: 16 out.
  job(0, [[0, 10]]); ticket(0, 0, [[0, 6]]);
  file(T(0)); complete(J(0));
  balance(0, 16, 'BEFORE the fix, ticket 6 then its job 10 (the double count)');

  // Halves posted BEFORE the migration, finished after it (Luna r1): a ticket filed on a job still open, and a job
  // completed while its linked ticket is not yet filed.
  job(20, [[20, 10]]); ticket(20, 20, [[20, 6]]); file(T(20));
  job(21, [[21, 10]]); ticket(21, 21, [[21, 7]]); complete(J(21));

  // APPLY (case 11: over a database that already has an old linked pair).
  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/candidate.sql'], {
    input: fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n') });
  const applyFile = () => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/candidate.sql'], { allowFailure: true });
  let r = applyFile();
  assert.equal(r.status, 0, `the candidate applies: ${out(r)}`);
  assert.match(out(r), /COUNT_ONCE: 1 job\(s\) already have both a job record and a linked ticket record/);
  r = applyFile();
  assert.notEqual(r.status, 0); assert.match(out(r), /COUNT_ONCE_PREFLIGHT/);
  assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_guard_inventory_transactions_immutable' AND tgenabled = 'O';`), '1', 'the immutability guard is untouched');
  refused(USERS.admin, `UPDATE public.inventory_transactions SET already_counted = 1 WHERE product_id = '${P(0)}';`, /permission denied|immutable|IMMUTABLE/i);
  console.log('[COUNT-ONCE] APPLY: commits with a NOTICE naming the 1 old pair; a second apply stops at the preflight; the ledger stays write-once');

  // GRANTS
  for (const sig of ['public._job_stock_group_20270310(uuid, uuid)']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(scalar(`SELECT has_function_privilege('${role}', '${sig}', 'EXECUTE');`), 'f', `${sig} not executable by ${role}`);
    }
  }
  assert.deepEqual(WRAPPERS.map(acl), wrapperAcl, 'wrapper grants unchanged');
  assert.equal(scalar(`SELECT has_function_privilege('authenticated', '${SIG.rev}', 'EXECUTE')::text || '/' || has_function_privilege('anon', '${SIG.rev}', 'EXECUTE')::text;`), 'true/false');
  console.log('[COUNT-ONCE] GRANTS: the group helper is owner-only; wrapper and reversal grants unchanged');

  // Straddling the migration: the earlier half carries no link and is still counted.
  complete(J(20));
  assert.equal(rows(20), '6/-/false/none 4/6/true/job');
  balance(20, 10, 'straddle, ticket 6 filed before the migration, job 10 completed after');
  file(T(21));
  assert.equal(rows(21), '10/-/false/none 0/7/true/blend_ticket');
  balance(21, 10, 'straddle, job 10 completed before the migration, ticket 7 filed after');
  refused(USERS.admin, reverseSql(T(20)), /APPLICATION_RECORD_COUNTED_WITH_JOB/);

  // 1. Ticket 6 then job 10: job moves 4, already_counted 6, flagged.
  job(1, [[1, 10]]); ticket(1, 1, [[1, 6]]);
  file(T(1)); complete(J(1));
  assert.equal(rows(1), '6/-/false/blend_ticket 4/6/true/job');
  assert.match(scalar(`SELECT notes FROM public.inventory_transactions WHERE product_id = '${P(1)}' AND already_counted IS NOT NULL;`), /\[6 already counted by blend ticket\(s\) for this job — review\]/);
  balance(1, 10, 'case 1, ticket 6 then job 10');

  // 2. Ticket 12 then job 10: job row 0, flagged, commits.
  job(2, [[2, 10]]); ticket(2, 2, [[2, 12]]);
  file(T(2)); complete(J(2));
  assert.equal(rows(2), '12/-/false/blend_ticket 0/10/true/job');
  assert.equal(scalar(`SELECT status FROM public.jobs WHERE id = '${J(2)}';`), 'completed');
  balance(2, 12, 'case 2, ticket 12 then job 10');

  // 3. Job 10 then ticket 7 (moves 0), then ticket 6 on the same job (moves 3).
  job(3, [[3, 10]]); ticket(3, 3, [[3, 7]]); ticket(31, 3, [[3, 6]]);
  complete(J(3)); file(T(3)); file(T(31));
  assert.equal(rows(3), '10/-/false/job 0/7/true/blend_ticket 3/3/true/blend_ticket');
  balance(3, 13, 'case 3, job 10 then tickets 7 and 6');

  // 4. Job 10 then one ticket with two lines of the product (6, 7): 0 then 3.
  job(4, [[4, 10]]); ticket(4, 4, [[4, 6], [4, 7]]);
  complete(J(4)); file(T(4));
  assert.equal(rows(4), '10/-/false/job 0/6/true/blend_ticket 3/4/true/blend_ticket');
  balance(4, 13, 'case 4, job 10 then one ticket with lines 6 and 7');

  // 5. Ticket 5 then two job lines (4, 6): credit goes first in line order.
  job(5, [[5, 4], [5, 6]]); ticket(5, 5, [[5, 5]]);
  file(T(5)); complete(J(5));
  assert.equal(rows(5), '5/-/false/blend_ticket 0/4/true/job 5/1/true/job');
  balance(5, 10, 'case 5, ticket 5 then job lines 4 and 6');

  // 6. Unlinked ticket, and a ticket on a job still open: full move, no flag.
  job(6, [[6, 9]]); ticket(6, null, [[6, 5]]); ticket(61, 6, [[6, 4]]);
  file(T(6)); file(T(61));
  assert.equal(rows(6), '5/-/false/blend_ticket 4/-/false/blend_ticket');
  balance(6, 9, 'case 6, unlinked ticket 5 and open-job ticket 4');

  // 7. Pints on a gallons product: claims compare in gallons (16 pt = 2 gal; job 3 gal moves 1).
  job(7, [[7, 3]]); ticket(7, 7, [[7, 16, 'Pt']]);
  file(T(7)); complete(J(7));
  assert.equal(rows(7), '2/-/false/blend_ticket 1/2/true/job');
  balance(7, 3, 'case 7, 16 pints ticket then 3 gallon job');

  // 8. A customer-supplied job line: no row, the ticket's take stands.
  job(8, [[8, 10, 'Gal', true]]); ticket(8, 8, [[8, 5]]);
  file(T(8)); complete(J(8));
  assert.equal(rows(8), '5/-/false/blend_ticket');
  balance(8, 5, 'case 8, ticket 5 and a customer-supplied job line');

  // Multi-product: ticket (P_a 3, P_b 6) then job (P_a 10, P_b 4).
  job(10, [['a', 10], ['b', 4]]); ticket(10, 10, [['a', 3], ['b', 6]]);
  file(T(10)); complete(J(10));
  assert.equal(rows('a'), '3/-/false/blend_ticket 7/3/true/job');
  assert.equal(rows('b'), '6/-/false/blend_ticket 0/4/true/job');
  assert.notEqual(scalar(`SELECT count(*) FROM public.activity_feed WHERE description LIKE '%2 chemical line(s) already counted by blend tickets — review%';`), '0', 'the completion activity names the counted lines');
  balance('a', 10, 'multi-product, product A'); balance('b', 6, 'multi-product, product B');

  // 9. A filed ticket's job link stays frozen (existing trg_linked_blend_ticket_header_lock), open or completed job.
  refused(USERS.rep, relinkSql(T(1), J(6)), /BLEND_TICKET_DOWNSTREAM_CONTENT_LOCKED/);
  refused(USERS.rep, relinkSql(T(61), J(1)), /BLEND_TICKET_DOWNSTREAM_CONTENT_LOCKED/);
  refused(USERS.rep, relinkSql(T(6), J(6)), /BLEND_TICKET_DOWNSTREAM_CONTENT_LOCKED/);  // unlinked → open job
  console.log('[COUNT-ONCE] case 9, a filed ticket cannot change job (existing header lock)');

  // An unfiled ticket moved between open jobs: job A (2), job B (10); ticket 6 moves A → B, then filed; A takes 2, B takes 4.
  job(91, [['c', 2]]); job(92, [['c', 10]]); ticket(91, 91, [['c', 6]]);
  ok(USERS.rep, relinkSql(T(91), J(92))); file(T(91));
  complete(J(91)); complete(J(92));
  assert.equal(rows('c'), '6/-/false/blend_ticket 2/-/false/job 4/6/true/job');
  balance('c', 12, 'ticket 6 moved from open job A (2) to open job B (10) before filing');

  // 10. Reversal: refused for a counted ticket; allowed for an unlinked one; a reversed ticket leaves the group.
  refused(USERS.admin, reverseSql(T(1)), /APPLICATION_RECORD_COUNTED_WITH_JOB/);
  balance(1, 10, 'case 10, refused reversal changed nothing');
  ok(USERS.admin, reverseSql(T(6)));
  balance(6, 4, 'case 10, unlinked ticket 5 reversed');
  job(9, [[9, 10]]); ticket(9, 9, [[9, 6]]);
  file(T(9)); ok(USERS.admin, reverseSql(T(9))); complete(J(9));
  assert.equal(rows(9), '6/-/false/none 10/-/false/job');  // the reversed record is gone
  balance(9, 10, 'case 10, ticket reversed before its job completes; job takes its full 10');

  // Races: each must wait for the completion's lock, then act on the committed job record.
  job(11, [['d', 10]]); ticket(11, 11, [['d', 6]]);
  let b = await whileCompleting(J(11), USERS.rep, fileSql(T(11)));
  assert.equal(b.code, 0, b.text);
  assert.equal(rows('d'), '10/-/false/job 0/6/true/blend_ticket');
  balance('d', 10, 'race, ticket filed while its job completes');

  job(14, [['f', 10]]); ticket(14, 14, [['f', 6]]);
  file(T(14));
  b = await whileCompleting(J(14), USERS.admin, reverseSql(T(14)));
  assert.notEqual(b.code, 0, `the reversal must be refused after waiting: ${b.text}`);
  assert.match(b.text, /APPLICATION_RECORD_COUNTED_WITH_JOB/);
  balance('f', 10, 'race, reversal attempted while the job completes (refused)');

  // ROLLBACK: refused while counted rows exist; on a database with none it restores the previous bodies.
  const rollback = fs.readFileSync(ROLLBACK, 'utf8').replaceAll('\r\n', '\n');
  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/rollback.sql'], { input: rollback });
  r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/rollback.sql'], { allowFailure: true });
  assert.notEqual(r.status, 0); assert.match(out(r), /COUNT_ONCE_ROLLBACK_REFUSED: counted postings exist/);
  // Prover-only: clear the counted rows (triggers off) in the same transaction as the rollback, as if none had posted yet.
  docker(['exec', '-i', NAME, 'sh', '-c', `cat > /tmp/rollback-clean.sql`], {
    input: `SET session_replication_role = replica; DELETE FROM public.inventory_transactions WHERE already_counted IS NOT NULL; SET session_replication_role = origin;\n${rollback}` });
  r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/rollback-clean.sql'], { allowFailure: true });
  assert.equal(r.status, 0, `rollback applies: ${out(r)}`);
  assert.deepEqual([md5(SIG.job), md5(SIG.bt), md5(SIG.rev)], [PRE.job, PRE.bt, PRE.rev], 'previous bodies restored');
  assert.deepEqual(WRAPPERS.map(acl), wrapperAcl, 'wrapper grants unchanged after rollback');
  job(15, [[0, 1]]); complete(J(15));
  console.log('[COUNT-ONCE] ROLLBACK: refused once counted rows exist; otherwise restores the previous bodies, and a job still completes');

  console.log('JOB_TICKET_COUNT_ONCE_PROOF_PASS');
} finally {
  removeContainer();
}
