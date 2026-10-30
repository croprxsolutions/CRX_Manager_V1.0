## 2026-10-29 - Sol risk check: Sol review fixes

- Login, permission, database-access and app-wiring code (for example `src/lib/db.ts`, `src/App.tsx`, auth and permission files), repository configuration at the root, `public/` and `eslint-local-rules/` now count as risky, so they need Sol.
- A Sol review of an earlier commit now covers the later commits only when those later commits are low risk themselves; a risky change made after Sol needs Sol again. Both merge guards enforce this.
