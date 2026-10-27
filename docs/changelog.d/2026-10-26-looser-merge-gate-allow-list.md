## 2026-10-26 — Looser merge gate: switched to an allow-list

After about twelve review rounds each found a new way to make one variable expand into several words
(unquoted splitting, wrappers, splats, substitutions, and finally `"${ARGS[@]}"`), Mason chose an
allow-list (2026-10-26): the only run-time program the merge and push gates allow is one quoted simple
variable — `"$NAME"` or `"${NAME}"` — with no other variable in the command, nothing glued from run-time
pieces, and no gated word. Every other run-time-built program is refused, as on main. A program the
stricter `programAssembledAtRuntime` test finds but the allow-list scan does not see in its allowed shape
is refused too. `.claude/hooks/codex-push-lib.mjs` (`SAFE_RUNTIME_PROGRAM_RE`); cases in
`.claude/hooks/guards.test.mjs`.
