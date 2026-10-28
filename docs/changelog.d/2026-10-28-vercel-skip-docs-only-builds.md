## 2026-10-28 - Skip Vercel builds for notes-only pushes

Vercel bills build time by the CPU minute, and in the period from 2026-10-10 to 2026-10-28 builds cost about $56, more than the Pro plan itself. In the 24 hours before this change Vercel ran 100 builds, and 45 of the 51 test builds whose files could be checked changed only notes and docs, which the Vite build never reads.

`vercel.json` now sets `ignoreCommand` to `scripts/vercel-ignore-build.sh`. The script compares a push with the branch's previous successful deployment (`VERCEL_GIT_PREVIOUS_SHA`) and skips the build only when every changed file is under `docs/`, `.claude/`, `.agents/` or `.codex/`, or is Markdown at the repository root or under `supabase/` or `scripts/`. It builds whenever it cannot prove that: a branch's first push, a previous commit missing from the shallow clone, no file differences, or any other changed file. Markdown under `src/` or `public/` always builds. `DEPLOYMENT.md` › Vercel configuration documents the rule.

No application, database or business-data changes. Validation: the script was run against real repository commits for a docs-only range (skip), an app-code range (build), a missing previous deployment (build), an unknown previous commit (build) and an empty range (build).

Separately, and outside the repository, Mason cancelled the unused Speed Insights Plus add-on ($10 a month, no events collected) on 2026-10-28; it stays active until 2026-11-10 and does not renew.
