## 2026-11-05 — KI-06: an erased invoice or payment keeps a full copy in the audit log

- New migration `20261115160000_financial_delete_snapshots.sql` (database only; no screen changes).
  When anything hard-deletes an invoice, a payment set (`allocation_sets`) or a legacy `payments` row,
  the database now writes an append-only `financial_audit_log` row holding the whole erased row.
  TRUNCATE on those three tables is refused, because it would erase rows without firing the copy.
- Why no screens PR: live read-only checks showed the app already never erases these rows. Deleting
  an invoice is soft (`deleted_at`) and deleting a payment is a void (`allocation_sets.is_active = false`);
  signed-in users have no DELETE on these tables. Only back-office (postgres or service-role)
  connections could erase them, which is how the 206 old audit rows that point at nothing were made
  (March 2026 test-era data, plus one August E2E demo invoice). Those rows are not changed.
- Proof: `scripts/smoke/prove-financial-delete-snapshots-real-schema.mjs`.
