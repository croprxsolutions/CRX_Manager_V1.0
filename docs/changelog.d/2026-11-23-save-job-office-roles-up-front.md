## 2026-11-23 — #2247: the completed-job chemical refusal, security review fixes

- Same migration `20270225160000_job_transfer_below_cost_whole_line.sql` (not applied live). Its re-emitted `save_job` now refuses anyone but an active admin or sales rep up front with the writer's own `INSUFFICIENT_ROLE`, before any helper runs, including the unit clean-up of the sent chemical list (security review LOW; Luna round 3 LOW); before, those callers reached the writer, which refused them the same way.
- The job screen shows `JOB_COMPLETED_CHEMICALS_LOCKED` as its plain sentence ("This job is complete, so its chemicals can't be changed …") instead of the raw code.
- The plan contract now says which edits still save on a completed job: notes and other details that leave every chemical line as it was; a rate or acreage change that moves a quantity is refused.
- Proof: the real-schema prover passes (`JOB_TRANSFER_BELOW_COST_PROOF_PASS`), including an applicator refused `INSUFFICIENT_ROLE`.
