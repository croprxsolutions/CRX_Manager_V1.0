## 2026-11-26 — Crew prints and Job Detail read a job and its chemicals in two steps

**Severity:** LOW. **Area:** Applicator screens (Job Detail, field sheet, loader worksheet, chemical report). **Status:** OPEN.
**Owner:** unassigned. **Tracked:** #2574 (follow-ups section; Sol round 3 MED, deferred with Mason's OK 2026-11-26).

Since #2574, non-office users load a job from `jobs_crew` and its chemicals from `job_chemicals_crew` in two
separate requests (the views cannot be embedded in one request). If an office user saves the job between those
two requests, an applicator's print or Job Detail can pair the old acres with the new chemical amounts. Office
users still read in one request and are not affected. Rare in practice (needs an office save during the crew
read); the fix is a single crew read (one RPC or view returning job plus chemicals), best done with the step-3
database lockdown.

PR 3 (the base-table lockdown) does not fix this: the fix is a single crew read function, which must land database-first and then be adopted by `JobDetail.tsx` and the print path in a separate app PR.
