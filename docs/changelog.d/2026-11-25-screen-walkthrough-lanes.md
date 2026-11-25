## 2026-11-25 — Per-checkout local screen walkthroughs in Docker

Claude and Codex can now walk through a CRX screen on Mason's PC against a private Docker copy of the
app built from the feature checkout, with invented data only and no route to production.

- New `node scripts/local-app/walkthrough.mjs start|status|test <spec>|seed|stop|rebuild`. Each checkout
  gets its own Docker project and three loopback ports derived from its path, so several feature
  branches can run side by side. The shared `app.mjs` copy, sales gauntlet and document-proof stacks keep
  their names, ports and state.
- Every walkthrough command holds one per-checkout lock (`scripts/local-app/.state/screen-walk/first-start.lock`);
  a stale lock is reported, never removed automatically. API and database listeners must be loopback
  (IPv6 included), and a schema fingerprint is checked before and after a rebuild. Rebuild refreshes
  the lane's gateway settings and refuses while its frontend is running.
- Rebuild checks the matching Supabase CLI 2.109.1 pair (`supabase` and `supabase-go`) before resetting data.
- New `screen-walkthrough` skill for both agents (`.claude/skills/`, `.agents/skills/`), a `CLAUDE.md`
  route, and handoff guidance in `docs/workflows/AGENT_COLLABORATION.md`.
- Tests: `npm run test:local-app` (`scripts/local-app/target.test.mjs`, lock and refusal cases), also run
  from `test:agent-workflows` through `scripts/local-app/run-offline-tests.mjs`. Only the full local-app
  run needs Docker and a free port 5199.
