#!/usr/bin/env node
// Fixture tests for the KI-35 live-ledger vs main drift check (scripts/check-migration-drift.mjs).
// Run: node scripts/check-migration-drift.test.mjs
import assert from 'node:assert/strict';
import { compareLedgerToMain, filesAtRef, hasDrift, plainReport, sqlHash } from './check-migration-drift.mjs';

const BASE = '20260727174805';
const sql = (s) => sqlHash(s);
const files = [
  { name: '20260101000000_old_thing.sql', sha: sql('old') },
  { name: '20260801000000_plain.sql', sha: sql('create table a();') },
  { name: '20260802000000_renumbered.sql', sha: sql('create table b();') },
  { name: '20260803000000_edited_after_apply.sql', sha: sql('-- APPLIED LIVE\ncreate table c();') },
  { name: '20260804000000_changed_sql.sql', sha: sql('create table d(x int);') },
  { name: '20260805000000_renamed_file.sql', sha: sql('create table e();') },
  { name: '20260806000000_never_applied.sql', sha: sql('create table f();') },
  { name: '20260807000000_parked_draft.sql', sha: sql('create table g();') },
  { name: '20260808000000_no_hash_in_read.sql', sha: sql('create table h();') },
];
const rows = [
  { version: '20260101000000', name: 'old_thing', sha: sql('something else'), parts: 3 },
  { version: '20260212035255', name: 'inventory_unique_product_location' }, // KI-62 accepted
  { version: '20260212035336', name: 'unexplained_old_row' },
  { version: '20260801000000', name: 'plain', sha: sql('create table a();\r\n'), parts: 1 },
  { version: '20260815120000', name: '20260802000000_renumbered', sha: sql('create table b();'), parts: 1 },
  { version: '20260803000000', name: 'edited_after_apply', sha: sql('-- PARKED, DO NOT APPLY\ncreate table c();'), parts: 1 },
  { version: '20260804000000', name: 'changed_sql', sha: sql('create table d();'), parts: 1 },
  { version: '20260805000000', name: 'renamed_before_merge', sha: sql('create table e();'), parts: 1 },
  { version: '20260808000000', name: 'no_hash_in_read' },
  { version: '20261108192049', name: '20261214100000_applied_before_merge', sha: sql('x'), parts: 1 },
];
const allowlist = {
  acceptedLedgerRows: [{ version: '20260212035255' }],
  parkedFiles: [{ file: '20260807000000_parked_draft.sql', reason: 'waits for Mason' }],
  acceptedMismatches: [{
    version: '20260803000000', file: '20260803000000_edited_after_apply.sql', reason: 'header note edited after the apply',
    liveSha: sql('-- PARKED, DO NOT APPLY\ncreate table c();'), fileSha: sql('-- APPLIED LIVE\ncreate table c();'),
  }],
};

const r = compareLedgerToMain({ rows, files, baselineHighWater: BASE, allowlist });
let pass = 0;
const check = (label, fn) => { fn(); pass += 1; console.log(`ok - ${label}`); };

check('a live row with no file is listed; an allowlisted old one is not', () => {
  assert.deepEqual(r.noFile.map((x) => x.name), ['unexplained_old_row', '20261214100000_applied_before_merge']);
  assert.deepEqual(r.acceptedNoFile.map((x) => x.version), ['20260212035255']);
});
check('a file never applied is listed; a parked draft is shown apart', () => {
  assert.deepEqual(r.neverApplied, ['20260806000000_never_applied']);
  assert.deepEqual(r.parkedWaiting, ['20260807000000_parked_draft']);
});
check('a live name that differs from its file (same stamp) is a name mismatch', () => {
  assert.deepEqual(r.nameMismatch, [{ version: '20260805000000', name: 'renamed_before_merge', file: '20260805000000_renamed_file.sql' }]);
});
check('changed SQL is a mismatch; CRLF, renumbering, pre-baseline rows and a pinned edit are not', () => {
  assert.deepEqual(r.contentMismatch.map((x) => x.name), ['changed_sql']);
  assert.deepEqual(r.acceptedContent.map((x) => x.name), ['edited_after_apply']);
  assert.equal(r.compared, 5); // includes the renamed row, compared against its stamp-matched file
});
check('a post-baseline row whose SQL cannot be compared is reported, never skipped', () => {
  assert.deepEqual(r.notCompared.map((x) => [x.name, x.why]), [['no_hash_in_read', 'the ledger read carried no SQL hash']]);
});
check('the result is drift, and the plain report says so line by line', () => {
  assert.equal(hasDrift(r), true);
  const text = plainReport(r, { rowCount: rows.length, fileCount: files.length, ref: 'origin/main' });
  assert.match(text, /Applied live, but no file on main: 2/);
  assert.match(text, /File on main never applied live: 1/);
  assert.match(text, /Live SQL could not be compared: 1/);
  assert.match(text, /RESULT: DRIFT FOUND/);
});
check('a matching ledger is clean', () => {
  const clean = compareLedgerToMain({
    rows: rows.filter((x) => ['20260801000000', '20260815120000', '20260803000000'].includes(x.version)),
    files: files.filter((f) => /plain|renumbered|edited/.test(f.name)),
    baselineHighWater: BASE, allowlist,
  });
  assert.equal(hasDrift(clean), false);
  assert.match(plainReport(clean, { rowCount: 3, fileCount: 3, ref: 'origin/main' }), /RESULT: CLEAN/);
});
check('a "--" line inside a quoted string is SQL: changing it is drift', () => {
  const out = compareLedgerToMain({
    rows: [{ version: '20260901000000', name: 'quoted', sha: sql('select $$\n--old\n$$;'), parts: 1 }],
    files: [{ name: '20260901000000_quoted.sql', sha: sql('select $$\n--new\n$$;') }],
    baselineHighWater: BASE,
  });
  assert.deepEqual(out.contentMismatch.map((x) => x.name), ['quoted']);
  assert.equal(hasDrift(out), true);
});
check('a pinned difference stops being accepted once either side changes again', () => {
  const out = compareLedgerToMain({
    rows: [rows.find((x) => x.version === '20260803000000')],
    files: [{ name: '20260803000000_edited_after_apply.sql', sha: sql('-- APPLIED LIVE\ncreate table c(x int);') }],
    baselineHighWater: BASE, allowlist,
  });
  assert.deepEqual(out.contentMismatch.map((x) => x.name), ['edited_after_apply']);
  const moved = compareLedgerToMain({
    rows: [{ ...rows.find((x) => x.version === '20260803000000'), name: 'other_migration' }],
    files: [{ name: '20260803000000_other_migration.sql', sha: sql('-- APPLIED LIVE\ncreate table c();') }],
    baselineHighWater: BASE, allowlist,
  });
  assert.deepEqual(moved.contentMismatch.map((x) => x.name), ['other_migration'], 'the pin is bound to its file name too');
});
check('a renamed row is still SQL-compared; a name pin covers the name only, not new SQL', () => {
  const live = { version: '20260805000000', name: 'renamed_before_merge', sha: sql('create table e(changed);'), parts: 1 };
  const file = { name: '20260805000000_renamed_file.sql', sha: sql('create table e();') };
  const bare = compareLedgerToMain({ rows: [live], files: [file], baselineHighWater: BASE });
  assert.deepEqual(bare.nameMismatch.map((x) => x.name), ['renamed_before_merge']);
  assert.deepEqual(bare.contentMismatch.map((x) => x.name), ['renamed_before_merge']);
  const pinned = compareLedgerToMain({ rows: [live], files: [file], baselineHighWater: BASE, allowlist: {
    acceptedMismatches: [{ version: '20260805000000', liveName: 'renamed_before_merge', file: file.name, reason: 'renamed on purpose' }],
  } });
  assert.deepEqual(pinned.nameMismatch, []);
  assert.deepEqual(pinned.contentMismatch.map((x) => x.name), ['renamed_before_merge']);
});
check('a pinned rename with matching SQL is clean: its file is not called unapplied', () => {
  const out = compareLedgerToMain({
    rows: [{ version: '20260805000000', name: 'renamed_before_merge', sha: sql('create table e();'), parts: 1 }],
    files: [{ name: '20260805000000_renamed_file.sql', sha: sql('create table e();') }],
    baselineHighWater: BASE,
    allowlist: { acceptedMismatches: [{ version: '20260805000000', liveName: 'renamed_before_merge', file: '20260805000000_renamed_file.sql', reason: 'renamed on purpose' }] },
  });
  assert.deepEqual(out.neverApplied, []);
  assert.equal(hasDrift(out), false);
});
check('the real repository lists its migration files at HEAD', () => {
  const real = filesAtRef('HEAD');
  assert.ok(real.length > 1000, `only ${real.length} files`);
  assert.ok(real.every((f) => /^\S+\.sql$/.test(f.name) && /^[0-9a-f]{64}$/.test(f.sha)));
});
check('only CRLF and surrounding blank space are normalised; comments count', () => {
  assert.equal(sqlHash('\n  create x;\r\nselect 1;\n\n'), sqlHash('create x;\nselect 1;'));
  assert.notEqual(sqlHash('-- a\ncreate x;'), sqlHash('create x;'));
});
console.log(`\n${pass} passed`);
