## 2026-11-24 — Label Data Quality counts "label gives no REI/PHI" as covered

- Migration `20270304110000_label_coverage_counts_not_applicable.sql` (NOT APPLIED; needs `20270303130000` first):
  `get_label_coverage_report` counts a product as covered for REI (or PHI) when it has a number or its
  "label gives no REI/PHI" tick is set. Same keys, admin check and grants. Mason's decision on #2500.
- Label Data Quality and Label Review screens: the two coverage labels read "REI (number or none)" and "PHI (number or none)".
