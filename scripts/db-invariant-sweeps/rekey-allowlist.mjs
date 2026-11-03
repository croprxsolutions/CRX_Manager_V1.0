#!/usr/bin/env node
/**
 * Re-key reviewed allowlist entries whose fingerprint changed but whose signature did not.
 *
 * A `cost-exposure-review` key is `<signature>#<hash>`, and the hash covers every helper the
 * function reaches, so one migration that changes a shared helper re-flags every caller's
 * reviewed entry. After a human re-reads the changed chain live, this swaps each entry's key
 * and appends their dated note to its justification. It never queries live.
 *
 * Usage:
 *   npm run db-sweeps:live > sweep-output.txt
 *   node scripts/db-invariant-sweeps/rekey-allowlist.mjs sweep-output.txt --note "Re-read live <date> after ..."
 *     [--predicate cost-exposure-review] [--allowlist <path>]
 *
 * Refuses and writes nothing when the note is empty, when any violation of the predicate is not
 * exactly one existing same-signature entry (a new function must be reviewed, not auto-allowlisted),
 * or when the file would not round-trip to the same bytes. Exit 0 re-keyed, 1 refused.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ALLOWLIST = join(dirname(fileURLToPath(import.meta.url)), 'allowlist.json');

const signatureOf = (key) => (key.includes('#') ? key.slice(0, key.lastIndexOf('#')) : null);

/** The adjudicator's JSON verdict is the last thing `db-sweeps:live` prints. */
export function violationKeys(outputText, predicate) {
  const text = outputText.replace(/\r\n/g, '\n');
  const start = text.lastIndexOf('{\n  "ok":');
  if (start === -1) throw new Error('No adjudicator verdict (`{ "ok": ... }`) found in the sweep output.');
  const verdict = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
  const item = verdict.summary?.find((s) => s.predicate === predicate);
  if (!item) throw new Error(`The sweep output has no result for predicate ${predicate}.`);
  return item.violations.map((v) => v.violation_key);
}

/** Pure: the new file text, or a thrown refusal. */
export function rekey(allowlistText, keys, predicate, note) {
  if (typeof note !== 'string' || note.trim() === '') {
    throw new Error('A note is required: a key is never re-pasted without a human re-read of the changed chain.');
  }
  if (keys.length === 0) throw new Error(`No ${predicate} violations to re-key.`);
  const eol = allowlistText.includes('\r\n') ? '\r\n' : '\n';
  const serialize = (data) => JSON.stringify(data, null, 2).replace(/\n/g, eol) + (allowlistText.endsWith(eol) ? eol : '');
  const data = JSON.parse(allowlistText);
  if (serialize(data) !== allowlistText) {
    throw new Error('allowlist.json does not round-trip through 2-space JSON; re-keying would rewrite unrelated lines.');
  }
  const problems = [];
  const claimed = new Set();
  const changes = [];
  for (const key of keys) {
    const signature = signatureOf(key);
    const matches = signature === null ? [] : data.entries.filter((e) => e.predicate === predicate &&
      e.violation_key !== key && signatureOf(e.violation_key) === signature);
    if (matches.length !== 1) {
      problems.push(`${key}: ${matches.length === 0 ? 'no reviewed entry has this signature (a new function needs a review, not a re-key)' : `${matches.length} entries share this signature`}`);
    } else if (claimed.has(matches[0])) {
      problems.push(`${key}: another violation already re-keys the same entry`);
    } else {
      claimed.add(matches[0]);
      changes.push([matches[0], key, signature]);
    }
  }
  if (problems.length) throw new Error(`Refusing; nothing written:\n  ${problems.join('\n  ')}`);
  for (const [entry, key] of changes) {
    entry.violation_key = key;
    entry.justification = `${entry.justification} ${note.trim()}`;
  }
  return { text: serialize(data), signatures: changes.map(([, , signature]) => signature) };
}

function main(argv) {
  const args = { predicate: 'cost-exposure-review', allowlist: DEFAULT_ALLOWLIST };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i].match(/^--(note|predicate|allowlist)$/)?.[1];
    if (flag) args[flag] = argv[++i];
    else positional.push(argv[i]);
  }
  if (positional.length !== 1) throw new Error('Usage: rekey-allowlist.mjs <saved db-sweeps:live output> --note "<text>" [--predicate <name>] [--allowlist <path>]');
  const keys = violationKeys(readFileSync(positional[0], 'utf8'), args.predicate);
  const { text, signatures } = rekey(readFileSync(args.allowlist, 'utf8'), keys, args.predicate, args.note);
  writeFileSync(args.allowlist, text);
  console.log(`Re-keyed ${signatures.length} ${args.predicate} entr${signatures.length === 1 ? 'y' : 'ies'}:`);
  for (const signature of signatures) console.log(`  ${signature}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`rekey-allowlist: ${error.message}`);
    process.exitCode = 1;
  }
}
