## 2026-11-25 — Reply scan skips only the surveyed shapes of mode and data-flow records

Follow-up to #2555 (Taha's two LOW review items).

- `lastAgentMessageText` (`.claude/hooks/owner-approval-lib.mjs`) used to skip a `mode` or
  `data-flow-records` record whenever its top-level `message`, `content` and `text` were empty, so text
  inside `records[]` or `mode` went unchecked. It now skips one only when it has exactly a surveyed
  shape: known top-level keys, a short identifier for `mode`, and in `records[]` only id strings,
  booleans, id lists and small `{type, id, kind, action}` references. Anything else ends the scan.
- Proof: all 59,756 real records of both types from the last 14 days on Mason's PC (520 distinct
  shapes) still pass, and the 13 real `skip` replies from the 2026-11-25 transcript still find the
  summary.
- Tests: `.claude/hooks/owner-approval-lib.test.mjs` covers both types carrying `message`, `content`,
  `text` or `summary`, and text inside `records[]` or `mode`. Each one ends the scan.
