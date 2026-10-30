// migration-history.md merges with git's union driver (.gitattributes, 2026-10-29), so two
// PRs that add or edit rows at once both land. Every migration from this date on must
// therefore have exactly one table row keyed by its version: none means it was never
// indexed (a mention in capture prose does not count), two means a union merge kept
// two versions of one record and someone must reconcile them. Older rows predate the
// rule and hold known gaps and duplicates.
export const STRICT_INDEX_FROM = '20260915';

export function migrationIndexProblems(history, migrationVersions) {
  const rowCounts = new Map();
  for (const raw of history.split('\n')) {
    const line = raw.replace(/\r/g, '').trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3 || !/^\d{8,14}$/.test(cells[1])) continue;
    rowCounts.set(cells[1], (rowCounts.get(cells[1]) || 0) + 1);
  }
  const strict = migrationVersions.filter((version) => version >= STRICT_INDEX_FROM);
  return {
    checked: strict.length,
    missing: strict.filter((version) => !rowCounts.has(version)),
    duplicated: strict.filter((version) => rowCounts.get(version) > 1),
  };
}

// A manual doc carries one short "Last verified" line: every re-check used to rewrite a
// long evidence paragraph there, so every PR collided on it (2026-10-29). Evidence
// goes in the PR's changelog note; a second stamp line is a merge that kept both.
export const MAX_STAMP_LINE = 200;

export function manualStampProblems(text) {
  const stamps = text.split(/\r?\n/).filter((line) => /^\*{0,2}Last verified/.test(line));
  return [
    stamps.length > 1 ? `${stamps.length} "Last verified" lines; keep one` : '',
    ...stamps.filter((line) => line.length > MAX_STAMP_LINE)
      .map((line) => `"Last verified" line is ${line.length} characters (limit ${MAX_STAMP_LINE}); move the evidence to the PR's docs/changelog.d note`),
  ].filter(Boolean);
}

export function chicagoCalendarStamp(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}${value('month')}${value('day')}`;
}

export function manualFreshnessBoundary(newestMigrationDate, todayChicago) {
  if (!newestMigrationDate) return undefined;
  return newestMigrationDate > todayChicago ? todayChicago : newestMigrationDate;
}
