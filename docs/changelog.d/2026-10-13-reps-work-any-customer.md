## 2026-10-13 — Sales reps work with ANY customer (migration `20261013220000`, NOT applied)

**Owner decision (Mason, in chat, 2026-10-13):** reps create, post and email invoices for any customer,
under their own name only; reps see and edit every customer and every customer-related record; only an
admin reassigns a customer; on a customer not assigned to them a rep cannot change its default commission
split; statements and year-end summaries open to reps. Recorded in `docs/manual/DECISION_LOG.md`. This
reverses the 2026-10-09 admin-only plan (PR #902, closed unmerged) and drops rep scoping.

**Why it was needed:** 146 of 154 live customers have no assigned rep, and live (read 2026-10-13) let a rep
see only their assigned customers and refused save, post and group post for any other customer
(`CUSTOMER_SCOPE_DENIED`), so reps could bill and email almost nobody.

**Database** (`supabase/migrations/20261013220000_reps_work_any_customer.sql`, permissions widening; applies
only with Mason's owner-approval reply):
- 18 functions re-created from their verbatim live bodies with only the assigned-rep tests removed (the
  header lists every hunk); 20 policies lose their assigned-rep condition, every other condition kept.
- Still refused: a rep naming another salesperson (`SALESMAN_SCOPE_DENIED`); a rep creating a customer not
  assigned to themselves (`REP_MUST_SELF_ASSIGN`); a rep reassigning a customer (`REP_CANNOT_REASSIGN`, now
  compared with the stored rep, since the edit page always sends it back); a rep changing the default
  commission split of a customer not assigned to them (`COMMISSION_SPLIT_ADMIN_OR_ASSIGNED_REP`). The last
  two are also enforced on the direct-table path by the new trigger `customers_guard_rep_edit_20261013`.
- Unchanged: every admin-only action, drivers, applicators and other roles, `invoices_select` (a rep reads
  the invoices they created or are the salesperson on), the balance listing's invoice-level filter, the
  reps' own call lists and "my customers" flags, quick deliveries, and the order-invoice RPCs.
- Preflight pins every replaced body and policy to its live md5 of 2026-10-13; postflight checks no
  assigned-rep test remains and owner, grants and security are unchanged.

**Edge Function** `customer-document-files`: admins and sales reps reach every customer's documents (was:
reps only their assigned customers). Needs a deploy, which waits for Mason's explicit OK.

**Screens:** the year-end report's batch mode no longer skips "customers not assigned to you" (the unused
assigned-customer helper is removed); the Misc Charge invoice screen now loads each customer's email and
billing address, so Email works there and the printed invoice shows the address (both were broken for
admins too); two new error messages (`REP_CANNOT_REASSIGN`, `COMMISSION_SPLIT_ADMIN_OR_ASSIGNED_REP`).

**Proof:** `node scripts/smoke/prove-reps-work-any-customer-real-schema.mjs` builds the production schema
baseline in a disposable PostgreSQL 17 container, replays every migration, checks the 18 bodies and 20
policies match live, then runs 51 calls as an admin, two reps, a driver, an applicator and a deactivated
rep BEFORE and AFTER the candidate: reps are refused before and allowed after; the narrower rules still
refuse after; every admin and other-role result is identical before and after; a drifted body aborts the
preflight; a second apply is refused; and with the guard trigger dropped the rep's direct reassignment
succeeds (so the refusal is the trigger). Prints `REPS_ANY_CUSTOMER_PROOF_PASS`.

**Follow-ups (not in this change):** the order-invoice RPCs' salesperson check (`KNOWN_ISSUES.md`); the old
SQL smoke chains that assert `CUSTOMER_SCOPE_DENIED` describe the rule at their own migration and are not
re-run past it.
