# KI-145 Bulk Customer Import — behavior contract

Read at `origin/staging` a93fb9e85 (2026-11-18).

## Outcome and authority

- **Result:** a rep or admin imports a customer list and every good row becomes a customer exactly like one made on
  the New Customer page (same server checks, same activity row). Bad rows are counted and each one says why.
- **Smallest change:** screen only, `src/components/customers/BulkCustomerImport.tsx` (+ its test). Each row calls the
  existing `save_customer` RPC (`p_customer_id` null = create) instead of a direct `customers` insert. No migration.
- **Who may act:** admins and active sales reps (`save_customer` raises `INSUFFICIENT_ROLE` otherwise; the Customers
  page already shows the button only to them).
- **Server enforcement (facts, `20261013220000_reps_work_any_customer.sql` newest `save_customer`):** the RPC is
  `SECURITY DEFINER`, takes the actor from `auth.uid()` (`p_performed_by` must match or `ACTOR_MISMATCH`), refuses a rep
  whose payload `assigned_sales_rep` is not themselves (`REP_MUST_SELF_ASSIGN`), and writes a `customer_created`
  activity row. `guard_customer_rep_edit_20261013` (`20261111100000`) refuses a rep's insert whose `assigned_tier`
  differs from the Settings Default Tier (`TIER_ADMIN_ONLY`).
- **Values the screen sends:** `assigned_sales_rep` = the signed-in rep's id for a rep (the server checks it);
  for an admin it stays empty, as the import does today (unchanged behavior; the admin can assign later).
  Tier: the rep's rows keep the Default Tier (already the case); an admin's rows keep the file's tier.

## State and failure

- **Each row is its own transaction.** A failed row writes nothing; earlier rows stay. The result screen lists every
  failed row: file row number, farm name and the server's message (via `sanitizeError`).
- **Parsing:** acres `"1,200"` (quoted in the CSV) → 1200 (thousands commas stripped before the number is read).
  A row with a blank first cell is kept and goes through the normal checks, so a missing farm name is counted as an
  invalid row instead of vanishing. Fully empty lines are still ignored. Row numbers are the file's line numbers.
- **Existing rows:** none change. Readers are unaffected (same columns as the page writes).
- **Timing:** each row gets its own idempotency key when the file is parsed, so pressing Import again on the same
  preview replays instead of duplicating (and the button is disabled while running). Re-parsing the file makes new
  keys: re-importing the same file twice makes duplicates, exactly as today (duplicate detection is KI-77).
- **Undo/history:** none added; the activity row records who imported each customer.

## Delivery

One screen PR to `staging`. No database change, so no DB-first split. Off the Sol list (checked with
`scripts/sol-needed.mjs`).

## Proof cases

1. When a sales rep imports a valid row, then `save_customer` is called with `assigned_sales_rep` = the rep and the row
   counts as imported (component test that fails first on today's code; plus local app as a rep against the local DB:
   customer created with the rep assigned and a `customer_created` activity row).
2. When an admin imports `"1,200"` acres, then 1200 is sent (component test, fails first).
3. When a row's first cell is blank, then Invalid Rows counts it as "Missing farm name" with its file row number
   (component test, fails first).
4. When the server refuses a row, then the result screen shows that row's number, name and message, and the other rows
   still import (component test).
5. When a rep's file says tier 3, then the Default Tier is sent and the server accepts it (existing test + local app).

## Business decisions

- **An admin's imported customers stay unassigned** (Mason, 2026-11-19, answering Taha's PR #1993 question). The
  New Customer page starts on the signed-in user; the import does not, as before. Reps' rows are assigned to the rep.

## Cold challenge (Astra gpt-6.2-astra high, 2026-11-18, FINDINGS 32) — settlement

Fixed in the contract and code:
- Row numbers come from the file's physical line, leading blank lines included (10); a blank first cell no longer
  drops a row wherever the farm column sits (11).
- Acreage: commas are stripped only from a real thousands pattern (`1,200`, `12,345.5`); `1,2`, `12abc` or a negative
  make the row invalid with a reason instead of saving a wrong or missing number (14). A row with more values than
  headers (an unquoted `1,200`) is invalid with a hint to quote it (13).
- Every row is caught at its own boundary; busy state always clears (19). A refusal with a database code shows the
  server's sanitized message; a request with no answer says "may have saved, check the list before importing again"
  (18, 20, 27). Close, Cancel and Choose Different File are disabled while importing (23).
- The result screen also counts invalid rows skipped, and shows a red icon when nothing imported (25). The results
  stay open after `onSuccess` (the Customers page only refetches its list, `src/pages/Customers.tsx:477`) (26).
- Parsing waits for the signed-in profile, so an admin's tiers are never lost while it loads (9). A rejected
  replacement file clears the old selection (17). OCR items: trimmed names, the 500 limit, numbered by position;
  the file's tier applies to CSV only (OCR has never read one) (15, 16).
- Who may act: active admins or active sales reps only (`INSUFFICIENT_ROLE` otherwise) (5). Admin rows send JSON
  `null` for the rep (4).

Refuted with evidence:
- 1: packet error (the KI excerpt was cut from stale line numbers); KI-145 is the import issue (KNOWN_ISSUES.md).
- 3: table defaults equal the RPC's COALESCE values (`credit_limit_cents 0`, `finance_charge_rate 0`,
  `finance_charge_enabled true`, `finance_charge_grace_days 0`), so a page create, the old insert and the import
  store the same billing defaults.
- 7, 8: a Default Tier change mid-import makes later rep rows fail `TIER_ADMIN_ONLY`, each shown with its reason;
  nothing saves at a wrong tier. Rare, visible and safe; no change.
- 21: rows are sent one at a time; the same key is never in flight twice.
- 28: no existing rows change.

Declined (not regressions; today's import has none of these; named as follow-ups):
- 22, 24, 29: in-place retry of unconfirmed rows, recovery after a reload, and a per-batch receipt/undo. Duplicate
  protection on re-import stays KI-77. Not a business decision for this fix: behavior is no worse than today and the
  screen now says which rows may have saved.
- 12: quoted values spanning lines (pre-existing parser limit).
- 2: parity means the same server create + activity row; the page's duplicate warning is KI-77.

Proof (6, 30, 31): run on the local test copy (real migrated database), as an admin through the screen and as a
sales rep through `save_customer` with that rep's JWT claims, including a refused middle row.
