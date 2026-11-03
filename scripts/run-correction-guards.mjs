#!/usr/bin/env node
// Runs every command in package.json's `test:correction-guards` chain side by
// side, so CI gets the same suite without a second list that can drift from it.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { removeTree } from './lib/test-temp-dir.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Half a 4-core runner. Several suites assert their own wall-clock speed to catch
// catastrophic backtracking; at 4 at once, guards.test.mjs missed its 3s limit in CI.
const DEFAULT_CONCURRENCY = 2;

export function guardCommands(script) {
  const commands = script.split('&&').map((command) => command.trim());
  for (const command of commands) {
    // Refuses anything the split cannot run faithfully, rather than dropping a suite.
    if (!/^node [\w./-]+\.mjs$/.test(command)) throw new Error(`Unsupported guard command: ${command}`);
  }
  return commands;
}

export async function runAll(commands, { cwd = REPO_ROOT, concurrency = DEFAULT_CONCURRENCY, log = console.log } = {}) {
  const queue = [...commands];
  const failures = [];
  const worker = async () => {
    for (let command = queue.shift(); command; command = queue.shift()) {
      const started = Date.now();
      // Each suite gets its own temp folder, so anything it fails to clean up is caught here.
      const temp = mkdtempSync(path.join(os.tmpdir(), 'crx-guard-suite-'));
      const env = { ...process.env, TMP: temp, TEMP: temp, TMPDIR: temp };
      let { code, output } = await new Promise((resolve) => {
        const child = spawn(process.execPath, [command.slice('node '.length)], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', (error) => resolve({ code: 1, output: `${output}${error.message}\n` }));
        child.on('close', (code) => resolve({ code, output }));
      });
      const leftovers = readdirSync(temp);
      removeTree(temp);
      if (leftovers.length > 0) {
        code ||= 1;
        output += `left ${leftovers.length} temp folder(s) behind: ${leftovers.slice(0, 10).join(', ')}\n`;
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0) {
        // A passing suite can still warn, e.g. "no 8.3 aliases on this volume" on Windows.
        log(`ok   ${seconds}s ${command}\n${output}`);
      } else {
        failures.push(command);
        log(`FAIL ${seconds}s ${command}\n${output}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { scripts } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  // Another chain (e.g. test:agent-workflows) runs one suite at a time, in its written order.
  const chain = process.argv[2];
  const commands = guardCommands(scripts[chain || 'test:correction-guards']);
  const failures = await runAll(commands, chain ? { concurrency: 1 } : {});
  console.log(`${commands.length - failures.length} of ${commands.length} guard suites passed`);
  if (failures.length > 0) process.exitCode = 1;
}
