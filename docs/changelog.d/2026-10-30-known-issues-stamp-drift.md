## 2026-10-30 - Fix known-issues verification stamp drift

The current-main integration exposed duplicate and overlong `Last verified` stamps in `KNOWN_ISSUES.md`, which caused `check-doc-drift` to fail. Kept the current KI-18 date as one concise stamp and removed the superseded duplicate.
