## 2026-11-23 - #2257: offline job completion no longer deadlocks with a sibling job

- Migration `20270225120000_offline_job_lock_no_key_update` changes one lock in `process_offline_action`: a job completed through offline sync now locks its job row `FOR NO KEY UPDATE`. A sibling job on the same booking completed at the same moment no longer deadlocks with it (with #2170 also applied). Same-job actions still run one after the other. No user-visible change apart from fewer retried offline completions.
- Proof: `scripts/smoke/prove-offline-job-lock-no-key-update-real-schema.mjs` on a rebuilt production schema; rollback `scripts/smoke/offline-job-lock-no-key-update-reverse.sql`.
