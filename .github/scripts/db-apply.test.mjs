// Run: node --test .github/scripts/db-apply.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMigrations, dollarTag, wrapperSql, isNoTransaction, stampProblems, refuseTarget, urlRef, fileProblems, sqlSkeleton } from './db-apply.mjs';

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

test('wrapperSql: file, same-transaction check, ledger row with the exact text, hash check, one transaction', () => {
  const text = "create table t(x int);\n-- it's fine\n";
  const sha = 'a'.repeat(64);
  const sql = wrapperSql({ stem: '20261110120000_add_t', text, run: true, sha, tag: '$crx_0000000000000000$' });
  const lines = sql.split('\n');
  assert.equal(lines[0], 'BEGIN;');
  assert.match(lines[1], /set_config\('crx\.apply_tx', txid_current\(\)::text, true\)/);
  assert.ok(sql.includes(`${lines[1]}\n${text}\n;\nDO $crx_check$`));
  assert.match(sql, /MIGRATION_LEFT_ITS_TRANSACTION: 20261110120000_add_t/);
  assert.ok(sql.includes("'20261110120000_add_t', ARRAY[$crx_0000000000000000$create table t(x int);\n-- it's fine\n$crx_0000000000000000$]);"));
  assert.ok(sql.includes(`IS DISTINCT FROM '${sha}' THEN RAISE EXCEPTION 'LEDGER_HASH_MISMATCH`));
  assert.ok(sql.endsWith('COMMIT;\n'));
  const recordOnly = wrapperSql({ stem: '20261110120000_add_t', text, run: false, sha, tag: '$crx_0000000000000000$' });
  assert.equal(recordOnly.split('\n')[2].startsWith('DO $crx_check$'), true);
  assert.throws(() => wrapperSql({ stem: "x'); drop table y; --", text, run: true, sha }), /bad migration name/);
  assert.throws(() => wrapperSql({ stem: '20261110120000_add_t', text, run: true, sha: "x' or 1=1" }), /bad sha256/);
});

test('fileProblems: UTF-8 only, no BOM, no own transaction control, no psql backslash commands', () => {
  const ok = Buffer.from('create function f() returns void language plpgsql as $$\nBEGIN\n  perform 1;\nEND;\n$$;\n');
  assert.deepEqual(fileProblems('20261110120000_f', ok), []);
  assert.match(fileProblems('x', Buffer.from('create table a();\nCOMMIT;\nselect 1;'))[0], /own transaction control/);
  assert.match(fileProblems('x', Buffer.from('begin;\nselect 1;'))[0], /own transaction control/);
  assert.match(fileProblems('x', Buffer.from('\\set x 1\nselect 1;'))[0], /backslash/);
  assert.match(fileProblems('x', Buffer.from([0xef, 0xbb, 0xbf, 0x73]))[0], /byte-order mark/);
  assert.match(fileProblems('x', Buffer.from([0x73, 0xff, 0x0a]))[0], /not valid UTF-8/);
});

test('isNoTransaction needs the marker alone on the first line', () => {
  assert.equal(isNoTransaction('-- crx: no-transaction\ncreate index concurrently i on t(x);'), true);
  assert.equal(isNoTransaction('-- Written 2026-11-10\n-- crx: no-transaction\nselect 1;'), false);
  assert.equal(isNoTransaction('-- crx: no-transaction please\nselect 1;'), false);
  assert.equal(isNoTransaction('select 1;\n'.repeat(10) + '-- crx: no-transaction'), false);
  assert.equal(isNoTransaction('create table t();'), false);
});

test('stampProblems: new files need a valid, unique stamp newer than the base branch; existing files never change', () => {
  const base = f(['20261101000000_a', '20261222110000_future']);
  assert.deepEqual(stampProblems({ added: f(['20261223000000_new']), base, head: [...base, ...f(['20261223000000_new'])] }), []);
  assert.match(stampProblems({ added: f(['20261201000000_old']), base, head: [...base, ...f(['20261201000000_old'])] })[0], /not newer than 20261222110000/);
  assert.match(stampProblems({ added: f(['20261223000000_x']), base, head: [...base, ...f(['20261223000000_x', '20261223000000_y'])] })[0], /shares its stamp/);
  assert.match(stampProblems({ added: ['2026_bad.sql'], base, head: base })[0], /name must be/);
  assert.match(stampProblems({ added: [], changed: ['20261101000000_a.sql'], base, head: base })[0], /edited, renamed or deleted/);
});

test('refuseTarget: exactly the expected project read from the URL, never live or MetaHive', () => {
  const pooler = (ref, pw = 'pw') => `postgresql://postgres.${ref}:${pw}@aws-0-us-west-1.pooler.supabase.com:5432/postgres`;
  assert.equal(refuseTarget(pooler('fsnjredpmakbmhwowjjt'), 'fsnjredpmakbmhwowjjt'), null);
  assert.equal(refuseTarget('postgresql://postgres:pw@db.fsnjredpmakbmhwowjjt.supabase.co:5432/postgres', 'fsnjredpmakbmhwowjjt'), null);
  assert.match(refuseTarget(pooler('rhyzpcqhnizqbxphqdkr'), 'fsnjredpmakbmhwowjjt'), /live/);
  assert.match(refuseTarget(pooler('fsnjredpmakbmhwowjjt'), 'rhyzpcqhnizqbxphqdkr'), /live/);
  assert.match(refuseTarget(pooler('dyxaxsjrqprvxzxkfooi'), 'fsnjredpmakbmhwowjjt'), /MetaHive/);
  assert.match(refuseTarget(pooler('otherprojectabcdefgh', 'fsnjredpmakbmhwowjjt'), 'fsnjredpmakbmhwowjjt'), /for otherprojectabcdefgh, not/);
  assert.match(refuseTarget('postgresql://postgres:pw@10.0.0.5:5432/postgres?x=fsnjredpmakbmhwowjjt', 'fsnjredpmakbmhwowjjt'), /unrecognised host/);
  assert.match(refuseTarget(pooler('fsnjredpmakbmhwowjjt'), ''), /TARGET_REF is not set/);
  assert.match(refuseTarget('', 'fsnjredpmakbmhwowjjt'), /not set/);
  assert.equal(urlRef('postgresql://postgres:postgres@127.0.0.1:56322/x'), 'local');
});

test('sqlSkeleton keeps only top-level SQL; transaction control is caught in any form', () => {
  const body = "create procedure p() language plpgsql as $$\nbegin\n  commit;\nend;\n$$;\n-- commit;\n/* commit; /* nested */ */\nselect 'commit;';\n";
  assert.deepEqual(fileProblems('20261110120000_p', Buffer.from(body)), []);
  for (const bad of ['create table t(x int); COMMIT WORK;', 'create table t(x int); COMMIT /* note */;', 'select 1;\n  end;', 'savepoint a;', 'Begin Transaction;']) {
    assert.match(fileProblems('x', Buffer.from(bad))[0] ?? '', /own transaction control/, bad);
  }
  assert.equal(sqlSkeleton("select E'it\\'s ; commit' ;").includes('commit'), false);
});

test('planMigrations: allowOutOfOrder applies older files (and still reports them)', () => {
  const p = planMigrations({
    files: f(['20261101000000_late', '20261105000000_new']),
    highWater: '20260727174805',
    ledgerNames: new Set(['20261103000000_applied']),
    oneShots: new Set(),
    allowOutOfOrder: true,
  });
  assert.deepEqual(p.outOfOrder, ['20261101000000_late']);
  assert.deepEqual(p.steps.map((s) => s.stem), ['20261101000000_late', '20261105000000_new']);
});

test('urlRef: a pooler user only counts on a Supabase pooler host, the direct host only with user postgres', () => {
  assert.equal(urlRef('postgresql://postgres.fsnjredpmakbmhwowjjt:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres'), 'fsnjredpmakbmhwowjjt');
  assert.equal(urlRef('postgresql://postgres.fsnjredpmakbmhwowjjt:pw@attacker.example:5432/postgres'), null);
  assert.equal(urlRef('postgresql://postgres.fsnjredpmakbmhwowjjt@localhost:5432/postgres'), null);
  assert.equal(urlRef('postgresql://other:pw@db.fsnjredpmakbmhwowjjt.supabase.co:5432/postgres'), null);
});

test('fileProblems: a psql backslash command anywhere outside quotes; SQL-standard function bodies are fine', () => {
  assert.match(fileProblems('x', Buffer.from('select 1; \\! cat /proc/self/environ'))[0] ?? '', /backslash/);
  assert.deepEqual(fileProblems('x', Buffer.from("select '\\! not a command';")), []);
  assert.deepEqual(fileProblems('x', Buffer.from('create function f() returns int language sql begin atomic select 1; select 2; end;\nselect 3;')), []);
});

test('migration names need a plausible date and time', () => {
  const head = f(['99999999999999_x']);
  assert.match(stampProblems({ added: head, base: [], head })[0], /name must be/);
  assert.deepEqual(stampProblems({ added: f(['20261231235959_ok']), base: [], head: f(['20261231235959_ok']) }), []);
});
