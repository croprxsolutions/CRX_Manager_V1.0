## 2026-11-11 — "Consolidate drafts" removed from the order page

- The button failed on every click since July: invoice lines can't move from one invoice to another
  (20260721), and each delivery now bills on its own invoice, capped at what it delivered.
- The button and its handler are gone; the database call is unchanged (it can't merge, so it changes nothing).
  Retiring the call itself waits for Mason's OK.
