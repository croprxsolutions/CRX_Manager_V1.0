## 2026-10-18 — List pages read every record instead of silently stopping at 500–2,000 (Goal 4, part 1)

Screen-only change; no database change.

- **What was wrong.** Fifteen list pages read their records in one request capped at 200, 500 or
  2,000 rows, or with no cap at all, which still meant the server's silent 1,000-row cap. Past that,
  records disappeared from the list, its filters and its totals with no warning (Orders and Invoices
  only showed a toast that disappeared after a few seconds). Live volumes on 2026-10-18 were far
  below every cap (58 orders, 34 purchase orders, 151 active customers), so nothing was being lost yet.
- **The fix.** `src/lib/pagedRead.ts` holds the shared pager. `fetchAllRows` (moved from
  `reconciliation.ts`, which re-exports it) reads 1,000 rows at a time until the end. Each paged
  query adds `id` as its last sort key, so pages never overlap. `fetchAllRowsForIds` sends a long id
  list in chunks of 200 and pages each chunk. Any failed page returns the error, so a page never shows
  a short list as if it were complete. The old "Showing first N" toasts are gone.
- **Pages:** Invoices, Orders (including its print and pick-list reads), Quotes, Blend Tickets,
  Purchase Orders (and outstanding items), Vendor Bills, Returns, Vendors, Application Records,
  Delivery Remainders, Customer Transaction Review, Commission Payments, Payment History, To Ship
  and Rebates.
- **Totals now complete:** the Invoices cards, the Vendor Bills status cards, Purchase Orders'
  outstanding value, Customer Transaction Review's debits, credits and ending balance, To Ship's
  owed amounts, and the unpaid-commission total.
- **Commission Payments item counts.** One paged read of the payment items replaces one count
  request per payment. If that read fails, every row's count shows as unverified and Post stays
  disabled on all of them (before, only the failed row was disabled).
- **Not in this change — follow-up:** Deliveries and Reports / Sales Reports keep their caps for now,
  because open PRs #954, #955 and #957 change those files. They get the same fix after those land.
  Recorded in `docs/manual/KNOWN_ISSUES.md` (list-page row caps) and under Goal 4 in
  `docs/plans/2026-10-13-direction-and-goals.md`.
