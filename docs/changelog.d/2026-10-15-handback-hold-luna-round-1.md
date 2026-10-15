## 2026-10-15 — preamble-less hand-back fix: Luna round 1 changes

Follow-up to `2026-10-15-vercel-deny-names-and-preambleless-handback-hold.md`, same PR.

- **Empty prompts (Luna MED, fixed).** The new hand-back check read past the end of an empty or
  blank prompt. It now returns "not a report" for those; tests cover `""`, spaces and blank lines.
- **Mason's halt next to a preamble-less report (Luna HIGH, narrowed).** The first cut also routed
  such a prompt through `hold-latch-prompt.mjs`'s peer-turn path, which strips a truncated report
  whole, so an indented "stop" Mason typed under one could be lost. That routing is removed: a
  closed report is stripped, a truncated one is kept for the latch (the existing fail-safe), and
  `hasAuthoredText()` still strips it strictly, so it cannot clear a hold. Residual, same as the
  preamble form since 2026-09-25: an indented line inside a CLOSED report with the harness's exact
  frame is read as report text.
- **Email `send_message` has no ask/deny rule (Luna HIGH, deferred).** Pre-existing, not introduced
  by this change, and recorded in `docs/manual/KNOWN_ISSUES.md`; it is a permissions change
  awaiting Mason's go-ahead as its own PR.
