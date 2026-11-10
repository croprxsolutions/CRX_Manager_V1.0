import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './lib/test-temp-dir.mjs';
import {
  chicagoCalendarStamp,
  freshnessEnforcedFor,
  frozenHistoryProblems,
  FROZEN_LIVE_CAPTURES,
  manualFreshnessBoundary,
  manualStampProblems,
  migrationIndexProblems,
  recordFileProblems,
} from './check-doc-drift-lib.mjs';
import { combineMigrationHistory } from '../.claude/hooks/migration-records-lib.mjs';

{
  const capture = '**Live capture — 2026-10-29 14:36 UTC:** `max(version)` = `20261028185500_order_edit` (row 1001).';
  const rowFor = (n, v, status) => `| ${n} | ${v} | ${status} \`${v}_x.sql\` |`;
  const table = (...rows) => [capture, '', '| # | Migration timestamp | Purpose |', '|---:|---|---|', ...rows].join('\n');
  const versions = ['20260101000000', '20261027080400', '20261028185500'];
  const ok = migrationIndexProblems(table(rowFor(1000, '20261027080400', 'APPLIED LIVE'), rowFor(1001, '20261028185500', 'APPLIED LIVE')), versions);
  assert.deepEqual([ok.checked, ok.missing, ok.duplicated], [2, [], []], 'one row per recent migration passes; rows before the cutoff are not required');
  const dropped = migrationIndexProblems(table(rowFor(1000, '20261027080400', 'APPLIED LIVE')), versions);
  assert.deepEqual(dropped.missing, ['20261028185500'], 'a removed row fails even while its capture still names the migration');
  const unioned = migrationIndexProblems(table(rowFor(1000, '20261027080400', 'APPLIED LIVE'), rowFor(1001, '20261028185500', '**LOCAL CANDIDATE — NOT APPLIED.**'), rowFor(1001, '20261028185500', 'APPLIED LIVE')), versions);
  assert.deepEqual(unioned.duplicated, ['20261028185500'], 'a candidate row and an applied row for one migration (a union merge kept both) fail');
  const twoApplied = migrationIndexProblems(table(rowFor(1000, '20261027080400', 'APPLIED LIVE'), rowFor(1001, '20261027080400', 'APPLIED LIVE 2026-10-29'), rowFor(1001, '20261028185500', 'APPLIED LIVE')), versions);
  assert.deepEqual(twoApplied.duplicated, ['20261027080400'], 'two applied rows for one migration fail too');
  const twoNew = migrationIndexProblems(table(rowFor(1002, '20261027080400', 'APPLIED LIVE'), rowFor(1002, '20261028185500', 'APPLIED LIVE')), versions);
  assert.deepEqual([twoNew.missing, twoNew.duplicated], [[], []], 'two PRs that both numbered their new row 1002 still pass: rows are keyed by version');
}
{
  const frozen = '| 1011 | 20261030090000 | APPLIED LIVE |\n';
  const record = (slug) => ({ name: `20261102090000_${slug}.md`, text: `**LOCAL CANDIDATE — NOT APPLIED.** \`20261102090000_${slug}.sql\`\n` });
  const versions = ['20261030090000', '20261102090000'];
  const one = migrationIndexProblems(combineMigrationHistory(frozen, [record('a')]), versions);
  assert.deepEqual([one.missing, one.duplicated], [[], []], 'a record file counts as the one record');
  assert.deepEqual(migrationIndexProblems(combineMigrationHistory(frozen, []), versions).missing, ['20261102090000'], 'a migration with no record fails');
  assert.deepEqual(migrationIndexProblems(combineMigrationHistory(frozen, [record('a'), record('b')]), versions).duplicated, ['20261102090000'], 'two record files for one version fail');
  const alsoFrozen = `${frozen}| 1012 | 20261102090000 | APPLIED LIVE |\n`;
  assert.deepEqual(migrationIndexProblems(combineMigrationHistory(alsoFrozen, [record('a')]), versions).duplicated, ['20261102090000'], 'a record plus a frozen row fails');
  assert.match(frozenHistoryProblems(alsoFrozen).join(' '), /20261102090000 has a row in the frozen file/, 'a new row in the frozen file fails');
  assert.deepEqual(frozenHistoryProblems(frozen), [], 'older frozen rows pass');
  const captures = (count) => '**Live capture — x:** y\n'.repeat(count);
  assert.deepEqual(frozenHistoryProblems(captures(FROZEN_LIVE_CAPTURES)), [], 'the frozen captures pass');
  assert.match(frozenHistoryProblems(captures(FROZEN_LIVE_CAPTURES + 1)).join(' '), /1 new live capture/, 'a new capture in the frozen file fails');
  assert.deepEqual(recordFileProblems(['20261102090000_a.md', '20261102090000_b.md'], ['20261102090000_a.sql']).orphans, ['20261102090000_b.md'], 'a record with no matching migration file fails');
  assert.deepEqual(recordFileProblems(['20261102090000_a.md'], ['20261030090000_old.sql', '20261102090000_a.sql', '20261102090000_b.sql']).unrecorded, ['20261102090000_b.sql'], 'two migrations cannot share one version\'s record; older files are exempt');
}
assert.deepEqual(manualStampProblems('# Doc\n\n**Last verified:** 2026-10-29 (America/Chicago), ledger only.\n'), [], 'a short single stamp passes');
assert.match(manualStampProblems(`**Last verified:** 2026-10-29 ${'x'.repeat(200)}`).join(' '), /limit 200/, 'a 201+ character stamp line fails');
assert.match(manualStampProblems('Last verified: 2026-10-28\nLast verified: 2026-10-29\n').join(' '), /2 "Last verified" lines/, 'two stamp lines (a merge kept both) fail');
assert.equal(
  chicagoCalendarStamp(new Date('2026-09-05T03:30:00.000Z')),
  '20260904',
  'freshness uses the repository business timezone rather than UTC',
);
assert.equal(
  manualFreshnessBoundary(['20260903', '20260905'], '20260904'),
  '20260903',
  'a future-dated migration neither raises the bar nor makes "today" the bar',
);
assert.equal(
  manualFreshnessBoundary(['20260903', '20260904', '20260905'], '20260904'),
  '20260904',
  'a migration dated today is due, so it sets the bar',
);
assert.equal(manualFreshnessBoundary(['20260905'], '20260904'), undefined, 'only future migrations: no bar yet');
assert.equal(manualFreshnessBoundary([], '20260904'), undefined, 'no migrations: no bar');

assert.equal(freshnessEnforcedFor(['scripts/a.mjs', 'docs/changelog.d/x.md']), false,
  'a change with no migration and no live-state doc only warns on a stale stamp');
assert.equal(freshnessEnforcedFor(['supabase/migrations/20261103000000_x.sql']), true,
  'a new migration must carry a fresh stamp');
assert.equal(freshnessEnforcedFor(['docs/manual/KNOWN_ISSUES.md']), true,
  'touching a live-state doc must leave its stamp fresh');
assert.equal(freshnessEnforcedFor([]), false, 'an empty diff only warns');

// --pins-only: the pre-push check refuses a record pinned to the CRLF hash and passes the LF one (PR #1579).
{
  const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  const sql = '-- x\nselect 1;\n';
  const pinsOnly = (pin) => {
    const root = tempDir('crx-pins-only-');
    try {
      mkdirSync(path.join(root, 'supabase/migrations'), { recursive: true });
      mkdirSync(path.join(root, 'docs/reference/migrations.d'), { recursive: true });
      writeFileSync(path.join(root, 'docs/reference/migration-history.md'), '# frozen\n');
      // A Windows checkout's CRLF copy; the check must hash the LF text git stores.
      writeFileSync(path.join(root, 'supabase/migrations/20261201000000_x.sql'), sql.replace(/\n/g, '\r\n'));
      writeFileSync(path.join(root, 'docs/reference/migrations.d/20261201000000_x.md'),
        `**LOCAL CANDIDATE — NOT APPLIED.** \`20261201000000_x.sql\` (SQL sha256: \`${pin}\`).\n`);
      return spawnSync(process.execPath, [path.resolve('scripts/check-doc-drift.mjs'), '--pins-only', root], { encoding: 'utf8' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const crlf = pinsOnly(sha(sql.replace(/\n/g, '\r\n')));
  assert.equal(crlf.status, 1, `a CRLF pin must fail: ${crlf.stdout}`);
  assert.match(crlf.stdout, /sha256 does not match/);
  const lf = pinsOnly(sha(sql));
  assert.equal(lf.status, 0, `the LF pin must pass: ${lf.stdout}${lf.stderr}`);
}

// --freshness-only: pre-push refuses a migration dated today when the live-state stamps are older,
// even outside a git checkout, and passes once they are bumped (PR #1652 found it in CI).
{
  const today = chicagoCalendarStamp();
  const dashed = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6)}`;
  const freshnessOnly = (stamp, stampLine = `**Last verified:** ${stamp}`, migrationDates = [today]) => {
    const root = tempDir('crx-freshness-only-');
    try {
      mkdirSync(path.join(root, 'supabase/migrations'), { recursive: true });
      mkdirSync(path.join(root, 'docs/manual'), { recursive: true });
      for (const date of migrationDates) writeFileSync(path.join(root, `supabase/migrations/${date}120000_x.sql`), 'select 1;\n');
      for (const doc of ['CURRENT_STATE.md', 'KNOWN_ISSUES.md']) {
        writeFileSync(path.join(root, 'docs/manual', doc), `# ${doc}\n\n${stampLine}\n`);
      }
      return spawnSync(process.execPath, [path.resolve('scripts/check-doc-drift.mjs'), '--freshness-only', root], { encoding: 'utf8' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const stale = freshnessOnly('2000-01-01');
  assert.equal(stale.status, 1, `a stamp older than today's migration must fail: ${stale.stdout}${stale.stderr}`);
  assert.match(stale.stdout, /FAIL manual freshness CURRENT_STATE\.md/);
  assert.match(stale.stdout, /FAIL manual freshness KNOWN_ISSUES\.md/);
  const fresh = freshnessOnly(dashed);
  assert.equal(fresh.status, 0, `today's stamp must pass: ${fresh.stdout}${fresh.stderr}`);
  const long = freshnessOnly(dashed, `**Last verified:** ${dashed} ${'x'.repeat(200)}`);
  assert.equal(long.status, 1, `an over-long stamp line must fail: ${long.stdout}`);
  assert.match(long.stdout, /FAIL manual doc CURRENT_STATE\.md stamp line/);

  // Midnight Central with a future-dated migration on main (2026-11-09): the bar is the
  // newest migration already due, never "today" by itself.
  const y = new Date(Date.UTC(+today.slice(0, 4), +today.slice(4, 6) - 1, +today.slice(6) - 1)).toISOString().slice(0, 10);
  const yesterday = y.replace(/-/g, '');
  const future = '20991231';
  const docsOnly = freshnessOnly(y, undefined, [yesterday, future]);
  assert.equal(docsOnly.status, 0, `(a) yesterday's stamps pass when nothing is due today: ${docsOnly.stdout}${docsOnly.stderr}`);
  const futureOnly = freshnessOnly('2026-01-01', undefined, ['20260101', future]);
  assert.equal(futureOnly.status, 0, `(b) a future-dated migration does not raise the bar: ${futureOnly.stdout}${futureOnly.stderr}`);
  const dueToday = freshnessOnly(y, undefined, [yesterday, today, future]);
  assert.equal(dueToday.status, 1, `(c) a migration dated today still needs today's stamps: ${dueToday.stdout}`);
  assert.match(dueToday.stdout, /FAIL manual freshness CURRENT_STATE\.md/);
  assert.match(dueToday.stdout, /FAIL manual freshness KNOWN_ISSUES\.md/);
}

console.log('PASS - check-doc-drift helpers keep one record per migration, a frozen history file, short single stamps and Chicago-date freshness.');
