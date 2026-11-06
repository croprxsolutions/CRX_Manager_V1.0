## 2026-11-05 — Bind retry receipts for operations batch 4e

- Candidate migration `20261117110000_bind_ops_replay_receipts_batch4e.sql` covers 15 notification, job, prepayment, field-application and quote/template actions. It requires a retry key and refuses one reused for another request or signed-in person.
- The three quote/template actions now give an exact retry the original answer. Their pinned bodies previously stored a marker and returned only “duplicate” on retry. The two bulk prepayment actions keep their existing disabled response and leave no receipt.
- Apply only after batch 4d (live) and once the app update that supplies keys to notification confirmation, failed-notification logging and field applied-info saves (PR #1518, merged) is serving in production. The migration is **not applied**. Its container-only prover uses invented records and runs on the post-4d state.
