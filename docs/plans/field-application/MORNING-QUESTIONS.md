# Field application build: Mason's answers (2026-11-24)

## Answers (Mason, 2026-11-24, in the build-kit session)

| # | Answer |
|---|---|
| M1 | Closest to exact (largest remainder; ties to the bigger share, then the grower) |
| M2 | Yes, payers on one field can have different prices; **not needed by February 1**: February bills one price per product per job and the office adjusts a rare split-price job by hand; per-payer prices are a spring item |
| M3 | Mark "Corrected" in CRX; the office chooses whether to re-send; credit and rebill only when dollars changed |
| M4 | End the job with nothing billed; the mix stays recorded; the tank is carried to the next job or a tote; note optional |
| M5 | If late, keep billing field work in Chem Man (office retypes acres) until CRX passes its checks; never bill planned acres |
| M6 | Sol capped at two rounds per plan; leftovers come to Mason as a short list |
| M7 | **Not yet.** No wave 1 goal starts until Mason says so |
| M8 | Each real pass bills its own service and fuel acres; suspected duplicates are flagged |
| M9 | The whole payer set waits until a missing substitute price is entered |
| Map tab | Keep it; the list stays the default |

The questions as asked follow.

# The questions (as asked)

Nine questions, each with a recommendation; "yes" to a recommendation is enough. **Wave 1 starts only after every question is answered and step 0.3 (the build sheet updated to match) is merged** (`WAVES.md` wave 0).

## M1. Who gets the leftover penny when a bill splits unevenly?

Example: a 3¢ line split 70/30. Exact is 2.1¢ / 0.9¢.
- **Recommended: closest to exact.** 2¢ / 1¢. Pennies go to whoever rounding shorted most; on a true tie, the bigger share, then the grower. CRX's split engine already works this way, except its tie-break is by customer ID; this changes the tie-break only.
- Other choice: always to the biggest share. 3¢ / 0¢.

## M2. Can two payers on one field pay different prices for the same product?

Example: landlord and tenant split product X 50/50, and the landlord was promised a lower price.
- First: **have you ever promised different prices to two payers on the same field?** If not, this question goes away.
- **Recommended (if not): one price per product per job** (quote or booking price, or the price on the first spray day), split by share, for February. Per-payer prices can come in spring.
- Other choice: price each payer's share separately. More work; delays billing.

## M3. A posted invoice had a wrong date or field name but the right dollars. What happens?

Three separate choices:
- (a) Mark it "Corrected" in CRX? **Recommended: yes.**
- (b) Re-send it to the customer automatically? **Recommended: no**; the office chooses to send.
- (c) Credit and re-bill? **Recommended: only when the dollars changed.**

## M4. A load is mixed, then rain stops the job before any acre is sprayed.

- **Recommended: the office ends the job with nothing billed.** The mix stays recorded as mixed (it really left stock) and the tank's contents are recorded as carried to the next job or put in a tote. A note like "rained out" is optional.
- Other choice: cancel and put the product back in stock. Simpler, but stock would show product that is really sitting mixed in a tank.

## M5. If CRX field billing is not ready by February 1?

- **Recommended:** the crew still uses CRX for jobs, mixing and acres, and the office keeps billing field work in Chem Man until CRX passes its go-live checks. **Cost:** the office types acres from CRX into Chem Man by hand during that time. CRX never bills planned acres.
- Other choice: bill from CRX's older job-to-invoice path (planned acres, then hand fixes).

## M6. What happens to reviewer disagreements I can't settle?

Each plan gets the review CRX's rules require plus Sol. Sol is capped at two rounds per plan; anything still disputed after that comes to you as a short list with both sides and my recommendation.
- **Recommended: yes**, keep the two-round cap.
- Other choice: no cap. Slower; the rules already stop and ask you after two rounds on a serious finding.

## M7. Start wave 1 on the test copy?

Two build sessions on **staging** (the test copy): the database lane (who-pays fields, billable acres, loads and stock) and the paperwork lane (printed sheets). They may merge into staging on their own once every review and check is clean. This yes does **not** cover anything live, any live data, any permission change, or the plan's "I approve" steps; each of those comes back to you.
- **Recommended: yes**, both lanes, once M1–M6 and M8–M9 are answered and 0.3 is merged.
- If you'd rather wait: the paperwork lane is safe to start alone (no money or database).

## M8. Two real passes over the same acres. Bill application twice?

Example: field A (49 acres) is sprayed Tuesday, then sprayed again Thursday with a second product.
- **Recommended: yes**, each real pass bills its own service and fuel acres (98 acres total), products as mixed. A suspected duplicate is flagged for the office.
- Other choice: application is billed once per field per job.

## M9. A substitute product has no price on file. Can its invoice post?

- **Recommended:** the draft shows a flag and the set can't post until the office types a price. This keeps your earlier rule that a payer set posts all together.
- Other choice: post the other payers' invoices and hold only the one with the missing price.

## Small one: the daily board's map tab (only if you disagree)

You said "list by rig, don't need map". The dispatch board shows the list first and also has a Map tab. **Recommended: keep the tab** (no work). Say "remove it" if you want it gone.

## Schedule risk (no answer needed)

February 1 is tight: about eleven database steps in a row, each with reviews, and the billing engine plus posting in under two weeks in early January. The plan proves one full job on staging by December 20 (no billing) as an early warning. If the database lane slips, M5 is the fallback.
