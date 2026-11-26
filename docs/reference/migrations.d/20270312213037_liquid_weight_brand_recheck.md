**LOCAL CANDIDATE — NOT APPLIED.** `20270312213037_liquid_weight_brand_recheck.sql` (SQL sha256: `2b8f994223f691eb98b98947bc4a7e3e1dbeb882b81cf6958b2d81fe41423035`). Keeps the liquid Weight review switch closed and prepares two changes for its later staged activation.

- A substantive active-brand rename withdraws the prior liquid group approval while review is open. Case and surrounding ordinary spaces keep the approval. EPA and manufacturer checks still apply. Stored tickets, existing events, and waiting drafts are preserved.
- The legacy bulk approval checks the switch after taking its liquid parent locks. The later cutover can refuse while those locks are held. The security mode, owner and grants of both functions are retained.
- Run `node scripts/smoke/prove-liquid-weight-brand-recheck-real-schema.mjs` for the before/after rename, saved ticket, and closed/open review paths in disposable PostgreSQL.
- Rollback is a new reviewed migration restoring the `approve_weights` function, private brand trigger function, and trigger columns from `20270307210000_liquid_density_review.sql`. Close review before rolling back its preparation. Review history and snapshots stay intact.
