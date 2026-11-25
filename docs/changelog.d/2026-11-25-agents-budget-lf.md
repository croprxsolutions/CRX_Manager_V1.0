## 2026-11-25 — Agent guidance size budget counts LF bytes

- `scripts/check-agent-guidance.mjs` now measures `AGENTS.md` and `CLAUDE.md` after turning CRLF line
  endings into LF (the shared `normalizeEol`). Windows checkouts store CRLF, so the same 11,978-byte
  `AGENTS.md` measured 12,060 there and failed `check:agent-guidance`, `test:agent-workflows` and
  `agent-health` in every Windows worktree while CI passed.
- Unchanged: the limits (12,000 bytes / 90 lines for `AGENTS.md`, 6,000 / 60 for `CLAUDE.md`) and
  every pinned sentence.
