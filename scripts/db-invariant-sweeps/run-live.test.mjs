#!/usr/bin/env node
// Networkless checks for run-live.mjs: query extraction, refusal, packet capture and token decoding.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeTokenBlob, extractQueries, packetFrom } from './run-live.mjs';

const runner = fileURLToPath(new URL('./run-sweeps.mjs', import.meta.url));
const printed = spawnSync(process.execPath, [runner], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SUPABASE_DB_URL: '' } });
assert.equal(printed.status, 0, printed.stderr);
// Predicate files checked out with CRLF print CRLF; extractQueries normalizes the same way.
const out = printed.stdout.replace(/\r\n/g, '\n');
const listed = spawnSync(process.execPath, [runner, '--list'], { encoding: 'utf8' }).stdout.match(/Discovered (\d+) predicate/)[1];

// Every printed predicate is extracted, in order, and passes the guard.
const queries = extractQueries(out);
assert.equal(queries.length, Number(listed));
assert.equal(extractQueries(out.replace(/\n/g, '\r\n')).length, queries.length, 'CRLF output still parses');
const first = queries[0];

// Refusal: any edit to a query, a missing tail, or no queries at all stops the run.
const edited = out.replace(first.query, () => first.query.replace('violation_key', 'violation_kEy'));
assert.throws(() => extractQueries(edited), /Refusing .*not a known sweep query/);
const headless = out.replace(first.query, () => first.query.replace('SELECT', 'SELECT  '));
assert.throws(() => extractQueries(headless), /predicates but \d+ queries/);
const renamed = out.replace(first.query, () => first.query.replace(`'predicate', '${first.name}'`, `'predicate', '${queries[1].name}'`));
assert.throws(() => extractQueries(renamed), /not a known sweep query/);
assert.throws(() => extractQueries(out.replace(/\n\) AS sweep_result;/g, '')), /no closing/);
assert.throws(() => extractQueries('nothing here'), /no wrapped queries/);
assert.throws(() => extractQueries(`┌─ PREDICATE: a\n${first.query}\n┌─ PREDICATE: b\n${first.query}`), /twice/);

// Capture: the packet is kept exactly as returned; anything else fails closed.
const packet = { predicate: first.name, rows: [{ violation_key: 'x' }], function_contracts: [] };
assert.deepEqual(packetFrom(first.name, 201, JSON.stringify([{ sweep_result: packet }])), packet);
assert.throws(() => packetFrom(first.name, 401, '{"message":"Unauthorized"}'), /HTTP 401/);
assert.throws(() => packetFrom(first.name, 200, 'not json'), /not JSON/);
assert.throws(() => packetFrom(first.name, 200, '[]'), /exactly one sweep_result/);
assert.throws(() => packetFrom(first.name, 200, JSON.stringify([{ sweep_result: packet }, { sweep_result: packet }])), /exactly one/);
assert.throws(() => packetFrom('other', 200, JSON.stringify([{ sweep_result: packet }])), /for this predicate/);

// Token: UTF-8, UTF-16LE and go-keyring forms decode; a non-token never echoes its value.
const token = `sbp_${'a1_'.repeat(10)}`;
const b64 = (text, enc = 'utf8') => Buffer.from(text, enc).toString('base64');
assert.equal(decodeTokenBlob(b64(token)), token);
assert.equal(decodeTokenBlob(b64(token, 'utf16le')), token);
assert.equal(decodeTokenBlob(b64(`go-keyring-base64:${b64(token)}`)), token);
assert.throws(() => decodeTokenBlob(b64('secret-not-a-token')), (error) => !error.message.includes('secret'));

console.log(`run-live.test.mjs: ok (${queries.length} queries)`);
