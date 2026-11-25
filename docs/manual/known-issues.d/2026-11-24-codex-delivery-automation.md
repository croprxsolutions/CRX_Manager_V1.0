## 2026-11-24 — Align automation with the Codex delivery policy

**Severity:** MED. **Area:** Agent delivery. **Status:** OPEN. **Owner:** unassigned.

Align the startup reminder and automated delivery checks with the written Codex policy in the ship guide. Add a staging-base scope to the Opus review wrapper. Claude handles the protected implementation when scheduled and retains its guarded staging merge role.

Progress 2026-11-25: three parts are done: the startup reminder (#2535), the `--scope base-staging` option in the Opus review wrapper (#2508), and the `[HOLD FOR MASON]` check in Claude's merge guard (#2506). Still open:

- Codex's production guard still lets Codex merge a green PR with a valid proof, so "Codex stops at PR readiness" is a written rule only.
- No guard checks that the Luna xhigh and Opus 5.5 pre-push reviews ran on the exact head Codex pushes.
- Codex's production guard and `npm run pr-readiness` do not check the `[HOLD FOR MASON]` marker.
