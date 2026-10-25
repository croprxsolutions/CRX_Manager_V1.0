## 2026-10-25 — Live-data guard: the `[E2E]` fake-data tag is judged per write, from its own WHERE

Follow-up to PR #1084, which shipped with two `[E2E]` gaps that Luna had rated BLOCKER and Mason
chose to keep as a follow-up (2026-10-25). Both are closed in `.claude/hooks/live-testdata-lib.mjs`.

- **One tag no longer exempts a whole batch of inserts/updates.** Before, `[E2E]` anywhere in the
  SQL, a comment included, let every insert and update through, so
  `UPDATE invoices SET total_cents = 1 WHERE id = 7; -- [E2E]` changed a real invoice. Now each
  write is judged by itself, with comments removed (DO-block bodies included). An `INSERT … VALUES`
  is fake only when every row has a value that is exactly an `'[E2E]…'` string, so
  `VALUES ('[E2E] a'), ('Real')` is refused. `INSERT … SELECT`, `DEFAULT VALUES` and
  `ON CONFLICT … DO UPDATE` never count as fake.
- **A tag somewhere in a delete or update no longer proves it touches fake rows.** Before,
  `DELETE FROM invoices WHERE id = 7 OR notes = '[E2E]'` passed. Now an UPDATE or DELETE
  (cancel/void included) counts as fake only when its own WHERE clause has, at the top level and
  joined only by AND, `<column> = | LIKE | ILIKE '<text containing [E2E]>'`. Because the marker
  test is ANDed in, the write can only touch rows that carry the marker. So
  `DELETE FROM invoices WHERE id = 7 AND notes = '[E2E]'`, the example given for this gap, is
  safe and stays allowed: it removes invoice 7 only if invoice 7 is itself marked. Refused:
  an OR or BETWEEN; NOT; a `USING`/`FROM` join; the marker inside a subquery
  (`id IN (SELECT 7 FROM customers WHERE name LIKE '[E2E]%')`); a tautology
  (`'[E2E]' = '[E2E]'`); and the marker only in the SET list (`SET notes = '[E2E]' WHERE id = 1`
  just labels a real row). Inside a DO block, the column must be qualified with the table or its
  alias (`c.name LIKE '[E2E]%'`). A bare name there may be a PL/pgSQL variable, and
  `v_note = '[E2E]'` is then always true.
- **Holes found while closing these (Luna round 1 and self-review), all refused even with
  REAL-DATA-OK:** `MERGE INTO` a business table (it was invisible); `EXECUTE` in a DO block (SQL
  assembled at run time such as `'UPDATE ' || 'customers …'` was invisible); `U&"custome\0072s"`
  Unicode-escaped names (invisible); and an insert/update spelled inside a string literal (kind
  `dynamic-sql-write`; a catalog search must split the words, e.g. `ILIKE '%update%customers%'`).
  `UPDATE ONLY` / `DELETE FROM ONLY` are now caught, for business tables and the audit log.
- **Speed:** a 340 KB literal packed with write words took 4 s to check and now takes 15 ms. A
  flood of unterminated writes is refused (`unclassifiable-writes`) instead of timing out.

The old test asserting that `UPDATE customers … WHERE id = 1 -- [E2E]` is allowed now asserts
the opposite. Its premise was the gap itself: a comment says nothing about which rows change.
The same goes for `UPDATE vendor_bills SET notes = '[E2E] test' WHERE id = 1`.

**Normal fake-data work still passes:** `DELETE FROM customers WHERE name LIKE '[E2E]%'`, an
`[E2E]` insert followed by a delete of the same row, multi-row `[E2E]` inserts, `[E2E]` inserts and
qualified marked updates inside a `DO` smoke block, and a CTE that deletes `[E2E]` rows.
**New requirements:**
- Updating an `[E2E]` row by id needs `AND name LIKE '[E2E]%'` (or similar) beside the id.
- Child rows (order items, invoice items) must carry their own marker or be removed with their
  marked parent. A text check cannot see where a subquery or a foreign key leads, so it refuses
  rather than guesses.
- Fake rows are inserted with `VALUES`, not `SELECT`.

The refusal message explains each of these.

**Accepted limits:** a marked INSERT can still attach a new row to a real parent. A write through
an updatable view is not seen, because the view name is not on the table list (unchanged).

**Proof:** `node .claude/hooks/guards.test.mjs` passes (460 assertions). Against origin/main's
classifier the new tests fail, and a 41-case probe showed the old guard allowing all 26 risky
writes that the new one refuses. The hook-level tests run the real `live-testdata-guard.mjs`
process and confirm that these are denied: the gap-1 example, a marked insert next to an unmarked
update, and an OR-ed delete. The same tests confirm the cleanup delete and insert-then-delete are
allowed.
