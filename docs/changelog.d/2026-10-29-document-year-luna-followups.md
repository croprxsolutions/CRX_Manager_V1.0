## 2026-10-29 - Preserve numbering contracts and error details

Numbering preflight and postflight now also check the existing volatility, strictness, and parallel-execution settings, confirmed against the live catalog. The disposable proof includes those attributes in its before/after contract comparison. Quote-number allocation failures retain the server's error code, details, and hint in Sentry while still presenting the existing simple retry message to the user.
