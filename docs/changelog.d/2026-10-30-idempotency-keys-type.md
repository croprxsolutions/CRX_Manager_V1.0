## 2026-10-30 — A shared type for the retry-key table (KI-83)

- KI-83: `idempotency_keys` (where database functions record each retry key and its first answer)
  had no interface in `src/types/index.ts`, although two screens read it and the migration review's
  TypeScript cross-check reads that file. The `typescript-types-drift-reviewer` rules ask for an
  interface for every table a screen reads with `.from(...)`.
- Added `IdempotencyKey` with the eight columns in `.claude/schema-registry.json`, typed as the
  generated `src/types/supabase.ts` row. Types only; no behaviour, database or screen change.
