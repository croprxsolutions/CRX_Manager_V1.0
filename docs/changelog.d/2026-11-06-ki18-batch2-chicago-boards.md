## 2026-11-06 — KI-18 batch 2: boards, dashboards and reports use the Chicago date

- New migration `20261128110000_ki18_batch2_chicago_boards.sql`. After 6 PM (7 PM in summer) Central the
  database thought it was already tomorrow, so in the evening the Team Board, dispatch board, morning
  delivery recap, owner and customer dashboards, receiving summary, stock forecast and stale-quote list
  counted the wrong day. 13 functions now take "today" from the Chicago date; the owner dashboard's
  accounting-period name and days left read the Chicago clock too. Customer statements default to a
  date range ending on the Chicago date.
- Nothing else in those functions changes. Statement and AR aging ranges follow in batch 3.
- Proof: `scripts/smoke/prove-ki18-batch2-chicago-boards-real-schema.mjs`.
