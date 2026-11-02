## 2026-11-02 — Product setup checks (local candidate)

Added the 12-category option list and field-change product checks in a local migration. Existing invalid rows are listed and left unchanged; unrelated edits and price changes remain available. Saved form and unit values wait for WP-PM-6a before changing. The Product page validates name, rate, EPA format and whole-number REI/PHI before saving. The list's inline category editor uses the same options; imports trim identity text, validate container size and category, and show database refusals. This candidate has not been applied to production.

Live reads on 2026-11-02 (read-only): ledger high-water `20261101181836`, 1,089 rows, neither WP-PM-12a nor this migration applied; 604 products, 16 needing cleanup under the new checks (listed privately). CURRENT_STATE.md and KNOWN_ISSUES.md were re-stamped for the ledger read only.
