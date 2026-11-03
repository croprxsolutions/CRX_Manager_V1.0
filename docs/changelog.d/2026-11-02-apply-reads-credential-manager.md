## 2026-11-02 - Migration apply reads the Supabase token from Credential Manager

- `scripts/apply-migration-file.mjs` uses `SUPABASE_ACCESS_TOKEN` when set and otherwise, on Windows, reads Mason's token in memory from Credential Manager (`Supabase CLI:supabase`), printing only where it came from. Sessions no longer build a throwaway launcher. Every apply gate is unchanged.
- The reader moved out of `scripts/db-invariant-sweeps/run-live.mjs` into `scripts/lib/supabase-credential.mjs`, shared by both; its decode test is `scripts/lib/supabase-credential.test.mjs` (fails when UTF-16LE decoding is removed).
