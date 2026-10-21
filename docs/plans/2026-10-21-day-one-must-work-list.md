# Day one: what must work on 2027-01-01 (DRAFT for Mason's approval)

**Owner:** Mason Wells approves. **Drafted:** 2026-10-21 by Claude, as asked in `docs/plans/2026-10-13-direction-and-goals.md` section 2 ("must work on day one" list, checkpoint 2026-10-31).
**Status:** DRAFT. Waiting on Mason's approval. Nothing here authorizes building anything; each item is built through its own goal and pull request.
**Evidence date:** every "today" status below was checked against `main` at `e0b5d4234` and the open-issue list on 2026-10-21. Statuses go stale quickly; re-check before relying on one.

---

## What this list is for

On **2027-01-01** Chem Man stops billing and every quote, order, delivery, invoice and payment runs in CRX. The first 30 days are the pilot.

This list sorts everything into three groups so we spend the next ten weeks on the right things:

- **MUST**: if it doesn't work on January 1, we can't bill safely in CRX. Either it's fixed first, or the date moves, or a written paper fallback covers it (Mason's call).
- **SHOULD**: needed soon, but the pilot can start without it because a manual step or a warning covers the gap for a few weeks.
- **CAN-WAIT**: after the pilot. Already parked by Mason, or low risk.

Words used below:
- **Live** means it's in the real app today.
- **Posting** an invoice means locking it as a real bill the customer owes.
- **Retry-safe** means that if the phone loses its connection mid-save and the person taps again, nothing is saved twice or saved wrong.
- **PR** is a pull request (one reviewed change to the app). **Migration** is a reviewed change to the database.

## The short version

| | Count | What it means |
|---|---|---|
| MUST, already working | 20 | Keep working; prove once on the test system in December. |
| MUST, not done yet | 30, plus Mason's 3 business tasks | The real work between now and December. Most belong to Goal 3 (billing, 15 items), Goal 6 (backups, 5) and the year-end date fixes (3). |
| SHOULD | 13 | Can start the pilot with a manual workaround. |
| CAN-WAIT | 4, plus the parked items in section 16 | After the pilot. |

Rows that only point to another row ("See 4.4") aren't counted twice.

**The three biggest risks for January 1:**
1. **Billing correctness (Goal 3) is about half built.** Split billing, voids on posted invoices, quote price locks, return credits on split orders and the "post uses what was saved" fix are all still open or in progress.
2. **We can't recover from losing the database yet (Goal 6).** The weekly off-site copy runs, but nobody has ever restored it, photos aren't backed up, and the Supabase plan has no rewind. Today a bad day could cost about a week of work.
3. **The year boundary itself.** Some quote, order and invoice-season stamps still use the server's clock (UTC, six hours ahead of Chicago), so work done on the evening of December 31 can be labelled 2027. Day one is that exact night.

---

## 1. Selling: quotes and orders

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 1.1 | Build, send and convert a quote; a rep records only their own name on it | **Working.** Quote builder, versions and PDFs live. Own-name on quotes live since 2026-10-15 (PR #938, migration `20261015200000`). | Done | MUST (working) |
| 1.2 | **A sent quote keeps the prices the customer saw** when it's accepted and turned into an order | **Not built.** Accepting a sent quote re-prices it to today's tier price (confirmed live 2026-10-14; goals doc section 3, gap 2). No PR yet. | Goal 3 ("Sent quotes keep their prices"), pricing plan slice 2 | MUST |
| 1.3 | Re-saving a quote with the same product on two lines, and Convert to Order never leaving an accepted quote with no order | **Open, latent** (`KNOWN_ISSUES.md`, "quote screen: re-saving a quote with two lines of one product is refused", 2026-10-13). | Goal 3 (same area as 1.2) | SHOULD |
| 1.4 | Create an order; a rep records only their own name on orders and blend tickets | **Working.** Live since 2026-10-15 (PR #933, migration `20261015130000`). | Done | MUST (working) |
| 1.5 | Only an admin changes a commission split; a new customer goes on an admin to-do list until it has one | **Not built.** Today a customer's assigned rep can edit that customer's split and any rep can edit a job's split (goals doc, Goal 2 "Still to do"). Due 2026-11-30. | Goal 2 follow-up | MUST |

## 2. Delivering

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 2.1 | Complete a delivery from the delivery page, the field stop and the Deliveries list; with no signal the app refuses and says so | **Built.** Refusal and paper-ticket fallback live (PR #955); the Deliveries list does it in one step (PR #964, migration `20261019220000`). **Not yet tried on a real phone in airplane mode** (Goal 5, "Still open" item 4). | Goal 5 | MUST (working; real-phone test owed) |
| 2.2 | Paper ticket when there's no signal: driver gets it signed, then completes in the app with a photo of it | **Built in the app.** The database doesn't require the photo or record that a paper ticket was used (Goal 5, "Still open" item 2). | Goal 5 follow-up | SHOULD |
| 2.3 | **Retry-safe completions and money actions**: a lost reply followed by a second tap never saves twice or saves the wrong numbers | **Partly done.** Four batches live (money batch 1, stock batch 2, delivery/job batch 3a, cancel/void batch 3b; last applied 2026-10-21). **69 database functions still open** (`KNOWN_ISSUES.md`, "about 75 live functions replay a saved result matched on the retry key alone"). The driver-retry gap (goals doc section 3) is part of this. | Goal 3 ("Retries are safe") | MUST |
| 2.4 | Customer gets a delivery receipt email | **Works, with a gap.** The phone sends it; if signal drops right after, it isn't retried. A driver who can't see an older stop's customer sends no receipt, and on the normal signature path isn't told (`KNOWN_ISSUES.md`, "a driver's completion receipt can be skipped", MED). The office can resend. | Goal 5 follow-up | SHOULD |
| 2.5 | Quick delivery for a counter sale in a few taps, including amounts under 1 unit | **Not built** (goals doc, Goal 3 "Invoices made from scratch": today 9–12 actions across 3 screens). Counter sales still *work*, just slowly. | Goal 3 | SHOULD |
| 2.6 | A stock shortage warns but never blocks a delivery | **Working.** Mason's permanent decision (2026-10-15, 6b). | Done | MUST (working) |

## 3. Billing: invoices

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 3.1 | **Post bills exactly what was saved and reviewed.** Post refuses with unsaved edits, or if someone else changed the invoice | **Open.** Today Post sends the *old* saved amounts and drops the edits on screen (`KNOWN_ISSUES.md`, "the regular invoice editor posts the old saved amounts", 2026-10-09). **In progress** in a parallel session (Goal 3, "post uses what was saved"). | Goal 3 | MUST |
| 3.2 | Product lines are billed only for delivered goods, across all of an order's invoices together | **Partly done.** A delivery's invoice is capped at what was delivered (migration `20261010120000`, PR #889). Order-level "Create Invoice" and up-front splits can still bill the ordered amount before delivery (goals doc, Goal 3 "Quantity caps"); no shipped fix found. | Goal 3 | MUST |
| 3.3 | Invoices made from scratch carry only charge lines (freight, application fee, service, other) | **Working.** Live 2026-10-21 (PR #983, migration `20261021050000`). | Done | MUST (working) |
| 3.4 | A product added on the invoice screen uses the customer's price tier | **Working** (PR #908, 2026-10-14). The goals doc asks for one check on a saved invoice and its PDF. | Goal 3 (one check) | MUST (working) |
| 3.5 | **Voiding or cancelling a delivery leaves nothing collectible for that delivery.** A posted invoice gets an automatic credit for exactly that delivery; it's never cancelled | **Not built.** Voiding a delivery whose invoice is already posted leaves the invoice fully collectible (`KNOWN_ISSUES.md` line "Voiding a delivery whose invoice is already posted leaves that invoice active"). A sales rep can also cancel a completed delivery through the server (Goal 3). One piece done: voiding an order with split drafts now works (PR #987, migration `20261021030000`, live 2026-10-21). | Goal 3 ("Voids and cancellations") | MUST |
| 3.6 | **Reps read every invoice**, other reps' invoices read-only; every balance a rep sees is the whole customer's | **Not built.** Reps can still unpost or edit some other reps' invoices (goals doc, Goal 2 "Back doors to close"). Due 2026-11-30. | Goal 2 follow-up | MUST |
| 3.7 | A rep invoices only under their own name, on every path | **Mostly working.** Manual, order and blend-ticket invoices live (PRs #907, #928, #933). Job invoices don't record a salesperson yet (goals doc, Goal 2). | Goal 2 follow-up | MUST |
| 3.8 | Invoice **season** follows Chicago's date, not the server's | **Open.** Paths that don't name a season use the server's clock (`KNOWN_ISSUES.md`, "other paths still stamp `invoices.season` from the UTC clock"). From 6 pm on December 31, those invoices can land in season 2027. | New small fix (year boundary) | MUST |
| 3.9 | Invoice numbers take Chicago's year | **Working.** Fixed live 2026-09-21 (migration `20260914100100`). | Done | MUST (working) |

## 4. Split billing (one sale billed to more than one customer)

Mason, 2026-10-15: "for regular order and deliveries we have to have the split billing."

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 4.1 | Split an order or delivery between the grower and a landlord, partly delivered orders included, with every cent accounted for and the leftover cent on the order's own customer | **In progress.** Today splitting to a landlord fails and a partly delivered order can't be split (goals doc, Goal 3 "Split billing"). Open PRs: #1006 (single order invoice refuses an order split across fields) and #1010 (split billing can bill a field owner who isn't the order's customer). | Goal 3 | MUST |
| 4.2 | The Order page's "Bill Split" card actually drives the bills | **Not built.** It saves percentages no bill reads (goals doc, Goal 3). | Goal 3 | MUST |
| 4.3 | Shares freeze at the first delivery; the last delivery bills exactly what's left; an order can be closed short | **Not built** (goals doc, Goal 3 build notes). | Goal 3 | MUST |
| 4.4 | A return on a split order credits each payer for their own share | **Not built.** A return has one customer today, and the database refuses quantity billed to another split customer (goals doc, Goal 3 build notes). | Goal 3 | MUST |
| 4.5 | Splitting one *field-application* invoice among customers | **Not built, on purpose.** Parked by Mason 2026-10-15. | Future work | CAN-WAIT |

## 5. Field-application, job and blend-ticket invoices

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 5.1 | Create, post and print field-app, job and blend-ticket invoices with their chemical lines | **Working** (goals doc, Goal 3: these keep their chemical lines by design). | Done | MUST (working) |
| 5.2 | Blend tickets never price a product at $0 for a missing tier price; staff pick when a quote lists one product twice; a $0 line needs an admin reason | **Working.** Live 2026-10-21 (PR #982, migration `20261020210000`; PR #995, migration `20261021070000`). | Done | MUST (working) |
| 5.3 | A job or blend-ticket invoice can't bill more than was applied, counting every invoice for that job or ticket | **Not built** (goals doc, Goal 3 "Caps and orderless invoices"). | Goal 3 | MUST |
| 5.4 | Correct a posted field-app invoice with a credit (admin-only, needs a reason, partial amount allowed) | **Not built.** No credit path exists for a field invoice today; credits come only from returns, which need an order (goals doc, Goal 3). | Goal 3 | MUST |
| 5.5 | The fix stopping reps from making field-app invoices through the order screens is fully signed off | **Fix live 2026-10-07; two sign-off checks wait on Mason** (`KNOWN_ISSUES.md`, "CRX-LIFE-001", item 1 needs one read-only query approved at a prompt). | Mason + agent | SHOULD |
| 5.6 | Blend ticket linked to an order with several price tiers for one product | **Open, no money impact today** (`KNOWN_ISSUES.md`, "blend-ticket linkage picks ONE order line per product"). | Later | CAN-WAIT |

## 6. Payments, prepay and credits

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 6.1 | Record a check or bank payment against one or more invoices, by hand | **Working.** This is how payments are taken today; the money loop has completed a real cycle (`CURRENT_STATE.md`, "Reality check"). Retry-safe since batch 1 (PR #942). | Done | MUST (working) |
| 6.2 | Prepay: take money in advance, apply it to invoices, edit it | **Working.** Recent fixes: prepay screens count overdue invoices (PR #992), the potential-apply figure adds up per customer (PR #997), an exact retry of a prepay edit proven live (PR #968). | Done | MUST (working) |
| 6.3 | Credits (from returns) applied to invoices, with reversal | **Working** (credit-memo apply live; `CURRENT_STATE.md` shipped feature map). | Done | MUST (working) |
| 6.4 | **A refund paid outside CRX is recorded in CRX**, so the customer's credit can't be spent twice | **Not built** (goals doc, Goal 3 "Voids and cancellations"). | Goal 3 | MUST |
| 6.5 | Customer balances and aging use Chicago's date and include every customer | **Working.** PRs #991, #996, #998 (2026-10-21). | Done | MUST (working) |
| 6.6 | A customer's full payment history past 200 entries | **Open** (goals doc, Goal 4 list). New customers won't hit 200 in January. | Goal 4 | CAN-WAIT |

## 7. Returns

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 7.1 | Return goods on a CRX-billed order and get a credit | **Working** (`issue_return_credit`; goals doc, Goal 3 note). | Done | MUST (working) |
| 7.2 | A return against one of the 53 spring deliveries billed in Chem Man can't create a CRX credit | **Not built.** Returns on those are allowed today (`KNOWN_ISSUES.md`, 2026-10-07 entry); the narrow block is Goal 3 and needs returns to name their delivery. | Goal 3 | MUST |
| 7.3 | Split-order returns | See 4.4. | Goal 3 | MUST |

## 8. Commissions

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 8.1 | Commissions calculated on orders and jobs; payouts recorded | **Working** (job-level commissions live; commission cohort applied 2026-09-21 to 09-28). | Done | MUST (working) |
| 8.2 | Admin-only split changes, new-customer to-do list, editor that recalculates unpaid commissions | See 1.5. | Goal 2 follow-up | MUST |
| 8.3 | **Commission already paid on a returned or credited sale comes off the next payout** | **Not built.** The rule applies from launch; Mason allowed a recorded manual adjustment until it's automatic (goals doc, Goal 3). | Goal 3 (automatic) | SHOULD (automatic); MUST: a written manual step and someone who does it |

## 9. Statements, printed documents and emails

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 9.1 | Print and email invoices, split invoices, credits, statements and delivery receipts | **Built** (PDF outputs and the `send-email` service live; `CURRENT_STATE.md` feature map). | Done | MUST (working) |
| 9.2 | **The office and bookkeeper review real printed and emailed documents**: right recipient, address, product, unit, price, discounts, no sales tax, due date, payment instructions, balance | **Not done** (goals doc, Goal 3 "What the customer actually receives"). | Goal 3 | MUST |
| 9.3 | A failed email stays visible and can be resent without billing twice | **Partly.** The office can resend a receipt; a guaranteed server-side retry doesn't exist (Goal 5, "Still open" item 3). | Goal 3 / Goal 5 | SHOULD |
| 9.4 | A PDF over 20 pages is refused plainly rather than cut short | **Working** (PR #993, 2026-10-21). | Done | SHOULD (working) |

## 10. Reports and complete numbers

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 10.1 | Lists, reports, integrity checks and lookups read every record, not the first few hundred | **Mostly done.** Goal 4 parts 1, 2a and 2b live (PRs #959, #981, #988, #993). | Done | MUST (working) |
| 10.2 | Pickers become search boxes; list pages page on the server | **Open** (Goal 4 parts 3 and 4). Volume in January is low enough that today's full reads work. | Goal 4 | SHOULD |
| 10.3 | A **daily reconciliation check** for the 30-day pilot: balances, payments, credits, stock and (if live) QuickBooks | **Not written.** The integrity checks exist (PR #988) but there's no one-page daily pilot check. | Phase D prep | MUST |
| 10.4 | Workload test at twice the busiest day | **Not run** (Goal 4). Needs a test system. | Goal 4 | SHOULD |

## 11. Security and roles

Four staff roles must each do their normal day: **admin** (everything), **sales rep** (quotes, orders, invoices, payments), **driver** (deliveries, field stops), **applicator** (assigned jobs and fields). Plus commission recipients, who are paid but don't log in to do work.

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 11.1 | Only admins pull the restricted-use (RUP) sales register | **Working** (PR #927, migration `20261014220000`). | Done | MUST (working) |
| 11.2 | Photos need a staff sign-in | **Working** (PRs #929 and #947; buckets private since 2026-10-16). | Done | MUST (working) |
| 11.3 | **Cost and margin are admin-only everywhere** | **2 of 3 steps live** (PR #957; PR #965 with migration `20261019230000`). Step 3, locking the cost columns on the tables, is open (`KNOWN_ISSUES.md`, HIGH, 2026-10-18). Purchase-order cost is in open PR #980. | Goal 1 | MUST |
| 11.4 | A rep can't write RUP register rows for an invoice that was never posted | **Open** (`KNOWN_ISSUES.md`, MED, 2026-10-14). | Goal 1 follow-up | SHOULD |
| 11.5 | Staff trained per role, cut-over rehearsed on the test system | **December** (Phase D). | Phase D | MUST |

## 12. The year boundary (December 31 to January 1)

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 12.1 | Quote, order and rebate-claim numbers take Chicago's year | **Open.** They use the server's clock, so anything created after 6 pm Chicago on December 31 gets a 2027 number (`KNOWN_ISSUES.md`, 2026-09-26). | New small fix | MUST |
| 12.2 | Invoice season follows Chicago's date | See 3.8. | New small fix | MUST |
| 12.3 | Screens that work out "this season" from the browser clock | **Open** (`KNOWN_ISSUES.md`, "client-side season READS still follow the browser clock, including ONE SAFETY path"). | New small fix | MUST (the safety path); SHOULD (the rest) |

## 13. Backups and recovery (Goal 6)

Mason's target: an outage can last overnight, CRX is back by the next business morning, and we lose minutes of work, not days.

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 13.1 | **Supabase Pro with point-in-time recovery** (rewinding the database to a chosen minute) | **Not done.** Plan is Free (live check 2026-10-18, `docs/plans/2026-10-18-goal-6-safety-net-findings.md`). This is Mason's billing click. | Goal 6 (Mason) | MUST |
| 13.2 | An off-site database copy that has been **restored at least once**, timed and logged | **Half.** The weekly off-site copy has run every Sunday since 2026-09-06 (last 2026-10-18). It has **never** been restored. Restore steps are a draft (`docs/plans/2026-10-19-goal6-restore-procedure-draft.md`). A parallel session is working on Goal 6 now. | Goal 6 | MUST |
| 13.3 | Photos, signatures and uploads backed up (nine storage buckets) | **Not done.** The database copy doesn't include the files (Goal 6 findings, item 1). | Goal 6 | MUST |
| 13.4 | Two named people can run the recovery; the backup passphrase isn't held by Mason alone | **Not done.** Only Mason holds the passphrase today (Goal 6 findings). | Goal 6 (Mason names them) | MUST |
| 13.5 | Paper fallback for dispatch, delivery and payments during an outage, printed and rehearsed; the pilot's "emergency brake" (numbered paper records) ready | **Not done.** | Goal 6 / Phase D | MUST |
| 13.6 | An alert to a named person when a backup fails | **Designed, not built** (`docs/plans/2026-10-19-goal6-backup-health-alert-design.md`). | Goal 6 | SHOULD |
| 13.7 | A separate test system (staging), and money/inventory browser tests per role running on it for every change | **Not built.** | Goal 6 | SHOULD (needed for the December rehearsal and the QuickBooks test month, so in practice early) |

## 14. QuickBooks and Stripe, and their fallback

Nothing for either integration exists in the code today (searched `src/` and `supabase/functions/` on 2026-10-21: no QuickBooks or Stripe code).

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 14.1 | **QuickBooks Desktop sync**: invoices, payments and credits reach the books each night and reconcile | **Not started.** Connection test due 2026-11-15; accountant's accounting map needed first. | Goal 7 | SHOULD **if** the fallback below is approved; otherwise MUST |
| 14.2 | **Fallback if the sync isn't proven by 2026-12-15:** CRX totals keyed into QuickBooks by hand each day, from a CRX report, with a daily tie-out | Process not written. The goals doc already allows this choice (section 2). | Phase D prep | MUST (the written procedure and its report) |
| 14.3 | **Online card and ACH payments through Stripe** | **Not started.** Stripe sign-up and approval for an ag-chemical business is a lead-time step. | Goal 7 | CAN-WAIT **if** the fallback below is approved |
| 14.4 | **Fallback:** payments taken and recorded as today (check, bank transfer, recorded by hand in CRX) | **Working** (see 6.1). | Done | MUST (working) |

## 15. Business readiness (Mason's own tasks, no code)

These are on Mason's checklist (goals doc, L1–L3), not agent gates, but January 1 needs them.

| # | What must be ready | Today (evidence) | Rank |
|---|---|---|---|
| 15.1 | **Opening balances** for every customer, prepay, credit, open order and unbilled delivery, signed by the bookkeeper | Not started (L3). | MUST |
| 15.2 | **Stock count** matched to CRX | Not started (L2). On 2026-08-19 there were 19 negative stock rows, and five products still flag in the integrity report until counted (`KNOWN_ISSUES.md`, 2026-10-07 entry). | MUST |
| 15.3 | Compliance rules written down per state; customer and staff licenses on file | Not started (L1). Today the RUP license check only warns. | MUST |

## 16. Can wait until after the pilot

| Item | Why it can wait |
|---|---|
| Field-application split billing | Parked by Mason, 2026-10-15. |
| Blend-ticket billing that picks the exact quoted line automatically | Parked by Mason; staff pick it today (5.2). |
| Full offline proof of delivery | Dropped by Mason; completion needs signal (2.1). |
| Grower portal | After rollout (goals doc section 7). |
| An expired "uncertain request" locking its dialog | Low risk, rare (`KNOWN_ISSUES.md`, 2026-09-11). |
| Payment history past 200 entries, multi-tier blend linkage | Not reachable at January volume (6.6, 5.6). |

---

## What Mason needs to decide

Recommended answers first. Reply with the number and "yes", or say what to change.

1. **Approve this list and its MUST / SHOULD / CAN-WAIT labels.** Recommend: yes, as written. After approval, any change to a MUST item comes back to you.
2. **QuickBooks fallback.** If the sync isn't proven by 2026-12-15, do we (a) start January 1 with daily hand-keying into QuickBooks from a CRX report, or (b) move January 1? Recommend **(a)**: hand-keying is slower but safe, and moving the date keeps two billing systems running longer.
3. **Online payments fallback.** If Stripe isn't approved and tested by 2026-12-15, start January 1 with payments taken and recorded as today? Recommend **yes**. Stripe can follow in the pilot.
4. **Supabase Pro with point-in-time recovery.** Already decided on 2026-10-13; it still needs your billing click. Recommend doing it **this week**, because every Goal 6 recovery test waits on it.
5. **Name two people who can run a recovery**, and decide who besides you holds the backup passphrase. Recommend the senior developer (once engaged) and one office person.
6. **Commission deduction on returns at launch.** Mason already allowed a manual adjustment until it's automatic. Confirm **who** records it each payout. Recommend the admin who runs payouts.
7. **December 31 evening.** Until the year-boundary fixes (section 12) land, should staff stop entering quotes, orders and invoices in CRX after 6 pm on December 31? Recommend **yes as a backstop**, and we still fix the code.
8. **Who reviews the printed and emailed documents (9.2)**: which bookkeeper, and by when? Recommend by 2026-12-01, so fixes land before training.

## Sources

- `docs/plans/2026-10-13-direction-and-goals.md` (sections 2, 3, 4 and 5).
- `docs/manual/CURRENT_STATE.md` (migration ledger read 2026-10-21; shipped feature map; environment facts).
- `docs/manual/KNOWN_ISSUES.md` OPEN entries named in each row.
- `docs/plans/2026-10-18-goal-6-safety-net-findings.md` and the two 2026-10-19 Goal 6 drafts.
- `git log` on `origin/main` through `e0b5d4234` and the open PR list, both read 2026-10-21.
