## 2026-10-20 — the prepay screens count overdue invoices

- **Problem.** The Prepayment Manager's unpaid-invoice totals and the prepay workspace's Apply step
  read only `posted` invoices. The 6am cron job `mark-overdue-invoices` flips a past-due posted invoice
  to `overdue`, so a prepay customer's past-due invoices dropped out of the manager's totals and could
  not be picked in the Apply step. Payment Allocation already had this fix (U1 #41). Found by the
  compliance reviewer on PR #988 and listed in the 2026-10-15 and 2026-10-20 Goal 4 audits.
- **Check before the change (live, read-only).** The Apply step saves through `batch_apply_prepayments`,
  which applies each line through `apply_prepay_to_invoice`. Its body accepts `posted` or `overdue`
  invoices and refuses anything else. The manager's two bulk buttons call `apply_remaining_prepayments`
  and `batch_apply_all_prepayments`. Those read `posted` only, but both raise
  `PREPAY_BULK_APPLY_DISABLED` as their first statement, so they apply nothing either way.
- **Change.** `PrepaymentManagerPanel.tsx` and `PrepayWorkspacePanel.tsx` read
  `status in ('posted', 'overdue')`. The paged reads from PR #988 are unchanged. No database change.
- **Proof.**
  - `src/pages/MoneyScreens.paging.test.tsx` has two new tests. Each screen gets a posted invoice, an
    overdue one, a void one and a draft one. Both tests fail on the old `posted`-only reads. Both pass
    with the fix: the manager counts 2 invoices and $3.00, and the Apply step lists the overdue invoice
    but not the void or draft one.
  - The new filter was run read-only against live on 2026-10-20. It finds 2 unpaid invoices
    ($41,737.40), both overdue. The old filter found 0. The invoice status constraint allows both values.
    Both customers have no prepay balance today, so the live screens look the same until a prepay
    customer's invoice goes past due.
- **Not changed (follow-up).** The manager still shows its bulk "Apply" buttons. Their database
  functions are disabled, so pressing one only shows an error.
