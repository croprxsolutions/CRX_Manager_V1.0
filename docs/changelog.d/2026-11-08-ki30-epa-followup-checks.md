## 2026-11-08 — KI-30: follow-up checks for the EPA corrections (migration, not applied)

- New check-only migration `20261215120000_ki30_epa_followup_checks.sql` (record in `docs/reference/migrations.d/`).
  It changes nothing; it stops if an invoice line on one of the 48 corrected products still holds an old EPA
  number, or if one of them has a product-family link. Both were 0 on live (read-only, 2026-11-08).
- Answers Sol's points on the applied `20261214100000` migration, which is never edited. Awaits Mason's approval to apply.
- Proof: `node scripts/smoke/prove-ki30-epa-corrections-real-schema.mjs` case 6.
