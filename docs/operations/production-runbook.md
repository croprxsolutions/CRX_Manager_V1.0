# CRX Manager — Production Runbook

**Last updated:** 2026-10-14 (deploy section now points at the current landing, migration and Edge Function procedures; stale counts and paths corrected). Earlier: 2026-07-16 (backup/recovery section rewritten to FREE-plan reality; revert path updated to the PR-only landing flow)
**Audience:** Mason (owner) and any future on-call admin.
**Scope:** day-to-day operations, deploys, rollbacks, incident response, and recurring maintenance for the production system.

---

## 1. System landscape

| Component | Where it runs | Dashboard / CLI |
|---|---|---|
| Frontend | Vercel (production) | https://vercel.com/dashboard |
| Live URL | https://croprxsolutions.app | — |
| Database | Supabase project `rhyzpcqhnizqbxphqdkr` | https://supabase.com/dashboard/project/rhyzpcqhnizqbxphqdkr |
| Edge Functions | Supabase (one per folder in `supabase/functions/`, excluding `_shared`) | Supabase → Edge Functions tab |
| Email | Resend (via `send-email` Edge Function) | https://resend.com/dashboard |
| OCR | Google Vision API (via `process-blend-ticket` and `process-document`) | https://console.cloud.google.com |
| Repo | GitHub `masonwells1/CRX_Manager_V1.0` | https://github.com/masonwells1/CRX_Manager_V1.0 |
| CI | GitHub Actions (`.github/workflows/ci.yml`) | Repo → Actions tab |
| Error tracking | Sentry | https://sentry.io |

**Stack:** React 19 + TypeScript + Vite + Tailwind + Supabase + Vercel.

---

## 2. Deploy

The step-by-step procedures live in `DEPLOYMENT.md` and `.claude/commands/ship.md` (the file
`AGENTS.md` routes pushes, merges and releases to); this section only summarizes them.

### 2.1 Normal deploy (frontend)

Vercel builds a preview for every PR and deploys production when a PR merges into `main`.
Nobody pushes to `main` directly — the `protect-main` ruleset rejects it.

1. Open a PR. CodeRabbit reviews it automatically and CI runs the required checks.
2. The PR merges only through the protected path in `.claude/commands/ship.md` Step 8:
   CodeRabbit APPROVED on the exact head, every check green, a fresh exact-SHA Sol review
   (except a documentation-only change, `docs/reference/sol-exempt-paths.md`), then
   `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`.
3. Watch [Vercel deployments](https://vercel.com/dashboard) until the new build is "Ready."
4. Hit https://croprxsolutions.app → hard refresh → confirm the new build.

A preview deployment talks to the live database (there is no staging project yet), so do
not create or change records while checking one.

### 2.2 Database migration deploy

Migrations are SQL files in `supabase/migrations/`. An agent applies them through
`scripts/apply-migration-file.mjs` (dry run first, then `--confirm`) after the PR's reviews
pass — not by `npx supabase db push`, and not through the MCP `apply_migration` tool, which
cannot pass the apply guard. The full sequence, including which migrations wait for Mason's
own approval, is in `DEPLOYMENT.md` and `.claude/commands/ship.md` Step 5. Record each
change in a new `docs/changelog.d/<YYYY-MM-DD>-<slug>.md` entry and in
`docs/reference/migration-history.md`.

### 2.3 Edge Function deploy

Edge Functions live in `supabase/functions/<function-name>/` (`_shared/` is shared code, not
a function). Each has its own `index.ts` and runs on Deno. **Every Edge Function deploy
needs Mason's explicit approval in the current conversation** (`AGENTS.md`). Agents use the
`deploy-edge-function` skill, which runs the pre-flight checks and a post-deploy smoke test.

### 2.4 Required environment variables

**Vercel project:** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are required;
`VITE_MAPBOX_TOKEN` and `VITE_SENTRY_DSN` are optional (`.env.example`).

**Supabase Edge Function secrets:** see the "Edge Function secrets" table in `DEPLOYMENT.md`,
which is the single list. `SUPABASE_SERVICE_ROLE_KEY` is present automatically; never expose
it to the frontend. When `SENTRY_DSN` is unset, `captureEdgeException` logs a
`SENTRY_MISCONFIG` warning instead of reporting.

---

## 3. Rollback

### 3.1 Rolling back the frontend

**Fastest path — Vercel "Promote to Production":**
1. Vercel Dashboard → Deployments tab.
2. Find the last known-good deployment (look at commit hash).
3. Click "..." → "Promote to Production."
4. Confirm. Live URL points at the old build within ~30 seconds.

**Alternative — git revert via a PR** (direct pushes to `main` are impossible — the
`protect-main` ruleset rejects them for everyone):
```bash
git checkout -b revert/<short-name> origin/main
git revert <bad-commit-sha>
git push -u origin revert/<short-name>
gh pr create --fill
```
The revert PR then lands through the normal protected path (`.claude/commands/ship.md`
Step 8; `--auto` is refused by the merge gates). The merge to `main` auto-deploys the revert via Vercel. (The Vercel dashboard
rollback above is faster — prefer it mid-incident.)

### 3.2 Rolling back a database migration

**Migrations are append-only — there is no "down" script.** If a migration introduced a bug:

1. **DO NOT** delete or modify the bad migration file in git history.
2. Write a NEW migration that reverses the bad changes (drop columns added, restore prior function definitions, etc.).
3. Apply it through the normal migration path (§2.2).
4. Confirm app works against the reversed state.

**Worst-case (data corruption):** restore from the `CRX_Backups` dump or the in-database
`backup_snapshots` (see §4.4 and §4.6). There is no Supabase point-in-time recovery on the FREE plan.

### 3.3 Rolling back an Edge Function

Edge Functions are versioned by deploy. To roll back, redeploy the prior version's source code
(a redeploy is an Edge Function deploy, so it needs Mason's explicit approval first):

```bash
git checkout <good-sha> -- supabase/functions/<fn-name>/
npx supabase functions deploy <fn-name> --project-ref rhyzpcqhnizqbxphqdkr
git checkout HEAD -- supabase/functions/<fn-name>/
```

---

## 4. Backups and disaster recovery

> **Rewritten 2026-10-19** from the Goal 6 findings (`docs/plans/2026-10-18-goal-6-safety-net-findings.md`).
> **Today (live check 2026-10-18): the Supabase org is on the FREE plan. There is no PITR and
> no usable Supabase daily backup.** Parts marked **AFTER PRO + PITR** describe the target state
> Mason decided on 2026-10-13. They are not true until an agent re-checks the plan live and
> records it. Recovery target (Mason, 2026-10-14): an outage may last overnight, CRX is back by
> the next business morning, and lost work is minutes, not a day.

### 4.1 What is backed up

| Copy | Where | Covers | Does NOT cover |
|---|---|---|---|
| Weekly encrypted `pg_dump` | Private repo `masonwells1/CRX_Backups`, workflow `.github/workflows/offsite-backup.yml` (this repo has no backup workflow). Sundays 08:00 UTC, newest 8 kept. | Database rows. | Uploaded files. Whether the `auth` schema (logins) is included is **unverified** until a drill decrypts one. |
| Weekly in-database snapshot | `pg_cron` job `weekly-db-backup` into `backup_snapshots`, 8 weeks. | Bad-data mistakes in a table that still exists. | Losing the project (same database). |
| Storage files (photos, signatures, documents; nine buckets) | **Nothing.** | n/a | Everything. Delivery photos and signatures are staff evidence, not re-obtainable from the customer. |
| Edge Function source, app code | Git. | Code. | n/a |
| Vercel deployments | About 30 days; any past deployment can be promoted. | Frontend. | n/a |
| **AFTER PRO + PITR:** point-in-time recovery | Supabase. | Database to any minute inside the window. PITR is a paid add-on and needs at least Small compute. | Uploaded files (neither Pro nor PITR backs up Storage bytes). |

Until the file backup exists (Goal 6, agent step 2), a lost Storage bucket cannot be recovered.
Say so plainly if it happens; do not promise a restore.

### 4.2 Who runs recovery

Recovery owner: **Mason Wells**. Backup person: **Mason Wells (no second person named yet)**.
The dump passphrase lives only in Mason's password manager, so Mason is currently the single
point of failure. Both people need GitHub access to `CRX_Backups`, the passphrase, Supabase org
access and Vercel access. Replace the backup person with a second human the day one is chosen.

### 4.3 Decide which recovery you need

| Situation | Path |
|---|---|
| A few wrong rows, table intact | 4.4 Compensating fix from a snapshot |
| A bad change just wrote wrong data across many rows | **AFTER PRO + PITR:** 4.5 Rewind. Until then: 4.4 for small damage, 4.6 for large. |
| Project lost or corrupted | 4.6 Restore into a new project |
| A Storage bucket lost | Not recoverable today (no file backup). Tell Mason. |
| Site down but data fine | Section 6.1, not this section |

**First, always:** stop the damage and tell Mason in plain words what is wrong. Pause anything that
writes (scheduled jobs, imports) if the cause is unknown. Write down the clock time you noticed
it for the incident timeline. Discovery time is not the restore point: the restore point is the last
moment **before the bad change began** (4.5), which may be earlier than when anyone noticed.

### 4.4 Compensating fix from a snapshot (table intact)

1. Read `backup_snapshots` for the affected table (read-only `SELECT`).
2. Compare to live and list exactly which rows differ.
3. Write the fix as a normal reviewed migration. Never edit an applied migration. Changing live
   data outside a reviewed migration needs Mason's approval in that conversation.

### 4.5 Rewind to a time (AFTER PRO + PITR; not available today)

1. Pick the restore time: the last moment before the bad change, in UTC. Give Mason the Central equivalent.
2. Prefer restoring into a **new** project and copying back only what is wrong. Rewinding production
   discards every legitimate write after that time; Mason approves that trade-off first.
3. **A Supabase clone starts the copied scheduled jobs (`pg_cron`), webhooks and wrappers immediately**
   (Supabase clone-project docs), with no chance to pause them first. So disable every `pg_cron` job
   (`cron.job`) and webhook in the copy before connecting the app, and note what may have run in the
   minutes before you could. If that is not acceptable, use the logical dump path (4.6), which brings
   no scheduled jobs.
4. Run the post-restore checklist (4.7) before anything resumes syncing.
5. Log it in the drill log (4.9) with timings.

### 4.6 Restore the newest dump into a new project

1. Create a **new** Supabase project (never overwrite production). A second project may cost money: Mason approves.
2. Clone `masonwells1/CRX_Backups` and choose the archive `backups/crx-backup-YYYY-MM-DD.dump.gpg`:
   the **newest** when the project is lost; for **corruption**, the newest archive taken **before the bad
   change began** (the newest one may already contain the damage). The repo keeps 8, so corruption older
   than about 8 weeks cannot be undone this way. Say which you chose and why in the drill log.
3. Decrypt with the passphrase from Mason's password manager. Never paste it into chat or a file.
4. Restore with `pg_restore` using the **Session pooler** connection string (IPv4). Keep
   scheduled jobs **off during reconciliation**: confirm `cron.job` in the new project is empty or inactive
   before the app is pointed at it. They are put back at the end (4.7, last item), not forgotten.
5. Validate. **Future (once the alert design is built):** compare against the baseline file
   `baseline-YYYY-MM-DD.json` stored beside the dump. **Today no baseline exists.** If the project
   is **lost** (no live database to count), validate without live counts: the restore finishes with no
   errors; the key tables are not empty; no table's newest `created_at` is after the dump date, and the busiest tables (`invoices`, `inventory_transactions`) have one within a few days of it in season (do not apply this to low-volume tables such as `allocation_sets` or `prepay_credits`, which may have no new rows for days);
   internal checks hold (every invoice total equals the sum of its lines, every order and invoice points to
   a customer that exists, every profile has a matching login); and several of the most recent invoice
   numbers before the dump match an outside record (QuickBooks, Chem Man, email, paper tickets).
   Also, each Monday backup check below saves a dated list of live row counts for the tables named here
   to a place that survives losing the project (the `CRX_Backups` repo), so a lost-project restore
   can compare to the most recent one.
   If the project is **still reachable** (a drill, or corruption), also use this fallback:
   read live row counts for `customers`, `invoices`, `orders`, `inventory_transactions`, `allocation_sets` and `prepay_credits` (the live payment tables; the old `payments` table is dead and must not be used)
   just before the drill and note the dump date. Treat a table as **append-only** only if no one can delete from it; today
   that is just `inventory_transactions` (confirm against the delete rules at drill time). For it, the restored
   count must be at or below live and close to it (rows written since the dump are missing, never extra).
   Everything else, including `allocation_sets` and `prepay_credits` (admins can delete from both; count
   voided rows too, since voiding changes status, not row count), `customers`, `orders` and `invoices`,
   is mutable: the restored count may be above live if records were deleted after the dump: list the difference and
   explain it from the activity log rather than failing the drill. In every table the newest `created_at`
   must not be after the dump time. Spot-check a few known recent invoices by number. Record the numbers
   in the drill log.
6. Check logins: confirm users exist in `auth.users` in the restored copy, with the **same IDs** as
   `profiles.id` (each profile's ID is its login's ID, so the two must match). If the dump lacks
   `auth.users`, do not just re-create logins: new logins get new IDs and would not inherit their restored
   profiles, roles or records. Either restore the original user IDs, or relink and validate every
   identity-dependent row before cutover (this needs its own reviewed plan and Mason's approval; stop and
   escalate rather than improvising). Record which case applied. Matching rows are not proof: before
   cutover, **sign in with a real password for one account of every active role** (admin, sales rep, and
   each other role in use) and check each can open the screens and data that role should, and cannot open
   what it should not. One admin test is not enough.
7. Work lost is everything written after the dump time: up to about 7 days today, more if a Sunday run was missed.
8. A dump holds the database only. A new project has **no Edge Functions and no secrets**. Before going
   live on the restored copy: deploy every function directory under `supabase/functions/` to it, install
   every required secret (from the password manager, never pasted into chat), and smoke-test each function
   (`send-email`, `create-user`, `reset-user-password`, `process-document`, `process-blend-ticket`,
   `customer-document-files`, `epa-lookup`, `setup-blend-tickets-storage`; the directory listing is
   authoritative). The Content Security Policy in `vercel.json` allows connections only to the current project's host
   (`rhyzpcqhnizqbxphqdkr.supabase.co`), so the new project's host must be added there and deployed through
   the normal PR path first, or browsers will block every request after cutover. Also set the new project's
   Auth **Site URL** to `https://croprxsolutions.app` and add `https://croprxsolutions.app/reset-password`
   (and any other redirect the app uses) to its redirect allow list, then test a password reset; otherwise
   password recovery fails after cutover. **Turn public signup off** in the new project's Auth settings
   and verify it (a direct signup request must be refused) before exposing it: a new project defaults to
   signup on, and the profile-creation trigger copies a role from the signup request, so open signup could
   let a stranger create an admin profile. Auth changes need Mason's explicit approval. Only then repoint the
   Vercel environment variables to the new project and redeploy.
   Deploying functions, installing secrets and changing production configuration each need Mason's
   explicit approval in the current conversation.
9. Run the post-restore checklist (4.7).

### 4.7 After any restore: nothing may happen twice

Before scheduled jobs, QuickBooks sync, payment notifications or email sending resume, reconcile what
the real world already did after the restore point:

- **Payments:** list payments settled after the restore time (Stripe once Goal 7 ships; until then, bank deposits and checks). Each must exist in CRX exactly once.
- **QuickBooks (once Goal 7 ships):** list entries already written after the restore time. Do not re-send them; link them.
- **Email:** the Resend logs (30 days) show what was already sent. Do not re-send invoices or receipts customers already got.
- **Deliveries and stock:** drivers may have completed deliveries after the restore time. Re-apply them from the tickets through the normal screens.
- **Commissions and payouts:** compare any payout paid after the restore time.
- **Scheduled jobs (last):** only after everything above is reconciled, put the `pg_cron` jobs back. The
  logical dump path leaves `cron.job` empty and nothing recreates it by itself. Compare against the job list
  in the repository's migrations (for example `mark-overdue-invoices`, `auto-expire-quotes`,
  `check-unpriced-orders`, `data-integrity-sweep`, `weekly-db-backup`; the migrations are authoritative),
  re-create them through a reviewed migration, and verify the live `cron.job` list matches before calling
  recovery complete.

Goal 7 completes the payment and QuickBooks lines; keep this section in step with it.

### 4.8 Outage paper fallback

The office keeps working while CRX is down overnight:

- **Dispatch:** the last printed delivery schedule, plus phone calls to drivers.
- **Deliveries:** a paper ticket recording customer, product, quantity, date, signer name and signature. Photograph it.
- **Payments:** a paper log of checks and cash: customer, invoice number, amount, date, method.
- Afterward, enter everything through the normal screens, oldest first, ticking each off the log.

Not yet rehearsed. Log the first rehearsal in 4.9.

### 4.9 Drill log (quarterly; the first is overdue)

Run 4.6 against a throwaway project each quarter. Record the date, backup file, who ran it, minutes
per step, whether validation matched, whether logins were present, and problems. Rewind drills
(after Pro + PITR), file-restore drills (after the file backup exists) and the paper rehearsal go in the same table.

| Date | Type | Backup used | Total time | Validation match | Logins present | Notes |
|---|---|---|---|---|---|---|
| _none yet_ | | | | | | |

### 4.10 What is NOT in any backup

- `.env` secrets (they live in Vercel and Supabase). Keep offline copies in a password manager: Supabase service role key, Resend API key, Mapbox token, Sentry DSN, Vercel deploy hooks, and the dump passphrase (a second entry for the backup person).
- Resend email logs (30 days), Sentry history, GitHub Actions logs (90 days).

### 4.11 Backup health alerting

Design: `docs/operations/backup-health-alert-design.md`. Today a **failed** Sunday run sends a GitHub
email, but a run that **never starts has no alert at all**: the missed-run watchdog is designed, not built.
Until it is, every Monday check the date of the newest file in `CRX_Backups/backups/`. That confirms
freshness only; it does **not** prove the dump is complete (a truncated dump over 10 KB passes today's
workflow). So also, once a month, decrypt the newest dump and run a full restore into a throwaway
database (4.6) to prove it works, and save the Monday row-count list described in 4.6 step 5.

---

## 5. Month-end close

**Cadence:** First weekday of every month, for the previous calendar month.

1. **Confirm all deliveries are completed or cancelled** for the closing month. Open `Deliveries` page → filter status = `in_progress` or `scheduled` with delivery date in the closing month → resolve each.
2. **Confirm all invoices are posted or voided** for the closing month. `Invoices` page → filter status = `unposted` or `draft` with invoice date in the closing month → post or void.
3. **Generate finance charges** for overdue customers (Customers → Statements → Generate Finance Charges).
4. **Run the period close:** Month-End Close page (`/month-end`, admin only) → close the month. The `close_accounting_period()` RPC checks for any blocking open transactions and refuses if anything is incomplete.
5. **Generate statements** (Customers → Statements → Generate Batch Statements) and review/email.
6. **Apply remaining prepayments:** Customers → Prepay → Apply Remaining → confirm balances.
7. **Reconcile commissions:** Commissions page → review the prior month → mark paid where applicable.
8. **Export reports** (Reports page → P&L, Balance Sheet, AR Aging) for record keeping.

If the close RPC rejects: read the error message — it names the open transaction. Resolve the transaction first, then retry.

---

## 6. Common incidents

### 6.1 "The site is down"

1. **Check Vercel status:** dashboard shows current deployment health.
2. **Check Supabase status:** https://status.supabase.com
3. **Hit the health endpoint:** `curl -I https://croprxsolutions.app/` should return `200`.
4. **Check Sentry:** look for spikes in unhandled errors in the past hour.

If Vercel is fine but the app errors:
- 401/403 errors → Supabase anon key likely changed; verify env var.
- 500 errors from RPC calls → check Supabase logs for the function name.
- Blank screen → check browser console. Likely a missing build asset or CSP violation.

### 6.2 "Emails aren't going out"

1. Open Sentry → filter `edge_function:send-email` (alerts auto-fire on Resend send failures since Sprint F #7).
2. Check Resend dashboard → look for failed sends.
3. Verify `RESEND_API_KEY` in Supabase Edge Function secrets (rotated keys are the most common cause).
4. Manually call `send-email` from the live app with a test recipient; the response includes any error body.

### 6.3 "A git hook is taking too long"

The pre-commit hook is fast: it checks the ledger requirement, private-artifact containment
and the staged high-risk files only. The pre-push hook runs typecheck and build, so it is the
slow one. Full lint, unit/guard tests and coverage run in GitHub CI on the PR. If a hook is slow:
- `npm ci` to ensure clean dependencies
- Restart your terminal
- `--no-verify` is never allowed (`AGENTS.md`); fix the slow step instead.

### 6.4 "I broke a migration that's already applied"

See §3.2 — write a forward-fix migration, never edit history.

### 6.5 "Customer reports their data is wrong"

1. Check `activity_feed` for the customer + date range — every meaningful mutation is logged with `performed_by`.
2. Check `financial_audit_log` for any payment/invoice mutations — append-only, never deleted.
3. If the bug is a system bug, write the fix migration; if it's user error, walk them through the correct flow.

---

## 7. Routine maintenance

| Task | Cadence | How |
|---|---|---|
| Restore drill | Quarterly | §4.6 and §4.9 |
| Month-end close | Monthly (first weekday) | §5 |
| Vercel + Supabase + Resend usage check | Monthly | Each dashboard's billing tab |
| Sentry triage | Weekly | Sentry → Issues → unresolved |
| Dependency audit (`npm audit`) | Weekly | Run `npm audit --audit-level=critical` |
| `pg_cron` job health (after Sprint F #3) | Monthly | Supabase → Database → cron schedules |
| Reconciliation report (after Sprint F #4) | Monthly, before close | Admin dashboard → Integrity Report |

---

## 8. Hard rules (from `AGENTS.md`, repeated here for ops)

- **NEVER** modify or delete an existing migration file. Only add new ones.
- **NEVER** drop RLS from a table. Every table must have RLS.
- **NEVER** expose `service_role` key in the frontend.
- **NEVER** modify `financial_audit_log` records — append-only.
- **NEVER** use binary floating point for money. New storage uses `bigint` cents.
  Legacy PostgreSQL numeric-dollar storage is not an approved exception until exact
  `numeric` arithmetic, clean finite whole-cent values, and an active finite whole-cent
  CHECK are verified. Dirty or unconstrained columns remain tracked findings.
- **NEVER** commit or push with `--no-verify` (bypasses the git hooks).
- **NEVER** push to `main` directly; every change lands through a PR.

---

## 9. Quick reference — files & docs

| Doc | Purpose |
|---|---|
| `AGENTS.md` | Project rules shared by every agent (`CLAUDE.md` adds Claude-only routing) |
| `docs/manual/CURRENT_STATE.md` / `KNOWN_ISSUES.md` | What is live now / what is known broken |
| `DEPLOYMENT.md` | How changes reach production; Edge Function secrets |
| `docs/workflows/SAFE_DEVELOPMENT_RULES.md` | Mandatory pre-commit safety checklist |
| `docs/workflows/DATABASE_CHANGE_CHECKLIST.md` | Step-by-step for schema changes |
| `docs/changelog.d/` | One file per change (new entries); `docs/CHANGELOG.md` is the history up to 2026-08-26 |
| `docs/reference/migration-history.md` | Every migration with description |
| `docs/reference/rpc-functions.md` | All RPCs + signatures |
| `docs/reference/database-schema.md` | All tables + RLS matrix |
| `docs/audits/` | Codex audit findings (current and past) |

---

## 10. When to update this runbook

After any of:
- New Edge Function deployed
- New external service integrated (replace Resend, add Stripe, etc.)
- Disaster recovery drill performed (record outcome in §4.9)
- Incident that revealed a missing playbook step
- New month-end procedure or accounting period rule
