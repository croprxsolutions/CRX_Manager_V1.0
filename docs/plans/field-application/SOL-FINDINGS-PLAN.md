# Sol's 88 findings: what we do with each one

Sol (gpt-6.2-sol, high effort) reviewed `SPEC.md` on 2026-11-24. Its full report is Sol's full report (kept in Mason's private review folder).

**How to read the "Plan" column:**
- **YOUR ANSWER:** you decided it on 2026-11-24.
- **KEEP:** I'll build it in. It's either behind the scenes or one small screen detail, with no extra steps for the crew.
- **SKIP:** over-engineering, or already covered by an earlier decision.
- **DEFAULT:** a simple rule I picked. Change it if you disagree.

Your standing rule (2026-11-24): **don't over-engineer. Keep the crew and office free and flexible. Flags and notes, not blocks.**

| # | What Sol found (plain English) | Plan |
|---|---|---|
| 1 | A rate over the label maximum can still be printed and sent to the sprayer | **SKIP.** You decided over-rate warns but never blocks. The warning stays |
| 2 | A work entry doesn't say which product went on which acres if two different mixes were sprayed the same day | **KEEP.** Each work entry is linked to the load that sprayed it, so the product is known automatically. No extra typing |
| 3 | The whole-job 5% average can hide one field that went over the label maximum | **KEEP.** The label maximum is checked field by field as a warning only (still a G6 note, never a block) |
| 4 | Changing the mix mid-job makes earlier fields look like they got the new product | **YOUR ANSWER:** each load keeps its own mix |
| 5 | Three different billing rules could disagree | **YOUR ANSWER:** bill each field from the load that sprayed it × sprayed acres. The office can override with a reason |
| 6 | Job A closes on an estimate while Job B is still using the same shared load | **YOUR ANSWER:** Job A's invoice waits until the shared load is used up or set aside. The office can force it early |
| 7 | Two jobs on one tender could both count the same gallons as theirs | **KEEP.** Shared gallons are split by acres once the load is settled (Q11 plus answer 6). No reservations system |
| 8 | A real spill could be hidden as a gauge correction | **YOUR ANSWER:** no spill button. Correct balance covers it (Q14) |
| 9 | Sometimes no field is safe to spray off leftover mix | **YOUR ANSWER:** it goes in a tote and is handled outside the system |
| 10 | A phone that never syncs could hide a day's work | **SKIP.** Q7 already shows "waiting to sync". No device sign-offs |
| 11 | Cancelling a half-sprayed job could lose the sprayed acres | **YOUR ANSWER:** close the leftover acres. Cancel is only for jobs with zero acres sprayed |
| 12 | Grower-supplied product mixed with another customer's job | **YOUR ANSWER:** flag it afterwards (Q3) |
| 13 | Posting a payer set could half-succeed (two invoices post, one fails) | **KEEP.** The whole set posts or none of it does |
| 14 | Field-specific label restrictions (crop stage, buffers, harvest window) | **SKIP.** That stays the applicator's job, as today |
| 15 | Spray record rules differ by state | **YOUR ANSWER:** two or more states. Staff set the required fields (D6, kept small) |
| 16 | No check of applicator licence or supervisor | **SKIP.** Already a LATER item (3a) |
| 17 | No notice to the farm before spraying | **SKIP** |
| 18 | The spray record waits on the whole job or the invoice (federal rule: a restricted-use record goes to the customer within 30 days) | **KEEP.** The spray record prints per field any time, without waiting for the job or the invoice |
| 19 | The exact product registration number may be missing | **SKIP** beyond KI-206. Picking the product from the list already identifies it |
| 20 | Drift or a wrong-field spray has no alert path | **YOUR ANSWER:** a note is enough |
| 21 | Batch sizing uses the whole tank size, not the space left | **KEEP.** The proposal uses the space left in the tank |
| 22 | "Same mix" is judged by the plan, not by what was really mixed | **KEEP.** Combining tanks compares the real mixes. A mismatch shows a warning, never a block |
| 23 | An empty tank can still hold residue before a sensitive crop | **SKIP** |
| 24 | A gauge drop gets counted as sprayed even if it was priming or a transfer | **SKIP.** Covered by your 5% slack plus a note |
| 25 | No tolerance for rough gauges | **YOUR ANSWER:** allow 5% or more with no office step. The applicator just notes it |
| 26 | A held tote could be reused by mistake | **YOUR ANSWER:** totes are handled outside the system |
| 27 | Two drivers fill from the same gallons at once | **KEEP** (behind the scenes). The second save sees the updated balance. If it would go below zero, it warns only |
| 28 | The same pass entered on the phone and from paper | **KEEP, light.** CRX warns when two entries look the same (same field, day and acres), and the office deletes one |
| 29 | A batch could take stock but fail to update the tank | **KEEP.** Stock and the tank balance save together or not at all |
| 30 | The planned warehouse is recorded even if product came from another one | **SKIP.** The warehouse is already editable at the tablet. No lot tracking |
| 31 | No way to fix a typo on a confirmed batch, or add product later | **KEEP.** "Correct batch" with a reason (a reversing entry) and "Add to batch" |
| 32 | Stock is short in CRX but the product was really used | **YOUR ANSWER:** allow it and flag the office |
| 33 | How bookings get drawn down | **DEFAULT:** today's booking rules (Taha's area) |
| 34 | A grower already bought product that CRX is holding, so it could be billed twice | **YOUR ANSWER (2026-11-24, brainstormed):** sometimes a customer already paid for product they want dropped in the tank, and that earlier invoice already took it out of stock. So it is handled exactly like grower-supplied product: on the job's product line the office or mixer picks **"Customer's own / already paid"**. It takes no stock at the batch and shows on the field invoice at no charge. Moving it to another customer's job is flagged (Q3) |
| 35 | Over-the-counter restricted-use sales need their own records | **SKIP.** The normal sales flow handles sales |
| 36 | Internal cost and margin of shared loads | **SKIP.** Cost leaves with stock at the batch. No per-job margin split |
| 37 | Extra acres the office declines to bill | **YOUR ANSWER (2026-11-24):** extra acres the applicator logs just bill like any sprayed acre. No office check, no friction. They show on the review screen for information only (replaces D3's 'check before charging') |
| 38 | The "larger pass counts" rule miscounts partial overlaps | **SKIP** (you said repeat passes are a non-issue). I'll drop that rule; the office just edits acres if needed |
| 39 | "Bill actual used" spreads extra product onto fields that never got it | **KEEP.** The extra is spread only over the acres that got that mix (automatic with each load's own mix) |
| 40 | Who owes a waste or extra-visit charge | **SKIP.** The office decides with a reason (D11) |
| 41 | A landlord split changes mid-job | **YOUR ANSWER:** use the split on the day sprayed. The office can always edit at posting |
| 42 | Two reps editing different payers' drafts could make the set disagree | **KEEP** (behind the scenes). Edits apply to the shared line and its split together |
| 43 | A price refresh could raise locked quote prices | **KEEP.** A refresh never touches locked quote or booking lines |
| 44 | Duplicate-billing check is based only on field, date and product | **SKIP.** The B04 warning stays as it is |
| 45 | The unpost check must also cover credits and prepays | **KEEP** |
| 46 | Which invoices get credit-and-rebill | **DEFAULT:** only the invoices that changed |
| 47 | A spray-record correction after posting could leave the invoice wrong | **KEEP, light.** Correcting a posted job's record flags its invoices for the office |
| 48 | Sales tax per payer | **YOUR ANSWER:** no tax on field work |
| 49 | A partial batch could release all of the job's held stock | **KEEP.** It releases only what that batch used |
| 50 | Deleting old jobs at go-live | **YOUR ANSWER:** delete test jobs (with your yes at the time) and archive real ones |
| 51 | The first-real-job check is vague | **KEEP D12.** I'll write a short checklist for the first real job |
| 52 | Weather pulled at the wrong time (for example, logged at night) | **KEEP.** Weather is pulled at the "Now" start time and stays editable |
| 53 | Clean jobs still need an office close | **KEEP.** One-click close for clean jobs |
| 54 | A rescheduled job could leave two crews on different plans | **SKIP** |
| 55 | A rig change reads as if the liquid moves with it | **KEEP** (wording fix). A move is logged only if liquid really moved |
| 56 | Paper tickets have no ticket number | **SKIP** |
| 57 | Fields with similar names get mixed up | **KEEP, light.** Show the grower name and acres beside field names in pickers |
| 58 | A note may not be enough for the next driver to find the unfinished strip | **SKIP.** Acres plus a note (S12) |
| 59 | Prefilled acres make it easy to save a spray that never happened | **SKIP.** Prefill stays (G3.3) |
| 60 | A zero-acre job breaks the rate check | **KEEP.** It closes without a rate check |
| 61 | A crew-mistake second pass gets billed | **YOUR ANSWER:** non-issue, no rule |
| 62 | "Carrier rate", water added and finished gallons are mixed up | **KEEP.** "Water to add" and "finished gallons" are labelled separately |
| 63 | Adding water only, or an interrupted mix | **SKIP.** The mixer notes it |
| 64 | Fill and gauge correction could record the same change twice | **KEEP** (behind the scenes). The fill suggestion recalculates after a correction |
| 65 | Balance formulas miss some move directions | **KEEP** (wording fix). Balances count every move in and out |
| 66 | Which price date for a job sprayed over several days | **YOUR ANSWER:** one price from the first spray day. Locked prices still win |
| 67 | How a job-wide flat fee splits across fields | **YOUR ANSWER:** no flat fees. Remove the feature |
| 68 | What fuel is charged on | **DEFAULT:** per acre on the application share, as written. The office can edit the line |
| 69 | The leftover cent can land on a payer with a 0% share | **KEEP.** The leftover cent goes to the biggest share on that line |
| 70 | Who may add a payer to a line | **SKIP.** Already limited to payers saved on the field |
| 71 | The invoice confuses the field total with the payer's share | **KEEP.** Lines labelled "field total" and "your share" |
| 72 | Maps or notes could show another customer's info | **SKIP (Mason, 2026-11-24):** not an issue. Removed |
| 73 | One person can make a change, approve it and post it | **SKIP.** No second-person approvals |
| 74 | Commission when two reps share a job | **YOUR ANSWER (2026-11-24):** commission comes from the rep set on the customer in customer setup. Who entered the job or posted the invoice doesn't matter |
| 75 | Zero-dollar invoices | **DEFAULT:** none are made |
| 76 | Who gets the "job done" email | **YOUR ANSWER (2026-11-24):** the email goes to every payer on the job (many fields are 50/50). Each payer's email shows only their own fields. Still off by default |
| 77 | One delayed field holds up the whole job's billing | **KEEP.** A simple "sprayed, not billed" list for the office |
| 78 | Cancellation or trip fees | **SKIP.** No flat fees |
| 79 | A grower pays from an old emailed invoice after a correction | **KEEP, light.** A reposted invoice is marked "Corrected" |
| 80 | A standing stock vs sprayed vs billed comparison | **YOUR ANSWER (2026-11-24): KEEP.** A standing office view per job: stock that left at the batch vs gallons sprayed per field vs what was billed, with any difference highlighted, so the office can spot problems quickly |
| 81 | No way to send a field back to the crew | **SKIP.** The office calls the crew and reopens the job |
| 82 | Launch testing covers only a clean job | **KEEP.** I test the messy cases too (my work, no crew cost) |
| 83 | Rain-held jobs still show in the mixer's list | **SKIP.** The mixer picks |
| 84 | Only one driver per entry | **SKIP.** The crew field already takes more than one name |
| 85 | Print options unclear | **SKIP** |
| 86 | Field numbers repeat when several jobs print together | **YOUR ANSWER (2026-11-24):** spray order is numbered per job. Every job starts at 1, 2, 3, even when three jobs go out to the same sprayer |
| 87 | The worked example skips the last partial fill | **KEEP** (doc fix) |
| 88 | Printed amounts more precise than the crew can measure | **SKIP** |

**Totals (updated 2026-11-24):** 24 your answers · 32 keep · 28 skip · 4 defaults.
