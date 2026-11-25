# REI / PHI "not applicable" — behavior contract (2026-11-24)

Read at `origin/staging` ef21134fc; production checked read-only the same day.

## Outcome and authority

- **Result.** A product can record that its label gives no REI and/or no PHI. That product stops showing
  "Incomplete setup" for that field. No fake 0 is ever stored (0 means "no wait").
- **Smallest change.** Two columns on `public.products`: `rei_not_applicable boolean NOT NULL DEFAULT false`
  and `phi_not_applicable boolean NOT NULL DEFAULT false`. A flag is only meaningful while the matching number
  is blank. The existing product page save (`ProductDetail.tsx` → direct column-granted `UPDATE`) writes them; no new RPC.
- **Files.** New migration `supabase/migrations/20270303130000_product_interval_not_applicable.sql`;
  `src/lib/productSetup.ts`, `src/pages/ProductDetail.tsx`, `src/lib/costFields.ts` (PRODUCT_COLUMNS),
  `src/types/index.ts`, `src/types/supabase.ts`, `src/components/products/ProductChangeHistory.tsx`, tests.
- **Who may act.** Same as REI/PHI today: column grants to `authenticated` (INSERT/UPDATE/SELECT/REFERENCES)
  mirroring `rei_hours`; the products UPDATE/INSERT RLS policies (admin) decide who actually writes. The input is
  shown to admins only, like REI/PHI. No `SECURITY DEFINER` function is added; the history trigger function
  (already DEFINER, owner postgres) is re-issued with two more watched fields.
- **Screen-sent values.** Only the two booleans and the existing numbers. No locator or actor is trusted.

## State and failure

- **Rule that always holds (DB):** `NOT (rei_not_applicable AND rei_hours IS NOT NULL)`, same for PHI
  (CHECK constraints).
- **Automatic record changes** (BEFORE trigger `trg_clear_product_interval_not_applicable`; never sets a flag,
  never writes a number):
  - Every accepted numeric write to an interval clears its flag, whoever writes it (product page, Label Review,
    setup workbook, bulk import, an old browser tab). Business rule: a number wins over "not applicable". Writers keep
    working instead of failing the CHECK.
  - A changed EPA number clears a flag that the same save did not set: a new label needs a new review.
  - An explicit blank (workbook cell cleared, number deleted) leaves the flag as it is; only the tick changes it.
- **Existing rows.** All existing rows get `false` = today's meaning ("blank = not entered"). No backfill in this
  change (Mason decides separately). Read-only check after apply:
  `SELECT count(*) FROM products WHERE rei_not_applicable OR phi_not_applicable` → `0`.
- **Readers.** Every reader already treats a blank interval as "no interval": job corrections skip a null product
  value (`jobLabelCorrections.ts`), applicator sheet, WPS notice, chemical reports and the field app print blank.
  The flag keeps the number blank, so none of them can print or write 0. Only `missingProductSetup` reads the flag.
- **Already-deployed app during rollout.** It never sends the new columns; its writes keep the default/old values.
  An old tab can clear a flag only by saving a number or a changed EPA number (the rules above). A brand's EPA number changed on the Brands screen does not clear a generic's ticks (Mason, 2026-11-24: rare; untick by hand). Selecting the new columns needs the
  migration live first (DB-first PR split).
- **Timing.** REI/PHI and the flags do not move `pricing_version`. The page sends an interval pair only when it
  changed, and that update also filters on the number and flag the page read. If anyone changed the pair since, zero
  rows match and the page says "Product details changed after this page loaded. Reload before saving." So a tick can
  never be silently dropped by the trigger, and a newer number is never overwritten by a stale tick. Unchanged flags
  are never re-sent (same rule as the other label fields), so an unrelated edit cannot undo a tick.
- **Editing transitions (page).** unknown → N/A: tick. number → N/A: tick (clears the number; the number box is
  disabled while ticked). N/A → number: untick, type. N/A → unknown: untick. Non-admins see the tick read-only.
- **Undo and history.** `write_product_change_history` records `rei_not_applicable` / `phi_not_applicable`
  old → new with the actor, like every other setup field. Undo = untick and save (recorded the same way).

## Delivery

- PR 1 (database first): migration + ledger record + this contract. Compatible with the deployed app.
- PR 2 (screens): stacked on PR 1, merges only after PR 1 is live on staging.
- Out of scope: the "new product" form (it creates through `create_product_with_parent`; the flag is set after the
  first save), the setup workbook and bulk import columns, and any backfill.

## Proof cases

1. When an admin ticks "Label gives no REI" on a saved pesticide product with blank REI and saves, then
   `rei_not_applicable = true`, `rei_hours` stays NULL, the "Incomplete setup" badge no longer lists REI, and the
   history shows the change. (Browser on the local test copy.)
2. When `rei_hours = 12` is written to a flagged product (Label Review / workbook path), then the row saves with
   `rei_hours = 12, rei_not_applicable = false`. (SQL on the local test database.)
3. When something writes `rei_not_applicable = true` together with `rei_hours = 5`, then the trigger keeps 5 and
   clears the flag (never a stored conflict). (SQL.)
4. When a flagged product is used on a job, then job label corrections propose nothing for that field and the job
   payload has no 0. (Unit test.)
5. When the flag is false and REI is blank, then the product is still flagged incomplete (no regression). (Unit.)
6. A non-admin authenticated user cannot change the flag (same RLS as REI). (SQL as the real role.)

- **Jobs.** Existing job lines keep the REI/PHI they were saved with; this change touches no job. Job label
  corrections skip a blank product value (`jobLabelCorrections.ts:39`, test "does not offer a blank product value"), so
  they never propose 0 or N/A. Every reader of a blank interval prints blank (the WPS notice prints "see product label", `wpsNoticePdf.ts:148`): `applicatorSheetData.ts`,
  `wpsNoticePdf.ts`, `chemicalApplicationReportFetch.ts:202`, `FieldAppChemicalEntry.tsx:358`, `JobDetail.tsx:1015`.

## Cold challenge (gpt-6.2-astra, high, 2026-11-24): 48 findings, settled

- Fixed: save race (#6, #7, #8) by the pair filter above; history preflight now checks the exact predecessor body
  hash (#36); grant parity compares each flag with its own interval (#31); `metabase_ro` and `service_role` hold
  table-level SELECT on products (read on production), so they inherit the columns and parity holds (#30 disproved);
  rollback wording (#40, #41); contract wording for old tabs and "every numeric write" (#5, #9); transitions (#10).
- Disproved / no change: workbook fingerprint lists fields explicitly (`20261108120000:473`) and omits the flags, so no
  open workbook goes stale (#18); `use_timing` still exists and is watched (#38); direct insert history records only
  "created" for every field today (#34); the CHECK scan is over a few hundred rows and ADD COLUMN with a constant
  default is metadata-only (#43); production release goes through `release/next` with the apply before merge (#42).
- Out of scope (Mason decides separately): backfill and backlog sizing (#24), legacy zeroes (#25), existing job
  values (#26, #27).
- Declined suggestion #48 (fold into `guard_product_setup_fields`): re-issuing that larger guard is riskier than a
  six-line trigger.

## Business decisions (Mason accepted all four as built, 2026-11-24)

1. What a tick means: "this product's label lists no REI (or no PHI) for the crops we sell it for". Wording on screen:
   "Label gives no REI" / "Label gives no PHI".
2. A changed EPA number clears the ticks (re-review). Built.
3. Printouts and field screens keep showing a blank for both "unknown" and "not applicable" (no change). Showing
   "N/A" there would be a follow-up.
4. The new-product form has no tick; it appears after the first save.
