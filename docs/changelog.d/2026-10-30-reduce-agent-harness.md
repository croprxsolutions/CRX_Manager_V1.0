## 2026-10-30 - Agent harness reduced to the owner keep list

Mason asked for fewer guardrails ("I want less strict rules ... our harness has gotten way to strict") and approved the cut list in chat ("Approve the list").

- **CodeRabbit threads:** an outdated thread no longer holds a merge, and a resolved thread needs no reply.
- **Codex** may post plain-text replies on review threads.
- **One CodeRabbit review** on any commit satisfies a `needs-coderabbit` PR.
- **Sol** now runs only for changes on `docs/reference/sol-required-paths.md` (`sol-risk-lib.mjs`); `sol-exempt-lib.mjs` is deleted.
- **Shell-spelling checks** are removed from the push, merge and Codex production guards. Plain spellings still fire.
- **`ship.md` and `agent-guardrails.md`** are shortened to current rules.

Kept: secret protection, no force-push, no direct push to `main`, no `--admin` merges, CI and status checks, the destructive-migration approval, the migration-apply proof gate, and the database rules for money and inventory. Decision: `docs/manual/DECISION_LOG.md`, 2026-10-30.
