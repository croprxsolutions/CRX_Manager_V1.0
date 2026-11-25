## 2026-11-25 — Skip and approval replies ignore any text-free transcript record

Mason's `skip` and `approve` replies were refused on 2026-10-20 (`mode`) and again on 2026-11-25
(`mode`, `data-flow-records`), each time because Claude Code began writing a new record type
between the agent's message and his reply. Each fix listed the new type by name, so the next
Claude Code update would break it again.

- `lastAgentMessageText` (`.claude/hooks/owner-approval-lib.mjs`) now also skips a record of any
  type outside the conversation types (`user`, `assistant`, `system`, `queue-operation`, `summary`)
  when every field name and string value in it is a bare identifier (no spaces, so no sentence)
  and no field is named `message`, `content`, `text`, `summary` or `prompt`. Real examples:
  `api-request` (metadata only), `tools-used`, `cost-state`, `session-owner`, `permission-mode`,
  `derived-from`.
- A record with any free text still ends the scan: `api-request-blob`, `api-request-shape`,
  `ai-title`, or any field carrying a sentence. `mode` and `data-flow-records` keep their stricter
  surveyed shapes.
- Proof: replaying the scan over the 149 short replies in Mason's 30 most recent transcripts, 148
  give the same result before and after; the one that differs had a `tools-used` record after the
  agent's message, so the old scan saw no message and would have refused a skip there; the new one
  reads it.
- Tests: `.claude/hooks/owner-approval-lib.test.mjs` (the real text-free shapes are skipped; the
  test fails with the new rule removed; free text, free-text field names and conversation types
  still end the scan).
