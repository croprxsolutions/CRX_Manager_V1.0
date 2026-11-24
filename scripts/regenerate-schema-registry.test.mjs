#!/usr/bin/env node
// Networkless checks for regenerate-schema-registry.mjs --live: every query is sent read-only,
// rows land under their input key, and anything other than a non-empty row array fails closed.
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';

const registryPath = new URL('../.claude/schema-registry.json', import.meta.url);
const registryMtime = statSync(registryPath).mtimeMs;
// Imported after the mtime read: a static import would run first and hide a write on import.
const { INTROSPECTION_QUERIES, PROJECTS, liveIntrospection, fetchTypes } = await import('./regenerate-schema-registry.mjs');

const sent = [];
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const urls = [];
const fakeFetch = (rowsFor) => async (url, init) => {
  urls.push(url);
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

// Default is live; --staging reads the staging project and nothing else.
assert(urls.slice(0, 6).every((u) => u === `https://api.supabase.com/v1/projects/${PROJECTS.live}/database/query`));
urls.length = 0;
await liveIntrospection({ token: 't', projectRef: PROJECTS.staging, fetchImpl: fakeFetch(() => reply(200, '[{"x":1}]')) });
assert.equal(urls.length, 6);
assert(urls.every((u) => u === 'https://api.supabase.com/v1/projects/fsnjredpmakbmhwowjjt/database/query'));

// Types: the staging project's public schema; anything but a types string fails closed.
let typesUrl;
const typesFetch = (status, body) => async (url) => { typesUrl = url; return reply(status, body); };
assert.equal(await fetchTypes({ token: 't', projectRef: PROJECTS.staging, fetchImpl: typesFetch(200, JSON.stringify({ types: 'export type Database = { public: {} }' })) }), 'export type Database = { public: {} }');
assert.equal(typesUrl, 'https://api.supabase.com/v1/projects/fsnjredpmakbmhwowjjt/types/typescript?included_schemas=public');
await assert.rejects(() => fetchTypes({ token: 't', fetchImpl: typesFetch(401, '{"message":"no"}') }), /HTTP 401/);
await assert.rejects(() => fetchTypes({ token: 't', fetchImpl: typesFetch(200, '{"types":""}') }), /types: HTTP 200/);
await assert.rejects(() => fetchTypes({ token: 't', fetchImpl: typesFetch(200, 'oops') }), /not JSON/);

// Importing the module must not run a mode (the old top-level code stamped the registry on import).
assert.equal(statSync(registryPath).mtimeMs, registryMtime, 'importing the module wrote the registry');
console.log('regenerate-schema-registry.test.mjs: ok');
