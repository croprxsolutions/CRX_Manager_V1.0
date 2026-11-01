import assert from 'node:assert/strict';
import {
  chicagoCalendarStamp,
  frozenHistoryProblems,
  FROZEN_LIVE_CAPTURES,
  manualFreshnessBoundary,
  manualStampProblems,
  migrationIndexProblems,
  orphanRecords,
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
  const record = (slug) => ({ name: `20261102090000_${slug}.md`, text: '**LOCAL CANDIDATE — NOT APPLIED.** body\n' });
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
  assert.deepEqual(orphanRecords(['20261102090000_a.md', '20261102090000_b.md'], ['20261102090000_a.sql']), ['20261102090000_b.md'], 'a record with no matching migration file fails');
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
  manualFreshnessBoundary('20260905', '20260904'),
  '20260904',
  'a deliberately future-stamped candidate must not force a future verification claim',
);
assert.equal(
  manualFreshnessBoundary('20260903', '20260904'),
  '20260903',
  'an ordinary migration still defines the minimum freshness boundary',
);

console.log('PASS - check-doc-drift helpers keep one record per migration, a frozen history file, short single stamps and Chicago-date freshness.');
