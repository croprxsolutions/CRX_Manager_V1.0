# Blend-ticket import: the total column, not the per-acre rate, is the quantity — Behavior contract

Source: Sol round 11 HIGH 1 on #2267 (head `0b23deaef2cc`, skipped by Mason 2026-11-24 so #2267 could land). Read at `origin/staging` `17c4b5b52`.

## Facts

- `supabase/functions/process-blend-ticket/index.ts` `extractProducts` reads the product section two ways and keeps whichever finds more lines: `parseProductLine` (one line per product) and `parseMultiLineProducts` (name, then rate, then total on separate lines).
- `parseProductLine` has two paths. The pipe path (`name | rate | total`) and the multi-line reader already take the quantity from the total column and fall back to the rate only when there is no total. The plain-spaces path takes the **first** number after the name, which is the per-acre rate: `Piksi Dust Inffurow 6 g 750 g` gives quantity 6, unit `g`, confidence 100.
- That quantity becomes the blend product row a rep reviews; after approval, Create App Record files and deducts it (`20260713060200_harden_blend_unit_indeterminate_guard.sql:161` checks only that the unit matches stock). Before #2267 the `g` vs `MG` mismatch refused the Piksi line; now both are `g`, so the wrong amount passes.
- The ticket header the reader keys on is `Product  Rate/Acre  Total Product`: column 2 is the rate, column 3 is the total used.

## Outcome

All three readers (plain spaces, pipes, and the multi-line reader) read the rate per acre, then the total used, through one rule (`pickQuantity` in `productLine.ts`), as Mason chose on 2026-11-24 ("strict rule"):

- **Exact:** a rate with a known unit (an optional `/ac` or `per acre` after it) and a total that is a clean amount cell with a known unit (`750 g`, `750g`, `.75 g`, `32qt.`, `1,500 qt`, `750 grams`), and nothing else. Quantity and unit are the total's.
- **Everything else keeps a best-guess number but a blank unit:** a line with only one amount (rate or total? the header has both columns), an empty, unreadable or unit-less total, a unit the reader does not know (`mg`, `kg`, `bags`, `Lot`), a rate whose unit is unknown (`280 SL`), extra text, amounts or columns. The guess is the total's number when one is readable (also a damaged `~10 gal`), else the rate's. The reader never borrows the rate's unit and never finds `g` inside another word.
- **Catalog check:** if an active product's name is longer than the read name and runs on into the line's amounts (`Atrazine 4L`, `Atrazine 4 L`, `Liberty 280 SL`), the columns shifted, and the unit is left blank (`nameSwallowsRate`, applied in `index.ts`). A false match only blanks a unit.

A blank unit is the safety valve: `create_application_record_from_blend_ticket` (body from `20260713060200`, renamed by `20261016140000`) passes the line unit to `field_app_priced_quantity`, which returns NULL for a blank unit, and the function raises `BLEND_TICKET_UNIT_UNCONVERTIBLE`. So a guessed line cannot be filed or deducted until a rep sets its unit. The batch approval screen does not show product lines, so this check, not a rep's reading of every line, is what stops a guess (Sol r1 LOW).

Files: `supabase/functions/process-blend-ticket/index.ts`, a new `productLine.ts` beside it (so a test can import the reader without starting the server), and its Deno test. No database, screen, permission or lifecycle change.

## Rules that always hold

- With a clean total cell and aligned columns, the quantity is the total's number in the total's unit; it is never the rate.
- A unit the reader is not sure of is left blank, never replaced by a known one; a blank unit cannot be filed.

## Existing rows

Already-imported tickets are not re-read. Any ticket imported with the old reader keeps the quantity a rep reviewed and saved. No query needed: nothing stored changes.

## Delivery

One PR into `staging`. The Edge Function runs from the deployed copy, so the fix reaches users only after the function is deployed: staging first; production deploy needs Mason's explicit yes.

## Proof cases (Deno test against the real reader, `productLine.test.ts`)

1. Exact lines give the total: `Piksi Dust Inffurow 6 g 750 g` → 750 g; `6g 750g`; `32 oz 10 gal` → 10 gal; `1,500 qt`; `2 lbs 80 lbs` → 80 lb; `32 QTS`; `2 qt/ac 32 qt`; `2 qt per acre | 20 qt`; `32qt.`; `.75 g` total; `6 grams 750 grams`; `ml` stays `ml`; the pipe forms.
2. One-amount lines keep the number, blank unit: `Roundup 32 oz`, `2. qt`, `Roundup | 32 oz`, an empty pipe total, `750 grams`.
3. Every other guess has a blank unit: lot and EPA numbers, `N/A`, `1,5 g`, a bare total, `mg`/`kg`/`bags`, `1 500 qt`, damaged `~10 gal` (keeps 10), `Liberty 280 SL 32 oz 10 gal`, `Atrazine 4L 2 qt 100 qt`, extra pipe columns.
4. The multi-line reader uses the same rule; `Atrazine 4L 2 qt` with `Atrazine 4L` in the catalog is caught.

## Challenge settlement (Astra `gpt-6.2-astra` high, 47 findings; compliance reviewer, 3 HIGH)

- Fixed in the contract and code: trailing lot/EPA numbers read as the total; `g` matching inside `mg`/`kg`/`bag`; unknown total units taking the rate's unit; leading decimals and `1,5`; wrong file name.
- Luna r1–r2 and Sol r1 (`1029256da`): the pipe reader also uses the strict cell; a guess (unreadable or unit-less total, numeric product name, shifted columns) now always has a blank unit instead of borrowing the rate's (this reverses Luna r2's "inherit the rate's unit" suggestion, which Sol r1 showed can deduct 10 oz for 10 gal); `2.`, `QTS`, `/ac` read correctly.
- Refuted: `ratePerAcre`/`totalProduct` text contents — only name, quantity, unit, lot and confidence are sent to `commit_blend_ticket_ocr_result` (`index.ts` `ocrProducts` mapping).
- Out of scope, unchanged by this PR (pre-existing OCR layout limits): a row wrapped over two lines, mixed horizontal/vertical layouts, header order, section boundaries, the confidence formula, reprocess and filing/stock paths. Listed as follow-ups in the PR.
- Luna r4–r6: pipe rate cells with extra text are not exact; an unreadable rate keeps a readable total's number; `/ac` is allowed in a pipe rate cell. Refuted: `ml` read as `l` (tested). The first-number scan still drops lines like `1,500 qt` (old behavior; the line is missing, not wrong). A trailing empty pipe column is a table border and stays allowed.
- Sol r2 (`270c1d338`): an empty pipe total and any one-amount line are now a guess (blank unit), since a single amount may be the rate; the catalog check catches a name that swallowed the rate token; damaged totals keep their number; `grams` and `per acre` are read; the multi-line reader uses the same rule. Still deferred: a name with an amount that is not in the catalog; the token scan dropping lines that start with `.75` or `1,500`.
- Luna r7–r8: extra text in a multi-line rate cell is not exact (`rateHasExtra`); the catalog check now also catches a name whose amount and unit are separate tokens.
- Decisions: legacy exposure and rollback are not new — the app is not in real use yet (2026-11-24) and #2267's gram change is on staging only; production deploy of the function waits for Mason's yes. No business decision is open.

## Open business decisions

None open.

- **Strict rule (Mason, 2026-11-24, "Yes, strict rule").** After the review stop rule fired (a new HIGH from the "is the reader sure?" rule in Luna r1, Sol r1 and Luna r3), Mason chose: the import fills a unit only for an exact line (name, rate with a known unit, optional total with a known unit, nothing else); every other line arrives with a blank unit that a rep must set before Create App Record will file it.
- **A blank unit makes the rep fix the whole line (Mason, 2026-11-25, "Yes, rep fixes line").** After Luna r9 (the catalog check's third HIGH round: a shifted line keeps the rate as its quantity guess and a product matched from the cut-short name), Mason chose: a blank unit is what stops the line, and the rep who sets the unit also checks its product and amount. The product match is not cleared, because filing silently skips a line with no product.
