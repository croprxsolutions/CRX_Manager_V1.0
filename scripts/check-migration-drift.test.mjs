#!/usr/bin/env node
// Fixture tests for the KI-35 live-ledger vs main drift check (scripts/check-migration-drift.mjs).
// Run: node scripts/check-migration-drift.test.mjs
import assert from 'node:assert/strict';
import { compareLedgerToMain, hasDrift, plainReport, sqlHash } from './check-migration-drift.mjs';

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
  { version: '20261108192049', name: '20261214100000_applied_before_merge', sha: sql('x'), parts: 1 },
];
const allowlist = {
  acceptedLedgerRows: [{ version: '20260212035255' }],
  parkedFiles: [{ file: '20260807000000_parked_draft.sql', reason: 'waits for Mason' }],
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
check('changed SQL is a mismatch; CRLF, comment edits, renumbering and pre-baseline rows are not', () => {
  assert.deepEqual(r.contentMismatch.map((x) => x.name), ['changed_sql']);
  assert.equal(r.compared, 4);
});
check('the result is drift, and the plain report says so line by line', () => {
  assert.equal(hasDrift(r), true);
  const text = plainReport(r, { rowCount: rows.length, fileCount: files.length, ref: 'origin/main' });
  assert.match(text, /Applied live, but no file on main: 2/);
  assert.match(text, /File on main never applied live: 1/);
  assert.match(text, /RESULT: DRIFT FOUND/);
});
check('a matching ledger is clean', () => {
  const clean = compareLedgerToMain({
    rows: rows.filter((x) => ['20260801000000', '20260815120000', '20260803000000'].includes(x.version)),
    files: files.filter((f) => /plain|renumbered|edited/.test(f.name)),
    baselineHighWater: BASE,
  });
  assert.equal(hasDrift(clean), false);
  assert.match(plainReport(clean, { rowCount: 3, fileCount: 3, ref: 'origin/main' }), /RESULT: CLEAN/);
});
check('the SQL-side hash normalisation matches the JS one on a comment-only edit', () => {
  assert.equal(sqlHash('-- a\n  -- b\r\ncreate x;\n-- tail'), sqlHash('\ncreate x;\n'));
  assert.notEqual(sqlHash('create x; -- inline'), sqlHash('create x;'));
});
console.log(`\n${pass} passed`);
