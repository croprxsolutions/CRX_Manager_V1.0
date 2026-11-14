Settle how a risky change must behave BEFORE the production implementation: a short behavior contract, one cold challenge from the other model, Mason's business decisions, then build and prove. Pilot since 2026-11-09 (Mason). The evidence, the baseline and the measurement are in `docs/research/2026-11-09-pre-code-planning/`.

**Why:** in the last 40 merged PRs, the long Luna/Sol fights on money and database work came from things nobody settled before coding: who may act, two users or a retry at once, what old rows mean, what undo keeps, and whether the database must land before the screens. Mason's answers took one sentence each but arrived at review round 4.

## When to use it

Use it when a change can alter **money, stock, stored data, who may do what, or a record's lifecycle**, or the enforcement that protects them. Judge by behavior, not file path or label: a shared helper, status list, Edge Function, test expectation or guard that changes a money or permission outcome counts. Skip it only when neither business behavior nor its enforcement changes. Other substantial work keeps `ship.md`'s short plan, and trivial work keeps the light path.

Decide this before implementing, and again if the scope grows. If risky code already exists, stop adding to it, say so, write the contract, and continue only once it is settled.

This replaces only the short plan in `ship.md` › Step 0.5 (its steps 2–3); Step 4 below is the message to Mason that replaces "post it and proceed". Sizing, the Sol file check, scaffolds, Luna, Sol, CI, hooks, migration gates and the three-round stop rule all still apply.

## Step 1: Establish the facts

Read the affected screen, the server enforcement (RPC bodies, RLS, triggers), the schema, and the relevant `docs/manual/DECISION_LOG.md` and `KNOWN_ISSUES.md` entries. Note the commit you read. A function's current body is in the NEWEST migration that defines it, often a large later re-emit: search all of `supabase/migrations/`, not just the file that created it. The registry and repository are not proof of what production runs: when the plan depends on live behavior, check it read-only (the read-only database tool or `npm run db-sweeps:live`), never by changing data. Small throwaway probes are allowed; shipping code is not.

Keep three things apart:
- **facts**, with where they came from;
- **established decisions**, cited;
- **assumptions**, marked unresolved.

What the code does today is not proof of what the business wants. A fact you could not check is marked UNVERIFIED and becomes a check that must pass before the build relies on it; it does not block writing the contract.

## Step 2: Write the contract

Write `docs/plans/<YYYY-MM-DD>-<slug>-CONTRACT.md`, or add a "Behavior contract" section to the change's existing build sheet. Be short and plain. Leave out sections that do not apply, with no filler. Cover:

1. **Outcome and authority.**
   - The business result.
   - The smallest change that delivers it, the existing path it reuses, and the files you expect to touch (for the Sol file check). Any new table, lock, timer, queue, flag or job needs a reason why the existing path cannot do it.
   - Who may act, on which records. Every action the screen offers must be allowed by the server; the screen may offer less than the server allows.
   - How the server enforces this, including `SECURITY DEFINER` functions that bypass RLS.
   - Which values the screen sends are only locators, and what the server derives or checks itself: the actor, scope, price, status, and that supplied records belong together, per record for bulk actions.
2. **State and failure.**
   - **Rules that always hold**, and the transaction that keeps them, plus what happens to effects outside it (emails, receipts, files).
   - **Existing rows.** What old rows mean, what new writes do, how every reader treats each allowed value, and writes from the already-deployed app during rollout. Include the read-only query and its expected result.
   - **Timing.** Of double click, retry after a timeout, two users on one record, and a stale or late response: which apply. State the server outcome and the screen outcome for each. For idempotency, say what counts as the same operation, when the key is created, and what a retry returns. A disabled button is never the whole answer.
   - **Undo and history.** Who is recorded for the original and for the reversal, which values are kept, what a repeated undo does, what later actions it blocks, and what the receipt shows afterwards.
3. **Delivery.**
   - Whenever the screens depend on a database change (new or changed function, column, status value, trigger or policy), the database change ships first in its own PR, compatible with the app already deployed, with its recovery path (four past deadlocks).
   - That PR is a complete delivery unit. The screen PR may be prepared in parallel but merges only after the database is live. The feature stays open until both are verified.
4. **Proof cases.**
   - One concrete "When …, then …" line per material rule or risk, including the denied and failure cases that apply. There is no fixed count, but merge cases one test proves together and drop any that would not catch a plausible mistake.
   - Expected results come from the business rule, never from reading the new code.
   - Each case names its proof: a SQL test as the real caller, the exact query or RPC call against a real migrated database, or a browser check. It also names a safe place to run it: the local database or prover with test data, never mutating production data.

**Open business decisions** go at the end: any unresolved choice about authority, lifecycle, audit, money, stock or what customers see. Each lists the options, the consequence of each, and a recommendation. A change that reverses a recorded Mason decision is always listed here, citing it. Technical choices stay with the agent or developer.

## Step 3: One cold challenge, then settle

Give the other model the contract plus its sources: the relevant schema lines, RPC bodies, policies and screen code, with file paths. Include brief, evidence-backed reasons for key constraints. Leave out the author, any self-assessment, and any request to approve.

- **From Claude:** use the `codex` skill with `gpt-6-astra` at `high` and its packet method.
- **From Codex:** save the prompt, contract and sources as one packet file in a scratch folder outside the repo, then run `node scripts/run-claude-review.mjs --scope uncommitted --topic plan-contract --prompt-file` followed by that file's path. The packet is what gets challenged; any uncommitted code in the diff is extra context.

Prompt: "Assume this behavior contract is wrong. Report every counterexample (who does what, and the wrong result), missing decision, missing evidence you would need, screen/server/RLS mismatch, legacy-row gap, timing, undo or rollout hole, and a smaller design that still meets the outcome. Label each finding DEFECT, DECISION, MISSING-EVIDENCE or SUGGESTION, with severity. End with FINDINGS <n>." There is no approve verdict. When a change reuses an already-settled contract unchanged, challenge only what is new.

A failed, cut-off or evidence-starved run is not a clean result: fix the packet and run it again.

Every DECISION finding goes to Mason (Step 4); the agent never settles a business choice itself. Settle every DEFECT and MISSING-EVIDENCE finding by doing one of the following:
- **Correct the contract** so that it is consistent.
- **Disprove it with evidence that answers that exact counterexample.** That evidence is a code or schema line, a test, or a read-only query. Another model's opinion is not evidence, and a business decision settles what is wanted, not whether a mechanism delivers it.
- **Re-label it DECISION** if it turns out to hinge on a business choice. A technical question is never sent to Mason.

MISSING-EVIDENCE that can only be produced after the migration exists becomes a named proof case that must pass before anything is built on it. SUGGESTIONs may be declined with a one-line reason.

If a fix changes behavior, authority, data handling, timing, undo or rollout, challenge only that change again, once. If the design still does not converge, simplify it or name the business choice that is blocking it. Do not loop: the plan gets at most one challenge plus one targeted re-check, apart from re-running a failed run.

## Step 4: Mason

If any business decisions remain, send one message starting `NEEDS MASON - DECISION REQUIRED`. Number the questions, each with a recommendation and its consequence in one line. Bundle only independent choices; describe interacting ones as one combined outcome. Wait only on the work that depends on an answer, and record his answers in the contract with the date. A later question is allowed when new evidence raises a real decision.

Then post the settled outcome and the key proof cases to Mason in plain English, and continue (`AGENTS.md` › Operating Contract). If he says stop or redirects, stop at once.

## Step 5: Build and prove

- Build what the contract settled. If the build needs a material change, return to the affected decision and challenge before building on it. A note in the PR is not enough.
- Before Luna, every proof case must pass, with expected and observed results and the commit and environment recorded in the PR.
  - Check every changed or newly relied-on query or RPC against a real migrated database, with the caller's real arguments, filters and ordering.
  - Run the permission cases as the effective caller, including the denied ones.
  - Check screen races and receipts through the real screen.
  - A mocked test does not prove a query.
- If `main` or a dependency PR changes something the contract relied on, refresh the evidence it affects. If it changes the behavior the contract settled, treat it as a material change (first bullet).
- Luna and Sol review the code against the contract **and** the current code, because an agreed contract can still be wrong.
- When repeated HIGH findings trace to the same design assumption, re-examine that assumption before the next patch. The `AGENTS.md` stop rule still applies, and Mason is asked only about a real business trade-off.

## Step 6: Log the pilot

When the change closes, add one row per logical change, across all its PRs and including stopped attempts, to `docs/research/2026-11-09-pre-code-planning/pilot-log.md`. After five rows, the agent closing the fifth compares them with the baseline and tells Mason whether to keep, simplify or delete this step.
