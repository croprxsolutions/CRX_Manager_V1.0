#!/usr/bin/env node
// Pre-push asks: does this push change anything the app type check or build reads?
// Reads git's pre-push ref lines on stdin and prints "build" or "skip". Any doubt
// prints "build", so a broken diff never skips the check. With --map it asks the same
// about the workflow map generator's inputs and prints "check" or "skip". CI builds every PR either way
// (2026-11-03 retro: three scripts/docs pushes spent ~13 minutes rebuilding the app).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_FILES = new Set(['index.html', 'vite.config.ts', 'package.json', 'package-lock.json', '.nvmrc', 'vercel.json']);

export function needsAppBuild(paths) {
  return paths.some((file) => file.startsWith('src/') || file.startsWith('public/')
    || /^tsconfig[^/]*\.json$/.test(file) || APP_FILES.has(file));
}

// Everything scripts/generate-workflow-map.mjs reads, plus the generator itself.
const MAP_FILES = new Set(['docs/app-workflow-map.html', 'docs/reference/rpc-functions.md', 'scripts/generate-workflow-map.mjs']);

export function needsMapCheck(paths) {
  return paths.some((file) => file.startsWith('src/') || MAP_FILES.has(file));
}

function changedPaths(refLines) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const zero = /^0+$/;
  const paths = [];
  for (const line of refLines.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [, localSha, , remoteSha] = line.split(/\s+/);
    if (!localSha || zero.test(localSha)) continue; // branch delete: nothing to build
    let base;
    try { base = !zero.test(remoteSha) && git('cat-file', '-t', remoteSha) === 'commit' ? remoteSha : null; } catch { base = null; }
    base ??= git('merge-base', localSha, 'origin/main');
    paths.push(...git('diff', '--name-only', '--no-renames', base, localSha).split('\n').filter(Boolean));
  }
  return paths;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const map = process.argv.includes('--map');
  let verdict = map ? 'check' : 'build';
  try {
    const refs = readFileSync(0, 'utf8');
    if (refs.trim() && !(map ? needsMapCheck : needsAppBuild)(changedPaths(refs))) verdict = 'skip';
  } catch { /* keep build */ }
  console.log(verdict);
}
