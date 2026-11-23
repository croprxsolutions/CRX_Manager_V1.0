## 2026-11-22 — Agents can't merge into Taha's areas until Dec 15

- Mason to Taha (Slack, 2026-11-22): until Dec 15 our agents never merge into `staging` a PR that changes Taha's
  areas (quotes, bookings, purchasing holds, chemical invoices and billing), whatever OK line it has. #1980 and
  #1989 merged after Taha asked; a written rule did not stop them, so both merge gates now refuse
  (`.claude/hooks/taha-lane-lib.mjs`, called from `pr-merge-guard.mjs` and `.codex/hooks/production-action-guard.mjs`).
- Field billing (field invoices, spray jobs, blend tickets) is Mason's and is not blocked. A file list GitHub can't
  read, or one of 250+ files, refuses.
- Mason's way past it: the refusal shows a 6-digit code; his message of its own `taha override <code>`
  (`.claude/hooks/taha-lane-prompt.mjs`) lets that one PR through for 24 hours. The block turns itself off after Dec 15.
