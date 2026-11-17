#!/usr/bin/env node

import assert from 'node:assert/strict';
import { advisoryIds, blockingAdvisories } from './npm-audit-gate.mjs';

const advisory = (id, severity, name = 'pkg') => ({
  name, severity, title: `${name} bug`, url: `https://github.com/advisories/${id}`,
});
const report = {
  vulnerabilities: {
    picomatch: { via: [advisory('GHSA-fc5q-39xc-vjpf', 'high', 'picomatch')] },
    vite: { via: ['picomatch', 'tinyglobby'] },
    minimatch: { via: [advisory('GHSA-g3hv-75wg-m249', 'moderate', 'minimatch')] },
  },
};
const exceptions = { 'GHSA-fc5q-39xc-vjpf': { until: '2026-12-31', package: 'picomatch', latestSeen: '4.0.7' } };
const same = (name) => (name === 'picomatch' ? '4.0.7' : null);
const devOnly = new Set();
const run = (r, day, ex = exceptions, latestOf = same, prod = devOnly) => blockingAdvisories(r, day, ex, latestOf, prod);

assert.deepEqual(run(report, '2026-11-17'), [], 'excepted high and moderate pass');
assert.deepEqual(run(report, '2026-12-31'), [], 'exception holds on its last day');
assert.equal(run(report, '2027-01-01').length, 1, 'expired exception fails again');
assert.equal(run(report, '2026-11-17', {}).length, 1, 'no exception: high fails');

// Sol HIGH (2026-11-17): a published fix must end the exception before its date.
assert.equal(run(report, '2026-11-17', exceptions, () => '4.0.8').length, 1, 'a newer picomatch release ends the exception');
assert.equal(run(report, '2026-11-17', exceptions, () => null).length, 1, 'unknown latest version fails closed');
assert.equal(blockingAdvisories(report, '2026-11-17', exceptions).length, 1, 'default latestOf is unknown: fails closed');
const fixed = (fixAvailable) => ({ vulnerabilities: { picomatch: { ...report.vulnerabilities.picomatch, name: 'picomatch', fixAvailable } } });
assert.equal(run(fixed({ name: 'picomatch', version: '4.0.8', isSemVerMajor: false }), '2026-11-17').length, 1, 'npm direct fix ends the exception');
assert.equal(run(fixed(true), '2026-11-17').length, 1, 'fixAvailable true ends the exception');
assert.deepEqual(run(fixed({ name: 'vitest', version: '3.1.4', isSemVerMajor: true }), '2026-11-17'), [], 'a breaking downgrade of another package is not a fix');

// Sol HIGH (2026-11-17, second run): reaching production dependencies ends it too.
assert.equal(run(report, '2026-11-17', exceptions, same, new Set(['GHSA-fc5q-39xc-vjpf'])).length, 1, 'excepted advisory in the production audit fails');
assert.equal(run(report, '2026-11-17', exceptions, same, null).length, 1, 'unknown production audit fails closed');
assert.deepEqual([...advisoryIds(report)].sort(), ['GHSA-fc5q-39xc-vjpf', 'GHSA-g3hv-75wg-m249'], 'advisoryIds reads object vias only');

const other = { vulnerabilities: { ...report.vulnerabilities, x: { via: [advisory('GHSA-aaaa-bbbb-cccc', 'critical', 'x')] } } };
assert.equal(run(other, '2026-11-17').length, 1, 'any other high/critical still fails');
assert.deepEqual(run({}, '2026-11-17'), [], 'clean report passes');

console.log('npm-audit-gate tests passed');
