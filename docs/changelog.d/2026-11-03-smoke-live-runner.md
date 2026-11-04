## 2026-11-03 - Live smoke chains run byte-exact (`npm run smoke:live`)

- `scripts/smoke/run-smoke.mjs --live` sends each post-apply smoke chain unchanged, as one statement, to the live project through the Supabase Management API and grades it itself. Nobody retypes a 15-33KB chain into MCP `execute_sql` any more.
- It sends only `.sql` files named in `smoke-specs.json`, from `scripts/smoke/`, that raise `SMOKE_PASS_ROLLBACK`, and never container-only or psql-only chains. The token is read in memory and never printed or saved. Mason approved this use on 2026-11-03.
- The shared grader (`interpret-result.mjs`) now accepts `SMOKE_PASS_ROLLBACK:` as a pass. Four chains raise that shape, and psql mode used to grade them as FAIL.
- ship.md Step 5 item 4 and `scripts/smoke/README.md` now point at `npm run smoke:live`.
