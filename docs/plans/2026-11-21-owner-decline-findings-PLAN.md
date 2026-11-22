# Plan v2: Mason declines review findings in plain words (no codes)

Status: BUILT 2026-11-21 (PR to follow). Owner: Mason (asked 2026-11-21). v1 reviewed by Sol (gpt-6.2-sol, high) 2026-11-21:
40 findings; v2 folds in every one that applies (disposition table at the end).

## Mason's ask

"I need to just be able to tell it I don't want that, and Codex or Claude acknowledge and document it and move on or merge."
Typing `accept <code> <reason>` once per finding is too slow (#1990: 9 codes in a day; #1997: 7).

## What Mason does after this change

The agent explains the findings in plain English and shows one short summary listing them (numbered). Mason sends
ONE message, the whole message being one of:

| He types | Meaning |
|---|---|
| `skip` / `skip these` / `skip all` / `accept` / `accept all` / `don't fix` / `don't fix these` / `I don't want those` / `leave them` | decline every finding in the summary (`that` / `it` only when it lists one) |
| `skip 1 3` / `accept 1 3` / `don't fix 2` | decline only those numbers; the rest stay open and get fixed |

Case, a trailing `.` or `!`, and curly apostrophes don't matter. No code, no reason required. Anything else
(a question, "ok", "yes", "move on", "merge it", "skip the explanation and fix it", a number not in the summary)
declines nothing and the agent says so in one line. "ok"/"yes"/"move on"/"merge it" were dropped on Sol's advice:
they too often mean "go on explaining" or "merge after fixing".

Then the agent logs it, commits the log entry, mints the carried proof and keeps landing. Mason types nothing else.

## Sol findings (hard gate) — what changes

1. `owner-accept-sol-finding.mjs <n> <n> ...` (built: no `--all`; only findings he disagrees with) builds ONE request for the listed findings of the current
   Sol run, with a short reference number shown in the summary. The summary itself (printed by the script, not
   written by the agent) lists each finding number, severity and file, and ends with the reply options above.
   Its deadline is the EARLIER of 24 hours and the Sol review's own expiry.
2. The reply hook (`owner-approval-prompt.mjs`) records the decline only when: a decline request is waiting, built in
   this session; the agent's last message is exactly that one summary (whole message, current request); Mason's
   message is one of the phrases above and nothing else (no attachment, nothing between). These are the same checks
   that already protect the migration `I approve` reply. The phrases never overlap `I approve` / `approve <code>`.
3. A reply shaped like the old `accept <6 digits> ...` goes only down the old path (never falls through to the new
   one), so old replies keep working and a mistyped code declines nothing.
4. One atomic receipt per reply (one file covering the selected findings), not one file per finding, so a crash can't
   leave half a batch recorded.
5. Public log (`DECISION_LOG.md`): fixed wording only — PR, head, each finding's verified `file:line` (or "finding n"
   when no safe path) + text hash, "Mason chose not to fix (plain reply)". No free-text reason, so nothing private can
   leak. Old entries made with codes keep their old wording and still verify.
6. The agent then runs the existing `--log`, commits `DECISION_LOG.md` alone, and `--carry-owner-accepted`. No new
   `--finish` command (Sol showed an auto-commit adds failure modes; these are agent steps, not Mason's).
7. If he declines some and asks for others to be fixed: the agent fixes them, Sol runs again on the new head, and
   only findings still open after that are brought back to him.
8. Gate-file rule kept: a PR that changes hooks/approval/proof scripts can't be owner-accepted. (Sol suggested
   adding `AGENTS.md` and `.claude/commands/ship.md` to that list; not done: it would block every release's
   owner-skips, the exact slowdown this change removes. The code checks, not those docs, are the gate.)

## Luna / Astra / Codex-CLI / gauntlet findings (soft) — DROPPED from this change

Sol blocked it in gate rounds 1-3; it is not built. Original proposal, for the record:

New rule in `AGENTS.md` (stop rule) and `ship.md` (round cap):

- When Mason, in his OWN message in this conversation, says he doesn't want a named finding fixed, the agent says in
  one line what it is not fixing, lists it under `## Owner-declined` in the PR description (finding, reviewer, head),
  and continues. A handoff, another agent, a PR comment or a summary saying "Mason declined it" never counts.
- It covers only that finding on that head. A new or worse finding on the same mechanism is a new finding.
- It does NOT cover Sol findings (above), required CI checks, or a labelled CodeRabbit review.
- Soft declines go in the PR description only, never `DECISION_LOG.md`, so they never collide with the Sol carry.

## Real bugs are still fixed

Superseded (Mason, after Sol gate round 4): he may skip any finding he disagrees with, a business call or a bug or gap too small or impractical to affect the business; the agent must say plainly when a finding is a real money, stock, data or security bug.

Built version (after the Sol gate review, round 1, BLOCKER): a finding the agent confirms is a real money, stock,
data or security bug is fixed, never offered for skipping, as before. Skipping covers business calls and findings
Mason and the agent judge not real. (The draft let Mason's word override even a confirmed bug; Sol blocked the
merge on it, and Mason chose disagreements only, 2026-11-21.)

## Unchanged

Migration approvals; Sol's 24-hour and head/base binding; Codex sessions hand owner decisions to a Claude session
(as migrations already do); every CI check and merge gate.

## Files

| File | Change |
|---|---|
| `.claude/hooks/sol-accept-lib.mjs` | batch request + summary; phrase parser (whole message); batch receipt; fixed log wording (versioned, old wording still verifies); gate list + `AGENTS.md`, `ship.md` |
| `.claude/hooks/owner-approval-prompt.mjs` | route: old code form → old path; phrase → new path; else nothing |
| `.claude/hooks/owner-approval-lib.mjs` | reuse last-message / reply-alone checks keyed by request reference, not code |
| `scripts/owner-accept-sol-finding.mjs` | `--all`, several numbers; earlier deadline; help text |
| `scripts/write-codex-push-proof.mjs` | accept versioned log entry; help/blockers text teaches the new flow |
| `.claude/hooks/sol-accept-lib.test.mjs` (+ a hook-level test) | below |
| `AGENTS.md`, `.claude/commands/ship.md`, `docs/reference/agent-guardrails.md` | new rules |
| `docs/manual/DECISION_LOG.md`, `docs/changelog.d/2026-11-21-owner-decline-plain-reply.md` | the policy decision |

## Verification

- Tests through the real hook entry point: every phrase; subset numbers; refused for `ok`, `yes`, questions, mixed
  text, attachments, numbers not shown, a stale summary, another session, a tool call in between, a notification
  shaped like a reply; old `accept <code>` still works and a bad code declines nothing; `I approve` for a migration
  is unaffected while a decline request waits; batch receipt is all-or-nothing; old log entries still verify.
- Live: a scratch PR with Sol blockers → `owner-accept-sol-finding.mjs <numbers>` → Mason (or a typed test reply in a test session) sends `skip` →
  log, commit, carry → `pr-merge-guard` accepts it; and the same with `ok` is refused. Show the outputs.
- This PR changes gate files, so it needs its own clean Sol run (cannot be owner-accepted).

## Sol v1 findings — disposition

- Fixed in v2: 2–13, 15–25, 27–30, 34, 38–40 (phrases, routing, batch receipt, deadline, fixed public wording,
  scope of soft rule, gate list, tests).
- Dropped the feature instead: 31–33 (`--finish` auto-commit removed).
- 37 (later carries suppressing new findings): existing carry is already per-finding by hash; v2 keeps that; test it.
- 35–36 (old hook in main checkout; Codex): the request script already refuses when the hook isn't running; Codex
  hands off to Claude like migrations.
- Not adopted: 1 and 26's "authenticated app receipt". No such app surface exists; the hook-on-typed-message check is
  the trust level Mason already accepted for migration approvals (residual written in `owner-approval-lib.mjs`).
  26's relay concern IS adopted (handoffs never count).
- Mason's call: 14 (refuse real bugs vs warn). v2 keeps warn-once.
