## 2026-11-23 — Job stale-edit check ships screen-only; database check is a follow-up

**Decision (Mason, 2026-11-23):** ship #2337's screen-only "this job changed since you opened it" check with its known timing gaps, and do the database-side check (inside `save_job`) as a separate follow-up.
**Why:** the screen check stops almost every silent overwrite today; the gaps left (two saves in the same second, a refused retry after a lost reply, a dispatcher's same-second change right after the Dispatch wizard) need a database change, which is its own reviewed PR and live apply.
**What this forbids/implies:** #2337 may land with those gaps named; do not patch them further on the screen. The follow-up moves the compare into `save_job` under a row lock, after the idempotency replay check.
