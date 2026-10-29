## 2026-10-29 — Guard friction, part 2: a relaxed harness (stop latch, money words, push and merge false alarms)

Mason: "i am fine with holes i our harness i want it more relaxed than too rigid". Each
change below trades an exotic bypass, named in the code as an accepted hole, for an end
to a false refusal that kept recurring.

- **Hold latch (`hold-latch-lib.mjs`):** only a halt COMMAND latches — a line or sentence
  beginning with stop / pause / halt / hold on|up|off / cancel (after an optional
  "please", "ok", "wait"…), or a request aimed at the agent ("I need you to stop", "can you
  pause"). "Make the gate stop refusing", Mason's own "I want it to stop blocking on
  certain words like stop", and the old scoping phrases ("just scoping", "for a new
  session") no longer latch. The halt messages no longer mention scope-only. Recorded in
  `docs/manual/DECISION_LOG.md`.
- **Money-PR test (`codex-bot-review-lib.mjs`):** money stems are matched against a
  path's words (split at punctuation and camelCase, plus adjacent pairs) instead of as
  substrings, so `paging`, `border` and `syntax` no longer force a CodeRabbit review.
  Checked against every tracked `src/` file: six non-money `*.paging.test.*` files left
  the set, and eight delivery and reconciliation files the old list missed joined it
  (`deliver`, `inventor`, `reconcil`, `surcharge`, `araging` added).
- **Push guard (`codex-push-lib.mjs`):** `PATH`/`PATHEXT` count only when assigned
  (`PATH=…`, `$env:Path += …`); the word "path" in a commit message no longer refuses
  the push.
- **Merge and push guards (`pr-merge-guard.mjs`, `codex-push-guard.mjs`):** a program
  started from a variable (`"$CODEX" exec …`) is refused only when the command could reach
  a merge, push or GitHub call. Accepted hole: a name and verbs built entirely from
  variables (`$a$b pr $c$d 951`).
