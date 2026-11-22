# CRX staging issues, improvements, and verified coverage

Prepared November 22, 2026. Scope is the initial staging run and its 34-case continuation. Tests ran on staging build 9a1c5b2d with synthetic records. GitHub staging had moved to 104ea5af by closeout while the deployed alias still served the checked build. Findings here describe the tested deployment and may need retest on newer builds. Field application invoice creation, changes and indirect creation were excluded.

## Coverage

**60 distinct cases were exercised across 12 of 13 tracked areas.** This is 11 operational areas plus the separate browser-readback lane. Of 76 named cases, 39 passed, 17 were partially verified, 4 failed, 9 were blocked, and 7 were excluded. The 4 failed case records represent 3 distinct app defects, because two case IDs reproduced the same Return Approval issue. The integration lane was scoped to real outbound sends and remained excluded. Source discovery catalogued 102 routes. Route inventory and blocked paths are separate from observed coverage.

Counting rule: use the last verified result for each case ID. Start with the 76 original records, replace the original 34 unrun outcomes with their continuation outcomes, then apply two separately evidenced setup retests. New Customer moved from blocked to passed. Payment History allocation expansion moved from blocked to failed. A test counts as exercised when the case passed, failed with an observed outcome, or received partial proof. Repeated browsers, retries, and fixture setup do not create new cases. Check the consolidated coverage for the original and latest status of each case.

| Area | Exercised | Passed | Partial | Failed | Blocked | Excluded |
|---|---:|---:|---:|---:|---:|---:|
| Purchasing | 5 | 4 | 1 | 0 | 1 | 1 |
| Pricing and quote history | 14 | 8 | 5 | 1 | 0 | 0 |
| Returns | 9 | 6 | 1 | 2 | 2 | 0 |
| Finance | 10 | 6 | 3 | 1 | 4 | 1 |
| Fulfillment | 3 | 1 | 2 | 0 | 0 | 0 |
| Inventory | 1 | 0 | 1 | 0 | 0 | 0 |
| Field planning | 1 | 0 | 1 | 0 | 0 | 2 |
| Operations and reporting | 4 | 3 | 1 | 0 | 0 | 2 |
| Product and customer master | 1 | 0 | 1 | 0 | 0 | 0 |
| Role coverage | 1 | 1 | 0 | 0 | 2 | 0 |
| Recovery | 3 | 2 | 1 | 0 | 0 | 0 |
| Browser readback | 8 | 8 | 0 | 0 | 0 | 0 |
| Outbound integrations | 0 | 0 | 0 | 0 | 0 | 1 |
| **Total** | **60** | **39** | **17** | **4** | **9** | **7** |

[Consolidated 76-case coverage](2026-11-22-staging-rehearsal-coverage.csv) · Initial results (local only: `C:/Codex/crx-stage-night/runs/20261121-225900/report.md`) · Continuation results (local only: `C:/Codex/crx-stage-night/runs/20261122-070645-continuation/report.md`)

## Confirmed app defects and usability defects

| ID and priority | What staff see | Impact and evidence | Retest and improvement |
|---|---|---|---|
| CRXN-01 · P2 · Return approval | Open a requested return, click Approve, and try a normal pointer click on the confirmation. The return details cover the confirmation. | Reproduced in the initial run and on an independent fresh request during the continuation. The independent request stayed pending and sent no approval. The keyboard path worked for the first return and produced the expected single stock and credit events. | Verify a normal click on a fresh requested return, correct focus and Escape behavior, exactly one approval, and Approved after reload. An existing isolated local change was browser-tested, but staging still reproduces the defect. |
| CRXN-02 · P2 · Quote Compare | Compare two versions of a quote with the same product on separate sections. One section is absent and the remaining row has no section label. | Two fresh browsers reproduced the omission. The unchanged $24.00 section was missing while the comparison displayed $26.00 to $25.00. Both saved versions and PDFs showed both lines and correct totals of $50.00 and $49.00. | Build the display around saved line identity and show section names. Retest changes to either line and ensure both remain visible, while both PDFs and totals still reconcile. |
| CRXN-04 · P2 proposed · Payment History | Find the exact payment and expand its invoice allocation. The detail does not load. | The app request returned HTTP 300. The $300.00 allocation was still saved. The deployed table has two applicable invoice relationships and the request leaves the relationship unspecified. The first runner timeout was followed by this specific staging reproduction. | Explicitly select the intended allocation relationship. Retest the exact fixture and an alternate relationship, including error display if an allocation cannot load. Check saved amounts and customer balance remain the same. |
| CRXN-03 · P3 · Quick Delivery unit display | The optional packaging unit shows a dash for a product stocked in Gal. | Reproduced on the continuation. The two-Gal entry calculated $10.00, and saved delivery, order and chemical invoice records all used Gal. This is a clarity issue in the tested combination. | Show the selected or implied sales unit before submit. Test a pack size and converted unit on run-owned fixtures and reconcile the visible quantity, saved units, stock and invoice. |

Initial finding records with reproduction steps (local only: `C:/Codex/crx-stage-night/runs/20261121-225900/findings.jsonl`) · Continuation setup retests and evidence paths (local only: `C:/Codex/crx-stage-night/runs/20261122-070645-continuation/setup-retest.md`) · Existing local Return Approval change (local only: `C:/CRX_wt/return-dialog/src/pages/Returns.tsx:1299`)

## Workflow and UX improvement candidates

These are observations or design opportunities for review. The evidence column states what actually ran.

| Area | Improvement | Evidence and decision still needed |
|---|---|---|
| New Customer and quoting | Highlight the missing commission recipient beside the split row and let staff see which step is required before Save. | A blank row refused save with the required-recipient message. Selecting the approved recipient saved exactly one synthetic customer and persisted the split. The validation worked. Placement and guidance are the improvement. |
| Return workflow | Make each stage and its effect visible: requested, approved, physical receipt, restock, and credit. Show where posted credit can next be used. | A keyboard workaround and exact readback were needed during testing. The observed goods and credit effects reconciled. Time and error reduction from a redesigned workflow remain unmeasured. |
| Credit and prepay | Make available credit, amounts applied, remaining invoice balance, and the appropriate reversal route discoverable from the same task. | Credit and prepay application reconciled. No supported individual credit unapplication or evidence-preserving prepay unapplication route was exercised. Verify which reversals staff should be allowed to perform and which history must be retained. |
| Prepay audit | Make the source payment or reference visible and traceable where it is expected. | One independent staged proof had no reference field in the captured credit readback. The cents and linkage to the applied invoice matched. This is an audit lead pending UI and policy verification. |
| Quick Delivery and To Ship | Clarify whether skipping a draft at scheduling also affects draft creation when completing the delivery. Give staff a clear next step for a completed, uninvoiced order. | With draft creation unchecked, scheduling made zero invoices and completion made one $10.00 draft. This observation needs a rule and wording check. The manual backfill scenario still lacks an eligible completed, uninvoiced fixture. |
| Purchasing and supplier costs | Show ordered cost, receipt cost snapshot, corrected PO cost, and current product cost distinctly. Make the effect of a correction clear before staff apply it. | A four-Gal PO cost correction moved received value from $32.00 to $34.00 and kept master cost at $9.00. Quick Receive preserved the PO cost basis. Supplier-origin cost selection and independent supplier statements still need proof. |
| Pricing workbook | Make the invalid row and what to fix easy to find when Apply is disabled. Keep replay feedback specific so staff can tell an already-applied workbook from a malformed one. | A mixed workbook produced one ready and one invalid row with Apply disabled. One valid change was saved once and an identical replay was refused. The guards worked. |
| Pricing and historical quoting | Make current tier, last charged, and the saved quoted amount visibly distinct. Show the relevant scope, date and source next to each. | Old and new prices remained distinct and exact. Last Charged showed different valid order and invoice sources. The idea is to reduce staff confusion. Compare has its own confirmed defect above. |
| Office exceptions and reports | Verify a staff member can start at the dashboard, find the right exception, understand what remains, and finish without reentering information. | Short delivery, finance statements, exports and some bulk controls ran. A timed dashboard-to-recovery comparison across roles and exceptions has no complete proof. |
| Documents and handoff | Compare quote PDF, pick list, signed delivery, invoice and statement in one role-by-role trail and highlight discrepancies where staff act. | A same-order chain matched quote, pick list, office delivery, $30.00 chemical invoice and statement. Signature and driver handoff remain open. |

## Coverage gaps and exact blockers

Review these as test gaps unless a confirmed app defect is listed above. Related case IDs, evidence and accountable role for each continuation case are in the consolidated CSV.

| Area | Outstanding proof and what stood in the way |
|---|---|
| Purchasing | Ordinary receipt reversal removes a recorded receiving row. A dedicated supplier return and vendor-credit path with evidence preservation was not established. Independent supplier statement, approved supplier quote/candidate pricing, and alternate-unit PO or receipt fixtures remain open. |
| Returns and corrections | Actual refunds needed an approved isolated settlement route. Credit void/reissue removes a tax-allocation row. Individual credit unapplication had no confirmed ordinary UI path. The known odd-cent two-part split fixture uses excluded field-owned invoicing. Failed pointer approval and successful keyboard recovery have separate evidence. |
| Split-payer tax and discount | The 50/50 payers, 3% primary discount and tax settings persisted. Generation on staging can notify active staff on failure, so live split invoices were not generated for this case. Treat $5.20 and $5.36 as worksheet expectations only. Stale split-credit repricing remains open. |
| Prepay, finance and periods | The applied prepay reversal path inspected removes a stored application ledger row and was blocked under preservation. General credit creation without a goods return lacks a confirmed UI route. Commission candidate visibility passed, but settlement/correction, earlier-season prepay and shared period close/reopen remain open. |
| Pricing and quote lifecycle | Legacy history sort and a safe expired quote fixture were unavailable. Quote version restore removes historical section/line rows under the inspected path. Alternate product substitution, scoped below-cost approval, voided Last Charged history, role masking and supplier quote approval remain open. The resizing check was a phone-sized browser. |
| Fulfillment, device and roles | Office delivery and short-delivery follow-up passed. Signed driver and offline reconnect require an approved staging driver and physical device. Other staff identities were unavailable. A safe, fully completed but uninvoiced fixture is needed for manual backfill. |
| Product, customer and inventory setup | Holds/release and lot receipt passed. Warehouse-wide counts, independent warehouse flow, alternate product unit, package and tote conversion, customer payer defaults, supplier change, and product retirement with existing history need dedicated fixtures. |
| Field planning | A four-acre job saved scheduled and unassigned with no invoice. Scope stopped at the billing boundary. Applicator handoff and blend coverage need an approved fixture that cannot create a field invoice. Field invoice work remains excluded. |
| Reporting, load and integrations | A scoped statement export, stale-tab refusal, and small action set passed. Multi-page compliance, larger non-production workload, broader bulk behavior and additional roles remain open. Real sends, funds and production actions were excluded. |

## Test setup, runner issues, and recovery

The source ledgers retain individual occurrences and outcomes, including repeats. The continuation attempt ledger contains **112 attempt records, 57 marked stopped**. These are runner attempt records, not 57 app defects. The following groups help plan improvements across both runs:

- **Target and access.** Saved Windows credentials initially absent, Vercel sign-in redirect, rejected browser authentication on three staging URLs, local Vercel project-link mismatch, preloaded asset mistaken for the app entry, and migration filename/application-time confusion. The durable solution was to bind the deployed staging URL, actual entry asset and staging database, and obtain sign-in through authorized access. Use a fail-closed baseline check for each run.
- **Fixture setup.** Initial product navigation or unit-loading failures, the What’s New overlay, missing required commission recipient on customer/quote fixtures, a runner guard that initially rejected the default signed-in rep, the need for exact starting stock, and unavailable alternate unit/pack, role and older records. Keep setup validation explicit before any transaction and record a separate setup retest result after repair.
- **Runner selection and timing.** Product/PO/bill/payment/quote locators, form controls that populate asynchronously, return fixture loading, separate page navigation and saved-state reads, PDF parser and teardown issues, workbook review and replay attempts, and assertions tied to a local variable after a save. This includes Payment History attempts before the confirmed app issue was established. Scoped locators, explicit readiness checks and intent/readback checkpoints are the improvements.
- **Interrupted writes and evidence.** Planned response-loss probes and incidental response loss both occurred. Exact run-owned record lookup established whether the write committed before any repeat. Preserve intent, response, persisted result and recovery separately. Do not treat a response timeout as evidence a write failed.
- **Notification containment.** Routine browser notices could be held while the chemical delivery used an authorized fixture. Some server-side exception notices and receipt behavior cannot be assumed safe. The split completion stayed gated. Test recipients, authorized roles and clean synthetic contact settings are prerequisites.
- **Credential handling.** A raw browser shutdown error exposed one short-lived staging access token in a private transcript. The browser closed and the runner suppressed raw auth errors. The signed expiration passed, and saved run artifacts had no token matches in the reported scan. Keep auth output sanitized and preserve the incident without copying the value.
- **Run control.** The first batch closed too early with 34 unrun cases. The continuation tracked the exact 34 IDs, continued past individual blockers and performed setup retests. Future closeout should require an exact disposition of every queued case and a recorded final retest pass.

Initial hiccups and individual retries (local only: `C:/Codex/crx-stage-night/hiccups.md`) · Continuation attempt ledger (local only: `C:/Codex/crx-stage-night/runs/20261122-070645-continuation/attempt-ledger.csv`) · Setup retest results (local only: `C:/Codex/crx-stage-night/runs/20261122-070645-continuation/setup-retest.md`) · Credential incident (local only: `C:/Codex/crx-stage-night/runs/20261122-070645-continuation/credential-incident.md`)

## Testing rule for future runs

Record app defects, workflow improvements and coverage gaps as they occur. During a test run, change only a runner or run-owned synthetic fixture when the change is necessary to reach or verify the case. Preserve the original failure, record what changed, and link the fresh retest. If the app itself blocks a test, document the app issue and continue independent cases. Treat an app-code repair as separate work unless Mason specifically asks to make a necessary unblock for the current test. Keep field application invoicing excluded from this rehearsal. No application fixes were made for this consolidation.
