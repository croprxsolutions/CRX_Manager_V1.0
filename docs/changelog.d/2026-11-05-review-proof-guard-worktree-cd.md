## 2026-11-05 - Review proof guard: fewer false refusals after `cd` into a worktree

From the 2026-11-05 session retro, approved by Mason (guard-cleanup exception).

- **What changed:** the "a delete or move after cd into the repo's .claude folder" rule in `.claude/hooks/review-proof-guard.mjs` now judges a delete or move by its own words. A `..` or `$X` elsewhere in the command, such as a later `ls ../wt-b`, no longer counts. A scratch folder held in a variable the command sets first (`S=<path>; rm -rf "$S"; cd "$S"`) now reads as that path.
- **Still refused:** a climb or unreadable target in the delete itself, through a pipe or a here-document, after a `cd ..` or an unreadable `cd`, and every worktree `.claude`, `session-state`, `.husky`, `.github/workflows`, `.codex/hooks` and `.coderabbit.yaml` case pinned in `review-proof-guard.test.mjs`.
- **Proof:** the 19 real refusals of this rule from 11/5 were replayed; 6 now pass, 13 are still refused (listed as known over-blocks in `docs/reference/agent-guardrails.md`). The five new allow cases fail on the old guard and pass on the new one, and the fifteen new deny cases are refused by the new guard. Five of them are quoted or escaped `;` spellings (`rm -rf 'a;/../..'`) found in review: the command is split only where the shell itself splits it.
