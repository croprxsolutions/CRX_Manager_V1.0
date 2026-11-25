#!/usr/bin/env node
// Offline half of target.test.mjs, as a plain `node path.mjs` so run-correction-guards.mjs accepts it in CI.
// The skipped block needs a running Docker; the live screen walkthrough covers it.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const test = fileURLToPath(new URL('./target.test.mjs', import.meta.url));
const { status } = spawnSync(process.execPath, ['--test', '--test-skip-pattern=every command refuses before it changes anything', test], { stdio: 'inherit' });
process.exit(status ?? 1);
