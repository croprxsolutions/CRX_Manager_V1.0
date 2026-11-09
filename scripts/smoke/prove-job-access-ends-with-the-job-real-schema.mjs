#!/usr/bin/env node
/**
 * Real-schema proof for 20261217100000_job_access_ends_with_the_job.sql (KI-01 part C / KI-73).
 *
 * Builds the checked-in production baseline plus every post-baseline migration BEFORE the candidate in a
 * network-disabled PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), turns row security on for
 * storage.objects as live has it, seeds one job per case and one row per job in each table read below
 * (job_chemicals, job_tag_assignments and job_loader_worksheets are not seeded: their select policies
 * use the same subquery on jobs and the migration's preflight pins their text; get_jobs_billed_customers
 * is checked only by the BODIES diff), then,
 * each read or call made as that signed-in user (role authenticated, JWT claims, row security on) and
 * rolled back:
 *   1. BEFORE: what each role reads (jobs, fields, job fields, customers, addresses, shares, completion
 *      info, completion records and their field and crew rows, attachments, attachment photos) and
 *      what each field role can do through start_job, complete_job, stage_offline_action,
 *      stamp_job_printed, get_job_fields_with_geojson, get_job_billed_customers, get_dispatched_list
 *      and get_dispatch_board_jobs; printed as a table;
 *   2. AUTOCOMMIT: run statement by statement the file stops at its preflight, nothing changed;
 *   3. the candidate applies as one transaction and prints POSTFLIGHT_OK; each replaced body differs
 *      from the replayed one only on the marked lines;
 *   4. AFTER: the same table, checked exactly: the whole-job applicator keeps a scheduled or in-progress
 *      job, and a completed/invoiced one completed in the last 7 days (jobs.completed_at, stamped by the new
 *      trigger, which ignores what a client sends), whatever its scheduled date and with or without a dispatch
 *      row, and loses the rest (cancelled, deleted, done 8+ days ago even when dated within 7 days or in the
 *      future); a dispatch-only applicator reads the rest of the job it is sent to but never a deleted one,
 *      nor its dispatch row; customer addresses read exactly as before for every role (Mason,
 *      2026-11-08: drivers keep the delivery address); admin and sales rep get exactly what they got before;
 *   5. RE-APPLY: refused by the preflight.
 *
 * Run: node scripts/smoke/prove-job-access-ends-with-the-job-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a container built up to (not including) the candidate: UNDO_PATHS_CONTAINER=<name> JOB_ACCESS_PROOF_REUSE=1
 * Prints JOB_ACCESS_ENDS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, scalar, psql, attempt, id, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20261217100000_job_access_ends_with_the_job.sql';
const reuse = process.env.JOB_ACCESS_PROOF_REUSE === '1';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');

const W = USERS.applicator; // whole-job applicator
const D = id('b1');         // dispatch-only applicator
const X = id('b2');         // applicator sent to nothing
const OFF = id('b3');       // deactivated applicator, whole-job applicator of job 8
const RECIP = id('b4');     // entity_recipient
const ROLES = { admin: USERS.admin, rep: USERS.rep, W, D, X, OFF, driver: USERS.driver, recip: RECIP };

// Job n has id(100+n), customer id(200+n), field id(300+n), job_fields id(400+n), share id(500+n),
// completion info id(600+n), record id(700+n), record field id(800+n), crew id(900+n),
// attachment id(1000+n), address id(1100+n), dispatch id(1200+n). Customer 11 is the driver's delivery.
const JOBS = {
  1: { who: W, status: 'scheduled', days: 0, note: 'scheduled' },
  2: { who: W, status: 'completed', days: -2, done: 2, note: 'completed 2 days ago' },
  3: { who: W, status: 'completed', days: -10, done: 10, note: 'completed 10 days ago' },
  4: { who: W, status: 'cancelled', days: 0, note: 'cancelled' },
  5: { who: W, status: 'scheduled', days: 0, deleted: true, note: 'scheduled, deleted' },
  6: { who: W, status: 'invoiced', days: -1, done: 1, note: 'invoiced yesterday' },
  7: { who: W, status: 'in_progress', days: 0, deleted: true, note: 'in progress, deleted' },
  8: { who: OFF, status: 'scheduled', days: 0, note: 'deactivated applicator' },
  9: { who: null, dispatch: D, status: 'scheduled', days: 0, note: 'dispatch-only' },
  10: { who: null, dispatch: D, status: 'scheduled', days: 0, deleted: true, note: 'dispatch-only, deleted' },
  // 11 is the driver's delivery customer, so the next job case is 12.
  12: { who: W, status: 'completed', days: 30, done: 8, note: 'done 8 days ago, dated in 30 days' },
  13: { who: W, status: 'completed', days: 30, done: 0, note: 'done today, dated in 30 days' },
  // An office override cancels a job after its dispatch completed: the terminal trigger leaves the row completed.
  14: { who: null, dispatch: D, dispatchStatus: 'completed', done: 1, status: 'cancelled', days: 0, note: 'dispatch done yesterday, job then cancelled' },
  // Sol, 2026-11-08: a scheduled date near today must not reopen an old job, nor an old date close a fresh one.
  15: { who: W, status: 'completed', days: 3, done: 10, note: 'done 10 days ago, dated in 3 days' },
  16: { who: W, status: 'completed', days: -20, done: 0, noDispatch: true, note: 'done today, dated 20 days ago, no dispatch row' },
  // Sol, 2026-11-08 (round 2): a finished job's dispatch access ends 7 days after the job, whatever the row says:
  // an office override to invoiced leaves the row open; editing a completed row moves its updated_at.
  17: { who: null, dispatch: D, status: 'invoiced', days: 0, done: 10, note: 'office-invoiced 10 days ago, dispatch still open' },
  18: { who: null, dispatch: D, dispatchStatus: 'completed', status: 'completed', days: 0, done: 10, touched: 0, note: 'done 10 days ago, its dispatch row edited today' },
};
const uid = (n) => id(String(n));
const today = "((now() AT TIME ZONE 'America/Chicago')::date)";

function seed() {
  psql(`ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA storage TO authenticated; GRANT SELECT, INSERT, DELETE ON storage.objects TO authenticated;
    INSERT INTO storage.buckets (id, name) VALUES ('job-attachments', 'job-attachments') ON CONFLICT DO NOTHING;`, { user: 'supabase_admin' });
  if (scalar(`SELECT count(*) FROM public.jobs WHERE id = '${uid(101)}';`) === '1') return;
  if (scalar(`SELECT count(*) FROM auth.users WHERE id = '${USERS.admin}';`) === '0') seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${D}', 'ki73-d@example.invalid', '{"full_name":"[KI73] Dispatch","role":"applicator"}'::jsonb),
    ('${X}', 'ki73-x@example.invalid', '{"full_name":"[KI73] Other","role":"applicator"}'::jsonb),
    ('${OFF}', 'ki73-off@example.invalid', '{"full_name":"[KI73] Off","role":"applicator"}'::jsonb),
    ('${RECIP}', 'ki73-r@example.invalid', '{"full_name":"[KI73] Recipient","role":"entity_recipient"}'::jsonb)
    ON CONFLICT DO NOTHING;`);
  // The profile role lock is a trigger, so these run in the replica block below.
  const rows = [`UPDATE public.profiles SET role = 'entity_recipient' WHERE id = '${RECIP}';
    UPDATE public.profiles SET is_active = false WHERE id = '${OFF}';`];
  for (const [k, j] of Object.entries(JOBS)) {
    const n = Number(k);
    rows.push(`INSERT INTO public.customers (id, farm_name) VALUES ('${uid(200 + n)}', '[KI73] Farm ${n}');
      INSERT INTO public.customer_addresses (id, customer_id) VALUES ('${uid(1100 + n)}', '${uid(200 + n)}');
      INSERT INTO public.fields (id, customer_id, field_name) VALUES ('${uid(300 + n)}', '${uid(200 + n)}', 'F${n}');
      INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, applicator_id, deleted_at)
        VALUES ('${uid(100 + n)}', 'KI73-${n}', '${uid(200 + n)}', ${today} + ${j.days}, '${j.status}',
                ${j.who ? `'${j.who}'` : 'NULL'}, ${j.deleted ? 'now()' : 'NULL'});
      INSERT INTO public.job_fields (id, job_id, field_id) VALUES ('${uid(400 + n)}', '${uid(100 + n)}', '${uid(300 + n)}');
      INSERT INTO public.job_field_shares (id, job_id, field_id, customer_id, split_pct) VALUES ('${uid(500 + n)}', '${uid(100 + n)}', '${uid(300 + n)}', '${uid(200 + n)}', 100);
      INSERT INTO public.job_applied_info (id, job_id) VALUES ('${uid(600 + n)}', '${uid(100 + n)}');
      INSERT INTO public.job_applied_records (id, job_id, application_date) VALUES ('${uid(700 + n)}', '${uid(100 + n)}', ${today});
      INSERT INTO public.job_applied_record_fields (id, application_record_id, field_id) VALUES ('${uid(800 + n)}', '${uid(700 + n)}', '${uid(300 + n)}');
      INSERT INTO public.job_applied_record_crew (id, application_record_id, member_name_snapshot) VALUES ('${uid(900 + n)}', '${uid(700 + n)}', 'crew ${n}');
      INSERT INTO public.job_attachments (id, job_id, storage_path, file_name) VALUES ('${uid(1000 + n)}', '${uid(100 + n)}', '${uid(100 + n)}/a.jpg', 'a.jpg');
      INSERT INTO storage.objects (bucket_id, name) VALUES ('job-attachments', '${uid(100 + n)}/a.jpg');
      ${j.who && !j.noDispatch ? `INSERT INTO public.job_location_dispatches (id, job_field_id, job_id, applicator_id, dispatch_status, updated_at) VALUES ('${uid(1200 + n)}', '${uid(400 + n)}', '${uid(100 + n)}', '${j.who}', '${j.status === 'cancelled' ? 'cancelled' : j.done === undefined ? 'dispatched' : 'completed'}', now() - interval '${j.done ?? 0} days');` : ''}
      ${j.dispatch ? `INSERT INTO public.job_location_dispatches (id, job_field_id, job_id, applicator_id, dispatch_status, updated_at) VALUES ('${uid(1200 + n)}', '${uid(400 + n)}', '${uid(100 + n)}', '${j.dispatch}', '${j.dispatchStatus ?? 'dispatched'}', now() - interval '${j.touched ?? j.done ?? 0} days');` : ''}`);
  }
  // Customer 11: the driver's delivery today (the only customer a driver may see).
  rows.push(`INSERT INTO public.customers (id, farm_name) VALUES ('${uid(211)}', '[KI73] Driver farm');
    INSERT INTO public.customer_addresses (id, customer_id) VALUES ('${uid(1111)}', '${uid(211)}');
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, assigned_driver, scheduled_date)
      VALUES ('${uid(1311)}', 'KI73-D', '${uid(1411)}', '${uid(211)}', '${USERS.admin}', '${USERS.driver}', ${today});`);
  // Fixtures only: replica skips foreign keys and the job triggers, so each whole-job applicator's dispatch row is
  // written above as those triggers leave it: dispatched while open, cancelled with the job, completed (updated_at =
  // when the job was actually completed) for a completed or invoiced job.
  psql(`BEGIN; SET LOCAL session_replication_role = replica;\n${rows.join('\n')}\nCOMMIT;`);
  const roles = scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY id) FROM public.profiles WHERE id IN ('${D}','${X}','${OFF}','${RECIP}');`);
  assert.equal(roles, 'applicator:true,applicator:true,applicator:false,entity_recipient:true', 'extra profiles must land with their roles');
}

const probe = (who, body) => {
  const out = attempt(who, body);
  assert.ok(out.startsWith('ok|'), `probe as ${who} failed: ${out}`);
  return out.slice(3);
};

// What each table shows, as the list of case numbers its rows belong to.
const TABLES = {
  jobs: 'SELECT right(id::text, 4)::int - 100 FROM public.jobs',
  fields: 'SELECT right(id::text, 4)::int - 300 FROM public.fields',
  job_fields: 'SELECT right(job_id::text, 4)::int - 100 FROM public.job_fields',
  customers: 'SELECT right(id::text, 4)::int - 200 FROM public.customers',
  addresses: 'SELECT right(customer_id::text, 4)::int - 200 FROM public.customer_addresses',
  shares: 'SELECT right(job_id::text, 4)::int - 100 FROM public.job_field_shares',
  applied_info: 'SELECT right(job_id::text, 4)::int - 100 FROM public.job_applied_info',
  records: 'SELECT right(job_id::text, 4)::int - 100 FROM public.job_applied_records',
  record_fields: 'SELECT right(application_record_id::text, 4)::int - 700 FROM public.job_applied_record_fields',
  record_crew: 'SELECT right(application_record_id::text, 4)::int - 700 FROM public.job_applied_record_crew',
  attachments: 'SELECT right(job_id::text, 4)::int - 100 FROM public.job_attachments',
  photos: "SELECT right(split_part(name, '/', 1), 4)::int - 100 FROM storage.objects WHERE bucket_id = 'job-attachments'",
  dispatches: 'SELECT right(job_id::text, 4)::int - 100 FROM public.job_location_dispatches',
};
const seen = (who) => JSON.parse(probe(who, `SET LOCAL ROLE authenticated;
  v := json_build_object(${Object.entries(TABLES).map(([k, q]) => `'${k}', (SELECT COALESCE(string_agg(k::text, ',' ORDER BY k), '-') FROM (${q}) s(k))`).join(', ')})::text;
  RESET ROLE;`));

// One rolled-back sub-block per call; 'PROBE_OK' undoes a call that went through. A refusal on the job's
// status means the access check passed ('yes'); any other error is printed and fails the exact checks.
const call = (target, stmt, result) => `BEGIN SET LOCAL ROLE authenticated; ${stmt}; RAISE EXCEPTION 'PROBE_OK';
  EXCEPTION WHEN OTHERS THEN ${target} := CASE WHEN SQLERRM = 'PROBE_OK' THEN ${result}
    WHEN SQLERRM ~* '^(not.authorized|job not found)' THEN 'no'
    WHEN SQLERRM ~* 'current status' THEN 'yes' ELSE 'ERR:' || SQLERRM END; END;`;
const calls = (who, n) => probe(who, `
  ${call('f0', `PERFORM public.start_job('${uid(100 + n)}', '${who}', 'ki73-s-' || gen_random_uuid())`, "'yes'")}
  ${call('f1', `PERFORM public.complete_job('${uid(100 + n)}', '{}'::jsonb, '${who}', 'ki73-c-' || gen_random_uuid())`, "'yes'")}
  ${call('f2', `r := public.stage_offline_action(gen_random_uuid(), 'complete_job', '${uid(100 + n)}', 1, now(), '{}'::jsonb, 'ki73-o-' || gen_random_uuid(), NULL)`, "CASE WHEN r->>'failure_code' = 'NOT_AUTHORIZED' THEN 'no' ELSE 'yes' END")}
  ${call('t', `r2 := public.stamp_job_printed('${uid(100 + n)}', NULL)::jsonb`, "CASE WHEN (r2->>'success')::boolean THEN 'yes' ELSE 'no' END")}
  ${call('t2', `SELECT count(*) INTO n FROM public.get_job_fields_with_geojson('${uid(100 + n)}')`, "CASE WHEN n > 0 THEN 'yes' ELSE 'no' END")}
  v := concat_ws(' ', f0, f1, f2, t, t2);
  BEGIN SET LOCAL ROLE authenticated; PERFORM * FROM public.get_job_billed_customers('${uid(100 + n)}'); RESET ROLE; v := v || ' yes';
  EXCEPTION WHEN OTHERS THEN v := v || CASE WHEN SQLERRM ~* '^not.authorized' THEN ' no' ELSE ' ERR:' || SQLERRM END; END;`);
const CALLS = 'start complete offline print map billed';
const lists = (who) => probe(who, `SET LOCAL ROLE authenticated;
  v := concat_ws(' ',
    (SELECT COALESCE(string_agg(DISTINCT (right(x->>'job_id', 4)::int - 100)::text, ',' ORDER BY (right(x->>'job_id', 4)::int - 100)::text), '-') FROM public.get_dispatched_list(NULL, NULL) x),
    (SELECT COALESCE(string_agg(DISTINCT (right(x->>'id', 4)::int - 100)::text, ',' ORDER BY (right(x->>'id', 4)::int - 100)::text), '-') FROM public.get_dispatch_board_jobs('${who}') x));
  RESET ROLE;`);
// An applicator adding a photo record to the job (write policies that reach the job through jobs).
const canAttach = (who, n) => probe(who, `BEGIN SET LOCAL ROLE authenticated;
  INSERT INTO public.job_attachments (job_id, storage_path, file_name, uploaded_by) VALUES ('${uid(100 + n)}', '${uid(100 + n)}/b.jpg', 'b.jpg', '${who}');
  RAISE EXCEPTION 'PROBE_OK';
  EXCEPTION WHEN OTHERS THEN v := CASE WHEN SQLERRM = 'PROBE_OK' THEN 'yes' WHEN SQLERRM ~ 'row-level security' THEN 'no' ELSE 'ERR:' || SQLERRM END; END;`);

const FIELD_CASES = { W: [1, 2, 3, 4, 5, 6, 7, 12, 13, 15, 16], D: [9, 10, 14, 17, 18], X: [1], OFF: [8] };
function snapshot() {
  const reads = Object.fromEntries(Object.entries(ROLES).map(([r, u]) => [r, seen(u)]));
  const fns = {};
  for (const [r, cases] of Object.entries(FIELD_CASES)) for (const n of cases) fns[`${r} job ${n}`] = calls(ROLES[r], n);
  const dispatchLists = Object.fromEntries(['W', 'D', 'admin'].map((r) => [r, lists(ROLES[r])]));
  const attach = { 'W job 1': canAttach(W, 1), 'W job 4': canAttach(W, 4), 'D job 9': canAttach(D, 9) };
  return { reads, fns, dispatchLists, attach };
}
function print(label, s) {
  console.log(`\n=== ${label}: case numbers each role can read (- = none) ===`);
  console.log(['role'.padEnd(7), ...Object.keys(TABLES).map((t) => t.padEnd(14))].join(' '));
  for (const [r, row] of Object.entries(s.reads)) console.log([r.padEnd(7), ...Object.keys(TABLES).map((t) => String(row[t]).padEnd(14))].join(' '));
  console.log(`--- ${label}: field-role calls (${CALLS}) ---`);
  for (const [k, v] of Object.entries(s.fns)) console.log(`${k.padEnd(12)} ${v}   (${JOBS[k.split(' ').at(-1)].note})`);
  console.log(`--- dispatched list / dispatch board: ${JSON.stringify(s.dispatchLists)}; add attachment: ${JSON.stringify(s.attach)}`);
}

const bodies = () => JSON.parse(scalar(`SELECT json_object_agg(p.oid::regprocedure::text, p.prosrc) FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('_is_dispatched_to_me', '_can_see_field', '_start_job_replay_impl_20261015',
    '_complete_job_replay_impl_20261015', 'stage_offline_action', 'stamp_job_printed', 'get_job_fields_with_geojson',
    'get_jobs_billed_customers', 'get_job_billed_customers', 'get_dispatch_board_jobs', 'get_dispatched_list');`));

try {
  if (!reuse) buildContainer({ stopBefore: CANDIDATE });
  assert.equal(scalar("SELECT to_regprocedure('public._is_job_applicator(uuid)') IS NULL;"), 't', 'the container must not have the candidate yet');
  seed();

  const before = snapshot();
  print('BEFORE', before);
  const oldBodies = bodies();
  assert.equal(Object.keys(oldBodies).length, 11, 'eleven replaced functions, one overload each');

  // 2. Autocommit: statement by statement the preflight refuses before any change.
  const auto = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: candidate, allowFailure: true });
  assert.notEqual(auto.status, 0, 'an autocommit run must fail');
  assert.match(auto.stderr, /PREFLIGHT_FAIL: run this file as one transaction/);
  assert.equal(scalar("SELECT to_regprocedure('public._is_job_applicator(uuid)') IS NULL;"), 't', 'autocommit changed nothing');
  console.log('\nAUTOCOMMIT: refused by the preflight, nothing changed');

  // 3. Apply.
  const applied = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1'], { input: candidate, allowFailure: true });
  assert.equal(applied.status, 0, `apply failed:\n${applied.stderr}`);
  assert.match(applied.stderr, /POSTFLIGHT_OK/);
  console.log('APPLY: POSTFLIGHT_OK');
  const newBodies = bodies();
  for (const [sig, oldSrc] of Object.entries(oldBodies)) {
    const o = oldSrc.replaceAll('\r', '').split('\n');
    const nw = newBodies[sig].replaceAll('\r', '').split('\n');
    const added = nw.filter((l) => !o.includes(l));
    const removed = o.filter((l) => !nw.includes(l));
    assert.ok(added.length > 0, `${sig} unchanged`);
    for (const l of added) assert.match(l, /KI-73 part C|_is_job_applicator|j\.deleted_at IS NULL\)$|j\.status <> 'cancelled'\)$|^\s*-- completed before the job was cancelled|^\s*OR EXISTS \($|^\s*-- The whole-job applicator/, `${sig}: unexpected new line: ${l}`);
    for (const l of removed) assert.match(l, /applicator_id|is_applicator\(\)|JOIN public\.jobs j|deleted_at IS NULL\)\)$|-- The whole-job applicator|soft-deleted job\. Part C/, `${sig}: unexpected removed line: ${l}`);
  }
  console.log('BODIES: each replaced function differs only on its marked whole-job lines');

  // The completion clock: the server stamps it on reaching completed, and a client value never lands.
  const stamp = psql(`BEGIN;
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, completed_at)
      VALUES ('${uid(199)}', 'KI73-T', '${uid(201)}', ${today}, 'scheduled', now() - interval '1 day');
    SELECT 'STAMP_A:' || (completed_at IS NULL) FROM public.jobs WHERE id = '${uid(199)}';
    UPDATE public.jobs SET status = 'in_progress' WHERE id = '${uid(199)}';
    UPDATE public.jobs SET status = 'completed' WHERE id = '${uid(199)}';
    SELECT 'STAMP_B:' || (completed_at = now()) FROM public.jobs WHERE id = '${uid(199)}';
    UPDATE public.jobs SET completed_at = now() + interval '30 days' WHERE id = '${uid(199)}';
    SELECT 'STAMP_C:' || (completed_at = now()) FROM public.jobs WHERE id = '${uid(199)}';
    ROLLBACK;`).stdout;
  for (const mark of ['STAMP_A:true', 'STAMP_B:true', 'STAMP_C:true']) assert.ok(stamp.includes(mark), `completion stamp: ${mark} missing in\n${stamp}`);
  console.log('STAMP: NULL on insert whatever the client sends, server time on completion, client update ignored');
  // Fixtures were written with triggers off (before the column existed): stamp them as the trigger would have.
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    ${Object.entries(JOBS).filter(([, j]) => ['completed', 'invoiced'].includes(j.status)).map(([k, j]) => `UPDATE public.jobs SET completed_at = now() - interval '${j.done} days' WHERE id = '${uid(100 + Number(k))}';`).join('\n    ')}
    COMMIT;`);

  // 4. After.
  const after = snapshot();
  print('AFTER', after);
  for (const r of ['admin', 'rep']) assert.deepEqual(after.reads[r], before.reads[r], `${r} reads must not change`);
  const all = '1,2,3,4,5,6,7,8,9,10,12,13,14,15,16,17,18';
  assert.deepEqual(after.reads.admin, { jobs: all, fields: all, job_fields: all, customers: "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18", addresses: "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18",
    shares: all, applied_info: all, records: all, record_fields: all, record_crew: all, attachments: all, photos: all,
    dispatches: '1,2,3,4,5,6,7,8,9,10,12,13,14,15,17,18' });
  // Before: the open dispatch rows of deleted jobs (5, 7 and 10) and of job 17, invoiced 10 days ago, were readable by their dispatchee.
  assert.deepEqual([before.reads.W.dispatches, before.reads.D.dispatches], ['1,2,3,4,5,6,7,12,13,15', '9,10,17']);
  for (const r of Object.keys(ROLES)) assert.equal(after.reads[r].addresses, before.reads[r].addresses, `${r}: addresses unchanged`);
  const everyAddress = before.reads.admin.addresses;
  const job = (s) => ({ jobs: s, job_fields: s, shares: s, applied_info: s, records: s, record_fields: s, record_crew: s, attachments: s, photos: s });
  // Job 16's customer stays hidden: customers_select (unchanged) still asks for a scheduled date in the last 7 days.
  assert.deepEqual(after.reads.W, { ...job('1,2,6,13,16'), fields: '1,2,6,13,16', customers: '1,2,6,13', addresses: everyAddress, dispatches: '1,2,6,13' },
    'whole-job applicator keeps only jobs not yet done or done in the last 7 days, whatever their date');
  assert.deepEqual(after.reads.D, { ...job('9'), fields: '9', customers: '9', addresses: everyAddress, dispatches: '9' }, 'dispatch-only applicator reads the rest of the job, never a deleted or cancelled one');
  const none = { ...job('-'), fields: '-', customers: '-', addresses: '-', dispatches: '-' };
  for (const r of ['X', 'OFF', 'recip']) assert.deepEqual(after.reads[r], { ...none, addresses: before.reads[r].addresses }, `${r} reads no job`);
  assert.deepEqual(after.reads.driver, { ...job('-'), fields: '-', customers: '11', addresses: everyAddress, dispatches: '-' }, 'a driver reads their delivery customer and, as before, every address');
  // Calls: start/complete/offline/print/map/billed. The whole-job leg follows the window; dispatch never reaches a deleted job.
  const yes = 'yes yes yes yes yes yes', no = 'no no no no no no';
  assert.deepEqual(after.fns, {
    'W job 1': yes, 'W job 2': yes, 'W job 3': no, 'W job 4': no, 'W job 5': no, 'W job 6': yes, 'W job 7': no, 'W job 12': no,
    'W job 15': no, 'W job 16': yes,
    // Job 13 was completed today, so the whole-job leg admits it like job 2.
    'W job 13': yes,
    'D job 9': yes, 'D job 10': no, 'D job 14': no, 'D job 17': no, 'D job 18': no, 'X job 1': no, 'OFF job 8': before.fns['OFF job 8'],
  });
  // "<dispatched list> <dispatch board>" per applicator; the board never showed deleted jobs.
  assert.deepEqual(before.dispatchLists, { W: '1,13,2,6 1,12,13,15,16,2,3,4,6', D: '14,17,18,9 17,9', admin: '1,13,14,17,18,2,6,8,9 -' }); // text order
  assert.deepEqual(after.dispatchLists, { W: '1,13,2,6 1,13,16,2,6', D: '9 9', admin: '1,13,17,18,2,6,8,9 -' }, 'the board drops the ended jobs; office staff still list a dispatch left open on an old invoiced job (17)');
  assert.deepEqual(before.attach, { 'W job 1': 'yes', 'W job 4': 'yes', 'D job 9': 'no' }, 'before: the whole-job applicator writes to a cancelled job');
  assert.deepEqual(after.attach, { 'W job 1': 'yes', 'W job 4': 'no', 'D job 9': 'no' }, 'writes reaching the job through jobs inherit the window; dispatch stays read-only');

  // 5. Re-apply.
  const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1'], { input: candidate, allowFailure: true });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists \(already applied\?\)/);
  console.log('RE-APPLY: refused by the preflight');
  console.log('\nJOB_ACCESS_ENDS_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
