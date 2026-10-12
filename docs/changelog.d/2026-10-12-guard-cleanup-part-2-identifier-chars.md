## 2026-10-12 — guard cleanup, part 2: identifier characters match PostgreSQL's scanner

Follows `2026-10-12-guard-cleanup-part-2-app-schema.md`. `main` (#894, owner approval by chat reply) was merged in first; the two conflicts were comments in `prompt-router.mjs` and the UserPromptSubmit paragraph in `agent-guardrails.md`, both kept from each side.

**Fixed (Luna, HIGH, the third round of the same identifier-boundary class)**

- `live-testdata-lib.mjs`: the schema and name boundaries used JavaScript's `\w` (plus `$`), but PostgreSQL's scanner also treats every non-ASCII character as part of an identifier. So `"éauth".uid()` matched the `auth.uid()` exemption and `éget_invoice(42)` was read as `get_invoice`. Both boundaries and the name pattern now use PostgreSQL's own definition (ASCII letters, digits, `_`, `$`, any non-ASCII character), so the class is closed by construction rather than one character at a time.

**Proof observed**

- `npm run test:correction-guards` exits 0 (`guards` 202 assertions): `"éauth".uid()`, `éauth.uid()`, `éget_invoice(42)`, `écount(1)` and two `pg_catalog` lookalikes are blocked; `auth.uid()`, `AUTH.uid()`, `count(*)`, `pg_catalog.pg_get_triggerdef(…)` and the ordinary invoice and catalog queries are still reads.
