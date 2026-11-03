import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { guardCommands, runAll } from './run-correction-guards.mjs';
import { tempDir } from './lib/test-temp-dir.mjs';

const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const chain = scripts['test:correction-guards'];
assert.equal(guardCommands(chain).length, chain.split('&&').length, 'every chained suite is kept');
assert.deepEqual(guardCommands('node a.mjs &&node b.mjs&& node c.mjs'), ['node a.mjs', 'node b.mjs', 'node c.mjs']);
for (const unsupported of ['npm run other', 'node a.mjs || node b.mjs', 'node a.mjs --flag', '']) {
  assert.throws(() => guardCommands(unsupported), /Unsupported guard command/, unsupported);
}

const temp = tempDir('run-correction-guards-');
try {
  writeFileSync(path.join(temp, 'pass.mjs'), "console.log('notice on success');\n");
  writeFileSync(path.join(temp, 'fail.mjs'), "console.error('fail detail'); process.exit(3);\n");
  const lines = [];
  const failures = await runAll(['node fail.mjs', 'node pass.mjs', 'node pass.mjs'], { cwd: temp, concurrency: 2, log: (line) => lines.push(line) });
  assert.deepEqual(failures, ['node fail.mjs'], 'a failure is reported and the rest still run');
  assert.equal(lines.filter((line) => line.startsWith('ok ')).length, 2);
  assert(lines.some((line) => line.startsWith('FAIL') && line.includes('fail detail')), 'a failure shows its output');
  assert(lines.some((line) => line.startsWith('ok ') && line.includes('notice on success')), 'a pass shows its output');
  assert.deepEqual(await runAll(['node missing.mjs'], { cwd: temp, log: () => {} }), ['node missing.mjs'], 'a missing suite fails');

  writeFileSync(path.join(temp, 'leak.mjs'), "import { mkdtempSync } from 'node:fs'; import os from 'node:os'; import path from 'node:path'; mkdtempSync(path.join(os.tmpdir(), 'crx-leak-'));\n");
  writeFileSync(path.join(temp, 'tidy.mjs'), "import { tempDir } from " + JSON.stringify(new URL('./lib/test-temp-dir.mjs', import.meta.url).href) + "; tempDir('crx-tidy-');\n");
  const leakLines = [];
  assert.deepEqual(await runAll(['node leak.mjs', 'node tidy.mjs'], { cwd: temp, log: (line) => leakLines.push(line) }), ['node leak.mjs'],
    'a passing suite that leaves a temp folder behind fails; one that cleans up passes');
  assert(leakLines.some((line) => line.includes('left 1 temp folder(s) behind: crx-leak-')), 'the leftover is named');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log('run-correction-guards tests passed');
