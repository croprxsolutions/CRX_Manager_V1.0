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

**Takes effect** only after `C:/CRX_Manager` is fast-forwarded past the merge, because worktree
sessions load hooks and settings from the main checkout.
