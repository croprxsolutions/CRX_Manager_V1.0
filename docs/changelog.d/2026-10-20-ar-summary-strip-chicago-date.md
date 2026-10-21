## 2026-10-20 — Accounts Receivable summary strip asks for Chicago's date, not UTC's

The "Net Money Position" strip at the top of Accounts Receivable asked `get_ar_aging` for
`new Date().toISOString().slice(0, 10)`, a UTC date. From about 7pm Central UTC is already
tomorrow, so in the evening the strip asked for tomorrow's aging while the AR Aging table
under it (which used the browser's own date) asked for today's, and the two could disagree.

- `src/pages/AccountsReceivable.tsx`: the strip now uses `todayInBusinessTz()` (Chicago). Its
  paged read (every row, `count: 'exact'`, largest balance first then customer id) is unchanged.
- `src/pages/ARaging.tsx`: the table's default as-of date also uses `todayInBusinessTz()`, so the
  strip and the table ask for the same day whatever the viewer's computer clock says. The date
  box is still editable; reminder and statement dates are unchanged.
- `src/pages/AccountsReceivable.businessDate.test.tsx`: pins the clock to 8:30pm Central with the
  computer set to UTC and checks every `get_ar_aging` call asks for 2026-10-20. It fails if either
  screen goes back to its old clock.
- `docs/manual/KNOWN_ISSUES.md`: the UTC as-of-date note no longer lists the strip.

Screen-only; no database change.
