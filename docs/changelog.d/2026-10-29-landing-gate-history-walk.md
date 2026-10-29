## 2026-10-29 — Migration landing gate walks main's history (Luna HIGH on PR #1206)

- `proofBaseStillCovers` no longer reads GitHub's net compare between the Sol proof's base
  and today's main: a net diff hid a migration added and later removed, or renamed out of
  `supabase/migrations/`, and stopped at 300 files. It now walks main's own history
  (`git log --first-parent -m --no-renames`) and refuses if any step touched the folder; a
  commit missing locally refuses (run `git fetch origin`). An empty main commit no longer refuses.
- Checked against real git: code-only and empty commits pass; add-then-delete, rename-out and
  a missing commit refuse.
