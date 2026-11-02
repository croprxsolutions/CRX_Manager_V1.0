import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { guardCommands, runAll } from './run-correction-guards.mjs';

const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const chain = scripts['test:correction-guards'];
assert.equal(guardCommands(chain).length, chain.split('&&').length, 'every chained suite is kept');
assert.deepEqual(guardCommands('node a.mjs &&node b.mjs&& node c.mjs'), ['node a.mjs', 'node b.mjs', 'node c.mjs']);
for (const unsupported of ['npm run other', 'node a.mjs || node b.mjs', 'node a.mjs --flag', '']) {
  assert.throws(() => guardCommands(unsupported), /Unsupported guard command/, unsupported);
}

const temp = mkdtempSync(path.join(tmpdir(), 'run-correction-guards-'));
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
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log('run-correction-guards tests passed');
