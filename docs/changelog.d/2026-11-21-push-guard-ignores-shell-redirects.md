## 2026-11-21 - The push guard no longer reads shell redirections as branch names

A retro found two harmless pushes of docs PR #2110 refused with "LANDING CLAIM: another session is landing branch \">\"". The landing claim read `2>` (from `2>&1`) and `>` / `out.txt` (from `> out.txt`) as branches being pushed, and other sessions already held claims on those fake names.

`splitShellArgs` in `.claude/hooks/codex-push-lib.mjs`, the word splitter every push-argument reader there uses, now drops redirection operators (`>`, `>>`, `2>`, `<`, attached forms like `>out.txt` or `2>/dev/null`) and their target file. A quoted `'>'` stays a real argument. Pipes and `&&`/`;` were already cut off. A real claimed branch is still refused behind a redirect, and main-branch pushes are still caught.

Tests: `.claude/hooks/pr-claim-lib.test.mjs`.
