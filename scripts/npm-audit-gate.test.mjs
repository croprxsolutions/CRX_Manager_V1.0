#!/usr/bin/env node

import assert from 'node:assert/strict';
import { blockingAdvisories } from './npm-audit-gate.mjs';

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
const exceptions = { 'GHSA-fc5q-39xc-vjpf': '2026-12-31' };

assert.deepEqual(blockingAdvisories(report, '2026-11-17', exceptions), [], 'excepted high and moderate pass');
assert.deepEqual(blockingAdvisories(report, '2026-12-31', exceptions), [], 'exception holds on its last day');
assert.equal(blockingAdvisories(report, '2027-01-01', exceptions).length, 1, 'expired exception fails again');
assert.equal(blockingAdvisories(report, '2026-11-17', {}).length, 1, 'no exception: high fails');

const other = { vulnerabilities: { ...report.vulnerabilities, x: { via: [advisory('GHSA-aaaa-bbbb-cccc', 'critical', 'x')] } } };
assert.equal(blockingAdvisories(other, '2026-11-17', exceptions).length, 1, 'any other high/critical still fails');
assert.deepEqual(blockingAdvisories({}, '2026-11-17', exceptions), [], 'clean report passes');

console.log('npm-audit-gate tests passed');
