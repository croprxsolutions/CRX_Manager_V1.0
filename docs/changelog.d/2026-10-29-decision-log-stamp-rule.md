## 2026-10-29 — DECISION_LOG stamp rule made consistent (Luna on PR #1214)

- The DECISION_LOG footer told agents to bump "Last verified" on every review, contradicting the
  new rule that adding an entry does not change it. It now says: only after re-reading the whole file.
- `update-docs`: a stamp date with no scope means the whole document was re-read.
