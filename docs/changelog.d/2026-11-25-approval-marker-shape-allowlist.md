## 2026-11-25 — Reply scan skips only the surveyed shapes of mode and data-flow records

Follow-up to #2555 (Taha's two LOW review items).

- `lastAgentMessageText` (`.claude/hooks/owner-approval-lib.mjs`) used to skip a `mode` or
  `data-flow-records` record whenever its top-level `message`, `content` and `text` were empty, so text
  inside `records[]` or `mode` went unchecked. It now skips one only when it has exactly a surveyed
  shape: known top-level keys with their real types (`v` an integer, `snapshot` a boolean), and in
  `records[]` only booleans, id lists and small `{type, id, kind, action}` references. Every string
  must be a bare identifier (letters, digits and `_ . : @ / + -`, no spaces), so a sentence in any
  field ends the scan (Terra HIGH x2).
- Proof: all 60,685 real records of both types from the last 14 days on Mason's PC (624 distinct
  shapes and character patterns) still pass. The 13 real `skip` replies from the 2026-11-25
  transcript still find the summary.
- Tests: `.claude/hooks/owner-approval-lib.test.mjs` covers both types carrying `message`, `content`,
  `text` or `summary`, text inside `records[]` or `mode`, and a sentence in `snapshot`, `v`,
  `sessionId`, `tool_name`, `listed` or a reference's `action`. Each one ends the scan.
