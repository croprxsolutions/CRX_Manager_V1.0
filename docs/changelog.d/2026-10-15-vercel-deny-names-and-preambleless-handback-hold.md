## 2026-10-15 — Vercel/Supabase permission rules use the real tool names; a helper-agent report no longer trips the hold

Found in a harness review Mason asked for (2026-10-15).

- **Vercel rules matched nothing.** About 90 allow/ask/deny rules in `.claude/settings.json` were
  spelled `mcp__Vercel__…`. Every Vercel call in every saved session uses the connector's real name,
  `mcp__0fb370f6-ff90-41a7-8c20-6f1490a21d59__…`, so production promote, rollback, create-deployment,
  domain purchase and env-edit were never denied by them. Checked live on 2026-10-15: a
  `cancel_deployment` call with a made-up ID went straight through to Vercel (404) under the old rules.
  The rules are now spelled with the real name. The duplicate `ask` copy of `deploy_to_vercel` was dropped
  because the `deny` copy wins anyway.
- **Supabase.** The `mcp__Supabase__…` (capital S) rules also matched nothing; the three that had no
  correct-name twin (`list_edge_functions`, `get_project`, `get_edge_function`) are re-spelled with
  the connector's real name and the rest removed as duplicates. Secret creation, project
  pause/restore/create and branch create/delete/merge/rebase/reset now ask first on both Supabase
  connections. The email `send_message` gap in KNOWN_ISSUES stays open.
- **Hold latch.** The hook payload for a subagent's hand-back can start at its `<agent-message>` tag,
  without the "Another Claude session sent a message:" line the transcript shows. The report body
  (a list of hook events containing "Stop") then latched `hold.json` in the main checkout, blocking
  other sessions that share it, and the same report could also clear a hold Mason had set.
  `prompt-source-lib.mjs` now treats a prompt that opens with a column-zero open tag followed by
  the harness's exact "[Subagent hand-back] The text below is the final report of a subagent" frame
  as a report; `hold-latch-prompt.mjs` treats it as a peer turn. Proof: the two real hand-backs
  that latched holds today latch under the old code and not under the new; new assertions in
  `prompt-hooks.test.mjs` fail on the old code and pass on the new.
- Mason's personal `autoCompactWindow` was set to 800,000 (it was 1,000,000, at the 1M ceiling, against
  his own global rule). That is a user setting, outside the repo.
