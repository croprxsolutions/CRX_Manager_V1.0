# Backup health alert: design (Goal 6, agent step 3)

**Status:** design only, 2026-10-19. Nothing is built. Building it needs changes in the private repo
`masonwells1/CRX_Backups` and possibly a new secret there; adding a secret is Mason's gated action.

## Problem (from `docs/plans/2026-10-18-goal-6-safety-net-findings.md`)

- The only failure signal is a GitHub email. Nobody is named to act on it.
- The Sunday workflow fails only when the dump is under 10 KB. A truncated dump over 10 KB passes.
- A run that never starts (GitHub disabled a scheduled workflow, or the schedule was skipped) produces no failure and no email at all.
- The 2026-08-30 scheduled run failed and the next dump was 10 days later.

## What should be true

1. A backup that is **bad** is a failed run: the workflow fails and says why.
2. A backup that is **missing** is noticed: someone is told within one day of the expected time.
3. Mason sees it where he already looks, in plain words, with one next step.

## Design

**A. Stronger check inside the Sunday run (in `CRX_Backups`).**
- Compare the new dump size to the previous dump. Fail if it is under 70% of the previous size (the database only grows; 89 MB live, 13.2 MB encrypted).
- Prove the **whole** archive is readable, not just its table of contents (`pg_restore --list` reads only the contents list, so a dump cut off after it would pass). Restore the decrypted dump into a disposable Postgres inside the workflow run (a service container that is thrown away), fail on any restore error, and fail if the restored table count is below the previous run's. Row counts are checked only where a drop is not a normal event: **append-only tables** (for example `inventory_transactions`) must not shrink. Tables where deletes are allowed (`customers`, `orders`, and `invoices`, where `delete_invoices` and soft deletes exist) get a warning, not a failure, when the count drops by more than 5% since the last run, and the baseline records whether `invoices` counts include soft-deleted rows. Which tables are append-only is confirmed against the delete rules when this is built. The row counts from this restore are what get written to the baseline file below.
- Record row counts for a fixed list of key tables (`customers`, `invoices`, `orders`, `inventory_transactions`, `payments`) into a small `baseline-YYYY-MM-DD.json` committed beside the dump. The restore drill compares to this file (runbook 4.6, step 5, which uses a live-count fallback until this exists).

**B. A separate missed-run watchdog (not the backup job itself).** A job that does not depend on the Sunday workflow running:
- Runs daily at **10:00 UTC** (two hours after the Sunday 08:00 UTC backup is due). Age is the **commit timestamp** of the newest file in `CRX_Backups/backups/`, compared with the current time.
- It raises the alert when that age is over **7 days 2 hours**. A missed Sunday 08:00 UTC run is therefore flagged at 10:00 UTC the same Sunday, well inside the one-day target; a normal run finishing within two hours never trips it.
- Home options, in order of preference: (1) a second scheduled workflow in `CRX_Backups` that opens a GitHub issue titled "Backup is late"; (2) the existing nightly watchdog that the Goal 6 plan mentions, reading a staleness flag. Option 1 needs no new secret because it only reads the repo it lives in.

**C. Where Mason sees it.** Both A and B end in the same place: a GitHub issue in `CRX_Backups` (the workflow **assigns the issue to Mason and mentions him by username**, because GitHub emails only people who are watching, assigned or mentioned, not merely the repo owner; the build step must also confirm Mason's GitHub notification settings send email for `CRX_Backups`, or add a second channel such as a text or email sent by a scheduled task), plus a line in the app's admin health view if one exists when this is built. The alert text is plain: "The weekly backup did not finish. Last good copy: <date>. Next step: tell your agent to check the backup."

**D. Who responds.** The recovery owner and backup person (runbook 4.2) once Mason names them. Until then, Mason.

## Not covered by this design

- File (Storage) backups: separate step; the same watchdog pattern applies once they exist, using the manifest comparison.
- Alerts for PITR (Supabase dashboard); revisit after the Pro upgrade.

## Build checklist (when approved)

1. Edit `.github/workflows/offsite-backup.yml` in `CRX_Backups`: size-ratio check, disposable-restore check, baseline file.
2. Add the daily lateness workflow (no new secret).
3. Prove it: run with deliberately damaged test dumps on a branch and watch each fail: one cut off before the end of the table of contents, and one cut off **after** it (intact contents, missing data blocks); run the lateness check against a faked old date and watch the issue open. Do not merge on "it looks right".
4. Update runbook 4.11 and the findings note.
