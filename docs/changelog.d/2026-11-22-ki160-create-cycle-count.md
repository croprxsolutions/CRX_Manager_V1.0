## 2026-11-22 - KI-160: starting a stock count is one server step (database part)

- Migration `20270209160000_create_cycle_count_one_step.sql`: new `create_cycle_count` saves a count and every line for the chosen location together, or nothing. Before, the Cycle Counts screen made three separate requests, and a failure after the first left an empty open count that blocked that location until someone cancelled it.
- No data changes. The current screen keeps working as before; the screen PR switches to the new function after this is on the staging database. A follow-up removes the old direct-insert path once the new screen is live everywhere.
- Proof: `node scripts/smoke/prove-create-cycle-count-real-schema.mjs` (`CREATE_CYCLE_COUNT_PROOF_PASS`, local Docker): admin start with 3 stock rows; empty location refused with nothing saved; rep, driver, applicator, inactive admin and anon refused; second open count refused by name; a refused line rolls the whole start back; same retry key returns the same count. Smoke chain `smoke-create-cycle-count.sql` passes.
- Not verified: the staging database (applied by the staging DB job after merge).
