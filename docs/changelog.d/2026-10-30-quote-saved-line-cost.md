## 2026-10-30 — After Save, an admin sees the cost the database recorded for each line (KI-82)

- KI-82 (found by Sol on #1105): after Save, Quote Builder kept the cost it loaded, so a line
  added (or switched to another product) after that product's cost changed showed a stale Cost,
  Profit and Margin to an admin until reload. Saved figures were always right; display only.
- Now, after an admin's save, Quote Builder re-reads each saved line's recorded cost through
  `get_admin_cost_fields` (admin-only, as on load). A line whose cost differs is refreshed, along
  with the product's cost today, so it never shows a stale "today" cost beside the recorded one.
  The just-saved quote is not marked as changed. Sales reps are unchanged (they never see cost).
- Proof:
  - Quote Builder test "shows each saved line's recorded cost after Save, without marking the
    quote changed".
  - Local screen check on a draft: a product's cost rose from $5.85 to $6.40 after the page
    loaded, and a new line of it showed $5.85 before Save. After Save it showed $6.40, today
    $6.40, profit $7.30, margin 10.2%, matching `quote_items` (640 cents, profit 7.30), with no
    unsaved-changes prompt.
