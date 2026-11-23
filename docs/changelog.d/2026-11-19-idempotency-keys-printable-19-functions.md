## 2026-11-19 — 19 more functions refuse idempotency keys with any non-printable character (#1912 follow-up)

- New migration `20270224220000_idempotency_keys_printable_only.sql` (not applied live; record in `docs/reference/migrations.d/`).
- The same retry-key fix made to stock adjustments now covers returns, commission payments, vendor bills and payments, receiving reversals, inventory holds and customer document removal. A key with a newline, tab, control character, space or accented letter is refused. App keys never contain these, so nothing changes for users.
- Proof: `node scripts/smoke/prove-adjust-inventory-key-real-schema.mjs` (local container, test data): all 20 functions refuse the bad key and accept a normal one. Not verified on staging or live.

Last verified stamps in CURRENT_STATE.md and KNOWN_ISSUES.md bumped to 2026-11-23 after a read-only live ledger read that day: latest live row still `20261121061349`.

Apply requirement: run the migration in a quiet window with no app traffic (Mason, 2026-11-23); the in-flight-at-cutover leftover risk is accepted. See the migration record.
