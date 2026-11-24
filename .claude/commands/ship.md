Drive a coding job from "implement" to "reviewed, committed and landed", pausing only at Mason's hard gates (`AGENTS.md` › Safety and Protected Delivery). Everything else lands by itself under Mason's autonomous-landing rule (2026-09-26): branch → Luna until clean → Sol on the committed head when the change is on the Sol list → push → PR → green checks → handle comments → merge into `staging` pinned to the head. The guards enforce the gates below, except one a step names as unenforced (the Taha merge hold); where this file and a guard disagree, the guard is right and this file is the bug.

**The job** is everything after `/ship`. If none was given, ask Mason what it is, then proceed.

## Who does what

| Role | Does | Never |
|---|---|---|
| **Builder** (the session that got the job) | Plans, builds, runs Luna and Sol, opens the PR. For a staging PR it then hands off to the CI watcher (below); if no watcher is running it is also the lander. | Merges into `main`. |
| **CI watcher** (`C:\Claude\crx-ci-watch\watch-list.md`) | Owns a staging PR after handoff: Step 8 items 2–4a (marks it ready, fixes failed checks, conflicts and review comments, answers teammates, re-runs Sol, notes when the Taha hold ends), keeps its row current, releases its landing claim, then reports `#N READY` or `#N BLOCKED` to the captain. A backup watcher takes over a row untouched for an hour. | Merges while a merge captain is running. |
| **Lander** = the merge captain when one is running, otherwise the builder | Runs `npm run pr-readiness -- <n>`, confirms the Taha hold has ended (item 4a), merges into `staging` (item 6), proves it on staging (item 7), closes out (item 8). | Merges anything into `main`, `.github/` changes, or the back-merge. |
| **Taha or Mason** | Merge `release/next`, `hotfix/<name>`, rollbacks, the back-merge and `.github/` PRs, by hand with "Create a merge commit". Mason alone gives the hard-gate approvals. | — |

**No timers.** Never start a polling loop or a command with `sleep`. Auto-fix wakes a session for failures, conflicts and comments; for a clean finish, hand the PR to the CI watcher, or, working alone, run `gh pr checks <n> --watch` in the background and act on its notice. A PR that must wait (the Taha hold) is handed to the watcher, or, with none running, reported as "ready to merge after HH:MM"; a Claude session then waits with the Monitor tool (an until-loop on the clock, never `sleep`) and lands it when the hold ends, so Mason never has to nudge. Never mark a PR ready while its checks run (that cancels them).

**Landing claim.** Pushing to, running Sol on, or merging a PR branch claims it for 2 hours; another session doing any of the three is refused (`.claude/hooks/pr-claim-lib.mjs`). Whoever passes a PR on releases it first: `node scripts/pr-claim.mjs release <branch>`.

## The numbers (each one is what the code enforces)

| Rule | Value | Enforced by |
|---|---|---|
| Sol proof age at merge or apply | 24 h on an unchanged head | `codex-push-lib.mjs` `SOL_PROOF_MAX_AGE_MS`, `migration-landing-gate-lib.mjs` |
| Apply proofs (both reviewers + content-bound Sol from `write-apply-proofs.mjs`) | 24 h; re-mint if older | `migration-apply-lib.mjs` `PROOF_MAX_AGE_MS` |
| Hotfix or release apply after Taha's `Ready to merge: <sha>` | within 30 min | `migration-landing-gate-lib.mjs` `READY_WINDOW_MS` |
| Destructive migration approval | Mason's whole-message reply `yes` (or `I approve`, `approve <code>`) right after the request; lasts 24 h; survives the head moving, not the SQL changing | `owner-approval-lib.mjs` |
| Rewrite or access-change migration | no approval since 2026-11-11, unless the classifier found a delete or dynamic SQL, could not read it, or crashed (then as destructive) | `migration-apply-lib.mjs` `ownerApprovalNeeded` |
| Taha hold | every live apply: refused while the PR is under 4 h old unless Taha has posted a review or comment (enforced); merge of a hold-list PR (Step 8 item 4a): 4 h, a Taha review does not shorten it (not enforced: check it yourself) | `migration-landing-gate-lib.mjs` `tahaHoldProblem` |
| Review rounds | the `AGENTS.md` stop rule (the same BLOCKER/HIGH survives two fix rounds; one mechanism yields a new BLOCKER/HIGH in three rounds); Luna script stops after 6 whole-branch rounds (2 on a hook change); Sol refuses round 5+ until a decision-log entry names the PR (`docs/reference/sol-proof-mechanics.md`) | `luna-review.mjs`, `write-codex-push-proof.mjs` |

## The review ladder

Subagent reviewers (Step 3) → **Luna** (`gpt-6-luna`/xhigh, advisory, as many rounds as needed) → **Sol** (`gpt-6.2-sol`/high, once, the only proof the gates accept, Sol-list changes only) → the Codex GitHub App on the PR. Ordinary code off the Sol list skips Luna and Sol and gets ONE **Terra** final review (`gpt-6.1-terra`/high, `node scripts/luna-review.mjs --terra`; Mason, 2026-11-23). **Astra** (`gpt-6.2-astra`) reviews plans and designs before code (`plan-contract`, `astra-delegation`); it is advisory, never replaces Luna or Sol, and its findings count toward the `AGENTS.md` round caps. Pins: `docs/reference/codex-model-tuning.md`.

## Step 0 — Branch

Never work on `main` or `staging`: `git fetch origin && git switch -c ship/<slug> origin/staging` (a hotfix: `hotfix/<name>` from `origin/main`). Tell Mason the branch. Re-check the branch right before every commit.

## Step 0.5 — Size, then plan

- **Trivial** (one file; no SQL, Edge Function, money, inventory, RLS, auth, permission, lifecycle or other business-critical change): skip Step 3 and Step 5; do Step 2, 2.5, then Step 7. Say you are taking the light path.
- **Substantial** (everything else): the full pipeline.

**Know whether Sol applies.** Check every file you will touch: `node --input-type=module -e "import {solRiskPathProblem as p} from './.claude/hooks/sol-risk-lib.mjs'; for (const f of process.argv.slice(1)) console.log(f, '->', p(f) ?? 'off the list')" <file> ...`. One edit to a listed file pulls the whole PR into Sol; keep cosmetic edits to listed files out of an off-list PR. Once the PR exists, `npm run sol-needed -- <n>` gives the merge gate's own answer.

**Plan substantial work:** read the live schema and code, write a short plain-English plan (what, assumptions, files). Post it to Mason, then proceed without waiting for his confirmation (`AGENTS.md` › Operating Contract); if he says stop, stop. A change to money, stock, stored data, permissions or a lifecycle uses `.claude/commands/plan-contract.md` instead.

## Step 1 — Implement

Finish the whole job; partial work does not enter the gate. Use `/new-page`, `/new-rpc`, `/create-migration` for scaffolds. A hook refusal is a defect to fix, never an obstacle to route around.

## Step 2 — Verify (local)

```bash
npm run typecheck
npm run lint
npm run check:code-health
npm run build
npm run test
npm run test:agent-workflows
```

If `package.json` or `package-lock.json` changed, also `node scripts/verify-deps.mjs`. Fix any failure before going on.

## Step 2.5 — Prove it runs

Green tests do not prove the change does the right thing.
- **UI:** open it in the running app, click the real flow, confirm the result, check console and network.
- **RPC / DB:** write or extend the RPC's smoke chain (`scripts/smoke/README.md`). If the function already exists live, run the chain now (`npm run smoke:live -- --spec <rpc>`, rolled back). If the migration that creates or changes it is not live yet, the chain's live run happens at apply time (Step 5 item 4: hotfix or release day); for a feature PR the proof before release is the staging `Database` run plus trying it on staging (Step 8 item 7).
- **Data read:** confirm the query returns the real shape.

If you cannot run it, say so; do not call it done.

## Step 3 — Review fan-out (one message, in parallel)

| If this changed | Dispatch |
|---|---|
| `supabase/migrations/*.sql` | `rls-security-reviewer` + `migration-drift-reviewer` |
| `src/types/index.ts` or a migration | `typescript-types-drift-reviewer` |
| `src/` importing `jspdf` or `jspdf-autotable` | `pdf-output-reviewer` |
| any `src/`, `supabase/functions/` or migration | `compliance-reviewer` |
| workflow / lifecycle / page↔RPC logic | `/review-workflow` |

Wait for every dispatched reviewer to report before Step 4; a reviewer still running counts as not reviewed.

## Step 4 — Fix loop

For each confirmed BLOCKER or HIGH (read the cited line first): fix, re-run Step 2, re-dispatch the reviewers whose scope you touched. Fix cheap MED/LOW; list the rest as deferred. Stop and hand Mason both positions when the `AGENTS.md` stop rule triggers (the same BLOCKER/HIGH survives two fix rounds; one mechanism yields a new BLOCKER/HIGH in three rounds, every reviewer counted; a design trusts a screen-sent ID at round 2).

## Step 5 — Migration: prepare the live apply

**Live applies are only for a hotfix or the release PR** (Staging, below). A feature PR's migration is applied to the staging database by the `Database` workflow after its merge, so it skips this step (including the cost-exposure re-keys, which the release does); its reviewers (Step 3) and its smoke chain (Step 2.5) still apply. For a hotfix, items 1–2 happen here and items 3–7 at Step 8 item 5.

**Carry cost-exposure re-keys in the PR** if the migration replaces an existing function: run `scripts/db-invariant-sweeps/predicates/cost-exposure-review.sql` read-only on live with each replaced function's body and settings overridden by the migration's (or on the prover's post-apply database), and swap in the new key with a dated note for every allowlisted root whose key changes. Item 7 confirms.

1. **Stamp the apply proofs:** `node scripts/write-apply-proofs.mjs <migration-name-without-.sql>`. It runs the Codex migration review itself and mints the content-bound proof only on a CLEAN verdict; never hand-write it. Editing the migration afterwards voids it: re-run Step 3, then re-stamp.
2. **Who authorizes.** Non-destructive (rewrites and access changes included): the autonomous-landing rule, no ask. Destructive (deletes or empties rows, drops data, MERGE) or unreadable: park it, explain the risk to Mason, then, once every other proof is fresh, run `node scripts/owner-approve-migration.mjs supabase/migrations/<file>.sql` from the PR's checkout and make its printed summary, exactly as printed, the whole last message of your turn. Since 2026-11-23 (Mason: his yes carries to the merge captain) any session may build it, show it and apply it: his reply counts in whichever conversation's last message showed that summary word for word, and any session's apply finds the approval in any checkout, still bound to that file and PR, 24 hours, once (forms and window: The numbers). If the script notes this session's messages do not reach the reply hook, send the summary to the session Mason is talking to and have that agent show it; never send him to a terminal. Never send or relay his reply yourself. Codex sessions hand every live apply to Claude; Codex's guard refuses even the dry run.
3. **Apply** from a clean checkout of the PR's pushed head: `node scripts/apply-migration-file.mjs <file>` (dry run), then `--confirm`. It refuses unless that head is the open PR's head with green checks, no `CHANGES_REQUESTED`, a fresh Sol proof, Taha's fresh `Ready to merge` and the Taha hold cleared. The MCP `apply_migration` door cannot pass the guard. Never `supabase db push`.
4. **Smoke chains:** every RPC the migration creates or changes passes its business-chain spec: `npm run smoke:live -- --spec <rpc>`. Exit 2 "no spec covers" → write the chain first (`scripts/smoke/README.md`). PASS is an error starting `SMOKE_PASS_ROLLBACK`; anything else fails: fix, then re-run the FULL chain, never one statement. Only where `--live` cannot run, run without it and execute each printed chain as ONE statement via `execute_sql`.
5. **Ledger reconciliation:** read the new ledger row's `version` and `name` and normalize them as `.claude/hooks/migration-ordering-lib.mjs` does. Keep the disk filename when the normalized name matches; rename the file and record only when it does not.
6. **Schema registry:** `/regen-schema-registry` if the migration added a status enum, generated column or table (where it goes: `docs/reference/sol-proof-mechanics.md`, post-apply row).
7. **Sweeps (post-apply gate):** `npm run db-sweeps:live` sends every predicate byte-exact and read-only to live, saves each `sweep_result` packet (`predicate`, `rows`, `function_contracts`) to a private capture, and adjudicates the full set. Only where it cannot run, `npm run db-sweeps` prints each predicate: execute every block read-only via MCP `execute_sql`, capture each packet as a private local JSON array, then run `node scripts/db-invariant-sweeps/run-sweeps.mjs --adjudicate <capture.json>`. Do not compare violation keys alone: exemptions need exact parameter and function/dependency contract matches. Missing, duplicate, unknown or drifting packets block. Any unallowlisted violation blocks the ship; never allowlist a real hole.

## Step 6 — Luna, then Sol

Pick the review by what the change touches (Mason, 2026-11-23):
- **Docs and wording only, no app code:** no Codex review (say so). CI and the Codex GitHub App still run.
- **Ordinary code off the Sol list** (`docs/reference/sol-required-paths.md`): ONE Terra final review, `node scripts/luna-review.mjs --terra`, on the committed head you will push. Fix any BLOCKER/HIGH, commit, and rerun Terra on the new head (it takes seconds) until none remains; the `AGENTS.md` stop rule applies. Then open the PR. Do not run Sol: no gate needs it and it costs ~20 minutes. A large or unclear change may still choose Sol (`--sol --reason`).
- **Sol-list changes** (money, inventory, database, logins), and anything touching auth, RLS/RPC security, a migration, permissions or an Edge Function: Luna until clean, then Sol once, as below.

- **Luna until clean** (`/codex-review` Step 3A, `node scripts/luna-review.mjs`): fix and re-run until no BLOCKER or HIGH remains. Write and commit the Step 7 docs before the clearing round, so it covers them. The round that clears the change is the default whole-branch round (base `origin/staging` for a feature branch, `origin/main` for hotfix/release) on the head you will push. A confirmed BLOCKER/HIGH in a screen that saves, uploads or imports needs a failing-then-passing test or observed behavior. Map the result: `CLEAN` → SHIP; any BLOCKER/HIGH → NEEDS-WORK; deferred MED/LOW only → SHIP-WITH-FOLLOWUPS. That is advisory, not permission to merge.
- **Sol once, last** (`/codex-review` Step 3B), only for a Sol-list change, at the end of Step 7. Never route a Luna round through the Sol wrapper: it deletes the existing proof for that head.
- **Every deferral gets a home** when decided: a GitHub issue (what changes, never how to exploit it), or an existing issue or known-issues entry. List them in the PR's `## Follow-ups` section (`- #1700 tighten the X check`, `- KI-104 ...`, or `- None`); both merge gates refuse a PR without it.
- If you disagree with a Codex BLOCKER, show Mason both positions and stop. If the CLI is unavailable, use `/codex-cross-review` and stop for Mason; never self-certify.

## Step 7 — Docs, commit, Sol

Update the docs the change touched: the migration's record `docs/reference/migrations.d/<name>.md`, `rpc-functions.md`, `pages-routes.md`, `database-schema.md`, the relevant workflow doc, and a NEW `docs/changelog.d/<YYYY-MM-DD>-<slug>.md` for anything beyond a small fix (never append to `docs/CHANGELOG.md`). Run `node scripts/check-doc-drift.mjs` and fix what it reports.

Check `git status --short --branch`, then commit on the branch. The pre-commit ledger guard requires a commit that stages agent-surface files (`.claude/{commands,skills,hooks,workflows,agents}/`, `.claude/settings.json`, `.codex/`, `.cursorrules`, `AGENTS.md`, `CLAUDE.md`, `.husky/`, `scripts/check-*`, `scripts/validate-*`, `scripts/verify-*`, `scripts/normalize-eol.mjs`, `scripts/agent-health-check.mjs`, `scripts/run-claude-review.mjs`, `scripts/write-codex-push-proof.mjs`, `scripts/sync-agent-workflows.mjs`) or a new migration to ADD a changelog.d entry describing it. Never `--no-verify`.

**Then Sol, for a Sol-list change:** `/codex-review` Step 3B on the committed, clean head, after `git fetch origin`, before the PR opens. Proof rules, carries and skips: `docs/reference/sol-proof-mechanics.md`.

## Step 8 — Land

Present branch, commit, evidence, migration state and the exact production action, then:

- **Records only** (an "applied live" note, a status update): one docs PR per session, after its last edit. A record of a still-draft PR's own change goes into that PR.
- **No Mason-only action** (all gates green, nothing in the hard-gate list): land with no ask —
  1. **Open.** `git push -u origin <branch>`, then `gh pr create --base staging` (a hotfix: `--base main` from `hotfix/<name>`), description ending in `## Follow-ups`. Auto-merge stays off. An off-list PR opens **ready**. A Sol-list PR opens as a **draft** (`--draft`); drafts skip the two Windows jobs. A rollback (`hotfix/revert-<name>`, `docs/operations/production-runbook.md` §3.1) opens ready and Taha or Mason merges it. Merge the base in only to resolve a conflict (never `main` into a staging-bound branch).
  2. **Ready.** A draft: once checks are green and your fixes pushed, `gh pr ready <n>`. A fix pushed after a PR is ready is an unreviewed head: run Luna on it first (unless the PR was Trivial), and when it changes code post `@codex review` once. Write that mention nowhere else (descriptions, commits, other comments), because the Codex App treats any mention as a task. CodeRabbit is optional: only a PR labelled `needs-coderabbit` (added when Mason asks) needs one completed review, requested once with `@coderabbitai full review` (`docs/reference/coderabbit-native-review.md`); never post `@coderabbitai` on an unlabelled PR.
  3. **Comments.** Read every Codex App (`chatgpt-codex-connector`) and CodeRabbit comment; fix or refute each with evidence in one push on the SAME PR, then resolve its thread with exactly `gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:"<thread-id>"}){thread{isResolved}}}'`. Answer every teammate comment (Taha's bot included) with the fix or reason in a PR comment containing that comment's link; both merge gates and the apply refuse until each has one.
  4. **Sol again only when needed.** The proof covers its head and later off-list commits for 24 hours. A later Sol-list commit, a resolved conflict, or a feature branch that merged `origin/staging` needs a new full run; mark a draft ready first, because the Sol pre-flight refuses a draft PR. A base that only moved forward needs nothing: merge as it is. Carries, restamps, post-apply records and Mason's skips: `docs/reference/sol-proof-mechanics.md`.
  4a. **Taha hold.** A PR stays open 4 hours (`gh pr view <n> --json createdAt`) before merge when any file is on the Sol list; under `src/` with `customer` or `product` in its path; under `.github/`, `src/lib/` or `src/types/`; `package.json` / `package-lock.json`; or in one of Taha's open PRs (`gh pr list --author TahaKhanAbdalli --state open --limit 200 --json number,files`). When unsure, hold. A Taha review does not shorten it. Emergency rollbacks (`hotfix/revert-<name>`) are not held for merge (Taha or Mason merges them), but their apply still waits unless Taha comments. The apply side is enforced (The numbers); the merge side is not yet, so check it yourself.
  5. **Migration.** Into `staging`: no live apply; after the merge confirm the `Database` run (Staging). Hotfix or release into `main`, non-destructive: within 30 minutes of Taha's `Ready to merge: <head sha, 12+ chars>` from his own account, re-mint apply proofs if stale and apply (Step 5 items 3–7), BEFORE Taha or Mason merges.
  6. **Merge.** Only a PR into `staging` is merged by an agent. A PR into `main` stops here: report it ready with the full head SHA whose migrations you applied and tell Taha or Mason to merge only while the head is still that SHA (if it moved, apply only migrations not already live, then hand off again). Immediately before merging, check the PR's live `mergeStateStatus` and check rollup (the gates judge the newest run per check; never infer mergeability from the known-stale protection sub-resource), and that auto-merge is off. Then `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>` (the pin before any `--body`; never the REST endpoint or a connector tool).
     **Staging merge:** for a frontend change, wait until every `Vercel – crx-manager-v1-0` status on the merge commit reads `success` (`gh api repos/croprxsolutions/CRX_Manager_V1.0/commits/<merge-sha>/status`), then in a browser signed in to the staging site confirm the `assets/index-*` names changed and exercise the change on staging with test data. With no staging sign-in available, say so and use the deploy status plus the `Database` run as the proof. Never touch production for a staging merge (the Browser pane is Mason's production admin session).
     **Production (after Taha or Mason merges a hotfix or release), looking only:** `curl -s https://croprxsolutions.app/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js'` names a new bundle; in the signed-in tab run `reg.update()`, post `{type:'SKIP_WAITING'}` to `reg.waiting`, reload and confirm the same bundle; exercise the change without saving (the Browser pane is Mason's admin session); check Sentry. Docs- and `.claude/`-only merges build nothing (`scripts/vercel-ignore-build.sh`): say so.
  7. **Records.** Staging: `Staging proof: <link>` and the `verified-on-staging` label. A live apply: right after each apply, before handing the merge over, `gh pr comment <n> --body "Applied live: <migration_name>"`, one line per migration, the name exactly as the file stem.
  8. **Close out**, last, read-only (the lander, once, after its last PR). Check each `## Follow-ups` home exists (`gh issue view <N>`; `KI-N` in `KNOWN_ISSUES.md` on `origin/main`; a `known-issues.d/` file via `git cat-file -e origin/<base>:<path>`; the PR itself is not a home). Name anything else deferred or not done. Verdict first: **SAFE TO ARCHIVE** (merged, deploy checked or none expected, migrations applied and commented, nothing unpushed, every follow-up homed) or **NOT YET — N steps remain**, each tagged "I can do this now" or "needs Mason". A staging merge ends "in staging, not live yet". Then list the follow-ups by link and title.

  `CHANGES_REQUESTED`, `--auto` and `--admin` are refused by both merge gates. Only Mason arms auto-merge; agents may disarm it. The daily summary (`.github/workflows/daily-landing-summary.yml`) tells Mason what landed.
- **A Mason-only action** (destructive migration, Edge Function deploy, data deletion, any hard gate in `AGENTS.md`): stop and ask for that specific action. No standing rule or older approval covers it; each gated action needs its own yes.
- **A required gate could not run or ran degraded:** do not land, do not self-certify; hand over per `AGENTS.md`.

### Handing off and landing several PRs

- **Builder → CI watcher.** Release your claim (`node scripts/pr-claim.mjs release <branch>`), read the watcher's id from `C:\Claude\crx-ci-watch\watch-list.md` (never hard-code it), and send one line: `#N HANDOFF branch=<branch> folder=<worktree holding any Sol proof> open=<what is open, or none>`. Keep a worktree holding a Sol proof until the PR merges. Hotfix and release PRs stay with the merge captain.
- **Watcher or child → captain:** release the landing claim, then send `#N READY head=<40-char sha>, Sol=<proof path|n/a>, migration=<none|applied>, hold=<ends HH:MM|none>` after `npm run pr-readiness -- <n>` is clean and every teammate comment is answered, or `#N BLOCKED` with the options. The captain settles technical forks itself and re-runs `pr-readiness` before merging.
- A hotfix migration PR sends `#N WINDOW` just before its last push; the captain asks Taha or Mason to merge nothing else into `main` until it is applied and merged or reports BLOCKED.
- Never push to a branch whose author pushed in the last 30 minutes (comment instead), or to Taha's branches at all.

### Report

```
SHIP — <job>  (<YYYY-MM-DD HH:MM>)
Branch: <branch>   Changed: <N migrations, N TS, N docs>
Reviewers: rls <..> drift <..> types <..> pdf <..> compliance <..> review-workflow <..>
Verify: typecheck ✓ lint ✓ build ✓ tests X/Y   Behavior: <what you ran and saw>
Luna: <SHIP | SHIP-WITH-FOLLOWUPS | not needed>   Sol: <proof head | not on list>
Migration: <applied live + smoked | staging job | none>
Deferred: <items with homes>
── <MERGED into staging | READY for Taha/Mason | WAITING ON MASON: <action>> ──
```

## Taha's PRs (Mason, 2026-11-06)

- **Hands off.** No agent of Mason's pushes to a branch Taha owns (author `TahaKhanAbdalli`, `taha/*`); the pre-push hook (`scripts/check-taha-branch-push.mjs`) refuses it. Post findings as PR comments. A billing-rule change goes to Mason and Taha as a decision before code.
- **His items.** Taha's six items are his through 2026-12-15, the billing plan among them. Before starting anything that might be one, ask Taha. When Mason directs money or billing work, warn him in one line of any overlap and follow his call; his field application invoice work is his.
- **He lands his own PRs**; his own clean Sol run on the final commit satisfies the Sol rule. No agent of Mason's monitors his PRs.
- **We hold ours** (Step 8 item 4a).

## Staging

Feature work lands in `staging`; `main` takes only the weekly release and hotfixes. Both merge guards give a staging merge the same gates as a main merge and refuse an agent's merge into `main`.

- **Every feature PR targets `staging`**, migrations included; all steps above apply.
- **Reviews cover the branch's own changes** (`origin/staging...HEAD`). A finding in someone else's staging code is theirs; say so in the PR.
- **Migrations into `staging` are not applied live.** After the merge, confirm the `Database` run for that merge commit is green: `gh run list --workflow db-apply.yml --branch staging --json headSha,status,conclusion --jq '.[] | select(.headSha=="<merge sha>")'`. A red run is yours to fix in a new PR. Wait for it before trying the change on staging. Never apply anything to the staging database by hand.
- **Prove it on staging** (test data only): `Staging proof: <link>` plus `verified-on-staging`, or `Held off: <revert PR or flag>` plus `held-off`. The release gate needs one or the other on every PR.
- **Destructive migrations may merge into `staging`** (Mason, 2026-11-20): say so in the PR and tell Mason; it reaches live only after his approval of that exact file.
- **Into `main` go only** `release/next` (opened by the release bot every Thursday 08:00 Dubai) and `hotfix/<name>` from `main`. A hotfix migration takes its stamp from `node scripts/next-migration-stamp.mjs --hotfix --live <live high-water>`, and its PR says whether it touches tables or rows a waiting staging migration also changes (then Taha or Mason decides before the apply). A hotfix may carry nothing staging has that main has not released unless Taha adds `hotfix-backport`.
- **Release-day applies** (Mason's Decision A, 2026-11-12): the agent applies the release's migrations live from the release PR, before it merges, oldest stamp first, through the same gate as a hotfix. The list: `git fetch origin`, then `git diff --name-only --diff-filter=A <baseRefOid>...<headRefOid> -- supabase/migrations` with SHAs from `gh pr view <n> --json baseRefOid,headRefOid`. A held-off PR's migration is still in that list, so it needs a revert PR first. Apply from a checkout of `release/next`, within 30 minutes of Taha's `Ready to merge`. If the head moves mid-release, stop and tell Taha and Mason in the PR which migrations are already live.
- **Staging freeze:** while a release PR is open, both merge guards refuse an agent's staging merge (each one re-cuts `release/next`). Queue staging-ready PRs until it lands.
- **Re-stamp PR after the last release apply:** run a read-only `list_migrations`, then on `hotfix/<name>` off `origin/main` move line 3 of `docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md` to today's Chicago date and the newest live row ("for the live ledger only"), add a changelog.d entry whose first line is `## <YYYY-MM-DD> - <what changed>`, run `node scripts/check-doc-drift.mjs`, open with base `main`. Taha or Mason merges it before the back-merge.
- **Release guards:** agents never approve a PR; never merge a `.github/` change; the apply gate refuses a release or hotfix whose `.github/workflows` differs from `main`'s, a release head missing staging's tip, or a fork's branch. The back-merge (`main → staging`) is Taha's or Mason's.
- `staging` deploys to its own Vercel environment and Supabase project (test data only).

## Rollback

Production broke after a change: `.claude/commands/rollback.md` (promote the last good Vercel deploy, a compensating migration, or a redeploy of the last good Edge Function; each step waits for Mason's OK). The code fix then follows as a `hotfix/revert-<name>` PR that Taha or Mason merges.

## Hard Rules

- NEVER merge work that skipped a required step: checks green, every Codex App or CodeRabbit comment fixed or refuted, Sol clean when the change is on the Sol list. Report every merge.
- NEVER apply a migration without both reviewers clean, fresh apply proofs, green checks and a Sol proof on its head; destructive ones only after Mason's approval of that exact file.
- NEVER report the gate clean with a confirmed BLOCKER/HIGH open.
- NEVER skip the review fan-out except on the Trivial path.
- NEVER `--no-verify`, `@ts-ignore` or `any` (except `reportPdf.ts` columnStyles), force-push without Mason's yes, or push to `main`.
- Edge Function deploys, data deletion and live applies of destructive migrations always wait for Mason's explicit yes (merging one into `staging` does not; Staging, above).
- A required safety gate that cannot run means STOP and hand off.
