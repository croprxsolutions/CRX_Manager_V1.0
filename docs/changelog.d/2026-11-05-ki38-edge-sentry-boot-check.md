## 2026-11-05 — Edge Functions flag a missing Sentry key at startup (KI-38)

- All eight Edge Functions now call `warnIfSentryMisconfigured()` from `_shared/sentry.ts` at
  module load. A missing or malformed `SENTRY_DSN` writes an ERROR-level `[SENTRY_MISCONFIG]`
  line on every cold start instead of only when an error is captured. It never throws, so the
  function's real work (sending email, creating users) is not blocked by an alerting gap.
- Removed the unused `validateSentryDsnOrThrow()` (it echoed the first characters of the key in
  its message). New test `src/lib/edgeSentryBootCheck.test.ts` covers the three key states and
  fails if any function skips the check.
- Live `SENTRY_DSN` confirmed present by name. Takes effect only as each function is redeployed.
