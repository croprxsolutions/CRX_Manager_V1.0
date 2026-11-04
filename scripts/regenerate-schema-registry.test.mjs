#!/usr/bin/env node
// Networkless checks for regenerate-schema-registry.mjs --live: every query is sent read-only,
// rows land under their input key, and anything other than a non-empty row array fails closed.
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';

const registryPath = new URL('../.claude/schema-registry.json', import.meta.url);
const registryMtime = statSync(registryPath).mtimeMs;
// Imported after the mtime read: a static import would run first and hide a write on import.
const { INTROSPECTION_QUERIES, liveIntrospection } = await import('./regenerate-schema-registry.mjs');

const sent = [];
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const fakeFetch = (rowsFor) => async (_url, init) => {
  const body = JSON.parse(init.body);
  sent.push(body);
  const key = Object.keys(INTROSPECTION_QUERIES).find((k) => INTROSPECTION_QUERIES[k] === body.query);
  return rowsFor(key);
};

const data = await liveIntrospection({ token: 't', fetchImpl: fakeFetch((key) => reply(201, JSON.stringify([{ key }]))) });
assert.deepEqual(Object.keys(data), Object.keys(INTROSPECTION_QUERIES));
for (const key of Object.keys(data)) assert.deepEqual(data[key], [{ key }]);
assert.equal(sent.length, 6);
assert(sent.every((body) => body.read_only === true), 'every query is sent read_only');

const fails = async (rowsFor, pattern) => assert.rejects(() => liveIntrospection({ token: 't', fetchImpl: fakeFetch(rowsFor) }), pattern);
await fails(() => reply(401, '{"message":"Unauthorized"}'), /HTTP 401/);
await fails(() => reply(200, 'not json'), /not JSON/);
await fails(() => reply(200, '{"rows":[]}'), /HTTP 200/);
await fails((key) => reply(200, key === 'columns' ? '[]' : '[{"x":1}]'), /columns: returned no rows/);
await fails((key) => reply(200, key === 'applied_names' ? '[]' : '[{"x":1}]'), /applied_names: returned no rows/);
// A schema with no generated columns is valid, not a failed read.
const noGenerated = await liveIntrospection({ token: 't', fetchImpl: fakeFetch((key) => reply(200, key === 'generated_columns' ? '[]' : '[{"x":1}]')) });
assert.deepEqual(noGenerated.generated_columns, []);

// Importing the module must not run a mode (the old top-level code stamped the registry on import).
assert.equal(statSync(registryPath).mtimeMs, registryMtime, 'importing the module wrote the registry');
console.log('regenerate-schema-registry.test.mjs: ok');
