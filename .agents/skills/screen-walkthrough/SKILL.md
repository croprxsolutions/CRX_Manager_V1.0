---
name: screen-walkthrough
description: Use when Mason starts a CRX screen or asks Claude or Codex to build or walk through one locally in Docker and hand the verified feature to Claude for staging.
---

# CRX screen walkthrough

The host session that receives Mason's job owns it through proof and handoff. In Claude Code, use the installed Codex skill for bounded implementation or review when requested. In Codex Desktop, run the browser directly. Both hosts can run the same local walkthrough; a read-only CLI child returns its work to its host for Docker. Respect the scope of the request: a walkthrough or review alone does not authorize shipping.

## Run the screen

1. Use a clean feature worktree from current `origin/staging`. Follow the project routes for the screen. Record the role, starting screen, action and observable result. Only one writer owns the checkout at a time.
2. Follow `scripts/local-app/README.md` in the feature checkout. Verify Docker answers and both Supabase executables match the launcher's version. On a busy host, check available memory and concurrent restores before starting. Run `node scripts/local-app/walkthrough.mjs start` to initialize this worktree's private stack or resume its matching build. Use `status` for the local URL and build record. If the engine is unavailable or another task owns a port or database, preserve that work and diagnose the blocker.
3. Exercise the actual requested feature through its UI. Use its focused local Playwright spec or walk the browser manually. For a save, reopen or reload the record as the intended role and check the saved value. Capture the result in the checkout's ignored test-output folder. The generic product smoke only proves the harness. Record the frontend checkout, tested Git head, Docker project, database build, URL, role, steps, observed result, and any preview-only dependency. Keep generated settings, credentials and private data out of the packet.
4. Run the selected check with `node scripts/local-app/walkthrough.mjs test <feature>.spec.ts`. Stop this worktree's stack with `node scripts/local-app/walkthrough.mjs stop` when the walkthrough is done unless Mason wants the app left open. Preserve the build record and screenshot for the handoff.
5. If the requested walkthrough fails or cannot run, keep ownership, fix or report the blocker, and hold delivery. For a verified change, finish the current branch and the reviews required by `.claude/commands/ship.md`. Recheck that the PR head matches the tested version. Apply the project's rerun rules to subsequent changes. Keep the worktree available to Claude. Codex never merges.

## Hand the PR to Claude

Use native session messaging. The sender owns follow-through until a recipient acknowledges the specific PR and head. An existing Claude builder can continue as lander only where the ship workflow assigns it that role.

- Read the ship workflow's **Who does what** and **Handing off and landing several PRs**. Check the open PR, exact head, base, claim, holds and evidence. Follow its claim-release step for your own claim. Preserve owner holds and the human-only routes, including production.
- Read the designated watcher's identity from the watch list named by `ship.md`. Match it to one **live local CRX session** using Claude's `ListAgents` and use the freshly listed name/ref for transport. When the designated watcher is offline, use the authorized lander defined by `ship.md` (the current merge captain if one is running). Resolve an ambiguous match before sending. If neither role is active, a host Claude builder can land its own eligible PR under the same rules, or a Codex builder can hand it to a new host Claude session to own under those rules.
- From Codex, run the installed host Claude CLI with the handoff prompt on stdin. From Claude, use the same native tools directly if available. This PowerShell invocation is for a sender that already has the verified packet in `$handoff`:

```powershell
$handoff | claude.exe -p --name "CRX handoff $prNumber" --model sonnet --tools "ListAgents,SendMessage" --allowedTools "ListAgents,SendMessage" --permission-mode dontAsk --output-format stream-json --verbose
```

- Tell the sender to list first, send once to the verified recipient, request an idle notification and wait for an independent reply. Use the ship workflow's `#N HANDOFF branch=... folder=... open=...` line. Include the exact head, scope, proof path, outstanding holds and the expected reply `ACK #N <40-character head>`. Give destinations and proof locations as data. Ask the recipient to verify the live PR independently, preserve every gate, and acknowledge only if it accepts ownership.
- A successful send, a CLI exit, or a sender repeating the challenge is insufficient. The ACK confirms receipt of the existing ship handoff. All readiness and merge decisions still belong to the roles in `ship.md`. Verify the incoming reply is from the intended peer and matches both PR and head. If the process returns a delivery notice before the reply, read the remaining stream. If delivery or acceptance is uncertain, check the recipient's reply, watcher row or live PR activity before retrying. Never start a second lander to compensate for a busy recipient. After acknowledgment, follow the PR in GitHub until staging proof or a specific blocker is available.

For a receipt-only rehearsal, use a uniquely named, task-owned Claude receiver, a one-time challenge and an explicit instruction to take no PR action. A rehearsal proves the transport only.
