## 2026-10-22 - Goal 3 "Post uses what was saved and reviewed" is live

- Migration `20261022022000_post_binds_reviewed_invoice_version` (migration-history row 968) was
  applied live at 7:42 PM Central on Mason's in-chat `I approve` (ledger version `20261023004246`).
  PR #1018 merged right after as `3ab57a80c`, and the app deploy finished at 7:53 PM Central.
- Live check: on a draft invoice, one unsaved edit greys out Post ("Save your changes before
  posting"). Nothing was saved or posted.
- Recorded in `docs/reference/migration-history.md` (row 968 and the live capture), `rpc-functions.md`,
  `CURRENT_STATE.md`, `KNOWN_ISSUES.md` (the 2026-10-09 editor entry is resolved) and `TO_DO_LIST.md`
  (item 3.1 is done). The schema registry was regenerated: only the high-water and the applied name
  changed.
- New KNOWN_ISSUES entry: the adversarial money/inventory smoke chain now fails live at its bulk-PO
  step, because row 962 strips non-admin purchase-order costs.
- Three older smoke chains (`smoke-adversarial-money-inventory-closeout.sql`,
  `smoke-field-invoice-loop.sql`, `smoke-govern-invoice-order-money-lifecycle.sql`) now call whichever
  `post_invoice` signature the database has, so container proofs that replay only up to an earlier
  candidate can run them again.
