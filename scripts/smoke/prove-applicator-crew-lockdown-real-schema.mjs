#!/usr/bin/env node
/**
 * Real-schema proof for 20270314160000_applicator_crew_base_read_lockdown.sql.
 * Uses the step-1 fixture and read/write probes, plus full visible-row payloads for each affected path.
 *
 * Run: node scripts/smoke/prove-applicator-crew-lockdown-real-schema.mjs
 * Reuse a network-disabled container built through step 1, but not this migration:
 *   UNDO_PATHS_CONTAINER=crx-crp-pr3 CREW_LOCKDOWN_PROOF_REUSE=1 node scripts/smoke/prove-applicator-crew-lockdown-real-schema.mjs
 * Prints CREW_LOCKDOWN_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  A, D, K, ACTORS, JOBS, J, all, seed,
} from './prove-applicator-crew-read-path-real-schema.mjs';
import {
  attempt, docker, NAME, ROOT, scalar,
} from './undo-paths/harness.mjs';

const CANDIDATE = '20270314160000_applicator_crew_base_read_lockdown.sql';
const REVERSE = 'applicator-crew-lockdown-reverse.sql';
const reuse = process.env.CREW_LOCKDOWN_PROOF_REUSE === '1';
if (reuse && !/^crx-(undo-paths|crp)-/.test(process.env.UNDO_PATHS_CONTAINER || '')) {
  throw new Error('CREW_LOCKDOWN_PROOF_REUSE needs UNDO_PATHS_CONTAINER naming a throwaway proof container (crx-undo-paths-* or crx-crp-*)');
}

const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const runCandidate = (flags) => docker([
  'exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...flags,
], { input: candidate, allowFailure: true });
const tablePayload = (relation, predicate) => {
  const pairs = JSON.parse(scalar(`SELECT coalesce(json_agg(quote_literal(a.attname)||', t.'||quote_ident(a.attname) ORDER BY a.attnum), '[]')
    FROM pg_attribute a
    WHERE a.attrelid = '${relation}'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND has_column_privilege('authenticated', a.attrelid, a.attname, 'SELECT');`));
  assert.ok(pairs.length, `${relation}: no columns visible to authenticated`);
  // jsonb_build_object takes at most 100 arguments (50 columns), so wide relations are built in pieces and joined.
  const chunks = [];
  for (let i = 0; i < pairs.length; i += 50) chunks.push(`jsonb_build_object(${pairs.slice(i, i + 50).join(', ')})`);
  const row = chunks.join(' || ');
  return `(SELECT coalesce(jsonb_agg(payload ORDER BY payload::text), '[]'::jsonb)::text
    FROM (SELECT ${row} AS payload FROM ${relation} t WHERE ${predicate}) visible_rows)`;
};

const jobIds = `ARRAY[${JOBS.map(J).join(', ')}]`;
const ids = (prefix, keys) => `ARRAY[${keys.map((k) => `md5('crp-${prefix}-${k}')::uuid`).join(', ')}]`;
const fieldIds = ids('field', JOBS);
const recordIds = ids('rec', JOBS);
const customerIds = ids('cust', [...JOBS, 'P']);
const board = (uid) => `public.get_dispatch_board_jobs('${uid}'::uuid, NULL, current_date - 30, current_date + 30)`;
function buildFullReads() {
  const reads = {
  base_jobs: tablePayload('public.jobs', `t.id = ANY(${jobIds})`),
  base_job_chemicals: tablePayload('public.job_chemicals', `t.job_id = ANY(${jobIds})`),
  base_job_field_shares: tablePayload('public.job_field_shares', `t.job_id = ANY(${jobIds})`),
  base_field_billing_defaults: tablePayload('public.field_billing_defaults', `t.field_id = ANY(${fieldIds})`),
  crew_jobs: tablePayload('public.jobs_crew', `t.id = ANY(${jobIds})`),
  crew_job_chemicals: tablePayload('public.job_chemicals_crew', `t.job_id = ANY(${jobIds})`),
  crew_job_field_shares: tablePayload('public.job_field_shares_crew', `t.job_id = ANY(${jobIds})`),
  crew_field_billing_defaults: tablePayload('public.field_billing_defaults_crew', `t.field_id = ANY(${fieldIds})`),
  customers: tablePayload('public.customers', `t.id = ANY(${customerIds})`),
  fields: tablePayload('public.fields', `t.id = ANY(${fieldIds})`),
  job_fields: tablePayload('public.job_fields', `t.job_id = ANY(${jobIds})`),
  applied_info: tablePayload('public.job_applied_info', `t.job_id = ANY(${jobIds})`),
  applied_records: tablePayload('public.job_applied_records', `t.id = ANY(${recordIds})`),
  applied_record_fields: tablePayload('public.job_applied_record_fields', `t.application_record_id = ANY(${recordIds})`),
  applied_record_crew: tablePayload('public.job_applied_record_crew', `t.application_record_id = ANY(${recordIds})`),
  attachments: tablePayload('public.job_attachments', `t.job_id = ANY(${jobIds})`),
  storage_objects: tablePayload('storage.objects', `t.bucket_id = 'job-attachments' AND t.name = ANY(ARRAY[${JOBS.map((k) => `${J(k)}::text || '/crp.txt'`).join(', ')}])`),
  loader_worksheets: tablePayload('public.job_loader_worksheets', `t.job_id = ANY(${jobIds})`),
  dispatches: tablePayload('public.job_location_dispatches', `t.job_id = ANY(${jobIds})`),
  epa: tablePayload('public.job_product_epa', `t.job_id = ANY(${jobIds})`),
  tags: tablePayload('public.job_tag_assignments', `t.job_id = ANY(${jobIds})`),
  dispatched_list: `(SELECT coalesce(jsonb_agg(to_jsonb(res_row) ORDER BY to_jsonb(res_row)::text), '[]'::jsonb)::text
    FROM public.get_dispatched_list(auth.uid(), NULL) res_row WHERE to_jsonb(res_row)::text LIKE '%CRP-%')`,
};
for (const [who, uid] of [['A', A], ['D', D], ['K', K]]) {
  reads[`dispatch_board_${who}`] = `(SELECT coalesce(jsonb_agg(b ORDER BY b ->> 'job_number'), '[]'::jsonb)::text
    FROM ${board(uid)} b WHERE b ->> 'job_number' LIKE 'CRP-%')`;
}
for (const k of JOBS) {
  reads[`notes_${k}`] = `(SELECT coalesce(jsonb_agg(to_jsonb(note_row) ORDER BY to_jsonb(note_row)::text), '[]'::jsonb)::text
    FROM public.get_notes_for_entity('job', ${J(k)}) note_row)`;
  reads[`billed_customers_${k}`] = `(SELECT coalesce(jsonb_agg(to_jsonb(res_row) ORDER BY to_jsonb(res_row)::text), '[]'::jsonb)::text
    FROM public.get_job_billed_customers(${J(k)}) res_row)`;
}
  return reads;
}

function fullSnapshot(uid) {
  // Rebuilt every time (never cached), so a column the candidate newly exposes shows up as a changed payload.
  const body = [
    "r := '{}'::jsonb;",
    ...Object.entries(buildFullReads()).map(([name, query]) => `BEGIN SET LOCAL ROLE authenticated; t := ${query}; RESET ROLE;
      EXCEPTION WHEN OTHERS THEN t := 'ERROR ' || SQLERRM; END; r := r || jsonb_build_object('${name}', t);`),
    'v := r::text;',
  ].join('\n');
  const out = attempt(uid, body);
  assert.ok(out.startsWith('ok|'), `full payload snapshot failed: ${out}`);
  const result = JSON.parse(out.slice(3));
  for (const [name, value] of Object.entries(result)) {
    // An RPC's own authorization refusal is a real outcome (compared before vs after); any other error is a broken probe.
    assert.ok(typeof value === 'string' && (!value.startsWith('ERROR ') || /^ERROR Not authorized/.test(value)), `${name}: ${value}`);
  }
  return result;
}

function ownUploadDelete() {
  const pathSql = `${J('A')}::text || '/crew-lockdown-own-upload.txt'`;
  const out = attempt(A, `
    r := '{}'::jsonb;
    SET LOCAL ROLE authenticated;
    INSERT INTO storage.objects (bucket_id, name, owner_id)
      VALUES ('job-attachments', ${pathSql}, auth.uid()::text) RETURNING id INTO u;
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('upload_object', n);
    INSERT INTO public.job_attachments (job_id, storage_path, file_name, uploaded_by)
      VALUES (${J('A')}, ${pathSql}, 'crew-lockdown.txt', auth.uid());
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('insert_attachment', n);
    DELETE FROM public.job_attachments WHERE storage_path = ${pathSql};
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('delete_attachment', n);
    DELETE FROM storage.objects WHERE id = u;
    GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('delete_object', n);
    RESET ROLE;
    v := r::text;
  `);
  assert.ok(out.startsWith('ok|'), `own-upload delete flow failed: ${out}`);
  const result = JSON.parse(out.slice(3));
  assert.deepEqual(result, { upload_object: 1, insert_attachment: 1, delete_attachment: 1, delete_object: 1 });
  return result;
}

function policyHash() {
  const result = docker([
    'exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
  ], { input: `BEGIN;
    SET LOCAL search_path = pg_catalog;
    SELECT md5(string_agg(tablename||'.'||policyname||'|'||permissive||'|'||cmd||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''), E'\\n'
      ORDER BY tablename COLLATE "C", policyname COLLATE "C")) || '|' || count(*)::text
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('jobs','job_chemicals','job_field_shares','field_billing_defaults')
        AND cmd IN ('SELECT','ALL');
    COMMIT;` });
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}

// Reuse mode keeps the container, so a failure after the lockdown committed must still put the six policies back.
let lockedDown = false;
try {
  if (!reuse) {
    const { buildContainer } = await import('./undo-paths/harness.mjs');
    buildContainer({ stopBefore: CANDIDATE });
  } else {
    assert.equal(docker(['inspect', '--format', '{{.State.Running}}', NAME]).stdout.trim(), 'true', 'reuse container must be running');
    assert.equal(docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', NAME]).stdout.trim(), 'none', 'reuse container must have networking disabled');
    assert.equal(scalar("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '20270308040000_applicator_crew_read_path';"), '1', 'reuse container must include step 1');
    assert.equal(scalar("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '20270314160000_applicator_crew_base_read_lockdown';"), '0', 'reuse container must not include this candidate');
  }

  assert.equal(scalar(`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('jobs_crew','job_chemicals_crew','job_field_shares_crew','field_billing_defaults_crew');`), '4', 'all crew views must exist');
  seed();

  const before = all(true);
  const beforeFull = Object.fromEntries(Object.entries(ACTORS).map(([name, uid]) => [name, fullSnapshot(uid)]));
  const beforeOwnUploadDelete = ownUploadDelete();
  const crew = ['A', 'D', 'K'];
  // Before == after only proves a read was preserved if the fixture actually returns rows for it.
  // dispatch_board_K is empty by design: K is a driver, on no applicator's board (asserted by the step-1 proof).
  const neverRead = Object.keys(beforeFull.A).filter((key) => key !== 'dispatch_board_K' && !/^ERROR /.test(beforeFull.A[key])
    && Object.values(beforeFull).every((snap) => snap[key] === '[]'));
  assert.deepEqual(neverRead, [], 'every full-payload read must return rows for at least one actor before the lockdown');
  // The same for the crew side: every non-base read returns rows for at least one crew member, so its crew path is tested
  // (not each member: K is a driver and by design sees fewer of them than the applicators A and D).
  const crewNeverRead = Object.keys(beforeFull.A).filter((key) => !key.startsWith('base_') && key !== 'dispatch_board_K'
    && crew.every((who) => beforeFull[who][key] === '[]' || /^ERROR /.test(beforeFull[who][key])));
  assert.deepEqual(crewNeverRead, [], 'every crew read must return rows for at least one crew member before the lockdown');
  const baseKeys = [
    'jobs', 'jobs_protected', 'job_chemicals', 'job_chemicals_price',
    'job_field_shares', 'job_field_shares_split', 'field_billing_defaults', 'field_billing_defaults_split',
  ];
  for (const who of crew) {
    assert.ok(baseKeys.some((key) => before[who][key] !== '[]'), `${who}: fixture must produce a real pre-lockdown base-table result`);
    assert.ok(['base_jobs', 'base_job_chemicals', 'base_job_field_shares', 'base_field_billing_defaults']
      .some((key) => beforeFull[who][key] !== '[]'), `${who}: full payload probe must contain a real pre-lockdown base-table row`);
  }

  const auto = runCandidate([]);
  assert.notEqual(auto.status, 0, 'an autocommit run must fail');
  assert.match(auto.stderr, /PREFLIGHT_FAIL: run this file as one transaction/);
  assert.equal(policyHash(), '82812af55c7565208df9dfaf907f8869|6', 'autocommit refusal must leave the six original policies unchanged');
  console.log('AUTOCOMMIT: refused before changing policies');

  // Each crew-view precondition refuses inside a rolled-back transaction and leaves the six policies alone.
  const brokenView = (setup) => docker([
    'exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
  ], { input: `BEGIN;\n${setup}\n${candidate}\nROLLBACK;`, allowFailure: true });
  const leaky = brokenView('ALTER VIEW public.jobs_crew RENAME COLUMN notes TO internal_memo;');
  assert.notEqual(leaky.status, 0, 'a crew view with a protected column must be refused');
  assert.match(leaky.stderr, /PREFLIGHT_FAIL: a crew view exposes a protected column/);
  const invoker = brokenView('ALTER VIEW public.field_billing_defaults_crew SET (security_invoker = true);');
  assert.notEqual(invoker.status, 0, 'a security_invoker crew view must be refused');
  assert.match(invoker.stderr, /PREFLIGHT_FAIL: crew views must be owned by an RLS-bypassing role/);
  const rlsOff = brokenView('ALTER TABLE public.job_chemicals DISABLE ROW LEVEL SECURITY;');
  assert.notEqual(rlsOff.status, 0, 'a protected base table with RLS off must be refused');
  assert.match(rlsOff.stderr, /PREFLIGHT_FAIL: crew views must be owned by an RLS-bypassing role/);
  const noGrant = brokenView('REVOKE SELECT ON public.job_chemicals_crew FROM authenticated;');
  assert.notEqual(noGrant.status, 0, 'a crew view authenticated cannot read must be refused');
  assert.match(noGrant.stderr, /PREFLIGHT_FAIL: authenticated must keep SELECT on all four crew views/);
  const changedView = brokenView('ALTER VIEW public.jobs_crew SET (security_barrier = false);');
  assert.notEqual(changedView.status, 0, 'any change to a crew view must be refused by the fingerprint');
  assert.match(changedView.stderr, /PREFLIGHT_FAIL: the four crew views changed since this file was written/);
  assert.equal(policyHash(), '82812af55c7565208df9dfaf907f8869|6', 'crew-view refusals must leave the six original policies unchanged');
  console.log('PRECONDITIONS: protected view column, security_invoker view, RLS-off base table and changed view fingerprint all refused');

  // RLS switched off after the preflight (between the policy changes and the postflight) is caught by the postflight.
  assert.equal(candidate.split('DO $postflight$').length, 2, 'candidate must contain exactly one postflight block');
  const lateRlsOff = docker([
    'exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
  ], { input: `BEGIN;\n${candidate.replace('DO $postflight$', 'ALTER TABLE public.job_field_shares DISABLE ROW LEVEL SECURITY;\nDO $postflight$')}\nROLLBACK;`, allowFailure: true });
  assert.notEqual(lateRlsOff.status, 0, 'RLS disabled before the postflight must be refused');
  assert.match(lateRlsOff.stderr, /POSTFLIGHT_FAIL: row level security must stay on/);
  assert.equal(policyHash(), '82812af55c7565208df9dfaf907f8869|6', 'postflight refusal must leave the six original policies unchanged');
  const lateRevoke = docker([
    'exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
  ], { input: `BEGIN;\n${candidate.replace('DO $postflight$', 'REVOKE SELECT ON public.jobs_crew FROM authenticated;\nDO $postflight$')}\nROLLBACK;`, allowFailure: true });
  assert.notEqual(lateRevoke.status, 0, 'a crew-view grant removed before the postflight must be refused');
  assert.match(lateRevoke.stderr, /POSTFLIGHT_FAIL: authenticated must keep SELECT on all four crew views/);
  // Every checked view and table stays ACCESS EXCLUSIVE locked by this transaction through the end of the file.
  const held = docker([
    'exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
  ], { input: `BEGIN;\n${candidate}\nSELECT 'LOCKS_HELD=' || count(*) FILTER (WHERE mode = 'AccessExclusiveLock' AND relation IN ('public.jobs'::regclass,
        'public.job_chemicals'::regclass, 'public.job_field_shares'::regclass, 'public.field_billing_defaults'::regclass))
      || '/' || count(*) FILTER (WHERE mode = 'AccessShareLock' AND relation IN ('public.jobs_crew'::regclass,
        'public.job_chemicals_crew'::regclass, 'public.job_field_shares_crew'::regclass, 'public.field_billing_defaults_crew'::regclass))
      FROM pg_locks WHERE pid = pg_backend_pid() AND granted;\nROLLBACK;`, allowFailure: true });
  assert.equal(held.status, 0, `lock probe failed:\n${held.stderr}`);
  assert.match(held.stdout, /LOCKS_HELD=4\/4/);
  assert.equal(policyHash(), '82812af55c7565208df9dfaf907f8869|6', 'postflight refusals and the lock probe must leave the six original policies unchanged');
  console.log('POSTFLIGHT: RLS turned off or a crew-view grant removed after the preflight is refused; base tables and crew views stay locked to the end');

  const reverseSql = readFileSync(path.join(ROOT, 'scripts', 'smoke', REVERSE), 'utf8').replaceAll('\r\n', '\n');
  const reverseUnlocked = docker([
    'exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1',
  ], { input: reverseSql, allowFailure: true });
  assert.notEqual(reverseUnlocked.status, 0, 'reverse on a database that was never locked down must fail');
  assert.match(reverseUnlocked.stderr, /REVERSE_FAIL: the current SELECT policies are not the four the lockdown wrote/);
  assert.equal(policyHash(), '82812af55c7565208df9dfaf907f8869|6', 'reverse refusal must leave the six original policies unchanged');
  console.log('REVERSE BEFORE LOCKDOWN: refused');

  const applied = runCandidate(['-1']);
  assert.equal(applied.status, 0, `apply failed:\n${applied.stdout}\n${applied.stderr}`);
  assert.match(applied.stderr, /POSTFLIGHT_OK/);
  lockedDown = true;
  console.log('APPLY: POSTFLIGHT_OK');

  const after = all(true);
  const afterFull = Object.fromEntries(Object.entries(ACTORS).map(([name, uid]) => [name, fullSnapshot(uid)]));
  const afterOwnUploadDelete = ownUploadDelete();
  for (const who of crew) {
    for (const key of ['jobs', 'job_chemicals', 'job_field_shares', 'field_billing_defaults']) {
      assert.equal(after[who][key], '[]', `${who}: ${key} must be empty after lockdown`);
    }
    const changed = baseKeys.filter((key) => before[who][key] !== after[who][key]);
    assert.ok(changed.length > 0, `${who}: base-table probe must detect a change`);
    assert.deepEqual(Object.keys(after[who]).filter((key) => before[who][key] !== after[who][key]).sort(), changed.sort(), `${who}: only base-table results may change`);
    for (const key of ['base_jobs', 'base_job_chemicals', 'base_job_field_shares', 'base_field_billing_defaults']) {
      assert.equal(afterFull[who][key], '[]', `${who}: ${key} must be empty after lockdown`);
    }
    const fullChanged = Object.keys(beforeFull[who]).filter((key) => beforeFull[who][key] !== afterFull[who][key]);
    assert.deepEqual(fullChanged.sort(), ['base_field_billing_defaults', 'base_job_chemicals', 'base_job_field_shares', 'base_jobs']
      .filter((key) => beforeFull[who][key] !== '[]').sort(), `${who}: only protected base-table payloads may change`);
  }
  for (const office of ['rep', 'admin']) {
    assert.deepEqual(after[office], before[office], `${office}: every step-1 read and write result stays identical`);
    assert.deepEqual(afterFull[office], beforeFull[office], `${office}: every visible table and RPC payload stays identical`);
  }
  assert.deepEqual(afterOwnUploadDelete, beforeOwnUploadDelete, 'A upload, attachment delete and storage-object delete are unchanged');
  assert.deepEqual(afterOwnUploadDelete, { upload_object: 1, insert_attachment: 1, delete_attachment: 1, delete_object: 1 });
  console.log('CREW READS: base tables return zero rows; crew views and all other full payloads are unchanged');
  console.log('OFFICE AND WRITES: admin, rep, all rolled-back writes and A own-upload deletion match before');

  const again = runCandidate(['-1']);
  assert.notEqual(again.status, 0, 're-apply must fail');
  assert.match(again.stderr, /PREFLIGHT_FAIL: already locked down/);
  console.log('RE-APPLY: refused by the preflight');

  // A later tightening of a lockdown policy makes the reverse refuse instead of silently overwriting it.
  const reverseTightened = docker([
    'exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
  ], { input: `BEGIN;\nALTER POLICY jobs_select ON public.jobs USING (public.is_admin());\n${reverseSql}\nROLLBACK;`, allowFailure: true });
  assert.notEqual(reverseTightened.status, 0, 'reverse over a tightened lockdown policy must fail');
  assert.match(reverseTightened.stderr, /REVERSE_FAIL: the current SELECT policies are not the four the lockdown wrote/);
  assert.deepEqual(all(true), after, 'tightened-policy reverse refusal must leave the lockdown and every result in place');
  console.log('REVERSE OVER CHANGED POLICY: refused before restoring any policy');

  const reverseAuto = docker([
    'exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
  ], { input: reverseSql, allowFailure: true });
  assert.notEqual(reverseAuto.status, 0, 'an autocommit reverse must fail');
  assert.match(reverseAuto.stderr, /REVERSE_FAIL: run this file as one transaction/);
  assert.deepEqual(all(true), after, 'autocommit reverse refusal must leave the lockdown and every result in place');
  console.log('REVERSE AUTOCOMMIT: refused before restoring any policy');

  const reverse = docker([
    'exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1',
  ], { input: reverseSql, allowFailure: true });
  assert.equal(reverse.status, 0, `reverse failed:\n${reverse.stdout}\n${reverse.stderr}`);
  assert.equal(policyHash(), '82812af55c7565208df9dfaf907f8869|6', 'reverse must restore the exact six old policy definitions');
  lockedDown = false;
  assert.deepEqual(all(true), before, 'reverse must return every read and write result to before');
  assert.deepEqual(Object.fromEntries(Object.entries(ACTORS).map(([name, uid]) => [name, fullSnapshot(uid)])), beforeFull,
    'reverse must return every full table and RPC payload to before');
  assert.deepEqual(ownUploadDelete(), beforeOwnUploadDelete, 'reverse must preserve the own-upload delete outcome');
  console.log('REVERSE: six original policies restored; every result is back to before');
  console.log('\nCREW_LOCKDOWN_PROOF_PASS');
} finally {
  if (reuse && lockedDown) {
    const restore = docker([
      'exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1',
    ], { input: readFileSync(path.join(ROOT, 'scripts', 'smoke', REVERSE), 'utf8').replaceAll('\r\n', '\n'), allowFailure: true });
    console.error(restore.status === 0 ? 'REUSE CLEANUP: six original policies restored after a failure'
      : `REUSE CLEANUP FAILED: the reused container is still locked down; rebuild it.\n${restore.stderr}`);
  }
  if (!reuse) {
    const { removeContainer } = await import('./undo-paths/harness.mjs');
    removeContainer();
  }
}
