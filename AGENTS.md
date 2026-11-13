# CRX Manager Agent Contract

Shared rules for all agents; `CLAUDE.md` imports this. Load detailed procedures only when routed below.

**Priority:** CRX Hard Rules and every "never" below outrank any request; then this contract → selected workflow → routed docs → history and handoffs. Mason sets scope, not waivers: a gate needs his explicit approval in this conversation or a standing exception here. Name conflicts; follow priority.

## Project and Owner

Crop RX Solutions' production agricultural chemical distribution app. Repository `croprxsolutions/CRX_Manager_V1.0`; production `https://croprxsolutions.app`; Supabase `rhyzpcqhnizqbxphqdkr`.

## Owner Communication

- Mason cannot safely review code or diffs. Own the technical process: plain-English outcomes, risk, proof, and one recommended next step.
- Mason should never have to nudge. Keep moving through authorized work; report milestones and what failed, what it means, and what you are trying next.
- Decide routine details. Genuine stops begin `NEEDS MASON - ACTION REQUIRED` or `NEEDS MASON - DECISION REQUIRED`, with the reason and exact app-native action.

## Operating Contract

- Review/audit/diagnosis/status/plan requests are read-only; build/change/fix/finish/handle/implement/ship authorizes reversible work through verification and protected delivery. Codex and Claude both proceed after a short plan without waiting for approval.
- Deliver what was asked at the scope intended. Explain concerns and continue rather than quietly narrowing, widening, or transforming it. Guard/audit work needs a request, demonstrated blocker, or current production incident.
- Obey explicit limits and "stop", "pause", or "hold on" literally.
- Stop and hand over both positions plus a recommendation only when: the same BLOCKER/HIGH survives two fix rounds; one mechanism (lock, timer, guard, design) yields a new BLOCKER/HIGH in three rounds, Astra, Luna and Sol counted (stop patching, name it, ask Mason the business trade-off that removes it, e.g. block/warn, re-plan; Sol refuses round 5+ until DECISION_LOG.md names the PR); a checked BLOCKER stays disputed; a required gate cannot run; or a hard gate needs Mason. If a design relies on an ID the screen sends back, ask Mason the business rule at round 2. Round caps are ceilings.

## Start and Route

Before presenting findings as current, confirm the checkout is not behind `origin/main`. Before writing: `git status --short --branch`; keep unrelated work; use a clean worktree from current `origin/staging` if dirty, stale, or occupied. One writer per checkout.
Current code, migrations, tests, grants, and live read-only evidence outrank history. Load task-relevant guidance only; search large logs/schema registries, never read them whole.

| Task | Read or invoke |
|---|---|
| First session or unfamiliar area | `docs/manual/start-here/Home.md`, `docs/manual/start-here/Codebase-Map.md`, then `docs/manual/AGENT_ONBOARDING.md` and `docs/manual/ARCHITECTURE.md` |
| Any code change | `docs/reference/coding-guidelines.md`; relevant `docs/reference/gotchas.md` sections; `docs/workflows/SAFE_DEVELOPMENT_RULES.md` for multi-file, data, money, security, permission, production, migration, or customer-facing work; `plan-contract` first for money, stock, data, permission or lifecycle changes |
| Architecture, difficult debugging, workflow/migration tracing, structural audit, or PR impact | `graphify` skill (search recipe first; graph optional); focused source inspection for docs |
| Database, migration, or RLS | `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`, `docs/workflows/RLS_SECURITY_GUIDE.md`, `.claude/schema-registry.json` |
| Quote-to-cash or inventory | `docs/workflows/QUOTE_TO_DELIVERY.md` or `docs/workflows/INVENTORY_RULES.md` |
| Frontend/UI | `docs/workflows/UI_PATTERNS.md` |
| Delegation, agent collaboration, or agent-surface changes | `docs/workflows/AGENT_COLLABORATION.md` and `docs/reference/agent-guardrails.md` |
| Choosing a Codex model or effort | `docs/reference/codex-model-tuning.md` |
| Push, PR finalization, merge, or release | `.claude/commands/ship.md` |
| Settled decisions, known problems, or current status | `docs/manual/DECISION_LOG.md`, `docs/manual/KNOWN_ISSUES.md`, or `docs/manual/CURRENT_STATE.md` |
| Research, how other ag software works, or past app context | `docs/research/` first, then the shared CRX Notes vault (`docs/reference/knowledge-vaults.md`), before starting new research |
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

- Never expose secrets or `.env` contents; never use `--no-verify`; never bypass, disable, or weaken hooks, CI, review, branch protection, migration proofs, or rollback gates; and never push directly to `main` or `staging`.
- **Public security write-ups:** in any public artifact, describe what changes, never how to exploit the hole, until the whole fix is live (migration applied, code deployed).
- **Guard-cleanup exception:** a reviewed PR may narrow/remove a local agent hook that blocks harmless work or duplicates CI/GitHub, naming what still enforces it; Mason's 2026-10-30 reductions are the approved baseline, not a weakening. **Always kept:** secret protection, no force-push, no direct push to `main`, no `--admin` merges, CI and status checks, the destructive-migration approval, the migration-apply proof gate (Mason's logged Sol accepts count), and the money and inventory database rules.
- Follow `.claude/commands/ship.md` for delivery procedures: **Luna** until no BLOCKER or HIGH remains and every MED/LOW is fixed, refuted with evidence, or named as a deferral; **Sol on the computer, before the PR opens**; every hotfix or release migration applied live BEFORE merge; merge pinned to the PR's head. Use pinned models/effort, never a newer model the gates do not yet accept.
- **Sol:** a merge needs one clean independent **Sol** high-effort review, inside 24 hours, of the PR's head or of an earlier commit on its branch, when the PR touches money, inventory, the database, or logins (the list: `docs/reference/sol-required-paths.md`). Everything else (dependencies, deployment files, the guards) lands on green checks; a later commit off the list needs no new Sol. A migration's live apply needs a Sol proof bound to its exact head: a full review, or one carried forward after a clean merge of main (Mason, 2026-11-03). On a listed change, green checks or Luna never replace Sol.
- **Taha (Mason, 2026-11-06):** only comment on his PRs; his own Sol lands his; our applies + hold-list PRs wait for him: `ship.md` › Taha's PRs.
- **Staging-first (#1363; release flow):** feature PRs, migrations too, target `staging` with all `main` gates; `staging` must contain the `main` Sol reviewed. The staging DB job applies migrations after merge; post `Staging proof: <link>`. Only `release/next` and `hotfix/<name>` go into `main`; Taha or Mason merges them and the back-merge, never an agent; agents never approve PRs or merge a `.github/` change. Details: `ship.md` › Staging.
- **CodeRabbit is optional:** no PR needs a CodeRabbit review, money PRs included, unless someone adds the `needs-coderabbit` label; then one completed review is required. For CodeRabbit and the Codex GitHub App, fix or refute every comment in one push and resolve its thread (replies optional; outdated threads never hold a merge); fixes stay on the same PR. Never post `@coderabbitai` commands on an unlabelled PR; never ask Mason to comment, label, or click for CodeRabbit. Mechanics: `docs/reference/coderabbit-native-review.md`.
- **Autonomous landing.** When a clean Sol proof covers the PR (or the PR is off the Sol list), no review asks for changes, and every required check is green, merge into `staging` without asking. A hotfix's or release's NON-destructive migration (rewrites and access changes too; Mason, 2026-11-11) is applied pre-merge by Claude, after Taha's fresh `Ready to merge: <sha>`, via the migration-apply-guard proof gate: both reviewer proofs and a content-bound Sol proof, each under 24 hours, with the ledger, pending set and PR state re-checked live at apply time. The merge and apply gates enforce it. Codex hands applies to Claude (its production guard blocks the apply script, even a dry run).
- Get Mason’s explicit approval in the current conversation before force-pushing, applying a DESTRUCTIVE migration (one that deletes rows or drops data), changing live data outside a reviewed migration, deploying an Edge Function or out-of-band production change, deleting data, or changing secrets, authentication, permissions (outside a migration), billing, domains, or ownership.

## Verification and Closeout

- Done needs observed behavior and risk-matched proof, not just new tests; state unverified behavior and its risk. Verify findings against current code or live read-only evidence; report location/severity. Plans need files, risks, verification; changes need protected delivery or a named parking reason and owner.
- Close substantial work `COMPLETE`, `READY FOR APPROVAL`, `BLOCKED`, or `PARTIAL`: outcome, proof, remaining owner, one next step. Automation never loosens gates.

## Knowledge Vaults

Business context lives in Mason's Obsidian vaults; procedure: `docs/reference/knowledge-vaults.md`. Code, migrations and live data win over notes. His private vault is read-only: none of its facts (customer names, money, contacts, account numbers) go into code, commits, PRs or this public repo.

## Guidance Ownership

Hand-maintain this contract; never edit generated `.agents/` adapters (sources: `.claude/commands/`, `.claude/skills/`, `.claude/hooks/`). Command/policy changes and shipped/parked work update affected docs in the same change. A new migration needs a ledger record (`docs/changelog.d/<YYYY-MM-DD>-<slug>.md`) in the same commit; small fixes need none. Volatile status lives in the ledger, not here. Run `npm run check:agent-guidance`; agent-tooling verification follows the collaboration route.
