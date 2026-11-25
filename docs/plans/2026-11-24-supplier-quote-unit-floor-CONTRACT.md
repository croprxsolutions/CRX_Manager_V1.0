# Behavior contract: supplier quote conversion floor and cost ceiling

Known issue: `docs/manual/known-issues.d/2026-11-24-supplier-quote-tiny-conversion-factor.md` (Sol round 1 MED on #2486).
Read at `origin/staging` 3d73f5033 (2026-11-24).

## Outcome

The converted cost per inventory unit, `round(cost_cents / package_quantity / inventory_units_per_supplier_unit)::bigint`,
must always fit a bigint (and JavaScript's exact-integer range), so the review screen never shows an absurd cost and
the supplier workspace and market-evidence reads never fail on a row. Today it overflows when the factor and the
package quantity are tiny (both columns allow 0.00000001) or the cost is huge (`_parse_pricing_dollars` allows up to
bigint cents).

Smallest change: bound each input where it is saved, so the product of the bounds fits.
- Conversion factor (`product_supplier_links.inventory_units_per_supplier_unit`) >= 0.001.
- Package quantity (`supplier_price_import_rows` / `supplier_price_observations.package_quantity`) >= 0.001.
- Cost per package line (`cost_cents`) <= 1,000,000,000 cents ($10,000,000).
- Worst case: 1e9 / 0.001 / 0.001 = 1e15 cents, below bigint (9.2e18) and below `Number.MAX_SAFE_INTEGER` (9.0e15).

Files: one new migration, `src/pages/SupplierPricing.tsx` (row message wording), `src/lib/errorSanitizer.ts`
(plain-English refusals), the two known-issue files, a ledger record, a real-schema prover, and the screen test fixture.

## Facts (read-only, production `rhyzpcqhnizqbxphqdkr`, 2026-11-24)

- 10 links with a factor, 20 import rows, 10 observations: every factor and package quantity is exactly 1;
  0 links below 0.001, 0 rows below 0.001; largest cost 46,743 cents. No PO line has a factor snapshot.
- Live `stage_supplier_price_import` body md5 = a927dd96…, identical to
  `20260720230000_supplier_pricing_durable_replay_and_reject.sql` (newest definition).
- Writers: the factor is set only by `upsert_product_supplier_link` (other link writers insert NULL);
  import rows are inserted by `stage_supplier_price_import` and `correct_supplier_price_observation`;
  observations by `approve_supplier_price_import` and `correct_supplier_price_observation` (corrections copy the
  original package quantity and parse a new cost). Observations are immutable (UPDATE/DELETE trigger).
- Staging data is not checked (the read-only tool is bound to production): UNVERIFIED, see Existing rows.

## Authority

Unchanged: the four write RPCs (link upsert, stage, approve, correct) stay admin-only `SECURITY DEFINER` with their actor, idempotency and grant checks.
No new function, grant or policy.

## Enforcement

1. `stage_supplier_price_import` (re-emitted, body otherwise byte-identical): a row with package quantity below
   0.001 gets the existing `PACKAGE_QUANTITY_INVALID` code; a cost above $10,000,000 gets new `COST_TOO_LARGE`.
   Both make the row `invalid` (not approvable), as every other row error does; the rest of the sheet still stages.
2. CHECK `product_supplier_links_conversion_floor` (factor NULL or >= 0.001) - the link save is refused.
3. CHECKs `supplier_price_observations_package_quantity_floor` (>= 0.001) and
   `supplier_price_observations_cost_ceiling` (<= 1e9 cents) - backstop for approve and correction.
4. Each CHECK is added validated. The preflight first counts stored links, observations and approvable (`new`/
   `changed`/`cannot_compare`) import rows outside a bound and refuses the whole apply with `SUPPLIER_QUOTE_UNIT_FLOOR_LEGACY_ROWS`
   and the counts; a row saved after the count makes the ADD CONSTRAINT itself fail. Either way nothing is applied.
   Production had 0 such rows on 2026-11-24. The tables hold tens of rows, so the exclusive lock lasts milliseconds,
   and the apply gives up after 5 seconds of waiting for it.
5. NaN (which PostgreSQL numeric accepts and sorts above every number) is refused by the stage row check and both
   floors. The floor applies to the stored `numeric(20,8)` value, so 0.000999999 is stored as 0.001 and accepted.
6. Screen: `PACKAGE_QUANTITY_INVALID` reads "Package quantity must be 0.001 or more."; `COST_TOO_LARGE` reads
   "The cost is over $10,000,000 for one line. Check the amount."; `errorSanitizer` maps the three constraint
   names and `SUPPLIER_CONVERSION_INVALID` to plain English starting "Nothing was saved."

## Existing rows

- After the apply no stored link, observation or approvable import row can be outside the bounds, so every reader
  (workspace, market evidence, preferred-vendor list) is safe for all rows, old and new.
- Production: none outside the bounds (query above). Staging is unverified; if it holds a test row outside a bound,
  its Database job stops with `SUPPLIER_QUOTE_UNIT_FLOOR_LEGACY_ROWS` and nothing applies until that row is fixed or
  removed. Checked in the staging browser before merge.
- Already-deployed app during rollout: it sends the same arguments; it shows the new row code through its existing
  fallback text ("cost too large.") and the constraint refusals through the generic sanitizer message until the
  screen half deploys. No screen depends on the migration, so one PR is safe.

## Timing

No new state; the only lock is the apply-time one above. Idempotency unchanged: the stage fingerprint covers the raw rows, so a retry of the same
payload replays the same stored response (including a pre-migration response, which is the existing contract).

## Undo

Rollback is a new forward migration: drop the four constraints and re-emit the prior stage body. No data to restore.

## Proof cases (real-schema container, `scripts/smoke/prove-supplier-quote-unit-floor-real-schema.mjs`)

1. When an admin saves a link with factor 0.0001, then the save is refused (constraint) and nothing is written;
   factor 0.001 and 1 save.
2. When a quote row has package quantity 0.0001, then it stages as `invalid` with `PACKAGE_QUANTITY_INVALID`;
   0.001 stages `new`.
3. When a row costs $10,000,000.01, then `invalid` with `COST_TOO_LARGE`; $10,000,000.00 stages.
4. When a row at the bounds (cost $10,000,000, qty 0.001, factor 0.001) is approved, then the workspace and market
   reads return its normalized cost 1,000,000,000,000,000 cents without error.
5. When a normal quote ($45.00, qty 2, factor 2.5) is staged and approved, then the normalized cost is 900 cents
   (unchanged behavior).
6. When an observation is corrected to $10,000,000.01, then the correction is refused and nothing is written.
7. Apply refuses under autocommit, applies once with POSTFLIGHT_OK, and a re-apply refuses.
8. Staging (browser, Claude in Chrome): a tiny factor is refused with the plain-English message; a normal quote
   still shows the right converted cost.

## Open business decisions

None. The $10,000,000 per-line ceiling and the 0.001 floors are technical sanity bounds chosen from live data
(largest real cost $467.43; every factor and package quantity is 1). Accepting smaller sizes means LOWERING a floor;
changing any bound means re-checking that cost / quantity / factor stays at or below 9.0e15 cents.

## Cold challenge (Astra gpt-6.2-astra high, 2026-11-24, 45 findings) and how each was settled

- Fixed in the contract and build: #1 (tiny pre-existing link + new approval overflows: checks are now validated
  against stored rows), #2 (NaN passes: refused explicitly), #7 (stored value governs: stated), #9 (wording on
  changing bounds), #27 (four write RPCs), #30 (gap between count and apply: closed by validation in the apply),
  #41 (postflight reports each check and its validation state), #42 (prover adds NaN, rounding and a legacy-row
  apply), #31 (lock: momentary on tiny tables).
- Disproved by validation (no stored row can be outside the bounds after apply): #3, #14, #16, #17, #18, #19, #20,
  #23, #39 (rollback would reopen only rows saved after a rollback; a rollback is a new reviewed migration).
- Pre-existing behaviour this change does not alter (out of scope, unchanged): #10 (a quantity of 0 or a date range
  backwards aborts the whole sheet), #11 (duplicate check ignores package quantity), #12 (parser overflow message),
  #13 (raw cost transport), #21 (product unit changed after link save), #22 (screen helper size limit), #24, #32, #33,
  #34, #35, #36 (idempotency and concurrency of existing RPCs).
- Evidence: #26/#43 real API error text is checked on staging in the browser and by `errorSanitizer.test.ts`;
  #28 grants and policies are untouched (postflight re-checks the stage grant); #29 the guarantee covers supplier
  quote conversions; PO snapshots copy the (now bounded) link factor; #37 the guarantee starts when the migration
  applies; old and new screens send the same arguments; #38 rows marked invalid stay invalid under the rule then in
  force; #40 queries are in the migration header.
- DECISION findings #4, #5, #6, #8: #5 (the bounds may refuse an exotic but convertible quote) is the trade-off the
  task brief delegated ("pick the floor from live data"); #4 (plausibility), #6 (sub-cent rounds to 0) and #8 (blank
  quantity means 1) are existing behaviour outside this change, listed for Mason as possible follow-ups.
- SUGGESTION #44/#45 (guard the converted result in every reader instead): declined. The task prefers refusing at
  save; with validated checks the readers are safe without rewriting three read paths and the screen.

## Targeted re-check (Astra gpt-6.2-astra high, 2026-11-24, 17 findings), settled once

- Fixed: #7 (exclusive lock wait unbounded: `SET LOCAL lock_timeout = '5s'`); #12 (NaN factor through the link save
  added to the prover); #1 and #8 (a production check left unvalidated would pass silently: the migration record now
  makes "every check `=true`" a release-apply stop, with the VALIDATE follow-up named).
- Disproved: #13 (the stage variable is `numeric(20,8)`, so 0.000999999 is stored and checked as 0.001 in stage too;
  the prover stages it as `new`); #10 (the prover stages a NaN row beside good rows: NaN row `invalid`, the others
  `new`, and only valid rows approve); #9 (no event triggers in this schema).
- Staging-only legacy consequences (#2, #3, #4, #5, #6, #15, #16): they exist only while a check is unvalidated,
  which production refuses at release. Documented in Existing rows; test data on staging may be fixed or removed.
- #11 (a JavaScript NaN serialises as null, which means quantity 1) and #17 (old screen's NaN text) are existing
  behaviour with no overflow path; no change.
- #14: the production counts are in the migration header; staging validation state is read from the staging Database
  job's `POSTFLIGHT_OK` line after merge.

## Luna round 1 (2026-11-24): strict apply

Luna HIGH (the same mechanism as Astra re-check #1 and drift review M4: a row outside a bound let the apply commit
with a check unvalidated) and MED (stage did not check a legacy link's factor) are closed by removing that leniency:
the apply now refuses while any stored row is outside a bound. Staging-only legacy consequences (Astra re-check #2-#6,
#15, #16; drift M2, M3) no longer exist.

## Luna round 2 (2026-11-24)

MED fixed: the preflight's import-row count now includes `cannot_compare`, which approval also accepts, so a pending
non-comparable row outside a bound stops the apply instead of failing a later approval. Production count with it
included: 0.

## Luna round 3 (2026-11-24)

- MED fixed: an older in-flight quote save could commit an out-of-bound import row between the preflight count and the
  checks. The preflight now takes `SHARE ROW EXCLUSIVE` on the three tables (writes wait, reads continue) before
  counting, under the 5s `lock_timeout`.
- MED refuted as a change here: a JSON `null` package quantity becoming 1 is the existing blank-means-1 rule (Astra #8,
  named follow-up). Both screens send the quantity as text (`'1'` default, `values.package_quantity || '1'`), never a
  serialized `NaN`; a text `NaN` is refused.
- LOW refuted: `convertedCostText` returns nothing for a row that is not eligible or approved, so an invalid
  tiny-quantity row shows no converted cost.

## Luna round 4 (2026-11-24)

MED fixed by a check, not another lock: an older stage call already running during the apply keeps its old body, so
it could save an out-of-bound row as `new` after the apply committed. New CHECK
`supplier_price_import_rows_pending_bounds` keeps every row awaiting approval (`new`, `changed`, `cannot_compare`)
within the bounds, so that late save fails instead (plain message mapped). This ends the timing/lock line of findings
(rounds 2-4). Correction also writes an import row, so a correction above the ceiling is now refused by this check
first. Prover: an out-of-bound pending row is refused; all four checks validated.

## Luna round 5 (2026-11-24)

- MED fixed: the preflight's write lock was later upgraded by `ADD CONSTRAINT`, and its table order could deadlock with
  a correction. The preflight now takes `ACCESS EXCLUSIVE` on all three tables in one statement, in the app's write
  order (import rows, observations, links), so nothing is upgraded later. A deadlock or a wait over 5s still cancels
  one side with nothing saved; that is safe, and the staff call or the apply is simply retried.
- LOW fixed: the constraint-name checks in the preflight and postflight are scoped to the three tables.

## Luna round 6 (2026-11-24)

MED refuted (NULL quantity or cost on a row awaiting approval): no writer makes one. The stage step defaults a blank
quantity to 1 and marks a missing or bad cost invalid (`COST_MUST_BE_POSITIVE` / `COST_INVALID`); the correction copies
the original observation's quantity, which is `NOT NULL`. Approval would write an observation, whose quantity and cost
are `NOT NULL`, so such a row could only fail with nothing saved. The NULL allowance matches the table's existing
column checks. Production read-only count 2026-11-24: 0 such rows. Unchanged.

## Sol round 1 (2026-11-25, head 1b8e82817): clean, six MED/LOW settled

- MED #1 fixed: a `COST_TOO_LARGE` row no longer keeps its cents (a value past JavaScript's exact integers made the
  whole saved import unreadable); the amount stays in `submitted_row`. Prover asserts it.
- MED #2 accepted: a stored legacy link with quote history would stop the apply with no in-app repair. Production
  count 0 (read-only, 2026-11-24 and 2026-11-25); staging links checked in the browser. If the staging job stops with
  `SUPPLIER_QUOTE_UNIT_FLOOR_LEGACY_ROWS`, nothing applied and the named test rows get a reviewed fix.
- MED #3 accepted: a correction and the apply can deadlock in any lock order (callers touch the tables in different
  orders). PostgreSQL cancels one side with nothing saved; the staff call or the apply is retried. `lock_timeout` 5s.
- MED #4 follow-up: the archived-supplier warning uses the supplier list from the last refresh, so a supplier
  archived in another session after that is not flagged until Refresh. Approval is allowed either way (Mason's rule).
- MED #5 follow-up (existing behaviour): duplicate detection ignores package quantity, so a direct RPC call with two
  rows that differ only by quantity keeps the first and marks the second duplicate. Before this change the first
  (tiny-quantity) row was approvable; now neither is. The workbook screen already refuses repeated links.
- LOW fixed: the prover checks the quantity floor and the cost ceiling on separate rows.

## Sol round 2 (2026-11-25, head 1adb40afc): clean

Repeats round 1 MED #2-#5 (settled above). LOW #6 fixed here (the enforcement summary now lists `cannot_compare`).
LOW #5 accepted: the correction proof stops at the pending-row check before the observation cost ceiling; the
postflight confirms that check exists and is validated, and the stage and link proofs exercise the other bounds.
