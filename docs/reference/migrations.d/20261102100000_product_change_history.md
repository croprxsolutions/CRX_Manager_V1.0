**LOCAL CANDIDATE — NOT APPLIED.** PR pending: `20261102100000_product_change_history.sql` (SQL sha256: `20dcec2eeb58b2c560c93c045484d5d0dd81e9e7574d58f7cd096b09768da31d`). Adds append-only product setup history written by a products trigger, with active-staff read access and no API write access. Cost and price changes remain outside this table in admin-only `cost_history`.

Rollback requires a reviewed migration removing the products trigger, both functions and the table. Dropping the table would destroy history and needs Mason's explicit approval.
