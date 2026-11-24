# Behavior contract: adjust_inventory refuses keys with any non-printable character (#1912)

Read at `origin/staging` b81667ddd, 2026-11-19.

## Outcome and authority

- **Result:** `adjust_inventory` refuses an idempotency key that contains any character outside printable ASCII (`!` to `~`), not only keys with no printable character at all. Fact: the current check (`20270113100000`, `p_idempotency_key COLLATE "C" !~ '[!-~]'`) needs just one printable character, so `'abc' || E'\n'` passes.
- **Smallest change:** one new migration re-emitting the `20270113100000` body with that one condition changed to `p_idempotency_key COLLATE "C" ~ '[^!-~]'` (and its comment). Files: `supabase/migrations/20270201140000_adjust_inventory_key_printable_only.sql`, its ledger records, this contract, `scripts/smoke/prove-adjust-inventory-key-real-schema.mjs`.
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

## Follow-up (Mason, 2026-11-19: "fix the other 15 functions with the same check")

- **Scope:** a database replayed from `origin/staging` plus `20270201140000` shows 19 more public functions whose current body holds the weak check (the "15" was a count of migration files). Migration `20270228160000_idempotency_keys_printable_only.sql` makes the same one-condition swap in each, generated from `pg_get_functiondef`. Each held the check exactly once, as `IF p_idempotency_key IS NULL OR ... OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN RAISE 'IDEMPOTENCY_KEY_REQUIRED ...'`.
- **Callers:** every app key comes from `generateIdempotencyKey` (`<operation>:<user>:<uuid>`), the intent hooks (`<tab uuid>:<uuid>`) or those keys plus record ids; all printable ASCII without spaces. No app call changes.
- **Money paths touched** (validation only, no amount, status or row logic): vendor bills/payments, commission payments, return credits. Taha has no open PRs (checked 2026-11-19); his billing/invoice ownership through 2026-12-15 should see this before the PR.
- **Sweep allowlist:** `cost-exposure-review` keys hash each function and the helpers it reaches, so entries whose chain reaches a changed body are re-keyed from the replayed database (they show until the migration is applied).
- **Proof cases:** no public function keeps the weak check; each of the 20 functions refuses a newline key with `IDEMPOTENCY_KEY_REQUIRED` and lets a normal key past the key check; a second apply is refused.
