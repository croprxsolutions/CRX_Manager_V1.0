## 2026-11-03 - Pushes run the code-health check

From the 2026-11-03 retro (PR #1346 session). `.husky/pre-push` now runs `npm run check:code-health` between typecheck and build, and blocks the push if it fails. On PR #1346, three unused exports failed only in CI. Because those files are on the Sol list, fixing them cost a fresh Luna and Sol round. The check takes about 20 seconds locally. CI is unchanged.

Tests: `scripts/supplier-pricing-phase3-private-artifacts.test.mjs` now checks that pre-push keeps one fail-closed code-health guard, and that a failing code-health run blocks the push.
