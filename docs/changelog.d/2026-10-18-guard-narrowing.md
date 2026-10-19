## 2026-10-18 — Guards narrowed to what they protect; no prompts for guard-file edits

**Why.** An audit of which hooks block safe work, checked by an independent adversarial Opus review,
found five refusals that cost far more than they protected. Since 2026-10-03, the merge and push
gates refused ordinary inline scripts in about 86 sessions. The review proof guard denied any command
mentioning a `.claude` path next to a word like "rm" in 34 sessions. The hold latch froze whole
sessions on helper reports, twice more on 2026-10-18 alone. Mason approved the revised plan
("Yes revised plan") and the permission change ("Change permissions to not always prompt me allow it").

**What changed.**
- `.claude/hooks/codex-push-lib.mjs`, `pr-merge-guard.mjs`, `codex-push-guard.mjs`: the run-time-text
  and fed-interpreter refusals run only when `couldReachGatedAction` finds a gated word, or
  obfuscation together with a way to run a program. Every readable merge, push and `--admin` check is
  unchanged.
- `.claude/hooks/hold-latch-lib.mjs`, `hold-latch-guard.mjs`: `holdDecision` returns deny, warn or
  allow. Outward actions deny. Push and merge are now read through autopilot's global-option-aware
  patterns, which closes the `gh pr merge … --match-head-commit` gap. Local edits and commits warn.
- `.claude/hooks/review-proof-guard.mjs`: the `.claude` ancestor rule is narrowed to whole targets,
  keeping `.claude/worktrees` at full breadth. `.claude/agents` and `.claude/commands` are enforcement
  surfaces. `codex-push-lib.mjs` `reviewProofPathMentioned` now also protects `migration-review-*.json`,
  `owner-approval-*.json`, `AUTOPILOT.on`, `applied-migrations.json` and `hold.json`.
- `.claude/hooks/bash-safety-lib.mjs`: the retired maintenance-producer rule is removed.
- `.claude/settings.json`: every `Edit(...)`/`Write(...)` entry is removed from `permissions.ask`.
  `scripts/check-agent-guidance.mjs` pins the reversal.
- Tests updated in `guards.test.mjs`, `review-proof-guard.test.mjs`, `bash-safety.test.mjs`,
  `mcp-tool-guard.test.mjs`, `pr-merge-guard.test.mjs` and `merge-guard-launcher.test.mjs`. Docs
  updated in `docs/reference/agent-guardrails.md`, `docs/manual/DECISION_LOG.md` and
  `docs/manual/KNOWN_ISSUES.md`.

**Proof.** Every `.claude/hooks/*.test.mjs` suite passes. Ran against the real hooks:
- the merge and push gates allow 11 ordinary shapes and still deny every merge and push form tried,
  except the two file-payload forms, which now match `bash payload.sh`;
- the hold latch with a latched `hold.json` warns on an edit and a commit, and denies `gh pr merge`,
  `git -C … push` and `select public.void_invoice(42)`;
- the review proof guard passes the reviewer's over-block probes and denies every forgery probe.

**Luna round 1 (7 findings).** Fixed:
- inline scripts that join strings with `+` (`'g'+'h pr '+'mer'+'ge'`) now count as obfuscation;
- the review proof guard's home-folder exclusion is anchored to a real home folder;
- the hold latch treats `gh api --field/--raw-field/--input` and writing REST clients (curl,
  wget, Invoke-RestMethod/WebRequest with a write method or a body) as outward;
- the launcher parity test now requires the working guard to deny every gated form, with one
  listed exception that main also allowed.

Declined, with reasons:
- (MED) a computed or fed command that merely mentions `git`/`merge`/`push` is still refused. That
  is the intended speed bump, and the common harmless shapes have no such word.
- (MED) the bare `deploy` match under a hold is unchanged from before this PR and errs toward
  blocking only while a stop is latched.
- (superseded in round 2, see below) inline `node -e` code.

**Codex connector (2 P1) and Luna round 2 (8 findings).** Fixed:
- a program name assembled from shell variables in the same command (`a=g; b=h; … $a$b pr $c$d 951`)
  is refused outright (`programAssembledAtRuntime`). main allowed it too;
- inline code arguments (`node -e`, `python -c`, `perl -e`, `ruby -e`, `php -r`) are refused when the
  CODE itself could reach a gated action (`inlineCodeReachesGatedAction`). main allowed the base64
  `node -e` merge. `gh … | node -e "…"` still passes when the code shows nothing gated. The fallback
  launcher counts any inline-code launch as a possible merge;
- `.`/`..` segments below `.claude` (`find .claude/./ -delete`, `.claude/hooks/../session-state`)
  count as the whole folder or the state dir;
- the `~`/`$HOME` home exclusion is anchored to the start of a word;
- the hold latch treats `gh pr update-branch`, `gh workflow run`, `gh secret/variable set`, repo,
  release, issue, label and gist writes, `curl -T`/`--upload-file` and `wget --method=…` as outward.

Refuted with a probe: `cp /tmp/payload .claude/./hooks/…` was already denied, because
`namesEnforcementSurface` resolves dot segments.

Declined: a fed script whose text names `git` (intended speed bump), the
`ls .claude/session-state | grep del` over-block (pinned in the tests), and `vercel whoami`
under a hold (the `vercel\s` match is unchanged from before this PR).

**Luna round 3 (9 findings), last iterating round.** Fixed: `fromCodePoint`/`fromhex`/`unhexlify`/
`pack(`/`ord(` and a bare `join(` count as obfuscation; inline code attached to its short flag
(`perl -e'…'`) is read; and under a hold any `psql`/`pg_restore` launch is outward.

Declined: an assembled program name that cannot reach a gated action is still refused
(`P=python; $P --version`, which is rare); inline code that only prints a gated word; the bare `deploy`
match; the hold's deliberate `create_directory` deny (in the tool superset since 2026-07-13);
the pinned `ls … | grep del` over-block; and SQL keywords inside string literals under a hold.

**Mason, 2026-10-18: no more iterating Codex rounds** ("call it good if we are fixing little tiny
bugs"). Rounds 1–3 kept finding new spellings of one class: a merge hidden inside code that a
runtime executes. A text check cannot close that class, because `node file.mjs` running the same
code has always been allowed. It is recorded as a **speed bump**, not a boundary. Each spelling
found was added, and the remaining residual is stated here and in agent-guardrails.md.

**Codex connector on `1f43c9cd4` (3 P1).** Fixed: a `printf` format with a `%` directive counts as
obfuscation (`printf 'g%s pr m%s 951' h erge | bash`); a path below `.claude` built at run time
(`.claude/s$(printf ession-state)`, `.claude/$X`) counts as the state dir; and under a hold,
`gh <global options> api … -f` is outward.

**Takes effect** only after `C:/CRX_Manager` is fast-forwarded past the merge, because worktree
sessions load hooks and settings from the main checkout.
