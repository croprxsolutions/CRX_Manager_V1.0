**LOCAL CANDIDATE — NOT APPLIED.** `20270314170000_validate_rebate_claim_links.sql` (SQL sha256: `d2c9eb75659e63555ffd1a855e2ac23213f453a13b8403d79e11a89e92feb437`). Validates the selected payer and explicit program product on new admin and sales-rep rebate claims. Existing Bill Split rules supply the effective customer shares. The migration also mirrors the Rebates page restriction on program and claim reads and creation.

The existing RPC signature, saved receipts, optional links, claim transitions and program management are preserved. The database phase follows the migration that routes browser claim writes through the RPC. The separate screen phase follows the database change.

For rollback, restore the previous wrapper and expected read policies in a reviewed forward migration. Keep the earlier direct-claim-write restrictions in place. Existing claims require no data migration.
