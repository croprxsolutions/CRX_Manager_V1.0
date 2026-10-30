import assert from 'node:assert/strict';
import {
  chicagoCalendarStamp,
  manualFreshnessBoundary,
  manualStampProblems,
  migrationIndexProblems,
} from './check-doc-drift-lib.mjs';

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

console.log('PASS - check-doc-drift helpers keep one row per migration, short single stamps and Chicago-date freshness.');
