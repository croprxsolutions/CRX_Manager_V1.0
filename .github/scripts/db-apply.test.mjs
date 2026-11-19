// Run: node --test .github/scripts/db-apply.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planMigrations, dollarTag, wrapperSql, isNoTransaction, stampProblems, refuseTarget, urlRef, fileProblems, sqlSkeleton, ledgerDrift, schemaDiff, applyUserProblem, realStamp, planRestamps, restampPairs, restampSql, unmatchedRestamps, migrationChanges, renameTargetProblem, oneShotListProblems, oneShotStops, ONE_SHOT_STOPS } from './db-apply.mjs';

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
  const deleted = (n) => stored.get(n) ?? null; // git shows each old file deleted holding what ran
  assert.deepEqual(planRestamps({ stored, files, highWater: '20260727174805', deleted }), [
    { from: '20261231110000_m4b', to: '20270102000000_m4b', sha: H('a') },
    { from: '20261231120000_m4a', to: '20270102000001_m4a', sha: H('b') },
  ]);
});
test('planRestamps: anything short of a clean restamp runs (or stops) as before', () => {
  const highWater = '20260727174805';
  const one = (stored, files, deleted) => { const s = new Map(stored); return planRestamps({ stored: s, files: new Map(files), highWater, deleted: deleted ?? ((n) => s.get(n) ?? null) }); };
  assert.deepEqual(one([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('d')]]), [], 'different SQL');
  assert.deepEqual(one([['20261231110000_m4b', H('a')]], [['20270102000000_other', H('a')]]), [], 'different name after the stamp');
  assert.deepEqual(one([['20270103000000_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), [], 'the new stamp is older');
  assert.deepEqual(one([['20261231110000_m4b', H('a')]], [['20261231110000_m4b', H('a')], ['20270102000000_m4b', H('a')]]), [], 'the old row still has its file');
  assert.deepEqual(one([['20261231110000_m4b', '']], [['20270102000000_m4b', H('a')]]), [], 'a row without stored SQL proves nothing');
  assert.deepEqual(one([['20260101000000_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), [], 'the old row is before the baseline');
  assert.deepEqual(one([['20261231110000_m4b', H('a')], ['20261231110001_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), [], 'two rows could match');
  assert.deepEqual(one([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('a')], ['20270102000001_m4b', H('a')]]), [], 'two files could match');
  assert.deepEqual(one([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('a')]], () => null), [], 'git shows no delete of the old file (Sol, #1837): no rename');
  assert.deepEqual(one([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('a')]], () => H('d')), [], 'the old file was deleted holding other bytes: no rename');
  assert.deepEqual(one([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('a')]], (from, to) => (to === '20270102000000_m4b' ? null : H('a'))), [], 'the delete came with another change, not this add: no rename (Sol, #1837)');
});
test('unmatchedRestamps: a restamp that is not clean blocks instead of running again (Mason, 2026-11-12)', () => {
  const highWater = '20260727174805';
  const run = (stored, files, deleted) => { const s = new Map(stored); const f = new Map(files); return unmatchedRestamps({ stored: s, files: f, highWater, restamps: planRestamps({ stored: s, files: f, highWater, deleted: deleted ?? ((n) => s.get(n) ?? null) }) }); };
  assert.deepEqual(run([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), [], 'a clean restamp is planned, not blocked');
  assert.deepEqual(run([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('d')]]), ['20270102000000_m4b'], 'different SQL blocks');
  assert.deepEqual(run([['20261231110000_m4b', '']], [['20270102000000_m4b', H('a')]]), ['20270102000000_m4b'], 'a row holding no SQL blocks');
  assert.deepEqual(run([['20261231110000_m4b', H('a')], ['20261231110001_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), ['20270102000000_m4b'], 'two rows could match: blocks');
  assert.deepEqual(run([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('a')], ['20270102000001_m4b', H('a')]]).length, 2, 'two files could match: both block');
  assert.deepEqual(run([['20261231110000_m4b', H('a')]], [['20261231110000_m4b', H('a')], ['20270102000000_new', H('b')]]), [], 'an ordinary new migration runs');
  assert.deepEqual(run([['20270103000000_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), ['20270102000000_m4b'], 'a backward restamp blocks (Mason, #1837 MED 2)');
  assert.deepEqual(run([['20261231110000_m4b', H('a')]], [['20261231110000_m4b', H('a')], ['20270102000000_m4b', H('a')]]), ['20270102000000_m4b'], 'a copy while the old row still has its file blocks (MED 1)');
  assert.deepEqual(run([['20261231110000_m4b', H('a')]], [['20270102000000_renamed', H('a')]]), ['20270102000000_renamed'], 'the same SQL under a new slug blocks (MED 1)');
  assert.deepEqual(run([['20261231110000_m4b', H('a')]], [['20270102000000_m4b', H('a')]], () => null), ['20270102000000_m4b'], 'no delete in git: blocks instead of a silent rename (Sol, #1837)');
  assert.deepEqual(run([['20260101000000_m4b', H('a')]], [['20270102000000_m4b', H('a')]]), ['20270102000000_m4b'], 'a row before the baseline is no restamp, and a copy of its SQL blocks (MED 1)');
});
test('restampSql: one transaction, renames only the row holding that exact SQL, and proves it before COMMIT', () => {
  const sql = restampSql([{ from: '20261231110000_m4b', to: '20270102000000_m4b', sha: H('a') }]);
  assert.match(sql, /^BEGIN;\nUPDATE supabase_migrations\.schema_migrations SET name = '20270102000000_m4b' WHERE name = '20261231110000_m4b' AND encode\(sha256\(convert_to\(statements\[1\], 'UTF8'\)\), 'hex'\) = 'a{64}';/);
  assert.match(sql, /RESTAMP_RENAME_FAILED/);
  assert.match(sql, /COMMIT;\n$/);
  assert.throws(() => restampSql([{ from: "x'; DROP TABLE t; --", to: '20270102000000_m4b', sha: H('a') }]), /bad migration name/);
  assert.throws(() => restampSql([{ from: '20261231110000_m4b', to: '20270102000000_m4b', sha: 'nope' }]), /bad sha256/);
  const two = restampSql([{ from: '20261231110000_m4b', to: '20270102000000_m4b', sha: H('a') }, { from: '20261231120000_m4a', to: '20270102000001_m4a', sha: H('b') }]);
  assert.equal(two.match(/BEGIN;/g).length, 1, 'several restamps: one transaction (Mason, #1837 LOW 2)');
  assert.equal(two.match(/RESTAMP_RENAME_FAILED/g).length, 2);
});
test('restampPairs: a deleted and an added migration with the same blob and name after the stamp, newer stamp', () => {
  const blob = { '20261231110000_m4b.sql': 'b1', '20270102000000_m4b.sql': 'b1', '20261231120000_m4a.sql': 'b2', '20270102000001_m4a.sql': 'b3', '20270102000002_x.sql': 'b1' };
  const pairs = restampPairs({ deleted: ['20261231110000_m4b.sql', '20261231120000_m4a.sql'], added: ['20270102000000_m4b.sql', '20270102000001_m4a.sql', '20270102000002_x.sql'], blob: (f) => blob[f] });
  assert.deepEqual(pairs, [{ from: '20261231110000_m4b.sql', to: '20270102000000_m4b.sql' }], 'm4a changed its bytes; x has another name');
  assert.deepEqual(restampPairs({ deleted: ['20270103000000_m4b.sql'], added: ['20270102000000_m4b.sql'], blob: () => 'same' }), [], 'an older new stamp is no restamp');
  assert.deepEqual(restampPairs({ deleted: ['20261231110000_m4b.sql'], added: ['20270102000000_m4b.sql'], blob: () => null }), [], 'an unreadable blob is no restamp');
  assert.deepEqual(restampPairs({ deleted: ['20261231110000_m4b.sql', '20261231110001_m4b.sql'], added: ['20270102000000_m4b.sql'], blob: () => 'same' }), [], 'two deleted files claiming one new file is no restamp');
  const ab = { '20261231110000_b.sql': 'x', '20261231120000_a.sql': 'y', '20270102000000_b.sql': 'x', '20270102000001_a.sql': 'y', '20270102000002_b.sql': 'x' };
  assert.equal(restampPairs({ deleted: ['20261231110000_b.sql', '20261231120000_a.sql'], added: ['20270102000000_b.sql', '20270102000001_a.sql'], blob: (f) => ab[f] }).length, 2, 'order kept');
  const swapped = { ...ab, '20270102000000_b.sql': undefined, '20270102000002_b.sql': 'x' };
  assert.deepEqual(restampPairs({ deleted: ['20261231110000_b.sql', '20261231120000_a.sql'], added: ['20270102000002_b.sql', '20270102000001_a.sql'], blob: (f) => swapped[f] }), [], 'two restamps that swap order are none (Mason, #1837 LOW 6)');
});
test('stampProblems: a restamp is not an edit, and its new stamp must still be the newest', () => {
  const base = ['20261231110000_m4b.sql', '20270101000000_live.sql'];
  const head = ['20270102000000_m4b.sql', '20270101000000_live.sql'];
  assert.deepEqual(stampProblems({ added: ['20270102000000_m4b.sql'], base, head, changed: [] }), []);
  assert.match(stampProblems({ added: ['20261231115900_m4b.sql'], base, head: ['20261231115900_m4b.sql', ...base.slice(1)], changed: [] })[0], /not newer/);
});
test('stampProblems: into staging, a new migration must also be newer than main (a hotfix may have gone live first)', () => {
  const base = ['20270101000000_a.sql'];
  const mainFiles = ['20270101000000_a.sql', '20270105000000_hotfix.sql'];
  assert.match(stampProblems({ added: ['20270103000000_x.sql'], base, head: [...base, '20270103000000_x.sql'], mainFiles })[0], /newest migration on main/);
  assert.deepEqual(stampProblems({ added: ['20270106000000_x.sql'], base, head: [...base, '20270106000000_x.sql'], mainFiles }), []);
  assert.deepEqual(stampProblems({ added: ['20270105000000_hotfix.sql'], base, head: [...base, '20270105000000_hotfix.sql'], mainFiles, onMain: ['20270105000000_hotfix.sql'] }), [], 'the back-merge brings main\'s own file');
});

test('migrationChanges: a restamp is no edit only into staging, for a file not on main; a restamped one-shot stays one (Mason/Sol, #1837)', () => {
  const blobs = { '20261231110000_m4b.sql': 'b1', '20270109100100_m4b.sql': 'b1' };
  const base = { deleted: ['20261231110000_m4b.sql'], added: ['20270109100100_m4b.sql'], removedOrEdited: ['20261231110000_m4b.sql'], baseBlob: (f) => blobs[f] ?? null, headBlob: (f) => blobs[f] ?? null };
  assert.deepEqual(migrationChanges({ ...base, toStaging: true, onMain: () => false }), { changed: [], problems: [], pairs: [{ from: '20261231110000_m4b.sql', to: '20270109100100_m4b.sql' }] }, 'staging-only file: a restamp');
  assert.deepEqual(migrationChanges({ ...base, toStaging: true, onMain: () => true }).changed, ['20261231110000_m4b.sql'], 'the old file is on main (live): refused');
  assert.deepEqual(migrationChanges({ ...base, toStaging: false, onMain: () => false }).changed, ['20261231110000_m4b.sql'], 'into main: refused');
  assert.deepEqual(migrationChanges({ ...base, removedOrEdited: ['20261231110000_m4b.sql', '20260901000000_x.sql'], deleted: ['20261231110000_m4b.sql', '20260901000000_x.sql'], toStaging: true, onMain: () => false }).changed, ['20260901000000_x.sql'], 'a plain delete still counts');
  assert.deepEqual(migrationChanges({ ...base, headBlob: () => 'b2', toStaging: true, onMain: () => false }).changed, ['20261231110000_m4b.sql'], 'the new file is read at HEAD: other bytes are an edit');
  const shot = { ...base, toStaging: true, onMain: () => false, oneShotsBase: { '20261231110000_m4b': 'why' } };
  assert.match(migrationChanges({ ...shot, oneShotsHead: { '20261231110000_m4b': 'why' } }).problems[0], /restamps the one-shot 20261231110000_m4b/);
  assert.deepEqual(migrationChanges({ ...shot, oneShotsHead: { '20261231110000_m4b': 'why', '20270109100100_m4b': 'why' } }).problems, [], 'new name listed too: fine');
  assert.match(migrationChanges({ ...base, toStaging: true, onMain: () => false, oneShotsHead: { '20270109100100_m4b': 'why' } }).problems[0], /into a one-shot/, 'an ordinary file restamped into a one-shot is refused (attack run)');
  assert.match(migrationChanges({ ...base, toStaging: true, onMain: () => false, oneShotsHead: { '20261231110000_m4b': 'x', '20270109100100_m4b': 'x' } }).problems[0], /into a one-shot/, 'listing both names in the PR itself is still refused (Sol, #1837)');
  const withNew = (f) => migrationChanges({ ...base, added: [...base.added, f], toStaging: true, onMain: () => false });
  assert.match(withNew('20270109100000_b.sql').problems[0], /sorts below 20270109100100/, 'a new file below a restamp target is refused (Sol, #1837)');
  assert.deepEqual(withNew('20270109100200_b.sql').problems, [], 'a new file after the restamps is fine');
});

test('renameTargetProblem: ledger rows are renamed on staging only (Sol, #1837)', () => {
  assert.equal(renameTargetProblem(true, 'fsnjredpmakbmhwowjjt'), null);
  assert.match(renameTargetProblem(true, 'rhyzpcqhnizqbxphqdkr'), /staging database only/);
  assert.match(renameTargetProblem(true, 'abcdefghijklmnopqrst'), /staging database only/);
  assert.equal(renameTargetProblem(false, 'rhyzpcqhnizqbxphqdkr'), null);
});

test('oneShotListProblems: a one-shot leaves the list only when this PR restamps it into a listed name (Sol, #1990)', () => {
  const pairs = [{ from: '20261231110000_fix.sql', to: '20270109100100_fix.sql' }];
  const base = { '20261231110000_fix': 'why' };
  assert.deepEqual(oneShotListProblems({ base, head: { '20270109100100_fix': 'why' }, added: ['20270109100100_fix.sql'], pairs }), [], 'restamp with the entry moved: fine');
  assert.deepEqual(oneShotListProblems({ base, head: { ...base, '20270109100100_fix': 'why' }, added: ['20270109100100_fix.sql'], pairs }), [], 'both names kept: fine');
  assert.match(oneShotListProblems({ base, head: {}, added: ['20270109100100_fix.sql'], pairs })[0], /20261231110000_fix was removed/, 'restamped, but the new name is not listed: refused');
  assert.match(oneShotListProblems({ base, head: {}, added: [] })[0], /was removed/, 'no restamp: refused');
  assert.match(oneShotListProblems({ base: {}, head: { '20261231110000_old': 'x' }, added: [] })[0], /isn't a new file/, 'an existing file cannot become a one-shot');
  assert.match(oneShotListProblems({ base: {}, head: { '20270109100100_fix': 'x' }, added: ['20270109100100_fix.sql'], pairs })[0], /isn't a new file/, 'an ordinary file restamped into a one-shot is refused here too (Luna r3, #1990)');
  // Keeping only the old entry while restamping the file is refused one step earlier (Luna r2, #1990):
  const blobs = { '20261231110000_fix.sql': 'b1', '20270109100100_fix.sql': 'b1' };
  const moved = migrationChanges({ deleted: ['20261231110000_fix.sql'], added: ['20270109100100_fix.sql'], removedOrEdited: ['20261231110000_fix.sql'], baseBlob: (f) => blobs[f] ?? null, headBlob: (f) => blobs[f] ?? null, toStaging: true, onMain: () => false, oneShotsBase: base, oneShotsHead: base });
  assert.match(moved.problems[0], /restamps the one-shot 20261231110000_fix; add 20270109100100_fix/);
});

test('oneShotStops: a one-shot whose check finds its rows uncorrected stops the run; others are only recorded (Sol, #1990)', () => {
  const steps = [{ stem: '20270121100000_ki137', run: false }, { stem: '20270121110000_next', run: true }, { stem: '20261007150100_old', run: false }];
  const stops = { '20270121100000_ki137': 'CHECK_KI137', '20270121110000_next': 'CHECK_RUN' };
  const asked = [];
  const holds = (sql) => (asked.push(sql), sql === 'CHECK_KI137');
  const out = oneShotStops({ steps, stops, holds, ref: 'fsnjredpmakbmhwowjjt' });
  assert.equal(out.length, 1);
  assert.match(out[0], /^20270121100000_ki137 is a one-shot .*this database \(fsnjredpmakbmhwowjjt\) still holds rows it corrects/);
  assert.match(out[0], /Never apply it to live/);
  assert.match(out[0], /never on the command line\): psql -v ON_ERROR_STOP=1 -1 -f supabase\/migrations\/20270121100000_ki137\.sql/);
  assert.match(out[0], /If its preflight refuses, or those rows were changed on purpose after it, ask Mason/);
  assert.equal(oneShotStops({ steps, stops, holds: () => undefined }).length, 1, 'an unclear result stops (fails closed)');
  assert.deepEqual(asked, ['CHECK_KI137'], 'only a pending one-shot with a check is checked');
  assert.deepEqual(oneShotStops({ steps, stops, holds: () => false }), [], 'rows corrected: recorded as before');
});

test('ONE_SHOT_STOPS: every check belongs to a listed one-shot whose file exists, so a restamp has to move it', () => {
  const reg = JSON.parse(readFileSync(new URL('../../supabase/baselines/one-shot-migrations.json', import.meta.url), 'utf8')).one_shot;
  for (const [stem, sql] of Object.entries(ONE_SHOT_STOPS)) {
    assert.ok(Object.hasOwn(reg, stem), `${stem} is a listed one-shot`);
    assert.ok(readFileSync(new URL(`../../supabase/migrations/${stem}.sql`, import.meta.url)).length > 0, `${stem}.sql exists`);
    assert.match(sql, /^EXISTS \(SELECT 1 FROM public\./, `${stem}: a boolean EXISTS check`);
    assert.doesNotMatch(sql, /;/, `${stem}: one expression, no statement break`);
  }
  assert.ok(Object.keys(ONE_SHOT_STOPS).some((s) => s.includes('_ki137_')), 'KI-137 has a check');
});
