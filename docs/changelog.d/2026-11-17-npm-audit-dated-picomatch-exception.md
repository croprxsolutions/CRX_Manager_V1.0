## 2026-11-17 — dependency audit: dated exception for one advisory with no fix anywhere

The required "Check for vulnerable dependencies" step went red on `staging` and every PR into it.
The only **high** advisory is picomatch GHSA-fc5q-39xc-vjpf (ReDoS): every published picomatch
(`<= 4.0.7`, the latest) is affected and GitHub lists no patched version, so no bump, `npm audit fix`
or `overrides` entry can clear it. picomatch is build/test tooling only (vite, vitest, knip, rollup
plugins); `npm audit --omit=dev --audit-level=high` passes.

On Mason's approval (2026-11-17) the step now runs `scripts/npm-audit-gate.mjs`: the same
high/critical bar, except this single advisory until **2026-12-31**. Any other high or critical
advisory still fails, and this one fails again after its date. `scripts/npm-audit-gate.test.mjs`
runs first in the same step. The moderate minimatch and glob advisories (fixes exist) are unchanged
by this and still pass the high bar as before; Dependabot bumps them.

Rule kept from 2026-09-02: never add an exception for an advisory that has a fix. Bump instead.
