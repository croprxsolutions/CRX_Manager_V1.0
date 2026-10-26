## 2026-10-26 — Looser merge and push gates: stop refusing ordinary commands

**Why.** Mason, 2026-10-26: "dont close holes i want loooser guards." A 30-day audit of 266 sessions
found the PR MERGE GATE made 1,171 blocks with about 39 real catches (~97% false). Most were the
"program built at run time" refusal on commands that could not merge or push (`"$NODE" x.mjs`,
`"$CODEX" --version`), and inline `node -e` code refused for containing the word `push` or `merge`
(`a.push(x)`, a regex). Same refusals in the CODEX GATE.

**What changed** (`.claude/hooks/codex-push-lib.mjs`, used by both gates):
- `runtimeProgramRefused(command, gated)`: a program run from a whole variable is refused only when
  the command could reach a gated action (`couldReachGatedAction`) or glues a word from run-time
  pieces (`$a$b`, `$(printf g)h`, `m$(echo e)rge`, `g${X}t`).
- Inline code (`node -e`, `python -c`, `perl -e`, `ruby -e`, `php -r`, `deno eval`) is refused only
  when it shows a gated word AND can start a program or reach the network (`child_process`, `exec`,
  `system(`, `fetch`, a URL; backticks in Perl, Ruby, PHP).

**Unchanged:** every readable `gh pr merge` is still gated (Sol proof, head pin, `--admin`/`--auto`
ban, CodeRabbit-on-money); raw REST/GraphQL merges, text piped into a shell, gh aliases and
escape-character spellings are still refused. GitHub still refuses any push to main.

**Proof.** The real hooks were run on JSON payloads: four former false blocks now pass; nine hidden
or illegal merges/pushes (`export P=gh && $P pr merge 1`, `$a$b pr $c$d`, `$(printf g)h pr …`,
`P=g$(echo h); $P pr m$(echo e)rge`, `node -e` with `child_process`, `echo … | bash`, `curl -X PUT
…/merge`, `--admin`, `$a$b $c$d origin HEAD:main`) are still denied by the merge gate. New
assertions in `.claude/hooks/guards.test.mjs`; `test:correction-guards` and `test:agent-workflows`
pass.

**Not done:** dropping the bare word `git` from the gated-word list was refused by the session's
auto-mode safety classifier, so it awaits Mason's explicit approval. The Codex-only
`production-action-guard.mjs` still refuses run-time text unconditionally.
