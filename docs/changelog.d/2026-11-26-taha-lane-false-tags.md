## 2026-11-26 — Fewer false Taha-lane tags

Mason's answers to a survey of PRs the Taha-lane rule tagged since 2026-11-04:

- **#2381** (parent EPA): the customer year-end summary functions are no longer Taha's.
- **#2267** (Piksi grams): a migration named for a product's units may lock tables and UPDATE the unit and quantity columns of order and quote lines (any other change to those tables still counts); every other lane table and function still counts.
- **#2451** (office menu): a change to one of Taha's screens that only edits labels, text or comments no longer counts. Its A/R tab move and redirect are code, so that PR would still be tagged.
- **Delivery completion** stays Taha's.
- **The `taha-ready` bot** no longer labels or pings Taha for back-merges straight from `main`, or for PRs that only change the lane block's own files. Mason's code is still needed to merge them.
