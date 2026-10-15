## 2026-10-15 — preamble-less hand-back fix: Luna round 2 changes

Same PR as `2026-10-15-vercel-deny-names-and-preambleless-handback-hold.md`.

- **Fixed (Luna HIGH).** The lower-case `mcp__supabase__` connection was missing ask rules for
  `pause_project`, `restore_project` and `create_project`, so the first entry's "both connections"
  claim was wrong. They are added; both Supabase connections now ask for those actions.
- **Disputed (Luna BLOCKER), surfaced to Mason.** A prompt that opens with an `<agent-message>` tag,
  the harness's exact "[Subagent hand-back] The text below is the final report of a subagent"
  frame, an INDENTED "stop now" and a closing tag does not latch. Measured: the existing preamble
  form (on `main` since 2026-09-25) gives the same result for the same shape, and a stop typed on its
  own line after the closing tag still latches. Typing that exact harness wrapper is not something
  a chat message does by accident.
- **Not from this change (Luna HIGH x2).** `execute_sql` on the claude.ai Supabase connector is a
  deliberate allow rule (unchanged here), and the email `send_message` gap stays recorded in
  `docs/manual/KNOWN_ISSUES.md`.
