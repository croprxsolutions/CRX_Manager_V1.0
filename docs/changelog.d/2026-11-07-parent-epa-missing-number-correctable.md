## 2026-11-07 — Parent EPA correction: a missing number stays correctable (database, not yet applied)

- `20261207113000_parent_epa_correction.sql` (Sol, 2026-11-07): an invoice line with no EPA copy of its
  own now blocks a parent EPA correction only when its size has a number, because only then would the
  line show a different number. A size with no number showed none on its lines, so the correction can
  fill one in. Before, a parent and sizes with no number could never be given one.
- Proof case added to `scripts/smoke/prove-parent-epa-correction-real-schema.mjs`; the record map
  (`docs/reference/product-corrections-record-map.md`) says the same.
