## 2026-11-08 — Jobs reach the Dispatch Board when their applicator is re-activated or made an applicator (KI-28, database)

- New migration `20261215100000_dispatch_sync_on_applicator_qualify.sql` (record in `docs/reference/migrations.d/`).
  A job assigned to someone who was inactive, or not an applicator, used to stay off the Dispatch Board for good.
  Now, the moment that person becomes an active applicator, each location of their open jobs that has no board
  row is dispatched to them, even if their license has expired (Mason's decision, the same as adding a location).
  Applying the file also dispatches any such location already waiting.
- A job assignment or a new location at the same instant waits for the activation, so none is missed.
- Left alone: locations already split or undispatched on the board, and finished or deleted jobs.
- Proof: `node scripts/smoke/prove-dispatch-sync-on-applicator-qualify-real-schema.mjs` (disposable real-schema database).
- Preventive: the detection sweep found 0 such jobs live on 2026-11-08. Not applied live yet.
