import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const lanePath = process.platform === 'win32' ? root.toLowerCase() : root;
process.env.CRX_LOCAL_APP_PROFILE = 'screen-walk';
process.env.CRX_LOCAL_APP_LANE = createHash('sha256').update(lanePath).digest('hex').slice(0, 8);
const target = await import('../local-app/target.mjs');
const { localSql } = await import('../local-app/e2e/local-db.ts');
target.assertCleanEnvironment();
const raw = readFileSync(new URL(`../local-app/${target.STATE_FOLDER}/local.env`, import.meta.url), 'utf8');
const state = Object.fromEntries(raw.split(/\r?\n/).filter(line => line.includes('=') && !line.startsWith('#')).map(line => {
  const equals = line.indexOf('=');
  return [line.slice(0, equals), line.slice(equals + 1)];
}));
target.assertLocalState(state);

const signal = 'RECEIVING_EXCESS_NOTICE_PROOF_PASS';
assert.equal(localSql(readFileSync(new URL('./smoke-receiving-excess-notice.sql', import.meta.url), 'utf8')), signal);
process.stdout.write(`${signal}\n`);
