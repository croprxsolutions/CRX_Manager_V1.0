import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// fetchAllRows only checks a paged read against the server's row count when
// each page carries `count`, i.e. when the query selects with
// `{ count: 'exact' }`. Without it the check is skipped silently and a list
// that changed mid-read can come back short. Every paged read on a page must
// therefore request the count.

const PAGES_DIR = join(__dirname, '..', 'pages');

// Files not checked yet, each with its reason.
const EXEMPT: Record<string, string> = {
  'Reports.tsx': 'open PRs #954/#955/#957 change this file; Goal 4 follow-up',
  'SalesReports.tsx': 'open PRs #954/#955/#957 change this file; Goal 4 follow-up',
  'Deliveries.tsx': 'open PRs #954/#955/#957 change this file; Goal 4 follow-up',
};

const CALL_PATTERN = /\bfetchAllRows(?:ForIds)?\s*(?:<[^()]*?>)?\s*\(/g;

type CallSite = { file: string; line: number; callback: string };

function findCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of readdirSync(PAGES_DIR).sort()) {
    if (!file.endsWith('.tsx') || file.endsWith('.test.tsx') || file in EXEMPT) continue;
    const source = readFileSync(join(PAGES_DIR, file), 'utf8');
    const starts = [...source.matchAll(CALL_PATTERN)].map((m) => m.index ?? 0);
    starts.forEach((start, i) => {
      const nextCall = i + 1 < starts.length ? starts[i + 1] : source.length;
      const rangeAt = source.indexOf('.range(', start);
      const line = source.slice(0, start).split('\n').length;
      // The callback's `.range(` must come before the next paged call; otherwise
      // a later query's count could mask this one, so record nothing and fail.
      const ownsRange = rangeAt !== -1 && rangeAt < nextCall;
      sites.push({ file, line, callback: ownsRange ? source.slice(start, rangeAt) : '' });
    });
  }
  return sites;
}

describe('paged list reads request the exact row count', () => {
  const sites = findCallSites();

  it('finds the paged reads (a pattern that matches nothing must fail)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(20);
  });

  it("every fetchAllRows / fetchAllRowsForIds call selects with { count: 'exact' }", () => {
    const offenders = sites
      .filter((site) => !site.callback.includes("count: 'exact'"))
      .map((site) => `src/pages/${site.file}:${site.line}`);
    expect(offenders, `paged reads without { count: 'exact' }:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every exempt file still exists (drop the entry once the file is covered)', () => {
    const files = new Set(readdirSync(PAGES_DIR));
    for (const file of Object.keys(EXEMPT)) expect(files.has(file), file).toBe(true);
  });
});
