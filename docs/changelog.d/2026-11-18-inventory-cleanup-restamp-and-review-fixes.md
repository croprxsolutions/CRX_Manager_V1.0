## 2026-11-18 - Inventory clean-up (#1940): new stamp and review fixes

- The migration moves from `20270122100000` to `20270126110000`, so it sorts after staging's newest migration. Its record, rollback script, prover and screen-message references follow.
- The new delivery-line check now locks the order line `FOR UPDATE` instead of `FOR SHARE`. Two follow-up deliveries made at the same moment from one order line now queue, instead of both being refused "being edited, retry" (Taha's note).
- The rollback script narrows the cycle-count columns back to `numeric(10,2)`, so after a rollback the saved count, its variance and Complete agree again (CodeRabbit). It now refuses, changing nothing, while any count has more than 2 places, instead of silently rounding it (Sol). The prover checks both.
- Proof: `node scripts/smoke/prove-inventory-cleanup-real-schema.mjs` prints `INVENTORY_CLEANUP_PROOF_PASS`. Not applied anywhere; staging applies it after the merge.
- Known and accepted (Mason): two completions sharing two products with no Main Warehouse stock row yet, in opposite order, can still deadlock; Postgres cancels one and it is retried, as today.
