## 2026-11-05 — Bind retry receipts for operations batch 4e

- Candidate migration `20261111210000_bind_ops_replay_receipts_batch4e.sql` covers 15 notification, job, prepayment, field-application and quote/template actions. It requires a retry key and refuses one reused for another request or signed-in person.
- The three quote/template actions now give an exact retry the original answer. Their pinned bodies previously stored a marker and returned only “duplicate” on retry. The two bulk prepayment actions keep their existing disabled response and leave no receipt.
- Apply only after batch 4c **and** after the app update that supplies keys to notification confirmation, failed-notification logging and field applied-info saves is deployed. The migration is **not applied**. Its container-only prover uses invented records and checks both batch orders when 4d is present.
