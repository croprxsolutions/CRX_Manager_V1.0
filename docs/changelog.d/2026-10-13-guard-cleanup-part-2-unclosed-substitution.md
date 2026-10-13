## 2026-10-13 — guard cleanup, part 2: an unclosed `$(` no longer hides a later one

Follows `2026-10-12-guard-cleanup-part-2-identifier-chars.md`.

**Fixed (CodeRabbit, Major, on 3d0130285)**

- `codex-push-lib.mjs`, `splitSubstitutions`: a quoted `'$('` opened a quote that never closed, so the splitter gave up there and a real `$($P pr merge 1 --admin)` AFTER it was read as plain words, where the `x=$($P` assignment is skipped. `P=gh; echo '$('; x=$($P pr merge 1 --admin)` passed both the merge and push guards (it passes on `main` too, as does the reverse order this PR already closed). The text after an unclosed `$(` is now returned as `unclosed` and checked like any other substitution, so a run-time program anywhere in it is found.

**Not taken: CodeRabbit's suggested fix**

- It refused every command with an unclosed `$(`. The reader does not know heredocs, so the everyday `git commit -m "$(cat <<'EOF' … EOF )"` and `gh pr create --body "$(cat <<'EOF' … )"` read as unclosed whenever the message holds an apostrophe ("don't", "it's"), and both would have been refused — a new false alarm on nearly every agent commit. Checking the unclosed tail instead refuses the hidden merge and keeps those messages.

**Proof observed**

- The real `pr-merge-guard.mjs` and `codex-push-guard.mjs`, from this head: seven hidden merge or push shapes deny (a quoted or double-quoted `$(` before the merge, one after it, a heredoc with a lone `'` inside the substitution, a heredoc commit message before the merge, and four-deep nesting after an unclosed `$(`); from 3d0130285 six of them were allowed. Heredoc commit and PR messages with apostrophes, `echo '$('`, the read loop, `i=$(($i+1)); git status`, `x=$(git rev-parse HEAD)` and `git status; echo '$('` all still pass.
- New assertions in `codex-push-lib.test.mjs` and `pr-merge-guard.test.mjs` fail with the new check switched off and pass with it on; `npm run test:correction-guards`, `npm run test:agent-workflows` and `npm run agent-health` exit 0.
