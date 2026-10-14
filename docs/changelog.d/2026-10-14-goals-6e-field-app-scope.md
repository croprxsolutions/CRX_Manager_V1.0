## 2026-10-14 - 6e covers only the New Invoice page, not field-application invoices

Documentation only; no app or database change.

- Mason's 6e decision ("confirm 6e") was explained to him as the New Invoice page: from-scratch `misc_charge` invoices carry no product lines. As merged in PR #911, the wording said "no order, no delivery", which would also catch field-application invoices. Codex flagged this on #911 just before it merged.
- Field-application invoices have no order by design: direct field-app, blend-ticket and completed-job invoices (`invoices_field_application_has_no_order`; `docs/workflows/QUOTE_TO_DELIVERY.md`).
- `docs/plans/2026-10-13-direction-and-goals.md`, `docs/manual/DECISION_LOG.md` and `docs/manual/KNOWN_ISSUES.md` now limit the rule to the New Invoice page. Field-application invoices keep their chemical lines, and Goal 3's enforcement must not refuse them.
