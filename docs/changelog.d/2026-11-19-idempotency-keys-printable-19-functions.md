## 2026-11-19 — 19 more functions refuse idempotency keys with any non-printable character (#1912 follow-up)

- New migration `20270201150000_idempotency_keys_printable_only.sql` (not applied live; record in `docs/reference/migrations.d/`).
- The same retry-key fix made to stock adjustments now covers returns, commission payments, vendor bills and payments, receiving reversals, inventory holds and customer document removal. A key with a newline, tab, control character, space or accented letter is refused. App keys never contain these, so nothing changes for users.
- Proof: `node scripts/smoke/prove-adjust-inventory-key-real-schema.mjs` (local container, test data): all 20 functions refuse the bad key and accept a normal one. Not verified on staging or live.
