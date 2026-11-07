## 2026-11-06 — Commit-time private-file check reads only the staged files

- `scripts/check-supplier-pricing-phase3-private-artifacts.mjs --pre-commit` now scans only the paths
  the commit adds or changes (`git diff --cached`), instead of every tracked, modified and untracked
  file. A commit with nothing staged went from about 46 seconds to about half a second.
- Approved by Mason on 2026-11-06. Pre-push, the direct `--range` mode, the GitHub-event mode and CI
  still run the full sweep (tracked, untracked, ignored and pushed history), so nothing reaches
  GitHub unchecked. The `--commit-msg` check is unchanged.
- Proof: a new fixture shows a staged private file is refused at commit while untracked and ignored
  ones are left to pre-push, and that pre-push still refuses them.
