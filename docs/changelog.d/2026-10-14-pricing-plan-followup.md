## 2026-10-14 - Pricing plan follow-up: two review fixes deferred from PR #905

Documentation only. No code or database changed, and nothing is built.

PR #905 merged with two valid Codex review notes deferred so its approved, Sol-reviewed head could land:

- **`docs/plans/2026-10-13-pricing-history-cost-tracking-and-quote-pricing-PLAN.md`:** slice 2 now requires
  a re-send after a revision adds, removes or duplicates lines or swaps a line to a different product, because
  `create_quote_version` snapshots `product_id` and price but not `quote_item_id`. Its proof covers added,
  removed, duplicate-product and swapped-product lines.
- **`TODO.md`:** the landlord split-billing line pointed to a `KNOWN_ISSUES.md` entry that is not on main
  yet. It now points to the 2026-10-13 `DECISION_LOG.md` entry and notes that the full entry arrives with
  PR #901. It also says the trigger refuses order-linked splits, not every split: an invoice with no
  `order_id` skips the customer check.

Checked: `origin/main`'s `KNOWN_ISSUES.md` has no `INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID` entry, and PR #901
is still open.
