## 2026-11-24 — Pricing screens: converted supplier cost, clearer history, faster price sheet

Screen and file-layout changes only. No database change, and nothing that is saved changes.

- Supplier Pricing review: each cost says "for N <unit>" when the package quantity is not 1 ("per <unit>" only
  when it is 1). Before approval, each row and the approve dialog show the cost per inventory unit the database
  will record ("= $3.00 per gal"), rounded exactly as PostgreSQL rounds it, or "cannot compare to inventory units".
  A unit mismatch now states the rule only, with no conversion advice or example amount.
- Price sheet upload says whether a refused sheet expired (from its own expiry date) or was already used or
  downloaded by another user. An expired sheet is refused before any preview.
- Sell Price History names who made each change ("Price sheet · <name>").
- Cost History lists only rows where the cost really changed (the newest 20), shows "No cost" for a blank side,
  and dates in the Central business day. Change History points admins to Sell Price History and Cost History.
- Price sheet (.xlsx): locked current margins show as numbers to 2 decimals and still read back as the exact
  server text; editable margins stay text. Cost and tier price headers carry the note
  "Dollars per inventory unit (see the inventory_unit column)".
- A price sheet with supplier evidence is read in one load instead of three: about 0.5 s to 0.13 s for 1,215 rows.
  This was not the cause of the slow preview, which is still unmeasured.
