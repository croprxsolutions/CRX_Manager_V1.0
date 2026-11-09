**LOCAL CANDIDATE — NOT APPLIED; awaiting Mason's approval (PR #1653).** `20261215120000_ki30_epa_followup_checks.sql` (SQL sha256: `864a52d27808cbf949132aa49c996be42621d47f9d25aa9f40a110424f47640f`). KI-30 follow-up to `20261214100000_ki30_epa_registration_corrections` (applied live 2026-11-08). Checks only: no row, schema, function, grant or policy changes. For the same 48 products it stops with `KI30F_STALE_INVOICE_LINE` if any invoice line (draft or posted) still holds a non-blank EPA number other than the corrected one (the invoice PDF prefers that saved copy), and with `KI30F_FAMILY_LINK` if any has `products.product_family_id` set. On a database without these products both checks find nothing and it passes, so it replays normally.

**Live capture — 2026-11-08 (read-only):** all 48 product ids hold exactly the corrected number listed in the file; the only 2 invoice lines on them hold no EPA copy; 0 have `product_family_id` set.

**Proof:** `node scripts/smoke/prove-ki30-epa-corrections-real-schema.mjs` case 6 (passes and changes nothing after the correction; a stale invoice copy or a family link stops it).

**Rollback:** nothing to roll back.
