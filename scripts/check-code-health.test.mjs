import assert from 'node:assert/strict';
import {
  findImprovements,
  findRegressions,
  isCheckedSourceFile,
  summarizeSizeResults,
  summarizeUnusedResults,
} from './check-code-health-lib.mjs';

const ROOT = 'C:\\repo';

const complexity = (name) => ({ ruleId: 'complexity', message: `${name} has a complexity of 21. Maximum allowed is 20.` });
assert.deepEqual(
  summarizeSizeResults(ROOT, [
    {
      filePath: 'C:\\repo\\src\\pages\\Big.tsx',
      messages: [
        complexity("Function 'Big'"),
        complexity('Arrow function'),
        complexity('Arrow function'),
        { ruleId: 'max-depth', message: 'Blocks are nested too deeply (5). Maximum allowed is 4.' },
        { ruleId: 'no-console', message: 'Unexpected console statement.' },
      ],
    },
    { filePath: 'C:\\repo\\src\\pages\\Big.test.tsx', messages: [complexity("Function 'x'")] },
    { filePath: 'C:\\repo\\src\\legacy\\old.test.js', messages: [complexity("Function 'x'")] },
    { filePath: 'C:\\repo\\src\\types\\supabase.ts', messages: [{ ruleId: 'max-lines', message: 'File has too many lines (9000).' }] },
  ]),
  {
    'src/pages/Big.tsx': {
      "complexity Function 'Big'": 1,
      'complexity Arrow function': 2,
      'max-depth': 1,
    },
  },
  'findings are keyed by rule and named function, ignore unrelated rules, and skip tests and type catalogs',
);
assert.throws(
  () => summarizeSizeResults(ROOT, [{ filePath: 'C:\\repo\\src\\a.ts', messages: [{ fatal: true, message: 'bad' }] }]),
  /could not parse/,
  'a file ESLint cannot parse fails closed instead of passing unmeasured',
);
assert.equal(isCheckedSourceFile('src/lib/money.ts'), true);
assert.equal(isCheckedSourceFile('scripts/x.mjs'), false);

assert.deepEqual(
  summarizeUnusedResults({
    files: ['src\\lib\\orphan.ts'],
    issues: [{ file: 'src/lib/a.ts', exports: { foo: { name: 'foo' } }, types: [{ name: 'Bar' }], duplicates: [[{ name: 'x' }, { name: 'y' }]] }],
  }),
  { 'src/lib/a.ts': ['duplicate:x|y', 'export:foo', 'type:Bar'], 'src/lib/orphan.ts': ['file'] },
  'Knip findings become stable per-file labels',
);
assert.throws(() => summarizeUnusedResults({}), /no issues list/, 'an unreadable Knip report fails closed');

const OLD = "complexity Function 'Old'";
const baseline = {
  size: { 'src/pages/Big.tsx': { [OLD]: 1, 'max-depth': 2 } },
  unused: { 'src/lib/a.ts': ['export:foo'] },
};
assert.deepEqual(findRegressions(baseline, baseline), [], 'the baseline itself passes');
assert.deepEqual(
  findRegressions(baseline, {
    size: { 'src/pages/Big.tsx': { 'max-depth': 3 }, 'src/pages/New.tsx': { 'max-depth': 1 } },
    unused: { 'src/lib/a.ts': ['export:foo', 'export:bar'] },
  }),
  [
    'src/pages/Big.tsx: max-depth — 3 found, baseline allows 2',
    'src/pages/New.tsx: max-depth — 1 found, baseline allows 0',
    'src/lib/a.ts: unused export:bar',
  ],
  'a grandfathered file cannot gain violations, a new file gets none, and new unused exports fail',
);
assert.deepEqual(
  findRegressions(baseline, {
    size: { 'src/pages/Big.tsx': { "complexity Function 'New'": 1, 'max-depth': 2 } },
    unused: {},
  }),
  ["src/pages/Big.tsx: complexity Function 'New' — 1 found, baseline allows 0"],
  'fixing one grandfathered function does not make room for a different new one',
);
assert.deepEqual(
  findImprovements(baseline, { size: { 'src/pages/Big.tsx': { 'max-depth': 1 } }, unused: {} }),
  [
    `src/pages/Big.tsx: ${OLD} 1 -> 0`,
    'src/pages/Big.tsx: max-depth 2 -> 1',
    'src/lib/a.ts: unused export:foo is gone',
  ],
  'fixed debt is reported so the baseline can shrink',
);

console.log('PASS - code-health ratchet blocks new debt and only lets the baseline shrink.');
