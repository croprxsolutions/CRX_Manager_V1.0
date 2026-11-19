## 2026-11-19 — adjust_inventory refuses idempotency keys with any non-printable character (#1912)

- New migration `20270129110000_adjust_inventory_key_printable_only.sql` (not applied live; record in `docs/reference/migrations.d/`).
- A manual stock adjustment's retry key is now refused if it holds any character outside `!` to `~` (newline, tab, control character, accented letter, and also the space, which is printable but deliberately refused). Before, one printable character was enough. App keys never contain these, so nothing changes for users.
- Proof: `node scripts/smoke/prove-adjust-inventory-key-real-schema.mjs` (local container, test data). Not verified on staging or live.
