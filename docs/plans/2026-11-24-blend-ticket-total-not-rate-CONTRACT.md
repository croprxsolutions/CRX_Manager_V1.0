# Blend-ticket import: the total column, not the per-acre rate, is the quantity — Behavior contract

Source: Sol round 11 HIGH 1 on #2267 (head `0b23deaef2cc`, skipped by Mason 2026-11-24 so #2267 could land). Read at `origin/staging` `17c4b5b52`.

## Facts

- `supabase/functions/process-blend-ticket/index.ts` `extractProducts` reads the product section two ways and keeps whichever finds more lines: `parseProductLine` (one line per product) and `parseMultiLineProducts` (name, then rate, then total on separate lines).
- `parseProductLine` has two paths. The pipe path (`name | rate | total`) and the multi-line reader already take the quantity from the total column and fall back to the rate only when there is no total. The plain-spaces path takes the **first** number after the name, which is the per-acre rate: `Piksi Dust Inffurow 6 g 750 g` gives quantity 6, unit `g`, confidence 100.
- That quantity becomes the blend product row a rep reviews; after approval, Create App Record files and deducts it (`20260713060200_harden_blend_unit_indeterminate_guard.sql:161` checks only that the unit matches stock). Before #2267 the `g` vs `MG` mismatch refused the Piksi line; now both are `g`, so the wrong amount passes.
- The ticket header the reader keys on is `Product  Rate/Acre  Total Product`: column 2 is the rate, column 3 is the total used.

## Outcome

The plain-spaces path reads the same columns the other two readers do: the first amount after the name is the rate per acre; a clean amount cell right after it (`750 g`, `750g`, `.75 g`, `1,500 qt`) is the total, and the total is the quantity. Anything else after the rate (a lot or EPA number, `N/A`, damaged text) is not a total, and the line keeps today's behavior (the rate's number). The unit is the total's own unit when it is one we know; a bare total at the end of the line takes the rate's unit; any other word after the total (`mg`, `kg`, `bags`, `Lot`) leaves the unit blank so the rep must pick it. The pipe reader learns `g` as a whole unit word only, so `mg`/`kg` never become grams.

Files: `supabase/functions/process-blend-ticket/index.ts`, a new `productLine.ts` beside it (so a test can import the reader without starting the server), and its Deno test. No database, screen, permission or lifecycle change. Nothing is written by the reader itself; a rep still reviews every line before the application record is created.

## Rules that always hold

- When the line has a clean total cell, the quantity is that cell's number, in that cell's unit or blank; it is never the rate.
- A unit the reader does not know is never replaced by a known one.
- The server-side stock-unit check and the rep's review are unchanged.

## Existing rows

Already-imported tickets are not re-read. Any ticket imported with the old reader keeps the quantity a rep reviewed and saved. No query needed: nothing stored changes.

## Delivery

One PR into `staging`. The Edge Function runs from the deployed copy, so the fix reaches users only after the function is deployed: staging first; production deploy needs Mason's explicit yes.

## Proof cases (Deno test against the real reader)

1. When the line is `Piksi Dust Inffurow 6 g 750 g`, then quantity 750, unit `g`.
2. When the line is `Piksi Dust 6g 750g` (no spaces before units), then quantity 750, unit `g`.
3. When the rate and total units differ (`Roundup 32 oz 10 gal`), then quantity 10, unit `gal`.
4. When the line has only one number (`Roundup 32 oz`), then quantity 32, unit `oz` (unchanged).
5. When the total has a thousands comma (`Atrazine 2 qt 1,500 qt`), then quantity 1500.
6. When the line is the pipe form (`Piksi | 6 g | 750 g`), then quantity 750 and unit `g` (the pipe reader did not know `g` as a unit and left it blank; a one-token addition).

7. Lot/EPA numbers, `mg`/`kg`/`bags`, leading decimals and `1,5` (Astra and compliance counterexamples): see `productLine.test.ts`.

## Challenge settlement (Astra `gpt-6.2-astra` high, 47 findings; compliance reviewer, 3 HIGH)

- Fixed in the contract and code: trailing lot/EPA numbers read as the total; `g` matching inside `mg`/`kg`/`bag` on the pipe path; unknown total units silently taking the rate's unit; leading decimals and `1,5`; wrong file name.
- Refuted: `ratePerAcre`/`totalProduct` text contents — only name, quantity, unit, lot and confidence are sent to `commit_blend_ticket_ocr_result` (`index.ts` `ocrProducts` mapping).
- Out of scope, unchanged by this PR (pre-existing OCR layout limits, a rep reviews every line): numeric product names (`Liberty 280 SL`), a row wrapped over two lines, mixed horizontal/vertical layouts, header order, section boundaries, the confidence formula, reprocess and filing/stock paths. Listed as follow-ups in the PR.
- Decisions: legacy exposure and rollback are not new — the app is not in real use yet (2026-11-24) and #2267's gram change is on staging only; production deploy of the function waits for Mason's yes. No business decision is open.

## Open business decisions

None.
