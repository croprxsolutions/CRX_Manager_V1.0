**LOCAL CANDIDATE — NOT APPLIED.** `20270306140000_field_marker_create_receipts.sql` (SQL sha256: `4ed30988eede223225176ca4ce7d9516121ce851e59ffe2829cfc8795db9cbb3`) reserves pin IDs after deletion so an interrupted save cannot restore a removed pin.

The new receipt contains marker identity, field, original author and timestamps. The insert trigger records the receipt in the pin transaction. Existing IDs are copied during the migration. The read-only function checks the caller's field access, receipt ownership and current pin in one snapshot.

Disposable proof runs with `node scripts/smoke/prove-field-marker-create-receipts-real-schema.mjs`. If this change needs to be withdrawn after the editor is deployed, revert the editor before changing the receipt enforcement so pending saves still resolve safely.
