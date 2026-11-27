import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const lanePath = process.platform === 'win32' ? root.toLowerCase() : root;
process.env.CRX_LOCAL_APP_PROFILE = 'screen-walk';
process.env.CRX_LOCAL_APP_LANE = createHash('sha256').update(lanePath).digest('hex').slice(0, 8);
const { localSql } = await import('./e2e/local-db.ts');

const expected = 'LOCAL_REBATE_BILLED_CUSTOMERS_PASS';
const sql = readFileSync(new URL('./rebate-billed-customers-proof.sql', import.meta.url), 'utf8');
assert.equal(localSql(sql), expected);
console.log(expected);
