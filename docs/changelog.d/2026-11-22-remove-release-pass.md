## 2026-11-22 - Mason's release pass removed

- The `ship the release` / `go live #<n>` pass (#2098) is switched off: its prompt hook is no longer routed, and the merge guard and the migration landing gate no longer accept it. Taha or Mason merges the release, hotfixes and the back-merge again, and live applies wait for Taha's `Ready to merge:` comment as before.
- Why: Sol's round 1 on release #2189 found 6 BLOCKER/HIGH in the pass, and round 2 on the fixes found 5 more; Mason chose removal over more patching (2026-11-22).
- Kept from #2098: Mason's plain `yes` (24 hours) for a destructive migration, and a destructive migration may merge into `staging`.
- `release-pass-lib.mjs`, its test and `release-pass-prompt.mjs` stay on disk unused (the hook guard refuses agent deletions there); a human can delete them.
