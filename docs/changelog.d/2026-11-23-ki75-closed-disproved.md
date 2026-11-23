## 2026-11-23 - KI-75 closed: the credit-memo apply race is disproved

- `KNOWN_ISSUES.md`: KI-75 (the "after-lock race in `apply_credit_memo_to_invoice`") is resolved as disproved. `check_idempotency` takes a per-key advisory transaction lock before reading, so concurrent calls with one key are serialized before any write.
- Evidence: a two-session test on a synthetic local database. Same key and arguments: the second call waits, then replays the first's application (one application). Same key with another target: refused with `IDEMPOTENCY_ARGUMENT_MISMATCH`.
- No code or SQL change.
