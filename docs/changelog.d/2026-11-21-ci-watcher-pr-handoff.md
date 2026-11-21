## 2026-11-21 - Ship workflow: hand staging PRs to a standing CI watcher

- `.claude/commands/ship.md` gains "Handing a staging PR to the CI watcher": a session that opens a staging PR sends the main watcher one `#N HANDOFF` line (ids read from the watcher list file) and may then be archived. The main watcher owns the PR through READY; a backup watcher takes over stalled PRs.
- Why: ad-hoc watcher sessions per batch left PRs without a clear owner and kept finished sessions open just to watch CI (Mason, 2026-11-21).
