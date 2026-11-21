# Behavior contract: adjust_inventory refuses keys with any non-printable character (#1912)

Read at `origin/staging` b81667ddd, 2026-11-19.

## Outcome and authority

- **Result:** `adjust_inventory` refuses an idempotency key that contains any character outside printable ASCII (`!` to `~`), not only keys with no printable character at all. Fact: the current check (`20270113100000`, `p_idempotency_key COLLATE "C" !~ '[!-~]'`) needs just one printable character, so `'abc' || E'\n'` passes.
- **Smallest change:** one new migration re-emitting the `20270113100000` body with that one condition changed to `p_idempotency_key COLLATE "C" ~ '[^!-~]'` (and its comment). Files: `supabase/migrations/20270129110000_adjust_inventory_key_printable_only.sql`, its ledger records, this contract, `scripts/smoke/prove-adjust-inventory-key-real-schema.mjs`.
- **Who may act:** unchanged (active admin, actor bound to `auth.uid()`, `SECURITY DEFINER`, `search_path = public, pg_temp`, same grants). The new check still runs after the auth checks and before any receipt lookup.

## State and failure

- **Callers:** both app callers send generated keys: `InventoryPage.tsx` (`adjust_inventory:<user>:<uuid>`, `src/lib/idempotency.ts`) and `BatchAdjustModal.tsx` (`<batch key>:<inventory id>`). Every character is printable ASCII without spaces, so no app call changes. Fact from the code; the proof uses both shapes.
- **Existing rows:** no table or row changes. A stored receipt with an odd key can no longer be replayed through this function, which is correct: no app caller can produce such a key.
- **Timing / retry:** unchanged. Same key + same request replays the first answer under the advisory lock; the key check runs before replay, as before.
- **Space is now refused** (outside `!`-`~`), matching the issue's suggested fix; app keys never contain one.

## Delivery

Database-only, no screen change. Local commit only until release #1990 lands; then Sol (inventory + database path), a staging PR, and the normal migration-apply gates. Rollback: a new migration re-emitting the `20270113100000` body.

## Proof cases (local real-schema container, test data)

- When an app-shaped key or a batch row key is used, then stock moves by the delta, one ledger row and one receipt are written; the same key again returns the first answer and writes nothing.
- When the key contains a newline, tab, carriage return, control character, space, or non-ASCII letter, or is blank or NULL, then `IDEMPOTENCY_KEY_REQUIRED` is raised and nothing changes.
- When the migration is applied a second time, then the preflight refuses it.

No open business decisions. Cold challenge skipped: one-condition tightening with no authority, lifecycle or data change; Sol reviews before delivery.
