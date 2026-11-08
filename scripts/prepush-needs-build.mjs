#!/usr/bin/env node
// Pre-push asks: does this push change anything the app type check or build reads?
// Reads git's pre-push ref lines on stdin and prints "build" or "skip". Any doubt
// prints "build", so a broken diff never skips the check. With --map it asks the same
// about the workflow map generator's inputs and prints "check" or "skip"; --pins asks it about migration
// SQL and records; --freshness asks it about migration SQL alone; --registry asks it about the schema registry and migration records. With --edge-tests it lists the vitest
// files that read a changed Edge Function folder's source. CI builds every PR either way
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

// Migration SQL and records: a CRLF sha256 pin in a record failed 4 CI checks (PR #1579).
export function needsPinCheck(paths) {
  return paths.some((file) => /^supabase\/migrations\/[^/]+\.sql$/.test(file)
    || /^docs\/reference\/(?:migrations\.d\/[^/]+\.md|migration-history\.md)$/.test(file));
}

// Migration SQL only: a migration dated today makes CI fail stale live-state doc stamps (PR #1652).
export function needsFreshnessCheck(paths) {
  return paths.some((file) => /^supabase\/migrations\/[^/]+\.sql$/.test(file));
}

// A registry refresh or a record flipped to APPLIED LIVE moves which migrations the contract tests
// discover; skipping that test cost a CI round three times (#1051, #1562, #1606; 2026-11-07 retro).
export function needsRegistryCheck(paths) {
  return paths.some((file) => file === '.claude/schema-registry.json'
    || /^docs\/reference\/migrations\.d\/[^/]+\.md$/.test(file));
}

// Edge Function folders touched by the push (_shared counts as a folder too).
export function changedEdgeFolders(paths) {
  return [...new Set(paths.map((f) => /^supabase\/functions\/([^/]+)\//.exec(f)?.[1]).filter(Boolean))];
}

// Vitest files whose text names a changed folder, as a path or as join(..., 'functions', 'name', ...).
// Source-reading tests break when a function's text changes (PR #1515 reached CI before anyone saw it).
// paths === null means the changed files are unknown: pick every test that names any function folder.
export function edgeSourceTests(paths, tests) {
  const folders = paths === null ? null : changedEdgeFolders(paths);
  if (folders && !folders.length) return [];
  const names = folders ? folders.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : '[\\w-]+';
  const mention = new RegExp(`functions['"/\\\\,\\s]+(?:${names})(?![\\w-])`);
  return tests.filter((t) => mention.test(t.text)).map((t) => t.path).sort();
}

function vitestFiles() {
  return execFileSync('git', ['ls-files', 'src/*.test.ts', 'src/*.test.tsx'], { encoding: 'utf8' })
    .split('\n').filter(Boolean).flatMap((path) => {
      try { return [{ path, text: readFileSync(path, 'utf8') }]; } catch { return []; } // deleted in the working tree
    });
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--edge-tests')) {
  // One test file per line; empty means nothing to run. Unknown changed files run every source-reading
  // test; only an unlistable test tree prints nothing (CI still runs everything).
  try {
    const refs = readFileSync(0, 'utf8');
    if (refs.trim()) {
      let paths = null;
      try { paths = changedPaths(refs); } catch { /* unknown: run them all */ }
      console.log(edgeSourceTests(paths, vitestFiles()).join('\n'));
    }
  } catch { /* nothing to run */ }
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = ['--map', '--pins', '--freshness', '--registry'].find((flag) => process.argv.includes(flag));
  const check = Boolean(mode);
  const needs = { '--map': needsMapCheck, '--pins': needsPinCheck, '--freshness': needsFreshnessCheck, '--registry': needsRegistryCheck }[mode] ?? needsAppBuild;
  let verdict = check ? 'check' : 'build';
  try {
    const refs = readFileSync(0, 'utf8');
    if (refs.trim() && !needs(changedPaths(refs))) verdict = 'skip';
  } catch { /* keep build */ }
  console.log(verdict);
}
