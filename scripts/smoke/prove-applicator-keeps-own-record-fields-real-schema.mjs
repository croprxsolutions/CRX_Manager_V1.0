#!/usr/bin/env node
/**
 * Real-schema proof for 20261220100000_applicator_keeps_own_record_fields.sql (Taha's review of #1650).
 *
 * Builds the checked-in production baseline plus every post-baseline migration BEFORE the candidate (so
 * 20261217100000_job_access_ends_with_the_job is in) in a network-disabled PostgreSQL container
 * (scripts/smoke/undo-paths/harness.mjs), seeds synthetic jobs and spray records, then reads as each
 * signed-in user (role authenticated, JWT claims, row security on):
 *   MED  W's own spray record on job 1, completed 30 days ago, covering fields 1 and 2: BEFORE W reads the
 *        record but not its fields or field rows (Record Book shows "-"); AFTER W reads both. W never reads
 *        X's record field (3); D, not on the record, reads none; admin and rep read exactly what they did.
 *        A deactivated applicator who performed a record (6) and a driver gain nothing. Boundary parts
 *        (field_polygons) follow fields; billing defaults keep the 7-day window.
 *   LOW  job 2: W is the whole-job applicator, its field is dispatched to D only (W holds no dispatch row),
 *        dated 20 days ago, in progress. W reads it, completes it (real status update, the server stamps
 *        jobs.completed_at), and still reads it and its job field; job 4, same shape but completed 8 days
 *        ago, stays hidden from W (the window still ends).
 *   Autocommit is refused by the preflight; apply prints POSTFLIGHT_OK; re-apply is refused.
 *
 * Run: node scripts/smoke/prove-applicator-keeps-own-record-fields-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a container built up to (not including) the candidate: UNDO_PATHS_CONTAINER=<name> OWN_RECORD_PROOF_REUSE=1
 * Prints OWN_RECORD_FIELDS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, scalar, psql, attempt, id, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20261220100000_applicator_keeps_own_record_fields.sql';
const PARENT = '20261217100000_job_access_ends_with_the_job.sql';
const reuse = process.env.OWN_RECORD_PROOF_REUSE === '1';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');

const W = USERS.applicator; // whole-job applicator, performed record 1
const D = id('c1');         // applicator dispatched to jobs 2 and 4
const X = id('c2');         // applicator who performed record 3
const OFF = id('c3');       // deactivated applicator who performed record 6
const ROLES = { admin: USERS.admin, rep: USERS.rep, W, D, X, OFF, driver: USERS.driver };
const uid = (n) => id(String(n));
const today = "((now() AT TIME ZONE 'America/Chicago')::date)";
const run = (sql) => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...sql.flags], { input: candidate, allowFailure: true });

// Field n is id(300+n); job n id(100+n); job field id(400+n); record id(700+n); record field id(800+n).
function seed() {
  if (scalar(`SELECT count(*) FROM public.jobs WHERE id = '${uid(101)}';`) === '1') return;
  if (scalar(`SELECT count(*) FROM auth.users WHERE id = '${USERS.admin}';`) === '0') seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${D}', 'own-d@example.invalid', '{"full_name":"[OWN] Dispatch","role":"applicator"}'::jsonb),
    ('${X}', 'own-x@example.invalid', '{"full_name":"[OWN] Other","role":"applicator"}'::jsonb),
    ('${OFF}', 'own-off@example.invalid', '{"full_name":"[OWN] Off","role":"applicator"}'::jsonb)
    ON CONFLICT DO NOTHING;`);
  const job = (n, who, status, days, doneDays, fields) => `
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, applicator_id, completed_at)
      VALUES ('${uid(100 + n)}', 'OWN-${n}', '${uid(201)}', ${today} + ${days}, '${status}', '${who}',
              ${doneDays === null ? 'NULL' : `now() - interval '${doneDays} days'`});
    ${fields.map((f) => `INSERT INTO public.job_fields (id, job_id, field_id) VALUES ('${uid(400 + f)}', '${uid(100 + n)}', '${uid(300 + f)}');`).join('\n')}`;
  const record = (n, who, fields) => `
    INSERT INTO public.application_records (id, record_number, source_type, source_id, customer_id, applicator_id, field_id, application_date)
      VALUES ('${uid(700 + n)}', 'OWN-R${n}', 'job', '${uid(100 + n)}', '${uid(201)}', '${who}', '${uid(300 + fields[0])}', ${today} - 30);
    ${fields.map((f) => `INSERT INTO public.application_record_fields (id, application_record_id, field_id, acres) VALUES ('${uid(800 + f)}', '${uid(700 + n)}', '${uid(300 + f)}', 10);`).join('\n')}`;
  // Fixtures only: replica skips foreign keys and triggers (the jobs' completed_at is written as the trigger would have).
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name) VALUES ('${uid(201)}', '[OWN] Farm');
    UPDATE public.profiles SET is_active = false WHERE id = '${OFF}';
    ${[1, 2, 3, 4, 5, 6].map((f) => `INSERT INTO public.fields (id, customer_id, field_name) VALUES ('${uid(300 + f)}', '${uid(201)}', 'F${f}');
      INSERT INTO public.field_polygons (field_id, polygon_geojson) VALUES ('${uid(300 + f)}', '{"type":"Polygon","coordinates":[]}'::jsonb);
      INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct) VALUES ('${uid(300 + f)}', '${uid(201)}', 100);`).join('\n')}
    ${job(1, W, 'completed', -30, 30, [1, 2])}
    ${record(1, W, [1, 2])}
    ${job(3, X, 'completed', -30, 30, [3])}
    ${record(3, X, [3])}
    ${job(6, OFF, 'completed', -30, 30, [6])}
    ${record(6, OFF, [6])}
    ${job(2, W, 'in_progress', -20, null, [4])}
    INSERT INTO public.job_location_dispatches (id, job_field_id, job_id, applicator_id, dispatch_status) VALUES ('${uid(1202)}', '${uid(404)}', '${uid(102)}', '${D}', 'dispatched');
    ${job(4, W, 'completed', -20, 8, [5])}
    INSERT INTO public.job_location_dispatches (id, job_field_id, job_id, applicator_id, dispatch_status, updated_at) VALUES ('${uid(1204)}', '${uid(405)}', '${uid(104)}', '${D}', 'completed', now() - interval '8 days');
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY id) FROM public.profiles WHERE id IN ('${D}','${X}','${OFF}');`), 'applicator:true,applicator:true,applicator:false');
}

const probe = (who, body) => {
  const out = attempt(who, body);
  assert.ok(out.startsWith('ok|'), `probe as ${who} failed: ${out}`);
  return out.slice(3);
};
const TABLES = {
  records: 'SELECT right(id::text, 4)::int - 700 FROM public.application_records',
  fields: 'SELECT right(id::text, 4)::int - 300 FROM public.fields',
  record_fields: 'SELECT right(field_id::text, 4)::int - 300 FROM public.application_record_fields',
  billing_defaults: 'SELECT right(field_id::text, 4)::int - 300 FROM public.field_billing_defaults',
  boundaries: 'SELECT right(field_id::text, 4)::int - 300 FROM public.field_polygons',
  jobs: 'SELECT right(id::text, 4)::int - 100 FROM public.jobs',
  job_fields: 'SELECT right(field_id::text, 4)::int - 300 FROM public.job_fields',
};
const seen = (who) => JSON.parse(probe(who, `SET LOCAL ROLE authenticated;
  v := json_build_object(${Object.entries(TABLES).map(([k, q]) => `'${k}', (SELECT COALESCE(string_agg(k::text, ',' ORDER BY k), '-') FROM (${q}) s(k))`).join(', ')})::text;
  RESET ROLE;`));
// Record Book's own read: the record with its field embedded (PostgREST's left join under fields_select).
const recordBook = (who) => probe(who, `SET LOCAL ROLE authenticated;
  v := (SELECT COALESCE(string_agg(ar.record_number || '=' || COALESCE(f.field_name, '-'), ',' ORDER BY ar.record_number), '-')
          FROM public.application_records ar LEFT JOIN public.fields f ON f.id = ar.field_id);
  RESET ROLE;`);
const snapshot = () => ({
  reads: Object.fromEntries(Object.entries(ROLES).map(([r, u]) => [r, seen(u)])),
  book: Object.fromEntries(['W', 'X', 'D', 'OFF'].map((r) => [r, recordBook(ROLES[r])])),
});

try {
  // 20261217100000's preflight needs row security on storage.objects, as live has it (the container's stub
  // has it off), so the build stops before it and it is applied here as one transaction.
  if (!reuse) buildContainer({ stopBefore: PARENT });
  if (scalar("SELECT to_regprocedure('public._is_job_applicator(uuid)') IS NULL;") === 't') {
    psql('ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;', { user: 'supabase_admin' });
    const parent = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1'],
      { input: readFileSync(path.join(ROOT, 'supabase', 'migrations', PARENT), 'utf8').replaceAll('\r\n', '\n'), allowFailure: true });
    assert.equal(parent.status, 0, `${PARENT} failed:\n${parent.stderr}`);
    assert.match(parent.stderr, /POSTFLIGHT_OK/);
  }
  assert.equal(scalar("SELECT to_regprocedure('public._is_job_applicator(uuid)') IS NOT NULL AND to_regprocedure('public._is_my_application_field(uuid)') IS NULL;"), 't',
    'the container must have 20261217100000 and not the candidate');
  seed();

  const before = snapshot();
  console.log('BEFORE', JSON.stringify(before, null, 1));
  // Taha's MED, reproduced: W reads their own record but not its fields.
  assert.equal(before.reads.W.records, '1');
  assert.equal(before.reads.W.fields, '4');
  assert.equal(before.reads.W.record_fields, '-');
  assert.equal(before.book.W, 'OWN-R1=-');

  const auto = run({ flags: [] });
  assert.notEqual(auto.status, 0, 'an autocommit run must fail');
  assert.match(auto.stderr, /PREFLIGHT_FAIL: run this file as one transaction/);
  assert.equal(scalar("SELECT to_regprocedure('public._is_my_application_field(uuid)') IS NULL;"), 't', 'autocommit changed nothing');
  console.log('AUTOCOMMIT: refused by the preflight, nothing changed');

  const applied = run({ flags: ['-1'] });
  assert.equal(applied.status, 0, `apply failed:\n${applied.stderr}`);
  assert.match(applied.stderr, /POSTFLIGHT_OK/);
  console.log('APPLY: POSTFLIGHT_OK');

  const after = snapshot();
  console.log('AFTER', JSON.stringify(after, null, 1));
  for (const r of ['admin', 'rep']) assert.deepEqual(after.reads[r], before.reads[r], `${r} reads must not change`);
  assert.deepEqual(after.reads.admin, { records: '1,3,6', fields: '1,2,3,4,5,6', record_fields: '1,2,3,6', billing_defaults: '1,2,3,4,5,6', boundaries: '1,2,3,4,5,6', jobs: '1,2,3,4,6', job_fields: '1,2,3,4,5,6' });
  // MED fixed: W reads the fields and field rows of their own 30-day-old record, nothing of X's, and the
  // other field tables keep the 7-day window (only job 2's field 4 is current). Boundary parts follow fields
  // (field_polygons_select reads fields under row security), as the header says.
  assert.deepEqual(after.reads.W, { records: '1', fields: '1,2,4', record_fields: '1,2', billing_defaults: '4', boundaries: '1,2,4', jobs: '2', job_fields: '4' });
  assert.equal(after.book.W, 'OWN-R1=F1');
  assert.deepEqual(after.reads.X, { records: '3', fields: '3', record_fields: '3', billing_defaults: '-', boundaries: '3', jobs: '-', job_fields: '-' });
  // A deactivated applicator who performed a record, and a driver, gain nothing.
  for (const r of ['OFF', 'driver']) assert.deepEqual(after.reads[r], before.reads[r], `${r} gains nothing`);
  assert.equal(after.reads.OFF.fields, '-');
  assert.equal(after.reads.driver.fields, '-');
  assert.equal(after.book.X, 'OWN-R3=F3');
  assert.deepEqual(after.reads.D, before.reads.D, 'an applicator on no record gains nothing');
  assert.deepEqual(after.reads.D, { records: '-', fields: '4', record_fields: '-', billing_defaults: '4', boundaries: '4', jobs: '2', job_fields: '4' });
  console.log('MED: the applicator keeps the field of their own 30-day-old spray record; nobody else gains anything');

  // LOW: W completes job 2 through the app's own call (complete_job, signed in as W, triggers on); W, the
  // whole-job applicator without a dispatch row, keeps it.
  const done = attempt(W, `SET LOCAL ROLE authenticated;
    PERFORM public.complete_job('${uid(102)}', '{}'::jsonb, '${W}', 'own-complete-' || gen_random_uuid());
    RESET ROLE;
    v := (SELECT (completed_at >= now() - interval '1 minute')::text FROM public.jobs WHERE id = '${uid(102)}') || ' ' ||
         (SELECT count(*) FROM public.job_location_dispatches WHERE job_id = '${uid(102)}' AND applicator_id = '${W}')::text;
    SET LOCAL ROLE authenticated;
    v := v || ' ' || (SELECT COALESCE(string_agg(right(id::text, 4)::int - 100 || '', ','), '-') FROM public.jobs)
           || ' ' || (SELECT COALESCE(string_agg(right(field_id::text, 4)::int - 300 || '', ','), '-') FROM public.job_fields)
           || ' ' || public._is_job_applicator('${uid(102)}')::text;
    RESET ROLE;`);
  assert.equal(done, 'ok|true 0 2 4 true', 'whole-job applicator with no dispatch row keeps a split job, dated 20 days ago, after completing it');
  assert.equal(after.reads.W.jobs.split(',').includes('4'), false, 'job 4, completed 8 days ago, stays hidden');
  console.log('LOW: split-dispatch job stays visible to its whole-job applicator inside the 7-day window; ends after it');

  const again = run({ flags: ['-1'] });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists \(already applied\?\)/);
  console.log('RE-APPLY: refused by the preflight');
  console.log('\nOWN_RECORD_FIELDS_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
