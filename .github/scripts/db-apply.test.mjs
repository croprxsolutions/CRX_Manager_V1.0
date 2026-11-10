// Run: node --test .github/scripts/db-apply.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMigrations, dollarTag, wrapperSql, isNoTransaction, stampProblems, refuseTarget } from './db-apply.mjs';

const f = (stems) => stems.map((s) => `${s}.sql`);

test('planMigrations: post-baseline files the ledger lacks, one-shots recorded only, in stamp order', () => {
  const p = planMigrations({
    files: f(['20260101000000_old', '20261101000000_a', '20261102000000_oneshot', '20261103000000_b']),
    highWater: '20260727174805',
    ledgerNames: new Set(['20261101000000_a', 'legacy_name_without_stamp']),
    oneShots: new Set(['20261102000000_oneshot']),
  });
  assert.deepEqual(p.steps, [
    { stem: '20261102000000_oneshot', run: false },
    { stem: '20261103000000_b', run: true },
  ]);
  assert.deepEqual(p.outOfOrder, []);
});

test('planMigrations: a missing file older than the newest applied one is out of order (one-shots are exempt)', () => {
  const p = planMigrations({
    files: f(['20261101000000_late', '20261102000000_oneshot', '20261105000000_new']),
    highWater: '20260727174805',
    ledgerNames: new Set(['20261103000000_applied']),
    oneShots: new Set(['20261102000000_oneshot']),
  });
  assert.deepEqual(p.outOfOrder, ['20261101000000_late']);
  assert.deepEqual(p.steps.map((s) => s.stem), ['20261102000000_oneshot', '20261105000000_new']);
});

test('dollarTag never appears in the text', () => {
  const text = 'select $crx$ x $crx$; $crx_ab$';
  for (let i = 0; i < 50; i++) assert.equal(text.includes(dollarTag(text)), false);
  assert.match(dollarTag(''), /^\$crx_[0-9a-f]{16}\$$/);
});

test('wrapperSql: the file, then its ledger row holding the exact file text, in one transaction', () => {
  const text = "create table t(x int);\n-- it's fine\n";
  const sql = wrapperSql({ stem: '20261110120000_add_t', text, run: true, tag: '$crx_0000000000000000$' });
  assert.ok(sql.startsWith('BEGIN;\n' + text));
  assert.match(sql, /INSERT INTO supabase_migrations\.schema_migrations \(version, name, statements\)/);
  assert.match(sql, /'20261110120000_add_t', ARRAY\[\$crx_0000000000000000\$create table t\(x int\);\n-- it's fine\n\$crx_0000000000000000\$\]\);\nCOMMIT;\n$/);
  const recordOnly = wrapperSql({ stem: '20261110120000_add_t', text, run: false, tag: '$crx_0000000000000000$' });
  assert.ok(recordOnly.startsWith('BEGIN;\nINSERT'));
  assert.throws(() => wrapperSql({ stem: "x'); drop table y; --", text, run: true }), /bad migration name/);
});

test('isNoTransaction reads a header marker in the first lines only', () => {
  assert.equal(isNoTransaction('-- crx: no-transaction\ncreate index concurrently i on t(x);'), true);
  assert.equal(isNoTransaction('-- Written 2026-11-10\n--   crx:  no-transaction\nselect 1;'), true);
  assert.equal(isNoTransaction('select 1;\n'.repeat(10) + '-- crx: no-transaction'), false);
  assert.equal(isNoTransaction('create table t();'), false);
});

test('stampProblems: new files need a valid, unique stamp newer than everything already on the base branch', () => {
  const base = f(['20261101000000_a', '20261222110000_future']);
  assert.deepEqual(stampProblems({ added: f(['20261223000000_new']), base, head: [...base, ...f(['20261223000000_new'])] }), []);
  assert.match(stampProblems({ added: f(['20261201000000_old']), base, head: [...base, ...f(['20261201000000_old'])] })[0], /not newer than 20261222110000/);
  assert.match(stampProblems({ added: f(['20261223000000_x']), base, head: [...base, ...f(['20261223000000_x', '20261223000000_y'])] })[0], /shares its stamp/);
  assert.match(stampProblems({ added: ['2026_bad.sql'], base, head: base })[0], /name must be/);
});

test('refuseTarget: only the expected project, never live or MetaHive', () => {
  assert.equal(refuseTarget('postgresql://postgres.fsnjredpmakbmhwowjjt:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres', 'fsnjredpmakbmhwowjjt'), null);
  assert.match(refuseTarget('postgresql://postgres.rhyzpcqhnizqbxphqdkr:pw@host/postgres', 'fsnjredpmakbmhwowjjt'), /live/);
  assert.match(refuseTarget('postgresql://postgres.dyxaxsjrqprvxzxkfooi:pw@host/postgres', 'fsnjredpmakbmhwowjjt'), /MetaHive/);
  assert.match(refuseTarget('postgresql://postgres.otherproject12345678:pw@host/postgres', 'fsnjredpmakbmhwowjjt'), /not the fsnjredpmakbmhwowjjt/);
  assert.match(refuseTarget('', 'fsnjredpmakbmhwowjjt'), /not set/);
});
