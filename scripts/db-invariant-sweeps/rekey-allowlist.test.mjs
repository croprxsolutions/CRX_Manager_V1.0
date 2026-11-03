#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'rekey-allowlist.mjs');
// The real file (CRLF in a Windows checkout, LF elsewhere) so the byte checks cover what is shipped.
const original = readFileSync(path.join(here, 'allowlist.json'), 'utf8');
const costEntries = JSON.parse(original).entries.filter((e) => e.predicate === 'cost-exposure-review');
const NOTE = 'Re-read live 2026-11-03 after test (PR #0, ledger 0): nothing reads cost.';
const rehash = (key) => `${key.slice(0, key.lastIndexOf('#'))}#000000000000`;

function sweepOutput(keys) {
  const verdict = { ok: false, complete: true, execution: 'captured-results-only', summary: [
    { predicate: 'cost-exposure-review', status: 'FAIL', total_rows: keys.length, allowlisted: 0,
      violations: keys.map((violation_key) => ({ violation_key })) },
  ] };
  return `captured  1/31  cost-exposure-review\n\nSaved 31 packets.\n\n${JSON.stringify(verdict, null, 2)}\n`;
}

function run(keys, ...extra) {
  const dir = mkdtempSync(path.join(tmpdir(), 'crx-rekey-'));
  try {
    const allowlist = path.join(dir, 'allowlist.json');
    const output = path.join(dir, 'out.txt');
    writeFileSync(allowlist, original);
    writeFileSync(output, sweepOutput(keys));
    const result = spawnSync(process.execPath, [script, output, '--allowlist', allowlist, ...extra], { encoding: 'utf8' });
    return { ...result, after: readFileSync(allowlist, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a same-signature re-key changes only those entries', () => {
  const targets = [costEntries[0], costEntries[5]];
  const r = run(targets.map((e) => rehash(e.violation_key)), '--note', NOTE);
  assert.equal(r.status, 0, r.stderr);
  for (const e of targets) assert.match(r.stdout, new RegExp(`  ${e.violation_key.slice(0, 20).replace(/[()]/g, '\\$&')}`));
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const before = original.split(eol);
  const after = r.after.split(eol);
  assert.equal(after.length, before.length, 'same line count and line endings');
  const changed = before.flatMap((line, i) => (line === after[i] ? [] : [i]));
  assert.equal(changed.length, 4, 'two lines (key + justification) per re-keyed entry');
  const data = JSON.parse(r.after);
  for (const e of targets) {
    const updated = data.entries.find((x) => x.violation_key === rehash(e.violation_key));
    assert.equal(updated.justification, `${e.justification} ${NOTE}`);
    assert.equal(updated.dated, e.dated);
  }
});

test('a new signature refuses and leaves the file byte-identical', () => {
  const r = run([rehash(costEntries[0].violation_key), 'brand_new_fn(p_x uuid)#abcdefabcdef'], '--note', NOTE);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /brand_new_fn.*needs a review/);
  assert.equal(r.after, original);
});

test('a violation that is an existing key (not a re-key) refuses', () => {
  const r = run([costEntries[0].violation_key], '--note', NOTE);
  assert.equal(r.status, 1);
  assert.equal(r.after, original);
});

test('a signature shared by two entries refuses', () => {
  const dupe = { ...costEntries[0], violation_key: rehash(costEntries[0].violation_key).replace(/0+$/, '111111111111') };
  const data = JSON.parse(original);
  data.entries.push(dupe);
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const withDupe = JSON.stringify(data, null, 2).replace(/\n/g, eol) + eol;
  const dir = mkdtempSync(path.join(tmpdir(), 'crx-rekey-'));
  try {
    const allowlist = path.join(dir, 'allowlist.json');
    const output = path.join(dir, 'out.txt');
    writeFileSync(allowlist, withDupe);
    writeFileSync(output, sweepOutput([rehash(costEntries[0].violation_key).replace(/0+$/, '222222222222')]));
    const r = spawnSync(process.execPath, [script, output, '--allowlist', allowlist, '--note', NOTE], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /2 entries share this signature/);
    assert.equal(readFileSync(allowlist, 'utf8'), withDupe);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty or missing note refuses', () => {
  for (const extra of [['--note', '   '], []]) {
    const r = run([rehash(costEntries[0].violation_key)], ...extra);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /note is required/);
    assert.equal(r.after, original);
  }
});
