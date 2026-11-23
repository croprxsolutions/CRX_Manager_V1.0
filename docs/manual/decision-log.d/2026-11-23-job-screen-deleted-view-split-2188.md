## 2026-11-23 — Job screen: deleted jobs open read-only; the refused-write recovery waits for the database fix (#2188 / #2174)

**Decision (Mason, 2026-11-23, in the session: "Yes, split it"):** the job-screen work for #2188 and #2174 ships in three steps.

1. **Now (this PR):**
   - A deleted job opens marked deleted, read-only, with no action that changes it (#2188).
   - "Assign Anyway" checks the loader numbers too (#2174 item 3).
   - The mass-edit loader range is compared exactly on the typed text (#2174 item 5).
   - A refused save or cancel keeps today's behaviour: a toast, and a save reloads the job, so a job deleted meanwhile shows as deleted.
2. **Next (#2335):** the database refuses every write to a deleted job, including completing it, which deducts stock.
3. **Last:** the "not saved" box for refused saves and cancels (#2174 items 1 and 4), rebuilt on top of #2335. Branch `fix/job-detail-deleted-2188` keeps the earlier build.

**Why:** five review rounds of the screen-side recovery kept finding new races (two things happening at once). Most of the serious ones end in the same place: the database still accepts a write to a deleted job. The screen cannot fully guard what the server allows, so the server fix comes first.

**What this forbids/implies:**
- Until #2335 lands, a tab opened before a job was deleted can still save or complete it; this PR only stops the screen from offering those actions once it knows.
- Server-side cancel logging stays with #2334; reloads that overwrite typing after an ordinary save stay with #2342.
- This supersedes the round-2 "reload at once and keep the typed text" design (Mason's round-1 and round-2 answers, recorded on branch `fix/job-detail-deleted-2188`); that design returns with step 3.
