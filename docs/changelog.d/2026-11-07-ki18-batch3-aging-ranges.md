## 2026-11-07 — KI-18 batch 3: statements use the AR Aging day ranges; aging takes the Chicago date

- New migration `20261208100000_ki18_batch3_aging_ranges_and_chicago_default.sql`.
- Customer statements (single, emailed and Month-End batch) now bucket overdue amounts the same way as the
  AR Aging page: 0-29, 30-59, 60-89, 90-119 and 120+ days past due (Mason, 2026-11-07). Before, an invoice
  exactly 30 days past due was "Current" on the statement and "30-59" on AR Aging.
- `get_ar_aging` used the database's UTC date when called without a date, which after 6 PM (7 PM in summer)
  Central is tomorrow. It now uses the Chicago date. Every screen already passes the Chicago date, so this
  part changes nothing on screen; it closes the last UTC "today" on the aging paths (checked live, read-only).
- Proof: `scripts/smoke/prove-ki18-batch3-aging-real-schema.mjs`.
