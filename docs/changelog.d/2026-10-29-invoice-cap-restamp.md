## 2026-10-29 — Invoice delivered-cap migration re-stamped (PR #1174)

- Brought PR #1174 up to date with main. Its migration is renamed from
  `20261028175633_cap_order_invoices_at_delivered` to
  `20261029160000_cap_order_invoices_at_delivered`, because
  `20261028185500_order_edit_and_number_concurrency` applied live first and the
  ordering guard refuses an older timestamp. The SQL is unchanged.
- Dropped the draft-only `vercel.json` setting that kept this branch from
  deploying previews; main's `ignoreCommand` stays.
