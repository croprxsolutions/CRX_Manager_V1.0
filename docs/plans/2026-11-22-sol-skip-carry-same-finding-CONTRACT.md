# Sol skip carries to a repeat finding — behavior contract

Read at `origin/staging` 3f1ca8933 (2026-11-22). Mason, 2026-11-22: "build something that will carry my acceptance of a gap or bug forward if it gets flagged again"; on the reversal question: "yes built it do recommended ... this doesnt need to be loctite".

## Outcome and authority

- **Result.** After a PR merges `origin/staging` again, the fresh full Sol run often re-raises a HIGH Mason already skipped on that PR (#2267: three skips of one finding). When EVERY BLOCKER/HIGH of the fresh run is one Sol itself labels the same as a finding Mason already skipped on this PR, the agent records the carry and writes the proof with no new question. Any NEW BLOCKER/HIGH goes to Mason exactly as today.
- **Smallest change, existing path reused.** The current owner-accept path stays: Sol full run → blockers record → `owner-accept-sol-finding.mjs --log` writes a `DECISION_LOG.md` entry, committed alone → `write-codex-push-proof.mjs --carry-owner-accepted` writes a carried proof bound to that commit. The only addition is a second way to satisfy "every finding is accepted": a carried acceptance instead of a fresh skip reply. Files: `scripts/write-codex-push-proof.mjs` (Sol prompt + record + carry writer), `.claude/hooks/sol-accept-lib.mjs` (parse label, match, refusals, log entry, gate check), `scripts/owner-accept-sol-finding.mjs` (`--log`), `.claude/hooks/codex-push-lib.mjs` (`carriedSolProof` accepts the new mode), `.claude/hooks/pr-merge-guard.mjs` and `.claude/hooks/migration-landing-gate-lib.mjs` (pass every proof so the chain can be traced), tests, `ship.md`, `AGENTS.md`. No new table, lock, timer, job or file type.
- **Who decides "same".** Sol only. The full-run prompt lists this PR's earlier accepted findings (ref, severity, file:line, wording) and requires every `SOL_FINDING` line to end with `SAME_AS_ACCEPTED <ref>` or `NEW`. The agent never labels a finding.
- **Who approves.** Nobody new. A carried acceptance is valid only when it traces to a root acceptance Mason gave in-session through the hook-recorded skip/accept flow (a proof with `carry.mode: "owner_accepted"`, which today is only written after his receipts verify). A carried proof never becomes a root: every carried entry names the ROOT acceptance's ref, head, PR and time.

## Rules that always hold (refuse the auto-carry → ask Mason as today)

1. A full fresh Sol run on the new head happened (the blockers record is that run's, under 24 hours, same model/effort).
2. Every BLOCKER/HIGH carries Sol's own `SAME_AS_ACCEPTED <ref>`; one `NEW`, a missing label, or a ref not in the list Sol was given refuses the whole carry (all-or-nothing: no mixing carried and fresh skips in one entry).
3. The ref names an acceptance on the SAME pull request (number and repository URL), whose root acceptance is at most 7 days old, whose accepted head is an ancestor of the new head.
4. Same file path: the finding's `file` (from `file:line`) equals the accepted finding's file; the line may move. A finding with no readable location refuses.
5. Severity never rises: HIGH accepted, BLOCKER now → refuse.
6. The PR's own change to that file is unchanged and not empty: its whole patch (merge-base..head, hunk positions and blob ids included) at the new head equals the one at the head Mason skipped at. Any PR edit to that file, or a base change to it, refuses (Mason is asked); a file the PR does not change never carries.
7. A PR that changes gate or approval files refuses (existing rule, which also covers release/hotfix PRs with gate files).
8. The `DECISION_LOG.md` entry is written by `--log` and committed alone; the proof writer rebuilds it byte for byte. Wording: "carried from ref <ref> at <old head> to <new head>; Sol marked it the same".
9. The proof's mode is `owner_accepted_carried`. `carriedSolProof` treats it like `owner_accepted` (same base, non-empty list). Claude's staging merge gate accepts it only when every entry traces to a root `owner_accepted` proof (an untracked local proof file) with the same ref, head, PR, URL and time, under 7 days old. The live migration-apply gate never accepts a carried skip, and Codex's merge guard hands such a PR to Claude (Mason, 2026-11-23). A run Sol marks all-repeat is never put to Mason (Mason, 2026-11-23).

## Existing rows

No database change. Old proofs keep their meaning; no old proof has the new mode. An old blockers record has no labels and can only go through Mason's skip, as today. A Sol run with no earlier acceptances on the PR gets the old prompt (labels optional).

## Timing

The carry is a local script run on a clean worktree, bound to exact SHAs; a moved HEAD refuses (existing check). Two sessions on one checkout are already refused by the one-writer rule. Root acceptance older than 7 days at gate time → the carried proof stops counting (the gate re-checks the age).

## Proof cases

- When every finding is `SAME_AS_ACCEPTED` a real root ref on the same PR, same file, same severity, unchanged PR change → `--log` writes the carried entry, `--carry-owner-accepted` writes an `owner_accepted_carried` proof, the merge-gate check accepts it; no skip request is built. (unit + fixture repo)
- When one finding is `NEW` → refused, message says ask Mason with `owner-accept-sol-finding.mjs <numbers>`. (unit + fixture)
- When the PR edited that file after the acceptance → refused. (fixture repo)
- When the file differs, the severity rose, the ref is unknown, from another PR, or older than 7 days → refused. (unit)
- When the root proof is missing from the local proofs, or names another ref → the gate check refuses the carried proof. (unit)

## Cold challenge (Astra gpt-6.2-astra/high, 2026-11-22, 28 findings) — how each was settled

- **Identity (1, 2, 11, 16, 19).** Each accepted finding is keyed `<ref 12>/<root finding n>`, never the reply alone. The Sol run saves the exact list it was shown (`carry_candidates`: key, root head/ref/n/time, severity, wording, PR, URL, reviewed head R and base) inside its blockers record; `--log` and the proof writer resolve labels only against that snapshot, so both render the same entry. The code comparison uses the reviewed head R (`carry.from_head`), not the log-only commit L; the root lookup uses the root proof's own head L. The gate requires the entries to cover findings 1..k exactly once, each with a distinct root, each root an `owner_accepted` proof entry that is itself not carried.
- **File comparison (9, 10).** The PR's own diff of that file (merge-base..head, default context, `@@` positions and `index` lines dropped, mode lines kept) must be equal, and the file must exist at both reviewed heads; any git error refuses. An identical change moved within the file keeps different context lines and refuses; staging absorbing the PR's edit refuses (safe side); edit-then-revert compares equal (same code, accepted).
- **Labels (12).** The label is split off before the 400-character check and never enters the owner-facing wording or its hash; a missing or malformed label only disables the carry, the record stays for Mason.
- **Stale record (13).** A full run deletes this head's blockers record before Sol starts, so only the latest run can be used.
- **PR lookup (14).** `--log` resolves the open PR (into staging, head = this head) before writing a carried entry, and every candidate must name that PR and URL.
- **Gates (17, 18, 20, 21).** The chain check applies to ANY proof whose entries carry `carried_from` (so a later restamp/post-apply carry keeps it). The carried proof's `root_review` is the fresh run (24-hour clock); Mason's `accepted_at` is kept per entry (7-day clock), never refreshed. The migration gate collects every proof before judging (order-independent). Authority callers inventoried: `ownerAcceptedForPr` is called only by `pr-merge-guard.mjs` and `migration-landing-gate-lib.mjs`; the push guard checks shape only, as for today's `owner_accepted`.
- **Unchanged behavior (22, 24).** An earlier clean proof covering later commits is the existing 2026-10-30 rule (refused at merge when the later commits touch the Sol list); this change does not touch it. HEAD and clean-tree re-checks before writing are the existing writer's.
- **Recovery and rollout (15, 23, 25, 26).** Any refusal prints its reason; the recovery is the existing one (ask Mason with `owner-accept-sol-finding.mjs <numbers>`; after expiry, a fresh full Sol run). Readers and writer ship together; guards in `C:\CRX_Manager` refuse the new mode until that folder syncs (fail-closed). Messages in the runner, writer and merge guard name the new mode.
- **Proof (27).** A fixture-repo test drives the real writer functions through: all-SAME carries, one NEW refuses, a PR edit to the file refuses, and the gate check before/after 7 days.

### Business choices from the challenge (Mason, 2026-11-22: "do recommended"; he may redirect)
- (3) Only PRs into `staging`, reviewed against `origin/staging`, not release rules. Any later version of the PR qualifies (not only a catch-up merge); the same-file, unchanged-change check covers the rest.
- (4) Skips Mason gave before this lands also carry (that is #2267's case). The skip request's wording stays unchanged (its text is re-checked byte for byte on old receipts).
- (5) Mixed run (one repeat, one NEW): all-or-nothing, as Mason specified; he is asked about the run as today and the agent tells him which are repeats.
- (6) Only skips from fully accepted runs (a logged `owner_accepted` proof) carry.
- (7) Two current findings pointing at one accepted finding refuse; severity is compared with Mason's original decision.
- (8) No undo button: if Mason says "fix it after all", the fix changes the file and the carry stops; otherwise it ends after 7 days.

## Open business decisions

- **Reverses part of #2226 and #2199** (`DECISION_LOG.md` 2026-11-22: skips never carry onto a newer base; a skip counts only for the version it was given for). Mason, 2026-11-22: build it, accepted risk. This PR changes gate files, so it gets no owner skip of its own: it needs a clean Sol run, and a person merges it. **Accepted risk:** Sol could label a new issue "same"; the same-file, same-PR, unchanged-PR-change and severity checks limit it.
