#!/usr/bin/env node
/**
 * Real-schema proof for 20270307190000_applicator_crew_read_path.sql
 * (contract: docs/plans/2026-11-25-applicator-crew-read-path-CONTRACT.md, proof cases 1, 2, 4 and 5).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), seeds invented jobs, then records, as each signed-in
 * user (role authenticated, JWT claims, row security on), the exact rows and payloads every applicator screen reads
 * and the outcome of the writes they make:
 *   A  applicator assigned to job A (scheduled) and job E (invoiced yesterday)
 *   D  applicator dispatched to job B's field
 *   K  driver, active member of a crew dispatched to job C's field (no applicator on C)
 *   rep (sales rep) and admin
 * Reads: jobs, job_chemicals, job_fields, job_field_shares, field_billing_defaults, customers, applied info / records /
 * record fields / record crew, attachments and their storage objects, loader worksheets, dispatches, EPA, tags, notes,
 * billed customers, dispatched list, loader weights (both entry modes), the dispatch board for A, D and K.
 * Writes (each rolled back): applied info on A/B/C, applied records on A/B, the invoiced job E's record, record field and
 * record crew rows, a record field insert, attachment and storage inserts on A/B and a bad folder, an attachment delete.
 *
 * Expected (contract §4): after the candidate every result is identical except the dispatch board rows for A and D,
 * which lose total_price_cents, internal_memo and commission_split (admin and rep keep them); each crew view returns,
 * per user, exactly the rows its base table returns and none of the protected columns; anon reads no view.
 * Autocommit is refused by the preflight; apply prints POSTFLIGHT_OK; re-apply is refused; the reverse
 * (scripts/smoke/applicator-crew-read-path-reverse.sql) returns every result to the before state.
 *
 * Run: node scripts/smoke/prove-applicator-crew-read-path-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a container built up to (not including) the candidate: UNDO_PATHS_CONTAINER=<name> CREW_READ_PROOF_REUSE=1
 * Prints CREW_READ_PATH_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, scalar, psql, attempt, id, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270307190000_applicator_crew_read_path.sql';
const reuse = process.env.CREW_READ_PROOF_REUSE === '1';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const run = (flags) => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...flags], { input: candidate, allowFailure: true });

const A = USERS.applicator;
const D = id('d1');
const K = USERS.driver;
const ACTORS = { A, D, K, rep: USERS.rep, admin: USERS.admin };
const JOBS = ['A', 'B', 'C', 'E'];
const J = (k) => `md5('crp-job-${k}')::uuid`;
const PRODUCT = id('e1');

function seed() {
  if (scalar(`SELECT count(*) FROM public.jobs WHERE id = ${J('A')};`) === '1') return;
  if (scalar(`SELECT count(*) FROM auth.users WHERE id = '${USERS.admin}';`) === '0') seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${D}', 'crp-d@example.invalid', '{"full_name":"[CRP] Dispatchee","role":"applicator"}'::jsonb) ON CONFLICT DO NOTHING;`);
  // Live has row security on storage.objects and grants it to signed-in users; the container's stub has neither.
  psql('ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY; GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;', { user: 'supabase_admin' });
  // Fixtures only: replica skips foreign keys and triggers (the product row is not needed by any read compared here).
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, account_number)
      SELECT md5('crp-cust-'||k)::uuid, '[CRP] Grower '||k, 'CRP-'||k FROM unnest(array['A','B','C','E','P']) k;
    INSERT INTO public.ground_crews (id, name, is_active) VALUES (md5('crp-crew')::uuid, '[CRP] crew', true);
    INSERT INTO public.ground_crew_members (crew_id, name, profile_id, is_active) VALUES (md5('crp-crew')::uuid, '[CRP] K', '${K}', true);
    INSERT INTO public.job_tags (id, name) VALUES (md5('crp-tag')::uuid, '[CRP] tag');
    DO $$
    DECLARE k text; jid uuid; fid uuid; cid uuid; rid uuid; jfid uuid;
    BEGIN
      FOREACH k IN ARRAY array['A','B','C','E'] LOOP
        jid := md5('crp-job-'||k)::uuid; fid := md5('crp-field-'||k)::uuid; cid := md5('crp-cust-'||k)::uuid;
        rid := md5('crp-rec-'||k)::uuid; jfid := md5('crp-jf-'||k)::uuid;
        INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES (fid, cid, '[CRP] Field '||k, 50);
        INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary)
          VALUES (fid, cid, 70, true), (fid, md5('crp-cust-P')::uuid, 30, false);
        INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, applicator_id, total_acres, total_price_cents,
                                 total_cost_cents, internal_memo, commission_split, completed_at)
          VALUES (jid, 'CRP-'||k, cid, CASE k WHEN 'E' THEN 'invoiced' ELSE 'scheduled' END, current_date,
                  CASE WHEN k IN ('A','E') THEN '${A}'::uuid END, 50, 99900, 55500, 'CRP SECRET MEMO '||k,
                  '{"splits":[]}'::jsonb, CASE WHEN k = 'E' THEN now() - interval '1 day' END);
        INSERT INTO public.job_fields (id, job_id, field_id, acres_to_treat, sort_order) VALUES (jfid, jid, fid, 50, 0);
        INSERT INTO public.job_chemicals (id, job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, cost_per_unit_cents, sort_order)
          VALUES (md5('crp-chem-'||k)::uuid, jid, '${PRODUCT}', 50, 'gal', 1, 'gal', 2500, 1500, 0);
        INSERT INTO public.job_field_shares (id, job_id, field_id, customer_id, split_pct, is_primary)
          VALUES (md5('crp-share1-'||k)::uuid, jid, fid, cid, 70, true), (md5('crp-share2-'||k)::uuid, jid, fid, md5('crp-cust-P')::uuid, 30, false);
        INSERT INTO public.job_applied_info (job_id) VALUES (jid);
        INSERT INTO public.job_applied_records (id, job_id, application_date) VALUES (rid, jid, current_date);
        INSERT INTO public.job_applied_record_fields (id, application_record_id, field_id) VALUES (md5('crp-rf-'||k)::uuid, rid, fid);
        INSERT INTO public.job_applied_record_crew (id, application_record_id, member_name_snapshot) VALUES (md5('crp-rc-'||k)::uuid, rid, '[CRP] crew');
        INSERT INTO public.job_attachments (id, job_id, storage_path, file_name) VALUES (md5('crp-att-'||k)::uuid, jid, jid::text || '/crp.txt', 'crp.txt');
        INSERT INTO storage.objects (bucket_id, name) VALUES ('job-attachments', jid::text || '/crp.txt');
        INSERT INTO public.job_loader_worksheets (id, job_id, capacity_gal) VALUES (md5('crp-lw-'||k)::uuid, jid, 500);
        INSERT INTO public.job_product_epa (job_id, product_id) VALUES (jid, '${PRODUCT}');
        INSERT INTO public.job_tag_assignments (job_id, tag_id) VALUES (jid, md5('crp-tag')::uuid);
        INSERT INTO public.team_notes (id, title, content, created_by, linked_entity_type, linked_entity_id)
          VALUES (md5('crp-note-'||k)::uuid, '[CRP] note '||k, 'x', '${USERS.admin}', 'job', jid);
        IF k = 'B' THEN
          INSERT INTO public.job_location_dispatches (id, job_field_id, job_id, applicator_id, dispatch_status)
            VALUES (md5('crp-disp-B')::uuid, jfid, jid, '${D}', 'dispatched');
        ELSIF k = 'C' THEN
          INSERT INTO public.job_location_dispatches (id, job_field_id, job_id, crew_id, dispatch_status)
            VALUES (md5('crp-disp-C')::uuid, jfid, jid, md5('crp-crew')::uuid, 'dispatched');
        END IF;
      END LOOP;
    END $$;
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role, ',' ORDER BY role) FROM public.profiles WHERE id IN ('${A}','${D}','${K}');`), 'applicator,applicator,driver');
}

// "<job letter>:<row tag>" lists, so a result names exactly which rows a user read.
const L = (col) => `(SELECT k FROM unnest(array['A','B','C','E']) k WHERE md5('crp-job-'||k)::uuid = ${col})`;
const list = (expr, from) => `(SELECT coalesce(json_agg(x ORDER BY x)::text, '[]') FROM (SELECT ${expr} AS x FROM ${from}) s WHERE x IS NOT NULL)`;
const rows = (from, jobCol, idCol) => list(`${L(jobCol)} || ':' || left(${idCol}::text, 8)`, from);
const PROTECTED = "('total_price_cents','total_cost_cents','internal_memo','commission_split','price_per_unit_cents','cost_per_unit_cents','split_pct')";
const board = (uid) => `public.get_dispatch_board_jobs('${uid}'::uuid, NULL, current_date - 30, current_date + 30)`;
const boardKeys = (uid) => `(SELECT coalesce(json_agg(DISTINCT key ORDER BY key)::text, '[]')
  FROM ${board(uid)} b, jsonb_path_query(b, 'strict $.**') node,
       jsonb_object_keys(CASE WHEN jsonb_typeof(node) = 'object' THEN node ELSE '{}' END) key
  WHERE b ->> 'job_number' LIKE 'CRP-%' AND key IN ${PROTECTED})`;
const JOB_IDS = `ARRAY[${JOBS.map(J).join(', ')}]`;

const READS = {
  jobs: rows('public.jobs t', 't.id', 't.id'),
  jobs_protected: list(`${L('t.id')} || ':' || coalesce(t.total_price_cents::text, '-') || '/' || coalesce(t.internal_memo, '-') || '/' || coalesce(t.commission_split::text, '-')`, 'public.jobs t'),
  job_chemicals: rows('public.job_chemicals t', 't.job_id', 't.id'),
  job_chemicals_price: list(`${L('t.job_id')} || ':' || coalesce(t.price_per_unit_cents::text, '-')`, 'public.job_chemicals t'),
  job_fields: rows('public.job_fields t', 't.job_id', 't.id'),
  job_field_shares: rows('public.job_field_shares t', 't.job_id', 't.id'),
  job_field_shares_split: list(`${L('t.job_id')} || ':' || left(t.id::text, 8) || ':' || t.split_pct`, 'public.job_field_shares t'),
  field_billing_defaults: list(`right(f.field_name, 1) || ':' || left(t.id::text, 8)`, "public.field_billing_defaults t JOIN public.fields f ON f.id = t.field_id AND f.field_name LIKE '[CRP]%'"),
  field_billing_defaults_split: list(`right(f.field_name, 1) || ':' || t.split_pct`, "public.field_billing_defaults t JOIN public.fields f ON f.id = t.field_id AND f.field_name LIKE '[CRP]%'"),
  customers: list('right(farm_name, 1)', "public.customers WHERE farm_name LIKE '[CRP]%'"),
  applied_info: rows('public.job_applied_info t', 't.job_id', 't.job_id'),
  applied_records: rows('public.job_applied_records t', 't.job_id', 't.id'),
  applied_record_fields: rows('public.job_applied_record_fields t JOIN public.job_applied_records r ON r.id = t.application_record_id', 'r.job_id', 't.id'),
  applied_record_crew: rows('public.job_applied_record_crew t JOIN public.job_applied_records r ON r.id = t.application_record_id', 'r.job_id', 't.id'),
  attachments: rows('public.job_attachments t', 't.job_id', 't.id'),
  storage_objects: list("o.name", "storage.objects o WHERE o.bucket_id = 'job-attachments' AND o.name LIKE '%/crp.txt'"),
  loader_worksheets: rows('public.job_loader_worksheets t', 't.job_id', 't.id'),
  dispatches: rows('public.job_location_dispatches t', 't.job_id', 't.id'),
  epa: rows('public.job_product_epa t', 't.job_id', 't.job_id'),
  tags: rows('public.job_tag_assignments t', 't.job_id', 't.job_id'),
  notes: `(SELECT json_object_agg(k, (SELECT count(*) FROM public.get_notes_for_entity('job', md5('crp-job-'||k)::uuid)) ORDER BY k)::text FROM unnest(array['A','B','C','E']) k)`,
  dispatched_list: `(SELECT coalesce(json_agg(to_jsonb(r) ->> 'job_number' ORDER BY to_jsonb(r) ->> 'job_number')::text, '[]') FROM public.get_dispatched_list(auth.uid(), NULL) r WHERE to_jsonb(r)::text LIKE '%CRP-%')`,
  loader_by_jobs: `((public.get_loader_worksheet_weights(NULL, ${JOB_IDS}) - 'read_at')::text)`,
  loader_by_worksheets: `((public.get_loader_worksheet_weights((SELECT array_agg(md5('crp-lw-'||k)::uuid ORDER BY k) FROM unnest(array['A','B','C','E']) k), NULL) - 'read_at')::text)`,
};
for (const k of JOBS) READS[`billed_customers_${k}`] = `(SELECT coalesce(json_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text, '[]') FROM public.get_job_billed_customers(${J(k)}) r)`;
for (const [who, uid] of [['A', A], ['D', D], ['K', K]]) {
  READS[`board_${who}_jobs`] = `(SELECT coalesce(json_agg(b ->> 'job_number' ORDER BY b ->> 'job_number')::text, '[]') FROM ${board(uid)} b WHERE b ->> 'job_number' LIKE 'CRP-%')`;
  READS[`board_${who}_protected_keys`] = boardKeys(uid);
  READS[`board_${who}_total_count`] = `(SELECT coalesce(bool_and(b ? '_total_count'), true)::text FROM ${board(uid)} b WHERE b ->> 'job_number' LIKE 'CRP-%')`;
}
const VIEW_READS = {
  view_jobs: rows('public.jobs_crew t', 't.id', 't.id'),
  view_job_chemicals: rows('public.job_chemicals_crew t', 't.job_id', 't.id'),
  view_job_field_shares: rows('public.job_field_shares_crew t', 't.job_id', 't.id'),
  view_field_billing_defaults: list(`right(f.field_name, 1) || ':' || left(t.id::text, 8)`, "public.field_billing_defaults_crew t JOIN public.fields f ON f.id = t.field_id AND f.field_name LIKE '[CRP]%'"),
};
const count = (dml) => `WITH w AS (${dml} RETURNING 1) SELECT count(*) FROM w`;
const rec = (k) => `md5('crp-rec-${k}')::uuid`;
const WRITES = {
  update_applied_info_A: count(`UPDATE public.job_applied_info SET updated_at = updated_at WHERE job_id = ${J('A')}`),
  update_applied_info_B: count(`UPDATE public.job_applied_info SET updated_at = updated_at WHERE job_id = ${J('B')}`),
  update_applied_info_C: count(`UPDATE public.job_applied_info SET updated_at = updated_at WHERE job_id = ${J('C')}`),
  update_record_A: count(`UPDATE public.job_applied_records SET notes = notes WHERE job_id = ${J('A')}`),
  update_record_B: count(`UPDATE public.job_applied_records SET notes = notes WHERE job_id = ${J('B')}`),
  update_record_E_invoiced: count(`UPDATE public.job_applied_records SET notes = 'x' WHERE job_id = ${J('E')}`),
  delete_record_E_invoiced: count(`DELETE FROM public.job_applied_records WHERE job_id = ${J('E')}`),
  update_record_field_E_invoiced: count(`UPDATE public.job_applied_record_fields SET field_id = field_id WHERE application_record_id = ${rec('E')}`),
  delete_record_crew_E_invoiced: count(`DELETE FROM public.job_applied_record_crew WHERE application_record_id = ${rec('E')}`),
  delete_record_crew_A: count(`DELETE FROM public.job_applied_record_crew WHERE application_record_id = ${rec('A')}`),
  insert_record_field_A: count(`INSERT INTO public.job_applied_record_fields (application_record_id, field_id) VALUES (${rec('A')}, md5('crp-field-B')::uuid)`),
  insert_attachment_A: count(`INSERT INTO public.job_attachments (job_id, storage_path, file_name, uploaded_by) VALUES (${J('A')}, ${J('A')}::text || '/probe.txt', 'probe.txt', auth.uid())`),
  insert_attachment_B: count(`INSERT INTO public.job_attachments (job_id, storage_path, file_name, uploaded_by) VALUES (${J('B')}, ${J('B')}::text || '/probe.txt', 'probe.txt', auth.uid())`),
  delete_attachment_A: count(`DELETE FROM public.job_attachments WHERE job_id = ${J('A')}`),
  insert_storage_A: count(`INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('job-attachments', ${J('A')}::text || '/probe.txt', auth.uid()::text)`),
  insert_storage_B: count(`INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('job-attachments', ${J('B')}::text || '/probe.txt', auth.uid()::text)`),
  insert_storage_bad_folder: count(`INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('job-attachments', 'not-a-job/probe.txt', auth.uid()::text)`),
};

// One rolled-back probe per user: each check runs as `authenticated` in its own sub-transaction; a write is undone
// by raising after its row count is kept (plpgsql variables survive the rollback of their block).
function snapshot(uid, withViews) {
  const checks = { ...READS, ...(withViews ? VIEW_READS : {}) };
  const body = [
    "r := '{}'::jsonb;",
    ...Object.entries(checks).map(([k, q]) => `BEGIN SET LOCAL ROLE authenticated; t := ${q}; RESET ROLE;
      EXCEPTION WHEN OTHERS THEN t := 'ERROR ' || SQLERRM; END; r := r || jsonb_build_object('${k}', t);`),
    ...Object.entries(WRITES).map(([k, q]) => `t := NULL; BEGIN SET LOCAL ROLE authenticated; ${q} INTO n; t := n::text; RESET ROLE;
      RAISE EXCEPTION 'crp-undo'; EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'crp-undo' THEN t := 'ERROR ' || SQLERRM; END IF; END;
      r := r || jsonb_build_object('${k}', t);`),
    'v := r::text;',
  ].join('\n');
  const out = attempt(uid, body);
  assert.ok(out.startsWith('ok|'), `snapshot failed: ${out}`);
  return JSON.parse(out.slice(3));
}
const all = (withViews) => Object.fromEntries(Object.entries(ACTORS).map(([r, u]) => [r, snapshot(u, withViews)]));

try {
  if (!reuse) buildContainer({ stopBefore: CANDIDATE });
  assert.equal(scalar("SELECT to_regclass('public.jobs_crew') IS NULL;"), 't', 'the container must not have the candidate');
  seed();

  const before = all(false);
  console.log('BEFORE', JSON.stringify(before, null, 1));
  // The leak, reproduced: crew read prices, splits and memo today.
  assert.deepEqual(JSON.parse(before.A.jobs).map((x) => x[0]), ['A', 'E']);
  assert.deepEqual(JSON.parse(before.D.jobs).map((x) => x[0]), ['B']);
  assert.deepEqual(JSON.parse(before.K.jobs).map((x) => x[0]), ['C']);
  assert.deepEqual(JSON.parse(before.A.board_A_protected_keys), ['commission_split', 'internal_memo', 'total_price_cents']);
  assert.deepEqual(JSON.parse(before.D.board_D_protected_keys), ['commission_split', 'internal_memo', 'total_price_cents']);
  assert.match(before.A.job_chemicals_price, /2500/);
  assert.match(before.A.job_field_shares_split, /70/);
  // Writes behave as the contract states today.
  assert.equal(before.A.update_applied_info_A, '1');
  assert.equal(before.A.insert_attachment_A, '1');
  assert.equal(before.A.insert_storage_A, '1');
  assert.match(before.A.insert_attachment_B, /^ERROR new row violates row-level security/);
  assert.match(before.A.insert_storage_bad_folder, /^ERROR new row violates row-level security/);
  for (const w of ['update_record_E_invoiced', 'delete_record_E_invoiced', 'update_record_field_E_invoiced', 'delete_record_crew_E_invoiced']) {
    assert.match(before.A[w], /billed history/, `${w} must be refused by the billed-history trigger`);
  }

  const auto = run([]);
  assert.notEqual(auto.status, 0, 'an autocommit run must fail');
  assert.match(auto.stderr, /PREFLIGHT_FAIL: run this file as one transaction/);
  assert.equal(scalar("SELECT to_regclass('public.jobs_crew') IS NULL;"), 't', 'autocommit changed nothing');
  console.log('AUTOCOMMIT: refused by the preflight, nothing changed');

  const applied = run(['-1']);
  assert.equal(applied.status, 0, `apply failed:\n${applied.stderr}`);
  assert.match(applied.stderr, /POSTFLIGHT_OK/);
  console.log('APPLY: POSTFLIGHT_OK');

  const after = all(true);
  console.log('AFTER', JSON.stringify(after, null, 1));
  const changed = [];
  for (const [r, res] of Object.entries(before)) {
    for (const [k, v] of Object.entries(res)) if (after[r][k] !== v) changed.push(`${r}.${k}`);
  }
  assert.deepEqual(changed.sort(), ['A.board_A_protected_keys', 'D.board_D_protected_keys'], 'only the crew board rows may change');
  assert.equal(after.A.board_A_protected_keys, '[]');
  assert.equal(after.D.board_D_protected_keys, '[]');
  assert.deepEqual(JSON.parse(after.A.board_A_jobs), ['CRP-A', 'CRP-E']);
  assert.deepEqual(JSON.parse(after.D.board_D_jobs), ['CRP-B']);
  assert.equal(after.K.board_K_jobs, '[]', "K is on no applicator's board");
  for (const w of ['A', 'D']) assert.equal(after[w][`board_${w}_total_count`], 'true');
  for (const r of ['admin', 'rep']) {
    assert.deepEqual(JSON.parse(after[r].board_A_protected_keys), ['commission_split', 'internal_memo', 'total_price_cents'], `${r} board unchanged`);
  }
  console.log('BEFORE = AFTER for every read and write, except the crew board rows, which lost price, memo and commission split');

  for (const [r, res] of Object.entries(after)) {
    for (const t of ['jobs', 'job_chemicals', 'job_field_shares', 'field_billing_defaults']) {
      assert.equal(res[`view_${t}`], res[t], `${r}: ${t}_crew must return exactly the ${t} rows`);
    }
  }
  console.log('VIEWS: each crew view returns, per user, exactly the rows its base table returns');

  assert.equal(scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name IN ('jobs_crew','job_chemicals_crew','job_field_shares_crew','field_billing_defaults_crew')
    AND column_name IN ${PROTECTED.replace(')', ",'price_override_cents','pricing_note')")};`), '0');
  const anon = attempt(A, `BEGIN SET LOCAL ROLE anon; PERFORM 1 FROM public.jobs_crew LIMIT 1; t := 'READ'; RESET ROLE;
    EXCEPTION WHEN OTHERS THEN t := SQLERRM; END; v := t;`);
  assert.match(anon, /^ok\|permission denied/);
  const write = attempt(A, `BEGIN SET LOCAL ROLE authenticated; UPDATE public.jobs_crew SET notes = notes; t := 'WROTE'; RESET ROLE;
    EXCEPTION WHEN OTHERS THEN t := SQLERRM; END; v := t;`);
  assert.match(write, /^ok\|permission denied/);
  console.log('VIEWS: no protected column; anon cannot read; a signed-in user cannot write through them');

  const again = run(['-1']);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists \(already applied\?\)/);
  console.log('RE-APPLY: refused by the preflight');

  const reverse = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1'],
    { input: readFileSync(path.join(ROOT, 'scripts', 'smoke', 'applicator-crew-read-path-reverse.sql'), 'utf8').replaceAll('\r\n', '\n'), allowFailure: true });
  assert.equal(reverse.status, 0, `reverse failed:\n${reverse.stderr}`);
  assert.equal(scalar("SELECT to_regclass('public.jobs_crew') IS NULL AND to_regclass('public.field_billing_defaults_crew') IS NULL;"), 't');
  assert.deepEqual(all(false), before, 'after the reverse every result equals the before state');
  console.log('REVERSE: views removed; every read and write is back to the before state');
  console.log('\nCREW_READ_PATH_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
