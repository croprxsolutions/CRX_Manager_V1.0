## 2026-11-03 - Pre-push builds only for app changes; stale manual stamp warns on unrelated PRs

From the KI-85 (PR #1338) retro, approved by Mason.

- **Pre-push:** type check and build now run only when the pushed commits touch app files (`scripts/prepush-needs-build.mjs`). Containment still runs on every push, and CI still builds every PR. Proven: a scripts/docs push skipped the build in about 1 minute; an `src/` push still ran type check and build.
- **Manual freshness:** a stale "Last verified" stamp now fails only a change that adds a migration or touches CURRENT_STATE/KNOWN_ISSUES; others get a warning. Pushes to main use the push-before sha, so main goes red only when the merge itself adds or changes a migration or touches either doc. What still enforces freshness: every migration PR's own CI fails on a stale stamp, and so does the main push that lands it. Proven with the stamps set back to 2026-10-01: this branch WARNs, a migration change FAILs, an unreadable base FAILs.
- **Local test app:** `scripts/local-app/app.mjs` decodes the baseline with `--with-live-rows`, so a rebuild passes the KI-85 replay. Not rebuilt here: another checkout owns the running test copy.
