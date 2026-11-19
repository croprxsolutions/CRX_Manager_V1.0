# KI-146 — Farm groups cannot loop, and include grandchildren (behavior contract)

Read at `origin/staging` a93fb9e85, 2026-11-18.

## Facts (with sources)

- `customers.parent_customer_id` (uuid, FK to `customers.id`) is the farm-group link. No check stops a loop.
- Writers of that column: `save_customer` (newest body in `20261013220000_reps_work_any_customer.sql`, writes the column on
  insert and, when the payload carries the key, on update; it locks the edited row `FOR UPDATE` first); the direct table
  API (policy `customers_update`, altered in the same file, line ~3774). Bulk Customer Import inserts straight into
  `customers` but has no parent column (`BulkCustomerImport.tsx`), so it never sets a parent. No other trigger writes
  `NEW.parent_customer_id`; `idx_customers_parent` indexes the column (`20260213000000`).
- `get_customer_farm_group(uuid)` (newest body `20261023090000_field_functions_require_field_access.sql:287`) walks up with
  `UNION ALL` and no guard (a loop never ends, so the Sales Reports farm-group view times out), then returns the top parent
  plus only its DIRECT children, so a grandchild is left out of the group.
- Only caller: `SalesReports.tsx:184` (uses `id`s to widen the report to the group; one member = no group).
- The Customer screen's parent picker already hides the customer itself (`excludeIds`, `CustomerDetail.tsx:1547`).
- A plain `RAISE EXCEPTION` message reaches the toast unchanged (`sanitizeError` pass-through, `errorSanitizer.ts`).
- Live, read-only 2026-11-18: 154 customers, 19 with a parent, 0 pointing at themselves, 0 in a loop, 0 grandchildren.

## Outcome and authority

- Result: no save path can make a customer its own ancestor, and a farm group lists every customer below the top parent.
- Smallest change, one migration:
  1. A `BEFORE INSERT OR UPDATE OF parent_customer_id` trigger on `customers` refuses a parent that is the customer itself
     or any customer below it (children included). One trigger covers `save_customer` and the direct API, so
     `save_customer`'s 3,000-line body is not re-emitted. It runs only when the parent actually changes (an unchanged parent
     on an UPDATE is skipped, so unrelated saves never newly fail).
  2. `get_customer_farm_group`: same signature, grants, role check (`require_admin_or_sales_rep`); both walks recurse on
     customer ids alone with `UNION`, so repeats are dropped: the walk always ends, never lists a customer twice, and no
     depth limit can cut a real group short (a numeric cap was dropped after the challenge: it would truncate a deep group
     and, carried in the row, defeat `UNION`). The group is the top parent plus ALL its descendants. With no top (only
     possible with a loop, which the guard refuses and the postflight proves absent), the requested customer stands in.
- Who may act: unchanged. The trigger applies to every role, service role included; the loop guard always accepts a
  cleared parent (other existing checks, such as the row-version check, still apply).
- Trigger function is `SECURITY DEFINER` owned by `postgres`, `search_path = public, pg_temp`, EXECUTE revoked from
  every API role; the postflight proves its owner bypasses row security on `customers`, so no link is hidden from the walk.
- The refusal names no customer (a caller the insert policy would later refuse learns nothing): "Nothing was saved. The
  chosen parent customer is already below this customer in its farm group, ...".
- Files: the new migration, its ledger record, a real-schema prover, `KNOWN_ISSUES.md` KI-146. No screen change: the picker
  offering a child is refused on Save with a clear message (judged enough for 19 grouped customers; checked on screen).

## State and failure

- Rule that always holds: following parent links from any customer never returns to that customer.
- Timing: two users at once (A under B while B goes under A) could each pass their own check. The trigger takes one
  transaction-level advisory lock before walking, so parent changes run one at a time and the second sees the first
  (the trigger is VOLATILE; the walk is a separate statement after the lock, so it gets a fresh snapshot under the API's
  READ COMMITTED). Before that lock it takes the foreign-key check's own `FOR KEY SHARE` lock on the new parent, so a
  valid save waiting on a parent row that `save_customer` holds `FOR UPDATE` cannot deadlock with it. Unchanged-parent
  updates, clears and parentless inserts take no lock. Double click or retry of `save_customer` is covered by its
  idempotency key.
- Multi-row inserts: the walk also stops on any visible row that names the new row as its parent, because on INSERT the
  new row itself is not stored yet (rows that point at each other in one insert are refused; nothing is kept).
- Existing rows: none loop and none are grandchildren. CREATE TRIGGER locks writers out until commit, and the postflight
  then proves no customer is its own ancestor, so the rule holds from the moment it is installed.
- Rollback: a later migration can remove the trigger and re-emit the 20261023090000 reader; no data changes either way.
  Undo of a refusal: not applicable (nothing is written).

## Delivery

One database PR to `staging`; no screen depends on new names.

## Proof cases (real-schema prover, local test data)

1. When a customer is saved as its own parent, then it is refused and nothing changes (UPDATE and INSERT).
2. When A is B's parent and B is saved as A's parent (a child), then refused; same for a grandchild (A>B>C, A under C).
3. When a valid parent (unrelated, or a sibling) is set, or the parent is cleared, then it saves.
4. Through `save_customer` as an admin with the screen's payload shape, the loop is refused with the readable message and
   the parent is unchanged; a valid parent saves.
5. `get_customer_farm_group` for A, C or E (A>B>C, A>E) returns A, B, C and E, with only A marked parent, for an admin and
   a rep; for an ungrouped customer it returns just that customer; an unknown id returns no rows.
6. When a loop is forced in past the trigger, `get_customer_farm_group` still returns, and a `save_customer` of a looped
   customer with its parent unchanged still saves.
7. A non-office account calling `get_customer_farm_group` is still refused.
8. Rows naming each other in one multi-row insert (two-way and three-way) are refused and none are kept; a legal
   forward reference in one insert saves.
9. Two sessions: X under Y while Y goes under X: the second waits and is refused; X under Y is kept.
10. Two sessions: one holds G `FOR UPDATE` then moves G under H while the other moves F under G: both save, no deadlock.
11. Apply: autocommit refused, POSTFLIGHT_OK, re-apply refused.

## Challenge (Astra, gpt-6.2-astra high, 2026-11-18, FINDINGS 25)

Fixed: depth cap and duplicate rows (1, 2); multi-row insert hole (12); deadlock with `save_customer`'s row lock (10);
farm names in the refusal (16); "clear always allowed" wording (17); two-session proof (9); Bulk Import has no parent
column (20); install-boundary check (21, CREATE TRIGGER lock + postflight); unknown id and row-security owner (15, 23).
Declined with reason: rootless-loop report behavior (3, 22) is unreachable once the postflight and trigger hold; the
Sales Reports stale-response and switch-state races (4, 5) exist today and are not changed here (follow-up); sales totals
(6) only widen by the proven id list, checked on the screen; PostgREST row limit (7) is far above any group size;
current-membership reporting (8) is today's behavior, unchanged; lock hold time (11) affects only parent changes, which
are rare; batch reorganization order (13) has no screen and can be done as two saves; other triggers (14) none write
the parent; retry (18) is `save_customer`'s existing idempotency; rollback (24) noted above; AFTER trigger (25) not
needed once the insert hole is closed.

### Targeted re-check of the lock order, insert check and reader (Astra, high, FINDINGS 13)

Held: the multi-row insert check (Astra modelled every insert order for loops of 2-7 customers, no miss) and both reader
walks always end. Fixed: the postflight's loop check had a 1,000-step limit (a 1,001-customer ring would pass): now a
`UNION` walk with no limit (9); `authenticated` may UPDATE `customers.id` (checked in the prover database), so the trigger
also fires on `id` and treats an id change as a parent change (7; a rename that would re-point children into a loop is
refused, proof case 12). Accepted with reason: deadlocks (1-4) need two transactions re-parenting related customers at
the same instant, or one transaction changing several parents while another waits; PostgreSQL aborts one with a retry
error, the no-loop rule still holds, and every app path changes one customer per save (proof case 10 covers the common
`save_customer` lock order). Row-order and upsert refusals (5, 6) have no app path. Other triggers (8): none write the
parent (installed list read in the prover database). Rootless and dangling groups (10, 11) are unreachable once the
postflight, trigger and foreign key hold; the reader owner bypasses row security like the guard's. 12: one-shot RPC, no
paging.

12. A one-statement id rewrite that would re-point B's parent into a loop is refused and changes nothing.

## Open business decisions

None. (A farm group's depth is not limited.)

## Luna rounds (gpt-6-luna xhigh)

- Round 1 (FINDINGS 2, MED): the reader's owner is now checked in the postflight (fixed); two saves closing the same loop
  at the same instant through `save_customer` can deadlock: accepted as above, changelog wording corrected.
- Round 2 (FINDINGS 3): HIGH 1 fixed: a REPEATABLE READ or SERIALIZABLE snapshot can predate a concurrent parent change,
  so the guard now refuses a parent change outside READ COMMITTED (every app path is READ COMMITTED; a clear still
  saves; proof case 13). HIGH 2 refuted: each prover probe rolls back, so "D under A" is gone before "A under D".
  LOW 3 fixed: the id-rewrite case now requires the loop message.

13. A parent change in a REPEATABLE READ or SERIALIZABLE transaction is refused; clearing a parent there still saves.

## Sol round 1 (gpt-6.2-sol high, head c07e0e6af, FINDINGS: 1 HIGH + 3 MED + 4 LOW)

- HIGH 1 (Sol rounds 1 and 2, same finding): a narrow information-exposure concern about the guard running before the
  table's write permission check; no data can be changed through it. This mechanism had drawn a new HIGH in three
  rounds (Astra, Luna 2, Sol 1), so per AGENTS.md it went to Mason as a business trade-off; he accepted it on
  2026-11-18 (`docs/manual/DECISION_LOG.md`).
- MED 2 (deadlock when one transaction changes several parents while another waits): accepted above (Astra re-check 1-4);
  the changelog no longer promises that no valid save can deadlock.
- MED 3 (one-statement reorder, upsert DO NOTHING refused): accepted above (no app path; do it as two saves).
- MED 4 (1,000-row API cap): declined above; the largest live group is far smaller and a group that size is not planned.
- LOW 5 fixed: the baseline md5 ignores carriage returns, like the predecessor's own check (live: same md5 either way).
- LOW 6 fixed: the race helper fails if the first session never reaches its sleep.
- LOW 7 fixed: the driver probe requires the role check's own refusal (P0001 "Permission denied: requires admin or sales_rep role"), not any error.
- LOW 8 fixed: the refusal now says "Choose a customer that is not below this one, or clear the parent." (a sibling is
  a valid choice).

## Sol round 2 (head 4c12ecbeb): the same HIGH; MED/LOW

- This file's earlier wording of HIGH 1 said too much for a public repository: reworded above (fixed).
- Deadlock wording in the changelog (fixed, as MED 2 above); READ UNCOMMITTED, which PostgreSQL runs as READ COMMITTED, is
  now allowed (fixed).
- Declined with reason: batch reorder, conflict-ignoring insert, 1,000-row cap, rootless-loop fallback (as above;
  unreachable once the guard and postflight hold); the race probe's lock-wait observation and the nested statement
  timeout (the race outcome assertions already fail if the lock order breaks; a hang fails the run's own time limit);
  zero-row write probes (each probed row is seeded and visible to the admin); the trigger-definition text check under a
  non-default search_path (migrations run with the default path, and a mismatch fails closed).
