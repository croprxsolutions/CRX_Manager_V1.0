**LOCAL CANDIDATE — NOT APPLIED.** `20270306140000_field_marker_create_receipts.sql` (SQL sha256: `de5e40cdf9fa4c58ae15dcfbf688541857fa35f58c51b29c7fc9750a4a065479`) reserves pin IDs after deletion so an interrupted save cannot restore a removed pin.

The new receipt contains marker identity, field, original author and timestamps. The insert trigger records the receipt in the pin transaction. Existing IDs are copied during the migration, with time limits for lock acquisition and the copy. The read-only function checks the caller's field access, receipt ownership and current pin in one snapshot.

Disposable proof runs with `node scripts/smoke/prove-field-marker-create-receipts-real-schema.mjs`. If this change needs to be withdrawn after the editor is deployed, revert the editor before changing the receipt enforcement so pending saves still resolve safely.
