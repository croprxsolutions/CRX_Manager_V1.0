# Pre-code planning: research and decision (2026-11-09)

**Question (Mason):** we spend too long finding holes after branches are pushed. Should agents plan, test and deliberate (Claude with Codex) before any code, and push for simplicity?

**Decision:** pilot `plan-contract` (`.claude/commands/plan-contract.md`) on the next five changes that can affect money, stock, stored data, permissions or a lifecycle. It replaces the short plan in `ship.md` › Step 0.5 for that work and keeps every existing gate. Results go in `pilot-log.md`. After five, keep, change or delete it.

## What our own history showed

A read-only pass over the 40 merged PRs #1652–#1696. The counts are estimates from commit titles and lessons notes, and only six were app changes, so treat them as rough.

- **Plan mistakes drove the long rounds.** Across the six app/database PRs there were about 18 plan-level findings and 15 code-level ones. The plan-level ones caused Sol rounds 4–8: #1678 (who may close a receipt, office-user races, retry semantics) and #1653 (what to do with products that already have history). #1631 took 12 Sol rounds and #1452 needed a second migration for 405 legacy NULL rows; both are from lessons notes, outside this window.
- **The top five plan-level categories:**
  1. Who may act, and two users at once, decided late.
  2. Old rows left undecided.
  3. What undo, retry and re-created rows mean.
  4. Scope or slicing too wide.
  5. A screen allowing more than the server.
- **Plan documents were over-reviewed.** The build sheets took a median of about 6 rounds (#1681: about 26 Luna rounds over 44 commits), and Mason's answers arrived mid-review. A planning step must be one pass, not a loop.
- **Most PRs changed the harness rather than the app.** 16 of 40 changed guards or tooling, and 6 changed the app.
- **Baseline:**
  - Money and database PRs: about 3–8 fix rounds, median about 5.
  - Other feature PRs: median about 2.5.

## What outside sources showed

- **Spec-driven tools (GitHub Spec Kit, Kiro, BMAD, Tessl).**
  - Böckeler on martinfowler.com (`exploring-gen-ai/sdd-3-tools`) found them overkill for small features and tedious to review, and saw agents ignore the spec.
  - No independent evidence shows they reduce defects.
  - What we borrow: "When …, then …" requirement lines (Kiro's EARS style) and a short list of standing rules. We already have the rules in `AGENTS.md`.
- **Cross-model plan critique.**
  - Practitioner reports only, for example `chaseai-yt/grill-me-codex`, where Claude plans and Codex critiques.
  - Research on debate between models (arXiv 2510.07517, 2509.23055) shows reviewers defer to peers and to the author's framing. So the challenge is cold: no author, no reasoning, asked for defects, never asked to approve.
- **Matt Pocock's skills (`github.com/mattpocock/skills`, MIT).**
  - Source of the owner-question step (`grilling`): all open questions together, numbered, each with a recommended answer so the owner can accept it. Facts are looked up rather than asked.
  - His `tdd` skill adds that expected values come from an independent source, never the code under test.
- **obra/superpowers (MIT).** Source of the "no code until the design is written and approved" rule, and of a "Review Focus" list of inputs likely to break.
- **Sol, asked without seeing our idea.** It independently recommended:
  - a one-page behavior contract that replaces the short plan;
  - one adversarial pass before code;
  - database-first release order;
  - proof against a real migrated database as the real role.
- **Sol on our first draft.** "Adopt with changes":
  - drop the first-edit hook for now, because a plan file is easy to fake;
  - do not promise fewer reviews before measuring;
  - make the template ask about our specific danger spots (layer mismatch, timing, undo and history, legacy rows, release order);
  - only ask Mason genuine business choices.
- **High-reliability practice** (a research agent; several sources unverified). Ideas worth a later look once the pilot settles:
  - pgTAP role tests;
  - real-database tests instead of mocks;
  - a regression set of past bugs (a "bug museum");
  - one standard fix per risky mechanism, for example an idempotency key created when a form opens rather than a client timer;
  - capability rules the screen reads from the server.

## How the procedure itself was checked

- **Cold challenge.** Codex `gpt-6-astra` at high effort challenged the first draft and returned 46 findings. The material ones were folded in:
  - the screen may offer less than the server allows, so "identical sets" was wrong;
  - challenge before asking Mason, so he is interrupted once;
  - release order is triggered by any database dependency and must stay compatible with the deployed app;
  - proof needs a safe environment and recorded expected-versus-observed results;
  - a failed review run is not a clean one;
  - measure late *design* findings, not only business-rule ones.
- **Blind dry run on PR #1663** (admins restore removed documents, KI-07).
  - A fresh agent followed Steps 1–2 using only the code at that PR's base commit. It had no access to the PR, the lessons notes or later changes.
  - Before any code, its contract named both HIGH findings that Sol raised in review after five other reviewers called it clean:
    - the stale "removed" idempotency receipt replaying after a restore;
    - losing who removed the document, which needs a server-written history record.
  - It also caught a third gap: loosening the update trigger must not open a direct-update restore path.
  - Its usability notes were applied: find the newest function body, mark unverifiable facts UNVERIFIED, keep proof cases material only, and list reversals of recorded decisions.

## Deliberately not adopted (yet)

- A hook that blocks code until a plan exists. Revisit it if the pilot shows benefit; then bind approval to the contract file's content hash, as `grill-me-codex` does.
- Full Spec Kit, Kiro or BMAD pipelines, and long-lived specs that need upkeep.
- Multi-round plan debate, and fewer Luna rounds before the pilot measures it.
