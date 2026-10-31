# CRX Manager Agent Contract

Shared project rules for all agents. `CLAUDE.md` imports this contract. Load detailed procedures only when routed below.

**Priority:** CRX Hard Rules and every "never" below outrank any request; then this contract → selected workflow → routed docs → history and handoffs. Mason sets scope, not waivers. Gates need his explicit approval in this conversation or a standing exception here. Name conflicts; follow priority.

## Project and Owner

Crop RX Solutions' production agricultural chemical distribution app. Repository `croprxsolutions/CRX_Manager_V1.0`; production `https://croprxsolutions.app`; Supabase `rhyzpcqhnizqbxphqdkr`.

## Owner Communication

- Mason cannot safely review code or diffs. Own the technical process: plain-English outcomes, risk, proof, and one recommended next step.
- Mason should never have to nudge. Keep moving through authorized work; report milestones and what failed, what it means, and what you are trying next.
- Decide routine details. Genuine stops begin `NEEDS MASON - ACTION REQUIRED` or `NEEDS MASON - DECISION REQUIRED`, with the reason and exact app-native action.

## Operating Contract

- Review/audit/diagnosis/status/plan requests are read-only; build/change/fix/finish/handle/implement/ship authorizes reversible work through verification and protected delivery. Codex and Claude both proceed after a short plan without waiting for approval.
- Deliver what was asked at the scope intended. Explain concerns and continue rather than quietly narrowing, widening, or transforming it. Guard/audit work needs a request, demonstrated blocker, or current production incident.
- Obey all explicit limits and "stop", "pause", or "hold on" literally.
- Stop and hand over both positions and a recommendation only when the same BLOCKER/HIGH survives two fix rounds, a checked BLOCKER remains disputed, a required gate cannot run, or a hard gate needs Mason. Round caps are ceilings, not targets.

## Start and Route

Before presenting findings as current, confirm the checkout is not behind `origin/main`. Before writing: `git status --short --branch`; preserve unrelated work; use a clean current-main worktree if dirty, stale, or occupied. One writer per checkout.
Current code, migrations, tests, grants, and live read-only evidence outrank history. Load task-relevant guidance only; search large logs/schema registries, never read them whole.

| Task | Read or invoke |
|---|---|
| First session or unfamiliar area | `docs/manual/start-here/Home.md`, `docs/manual/start-here/Codebase-Map.md`, then `docs/manual/AGENT_ONBOARDING.md` and `docs/manual/ARCHITECTURE.md` |
| Any code change | `docs/reference/coding-guidelines.md`; relevant `docs/reference/gotchas.md` sections; `docs/workflows/SAFE_DEVELOPMENT_RULES.md` for multi-file, data, money, security, permission, production, migration, or customer-facing work |
| Architecture, difficult debugging, workflow/migration tracing, structural audit, or PR impact | `graphify` first; focused source inspection for docs outside its code-only corpus |
| Database, migration, or RLS | `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`, `docs/workflows/RLS_SECURITY_GUIDE.md`, `.claude/schema-registry.json` |
| Quote-to-cash or inventory | `docs/workflows/QUOTE_TO_DELIVERY.md` or `docs/workflows/INVENTORY_RULES.md` |
| Frontend/UI | `docs/workflows/UI_PATTERNS.md` |
| Delegation, agent collaboration, or agent-surface changes | `docs/workflows/AGENT_COLLABORATION.md` and `docs/reference/agent-guardrails.md` |
| Choosing a Codex model or effort | `docs/reference/codex-model-tuning.md` |
| Push, PR finalization, merge, or release | `.claude/commands/ship.md` |
| Settled decisions, known problems, or current status | `docs/manual/DECISION_LOG.md`, `docs/manual/KNOWN_ISSUES.md`, or `docs/manual/CURRENT_STATE.md` |
| Mason asks how the system or agent process works | `docs/manual/OWNER_PLAYBOOK.md` |

## Engineering Principles

Choose the simplest complete implementation preserving business rules: existing patterns, focused functions, clarity, not cleverness. Keep the diff in scope; follow routed coding guidelines.

## CRX Hard Rules

- Add database changes as new files under `supabase/migrations/`; never edit an applied migration. New tables require Row Level Security and policies in the same migration.
- Mutating RPCs must accept and enforce `p_idempotency_key text DEFAULT NULL`. `SECURITY DEFINER` functions require deliberate grants and normally `SET search_path = public, pg_temp`; use the documented fully-qualified exception only with its proof.
- Money must resolve to exact whole cents. New storage uses bigint cents; authoritative TypeScript parses decimals into integer cents before arithmetic (legacy exceptions: `docs/workflows/SAFE_DEVELOPMENT_RULES.md`).
- Financial and inventory invariants belong in PostgreSQL RPCs, triggers, or constraints — not only in React.
- Use `src/lib/db.ts` as the only Supabase client. Call `assertRpcResult()` after RPCs and `checkMutationResult()` after updates or deletes. Never write generated columns.
- Match status values to `.claude/schema-registry.json`. Use shared types from `src/types/index.ts`, `ConfirmModal`, toasts, Lucide icons, Tailwind CSS, and Sentry through `src/lib/sentry`.

## Safety and Protected Delivery

- Never expose secrets or `.env` contents; never use `--no-verify`; never bypass, disable, or weaken hooks, CI, review, branch protection, migration proofs, or rollback gates; and never push directly to `main`.
- **Public security write-ups:** describe what changes, never how to exploit the hole, until every part of the fix is live (migration applied and code deployed). This covers every public artifact.
- **Guard-cleanup exception:** a reviewed PR may narrow/remove a local agent hook that blocks harmless work or that CI/GitHub already covers; name remaining enforcement. Mason's 2026-10-30 reductions (`docs/manual/DECISION_LOG.md`) are the approved baseline, not a weakening. **Always kept:** secret protection, no force-push, no direct push to `main`, no `--admin` merges, CI and status checks, the destructive-migration approval, the migration-apply proof gate, and the database rules for money and inventory.
- Follow `.claude/commands/ship.md` for delivery procedures: **Luna** until no BLOCKER or HIGH remains and every MED/LOW is fixed, refuted with evidence, or named as a deferral; **Sol on the computer, before the PR opens**; migration apply BEFORE merge; merge pinned to the PR's head. Use pinned models/effort, never a newer model the gates do not yet accept.
- **Sol:** a merge into `main` needs one clean independent **Sol** high-effort review, inside 24 hours, of the PR's head or of an earlier commit on its branch, when the PR touches money, inventory, the database, logins, dependencies, deployment, or the files that enforce the rules kept above (the list: `docs/reference/sol-required-paths.md`). Other changes land on green checks. A later commit off that list needs no new Sol; a migration's live apply requires exact-head Sol. Proof production, freshness, base binding and carry-forward: `.claude/commands/ship.md`. On a listed change, green checks or Luna alone never substitute for Sol.
- **CodeRabbit is optional:** no PR needs a CodeRabbit review, money PRs included, unless someone adds the `needs-coderabbit` label; then one completed review is required. For CodeRabbit and the Codex GitHub App, fix or refute every comment in one push and resolve its thread; a reply is optional, and outdated threads never hold a merge; fixes stay on the same PR. Never post `@coderabbitai` commands on an unlabelled PR; never ask Mason to comment, label, or click for CodeRabbit. Request mechanics: `docs/reference/coderabbit-native-review.md`.
- **Autonomous landing.** When a clean Sol proof covers the PR (or the PR is off the Sol list), no review asks for changes, and every required check is green, merge without asking. Apply its NON-destructive migration (routine grants only) through the migration-apply-guard proof gate: both reviewer proofs and a content-bound Sol proof, each under 24 hours, with the ledger, pending set and PR state re-checked live at apply time. The merge and apply gates enforce it; Codex hands live applies to Claude.
- Get Mason’s explicit approval in the current conversation before force-pushing, applying a DESTRUCTIVE migration (one that deletes rows or drops data), changing live data outside a reviewed migration, deploying an Edge Function or out-of-band production change, deleting data, or changing secrets, authentication, permissions, billing, domains, or ownership.

## Verification and Closeout

- Done requires observed behavior and risk-matched proof; new tests alone are insufficient. State unverified behavior and risk. Verify findings against current code or live read-only evidence; report location/severity. Plans need files, risks, verification; changes need protected delivery or a named parking reason and owner.
- Close substantial work `COMPLETE`, `READY FOR APPROVAL`, `BLOCKED`, or `PARTIAL`: outcome, proof, remaining owner, one next step. Automation never loosens gates.

## Guidance Ownership

Hand-maintain this contract; never edit generated `.agents/` adapters. Workflow sources: `.claude/commands/`, `.claude/skills/`, `.claude/hooks/`. Command/policy changes and shipped/parked work require affected manual/reference updates and `docs/changelog.d/<YYYY-MM-DD>-<slug>.md` in the same change. Keep volatile status there. Run `npm run check:agent-guidance`; agent-tooling verification follows the collaboration route.
