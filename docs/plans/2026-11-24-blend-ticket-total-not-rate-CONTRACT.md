# Blend-ticket import: the total column, not the per-acre rate, is the quantity — Behavior contract

Source: Sol round 11 HIGH 1 on #2267 (head `0b23deaef2cc`, skipped by Mason 2026-11-24 so #2267 could land). Read at `origin/staging` `17c4b5b52`.

## Facts

- `supabase/functions/process-blend-ticket/index.ts` `extractProducts` reads the product section two ways and keeps whichever finds more lines: `parseProductLine` (one line per product) and `parseMultiLineProducts` (name, then rate, then total on separate lines).
- `parseProductLine` has two paths. The pipe path (`name | rate | total`) and the multi-line reader already take the quantity from the total column and fall back to the rate only when there is no total. The plain-spaces path takes the **first** number after the name, which is the per-acre rate: `Piksi Dust Inffurow 6 g 750 g` gives quantity 6, unit `g`, confidence 100.
- That quantity becomes the blend product row a rep reviews; after approval, Create App Record files and deducts it (`20260713060200_harden_blend_unit_indeterminate_guard.sql:161` checks only that the unit matches stock). Before #2267 the `g` vs `MG` mismatch refused the Piksi line; now both are `g`, so the wrong amount passes.
- The ticket header the reader keys on is `Product  Rate/Acre  Total Product`: column 2 is the rate, column 3 is the total used.

## Outcome

The plain-spaces path reads the same columns the other two readers do: the first number after the name is the rate per acre, the next number is the total, and the total is the quantity. With no second number, the single number stays the quantity (unchanged). The unit comes from the total when the total has one, else from the rate (unchanged otherwise).

Files: `supabase/functions/process-blend-ticket/index.ts`, a new `parseProductLine.ts` beside it (so a test can import the reader without starting the server), and its Deno test. No database, screen, permission or lifecycle change. Nothing is written by the reader itself; a rep still reviews every line before the application record is created.

## Rules that always hold

- The parsed quantity is never smaller than the ticket's total because the reader took the rate.
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

## Open business decisions

None.
