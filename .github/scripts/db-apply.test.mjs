// Run: node --test .github/scripts/db-apply.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMigrations, dollarTag, wrapperSql, isNoTransaction, stampProblems, refuseTarget, urlRef, fileProblems, sqlSkeleton, ledgerDrift, schemaDiff, applyUserProblem, realStamp, planRestamps, restampPairs, restampSql, unmatchedRestamps } from './db-apply.mjs';

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
  // Back-merge of main into staging: a file already on main, unchanged, may be older than staging's newest.
  const old = f(['20261201000000_from_main']);
  assert.deepEqual(stampProblems({ added: old, base, head: [...base, ...old], onMain: old }), []);
  assert.match(stampProblems({ added: old, base, head: [...base, ...old], onMain: [] })[0], /not newer than/);
  assert.match(stampProblems({ added: f(['20261201000000_x']), base, head: [...base, ...f(['20261201000000_x', '20261201000000_y'])], onMain: f(['20261201000000_x']) })[0], /shares its stamp/);
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

test('existing files with an impossible time (08:60) still apply; new ones must be real', () => {
  const p = planMigrations({ files: f(['20261022086000_team_board']), highWater: '20260727174805', ledgerNames: new Set(), oneShots: new Set() });
  assert.deepEqual(p.steps.map((x) => x.stem), ['20261022086000_team_board']);
  assert.match(stampProblems({ added: f(['20261231086000_new']), base: [], head: f(['20261231086000_new']) })[0], /real date and time/);
});

test('a file that is only stored (backfill, one-shot) needs clean UTF-8, not the run rules', () => {
  const wrapped = Buffer.from('BEGIN;\ncreate table t();\nCOMMIT;\n');
  assert.match(fileProblems('x', wrapped)[0], /own transaction control/);
  assert.deepEqual(fileProblems('x', wrapped, { forRun: false }), []);
  assert.match(fileProblems('x', Buffer.from([0xff]), { forRun: false })[0], /not valid UTF-8/);
});

test('ledgerDrift: rows with no file, rows whose file changed, files never applied', () => {
  const hw = '20260727174805';
  const files = new Map([
    ['20261101000000_a', 'h-a'],
    ['20261102000000_b', 'h-b-new'],
    ['20261103000000_pending', 'h-p'],
  ]);
  const stored = new Map([
    ['legacy_name', ''], // baseline-era row: ignored
    ['20260101000000_old', 'x'], // before the baseline: ignored
    ['20261101000000_a', 'h-a'],
    ['20261102000000_b', 'h-b-old'],
    ['20261105000000_sql_editor_change', 'h-z'],
  ]);
  const d = ledgerDrift({ stored, files, highWater: hw, oneShots: new Set() });
  assert.deepEqual(d.noFile, ['20261105000000_sql_editor_change']);
  assert.deepEqual(d.changed, ['20261102000000_b']);
  assert.deepEqual(d.notApplied, ['20261103000000_pending']);
});

test('urlRef: the read-only drift login on the pooler counts; any other host or a bad role does not', () => {
  assert.equal(urlRef('postgresql://crx_drift_ro.fsnjredpmakbmhwowjjt:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres'), 'fsnjredpmakbmhwowjjt');
  assert.equal(urlRef('postgresql://crx_drift_ro.fsnjredpmakbmhwowjjt:pw@attacker.example:5432/postgres'), null);
  assert.equal(urlRef('postgresql://Bad-Role.fsnjredpmakbmhwowjjt:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres'), null);
  assert.match(refuseTarget('postgresql://crx_drift_ro.rhyzpcqhnizqbxphqdkr:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres', 'fsnjredpmakbmhwowjjt'), /live/);
});

test('schemaDiff: lines only on the target and lines only in the rebuild, in their own order', () => {
  const target = ['column t.a int', 'function f() md5=1', 'policy t.p'];
  const rebuilt = ['column t.a int', 'function f() md5=2', 'index i'];
  assert.deepEqual(schemaDiff(target, rebuilt), { onlyTarget: ['function f() md5=1', 'policy t.p'], onlyRebuilt: ['function f() md5=2', 'index i'] });
  assert.deepEqual(schemaDiff(target, [...target]), { onlyTarget: [], onlyRebuilt: [] });
});

test('applyUserProblem: migrations apply only as postgres (pooler or direct), never the read-only or another role', () => {
  assert.equal(applyUserProblem('postgresql://postgres.fsnjredpmakbmhwowjjt:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres'), null);
  assert.equal(applyUserProblem('postgresql://postgres:pw@db.fsnjredpmakbmhwowjjt.supabase.co:5432/postgres'), null);
  assert.match(applyUserProblem('postgresql://crx_drift_ro.fsnjredpmakbmhwowjjt:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres'), /only as postgres, not crx_drift_ro/);
  assert.match(applyUserProblem('postgresql://migration_writer.fsnjredpmakbmhwowjjt:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres'), /not migration_writer/);
});

test('realStamp: the right shape and a real calendar day', () => {
  assert.equal(realStamp('20261231235959'), true);
  assert.equal(realStamp('20280229120000'), true); // leap year
  assert.equal(realStamp('20260231010000'), false); // 31 February
  assert.equal(realStamp('20270229120000'), false); // not a leap year
  assert.equal(realStamp('20261131000000'), false); // 31 November
});

test('fileProblems: a no-transaction file holds one statement; a one-shot is only checked for encoding', () => {
  const buf = (t) => Buffer.from(t);
  assert.deepEqual(fileProblems('x', buf('-- crx: no-transaction\nCREATE INDEX CONCURRENTLY i ON t (a);\n')), []);
  assert.match(fileProblems('x', buf('-- crx: no-transaction\nCREATE INDEX CONCURRENTLY i ON t (a);\nDROP INDEX j;\n'))[0], /one statement/);
  assert.deepEqual(fileProblems('x', buf("-- crx: no-transaction\nSET lock_timeout = '5s';\nCREATE INDEX CONCURRENTLY i ON t (a);\n")), []);
  assert.match(fileProblems('x', buf('-- crx: no-transaction\nCREATE INDEX CONCURRENTLY i ON t (a);\nSET ROLE nobody;\n'))[0], /one statement/);
  assert.match(fileProblems('x', buf("-- crx: no-transaction\nSET lock_timeout = '5s';\n"))[0], /one statement/);
  assert.match(fileProblems('x', buf('-- crx: no-transaction\nSET session_replication_role = replica;\nUPDATE t SET a = 1;\n'))[0], /one statement/);
  assert.match(fileProblems('x', buf('BEGIN;\nUPDATE t SET a = 1;\nCOMMIT;\n'))[0], /transaction control/);
  assert.deepEqual(fileProblems('x', buf('BEGIN;\nUPDATE t SET a = 1;\nCOMMIT;\n'), { forRun: false }), []);
  assert.deepEqual(fileProblems('x', buf('-- crx: no-transaction\nUPDATE t SET a = 1;\nUPDATE t SET b = 2;\n'), { forRun: false }), []);
});

// Mason's restamp (ship.md, 2026-11-04): the same SQL under a newer stamp. On staging the old name already ran.
const H = (c) => c.repeat(64);
test('planRestamps: a file the ledger lacks whose SQL matches a fileless row with the same name renames that row', () => {
  const stored = new Map([['20261231110000_m4b', H('a')], ['20261231120000_m4a', H('b')], ['20270101000000_live', H('c')], ['20261231130000_bare', '']]);
  const files = new Map([['20270102000000_m4b', H('a')], ['20270102000001_m4a', H('b')], ['20270101000000_live', H('c')]]);
  assert.deepEqual(planRestamps({ stored, files, highWater: '20260727174805' }), [
    { from: '20261231110000_m4b', to: '20270102000000_m4b', sha: H('a') },
    { from: '20261231120000_m4a', to: '20270102000001_m4a', sha: H('b') },
  ]);
});
test('planRestamps: anything short of a clean restamp runs (or stops) as before', () => {
  const highWater = '20260727174805';
  const one = (stored, files) => planRestamps({ stored: new Map(stored), files: new Map(files), highWater });
  assert.deepEqual(one([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('d')]]), [], 'different SQL');
  assert.deepEqual(one([['20261231110000_m4b', H('a')]], [['20270102000000_other', H('a')]]), [], 'different name after the stamp');
  assert.deepEqual(one([['20270103000000_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), [], 'the new stamp is older');
  assert.deepEqual(one([['20261231110000_m4b', H('a')]], [['20261231110000_m4b', H('a')], ['20270102000000_m4b', H('a')]]), [], 'the old row still has its file');
  assert.deepEqual(one([['20261231110000_m4b', '']], [['20270102000000_m4b', H('a')]]), [], 'a row without stored SQL proves nothing');
  assert.deepEqual(one([['20260101000000_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), [], 'the old row is before the baseline');
  assert.deepEqual(one([['20261231110000_m4b', H('a')], ['20261231110001_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), [], 'two rows could match');
  assert.deepEqual(one([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('a')], ['20270102000001_m4b', H('a')]]), [], 'two files could match');
});
test('unmatchedRestamps: a restamp that is not clean blocks instead of running again (Mason, 2026-11-12)', () => {
  const highWater = '20260727174805';
  const run = (stored, files) => { const s = new Map(stored); const f = new Map(files); return unmatchedRestamps({ stored: s, files: f, highWater, restamps: planRestamps({ stored: s, files: f, highWater }) }); };
  assert.deepEqual(run([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), [], 'a clean restamp is planned, not blocked');
  assert.deepEqual(run([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('d')]]), ['20270102000000_m4b'], 'different SQL blocks');
  assert.deepEqual(run([['20261231110000_m4b', '']], [['20270102000000_m4b', H('a')]]), ['20270102000000_m4b'], 'a row holding no SQL blocks');
  assert.deepEqual(run([['20261231110000_m4b', H('a')], ['20261231110001_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), ['20270102000000_m4b'], 'two rows could match: blocks');
  assert.deepEqual(run([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('a')], ['20270102000001_m4b', H('a')]]).length, 2, 'two files could match: both block');
  assert.deepEqual(run([['20261231110000_m4b', H('a')]], [['20261231110000_m4b', H('a')], ['20270102000000_new', H('b')]]), [], 'an ordinary new migration runs');
  assert.deepEqual(run([['20270103000000_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), [], 'an older stamp is not a restamp (the out-of-order check handles it)');
  assert.deepEqual(run([['20260101000000_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), [], 'a row before the baseline is not a restamp');
});
test('restampSql: one transaction, renames only the row holding that exact SQL, and proves it before COMMIT', () => {
  const sql = restampSql({ from: '20261231110000_m4b', to: '20270102000000_m4b', sha: H('a') });
  assert.match(sql, /^BEGIN;\nUPDATE supabase_migrations\.schema_migrations SET name = '20270102000000_m4b' WHERE name = '20261231110000_m4b' AND encode\(sha256\(convert_to\(statements\[1\], 'UTF8'\)\), 'hex'\) = 'a{64}';/);
  assert.match(sql, /RESTAMP_RENAME_FAILED/);
  assert.match(sql, /COMMIT;\n$/);
  assert.throws(() => restampSql({ from: "x'; DROP TABLE t; --", to: '20270102000000_m4b', sha: H('a') }), /bad migration name/);
  assert.throws(() => restampSql({ from: '20261231110000_m4b', to: '20270102000000_m4b', sha: 'nope' }), /bad sha256/);
});
test('restampPairs: a deleted and an added migration with the same blob and name after the stamp, newer stamp', () => {
  const blob = { '20261231110000_m4b.sql': 'b1', '20270102000000_m4b.sql': 'b1', '20261231120000_m4a.sql': 'b2', '20270102000001_m4a.sql': 'b3', '20270102000002_x.sql': 'b1' };
  const pairs = restampPairs({ deleted: ['20261231110000_m4b.sql', '20261231120000_m4a.sql'], added: ['20270102000000_m4b.sql', '20270102000001_m4a.sql', '20270102000002_x.sql'], blob: (f) => blob[f] });
  assert.deepEqual(pairs, [{ from: '20261231110000_m4b.sql', to: '20270102000000_m4b.sql' }], 'm4a changed its bytes; x has another name');
  assert.deepEqual(restampPairs({ deleted: ['20270103000000_m4b.sql'], added: ['20270102000000_m4b.sql'], blob: () => 'same' }), [], 'an older new stamp is no restamp');
  assert.deepEqual(restampPairs({ deleted: ['20261231110000_m4b.sql'], added: ['20270102000000_m4b.sql'], blob: () => null }), [], 'an unreadable blob is no restamp');
  assert.deepEqual(restampPairs({ deleted: ['20261231110000_m4b.sql', '20261231110001_m4b.sql'], added: ['20270102000000_m4b.sql'], blob: () => 'same' }), [], 'two deleted files claiming one new file is no restamp');
});
test('stampProblems: a restamp is not an edit, and its new stamp must still be the newest', () => {
  const base = ['20261231110000_m4b.sql', '20270101000000_live.sql'];
  const head = ['20270102000000_m4b.sql', '20270101000000_live.sql'];
  assert.deepEqual(stampProblems({ added: ['20270102000000_m4b.sql'], base, head, changed: [] }), []);
  assert.match(stampProblems({ added: ['20261231115900_m4b.sql'], base, head: ['20261231115900_m4b.sql', ...base.slice(1)], changed: [] })[0], /not newer/);
});
