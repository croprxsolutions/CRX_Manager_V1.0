#!/usr/bin/env node
/**
 * Real-schema proof for 20270303120000_field_split_versions.sql (field application FP-1,
 * docs/plans/field-application/CONTRACT-who-pays.md › FP-1 "Done when").
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), seeds splits the old way, applies the candidate
 * (autocommit refused, POSTFLIGHT_OK, re-apply refused), then checks:
 *   1. backfill: every field with a split has version 1 (history unknown), fields without one have none; thirds
 *      saved as 33.333333 x 3 become 33,333,334 / 33,333,333 / 33,333,333; notes move to field_payer_notes;
 *   2. set_field_billing_split saves thirds exactly and the copy shows them; refuses (RPC and direct SQL) a 90% set,
 *      the same customer twice, a negative or blank share, a version with no payers, a payer added to an old
 *      version, UPDATE/DELETE of history, and (until FP-4) a payer whose product and application shares differ;
 *      a 0%/0% named payer saves; a split starting on any day but Central today is refused (until FP-4);
 *   3. save_field: a name-only save writes no version and keeps notes; notes it is sent are ignored (only
 *      set_field_billing_split saves notes, and the copy carries none, so assigned applicators cannot read them); a named 0% payer survives two saves; a changed split writes a version; removing every payer from a
 *      field with a split is refused and the split kept; a per-acre price is refused; a sales rep with Fields & Maps
 *      turned off is refused by save_field and set_field_billing_split;
 *   4. retries: the same key resent writes nothing; the same key with different payers is refused; a missing or
 *      non-printable key is refused;
 *   5. access: a direct write to field_billing_defaults is refused; an applicator on a job still reads that field's
 *      copy and reads no version or notes row; applicator, inactive applicator, driver and entity_recipient cannot
 *      call the writer or the resolver; anon can touch nothing;
 *   6. deleting a customer who owns or pays on a field is refused; one with no field still deletes;
 *   7. resolver: dated versions (written by the internal writer, as FP-4 will allow), duplicates, unknown ids and a null date; a dated change with the same payers is kept;
 *   8. the nightly refresh repairs a stale copy; a split save and a FOR SHARE reader on the same field run one after
 *      the other (the reader waits for the writer's FOR UPDATE).
 *
 * Run: node scripts/smoke/prove-field-split-versions-real-schema.mjs   (needs Docker; never touches live)
 * Prints FIELD_SPLIT_VERSIONS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { buildSweepQuery, functionContractSql, subtractAllowlist } from '../db-invariant-sweeps/allowlist-match.mjs';
import { buildContainer, removeContainer, seedUsers, scalar, psql, attempt, asUser, refuse, id, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270303120000_field_split_versions.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });

const [A, B, C, D, E, X] = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(id);
const [F1, F2, F3, F4, F5, F6] = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map(id);
const [JOB, JF] = ['e1', 'b1'].map(id);
const OFF_APP = id('a7');
const ENTITY = id('a8');
const M = 100000000;

const payers = (rows) => `'${JSON.stringify(rows.map(([c, p, a]) => ({ customer_id: c, product_share_micro_pct: p, application_share_micro_pct: a ?? p })))}'::jsonb`;
const setSplit = (field, date, rows, key, notes = 'NULL') =>
  `r := public.set_field_billing_split('${field}', ${date}, ${rows}, ${notes}, 'proof', '${key}');`;
const versions = (field) => scalar(`SELECT count(*) FROM public.field_billing_split_versions WHERE field_id = '${field}';`);
const inForce = (field, date = "(now() AT TIME ZONE 'America/Chicago')::date") => scalar(`SELECT string_agg(p.customer_id::text || ':' || p.product_share_micro_pct || '/' || p.application_share_micro_pct, ',' ORDER BY p.customer_id)
  FROM public.field_billing_split_payers p WHERE p.version_id = public._field_split_in_force_20270303('${field}', ${date});`);
const copy = (field) => scalar(`SELECT string_agg(customer_id::text || ':' || split_pct || ':' || is_primary || ':' || coalesce(notes, '-'), ',' ORDER BY customer_id)
  FROM public.field_billing_defaults WHERE field_id = '${field}';`);
const note = (field, cust) => scalar(`SELECT coalesce(notes, '-') FROM public.field_payer_notes WHERE field_id = '${field}' AND customer_id = '${cust}';`);
// The old Field Setup screen's save: field payload plus the copy rows it read.
const fieldPayload = (field, owner, name) => `jsonb_build_object('customer_id', '${owner}', 'field_name', '${name}')`;
const copyRows = (field, notesFor = {}) => `(SELECT coalesce(jsonb_agg(jsonb_build_object('customer_id', customer_id, 'split_pct', split_pct, 'is_primary', is_primary,
    'notes', CASE customer_id::text ${Object.entries(notesFor).map(([c, n]) => `WHEN '${c}' THEN '${n}'`).join(' ') || `WHEN '' THEN notes`} ELSE notes END) ORDER BY customer_id), '[]'::jsonb)
    FROM public.field_billing_defaults WHERE field_id = '${field}')`;
const saveField = (field, owner, name, defaults, key) =>
  `u := public.save_field('${field}', ${fieldPayload(field, owner, name)}, ${defaults}, NULL, '${key}');`;
// The writer's "today" is the Central date; CURRENT_DATE is UTC in the container and runs a day ahead in the evening.
const TODAY = "(now() AT TIME ZONE 'America/Chicago')::date";
const commit = (uid, body) => attempt(uid, body, { commit: true });
// Whole output (scalar keeps only the last line; a sweep packet can span lines).
const scalarAll = (sql) => docker([...PSQL, '-A', '-t'], { input: sql }).stdout.trim();

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  // Before the candidate: splits saved the old way (field_billing_defaults rows), thirds at 33.333333 each.
  psql(`SET session_replication_role = replica;
    INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES
      ('${OFF_APP}', 'off-app@example.invalid', 'Applicator Off', 'applicator', false),
      ('${ENTITY}', 'entity@example.invalid', 'Entity Recipient', 'entity_recipient', true);
    SET session_replication_role = origin;
    INSERT INTO public.customers (id, farm_name) VALUES ('${A}', 'Alpha Farms'), ('${B}', 'Bravo Farms'), ('${C}', 'Charlie Farms'),
      ('${D}', 'Delta Landlord'), ('${E}', 'Echo Farms'), ('${X}', 'Xray No Fields');
    INSERT INTO public.fields (id, customer_id, field_name) VALUES ('${F1}', '${A}', 'One'), ('${F2}', '${A}', 'Two'),
      ('${F3}', '${A}', 'Three'), ('${F4}', '${E}', 'Four'), ('${F5}', '${B}', 'Five'), ('${F6}', '${E}', 'Six');
    BEGIN;
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, notes) VALUES
      ('${F1}', '${A}', 100, true, NULL),
      ('${F2}', '${A}', 50, true, NULL), ('${F2}', '${B}', 50, false, NULL),
      ('${F3}', '${A}', 33.333333, true, NULL), ('${F3}', '${B}', 33.333333, false, NULL), ('${F3}', '${C}', 33.333333, false, NULL),
      ('${F5}', '${B}', 60, true, NULL), ('${F5}', '${C}', 40, false, 'landlord note'),
      ('${F6}', '${B}', 100, true, NULL);
    COMMIT;
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, applicator_id) VALUES
      ('${JOB}', 'FS-J1', '${A}', CURRENT_DATE, 'scheduled', '${USERS.applicator}');
    INSERT INTO public.job_fields (id, job_id, field_id) VALUES ('${JF}', '${JOB}', '${F2}');`);
  // Before: the applicator reads the job field's split rows (and only those).
  assert.equal(attempt(USERS.applicator, asUser(`v := (SELECT count(*) FROM public.field_billing_defaults);`)), 'ok|2', 'before: applicator reads the job field split');

  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /FIELD_SPLIT_CUTOVER: 5 field\(s\) with a split, 9 split row\(s\)/);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /FIELD_SPLIT_BASELINE_DRIFT/, 're-apply must refuse');
  console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK, re-apply refused');

  // 1. Backfill.
  assert.equal(scalar(`SELECT count(*) || '/' || count(*) FILTER (WHERE version_number = 1 AND NOT history_known AND effective_from = '1900-01-01')
    FROM public.field_billing_split_versions;`), '5/5', 'five fields get version 1, history unknown');
  assert.equal(versions(F4), '0', 'a field with no split gets no version');
  assert.equal(inForce(F3), `${A}:33333334/33333334,${B}:33333333/33333333,${C}:33333333/33333333`, 'thirds: the leftover goes to the lowest id on a tie');
  assert.equal(copy(F3), `${A}:33.333334:true:-,${B}:33.333333:false:-,${C}:33.333333:false:-`, 'the copy follows version 1');
  assert.equal(note(F5, C), 'landlord note', 'old split notes move to field_payer_notes');
  assert.equal(copy(F5), `${B}:60.000000:true:-,${C}:40.000000:false:-`, 'the copy no longer carries the note (applicators read the copy)');
  assert.equal(copy(F6), `${B}:100.000000:true:-`, 'a non-owner sole payer stays primary (owner E pays nothing)');
  console.log('[backfill] version 1 on every field with a split, thirds exact, notes kept');

  // 2. The writer: thirds, refusals, 0% payers.
  let r = commit(USERS.admin, asUser(`${setSplit(F4, TODAY, payers([[A, 33333334], [B, 33333333], [C, 33333333]]), 'k-thirds')} v := r::text;`));
  assert.match(r, /^ok\|.*"wrote_version": true/, `thirds save: ${r}`);
  assert.equal(inForce(F4), `${A}:33333334/33333334,${B}:33333333/33333333,${C}:33333333/33333333`);
  assert.equal(copy(F4), `${A}:33.333334:true:-,${B}:33.333333:false:-,${C}:33.333333:false:-`, 'owner E is not a payer: the largest share (lowest id on a tie) is primary');
  const bad = [
    ['90%', payers([[A, 50000000], [B, 40000000]]), /FIELD_SPLIT_NOT_100/],
    ['same customer twice', payers([[A, 50000000], [A, 50000000]]), /FIELD_SPLIT_DUPLICATE_PAYER/],
    ['negative share', payers([[A, 110000000], [B, -10000000]]), /FIELD_SPLIT_INVALID_SHARE/],
    ['blank share', `'[{"customer_id":"${A}","product_share_micro_pct":100000000}]'::jsonb`, /FIELD_SPLIT_INVALID_SHARE/],
    ['fractional share', payers([[A, 99999999.5], [B, 0.5]]), /FIELD_SPLIT_INVALID_SHARE/],
    ['no payers', `'[]'::jsonb`, /FIELD_SPLIT_NO_PAYERS/],
    ['no date', payers([[A, M]]), /FIELD_SPLIT_DATE_REQUIRED/, 'NULL'],
    ['infinite date', payers([[A, M]]), /FIELD_SPLIT_DATE_REQUIRED/, "'-infinity'::date"],
  ];
  for (const [label, rows, re, date = TODAY] of bad) {
    r = attempt(USERS.admin, `${refuse(setSplit(F1, date, rows, `k-bad-${label}`))} v := t;`);
    assert.match(r, re, `RPC must refuse ${label}: ${r}`);
  }
  // Direct SQL (as the table owner, past every grant): the triggers still refuse.
  const direct = (body) => attempt(USERS.admin, `BEGIN ${body} SET CONSTRAINTS ALL IMMEDIATE; t := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN t := SQLERRM; END; v := t;`);
  assert.match(direct(`INSERT INTO public.field_billing_split_versions (id, field_id, version_number, effective_from) VALUES ('${id('99')}', '${F1}', 9, ${TODAY});`),
    /FIELD_SPLIT_NO_PAYERS/, 'direct: a version with no payers');
  assert.match(direct(`INSERT INTO public.field_billing_split_versions (id, field_id, version_number, effective_from) VALUES ('${id('99')}', '${F1}', 9, ${TODAY});
    INSERT INTO public.field_billing_split_payers (version_id, customer_id, product_share_micro_pct, application_share_micro_pct) VALUES ('${id('99')}', '${A}', 90000000, 90000000);`),
    /FIELD_SPLIT_NOT_100/, 'direct: 90%');
  assert.match(direct(`INSERT INTO public.field_billing_split_payers (version_id, customer_id, product_share_micro_pct, application_share_micro_pct)
    SELECT id, '${B}', 0, 0 FROM public.field_billing_split_versions WHERE field_id = '${F1}' AND version_number = 1;`),
    /FIELD_SPLIT_VERSION_CLOSED/, 'direct: a payer added to yesterday\'s version');
  assert.match(direct(`UPDATE public.field_billing_split_payers SET product_share_micro_pct = product_share_micro_pct;`), /FIELD_SPLIT_HISTORY_APPEND_ONLY/);
  assert.match(direct(`DELETE FROM public.field_billing_split_versions WHERE field_id = '${F1}';`), /FIELD_SPLIT_HISTORY_APPEND_ONLY/);
  assert.match(direct(`TRUNCATE public.field_billing_split_payers CASCADE;`), /FIELD_SPLIT_HISTORY_APPEND_ONLY/);
  // Until FP-4 the copy (one share per payer) still feeds job billing: a landlord at 0% application is refused.
  r = attempt(USERS.rep, `${refuse(setSplit(F2, TODAY, payers([[A, 60000000, M], [D, 40000000, 0]]), 'k-landlord'))} v := t;`);
  assert.match(r, /FIELD_SPLIT_SHARES_MUST_MATCH_UNTIL_FP4/, `differing share sets refused until FP-4: ${r}`);
  r = commit(USERS.rep, asUser(`${setSplit(F2, TODAY, payers([[A, 60000000], [D, 40000000]]), 'k-landlord-even')} v := r::text;`));
  assert.match(r, /^ok\|.*"wrote_version": true/, `matching share sets save: ${r}`);
  assert.equal(copy(F2), `${A}:60.000000:true:-,${D}:40.000000:false:-`);
  // A named party at 0% on both sides.
  r = commit(USERS.admin, asUser(`${setSplit(F1, TODAY, payers([[A, M], [D, 0]]), 'k-named0')} v := r::text;`));
  assert.match(r, /^ok\|.*"wrote_version": true/, `0%/0% named payer saves: ${r}`);
  assert.equal(copy(F1), `${A}:100.000000:true:-`, 'the copy leaves out a 0% product payer');
  r = commit(USERS.admin, asUser(`${setSplit(F6, TODAY, 'NULL', 'k-notes-only', `'[{"customer_id":"${B}","notes":"rpc note"}]'::jsonb`)} v := r::text;`));
  assert.match(r, /^ok\|.*"version_number": 1.*"wrote_version": false|^ok\|.*"wrote_version": false.*"version_number": 1/, `a notes-only RPC save reports the in-force version: ${r}`);
  r = attempt(USERS.admin, `${refuse(setSplit(F6, TODAY, 'NULL', 'k-notes-dup', `'[{"customer_id":"${B}","notes":"a"},{"customer_id":"${B.toUpperCase()}","notes":"b"}]'::jsonb`))} v := t;`);
  assert.match(r, /a customer is listed twice/, `the same customer in two spellings is refused by name: ${r}`);
  console.log('[writer] thirds exact; RPC and direct refusals; 0% payers save');

  // 3. save_field (the old Field Setup screen).
  const v1 = versions(F1);
  r = commit(USERS.admin, asUser(saveField(F1, A, 'One renamed', copyRows(F1), 'k-sf-name')) + ' v := u::text;');
  assert.equal(r, `ok|${F1}`, `name-only save: ${r}`);
  r = commit(USERS.admin, asUser(saveField(F1, A, 'One renamed again', copyRows(F1), 'k-sf-name2')) + ' v := u::text;');
  assert.equal(versions(F1), v1, 'two name-only saves write no version');
  assert.equal(inForce(F1), `${A}:100000000/100000000,${D}:0/0`, 'the named 0% payer survives two saves');
  r = commit(USERS.admin, asUser(saveField(F1, A, 'One', copyRows(F1, { [A]: 'owner note' }), 'k-sf-notes')) + ' v := u::text;');
  assert.equal(versions(F1), v1, 'a notes-only save writes no version');
  assert.equal(note(F1, A), '', 'save_field ignores notes (no note row is written; the old screen read them from the copy, which has none)');
  commit(USERS.admin, asUser(`${setSplit(F1, TODAY, 'NULL', 'k-owner-note', `'[{"customer_id":"${A}","notes":"owner note"}]'::jsonb`)} v := r::text;`));
  assert.equal(note(F1, A), 'owner note', 'the split writer saves the note');
  assert.equal(copy(F1), `${A}:100.000000:true:-`, 'and the copy does not carry it');
  r = commit(USERS.admin, asUser(saveField(F1, A, 'One', copyRows(F1), 'k-sf-after-note')) + ' v := u::text;');
  assert.equal(note(F1, A), 'owner note', 'an old-screen resend of the note-free copy keeps the note');
  r = attempt(USERS.admin, `${refuse(saveField(F1, A, 'One', `'[]'::jsonb`, 'k-sf-empty'))} v := t;`);
  assert.match(r, /FIELD_SPLIT_CLEAR_REFUSED/, `an empty split on a field with a split is refused (Create Invoice never falls back to a payer): ${r}`);
  assert.equal(versions(F1), v1, 'and writes nothing');
  assert.equal(inForce(F1), `${A}:100000000/100000000,${D}:0/0`, 'the split is unchanged');
  r = commit(USERS.admin, asUser(saveField(F5, B, 'Five', `'[{"customer_id":"${B}","split_pct":50},{"customer_id":"${C}","split_pct":50}]'::jsonb`, 'k-sf-change')) + ' v := u::text;');
  assert.equal(versions(F5), '2', 'a changed split writes a version');
  assert.equal(note(F5, C), 'landlord note', 'notes not sent stay');
  const f3Before = versions(F3);
  r = commit(USERS.admin, asUser(saveField(F3, A, 'Three details only', 'NULL::jsonb', 'k-sf-null')) + ' v := u::text;');
  assert.equal(r, `ok|${F3}`, `details-only save: ${r}`);
  assert.equal(versions(F3), f3Before, 'a NULL split leaves the split alone');
  assert.equal(inForce(F3), `${A}:33333334/33333334,${B}:33333333/33333333,${C}:33333333/33333333`, 'thirds unchanged');
  r = attempt(USERS.admin, `${refuse(saveField(F5, B, 'Five', `'[{"customer_id":"${B}","split_pct":100,"price_override_cents":500}]'::jsonb`, 'k-sf-price'))} v := t;`);
  assert.match(r, /PER_ACRE_PRICING_RETIRED/, `per-acre price refused: ${r}`);
  r = attempt(USERS.admin, `${refuse(saveField(F5, B, 'Five', `'[{"customer_id":"${B}","split_pct":90}]'::jsonb`, 'k-sf-90'))} v := t;`);
  assert.match(r, /must total 100/, `save_field 90% refused: ${r}`);
  // Shares within 0.01% of 100% are scaled in proportion, as order invoicing did: 50.01/50.00 -> 50.005/49.995 (Sol r5 HIGH).
  commit(USERS.admin, asUser(saveField(F5, B, 'Five', `'[{"customer_id":"${B}","split_pct":50.01},{"customer_id":"${C}","split_pct":50.00}]'::jsonb`, 'k-sf-near')) + ' v := u::text;');
  assert.equal(inForce(F5), [`${B}:50005000/50005000`, `${C}:49995000/49995000`].sort().join(','), 'a near-100% split is scaled in proportion, not shifted onto one payer');
  const vF5 = versions(F5);
  commit(USERS.admin, asUser(saveField(F5, B, 'Five renamed', `'[{"customer_id":"${B}","split_pct":50.005},{"customer_id":"${C}","split_pct":49.995}]'::jsonb`, 'k-sf-near-name')) + ' v := u::text;');
  assert.equal(versions(F5), vF5, 'resending the scaled copy (an old-screen name-only save) writes no version');
  console.log('[save_field] name-only and notes-only saves write no version; an empty save on a split field is refused; 0% payer survives; price refused');

  // 4. Retries.
  const before = versions(F6);
  r = commit(USERS.admin, asUser(`${setSplit(F6, TODAY, payers([[B, 70000000], [E, 30000000]]), 'k-retry')} v := r::text;`));
  const r2 = commit(USERS.admin, asUser(`${setSplit(F6, TODAY, payers([[B, 70000000], [E, 30000000]]), 'k-retry')} v := r::text;`));
  assert.equal(r2, r, 'the same key resent returns the first answer');
  assert.equal(versions(F6), String(Number(before) + 1), 'and writes nothing more');
  r = attempt(USERS.admin, `${refuse(setSplit(F6, TODAY, payers([[B, 10000000], [E, 90000000]]), 'k-retry'))} v := t;`);
  assert.match(r, /IDEMPOTENCY_INTENT_MISMATCH/, `same key, different payers refused: ${r}`);
  r = attempt(USERS.admin, `${refuse(`r := public.set_field_billing_split('${F3}', ${TODAY}, ${payers([[A, M]])}, NULL, NULL, NULL);`)} v := t;`);
  assert.match(r, /IDEMPOTENCY_KEY_REQUIRED/);
  r = attempt(USERS.admin, `${refuse(setSplit(F3, TODAY, payers([[A, M]]), 'k-tab\t'))} v := t;`);
  assert.match(r, /IDEMPOTENCY_KEY_REQUIRED/, `a key with a tab is refused: ${r}`);
  // Until FP-4 a split change starts today only (Mason, 2026-11-24): job billing reads today's copy.
  for (const date of ["DATE '2027-03-01'", `${TODAY} - 1`, `${TODAY} + 1`]) {
    r = attempt(USERS.admin, `${refuse(setSplit(F3, date, payers([[A, 70000000], [B, 30000000]]), `k-dated-${date.length}`))} v := t;`);
    assert.match(r, /FIELD_SPLIT_STARTS_TODAY_UNTIL_FP4/, `a split starting ${date} is refused: ${r}`);
  }
  console.log('[retries] same key replays; a different request under it is refused; non-today starts refused');

  // 5. Access.
  for (const stmt of [`INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct) VALUES ('${F4}', '${X}', 1);`,
    `UPDATE public.field_billing_defaults SET split_pct = split_pct;`, `DELETE FROM public.field_billing_defaults;`,
    `INSERT INTO public.field_billing_split_versions (field_id, version_number, effective_from) VALUES ('${F4}', 50, ${TODAY});`,
    `INSERT INTO public.field_payer_notes (field_id, customer_id, notes) VALUES ('${F4}', '${E}', 'x');`]) {
    r = attempt(USERS.admin, `${refuse(stmt)} v := t;`);
    assert.match(r, /permission denied/, `direct write refused for an admin: ${stmt} -> ${r}`);
  }
  assert.equal(attempt(USERS.applicator, asUser(`v := (SELECT string_agg(DISTINCT field_id::text, ',') FROM public.field_billing_defaults);`)), `ok|${F2}`,
    'an applicator on a job still reads that field\'s split, and no other');
  for (const [who, uid] of [['applicator', USERS.applicator], ['inactive applicator', OFF_APP], ['driver', USERS.driver], ['entity_recipient', ENTITY]]) {
    assert.equal(attempt(uid, asUser(`v := (SELECT count(*) FROM public.field_billing_split_versions) + (SELECT count(*) FROM public.field_billing_split_payers)
      + (SELECT count(*) FROM public.field_payer_notes);`)), 'ok|0', `${who} reads no version or notes row`);
    r = attempt(uid, `${refuse(setSplit(F2, TODAY, payers([[A, M]]), `k-${who}`))} v := t;`);
    assert.match(r, /Permission denied/, `${who} cannot save a split: ${r}`);
    r = attempt(uid, `${refuse(`v := (SELECT count(*) FROM public.field_split_as_of(ARRAY['${F2}']::uuid[], ${TODAY}));`)} v := t;`);
    assert.match(r, /Permission denied/, `${who} cannot call the resolver: ${r}`);
  }
  assert.equal(attempt(OFF_APP, asUser(`v := (SELECT count(*) FROM public.field_billing_defaults);`)), 'ok|0', 'an inactive applicator reads no split');
  for (const obj of ['public.field_billing_split_versions', 'public.field_billing_split_payers', 'public.field_payer_notes']) {
    assert.equal(scalar(`SELECT has_table_privilege('anon', '${obj}', 'SELECT')::text;`), 'false', `anon cannot read ${obj}`);
  }
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname ~ '(field_split|field_billing_split|field_billing_cop)'
    AND has_function_privilege('anon', oid, 'EXECUTE');`), '0', 'anon runs none of the new functions');
  assert.equal(scalar(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
    AND proname ~ '(field_split|field_billing_split|field_billing_cop)' AND proname NOT LIKE 'get\_field\_billing\_splits\_for\_%' -- older readers, unchanged
    AND has_function_privilege('authenticated', oid, 'EXECUTE');`),
    'field_split_as_of,set_field_billing_split', 'signed-in users run only the two entry points');
  // Settings > Page Access: a sales rep with Fields & Maps turned off cannot save a split or a field (Sol r2 HIGH).
  psql(`SET session_replication_role = replica; UPDATE public.profiles SET denied_pages = '{fields}' WHERE id = '${USERS.rep}'; SET session_replication_role = origin;`);
  const vF2 = versions(F2);
  r = attempt(USERS.rep, `${refuse(setSplit(F2, TODAY, payers([[A, M]]), 'k-rep-denied'))} v := t;`);
  assert.match(r, /PAGE_ACCESS_DENIED: fields/, `a rep without Fields & Maps cannot save a split: ${r}`);
  r = attempt(USERS.rep, `${refuse(saveField(F2, A, 'Denied rename', 'NULL::jsonb', 'k-rep-denied-sf'))} v := t;`);
  assert.match(r, /PAGE_ACCESS_DENIED: fields/, `a rep without Fields & Maps cannot use save_field: ${r}`);
  assert.equal(versions(F2), vF2, 'and nothing is written');
  // ... and cannot read split history, payers or notes, nor call the resolver (Sol r3 HIGH).
  const repReads = `v := (SELECT count(*) FROM public.field_billing_split_versions) + (SELECT count(*) FROM public.field_billing_split_payers)
    + (SELECT count(*) FROM public.field_payer_notes);`;
  assert.equal(attempt(USERS.rep, asUser(repReads)), 'ok|0', 'a rep without Fields & Maps reads no split history');
  r = attempt(USERS.rep, `${refuse(`v := (SELECT count(*) FROM public.field_split_as_of(ARRAY['${F2}']::uuid[], ${TODAY}));`)} v := t;`);
  assert.match(r, /PAGE_ACCESS_DENIED: fields/, `a rep without Fields & Maps cannot call the resolver: ${r}`);
  psql(`SET session_replication_role = replica; UPDATE public.profiles SET denied_pages = '{}' WHERE id = '${USERS.rep}'; SET session_replication_role = origin;`);
  assert.notEqual(attempt(USERS.rep, asUser(repReads)), 'ok|0', 'with Fields & Maps back on, the rep reads split history again');
  // A note already on a field stays editable when its customer is no longer the owner or a payer (Sol r2 MED).
  scalar(`INSERT INTO public.field_payer_notes (field_id, customer_id, notes) VALUES ('${F4}', '${X}', 'former owner') RETURNING 1;`);
  commit(USERS.admin, asUser(`${setSplit(F4, TODAY, 'NULL', 'k-former-note', `'[{"customer_id":"${X}","notes":"corrected"}]'::jsonb`)} v := r::text;`));
  assert.equal(note(F4, X), 'corrected', 'a former owner\'s note can be corrected');
  psql(`DELETE FROM public.field_payer_notes WHERE field_id = '${F4}' AND customer_id = '${X}';`); // X must stay note-free for the customer-delete check below
  console.log('[access] direct writes refused; applicator keeps the copy only; other roles and anon refused; Page Access honoured');

  // 6. Customers who own or pay on a field cannot be deleted.
  for (const [who, cust] of [['owner', E], ['payer only', D]]) {
    r = attempt(USERS.admin, `BEGIN DELETE FROM public.customers WHERE id = '${cust}'; t := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN t := SQLERRM; END; v := t;`);
    assert.match(r, /foreign key/, `deleting a field ${who} is refused: ${r}`);
  }
  r = attempt(USERS.admin, `DELETE FROM public.customers WHERE id = '${X}'; GET DIAGNOSTICS n = ROW_COUNT; v := n::text;`);
  assert.equal(r, 'ok|1', 'a customer with no field still deletes');
  console.log('[customers] owner and payer deletes refused');

  // 7. Resolver and dated versions. The public writer takes only today until FP-4, so the dated version is written by
  // the internal writer, as FP-4 will allow.
  const dated = (field, date, rows) => scalar(`SELECT set_config('request.jwt.claims', '{"sub":"${USERS.admin}","role":"authenticated"}', false);
    SELECT public._set_field_billing_split_20270303('${field}', ${date}, ${rows}, NULL, 'proof dated', '${USERS.admin}', true)->>'wrote_version';`);
  assert.equal(dated(F3, "DATE '2027-03-01'", payers([[A, 70000000], [B, 30000000]])), 'true', 'a dated version is written');
  r = attempt(USERS.rep, `v := (SELECT string_agg(field_id::text || ':' || has_split || ':' || coalesce(version_number::text, '-'), ',' ORDER BY field_id)
    FROM public.field_split_as_of(ARRAY['${F3}', '${F4}']::uuid[], DATE '2027-02-28'));`);
  assert.equal(r, `ok|${F3}:true:1,${F4}:true:1`, `before the dated version: ${r}`);
  r = attempt(USERS.rep, `v := (SELECT has_split || ':' || coalesce(version_number::text, '-') FROM public.field_split_as_of(ARRAY['${F4}']::uuid[], DATE '2026-01-01'));`);
  assert.equal(r, 'ok|false:-', `F4 before its first split has none: ${r}`);
  r = attempt(USERS.rep, `v := (SELECT version_number || ':' || payers::text FROM public.field_split_as_of(ARRAY['${F3}']::uuid[], DATE '2027-03-01'));`);
  assert.match(r, /^ok\|2:.*70000000/, `from the dated version: ${r}`);
  for (const [args, re] of [[`ARRAY['${F3}', '${F3}']::uuid[], ${TODAY}`, /FIELD_SPLIT_DUPLICATE_FIELD/], [`ARRAY['${id('ff')}']::uuid[], ${TODAY}`, /FIELD_NOT_FOUND/],
    [`ARRAY['${F3}']::uuid[], NULL`, /FIELD_SPLIT_DATE_REQUIRED/], [`ARRAY['${F3}', NULL]::uuid[], ${TODAY}`, /FIELD_SPLIT_FIELDS_REQUIRED/],
    [`ARRAY[]::uuid[], ${TODAY}`, /FIELD_SPLIT_FIELDS_REQUIRED/]]) {
    r = attempt(USERS.admin, `${refuse(`v := (SELECT count(*) FROM public.field_split_as_of(${args}));`)} v := t;`);
    assert.match(r, re, `resolver refuses ${args}: ${r}`);
  }
  const f3 = versions(F3);
  assert.equal(dated(F3, "DATE '2027-03-01'", payers([[A, 70000000], [B, 30000000]])), 'false', 'same payers on the in-force version\'s own date: nothing new');
  assert.equal(dated(F3, "DATE '2027-04-01'", payers([[A, 70000000], [B, 30000000]])), 'true', 'a dated change with the same payers is kept');
  assert.equal(versions(F3), String(Number(f3) + 1));
  console.log('[resolver] dated versions resolve; refusals; same-date no-op and dated change kept');

  // 8. Nightly refresh and lock order.
  psql(`DELETE FROM public.field_billing_defaults WHERE field_id = '${F1}';`);
  assert.equal(scalar(`SELECT public._refresh_all_field_billing_copies_20270303();`), '1', 'the nightly refresh repairs one stale copy');
  assert.equal(copy(F1), `${A}:100.000000:true:-`);
  assert.equal(scalar(`SELECT public._refresh_all_field_billing_copies_20270303();`), '0', 'and then has nothing to do');
  // A split save holds the field row; an invoice writer's FOR SHARE on that field waits for it.
  const writer = spawn('docker', [...PSQL], { stdio: ['pipe', 'pipe', 'pipe'] });
  writer.stdin.end(`BEGIN; SELECT set_config('request.jwt.claims', '{"sub":"${USERS.admin}","role":"authenticated"}', true);
    SET LOCAL ROLE authenticated; SELECT public.set_field_billing_split('${F2}', ${TODAY}, ${payers([[A, M]])}, NULL, 'lock', 'k-lock');
    SELECT 'SPLIT_HELD'; SELECT pg_sleep(6); COMMIT;`);
  let writerErr = '';
  writer.stderr.on('data', (d) => { writerErr += d; });
  writer.stdout.on('data', (d) => { writerErr += d; });
  const writerDone = new Promise((resolve) => writer.on('close', resolve));
  // Wait without blocking the event loop, so the writer's stdin is actually sent.
  for (let i = 0; i < 100 && !writerErr.includes('SPLIT_HELD'); i += 1) await new Promise((res) => setTimeout(res, 100));
  const held = writerErr.includes('SPLIT_HELD');
  assert.ok(held, `the writer is holding its transaction: ${writerErr}`);
  r = attempt(USERS.admin, `SET LOCAL lock_timeout = '1s'; BEGIN PERFORM 1 FROM public.fields WHERE id = '${F2}' FOR SHARE; t := 'NOT BLOCKED'; EXCEPTION WHEN OTHERS THEN t := SQLSTATE; END; v := t;`);
  assert.equal(r, 'ok|55P03', 'a FOR SHARE reader waits for the split writer');
  assert.equal(await writerDone, 0, 'the writer commits');
  r = attempt(USERS.admin, `PERFORM 1 FROM public.fields WHERE id = '${F2}' FOR SHARE; v := 'read';`);
  assert.equal(r, 'ok|read', 'and then the reader proceeds');
  assert.equal(inForce(F2), `${A}:100000000/100000000`);
  console.log('[locks] the nightly refresh repairs a stale copy; writer and FOR SHARE reader run one after the other');

  // 9. The standing actor-forgery sweep, with the checked-in allowlist, flags none of the FP-1 entry points.
  const actorPredicate = { name: 'actor-forgery', sql: readFileSync(path.join(ROOT, 'scripts/db-invariant-sweeps/predicates/actor-forgery.sql'), 'utf8') };
  const actorEntries = JSON.parse(readFileSync(path.join(ROOT, 'scripts/db-invariant-sweeps/allowlist.json'), 'utf8')).entries
    .filter((entry) => entry.predicate === actorPredicate.name);
  const packet = JSON.parse(scalarAll(buildSweepQuery(actorPredicate, actorEntries)));
  const flagged = subtractAllowlist(packet.predicate, packet.rows, actorEntries, packet.function_contracts)
    .map((row) => row.violation_key).filter((key) => /^(save_field\(|set_field_billing_split|_set_field_billing_split|field_split_as_of)/.test(key));
  const implKey = 'public._save_field_replay_impl_20261015(p_field_id uuid, p_field_payload jsonb, p_billing_defaults jsonb, p_performed_by uuid, p_idempotency_key text)';
  const implContract = JSON.parse(scalarAll(`SELECT COALESCE(json_agg(c), '[]'::json) FROM (${functionContractSql([implKey])}) AS c;`));
  assert.deepEqual(flagged, [], `actor-forgery sweep flags FP-1 functions (impl contract md5 now ${implContract[0]?.contract_md5}): ${flagged.join('; ')}`);
  console.log('[sweep] actor-forgery flags none of save_field, the split writer or the resolver');

  console.log('FIELD_SPLIT_VERSIONS_PROOF_PASS');
} finally {
  removeContainer();
}
