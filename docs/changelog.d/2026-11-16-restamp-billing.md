## 2026-11-16 - billing migrations re-dated above main's newest (#1868)

The three staging-only billing migrations sorted below main's newest (`20270109100000_delivery_receipt_brands`),
so `db-apply.mjs stamp-check origin/main` failed and Sol refused every Sol-list PR into `staging`. Each file is
renamed with byte-identical SQL (same sha256), keeping their order:

| Was | Now |
|---|---|
| `20261231110000_standing_grower_discount` | `20270109100100_standing_grower_discount` |
| `20261231120000_sales_tax_checkbox` | `20270109100200_sales_tax_checkbox` |
| `20270103190000_sales_tax_rep_no_salesman` | `20270109100300_sales_tax_rep_no_salesman` |

All three already ran on staging (drift 0, schema 0 on the 2026-11-16 nightly), so the staging job renames their
ledger rows instead of running them again (#1837). The new stamps sit above main's newest and below the queued
PRs (from `20270109110000`). Their docs, smoke specs and code comments follow the new names.
