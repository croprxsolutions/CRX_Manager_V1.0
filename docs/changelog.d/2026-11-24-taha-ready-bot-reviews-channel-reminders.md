## 2026-11-24 — Taha ready bot: #crx-reviews pings, his verdict as labels, 24-hour reminder, topic labels

- The Taha ready bot now pings Taha in #crx-reviews (not #crx-work), once per PR head, with an optional two-line Haiku summary.
- It mirrors Taha's latest review on the current head as `taha-approved` or `taha-changes` (display only; the merge gates read his real review from GitHub).
- If Taha has not decided 24 hours after the ping, it reminds him once for that head.
- Scheduled runs add up to three `topic:` labels picked by Haiku from a fixed list; with no API key this step is skipped.
- A missing Slack token now fails the ping job loudly instead of passing quietly.
- The daily landing summary gains a "Taha reviews" section: approved, sent back, waiting.
