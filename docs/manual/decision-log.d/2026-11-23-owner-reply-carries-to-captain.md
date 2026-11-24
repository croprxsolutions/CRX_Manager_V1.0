## 2026-11-23 — Mason's approval or skip reply counts in whichever conversation shows him the question

**Decision (Mason, 2026-11-23):** "let's make it count because I generally hand work to a merge captain." His `I approve` / `skip` reply counts in any conversation whose last message showed the request's summary word for word, whichever session built the request, and any session (a merge captain) may use the recorded approval.
**Why:** he was opening terminals to approve skips and landings because a reply only counted in the exact session that built the request.
**What this forbids/implies:**
- Still bound: the exact migration file (or Sol head and findings), the PR, his words alone, 24 hours, once only. A reply to another session's request, in any form (`approve <code>` too), counts only right after that conversation showed the summary word for word; the apply re-reads that.
- The old per-finding `accept <code> <reason>` form stays in the session that built it.
- Requests are searched in every `git worktree list` checkout; independent clones are not found (fails safe: no approval).
- Residual: another checkout's reply hook records the receipt with that checkout's code; checkouts must be current. The apply re-checks his words and the shown summary with its own code.
- A request script in a session whose messages never reach the hook refuses unless run with `--show-elsewhere`, and then says to show the summary in the conversation Mason talks to. Never send him to a terminal.
