#!/usr/bin/env node
/**
 * Real-schema proof for 20270225120000_offline_job_lock_no_key_update.sql (#2257).
 * Contract: docs/plans/2026-11-23-offline-job-lock-no-key-CONTRACT.md.
 *
 * Builds the production schema baseline plus every post-baseline migration before the candidate in a
 * network-disabled container (scripts/smoke/undo-paths/harness.mjs), then:
 *   - checks the candidate and #2170's migration (20270224170000, read from disk or its branch) apply in
 *     either order;
 *   - with #2170 applied, forces the sibling schedule (the direct completion holds the record-number lock,
 *     the offline completion holds its job and waits for that lock, then the direct one's booking sync
 *     references the offline job): the old lock deadlocks, the new one lets both finish with one
 *     application, one stock move and one draw per job;
 *   - same job raced offline-versus-direct (other key and same key), and an office edit in progress;
 *   - autocommit and second-apply refusals leave the body unchanged; rollback restores the old body.
 *
 * Run: node scripts/smoke/prove-offline-job-lock-no-key-update-real-schema.mjs   (needs Docker)
 * Prints OFFLINE_JOB_LOCK_PROOF_PASS on success. UNDO_PATHS_CONTAINER=<name> + CRX_PROVER_KEEP_CONTAINER=1 keeps it.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  ROOT, NAME, buildContainer, seedUsers, docker, psql, scalar, removeContainer, USERS,
} from './undo-paths/harness.mjs';

const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const CANDIDATE_NAME = '20270225120000_offline_job_lock_no_key_update.sql';
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', CANDIDATE_NAME);
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'offline-job-lock-no-key-update-reverse.sql');
const PR2170_NAME = '20270224170000_job_completion_missing_stock_rows.sql';
const PR2170_BRANCH = 'origin/cursor/job-completion-missing-stock-rows-a348';
const OLD_MD5 = '0461eebf65f23ccc8fe3852375eb9c78';
const NEW_MD5 = '6e3a3d8e5d3528c5c4b29ac132c1490d';
const ADMIN = USERS.admin;

const lf = (text) => text.replaceAll('\r\n', '\n');
function pr2170() {
  const onDisk = path.join(ROOT, 'supabase', 'migrations', PR2170_NAME);
  if (existsSync(onDisk)) return lf(readFileSync(onDisk, 'utf8'));
  const r = spawnSync('git', ['show', `${PR2170_BRANCH}:supabase/migrations/${PR2170_NAME}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, `#2170's migration is neither on disk nor on ${PR2170_BRANCH}: ${r.stderr}`);
  return lf(r.stdout);
}
function stage(name, text) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  writeFileSync(staged, text, 'utf8');
  try { docker(['cp', staged, `${NAME}:/tmp/${name}`]); } finally { unlinkSync(staged); }
}
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
function run(name, { single = true } = {}) {
  const r = docker([...PSQL, ...(single ? ['-1'] : []), '-f', `/tmp/${name}`], { allowFailure: true });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
const fnState = () => scalar(`SELECT md5(replace(prosrc, chr(13), '')) || ',' || prosecdef || ',' || array_to_string(proconfig, ';')
  || ',' || pg_get_userbyid(proowner) || ',' || proacl::text FROM pg_proc WHERE oid = 'public.process_offline_action(uuid,text)'::regprocedure;`);

// A real concurrent session (its own connection), started after delayMs.
function session(sql, delayMs = 0) {
  return new Promise((resolve) => setTimeout(() => {
    const c = spawn('docker', [...PSQL, '-A', '-t'], { cwd: ROOT });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
    c.stdin.end(sql);
  }, delayMs));
}
const STAMP = (k) => `SELECT '${k} ' || extract(epoch FROM clock_timestamp());`;
const at = (out, k) => Number((out.match(new RegExp(`^${k} ([0-9.]+)$`, 'm')) ?? [])[1]);
const signedIn = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', false);
  SELECT set_config('request.jwt.claim.sub', '${ADMIN}', false); SET ROLE authenticated;`;
const ids = (n) => `22570000-0000-4000-8000-${Buffer.from(String(n)).toString('hex').padStart(12, '0')}`; // hex-encode the tag: any label, valid uuid
const CUST = ids('c1');
const P = ids('b1');

function seedBooking(tag, quote, jobs) {
  // Fixture rows only, in replica mode: the quote send and price guards are not what this proves. The draws below
  // come from the real booking sync, and the completions run every normal trigger.
  psql(`SET session_replication_role = replica;
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by, status, is_planned)
      VALUES ('${quote}', '2257-${tag}', '${CUST}', '${ADMIN}', 'sent', true);
    INSERT INTO public.quote_sections (id, quote_id) VALUES ('${ids(`5${tag}`)}', '${quote}');
    INSERT INTO public.quote_items (quote_id, section_id, product_id, total_units_needed)
      VALUES ('${quote}', '${ids(`5${tag}`)}', '${P}', 10);
    ${jobs.map((j, i) => `INSERT INTO public.jobs (id, job_number, customer_id, job_date, quote_id, status, created_by)
      VALUES ('${j}', '2257-${tag}-${i}', '${CUST}', current_date, '${quote}', 'in_progress', '${ADMIN}');
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, sort_order, customer_supplied)
      VALUES ('${j}', '${P}', 1, 'Gal', 1, false);`).join('\n')}
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  // Build the booking's draws through the real sync, signed in.
  psql(`SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', false); SELECT public._sync_quote_job_reservations('${quote}', NULL);`);
  for (const j of jobs) {
    assert.equal(scalar(`SELECT count(*) FROM public.job_product_draws WHERE job_id = '${j}';`), '1', `${tag}: every active job on the booking draws`);
  }
}
function receipt(action, job, key) {
  psql(`INSERT INTO public.offline_action_receipts (client_action_id, actor_id, operation, entity_id, schema_version,
      client_created_at, entity_snapshot_at, request_payload, idempotency_key)
    SELECT '${action}', '${ADMIN}', 'complete_job', '${job}', 1, now(), j.updated_at, '{}'::jsonb, '${key}'
      FROM public.jobs j WHERE j.id = '${job}';`);
}
const offlineCall = (action, key) => `SELECT 'O ' || public.process_offline_action('${action}', '${key}')::text;`;
const directCall = (job, key) => `SELECT 'D ' || public.complete_job('${job}', '{}'::jsonb, '${ADMIN}', '${key}')::text;`;
const receiptState = (action) => scalar(`SELECT status || '/' || attempt_count || '/' || coalesce(failure_code, '-') FROM public.offline_action_receipts WHERE client_action_id = '${action}';`);
const sideEffects = (job) => scalar(`SELECT (SELECT status FROM public.jobs WHERE id = '${job}')
  || '/' || (SELECT count(*) FROM public.inventory_transactions WHERE job_id = '${job}' AND transaction_type = 'job_applied')
  || '/' || (SELECT count(*) FROM public.application_records WHERE source_id = '${job}')
  || '/' || (SELECT count(*) FROM public.job_product_draws WHERE job_id = '${job}');`);

// The schedule Astra asked for: B holds the booking, so the direct completion of J2 takes the record-number
// lock and then waits; the offline completion of J1 takes its job and waits for the number lock; B lets go
// and the direct completion's sync rebuilds J1's draw (a foreign-key check on J1).
async function siblingRace(quote, j1, j2, action, key) {
  const [b, d, o] = await Promise.all([
    session(`BEGIN; SELECT 1 FROM public.quotes WHERE id = '${quote}' FOR UPDATE; SELECT pg_sleep(3); COMMIT;`),
    session(`${signedIn} BEGIN; ${STAMP('S')} ${directCall(j2, `direct-${j2}`)} ${STAMP('E')} COMMIT;`, 500),
    session(`${signedIn} BEGIN; ${STAMP('S')} ${offlineCall(action, key)} ${STAMP('E')} COMMIT;`, 1300),
  ]);
  assert.equal(b.code, 0, b.out);
  return { d, o, all: `${d.out}\n${o.out}` };
}

async function main() {
  buildContainer({ stopBefore: CANDIDATE_NAME });
  seedUsers();
  assert.equal(fnState().split(',')[0], OLD_MD5, 'the replayed process_offline_action is not the body the candidate pins');
  const before = fnState();
  psql(`INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] 2257 Farm', true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, is_active)
      VALUES ('${P}', '[PROVER] 2257 Product', '2257-P', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, true);
    INSERT INTO public.inventory (product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES ('${P}', 'Main Warehouse', 'Gal', 100, 0, 0);`);
  stage('candidate.sql', lf(readFileSync(CANDIDATE, 'utf8')));
  stage('reverse.sql', lf(readFileSync(REVERSE, 'utf8')));
  stage('pr2170.sql', pr2170());

  // 1. Refusals leave nothing behind; merge order with #2170 does not matter.
  const auto = run('candidate.sql', { single: false });
  assert.notEqual(auto.status, 0, 'an autocommit run must refuse');
  assert.match(auto.output, /PREFLIGHT_FAIL: run this file as one transaction/);
  assert.equal(fnState(), before, 'a refused autocommit run must change nothing');
  stage('order.sql', `BEGIN;\n\\i /tmp/candidate.sql\n\\i /tmp/pr2170.sql\nSELECT 'ORDER_OK';\nROLLBACK;\n`);
  const order = run('order.sql', { single: false });
  assert.equal(order.status, 0, order.output);
  assert.match(order.output, /POSTFLIGHT_OK: offline job completion/);
  assert.match(order.output, /ORDER_OK/);
  assert.equal(fnState(), before);
  console.log('[case] an autocommit run refuses and changes nothing; the candidate then #2170 apply in one go (rolled back)');

  const applied2170 = run('pr2170.sql');
  assert.equal(applied2170.status, 0, applied2170.output);
  console.log('[prover] #2170 applied (complete_job takes the job FOR NO KEY UPDATE, then the record-number lock)');

  // A job completed alone sets the expected side effects (stock move / application record / draw).
  const [QC, JC] = [ids('qc'), ids('c9')];
  seedBooking('c', QC, [JC]);
  psql(`${signedIn} ${directCall(JC, 'control')}`);
  const DONE = sideEffects(JC);
  assert.match(DONE, /^completed\/1\/[01]\/1$/,`a job completed alone: ${DONE}`);
  console.log(`[prover] a job completed alone: status/stock moves/application records/draws = ${DONE}`);

  // 2. BEFORE: the old lock deadlocks the sibling schedule.
  const [Q1, J1, J2, A1] = [ids('q1'), ids('11'), ids('12'), ids('e1')];
  seedBooking('1', Q1, [J1, J2]);
  receipt(A1, J1, 'off-before');
  const old = await siblingRace(Q1, J1, J2, A1, 'off-before');
  assert.match(old.all, /deadlock detected/, `the old lock must deadlock the sibling schedule:\n${old.all}`);
  assert.ok(at(old.o.out, 'S') < at(old.d.out, 'E') || old.d.code !== 0, `the two completions must overlap:\n${old.all}`);
  if (old.o.code !== 0) {
    assert.equal(receiptState(A1), 'received/0/-', 'a deadlocked offline call leaves its receipt received, attempt rolled back');
    assert.equal(sideEffects(J1), 'in_progress/0/0/1');
  }
  console.log(`[case] before: the sibling schedule deadlocks (${old.o.code !== 0 ? 'offline' : 'direct'} call cancelled)`);

  // 3. Apply; second apply refuses and changes nothing.
  const first = run('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /POSTFLIGHT_OK/);
  const after = fnState();
  assert.deepEqual(after.split(',').slice(1), before.split(',').slice(1), 'owner, security, search_path and grants unchanged');
  assert.equal(after.split(',')[0], NEW_MD5);
  const again = run('candidate.sql');
  assert.notEqual(again.status, 0);
  assert.match(again.output, /OFFLINE_JOB_LOCK_BASELINE_DRIFT/);
  assert.equal(fnState(), after);
  console.log('[case] the candidate applies once (owner, SECURITY DEFINER, search_path, grants unchanged); a second apply refuses and changes nothing');

  // 4. AFTER: same schedule on a fresh booking, both finish; side effects match a serial run.
  const [Q2, J3, J4, A2] = [ids('q2'), ids('21'), ids('22'), ids('e2')];
  seedBooking('2', Q2, [J3, J4]);
  receipt(A2, J3, 'off-after');
  const onHandBefore = Number(scalar(`SELECT quantity_available FROM public.inventory WHERE product_id = '${P}' AND location = 'Main Warehouse';`));
  const neu = await siblingRace(Q2, J3, J4, A2, 'off-after');
  assert.ok(!/deadlock detected/i.test(neu.all), `no deadlock expected:\n${neu.all}`);
  assert.equal(neu.d.code, 0, neu.d.out);
  assert.equal(neu.o.code, 0, neu.o.out);
  assert.ok(at(neu.o.out, 'S') < at(neu.d.out, 'E'), `the two completions must overlap:\n${neu.all}`);
  assert.equal(receiptState(A2), 'succeeded/1/-');
  assert.equal(sideEffects(J3), DONE);
  assert.equal(sideEffects(J4), DONE);
  assert.equal(Number(scalar(`SELECT quantity_available FROM public.inventory WHERE product_id = '${P}' AND location = 'Main Warehouse';`)), onHandBefore - 2);
  console.log('[case] after: the same schedule finishes both; the receipt succeeded once; each job has one stock move, one application record and one draw; on-hand drops by exactly 2');

  // 5. Same job, offline holding it first, direct with another key, then with the receipt's own key.
  for (const [n, sameKey] of [['31', false], ['32', true]]) {
    const [Q, J, A] = [ids(`q${n}`), ids(n), ids(`e${n}`)];
    seedBooking(n, Q, [J]);
    receipt(A, J, `off-${n}`);
    const [o, d] = await Promise.all([
      session(`${signedIn} BEGIN; ${STAMP('S')} ${offlineCall(A, `off-${n}`)} SELECT pg_sleep(1.5); ${STAMP('E')} COMMIT;`),
      session(`${signedIn} BEGIN; ${STAMP('S')} ${directCall(J, sameKey ? `off-${n}` : `direct-${n}`)} ${STAMP('E')} COMMIT;`, 400),
    ]);
    const both = `${o.out}\n${d.out}`;
    assert.ok(!/deadlock detected/i.test(both), both);
    assert.equal(o.code, 0, o.out);
    // It waited: either it finished after the offline call, or it was refused because it saw the job already completed.
    assert.ok(at(d.out, 'E') >= at(o.out, 'E') || (d.code !== 0 && /Current status: completed/.test(d.out)),
      `the direct call must wait for the offline one:\n${both}`);
    assert.equal(receiptState(A), 'succeeded/1/-');
    assert.equal(sideEffects(J), DONE, both);
    console.log(`[case] same job, ${sameKey ? 'same key' : 'another key'}: the direct call waits, the job completes once (direct ${d.code === 0 ? 'returned' : 'refused'})`);
  }

  // 6. An office edit in progress: the offline call waits for it, then goes to office review.
  const [Q6, J6, A6] = [ids('q6'), ids('61'), ids('e6')];
  seedBooking('6', Q6, [J6]);
  receipt(A6, J6, 'off-6');
  const [edit, off] = await Promise.all([
    session(`BEGIN; ${STAMP('S')} UPDATE public.jobs SET notes = '[PROVER] office edit' WHERE id = '${J6}'; SELECT pg_sleep(2); ${STAMP('E')} COMMIT;`),
    session(`${signedIn} BEGIN; ${STAMP('S')} ${offlineCall(A6, 'off-6')} ${STAMP('E')} COMMIT;`, 400),
  ]);
  assert.equal(edit.code, 0, edit.out);
  assert.equal(off.code, 0, off.out);
  assert.ok(at(off.out, 'E') >= at(edit.out, 'E'), `the offline call must wait for the edit:\n${edit.out}\n${off.out}`);
  assert.match(off.out, /TARGET_STATE_CONFLICT/);
  assert.equal(receiptState(A6), 'needs_review/0/TARGET_STATE_CONFLICT');
  assert.equal(sideEffects(J6), 'in_progress/0/0/1');
  console.log('[case] an office edit in progress: the offline call waits, then lands in office review without completing the job');

  // 7. Rollback restores the old body exactly; a second run refuses and changes nothing.
  const autoReverse = run('reverse.sql', { single: false });
  assert.notEqual(autoReverse.status, 0);
  assert.equal(fnState(), after, 'a refused autocommit rollback must change nothing');
  const rolled = run('reverse.sql');
  assert.equal(rolled.status, 0, rolled.output);
  assert.equal(fnState(), before, 'rollback restores the old body, owner, security, search_path and grants');
  const rolledAgain = run('reverse.sql');
  assert.notEqual(rolledAgain.status, 0);
  assert.equal(fnState(), before);
  console.log('[case] rollback refuses autocommit, restores the 20260714203709 body and grants, and refuses a second run');

  console.log('OFFLINE_JOB_LOCK_PROOF_PASS');
}

try { await main(); } finally { if (!KEEP) removeContainer(); }
