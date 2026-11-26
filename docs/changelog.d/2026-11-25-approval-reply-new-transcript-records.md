## 2026-11-25 — Skip and approval replies survive Claude Code's new transcript records

Mason's `skip` replies were refused ("did not show the approval request's summary alone") even
when the agent's last message was exactly the printed summary. Claude Code 2.1.33x now writes two
new records between the agent's message and his reply, and the reply hook's backward scan treated
any unknown record as a boundary.

- `lastAgentMessageText` (`.claude/hooks/owner-approval-lib.mjs`) now skips a `mode` record
  (`{mode: "normal"}`) and a `data-flow-records` record (tool names and ids only; checked on
  ~29,000 real records) when it carries no `message`, `content` or `text`. One that does still ends
  the scan, as does every other unknown record.
- `api-request` and `api-request-blob` stay boundaries: they copy conversation text, and they were
  never seen between an agent's last message and a reply.
- Proof: replaying the hook's scan over a real 2026-11-25 transcript, 4 of 13 `skip` replies found
  no agent message before the fix; all 13 find the summary after it.
- Tests: `.claude/hooks/owner-approval-lib.test.mjs` (real shapes pass; the same records carrying
  text, and the two api-request types, still end the scan).
