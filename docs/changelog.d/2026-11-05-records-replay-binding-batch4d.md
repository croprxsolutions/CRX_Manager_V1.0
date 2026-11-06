## 2026-11-05 — Bind retry receipts for records batch 4d

- Candidate migration `20261114200000_bind_records_replay_receipts_batch4d.sql` covers 25 profile, blend-ticket, label, vendor, field and application-record actions. A retry key is required. A key reused for another request or signed-in person is refused before the saved answer is returned.
- The original permissions and validation run before receipt lookup. The deferred database guard prevents an unbound receipt from committing. The pinned original bodies remain callable only by PostgreSQL itself.
- Saving a blend recipe through the database now also requires an admin or sales rep, as the app's two recipe screens already do; before, any signed-in user could create one directly.
- Apply after batch 4c. The migration is **not applied**. Its container-only prover uses invented records and checks both batch orders when 4e is present.
