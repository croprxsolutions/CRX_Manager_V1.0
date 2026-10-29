## 2026-10-29 — Guard friction, part 3: routine migration applies accept 24-hour reviews

Mason approved Sol's recommendation: routine migration reviews last 24 hours, with fresh
checks right before applying; his "I approve" for data-deleting migrations stays at 30
minutes. This lets a migration PR land overnight once its reviews and checks are clean.

- `.claude/hooks/migration-apply-lib.mjs`: `PROOF_MAX_AGE_MS` (both reviewer proofs and the
  content-bound Sol proof) 30 minutes → 24 hours. `MAIN_REF_MAX_AGE_MS` stays 30 minutes,
  now its own constant.
- `.claude/hooks/migration-landing-gate-lib.mjs`: `APPLY_SOL_PROOF_MAX_AGE_MS` 30 minutes →
  24 hours, the same window the merge gates already use.
- `scripts/apply-migration-file.mjs`: fetches origin just before the gate, so the 30-minute
  fetch rule no longer refuses an apply after a long wait.
- Unchanged: Mason's chat approval (`OWNER_APPROVAL_MAX_AGE_MS`, 30 minutes, single use),
  exact SQL and head binding, and every live check at apply time.
- `AGENTS.md`, `ship.md`, `migration-review.md`, the codex-review skill, the database
  checklist, safe-development rules, the owner playbook, `agent-guardrails.md` and the
  decision log now say 24 hours.
