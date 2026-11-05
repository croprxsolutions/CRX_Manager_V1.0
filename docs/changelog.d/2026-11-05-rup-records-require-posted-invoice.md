## 2026-11-05 — RUP register rows only for a posted invoice (KI-05)

- New migration `20261110140000_rup_records_require_posted_invoice.sql` (record in `docs/reference/migrations.d/`):
  `generate_rup_sales_records` now refuses an invoice that is not posted (status other than `posted`, `paid` or
  `overdue`, or deleted) with `RUP_INVOICE_NOT_POSTED: invoice <number> is <status> and not posted`. Before, any
  active admin or sales rep could call it directly and write restricted-use-pesticide register rows for a draft.
- A new trigger on `rup_sales_records` applies the same rule to a direct insert (the `rup_sales_insert` policy lets an
  active admin insert), so no path can record a sale for an unposted invoice. Only `generate_rup_sales_records` inserts
  there (live read-only 2026-11-05) and live holds 0 register rows.
- The invoice row is read `FOR SHARE`, so it cannot be unposted while its rows are written. A refused call writes
  nothing (no register row, no idempotency receipt).
- Unchanged: the role gate, the idempotency replay, every other line of the body, SECURITY DEFINER,
  `search_path = public, pg_temp` and the grants (`authenticated`, `postgres`, `service_role`). The preflight pins the
  live body (md5 `18802cbd…`, read 2026-11-05, identical to `20260707040000`).
- Callers (live read-only 2026-11-05): only `_post_invoice_impl_20260714` and
  `_post_deleted_delivery_recovery_invoice_20260719`, and both set `status = 'posted'` before the call, so posting
  still writes the rows. No screen calls it.
- Proof: `node scripts/smoke/prove-rup-records-require-posted-invoice-real-schema.mjs`
  (`RUP_RECORDS_REQUIRE_POSTED_INVOICE_PROOF_PASS`).
- Applied live 2026-11-05 21:32:09 UTC (3:32 PM Central), ledger `20261105213209`; the live smoke chain passed
  (a real draft invoice is refused, posting still writes the register row) and rolled back.
