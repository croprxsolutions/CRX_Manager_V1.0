## 2026-10-21 — Agents request one CodeRabbit full review on money and Mason-named PRs

- Mason's decision (2026-10-21): a PR that touches money, invoices, payments, inventory, or costs,
  or one Mason asks a session to have reviewed, merges only with a clean CodeRabbit review of its
  current head as well as the clean Sol review. The agent requests it itself with one
  `@coderabbitai full review` comment on the frozen, green head; Mason no longer posts it by hand.
- Limits: wait for an automatic review still in progress; one request per head, plus one retry
  after a stated rate-limit wait (30 minutes if CodeRabbit is silent), then the PR is reported
  stuck. A qualifying PR drops `docs(` from its title so CodeRabbit does not skip it. A code fix prompted by CodeRabbit moves the head, so Sol re-runs and one new full
  review is requested. A plain merge of main does not need a new CodeRabbit review.
- Enforcement is written, not mechanical (Mason: keep it simple): no merge gate checks for the
  review; a coordinator session asks for `CR-CLEAN #<PR> head <sha>` before its GO. A hard
  merge-gate check is a separate follow-up.
- Every other PR keeps the 2026-10-19 advisory rule: no `@coderabbitai` commands.
- Updated together: `AGENTS.md`, `scripts/check-agent-guidance.mjs` (now checks the new wording),
  `.claude/commands/ship.md`, the `codex-review` and `deploy-check` skills (and their generated
  `.agents/` copies), the hook landing-policy text in `.claude/hooks/prompt-source-lib.mjs`,
  `.coderabbit.yaml` comments, `docs/reference/coderabbit-native-review.md` (full rules),
  `docs/reference/agent-guardrails.md`, `docs/reference/gotchas.md`,
  `docs/workflows/SAFE_DEVELOPMENT_RULES.md`, and `docs/manual/DECISION_LOG.md`.
- Checked: no hook, permission rule, or required check blocks an agent from posting the comment.
  The merge gates still deny any open or unreplied CodeRabbit thread.
