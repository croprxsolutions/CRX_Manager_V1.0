#!/usr/bin/env node
/**
 * Real-schema proof for 20270130100000_epa_batch_commit_checks_at_save (issue #1976).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate (the shared undo-paths harness), shows the hole
 * (commit_epa_proposal saves while a brand with a second EPA number is being saved at the same moment), applies the candidate,
 * then proves commit_epa_proposal_batch:
 *   B1 saves a plain proposal; an identical retry returns the same receipt.
 *   B2 refuses when the product has a second EPA number; the proposal stays open, nothing is written.
 *   B3 refuses when another proposal for that number was rejected.
 *   R1 race: a second EPA number saved while the batch save runs is waited out, then the save is refused.
 *   R2 race: two admins batch the same product; the first saves, the second admin's save is refused.
 *   C1-C5 the rest of the screen's decision, re-made at save: the decisions decline every label item (C1), EPA's
 *     name matches the product (C2), a label fact edited since the lookup (C3), another lookup running (C4) or
 *     a failed one (C5) all refuse.
 *   B4 a sales rep and anon cannot call it.
 *
 * Run: node scripts/smoke/prove-epa-batch-commit-real-schema.mjs   (needs Docker)
 * Prints EPA_BATCH_COMMIT_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

process.env.UNDO_PATHS_CONTAINER ||= `crx-epa-batch-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, scalar, psql, USERS, ROOT, NAME, docker, id } =
  await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270130100000_epa_batch_commit_checks_at_save.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const ADMIN = USERS.admin;
const ADMIN2 = id('a9');
const REP = USERS.rep;
const SERVICE = 'service';
// One product (parent) per case, each with its own EPA number; S* is a size of it carrying the same number.
const CASES = ['hole', 'b1', 'b2', 'b3', 'r1', 'r2', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
const P = Object.fromEntries(CASES.map((k, i) => [k, id(`e${i + 1}`)]));
const S = Object.fromEntries(CASES.map((k, i) => [k, id(`f${i + 1}`)]));
const NUM = Object.fromEntries(CASES.map((k, i) => [k, `${701 + i}-1`]));

const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const psqlArgs = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
function txIn(uid, sql, end = 'COMMIT') {
  if (uid === SERVICE) return `BEGIN;\nSET LOCAL ROLE service_role;\n${sql}\n${end};\n`;
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  return `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\n${end};\n`;
}
function as(uid, sql, end) {
  const r = docker(psqlArgs, { allowFailure: true, input: txIn(uid, sql, end) });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) };
}
// The same, in the background, for the two-session races.
function asAsync(uid, sql) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('docker', psqlArgs, { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ status: code, output: out, ms: Date.now() - t0 }));
    p.stdin.end(txIn(uid, sql));
  });
}
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const js = (uid, sql) => { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return JSON.parse(r.last); };
const refused = (uid, sql, pattern) => { const r = as(uid, sql); assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`); assert.match(r.output, pattern); };

let seq = 0;
const key = (tag) => `epa-batch-${tag}-${++seq}`;
const found = (num, productname = `[PROVER] ${num}`) => ({
  found: true, regType: 'section3', eparegno: num, productname, manufacturer: 'Prover Co', productStatus: 'Registered',
  latestLabelPdfUrl: null, signalWordCanonical: 'Caution', needsManual: false, isCancelled: false, rupYn: 'No',
  activeIngredients: [{ name: 'Atrazine', percent: 42.6, pcCode: null, casNumber: '1912-24-9' }], labelPdfs: [],
});
const START = (k, uid = ADMIN) => js(uid, `SELECT public.start_epa_lookup('${P[k]}', '${NUM[k]}', '${key('s')}');`);
const RECORD = (lookupId, num, name) => js(SERVICE, `SELECT public.record_epa_lookup('${lookupId}', ${J(found(num, name))}, '${key('r')}');`);
const propose = (k, uid = ADMIN, name = undefined) => {
  const r = RECORD(START(k, uid).lookup_id, NUM[k], name);
  assert.equal(r.outcome, 'proposal', JSON.stringify(r));
  return r.proposal_id;
};
const proposal = (pid) => JSON.parse(scalar(`SELECT to_jsonb(p) FROM public.epa_chemistry_proposals p WHERE id = '${pid}';`));
// As the screen sends them (batchDecision): every item the server could write, decided; only ingredients accepted.
const WRITABLE = new Set(['add', 'add_name_only', 'fill', 'confirm', 'rup_upgrade']);
const decisions = (pid) => proposal(pid).items.filter((i) => WRITABLE.has(i.class)).map((i) => ({ item_id: i.item_id, accept: i.kind === 'ingredient' }));
const ingredientsOnly = (pid) => proposal(pid).items.filter((i) => i.kind === 'ingredient').map((i) => ({ item_id: i.item_id, accept: true }));
const BATCH = (pid, k = key('c'), d = decisions(pid)) => `SELECT public.commit_epa_proposal_batch('${pid}', ${proposal(pid).proposal_version}, ${J(d)}, '${k}');`;
const registration = (k) => scalar(`SELECT to_jsonb(r) - 'registration_version' - 'updated_at' FROM public.epa_registrations r WHERE epa_registration = '${NUM[k]}';`);
const lookupOf = (pid) => proposal(pid).lookup_id;
const PLAIN = (pid) => `SELECT public.commit_epa_proposal('${pid}', ${proposal(pid).proposal_version}, ${J(decisions(pid))}, '${key('p')}');`;
const ingredients = (k) => Number(scalar(`SELECT count(*) FROM public.product_parent_ingredients WHERE parent_id = '${P[k]}';`));
// A second EPA number, the way the app adds one: a brand saved from the size's page (upsert_parent_brand).
const SECOND_NUMBER = (k) => `SELECT public.upsert_parent_brand('${P[k]}', '${S[k]}', '[PROVER] ${k} brand', '${NUM[k].replace(/-1$/, '-2')}',
  NULL, true, false, NULL, NULL, NULL, false, NULL, '${key('b')}');`;
const numbers = (k) => scalar(`SELECT string_agg(epa_registration, ',' ORDER BY epa_registration) FROM public.product_parent_brands WHERE parent_id = '${P[k]}' AND status = 'active';`);

function seed() {
  buildContainer({ stopBefore: CANDIDATE }); seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN2}', 'epa-batch-admin2@example.invalid', '{"full_name":"[PROVER] Admin Two","role":"admin"}'::jsonb);`);
  const parents = CASES.map((k) => `('${P[k]}', '[PROVER] ${k}', 'liquid', 'SL', 'Herbicide', '${NUM[k]}', true, '${ADMIN}', '${ADMIN}')`);
  const sizes = CASES.map((k) => `('${S[k]}', '[PROVER] ${k} 2.5', 'EPAB-${k}', 'liquid', 'Gal', 'Herbicide', '${NUM[k]}', 10.00, true)`);
  const regs = CASES.flatMap((k) => [NUM[k], NUM[k].replace(/-1$/, '-2')]).map((n) => `('${n}', 'unknown', NULL, 'no', '${ADMIN}', '${ADMIN}')`);
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id IN ('${ADMIN}', '${ADMIN2}');
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.product_parents (id, name, product_form, formulation_type, category, generic_epa_registration, is_active, created_by, updated_by)
      VALUES ${parents.join(', ')};
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, tier1_price, is_active)
      VALUES ${sizes.join(', ')};
    INSERT INTO public.product_parent_members (product_id, parent_id, added_by) VALUES ${CASES.map((k) => `('${S[k]}', '${P[k]}', '${ADMIN}')`).join(', ')};
    INSERT INTO public.epa_registrations (epa_registration, registration_status, cancelled_on, rup_status, created_by, updated_by)
      VALUES ${regs.join(', ')};
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
}

async function main() {
  seed();

  // BEFORE (the hole, issue #1976): commit_epa_proposal saves while a second EPA number is saved at the same moment.
  const holeId = propose('hole');
  const holeWriter = asAsync(ADMIN, `${SECOND_NUMBER('hole')} SELECT pg_sleep(2);`);
  await pause(500);
  const holeCommit = await asAsync(ADMIN, PLAIN(holeId));
  const hw = await holeWriter;
  assert.equal(hw.status, 0, hw.output);
  assert.equal(numbers('hole'), NUM.hole.replace(/-1$/, '-2'));
  assert.equal(holeCommit.status, 0, holeCommit.output);
  assert.equal(proposal(holeId).status, 'committed');
  assert.equal(ingredients('hole'), 1);
  console.log('[epa-batch] BEFORE: the product-page save wrote ingredients although a second EPA number was being saved (the hole is real)');

  const applied = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
    { input: candidate, allowFailure: true });
  assert.equal(applied.status, 0, `candidate failed:\n${applied.stderr}`);
  const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
    { input: candidate, allowFailure: true });
  assert.notEqual(again.status, 0); assert.match(again.stderr, /EPA_BATCH_PREFLIGHT: commit_epa_proposal_batch already exists/);
  console.log('[epa-batch] candidate applied; postflight passed; a second apply is refused by the preflight');

  // B1: a plain proposal saves; an identical retry returns the same receipt and writes nothing more.
  const b1 = propose('b1');
  const k1 = key('c');
  const sql1 = BATCH(b1, k1);
  const regBefore = registration('b1');
  const first = js(ADMIN, sql1);
  assert.equal(first.status, 'committed'); assert.equal(ingredients('b1'), 1);
  assert.equal(registration('b1'), regBefore, 'the batch must never write a label fact');
  assert.deepEqual(js(ADMIN, sql1), first);
  assert.equal(ingredients('b1'), 1);
  console.log('[epa-batch] B1: a plain proposal saves its ingredient; an identical retry returns the same receipt');

  // B2: a second EPA number on a size: refused, nothing written, the proposal stays open for a person.
  const b2 = propose('b2');
  const edit = as(ADMIN, SECOND_NUMBER('b2'));
  assert.equal(edit.status, 0, edit.output); assert.equal(numbers('b2'), '703-2');
  refused(ADMIN, BATCH(b2), /EPA_BATCH_NOT_ELIGIBLE: its EPA numbers changed \(now 703-1, 703-2\); nothing was saved/);
  assert.equal(proposal(b2).status, 'proposed'); assert.equal(ingredients('b2'), 0);
  console.log('[epa-batch] B2: two EPA numbers: refused, nothing written, proposal still open');

  // B3: another proposal for the same number was rejected: refused.
  const b3a = propose('b3');
  js(ADMIN, `SELECT public.reject_epa_proposal('${b3a}', ${proposal(b3a).proposal_version}, 'wrong label', '${key('j')}');`);
  const b3 = propose('b3');
  refused(ADMIN, BATCH(b3), /EPA_BATCH_NOT_ELIGIBLE: another proposal is waiting or was rejected; nothing was saved/);
  assert.equal(proposal(b3).status, 'proposed'); assert.equal(ingredients('b3'), 0);
  console.log('[epa-batch] B3: another proposal was rejected: refused, nothing written');

  // R1: a second EPA number saved at the same moment as the batch save: waited out, then refused.
  const r1 = propose('r1');
  const writer = asAsync(ADMIN2, `${SECOND_NUMBER('r1')} SELECT pg_sleep(2);`);
  await pause(500);
  const r1Commit = await asAsync(ADMIN, BATCH(r1));
  const w = await writer;
  assert.equal(w.status, 0, w.output); assert.equal(numbers('r1'), '705-2');
  assert.notEqual(r1Commit.status, 0, r1Commit.output);
  assert.match(r1Commit.output, /EPA_BATCH_NOT_ELIGIBLE: its EPA numbers changed \(now 705-1, 705-2\)/);
  assert.ok(r1Commit.ms > 1000, `the batch save should have waited for the number edit (${r1Commit.ms} ms)`);
  assert.equal(proposal(r1).status, 'proposed'); assert.equal(ingredients('r1'), 0);
  console.log(`[epa-batch] R1: race with a number edit: the save waited ${r1Commit.ms} ms, then refused; nothing written`);

  // R2: two admins batch the same product. Admin 1's save is in flight when admin 2's lookup starts; admin 2's
  // lookup waits, records after admin 1's save, and admin 2's save is refused.
  const r2a = propose('r2');
  const save1 = asAsync(ADMIN, `${BATCH(r2a)} SELECT pg_sleep(2);`);
  await pause(500);
  const start2 = await asAsync(ADMIN2, `SELECT public.start_epa_lookup('${P.r2}', '${NUM.r2}', '${key('s')}');`);
  const s1 = await save1;
  assert.equal(s1.status, 0, s1.output);
  assert.equal(start2.status, 0, start2.output);
  assert.ok(start2.ms > 1000, `admin 2's lookup should have waited for admin 1's save (${start2.ms} ms)`);
  assert.equal(proposal(r2a).status, 'committed'); assert.equal(ingredients('r2'), 1);
  const lookup2 = JSON.parse(start2.output.trim().split(/\r?\n/).filter(Boolean).at(-1)).lookup_id;
  const r2b = RECORD(lookup2, NUM.r2).proposal_id;
  refused(ADMIN2, BATCH(r2b), /EPA_BATCH_NOT_ELIGIBLE: ingredients were added meanwhile; nothing was saved/);
  assert.equal(proposal(r2b).status, 'proposed'); assert.equal(ingredients('r2'), 1);
  console.log(`[epa-batch] R2: two admins: the first save wins; the second admin's lookup waited ${start2.ms} ms and their save is refused`);

  // C1: decisions that leave a label item to its default are refused (the signal word blank, EPA says Caution).
  const c1 = propose('c1');
  assert.ok(proposal(c1).items.some((i) => i.kind === 'label' && WRITABLE.has(i.class) && i.accept_default === true),
    'C1 needs a label item that would be written by default');
  const reg1 = registration('c1');
  refused(ADMIN, BATCH(c1, key('c'), ingredientsOnly(c1)), /EPA_BATCH_DECISION_INVALID: the batch saves every ingredient and nothing else/);
  assert.equal(proposal(c1).status, 'proposed'); assert.equal(ingredients('c1'), 0); assert.equal(registration('c1'), reg1);
  console.log('[epa-batch] C1: a label item left to its default: refused, nothing written, registration unchanged');
  const declined = decisions(c1).map((d) => (d.item_id.startsWith('ing:') ? { ...d, accept: false } : d));
  refused(ADMIN, BATCH(c1, key('c'), declined), /EPA_BATCH_DECISION_INVALID/);
  assert.equal(ingredients('c1'), 0);
  console.log('[epa-batch] C1: an ingredient declined: refused (the batch saves every ingredient or none)');

  // C2: EPA's name shares no word with the product's names.
  const c2 = propose('c2', ADMIN, 'Zolto Fungicide');
  refused(ADMIN, BATCH(c2), /EPA_BATCH_NOT_ELIGIBLE: EPA name "Zolto Fungicide" does not match this product; nothing was saved/);
  assert.equal(ingredients('c2'), 0);
  console.log('[epa-batch] C2: EPA name does not match: refused');

  // C3: another admin sets the signal word after the lookup: the label now differs, so it waits for a person.
  const c3 = propose('c3');
  const v3 = scalar(`SELECT registration_version FROM public.epa_registrations WHERE epa_registration = '${NUM.c3}';`);
  js(ADMIN2, `SELECT public.set_epa_registration('${NUM.c3}', ${v3}, '{"signal_word":"Danger"}'::jsonb, 'prover edit', NULL, '${key('e')}');`);
  refused(ADMIN, BATCH(c3), /EPA_BATCH_NOT_ELIGIBLE: label fact changed since the lookup \(signal_word\); nothing was saved/);
  assert.equal(proposal(c3).status, 'proposed'); assert.equal(ingredients('c3'), 0);
  console.log('[epa-batch] C3: a label fact edited since the lookup: refused');

  // C6: the registration is recorded as cancelled here after the lookup (EPA said it was not).
  const c6 = propose('c6');
  const v6 = scalar(`SELECT registration_version FROM public.epa_registrations WHERE epa_registration = '${NUM.c6}';`);
  js(ADMIN2, `SELECT public.set_epa_registration('${NUM.c6}', ${v6}, '{"registration_status":"cancelled","cancelled_on":"2026-11-01"}'::jsonb, 'prover edit', NULL, '${key('e')}');`);
  refused(ADMIN, BATCH(c6), /EPA_BATCH_NOT_ELIGIBLE: label fact changed since the lookup \(registration_status\); nothing was saved/);
  assert.equal(ingredients('c6'), 0);
  console.log('[epa-batch] C6: registration cancelled since the lookup: refused');

  // C7: the recorded signal word agreed with EPA, then another admin cleared it: still an edit, refused.
  const setWord = (k, word) => {
    const v = scalar(`SELECT registration_version FROM public.epa_registrations WHERE epa_registration = '${NUM[k]}';`);
    js(ADMIN2, `SELECT public.set_epa_registration('${NUM[k]}', ${v}, '${JSON.stringify({ signal_word: word })}'::jsonb, 'prover edit', NULL, '${key('e')}');`);
  };
  setWord('c7', 'Caution');
  const c7 = propose('c7');
  assert.equal(proposal(c7).items.find((i) => i.item_id === 'label:signal_word')?.class, 'confirm');
  setWord('c7', null);
  refused(ADMIN, BATCH(c7), /EPA_BATCH_NOT_ELIGIBLE: label fact changed since the lookup \(signal_word\); nothing was saved/);
  assert.equal(ingredients('c7'), 0);
  console.log('[epa-batch] C7: a matching label fact cleared since the lookup: refused');

  // C4 / C5: another lookup of the number is running, or one failed (rows as start/record_epa_lookup write them).
  const c4 = propose('c4');
  psql(`INSERT INTO public.epa_lookups (parent_id, epa_registration, link_kind, link_id, registration_version, chemistry_version, status, requested_by)
    SELECT parent_id, epa_registration, link_kind, link_id, registration_version, chemistry_version, 'pending', requested_by
      FROM public.epa_lookups WHERE id = '${lookupOf(c4)}';`, { user: 'supabase_admin' });
  refused(ADMIN, BATCH(c4), /EPA_BATCH_NOT_ELIGIBLE: another lookup is running; nothing was saved/);
  const c5 = propose('c5');
  psql(`WITH l AS (INSERT INTO public.epa_lookups (parent_id, epa_registration, link_kind, link_id, registration_version, chemistry_version, status, recorded_at, requested_by)
      SELECT parent_id, epa_registration, link_kind, link_id, registration_version, chemistry_version, 'recorded', now(), requested_by
        FROM public.epa_lookups WHERE id = '${lookupOf(c5)}' RETURNING *)
    INSERT INTO public.epa_lookup_failures (lookup_id, parent_id, epa_registration, link_kind, link_id, registration_version, reason, created_by)
      SELECT id, parent_id, epa_registration, link_kind, link_id, registration_version, 'not_found', requested_by FROM l;`, { user: 'supabase_admin' });
  refused(ADMIN, BATCH(c5), /EPA_BATCH_NOT_ELIGIBLE: a lookup of this number failed; nothing was saved/);
  assert.equal(ingredients('c4') + ingredients('c5'), 0);
  console.log('[epa-batch] C4/C5: another lookup running, or one failed: refused');

  // B4: callers.
  refused(REP, BATCH(b2), /ADMIN_REQUIRED/);
  refused(null, BATCH(b2), /permission denied for function commit_epa_proposal_batch/);
  console.log('[epa-batch] B4: a sales rep and anon are refused');

  console.log('EPA_BATCH_COMMIT_PROOF_PASS');
}

try {
  await main();
} finally {
  if (!KEEP) removeContainer();
}
