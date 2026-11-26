// @vitest-environment node
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Script } from 'node:vm';
import { readFileSync } from 'node:fs';
import handler from '../../api/maps-step0.mjs';

const host = 'staging.croprxsolutions.app';
const tilesKey = 'AIza' + 'a'.repeat(35);
const staticKey = 'AIza' + 'b'.repeat(35);

function run(request, settings = {}) {
  const original = {};
  const environment = {
    VERCEL_TARGET_ENV: 'staging',
    VERCEL_GIT_COMMIT_REF: 'staging',
    CRX_STEP0_GOOGLE_MAP_TILES_KEY: tilesKey,
    CRX_STEP0_GOOGLE_STATIC_MAPS_KEY: staticKey,
    ...settings,
  };
  for (const [name, value] of Object.entries(environment)) {
    original[name] = process.env[name];
    process.env[name] = value;
  }

  const result = { headers: {}, status: 0, body: '' };
  try {
    handler({ method: 'GET', headers: { host }, ...request }, {
      setHeader(name, value) { result.headers[name] = value; },
      status(code) { result.status = code; return this; },
      send(body) { result.body = body; },
      end() {},
    });
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return result;
}

test('exposes no probe or credentials on an off-host, off-branch or non-staging deployment', () => {
  for (const response of [
    run({ headers: { host: 'croprxsolutions.app' } }),
    run({ headers: { host: 'other.vercel.app' } }),
    run({}, { VERCEL_TARGET_ENV: 'production' }),
    run({}, { VERCEL_TARGET_ENV: 'preview' }),
    run({}, { VERCEL_GIT_COMMIT_REF: 'main' }),
  ]) {
    assert.equal(response.status, 404);
    assert.equal(response.body, '');
    assert.equal(response.headers['Cache-Control'], 'private, no-store');
    assert.doesNotMatch(response.headers['Content-Security-Policy'], /googleapis/);
  }
});

test('ties the staging-only policy to the diagnostic page nonce and limits the method', () => {
  const methodRejected = run({ method: 'POST' });
  assert.equal(methodRejected.status, 405);
  assert.equal(methodRejected.headers.Allow, 'GET');

  const result = run({});
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  assert.equal(result.headers['Content-Type'], 'text/html; charset=utf-8');
  const script = result.body.match(/<script nonce="([^"]+)">([\s\S]+)<\/script>/);
  assert.ok(script);
  assert.ok(result.headers['Content-Security-Policy'].includes("'nonce-" + script[1] + "'"));
  assert.match(result.headers['Content-Security-Policy'], /connect-src https:\/\/tile\.googleapis\.com https:\/\/maps\.googleapis\.com/);
  assert.ok(script[2].includes(tilesKey));
  assert.ok(script[2].includes(staticKey));
  assert.doesNotThrow(() => new Script(script[2]));
  assert.notEqual(run({}).headers['Content-Security-Policy'], result.headers['Content-Security-Policy']);
});

test('excludes malformed configuration from the browser document', () => {
  const malformed = '</script><script>alert(1)</script>';
  const result = run({}, { CRX_STEP0_GOOGLE_MAP_TILES_KEY: malformed });
  assert.ok(!result.body.includes(malformed));
  assert.ok(result.body.includes('"tilesKey":null'));
});

test('reserves only the probe route from the standard app rewrite and headers', () => {
  const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  for (const rule of [config.rewrites[0], config.headers[0]]) {
    const source = new RegExp('^' + rule.source + '$');
    for (const path of ['/', '/fields', '/maps-step0', '/api/maps-step01', '/api/maps-step0/other']) {
      assert.ok(source.test(path), path);
    }
    for (const path of ['/api/maps-step0', '/api/maps-step0/']) {
      assert.ok(!source.test(path), path);
    }
  }
});
