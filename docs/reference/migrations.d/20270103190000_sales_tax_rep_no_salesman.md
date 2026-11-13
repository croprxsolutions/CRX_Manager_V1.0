**LOCAL CANDIDATE — NOT APPLIED.** `20270103190000_sales_tax_rep_no_salesman.sql` (SQL sha256: `c0df52c427687cd9bb3c7c160b46211d5d89abfddc1b66805b677f0d28a0732d`). Closes a hole in `set_order_sales_tax` (20261231120000): any sales rep could change the sales tax box on a sale with no salesman.

**Why.** The who-check was `NOT (is_admin() IS TRUE OR (is_sales_rep() IS TRUE AND salesman_id = actor))`. With no salesman the rep test is NULL, so the whole test is NULL, and plpgsql skips an `IF` whose test is NULL. Found on staging 2026-11-12: Test Rep One's direct call on ORD-2026-0002 (no salesman) returned 200. The screen already locked the box.

**What it does.** Re-emits `set_order_sales_tax` with that one line changed to `(...) IS NOT TRUE`, so a NULL refuses (`SALES_TAX_NOT_ALLOWED`). Every other line is 20261231120000's text. A preflight pins the function to that text (md5 `813249eef28a1e4e1f422042a8c527d5`, owner, SECURITY DEFINER, search_path, grants); a postflight checks the new test is in place and the grants are unchanged.

**Not changed:** who may change the box (an admin, or the rep named as the sale's salesman), the drafts it moves, its replay, audit entry, grants and settings.

Proof: `scripts/smoke/smoke-sales-tax.sql` gains case F "a sale with no salesman is no rep's own". It fails on 20261231120000's function and passes after this migration (local, 2026-11-12). Apply notes: one function replaced, no data touched. Rollback (its own reviewed migration): re-emit `set_order_sales_tax` with 20261231120000's text.
