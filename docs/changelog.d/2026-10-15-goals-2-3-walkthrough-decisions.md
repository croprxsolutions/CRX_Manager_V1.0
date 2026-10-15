## 2026-10-15 - Goals plan: Mason's Goal 2 and Goal 3 walkthrough decisions recorded

Documentation only. No code or database changed.

Claude walked Mason through every remaining Goal 2 and Goal 3 item, checking each against the code at
`7cd781f77`: what happens today, what the plan would change, and a recommendation for each business
choice. This change records his answers.

- **`docs/plans/2026-10-13-direction-and-goals.md`:**
  - **Cost and margin are admin-only.** Sales reps don't see them either, not even on their own invoices
    and quotes. This replaces the 2026-10-14 Goal 1 answer that reps keep cost and margin.
  - **Goal 2:**
    - only an admin sets a new customer's commission split;
    - admins get an editor for job and order splits;
    - the own-name back doors found in the code are listed (unpost, the single field-app editor,
      field billing/applied-info updates, return-to-scheduling, blend-ticket salesperson);
    - read-only scope, full customer balances and quote-split rules are recorded.
  - **Goal 3:**
    - list posting stays, with per-row "reload" refusals;
    - retries lock the form and check the first attempt;
    - voids cancel an unpaid invoice outright or auto-credit exactly that delivery's value;
    - cancelling a completed delivery is admin-only;
    - billing before delivery is removed;
    - from-scratch invoices get a description-plus-amount charge line;
    - quick delivery is improved for counter sales;
    - an admin-only field-invoice credit is built;
    - **order and delivery split billing must work now**, including landlords, partial deliveries and the
      "Bill Split" card, which today saves percentages no bill reads.
  - **Goal 5** shrinks to "completing a delivery needs a signal".
  - **Future work:** blend-ticket quote-line pricing, split billing of field-application invoices, full
    offline proof of delivery, and any Chem Man build work.
- **`docs/manual/DECISION_LOG.md`:** a new 2026-10-15 entry records these decisions.
