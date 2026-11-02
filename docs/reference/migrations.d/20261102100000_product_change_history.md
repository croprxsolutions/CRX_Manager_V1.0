**LOCAL CANDIDATE — NOT APPLIED.** PR pending: `20261102100000_product_change_history.sql` (SQL sha256: `433fadddd6ad63c2b1a31c02e3d3e000d089aa06bcc9b8563fea7a37b23986c8`). Adds append-only product setup history written by a products trigger, with read access for every active staff profile (including drivers and applicators) and no API write access. A signed-in admin product insert records that admin as actor. Numeric scale and blank/NULL text differences do not make false change rows. `notes`, `internal_notes`, `quoting_notes`, and `product_family_id` changes store the field name with NULL old/new values. Every newly created product has a history row and must be retired rather than hard-deleted. Cost and price changes remain outside this table in admin-only `cost_history`.

Rollback requires a reviewed migration removing the products trigger, both functions and the table. Dropping the table would destroy history and needs Mason's explicit approval.

The apply gate reads this file as deleting data, because of the word TRUNCATE in the append-only guard and its privilege checks. Nothing is deleted. It needs Mason's own `I approve` for this exact file at apply.

Every product created after apply has a history row and cannot be hard-deleted, so a data clean-up must retire a product, never delete it.
