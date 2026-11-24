#!/usr/bin/env node
/**
 * Real-schema proof for 20270228201000_save_job_refuses_changed_job.sql (contract:
 * docs/plans/2026-11-23-job-save-version-check-CONTRACT.md). Builds the checked-in baseline plus every
 * post-baseline migration BEFORE the candidate in a network-disabled PostgreSQL container
 * (scripts/smoke/undo-paths/harness.mjs), seeds a job, and:
 *   0. before the candidate: two saves from the same page version both succeed (the second overwrites
 *      the first) -- the gap this migration closes;
 * then applies the candidate (its preflight and postflight run) and, calling the PUBLIC functions as the
 * signed-in user:
 *   1. two saves from the same version, the first holding its lock: the second waits, then is refused
 *      JOB_CHANGED_SINCE_LOADED; the job keeps the first save's notes;
 *   2. a committed save retried with the same key and payload (its version now stale) returns the
 *      stored result and changes nothing; a new key with that version is refused;
 *   3. a stale version (another user changed a column, a field line, or a dispatch) is refused and
 *      nothing changes; the current version saves;
 *   4. no expected_version saves as today;
 *   5. the page's own dispatch, carried into its version, saves; with someone else's dispatch change too, refused;
 *   2 also: the retry's result says "replayed": true;
 *   6. printing, applied acres and a chemical's cost leave the version (all but rev) unchanged; rev moves;
 *      6b. a change put back leaves it unchanged too, and moves rev;
 *   7. a driver, or a rep denied the Job Schedule page, is refused job_edit_version; a sales rep gets one;
 *      a rep denied the page while their save waits for the job lock is refused once it clears;
 *      a denial while a rep's save is uncommitted waits for it (the profile is held FOR SHARE);
 *   8. a malformed expected_version is refused; a driver's save carrying one gets INSUFFICIENT_ROLE;
 *   9. 20270226150000's refusal still fires: a completed job's chemicals can't change, current version or not.
 *
 * Run: node scripts/smoke/prove-job-save-version-real-schema.mjs   (needs Docker; never touches live)
 * Prints JOB_SAVE_VERSION_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, seed, ref, psql, scalar, attempt, asUser, refuse, claims, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270228201000_save_job_refuses_changed_job.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const { admin: ADMIN, rep: REP, driver: DRIVER, applicator: APPLICATOR } = USERS;
const CHANGED = 'JOB_CHANGED_SINCE_LOADED: This job changed after you opened it. Nothing was saved. Reload the page to see the job as it is now, then make your edits again.';
const JOB = ref('job');

/** save_job as the page sends it; `expected` is a SQL jsonb expression, or null to send no version. */
const save = (notes, expected, key = null, who = ADMIN, status = 'scheduled') => `public.save_job(${JOB},
  jsonb_build_object('customer_id', ${ref('cust')}, 'status', '${status}', 'job_date', '2027-04-01', 'total_acres', 160,
    'notes', '${notes}', 'field_shares', '[]'::jsonb)${expected ? ` || jsonb_build_object('expected_version', ${expected})` : ''},
  (SELECT jsonb_agg(jsonb_build_object('field_id', f.field_id, 'acres_to_treat', 80, 'sort_order', f.sort_order) ORDER BY f.sort_order)
     FROM public.job_fields f WHERE f.job_id = ${JOB}),
  '[]'::jsonb, '${who}', ${key ? `'${key}'` : 'NULL'})`;
const notes = `(SELECT notes FROM public.jobs WHERE id = ${JOB})`;
const commit = (body, uid = ADMIN) => attempt(uid, body, { commit: true });
const show = (label, got) => { console.log(`[job-version] ${label}: ${got}`); return got; };
const loc = (n) => `(SELECT id FROM public.job_fields WHERE job_id = ${JOB} AND sort_order = ${n})`;
const dispatch = (n, key) => `public.dispatch_job_locations(jsonb_build_array(jsonb_build_object('job_field_id', ${loc(n)}, 'applicator_id', '${APPLICATOR}', 'crew_id', NULL)), '${ADMIN}', '${key}', false)`;
/** The page reads the version (as the signed-in user) and keeps it under `name`. */
const remember = (name, uid = ADMIN) => commit(`${asUser(`r := public.job_edit_version(${JOB});`)}
  INSERT INTO undo_paths.versions VALUES ('${name}', r) ON CONFLICT (name) DO UPDATE SET ver = EXCLUDED.ver; v := r::text;`, uid);
const V = (name) => `(SELECT ver FROM undo_paths.versions WHERE name = '${name}')`;
/** As someone else, committed (postgres: a direct write, the same rows another screen would change). */
const elsewhere = (sql) => psql(`BEGIN;\n${claims(ADMIN)}\n${sql};\nCOMMIT;`);

/** Session A saves from `expectedSql` and holds its transaction open for 8 s; resolves when it commits. */
function holdingSave(expectedSql, key, who = ADMIN) {
  const h = spawn('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  h.stderr.on('data', (d) => { err += d; });
  h.stdin.end(`BEGIN;\n${claims(who)}\nSET LOCAL ROLE authenticated;\nSELECT ${save('[JV] first save', expectedSql, key, who)};\nRESET ROLE;\nSELECT pg_sleep(8);\nCOMMIT;\n`);
  return new Promise((resolve) => h.on('close', (code) => resolve({ code, err })));
}
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitForHolder() {
  for (let i = 0; i < 100; i += 1) {
    if (scalar(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(8)%' AND state = 'active' AND pid <> pg_backend_pid();`) === '1') return;
    pause(100);
  }
  throw new Error('the holding session never reached its sleep');
}
/** A saves and holds; B saves from the same version meanwhile. Returns B's outcome and the job's notes after. */
async function concurrent(expectedSql, suffix) {
  const holder = holdingSave(expectedSql, `jv-a-${suffix}`);
  waitForHolder();
  const started = Date.now();
  const b = commit(`${refuse(`r := ${save('[JV] second save', expectedSql, `jv-b-${suffix}`)};`)} v := t;`);
  const waited = Date.now() - started;
  const a = await holder;
  assert.equal(a.code, 0, `the first save failed:\n${a.err}`);
  return { b, waited, after: scalar(`SELECT ${notes};`) };
}

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  seed('job-version', `
    INSERT INTO public.customers (farm_name) VALUES ('[JV] Farm');
    INSERT INTO undo_paths.ids SELECT 'cust', id FROM public.customers WHERE farm_name = '[JV] Farm';
    INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
      SELECT ${ref('cust')}, '[JV] Field ' || n, 'corn', 80 FROM generate_series(0, 1) n;
    INSERT INTO undo_paths.ids SELECT 'job', (public.save_job(NULL,
      jsonb_build_object('customer_id', ${ref('cust')}, 'status', 'scheduled', 'job_date', '2027-04-01', 'total_acres', 160,
        'notes', '[JV] created', 'field_shares', '[]'::jsonb),
      (SELECT jsonb_agg(jsonb_build_object('field_id', x.id, 'acres_to_treat', 80, 'sort_order', x.n) ORDER BY x.n)
         FROM (SELECT f.id, row_number() OVER (ORDER BY f.field_name) - 1 AS n FROM public.fields f WHERE f.customer_id = ${ref('cust')}) x),
      '[]'::jsonb, '${ADMIN}', NULL) ->> 'job_id')::uuid;
    CREATE TABLE undo_paths.versions (name text PRIMARY KEY, ver jsonb);`);
  // The page's calls run as authenticated; let them read the fixture ids (disposable database only).
  psql('GRANT USAGE ON SCHEMA undo_paths TO authenticated; GRANT SELECT ON ALL TABLES IN SCHEMA undo_paths TO authenticated;');
  assert.equal(scalar(`SELECT count(*) FROM public.job_fields WHERE job_id = ${JOB};`), '2', 'the seeded job must have two field lines');

  const wrapperMd5 = scalar("SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)'::regprocedure;");
  console.log(`[job-version] reviewed 20270226150000 wrapper md5: ${wrapperMd5}`);
  assert.ok(candidate.includes(`'${wrapperMd5}'`), 'the candidate preflight must pin the wrapper md5 printed above');

  // 0. Today: both saves from the same page version succeed; the second silently overwrites the first.
  const before = await concurrent(`'{"core":"as loaded","dispatches":[]}'::jsonb`, 'before');
  show('0 before the candidate, second save', `${before.b} -> notes=${before.after}`);
  assert.equal(before.b, 'ok|NOT REFUSED', 'today the second save passes (the gap)');
  assert.equal(before.after, '[JV] second save');

  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/jv-candidate.sql'], { input: candidate });
  const applied = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/jv-candidate.sql'], { allowFailure: true });
  assert.equal(applied.status, 0, `candidate apply failed:\n${applied.stderr}`);
  console.log('[job-version] candidate applied (preflight and postflight passed)');

  // 1. Two saves at once from the same version: the second waits for the first's lock, then is refused.
  remember('c1');
  const c1 = await concurrent(V('c1'), 'after');
  show('1 two saves at once', `${c1.b} (waited ${c1.waited} ms) -> notes=${c1.after}`);
  assert.equal(c1.b, `ok|${CHANGED}`);
  assert.equal(c1.after, '[JV] first save');
  assert.ok(c1.waited > 2000, `the second save must wait for the first's lock (waited ${c1.waited} ms)`);

  // 2. Lost reply: the save commits; the retry (same key and payload, version now stale) gets the stored result.
  remember('c2');
  assert.match(commit(`${asUser(`r := ${save('[JV] lost reply', V('c2'), 'jv-lost')};`)} v := r::text;`), /^ok\|\{/);
  const c2 = show('2 lost-reply retry', commit(`
    SELECT result INTO r FROM public.idempotency_keys WHERE idempotency_key = 'jv-lost';
    f0 := public._job_edit_version(${JOB})::text; n := (SELECT count(*) FROM public.activity_feed);
    ${asUser(`r2 := ${save('[JV] lost reply', V('c2'), 'jv-lost')};`)}
    ${refuse(`r3 := ${save('[JV] lost reply', V('c2'), 'jv-new-key')};`)}
    v := 'same=' || ((r || '{"replayed": true}') = r2) || '|unchanged=' || (f0 = public._job_edit_version(${JOB})::text)
      || '|activity+' || ((SELECT count(*) FROM public.activity_feed) - n) || '|notes=' || ${notes} || '|new key=' || t;`));
  assert.equal(c2, `ok|same=true|unchanged=true|activity+0|notes=[JV] lost reply|new key=${CHANGED}`);
  // A new job's retry is marked too (Luna round 12); its first call is not.
  const newJob = save('[JV] new job', null, 'jv-new-replay').replace(`public.save_job(${JOB},`, 'public.save_job(NULL,');
  assert.equal(show('2 new-job retry', commit(`${asUser(`r := ${newJob}; r2 := ${newJob};`)}
    v := coalesce(r ->> 'replayed', 'none') || '|' || (r2 ->> 'replayed') || '|same job=' || (r ->> 'job_id' = r2 ->> 'job_id');`)), 'ok|none|true|same job=true');
  // A rep denied the page is refused for the role, not told the job changed (Luna round 12).
  psql(`SET session_replication_role = replica; UPDATE public.profiles SET denied_pages = array_append(coalesce(denied_pages, '{}'), 'jobs') WHERE id = '${REP}';`);
  assert.match(show('2 denied rep, stale version', attempt(REP, `${refuse(`r := ${save('[JV] denied', V('c2'), null, REP)};`)} v := t;`)), /^ok\|INSUFFICIENT_ROLE/);
  psql(`SET session_replication_role = replica; UPDATE public.profiles SET denied_pages = array_remove(denied_pages, 'jobs') WHERE id = '${REP}';`);

  // 3. Someone else changes a job column, a field line, or a dispatch: refused, nothing changes. Current: saves.
  const staleAfter = (name, change) => {
    remember(name);
    elsewhere(change);
    return commit(`f0 := public._job_edit_version(${JOB})::text; ${refuse(`r := ${save('[JV] stale', V(name))};`)}
      v := t || '|unchanged=' || (f0 = public._job_edit_version(${JOB})::text);`);
  };
  const c3 = show('3 stale', [
    staleAfter('c3a', `UPDATE public.jobs SET loader_comment = '[JV] someone else' WHERE id = ${JOB}`),
    staleAfter('c3b', `UPDATE public.job_fields SET pests = '[JV] someone else' WHERE id = ${loc(0)}`),
    staleAfter('c3c', `SELECT ${dispatch(0, 'jv-other-dispatch-1')}`),
  ].join(' ; '));
  assert.equal(c3, [1, 2, 3].map(() => `ok|${CHANGED}|unchanged=true`).join(' ; '));
  remember('c3d');
  assert.equal(show('3 current version', commit(`${asUser(`r := ${save('[JV] current', V('c3d'))};`)} v := ${notes};`)), 'ok|[JV] current');

  // 4. No expected_version: today's behavior.
  assert.equal(show('4 no version', commit(`${asUser(`r := ${save('[JV] no version', null)};`)} v := ${notes};`)), 'ok|[JV] no version');

  // 5. The page's own dispatch, carried into its version: saves. Plus someone else's dispatch change: refused.
  const ownDispatch = (name) => `jsonb_set(${V(name)}, '{dispatches}', (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM (
      SELECT e FROM jsonb_array_elements_text(${V(name)} -> 'dispatches') e WHERE e NOT LIKE ${loc(1)}::text || '|%'
      UNION ALL SELECT ${loc(1)}::text || '|${APPLICATOR}||dispatched') x))`;
  remember('c5');
  assert.match(commit(`${asUser(`r := ${dispatch(1, 'jv-own-dispatch-1')};`)} v := r::text;`), /^ok\|/);
  assert.equal(show('5 own dispatch then save', commit(`${asUser(`r := ${save('[JV] after own dispatch', ownDispatch('c5'))};`)} v := ${notes};`)), 'ok|[JV] after own dispatch');
  commit(`${asUser(`r := ${dispatch(0, 'jv-own-dispatch-0')};`)} v := r::text;`);
  remember('c5b');
  assert.match(commit(`${asUser(`r := ${dispatch(1, 'jv-own-dispatch-2')};`)} v := r::text;`), /^ok\|/);
  elsewhere(`UPDATE public.job_location_dispatches SET dispatch_status = 'cancelled' WHERE job_field_id = ${loc(0)}`);
  assert.equal(show('5 own dispatch + someone else\'s', commit(`${refuse(`r := ${save('[JV] stale', ownDispatch('c5b'))};`)} v := t || '|notes=' || ${notes};`)),
    `ok|${CHANGED}|notes=[JV] after own dispatch`);

  // 6. Printing, applied acres and a chemical's cost do not change the version.
  elsewhere(`SET session_replication_role = replica;
    INSERT INTO public.products (id, product_name, is_active, product_form, inventory_unit) VALUES (gen_random_uuid(), '[JV] Chem', true, 'liquid', 'Gal');
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, cost_per_unit_cents) SELECT ${JOB}, id, 1, 'Gal', 100 FROM public.products WHERE product_name = '[JV] Chem';
    SET session_replication_role = origin`);
  remember('c6');
  elsewhere(`UPDATE public.jobs SET printed_at = now(), updated_at = now() + interval '1 minute', applied_acres = 5 WHERE id = ${JOB};
    UPDATE public.job_chemicals SET cost_per_unit_cents = 999 WHERE job_id = ${JOB}`);
  // Same check as save_job (all but rev); rev moves on any write.
  const sameButRev = (name) => `((public._job_edit_version(${JOB}) - 'rev') = (${V(name)} - 'rev'))::text
    || '/rev moved=' || (public._job_edit_version(${JOB}) ->> 'rev' <> ${V(name)} ->> 'rev')`;
  assert.equal(show('6 print / applied acres / cost', commit(`v := ${sameButRev('c6')};`)), 'ok|true/rev moved=true');

  // 6b. A change put back (job column, field line, dispatch): core and dispatches as before, rev moved, so the
  // page's version reads before and after its form catch it (Sol round 12).
  const putBack = (name, change, undo) => { remember(name); elsewhere(change); elsewhere(undo); return commit(`v := ${sameButRev(name)};`); };
  assert.equal(show('6b put back', [
    putBack('c6b1', `UPDATE public.jobs SET notes = '[JV] x' WHERE id = ${JOB}`, `UPDATE public.jobs SET notes = '[JV] after own dispatch' WHERE id = ${JOB}`),
    putBack('c6b2', `UPDATE public.job_fields SET pests = '[JV] x' WHERE id = ${loc(0)}`, `UPDATE public.job_fields SET pests = NULL WHERE id = ${loc(0)}`),
    putBack('c6b3', `UPDATE public.job_location_dispatches SET dispatch_status = 'cancelled' WHERE job_field_id = ${loc(1)}`,
      `UPDATE public.job_location_dispatches SET dispatch_status = 'dispatched' WHERE job_field_id = ${loc(1)}`),
  ].join(' ; ')), ['c6b1', 'c6b2', 'c6b3'].map(() => 'ok|true/rev moved=true').join(' ; '));

  // 7. Who may read a version.
  assert.equal(show('7 driver', attempt(DRIVER, `${refuse(`r := public.job_edit_version(${JOB});`)} v := t;`)), 'ok|INSUFFICIENT_ROLE');
  assert.equal(show('7 sales rep', attempt(REP, `${asUser(`r := public.job_edit_version(${JOB});`)} v := (r = public._job_edit_version(${JOB}))::text;`)), 'ok|true');
  assert.equal(scalar("SELECT has_function_privilege('authenticated', 'public._job_edit_version(uuid)', 'EXECUTE');"), 'f');
  // A rep denied the Job Schedule page is refused, as edit_jobs refuses them (Sol round 1).
  psql(`SET session_replication_role = replica; UPDATE public.profiles SET denied_pages = array_append(coalesce(denied_pages, '{}'), 'jobs') WHERE id = '${REP}';`);
  assert.equal(show('7 rep denied the jobs page', attempt(REP, `${refuse(`r := public.job_edit_version(${JOB});`)} v := t;`)), 'ok|INSUFFICIENT_ROLE');
  assert.match(show('7 rep denied the jobs page, save', attempt(REP, `${refuse(`r := ${save('[JV] denied rep', null, null, REP)};`)} v := t;`)), /^ok\|INSUFFICIENT_ROLE/);
  psql(`SET session_replication_role = replica; UPDATE public.profiles SET denied_pages = array_remove(denied_pages, 'jobs') WHERE id = '${REP}';`);
  // Denied WHILE the save waits (the job lock, or a new job's key lock): refused once the wait ends (Sol rounds 10, 11).
  // The denying session acts only after it sees the rep's save blocked on a lock, and fails if it never does (Sol round 11).
  async function deniedWhileWaiting(label, holder, repSave) {
    waitForHolder();
    // As an argument, not stdin: the rep's save below blocks this process, so piped input would not be sent.
    const denier = spawn('docker', ['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c',
      `DO $d$ BEGIN
        FOR i IN 1..200 LOOP
          PERFORM pg_stat_clear_snapshot();  -- pg_stat_activity is otherwise frozen for the whole transaction
          EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%${label}%' AND pid <> pg_backend_pid());
          IF i = 200 THEN RAISE EXCEPTION 'the rep''s save never waited on a lock'; END IF;
          PERFORM pg_sleep(0.05);
        END LOOP; END $d$;
        SET session_replication_role = replica; UPDATE public.profiles SET denied_pages = array_append(coalesce(denied_pages, '{}'), 'jobs') WHERE id = '${REP}';`],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    const denierDone = new Promise((resolve) => denier.on('close', resolve));
    for (let i = 0; scalar(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%never waited on a lock%' AND state = 'active' AND pid <> pg_backend_pid();`) !== '1'; i += 1) {
      if (i > 100) throw new Error('the denying session never started');
      pause(50);
    }
    const got = show(`7 ${label}`, attempt(REP, `${refuse(`r := ${repSave};`)} v := t;`));
    assert.equal((await holder).code, 0, 'the holding session failed');
    assert.equal(await denierDone, 0, 'the denial did not land while the rep was waiting');
    psql(`SET session_replication_role = replica; UPDATE public.profiles SET denied_pages = array_remove(denied_pages, 'jobs') WHERE id = '${REP}';`);
    return got;
  }
  assert.match(await deniedWhileWaiting('rep denied while the save waits', holdingSave(null, 'jv-hold-denial'),
    save('[JV] rep denied while the save waits', null, null, REP)), /^ok\|INSUFFICIENT_ROLE/);
  const keyHolder = spawn('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'ignore', 'pipe'] });
  keyHolder.stdin.end(`BEGIN;\nSELECT pg_advisory_xact_lock(hashtextextended('crx:idempotency:jv-new-denial', 0));\nSELECT pg_sleep(8);\nROLLBACK;\n`);
  assert.match(await deniedWhileWaiting('rep denied while a new job waits', new Promise((resolve) => keyHolder.on('close', (code) => resolve({ code }))),
    save('[JV] rep denied while a new job waits', null, 'jv-new-denial', REP).replace(`public.save_job(${JOB},`, 'public.save_job(NULL,')), /^ok\|INSUFFICIENT_ROLE/);
  // The last role check holds the rep's profile until commit: a denial meanwhile waits (Sol round 12).
  const repHolder = holdingSave(null, 'jv-rep-hold', REP);
  waitForHolder();
  const blocked = psql(`SET lock_timeout = '1s'; SET session_replication_role = replica;
    UPDATE public.profiles SET denied_pages = array_append(coalesce(denied_pages, '{}'), 'jobs') WHERE id = '${REP}';`, { allowFailure: true });
  show('7 denial during a rep\'s save', blocked.status === 0 ? 'LANDED' : blocked.stderr.trim());
  assert.match(blocked.stderr, /lock timeout/, 'a denial must wait for the rep\'s save to commit');
  assert.equal((await repHolder).code, 0, 'the rep\'s holding save failed');
  // The same save from a rep who keeps access goes through, so the refusal above is the denial, not the role.
  assert.equal(show('7 rep with access, save', attempt(REP, `${refuse(`r := ${save('[JV] rep save', null, null, REP)};`)} v := t;`)), 'ok|NOT REFUSED');
  // The admin holding save above sent no chemicals and so cleared case 6's: put it back for case 9.
  elsewhere(`SET session_replication_role = replica;
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, cost_per_unit_cents) SELECT ${JOB}, id, 1, 'Gal', 100 FROM public.products WHERE product_name = '[JV] Chem'
      AND NOT EXISTS (SELECT 1 FROM public.job_chemicals WHERE job_id = ${JOB});
    SET session_replication_role = origin`);

  // 8. A malformed version is refused.
  assert.match(show('8 malformed', attempt(ADMIN, `${refuse(`r := ${save('[JV] bad', `'"x"'::jsonb`)};`)} v := t;`)), /^ok\|EXPECTED_VERSION_INVALID/);
  assert.match(show('8 dispatches not an array', attempt(ADMIN, `${refuse(`r := ${save('[JV] bad', `'{"core":"x","dispatches":{}}'::jsonb`)};`)} v := t;`)), /^ok\|EXPECTED_VERSION_INVALID/);
  // A non-editor carrying a (stale) version gets the role refusal, not a version answer.
  assert.match(show('8 driver save', attempt(DRIVER, `${refuse(`r := ${save('[JV] driver', V('c1'), null, DRIVER)};`)} v := t;`)), /^ok\|INSUFFICIENT_ROLE/);

  // 9. 20270226150000's refusal is kept: a completed job's chemicals can't change, even from the current version.
  elsewhere(`SET session_replication_role = replica; UPDATE public.jobs SET status = 'completed' WHERE id = ${JOB}; SET session_replication_role = origin`);
  remember('c9');
  assert.match(show('9 completed job, chemicals dropped', commit(`f0 := public._job_edit_version(${JOB})::text;
    ${refuse(`r := ${save('[JV] completed', V('c9'), 'jv-completed', ADMIN, 'completed')};`)}
    v := t || '|unchanged=' || (f0 = public._job_edit_version(${JOB})::text);`)), /^ok\|JOB_COMPLETED_CHEMICALS_LOCKED.*\|unchanged=true$/);
  assert.equal(scalar("SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)'::regprocedure;"),
    '1a555a89c7d8ddc6b8d5692daa7b14cd', 'the installed save_job must be the body the postflight pins');

  console.log('\nJOB_SAVE_VERSION_PROOF_PASS');
} finally {
  removeContainer();
}
