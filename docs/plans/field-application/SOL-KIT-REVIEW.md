# Sol review of the build kit: every finding and what was done

Reviewer: Codex `gpt-6.2-sol`, high effort, read-only, round 1 of at most 2 (2026-11-24). 136 findings: every original cents cell was confirmed correct; the findings were about rules, gaps and ordering. **Claude has the final say** on each (Mason, 2026-11-24); a finding not taken is listed as rejected with the reason. "Deferred" means the item's own plan-contract must answer it before code (listed per item in `WAVES.md`, "Must address").

| Kind | Count |
|---|---|
| Fixed | 94 |
| Decision for Mason | 5 |
| Deferred to item contract | 37 |

Rejected: none. Scenario numbers in Sol's words are the round-1 numbering (old S14–S26 became S15–S29 after stock cases were added). Round 2 (changed files only) is recorded at the end.

| # | Kind | Severity | Where | Problem (Sol's words, shortened) | What was done |
|---|---|---|---|---|---|
| 001 | DEFECT | HIGH | `SCENARIOS.md` S22, `CONTRACT-field-billing.md` B12 | P3 is not untouched under the stated math | Fixed: SCENARIOS.md / scenarios-calc.py |
| 002 | DEFECT | HIGH | `SCENARIOS.md` S21–S22, `SPEC.md` stage 8 | Changing B from 110 to 100 acres leaves 10 acres unresolved unless they were already closed or are closed as part of the correction | Fixed: SCENARIOS.md / scenarios-calc.py |
| 003 | DEFECT | HIGH | `SCENARIOS.md` S16, `SPEC.md` stages 8–9 and worked example | S16 calls 57 gal “sprayed” in S1 | Fixed: SCENARIOS.md / scenarios-calc.py |
| 004 | DEFECT | MED | `SCENARIOS.md` S5, `scenarios-calc.py` lines 86–94 | The displayed gallons are rounded | Fixed: SCENARIOS.md / scenarios-calc.py |
| 005 | DEFECT | MED | `SCENARIOS.md` S9 | Setting P3 to zero in C while retaining P1 and P2’s stated thirds leaves the shares at 66.666667% | Fixed: SCENARIOS.md / scenarios-calc.py |
| 006 | DECISION | BLOCKER | `SPEC.md` stage 9.2, `SCENARIOS.md` rule 2, `CONTRACT-field-billing.md` B3 and M1, Build S | The spec gives residual cents to the biggest share, the build sheet gives them to the primary, and the contract selects largest remainder while M1 is open | Decision for Mason: MORNING-QUESTIONS M1 |
| 007 | DEFECT | HIGH | `SCENARIOS.md` rules 2–3, Billing Contract B3, calculator SQL lines 147–152 and 204–228 | The existing engine breaks ties and assigns the extra micro-percent by customer ID | Fixed: SCENARIOS.md / scenarios-calc.py |
| 008 | DEFECT | HIGH | `scenarios-calc.py` `split` and `spread`, Build Sheet §1a returns and fixtures | The Python logic floors signed amounts directly | Fixed: SCENARIOS.md / scenarios-calc.py |
| 009 | DEFECT | HIGH | `SCENARIOS.md` rules 1–4, Build Sheet §1a, calculator SQL lines 376–414 | The existing chemical and service calculator rounds each supplied field line and has no input for authoritative preallocated cents | Deferred to item contract: 4.1 |
| 010 | DECISION | HIGH | Billing Contract B3/B6, Build Sheet §1a per-payer prices and FP-5a proof | A load-wide price multiplied once cannot also represent two eligible payers in different price tiers | Decision for Mason: MORNING-QUESTIONS M2 |
| 011 | DEFECT | HIGH | Calculator SQL lines 394–416 and 425–478, Billing Contract B3/B8 | The excerpt checks whether overrides equal the base, rather than whether the effective prices of paying customers equal one another | Deferred to item contract: 4.1 |
| 012 | DEFECT | MED | `scenarios-calc.py` `std`, `SCENARIOS.md` rule 1 | The generator treats `(product, rate)` as load identity | Fixed: SCENARIOS.md / scenarios-calc.py |
| 013 | DEFECT | MED | `scenarios-calc.py` `spread` and `split`, `SCENARIOS.md` rules 1–3 | Array order stands in for spray order | Fixed: SCENARIOS.md / scenarios-calc.py |
| 014 | DEFECT | MED | `SCENARIOS.md` introduction, `scenarios-calc.py` lines 81–104 | The generator emits S1–S5 and diagnostics | Fixed: SCENARIOS.md / scenarios-calc.py |
| 015 | MISSING-EVIDENCE | MED | `SCENARIOS.md` S2/S4/S5/S10 | S2 changes rated acres without pinning stock or solution outcomes | Deferred to item contract: 1.3 and 4.1 contracts add stock and unit fixtures |
| 016 | DEFECT | HIGH | `SPEC.md` stage 4.3 and worked example | The default is described as sizing to the remaining capacity, yet the empty 6,000-gal tender in the example receives a 3,480-gal proposal for the job | Deferred to item contract: spring tender item (tenders are spring scope) |
| 017 | DEFECT | MED | Build Sheet §0 Q8, §1a and FP-1/FP-5a acceptance | Q8 requires exactly 100% on each of two sides, while old acceptance still allows everyone to pay 0% on the application side and old provenance still uses `pa... | Deferred to item contract: 0.3 fold-in |
| 018 | DEFECT | MED | Calculator SQL lines 311–320, 425–466 and 500–528, Billing Contract authority | A single null or missing customer ID can pass the excerpt’s duplicate check | Deferred to item contract: 4.1 |
| 019 | MISSING-EVIDENCE | MED | Calculator SQL lines 500–528, Build Sheet §1a stale screens and provenance | The shown hashes omit quantity, acres, dates and provenance | Deferred to item contract: 4.1 |
| 020 | DEFECT | MED | `SCENARIOS.md` introduction and Billing Contract proof | The claim that every money and stock rule has a scenario is stronger than the evidence | Deferred to item contract: 4.1 and 5.1 (partial credits, payer price tiers after M2) |
| 021 | DEFECT | BLOCKER | Batch Contract §2 rollout | A job already underway that has one newly confirmed batch and earlier paper loads skips the entire legacy completion deduction | Fixed: CONTRACT-batch-stock.md |
| 022 | DEFECT | BLOCKER | Batch Contract §2 KI-187 and proof 9, Billing Contract B13 | The proposed proof covers batch first, then blend ticket | Fixed: CONTRACT-batch-stock.md |
| 023 | DEFECT | HIGH | Batch Contract §§1 and 3, stock migration excerpt lines 83–132 and 179–189 | Changing only the completion deduction can leave triggers locking and creating inventory rows for planned products the batch never used | Deferred to item contract: 1.3 |
| 024 | DEFECT | HIGH | Batch Contract §2 timing, stock migration excerpt lines 179–183 | The existing wrapper locks the job before the application-record counter | Fixed: CONTRACT-batch-stock.md |
| 025 | DEFECT | HIGH | Batch Contract §2 timing and proof 12, stock migration excerpt lines 12–23, 92–132 | The existing path locks all existing rows first, then creates missing rows in product order | Fixed: CONTRACT-batch-stock.md |
| 026 | MISSING-EVIDENCE | HIGH | Batch Contract Facts and §3, `GAP-CHECK.md` §§1, 2 and 6 | The contract locates the implementation in `20270227170000`, whose excerpt shows a wrapper and trigger calling the older body | Deferred to item contract: 0.5 read-only facts |
| 027 | DEFECT | HIGH | Batch Contract §§1–2, Build Sheet rule 2 | New RPC signatures advertise a nullable retry key but omit whether null is refused, how the key is scoped and bound to a request, and when its result is retu... | Fixed: CONTRACT-batch-stock.md |
| 028 | DEFECT | HIGH | Batch Contract §§1–2 and proof 3 | The same-draft race assumes both tablets share a persisted batch row | Fixed: CONTRACT-batch-stock.md |
| 029 | DEFECT | HIGH | Batch Contract §1, `SPEC.md` stage 4 | Confirm sends amounts and IDs but does not define canonical units, compatible jobs, positive and finite quantities, distinct product rows, rate provenance, o... | Deferred to item contract: 1.3 |
| 030 | DEFECT | HIGH | Batch Contract §1 authority/RLS, `SPEC.md` stages 4 and 6, Build Sheet wave 0 | “Applicators read” and a role check alone can expose or let an applicator change another crew’s jobs | Deferred to item contract: 1.3 and 2.2 |
| 031 | DEFECT | HIGH | Batch Contract §§1 and 2, `SPEC.md` stages 4.5 and 9b | One “who may act” bullet covers confirm and correct | Fixed: CONTRACT-batch-stock.md |
| 032 | DEFECT | HIGH | Batch Contract §1, `SPEC.md` stage 4.5 and Gap Check row 27 | There are only confirm and correct RPCs | Fixed: CONTRACT-batch-stock.md |
| 033 | DEFECT | HIGH | Batch Contract §§1–2, `SPEC.md` stages 4.8 and 6.2 | A substitution is saved only on the current batch | Fixed: CONTRACT-batch-stock.md |
| 034 | DEFECT | HIGH | Batch Contract §§1–2, `SPEC.md` stage 4.7 | One load serves two jobs and uses 58 gal, while both jobs have a 58-gal X hold | Fixed: CONTRACT-batch-stock.md |
| 035 | DEFECT | HIGH | Batch Contract §2 corrections and holds | Job A’s hold was reduced at confirm | Fixed: CONTRACT-batch-stock.md |
| 036 | DEFECT | HIGH | Batch Contract §2 and proof 7, `SPEC.md` stage 4.2a | Two batches can both claim the same 200 gal logged for one rig | Fixed: CONTRACT-batch-stock.md |
| 037 | DEFECT | HIGH | Batch Contract §§1–2, `SPEC.md` stages 4–5, Gap Check rows 25–26 and 34 | A carried-in field on the receiving batch cannot record the gauge reading, unused gallons, discard disposition, or outgoing movement on the source job | Fixed: CONTRACT-batch-stock.md |
| 038 | DEFECT | HIGH | Batch Contract §2 carry-in, `SCENARIOS.md` S14, `SPEC.md` stages 4.8–9 and 9.2 | Job 2 inherits 200 gal containing X but its own recipe lists Y | Fixed: CONTRACT-batch-stock.md |
| 039 | DEFECT | HIGH | Batch Contract §2, `SPEC.md` stage 4.9 and Sol 12 | Customer A’s already-paid X is carried into customer B’s job with the same named mix | Fixed: CONTRACT-batch-stock.md |
| 040 | DEFECT | HIGH | Batch Contract §2, `SCENARIOS.md` S14/S16, `SPEC.md` stage 8 | A confirmed 58 gal load has 5 gal left or carried out | Fixed: CONTRACT-batch-stock.md |
| 041 | DEFECT | HIGH | Batch Contract §2 undo/history and proof 11 | The prose says reverse and replace, while proof 11 expects a single +3 gal delta | Fixed: CONTRACT-batch-stock.md |
| 042 | DEFECT | HIGH | Batch Contract §§1–2 corrections | Two users see 58 gal, then concurrently change it to 55 and 56 | Fixed: CONTRACT-batch-stock.md |
| 043 | DEFECT | HIGH | Batch Contract §2 corrections, Billing Contract §3, `SPEC.md` stage 10 | Changing the composition of a source load after its leftover went into another job updates source stock only | Fixed: CONTRACT-batch-stock.md |
| 044 | DEFECT | HIGH | Batch Contract §2 rollout/undo | Rolling back by restoring unconditional completion deductions after a batch has already taken 58 gal will take the stock again at close | Fixed: CONTRACT-batch-stock.md |
| 045 | DEFECT | HIGH | Batch Contract §1 “smallest change,” §2 flags, and proof 1–7 | The table sketch lacks durable storage or relationships for the original proposal, actor and timestamps per change, office review flags, and more than one le... | Fixed: CONTRACT-batch-stock.md |
| 046 | DEFECT | HIGH | Batch Contract §1 “done list,” `SPEC.md` stages 6–7 | No “done” list is defined | Fixed: CONTRACT-batch-stock.md |
| 047 | DECISION | HIGH | `SCENARIOS.md` S18, `SPEC.md` stage 7.5, Batch Contract §2 | S18 only permits the example with zero acres and no confirmed batch | Decision for Mason: MORNING-QUESTIONS M4 |
| 048 | MISSING-EVIDENCE | HIGH | Batch Contract §4 | The proof list omits completion and confirmation racing on the same job, stock-short remediation after a delivery, tablet scope, add versus correct, carry-in... | Fixed: CONTRACT-batch-stock.md |
| 049 | DEFECT | BLOCKER | `WAVES.md` 2.1/3.1, Billing Contract B2 | A job-to-batch list plus field totals cannot say which gallons sprayed which acres when Field B receives 40 acres of X and 70 of Y | Deferred to item contract: 2.1 (work entry per load revision; fixed in kit rules, built in 2.1) |
| 050 | DEFECT | HIGH | `WAVES.md` 2.1/2.5, `GAP-CHECK.md` rows 32–38 | The office entry manager and phone can continue writing through different paths | Deferred to item contract: 2.1 |
| 051 | DEFECT | HIGH | `WAVES.md` 2.1, `SPEC.md` stages 6.6c, 8, and 9.1 | “Applied” is used for crew completion and office closure, while existing code also uses `completed` and `invoiced` | Deferred to item contract: 2.1 |
| 052 | DEFECT | HIGH | `WAVES.md` 2.1/3.1, `SPEC.md` stage 6.6c and GR3 | One applicator marks the job done from a stale phone while another saves acres, adds a field or closes a remainder | Deferred to item contract: 2.1 and 2.5 |
| 053 | DEFECT | HIGH | `WAVES.md` 2.1/3.1, `SPEC.md` stages 7–8 | A zero-acre answer can be mistaken for an explicit close of all remaining acres | Deferred to item contract: 2.1 |
| 054 | DEFECT | HIGH | `SCENARIOS.md` S24, `SPEC.md` stage 6.2 | The spec says the office deletes one look-alike, while S24 permits keeping it with a reason | Deferred to item contract: 2.5 (S27 already says remove or keep with a reason) |
| 055 | DEFECT | HIGH | `WAVES.md` 2.1/2.5, `SPEC.md` stage 6.7, Gap Check row 38 | The database may retain the seven-day applicator edit allowance even after the screen hides editing | Deferred to item contract: 2.1 |
| 056 | DEFECT | HIGH | `WAVES.md` spring offline scope, `SPEC.md` stages 6.5 and 8 | February closure asks for “no unsynced entries,” yet new offline entries are spring work | Deferred to item contract: 2.1 |
| 057 | DEFECT | HIGH | Billing Contract B1, `SCENARIOS.md` S15, `SPEC.md` stage 8 and Sol 6 | S15 waits for every field a shared load sprayed to have acres or be closed | Deferred to item contract: 3.1 |
| 058 | DEFECT | HIGH | `SPEC.md` stage 8, `WAVES.md` 3.1 | Gauge reconciliation tolerance and per-product rate deviation both use 5% language | Deferred to item contract: 3.1 |
| 059 | DEFECT | HIGH | `WAVES.md` 3.1, `SPEC.md` stage 8 label maximum, Gap Check rows 6/43 | An agent can remove one screen’s block while the other route still rejects a save, or compare a job average that hides a field with a higher applied rate. | Deferred to item contract: 3.1 |
| 060 | MISSING-EVIDENCE | HIGH | `SPEC.md` stages 6.3/8, `WAVES.md` 2.1/3.1 | A gauge gives aggregate solution use | Deferred to item contract: 3.1 |
| 061 | DEFECT | HIGH | `WAVES.md` 2.1/2.5/3.1, Gap Check row 37, `SPEC.md` stage 6.6–6a | No explicit wave deliverable covers state-configured restricted-use fields and the as-sprayed, per-field print before close | Deferred to item contract: 2.1 |
| 062 | DEFECT | HIGH | `WAVES.md` 2.4/3.1, `SPEC.md` stages 4.3 and 8 waste | “Wasted” can remove leftovers from the next mix before they have a disposition | Deferred to item contract: 2.4 and 3.1 |
| 063 | DEFECT | HIGH | `WAVES.md` 2.5/3.1, `SPEC.md` stage 6.6b and GR5–6 | The phone can add an unknown-name field but the billing engine needs a stable field and grower identity | Deferred to item contract: 2.5 |
| 064 | DEFECT | HIGH | `WAVES.md` 3.1–3.2, `SPEC.md` stage 8 | The review UI can ship without the promised one-click clean closure, or require the same notes for ordinary extra acres as for a flagged substitution | Deferred to item contract: 3.1 and 3.2 |
| 065 | DEFECT | MED | `WAVES.md` 2.5/3.2, `SPEC.md` stages 6.1 and 8 close | The phone item omits directions and weather-at-start acceptance | Deferred to item contract: 2.5 and 3.2 |
| 066 | DEFECT | BLOCKER | Billing Contract B13/Delivery, `WAVES.md` 4.1 and spring, Build Sheet FP-5a/FP-5b | “Other three routes retired or rerouted” conflicts with keeping blend-ticket invoicing until spring and with retaining hand-typed invoices for S26 | Fixed: CONTRACT-field-billing.md |
| 067 | DEFECT | BLOCKER | Billing Contract B1/B2, Build Sheet §1a acreage fallback and FP-5a legacy conversion | An unattended agent may apply “only closed jobs, only sprayed acres” to every per-line save, making `legacy_fixed` drafts or independent typed invoices impos... | Fixed: CONTRACT-field-billing.md |
| 068 | DEFECT | HIGH | Billing Contract B5, Build Sheet §1a/FP-5a, `SPEC.md` stage 9.2 | A field can be sprayed Tuesday and Thursday across a split change | Fixed: CONTRACT-field-billing.md |
| 069 | DEFECT | HIGH | Billing Contract B5/authority, Build Sheet §1a and FP-5a resolver | The build sheet says a saved job override, including a differing legacy job share, wins over the dated field version | Fixed: CONTRACT-field-billing.md |
| 070 | DEFECT | HIGH | `WAVES.md` 1.1/2.3, Build Sheet FP-1 fallback, Gap Check row 4 | A versionless field added under Grower B to Grower A’s multi-grower job can fall back to A, the field owner, or B depending on which reader runs. | Fixed: CONTRACT-field-billing.md |
| 071 | DEFECT | HIGH | Billing Contract B2/B3/B7, `SPEC.md` stages 8–9 | A shared load serves two jobs with different locked prices or first-spray dates | Fixed: CONTRACT-field-billing.md |
| 072 | DEFECT | HIGH | Billing Contract B6/authority, `SCENARIOS.md` S8, Gap Check row 52 | “First spray day” does not define Central date, the treatment of zero-acre entries, historical price lookup, a Y substituted after that date with no valid pr... | Fixed: CONTRACT-field-billing.md |
| 073 | DEFECT | HIGH | Billing Contract authority, `SPEC.md` stages 9.2 and 9.4 | The declared payload has only identifiers, shares and reasons, but the office must be able to send a quantity, measured usage, a price, or an invoice date as... | Fixed: CONTRACT-field-billing.md |
| 074 | DEFECT | HIGH | `SCENARIOS.md` S10, Billing Contract B4–B9 and proof scope, Build Sheet FP-5a parity | The billing contract does not explicitly pin customer-supplied and already-paid product at zero price and cost through each route and refresh | Fixed: CONTRACT-field-billing.md |
| 075 | DEFECT | HIGH | Billing Contract B8 and §3, Build Sheet FP-5a snapshots | Moving all of P2’s charges to P1 can leave an empty P2 draft | Fixed: CONTRACT-field-billing.md |
| 076 | DEFECT | HIGH | Billing Contract §3, Build Sheet §1a stale screens and FP-5a set locking | Editors change different payer invoices in the same set while a share edit affects both | Fixed: CONTRACT-field-billing.md |
| 077 | DEFECT | HIGH | Billing Contract §3, Build Sheet rule 2 and §1a duplicate billing | Two users transfer the same closed job with different keys | Fixed: CONTRACT-field-billing.md |
| 078 | DEFECT | HIGH | Billing Contract B13/authority, `SCENARIOS.md` S26, `SPEC.md` stage 9.6 | Job uniqueness alone does not catch an unlinked typed invoice | Fixed: CONTRACT-field-billing.md |
| 079 | DEFECT | HIGH | Billing Contract B10/authority, Gap Check row 59 | Widening `post_invoice` alone still leaves an unrelated sales rep unable to open or save the set because the split writer checks ownership | Fixed: CONTRACT-field-billing.md |
| 080 | DEFECT | HIGH | Billing Contract B10, `SPEC.md` stage 10.1 | One payer set can have three different customer reps, and one customer can change reps or have none | Fixed: CONTRACT-field-billing.md |
| 081 | DEFECT | HIGH | Billing Contract B11, `SCENARIOS.md` S25, Build Sheet §1a date and period rules | A Dec 5 post backdated to Nov 22 can be checked only against December, then appear in closed November | Fixed: CONTRACT-field-billing.md |
| 082 | DEFECT | BLOCKER | Billing Contract §3/Delivery, Build Sheet FP-5a posting switch | With the switch on, an older single-post entry point may post one member independently unless it routes through set posting | Fixed: CONTRACT-field-billing.md |
| 083 | DEFECT | HIGH | Billing Contract B12 and §3, Build Sheet §0 Q10 and FP-5a set invariants | The phrase “no money and month open” does not pin all inherited checks | Fixed: CONTRACT-field-billing.md |
| 084 | DEFECT | HIGH | Billing Contract B12, `SCENARIOS.md` S21, Build Sheet §1a snapshots | A repost may overwrite the only posted representation or reconstruct it from today’s split | Fixed: CONTRACT-field-billing.md |
| 085 | DEFECT | BLOCKER | Billing Contract B12, Build Sheet §0 and §1a credit/source rules | The one-bill-per-job constraint can prevent any replacement after credit, or clearing the job’s unique link can let unrelated routes bill the whole job again | Fixed: CONTRACT-field-billing.md |
| 086 | DEFECT | HIGH | Billing Contract B12/§3, Build Sheet §1a returns and partial credits | Credit calculation from the current split or from independent rounds can refund the wrong payer or refund 2¢ against a 1¢ line through two half-returns. | Fixed: CONTRACT-field-billing.md |
| 087 | DECISION | HIGH | Billing Contract B12, `SPEC.md` stage 10.3 | B12 narrows “invoices that changed” to invoices whose amounts changed | Decision for Mason: MORNING-QUESTIONS M3 |
| 088 | DEFECT | HIGH | Billing Contract §3, `SCENARIOS.md` S23, `SPEC.md` stage 10.3 | The contract flags the entire set | Fixed: CONTRACT-field-billing.md |
| 089 | DEFECT | HIGH | Billing Contract §3, `SPEC.md` stage 10.3, Gap Check row 61 | `JOB_INVOICED_LOCKED` can still prevent an office spray-record correction even if a new screen displays the action | Fixed: CONTRACT-field-billing.md |
| 090 | DEFECT | HIGH | Billing Contract Delivery/proof, Build Sheet FP-5a legacy conversion | A conversion can preserve totals but change unit, cost, terms, source links, invoice number or historical date | Deferred to item contract: 4.1 |
| 091 | DEFECT | HIGH | Billing Contract §3/Delivery, Build Sheet FP-5a cutover | Retiring RPCs before new screens deploy leaves the current app with no working path | Deferred to item contract: 4.1 |
| 092 | DEFECT | HIGH | `WAVES.md` 4.2/5.2, `SPEC.md` stages 9.3 and 10.2, Build Sheet Q9 | S1 payer P2’s PDF or email can reuse the entire set payload and show A, P1’s prices or CRX costs | Deferred to item contract: 4.2 and 5.2 |
| 093 | MISSING-EVIDENCE | HIGH | Billing Contract Proof, `WAVES.md` 5.1–5.2, Build Sheet FP-5a/timeline | The enumerated tests omit S10 and S16–S18 | Deferred to item contract: 5.1 |
| 094 | DEFECT | BLOCKER | `WAVES.md` Wave 0, `GOALS.md` §7, Billing Contract M1 | Wave 1 can launch with conflicting authoritative instructions, and FP-1 builds allocator fixtures before the cents decision is settled. | Fixed: WAVES.md |
| 095 | DEFECT | HIGH | `WAVES.md` 0.4, Gap Check §1 | “Reach production in a normal release, or are recorded as staging-only” treats five candidate migrations as one decision | Fixed: WAVES.md |
| 096 | DEFECT | BLOCKER | `WAVES.md` 1.1/2.3, `GOALS.md` gate, Build Sheet FP-1/timeline | FP-1 includes a delete foreign-key change and revoked grants, and FP-4/FP-5a have grant changes | Fixed: WAVES.md |
| 097 | DEFECT | HIGH | `WAVES.md` 2.1/2.3, Build Sheet Wave 0/timeline | PR #1650 is an explicit access prerequisite for FP-4, and its policies matter for the new applicator writers | Fixed: WAVES.md |
| 098 | DEFECT | HIGH | `WAVES.md` 1.3, Batch Contract §3, `GOALS.md` Wave 1 DB mission | Partial hold release is deferred to a second PR after Dec 15, but the calendar and later briefs never give it a slot, owner, or Feb 1 exit condition | Fixed: WAVES.md |
| 099 | DEFECT | HIGH | `WAVES.md` rules 6 and 0.4/1.3, `GOALS.md` gate, Gap Check §4 | A “needs Taha’s eyes” note can be read as permission to touch his areas before Dec 15 | Fixed: WAVES.md |
| 100 | DEFECT | HIGH | `WAVES.md` 2.2/2.4 and parallel table, Batch Contract §1 | The mixer screens list 1.3 and 2.1 as prerequisites, omitting 2.2 | Fixed: WAVES.md |
| 101 | DEFECT | HIGH | `WAVES.md` rule 1, 2.4–2.5 note and calendar | “Start only when live” and “until then the UI lanes build” give contradictory instructions | Fixed: WAVES.md |
| 102 | DEFECT | HIGH | `WAVES.md` 3.1–3.3 and parallel table | Office review depends on the 3.1 server checks | Fixed: WAVES.md |
| 103 | DEFECT | HIGH | `WAVES.md` 4.1/5.1, Billing Contract Delivery, Build Sheet FP-5a | FP-5a’s cutover requires posting-switch entry-point changes and converts a legacy posted invoice on unpost | Fixed: WAVES.md |
| 104 | DEFECT | HIGH | `WAVES.md` 4.2/5.2 and Jan 4–17 row | PDF prep runs beside draft UI before the canonical draft or posted payload is established | Fixed: WAVES.md |
| 105 | DEFECT | HIGH | `WAVES.md` rule 3/2.3–2.5, `GOALS.md` later briefs | FP-4 has job-detail readers to replace while mixer and phone lanes may each need shared routes and generated types | Fixed: WAVES.md |
| 106 | DEFECT | MED | `WAVES.md` rule 3, Wave 1 missions, `GOALS.md` rule 7 | `JobDetail.tsx` is treated as reserved, while the paperwork mission allows a menu edit outside its ownership list | Fixed: WAVES.md |
| 107 | DEFECT | HIGH | `WAVES.md` rule 2/calendar, Wave 1 DB mission | Both database and UI dependencies can turn one WP item into multiple PRs under the build sheet’s “DB + screens” packages | Fixed: WAVES.md |
| 108 | DEFECT | BLOCKER | `WAVES.md` Jan 18–31 row and Wave 6 | Wave 6’s end-to-end checks run beside 5.1 even though posting, credit/rebill and corrected snapshots are part of the checks | Fixed: WAVES.md |
| 109 | DEFECT | HIGH | `WAVES.md` dates and critical path, Build Sheet timeline | Dec 7–20 contains one L item, one M item and a security item in one serial lane, before review and holds | Fixed: WAVES.md |
| 110 | DEFECT | HIGH | `WAVES.md` spring, Build Sheet timeline, Gap Check §4 | FP-6 says only “after Taha’s PRs,” omitting #1524 and #1534 being live | Fixed: WAVES.md |
| 111 | DEFECT | HIGH | `WAVES.md` 1.4, paperwork brief, Gap Check rows 7/12–16 | Screen scope includes water versus finished gallons but omits loader units, some map/print behavior and the common carrier value | Fixed: WAVES.md |
| 112 | DEFECT | HIGH | `WAVES.md` 2.1/3.3, Gap Check rows 6–11/17 | No item clearly owns the February job-level multi-applicator assignment, mid-job rig changes, warehouse default or full carrier propagation | Fixed: WAVES.md |
| 113 | DEFECT | HIGH | `WAVES.md` Wave 6, Gap Check §§2 and 6, `SPEC.md` stage 10.6 | The import is scheduled as staging plus spot-check only | Fixed: WAVES.md |
| 114 | DEFECT | BLOCKER | `WAVES.md` 6.3–6.5, Gap Check §4 #2407, `SPEC.md` stage 10.4–5 | The waves put a first real job before test-data cleanup, while #2407 reportedly clears the live field side and must run before real field jobs exist | Fixed: WAVES.md |
| 115 | DEFECT | HIGH | `WAVES.md` Wave 6, `SPEC.md` stage 10.7 and §10 timing | The January Chem Man handoff and Jan 1 chemical-sales move have no owner or release milestone | Fixed: WAVES.md |
| 116 | DECISION | HIGH | Build Sheet timeline fallbacks, `WAVES.md` February deadline | If FP-5a slips, the old fallback adds office split-history checks and may bill planned instead of sprayed acres or ignore later load changes | Decision for Mason: MORNING-QUESTIONS M5 |
| 117 | DEFECT | HIGH | `WAVES.md` Wave 6, `GOALS.md` Waves 3–6 briefs | Real jobs must be archived and searchable, but no item builds or proves the archive path | Fixed: WAVES.md |
| 118 | DEFECT | HIGH | `WAVES.md` 4.1/5.1, SPEC GR9, Gap Check billing rows | No critical item or scenario proves that a credit-hold customer can proceed through field work and field billing while chemical credit-hold behavior remains... | Fixed: WAVES.md |
| 119 | DEFECT | BLOCKER | `GOALS.md` Delivery gate, both Wave 1 missions | Feature pushes are described as allowed without stating the owner’s pre-push requirements | Fixed: GOALS.md and mission docs |
| 120 | DEFECT | BLOCKER | `GOALS.md` Delivery gate, Build Sheet rules 1 and 3, Wave 1 DB mission | The phrase “auth or permissions outside a reviewed migration” implies that a reviewed migration can change permission without Mason’s exact approval | Fixed: GOALS.md and mission docs |
| 121 | MISSING-EVIDENCE | HIGH | `GOALS.md` rules 3/5 and gate, Wave 1 missions | The packet cites agent round caps, required paths, protected-delivery rules and a four-hour hold but omits their current text or implementation | Deferred to item contract: each goal reads ship.md and the guards live at run time; the kit does not copy them |
| 122 | DEFECT | HIGH | `GOALS.md` rules 1/5, Wave 1 DB mission | “Code and live evidence win” can make intended differences, such as planned versus sprayed billing, look like reasons to stop | Fixed: GOALS.md and mission docs |
| 123 | DEFECT | HIGH | `GOALS.md` rules 5–7, Wave 1 missions Definition of done | “Merged or parked” can mark a wave done while stock, RLS or split work remains blocked | Fixed: GOALS.md and mission docs |
| 124 | DEFECT | HIGH | `GOALS.md` stop rules and delivery gate | The only concrete repeat stop is the same BLOCKER or HIGH twice | Fixed: GOALS.md and mission docs |
| 125 | DEFECT | HIGH | `GOALS.md` rules 2/7 and later briefs, `WAVES.md` rule 3 | A needed edit outside a lane’s scope is logged and waits, but no receiving owner or completion check is required | Fixed: GOALS.md and mission docs |
| 126 | DEFECT | HIGH | `GOALS.md` rule 4, Batch Contract proof, Billing Contract proof, `WAVES.md` 6.1 | “Migrated database or real screen” can pass with a fresh database, admin owner sessions or seeded SQL while production-shaped upgrades, old app callers and a... | Fixed: GOALS.md and mission docs |
| 127 | DEFECT | HIGH | `WAVES.md` Wave 6, Billing Contract Delivery, Build Sheet FP-5a proof | The read-only real preview, the first real hand-checked job, and general posting enablement are conflated | Fixed: WAVES.md |
| 128 | DEFECT | HIGH | `GOALS.md` gate, `WAVES.md` 5.2/6.5 | The invoice PDF code sits under Supabase Functions in the supplied evidence | Fixed: WAVES.md |
| 129 | MISSING-EVIDENCE | HIGH | Billing Contract header/proof, `GOALS.md` Read first, Build Sheet excerpts | FP-2, FP-4, FP-5c, the editor contract, Morning Questions, Progress and actual review outcomes are referenced but absent from the packet | Deferred to item contract: 0.3 fold-in (the build sheet's packages are read by each item's contract) |
| 130 | DEFECT | HIGH | `GOALS.md`/Wave 1 missions Definition of done, `WAVES.md` 6.5 | “Merged into staging” or “release to production” has no required schema and app version evidence, rollback checkpoint, smoke result or monitor owner | Fixed: GOALS.md and mission docs |
| 131 | DEFECT | MED | Wave 1 paperwork mission Definition of done | A single screenshot can show a new label while omitting safety values on later pages, staff print settings, broken direction links or bulk ordering. | Fixed: WAVES.md |
| 132 | DEFECT | HIGH | `GOALS.md` gate and proof, Build Sheet FP-5a rules 3/6 | Revoking a table grant before the last deployed writer switches can break old tabs and screens | Deferred to item contract: 1.1 and 4.1 |
| 133 | SUGGESTION | HIGH | Batch Contract §1 and `WAVES.md` 1.3/2.1 | February can get stuck building generalized balances, draft choreography and a movement system before anyone can mix a load. | Fixed: WAVES.md |
| 134 | SUGGESTION | HIGH | Billing Contract B1–B13, `WAVES.md` 4.1–5.2 | Replacing several writers and changing shared posting internals at once makes it difficult to prove which route changed dollars. | Deferred to item contract: 4.1 |
| 135 | SUGGESTION | HIGH | `WAVES.md` core scope and Wave 6 | Concurrent expansion of paperwork, dispatch UI, financial corrections and spring-like tracking can use the last integration window before the main flow has r... | Fixed: WAVES.md |
| 136 | SUGGESTION | MED | `SPEC.md` stages 4–10, `GOALS.md` proof | Flags implemented as separate queues or approvals can turn a clean job into extra crew and office work. | Fixed: WAVES.md |

## Round 2 (final; the two-round cap is reached)

Sol re-checked the revised files: 108 points (VERDICT: FINDINGS 108). Most ask for more depth on a round-1 finding; Claude's call on each:

**Fixed after round 2:**
- 137, 139: the S24 table was tagged S22; the calculator now uses exact fractions (no rounding before the final cent) and checks that every table tag matches. All tables are unchanged.
- 138, 142: the calculator asserts its fixture limits (one product per load; no "bill actual" on a zero-acre load).
- 140: S4b states its stock gallons.
- 021: a job's stock path is fixed at creation; no conversion.
- 094: the morning questions and waves now agree: every question answered and 0.3 merged before wave 1.
- 105, 106: `JobDetail.tsx` owner named for wave 2; the paperwork lane's one allowed edit there is exact.
- 107, 123, 124, 119: PR splitting, item order, stale proof (refresh, not stop), approvals said in the closing message, push only after local checks and Luna.
- 114, 157: field import only after the live reset has run; the Chem Man cut-off is per work entry's spray date.
- 127, 152, 158: posting switch on staging when 5.1 lands; production only with Mason's yes, pilot first; switches added to the yes list.
- 131: paperwork proof adds saved preferences and a two-job bulk print.
- 145: duplicate load reversed by an admin correction to zero.
- 151: the tablet role's proof moved to 2.2.
- 159: goals read Mason's answers and the folded-in build sheet first.
- 162–168: the morning questions were rewritten to be fair and separate (M1 example, M2 asks whether such promises exist, M3 split in three, M4 option with no new step, M5 names the retyping cost, M6 and M7 scoped).
- 169: duplicate and overlap notes are optional (Mason's flags-not-steps rule).

**New questions for Mason:** 149 (two real passes over the same acres) → M8; 147 (substitute with no price) → M9.

**Carried into each item's own plan-contract** (must be answered there before code; Claude's judgement that they are design depth, not kit errors):
- 1.3 batches and stock: 016, 023, 025, 027, 028, 029, 030, 031, 034, 035, 037–040, 042–046, 048, 049, 057, 062, 144, 150, 155.
- 1.1 / 1.2 / 2.1 / 2.5 field, acre and work data: 007, 017, 018, 051, 053, 054, 059, 060, 061, 063, 065, 112.
- 4.1 / 5.1 billing: 071–074, 076, 078, 080, 083, 085, 086, 090–092, 103, 118, 132, 141, 143, 146, 148, 153, 161.
- Waves and go-live (re-planned when wave 3 ends): 099, 104, 108, 109, 111, 113, 115, 117, 126, 128, 130, 135, 136, 154, 156, 160.

**Rejected:** none outright. Claude disagrees with the severity of several BLOCKERs (085, 091, 108, 132): each is real, but it belongs to a later item's plan, which the goal rules forbid starting without answering it, so it cannot reach code unanswered.
