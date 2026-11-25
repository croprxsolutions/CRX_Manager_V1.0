**LOCAL CANDIDATE — NOT APPLIED.** `20270306220000_field_marker_create_receipts.sql` (SQL sha256: `967e8e1cbd7979146450c0644ca9b008edc0e0dc6b557199cc2a4e2e2c9e5e48`) reserves pin IDs after deletion so an interrupted save cannot restore a removed pin.

The new receipt contains marker identity, field, original author and timestamps. The insert trigger records the receipt in the pin transaction. Existing IDs are copied during the migration, with time limits for lock acquisition and the copy. The read-only function checks the caller's field access, receipt ownership and current pin in one snapshot.

Disposable proof runs with `node scripts/smoke/prove-field-marker-create-receipts-real-schema.mjs`. If this change needs to be withdrawn after the editor is deployed, revert the editor before changing the receipt enforcement so pending saves still resolve safely.
