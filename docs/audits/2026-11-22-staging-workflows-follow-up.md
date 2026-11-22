# Staging workflow rehearsal — gaps, defects and staff improvements

November 22, 2026. This completes the reporting for the original overnight rehearsal, its continuation, the nine-section pass and the blocked-case retests. All observed transactions below used fictional fixtures. Field application invoicing was excluded throughout. Field planning, dispatch navigation and related non-billing surfaces appear only at their recorded proof depth.

## Coverage and proof

| Pass | Results | Tested build |
| --- | --- | --- |
| Overnight launch | 76 catalogued cases. 26 passed, 2 failed, 7 blocked, 34 unrun and 7 excluded at early stop. | `9a1c5b2d` |
| Continuation | Ran the exact 34 remaining IDs. 12 passed, 17 partial, 1 failed and 4 blocked. After setup retests, the reconciled original ledger contains 39 passed, 17 partial, 4 failed case records, 9 blocked and 7 excluded. | `9a1c5b2d` |
| Nine sections and setup | 55 cases across nine sections and a final setup batch. 6 passed, 4 read-only verified, 13 partial, 15 navigation only, 13 blocked and 4 reproduced issues. | `17a72d0ee` |
| Blocked-case follow-up | One of 13 cleared on deployed staging. Six had a successful isolated database retest of the blocked action or a scoped variant, four had partial local proof and two lack a verified staff workflow. Focused local checks passed 75 tests across seven files. | Browser `5f6d0c327`. Disposable database replayed 336 migrations after its baseline. |

The two case registers overlap. Counts describe each pass. A readback, a page open, a worksheet and an isolated database pass carry different proof from a completed staff workflow on the deployed app. The four failure reproductions in the nine-section pass are four existing issues. The release fixes below have their own proof status.

[Original rehearsal and findings](2026-11-22-staging-rehearsal-issues.md) · [Original 76-case register](2026-11-22-staging-rehearsal-coverage.csv) · [Later 55-case register](2026-11-22-staging-workflows-cases.csv) · [First report PR](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/2204)

## Confirmed defects and acceptance checks

| Finding | Evidence and impact | GitHub status and next check |
| --- | --- | --- |
| KI-200 · Return Approval pointer | The return detail intercepted a normal pointer click on its approval confirmation. Keyboard activation in an earlier pilot approved once. A further trial reproduced the pointer blocker and left the request pending. | [#2205 closed](https://github.com/croprxsolutions/CRX_Manager_V1.0/issues/2205), [#2210 merged to staging](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/2210) and included in the later verified test deployment. Fresh browser behavior remains open. On a new fictional request, confirm pointer and focus work, one approval is submitted, and reload shows Approved. |
| KI-201 · Quote Compare drops a section line | Comparing snapshots for a product used in two sections showed only the $26→$25 row. The unchanged $24 line was missing. Both snapshots and PDFs held the lines and the $50→$49 totals. | [#2206 open](https://github.com/croprxsolutions/CRX_Manager_V1.0/issues/2206). Quote owner: match saved lines by stable identity, show section labels and prove both rows and the totals. |
| KI-202 · Payment allocation fails to expand | Expanding the date on a saved fictional $300.00 payment returned HTTP 300. The relationship request was ambiguous. Independent readback found one correctly saved allocation. | [#2207 open](https://github.com/croprxsolutions/CRX_Manager_V1.0/issues/2207). Billing owner: use the intended invoice relationship, cover alternate/empty/error cases and reconcile the expanded amount to the saved payment. |
| KI-203 · Quick Delivery missing sales unit | A product stocked and sold in Gal showed a dash before save at two Gal and $10.00. Existing saved lines carried the correct unit. | [#2208 closed](https://github.com/croprxsolutions/CRX_Manager_V1.0/issues/2208), [#2213 merged to staging](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/2213) with a regression test. Browser check on the merged deployment remains open. Confirm products with and without a package size and reconcile form, saved lines and stock. |

## Observed business results

| Area | Evidence and remaining edge |
| --- | --- |
| Supplier PO, receiving and payable | A 12-Gal receipt at $8 drove one $96 bill and fictional ledger payment, leaving zero due and on order. Close Short preserved one receipt, received four and cleared eight on order. Mixed receipts preserved $57.50 basis and seven Gal while master cost remained $9. A correction changed a four-Gal receipt from $8 to $8.50 and aging to $34. Quick Receive added three Gal and left nine on order. Later setup received two Gal for $14 while $8 master cost and three tiers stayed unchanged. |
| Cost, selling prices and old quotes | Old presented quote retained $11/Gal and $22 after master cost went from $8 to $9. New quote used $12/Gal and $24. Converted old quote held $22 revenue, $16 cost, $6 gross profit and a $6 pending commission. Three tier quotes were $12/$15/$18 per Gal. An unsent draft repriced. Two booking draws retained $12 sale and $9 cost after master changes. Desktop and phone-sized edits persisted, stale writes were refused, and one workbook change at $12.10 persisted. Identical workbook replay and mixed invalid input were refused. Approved supplier quote at $18 per two-Gal case normalized to $9/Gal. Cost-basis selection was disabled on the tested product, and its $8 master cost remained intact. |
| Chemical delivery, invoice and customer statement | Short and follow-up deliveries each generated one $5 draft and cleared the remainder. One quote-led order linked a local quote PDF, pick list, office completion, $30 posted chemical invoice and $30 statement. Signature, driver handoff, offline sync and a supported staged manual missing-invoice recovery remain open. |
| Returns, payments and prepay | Paid, partly paid and unpaid return variants preserved source balances. A paid two-Gal sale consumed two Gal, return of one Gal restocked once and issued one $5 credit. Applying it to an $8 charge left $3. Cancellation added no stock or credit. Independent readback found one saved credit after response loss. In a separate case an $800 fictional ledger payment applied $300 to a $500 charge and left $500 prepay. Its void restored $500 due and retained the original payment/allocation history. In the applied-prepay variant the separate application row was removed on source void in the disposable proof. A $10 write-off and reversal restored $500 due with retained audit. |
| Statement, rebate and commission | Scoped CSV and statement verified $8 debit, $3 prepay and $5 balance and the date filter. One $6 commission remained selectable and unpaid. A $1/Gal rebate program saved, then a two-Gal standalone $2 claim reached Approved without payment, customer or order. Commission settlement, qualifying-order rebate attribution and payout remain open. |
| Product, compliance and field planning | New Customer saved with a required commission split and no contacts. Lot Trace displayed no recorded applications for a known one-Gal receipt. Four Gal was independently proven across the product, with no lot-specific balance proof. One four-acre plan reopened scheduled and unassigned with no downstream activity. One standalone one-Gal recipe saved and remained unused. The later fictional restricted-use chemical sale posted $10.00 for two Gal, stock moved 6→4 Gal, and one register row matched invoice line, product, selected brand and buyer certification. Zero payments or outbound notices accompanied it. |

## The 13 original blockers and their follow-up

| ID | Result and remaining work | Area |
| --- | --- | --- |
| S1-CREDIT-REV | Isolated pass. Reversal restored $8 due and $40 memo availability, kept one reversed application and replayed safely. Staff UI still needs an audited reversal action, subject to decision 34. | Finance |
| S1-PREPAY-REV | Isolated pass with history finding. Voiding the source restored $8 due and zeroed the source prepay. The application row was removed. Define history retention and staff permissions before an app change. | Finance |
| S1-NO-GOODS-CREDIT | No verified standalone credit action. The available Misc Charge action and eligible goods return cover different transactions. Define authorization, source reference, limits and audit. | Finance/product |
| S1-CREDIT-VOID-REISSUE | Isolated untaxed void/reissue passed. One replacement $40 credit and no extra restock. The original staged taxed memo kept its tax allocation. Determine retention requirements before testing the taxed lifecycle on a disposable fixture. | Finance |
| S1-FICTIONAL-REFUND | No verified ordinary action or isolated settlement. Decide whether CRX records an external refund or owns settlement and define the test-only destination and ledger proof. | Finance/product |
| S2-CHEM-SPLIT | Isolated alternate-price fixture posted two invoices at $10.39 and $10.71, verifying 50/50 shares, the primary 3% discount and 6.25% per-payer tax. Original staged $5.20/$5.36 remained a worksheet. Finish staged delivery-to-statement in an environment with contained notifications. | Fulfillment/Finance |
| S2-ODD-RETURN | Isolated chemical-only case split $5.01 into $2.51/$2.50 and refused stale return sequencing. Deployed retest requires posted payer invoices on a chemical sale. | Returns/Finance |
| S3-CHEM-RECOVERY | Isolated historical delivery created exactly one $40 draft for four Gal, replayed safely and preserved stock. All 11 completed staging candidates already had invoice coverage. Seed one genuinely uninvoiced completed delivery for browser proof. | Fulfillment QA |
| S4-SUPPLIER-RETURN | Isolated receipt reversal moved stock 54→50 and on order 13→17, recorded one adjustment and removed the receipt row. The history-preserving supplier return, linked vendor credit and independent statement remain open. | Purchasing/Warehouse |
| S5-ROLE-LAST-CHARGED | Isolated admin and sales rep both returned $10/Gal without cost or margin fields. A staging rep and a newer voided invoice are needed to verify the screen, role and history. | Sales/Staging Access |
| S6-MONTH-END | Isolated period closed and reopened with one reopen audit record, safe retries and rep refusal. Late correction and statement across the close boundary remain open. | Finance |
| S7-CROP-PROGRAMS | Local parsing, mapping and unit-transform tests passed. Save/apply through fresh sessions needs disposable template settings because the save replaces the complete collection. | Office Operations |
| S8-RUP | Cleared on deployed staging. One active register line matched two Gal at $5/Gal on the posted fictional chemical invoice with compatible customer certification and confirmed brand. | Compliance |

## Additional gaps across the nine sections

| Area | Next evidence needed |
| --- | --- |
| Fulfillment and field operations | Authorized driver/applicator sessions, physical phone and offline reconnect, signature, exception recovery by role, and planning-to-blend and application record lineage. Keep field application invoicing excluded. |
| Products and purchasing | Supplier selection enabled on an isolated product, unit/pack/tote and conversion fixtures, isolated count/recount and retirement, and proofs of vendor/payer/address history. |
| Pricing and quotes | Quote expiry, restore and legacy cases, scoped below-cost approval/refusal and role-specific Last Charged. Use disposable quote restore because the existing path replaces saved lines. |
| Finance and reporting | Prior-season prepay correction, commissioning and rebate settlement in test scope, month boundary and year-end acceptance, report pagination, bulk export and independent reconciliation through stock, aging, statements and accounting. |
| Office and compliance | Helper evidence for Crop Programs needs real persistence. Call Lists, Vehicles, Watchdog, Offline Work Review, Program Tracker, Label Review, Label Data Quality and EPA setup have navigation or limited filter proof. Test exact actions, pagination and downstream effects. |
| Communications and scale | Use captured recipients, test settlement and scoped accounts before messaging or refund tests. Add higher-volume and retry/concurrency cases with independent readbacks. |

## Staff UX changes to evaluate

| Surface | Observed friction and improvement |
| --- | --- |
| New Customer | Save requires a commission recipient. Put the prompt next to the incomplete split and focus that row. |
| Quote Compare and pricing | Keep every saved comparison row with its section. Label current tier, last charged, saved quoted amount, date and source clearly. Show the workbook's invalid row and remedy. Use distinct messaging for an already-applied file. |
| Purchasing and supplier quote | Show ordered cost, receipt snapshot, corrected PO value and current cost together with the effect of an edit. Show package conversion and normalized cost at review and explain why an approved quote cannot yet be selected. |
| Returns and prepay | Display requested, approved, received, restocked and credited as separate states and link to use the credit. Keep original payment/reference, amount applied and balance visible. Expose permitted corrections with retained history once Finance has decided the rules. |
| Quick Delivery and Today | The draft checkbox controls scheduling. Routine completion can still create a draft. Review copy with decision 35 and surface the existing draft or eligible next billing action from the exception card. |
| Recall and compliance | Tell staff that Lot Trace searches recorded application use and where to find receipt/delivery evidence and a lot balance. Show brand confirmation in the delivery list or route staff to confirm in Delivery Detail. The list-revision difference is a source observation awaiting a browser retest. |
| Reports and handoffs | Keep customer and dates visible in the export and handoff. Make the quote, pick list, delivery, chemical invoice and statement easy to trace and surface mismatches at the actionable step. |
| Field planning | Distinguish planning, dispatch and handoff states. The observed four-acre plan and recipe were before dispatch. |

## Runner and setup follow-ups

Verify the deployed app and database targets together before writing and again after an alias change. The follow-up refused a changed alias before login, then verified the replacement before starting. Use uniquely named fictional records and exact ownership checks. Check expected and actual amounts, units, lifecycle and downstream effects independently. Capture timeouts and retry attempts even when a later targeted probe passes. When a response is lost, look up the exact saved result before submitting again. Keep authorized role coverage, isolated periods and settings, captured notices, unknown outcomes and excluded paths explicit in the roster. Complete eligible setup retests before closing.

Documented setup issues included incomplete product unit/stock and supplier links, disabled cost selection, missing commission recipient, protected deployment access, slow readiness, selectors and overlays, misleading empty results, workbook/PDF handling and missing role or downstream fixtures. New Customer, scoped receipt and stock, standalone rebate, field plan, recipe and restricted-use setup were recovered to the depths above. Raw journals and authenticated evidence remain private.

The ongoing backlog is [Known Issues KI-200–205](../manual/KNOWN_ISSUES.md), [To-Do 13.7 and 16.12, and decisions 34–35](../manual/TO_DO_LIST.md), and the [Master Fix Plan](../manual/MASTER_FIX_PLAN.md). Preserve the remaining December rehearsal acceptance scenario as an open item until the full scenario runs across the period boundary.
