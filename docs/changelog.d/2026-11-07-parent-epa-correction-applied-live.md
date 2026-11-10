## 2026-11-07 — Parent EPA correction applied live, still switched off (database)

- `20261207113000_parent_epa_correction.sql` is **applied live** (ledger version `20261107201438`, PR #1611),
  with Mason's approval in chat. The correction stays switched off; no printout changes.
- Live checks after apply: `npm run smoke:live -- --spec correct_product_parent_identity` passed (rolled back).
- Wording fix to the 2026-11-06 note: one approved exception exists. A line saved while its product had no
  EPA number keeps a blank copy; after a permitted correction adds a number, the year-end summary falls back to
  the new number for that line (Mason's "Yes, allow it", `docs/manual/DECISION_LOG.md`).
- Known small gap (Sol LOW, deferred): the correction receipt's open-line count includes cancelled jobs that were
  never sprayed, so it can over-count. Display only; no data is affected.
