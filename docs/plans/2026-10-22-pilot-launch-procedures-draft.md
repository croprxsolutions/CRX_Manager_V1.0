# Pilot launch procedures: FIRST DRAFTS

**Status: DRAFT for Mason to correct. Not approved, not rehearsed, not policy.** Written 2026-10-22 by
Claude for To-Do List rows 16.5–16.8 (`docs/manual/TO_DO_LIST.md`, section 16). Every person is a
placeholder because To-Do decision 5 ("name an owner and a backup") is still open. Anything marked
**Draft suggestion** is a proposal Mason hasn't decided; each procedure ends with the questions he
needs to answer.

**Why this file is in `docs/plans/`.** Unproven procedures live here as drafts, like the restore
procedure (`docs/plans/2026-10-19-goal6-restore-procedure-draft.md`). Once Mason approves a
procedure and it has been rehearsed in December, it moves into
`docs/operations/production-runbook.md`, and the printable pages are printed from there.

**Sources the drafts are built on:** the goals doc (`docs/plans/2026-10-13-direction-and-goals.md`,
Goal 5, Goal 6 and Phase D), the production runbook (section 4.8, the outage paper fallback, and
section 6, common incidents), and the app's screens as they are on `main` today (2026-10-22).

**Words used below:**
- **Pilot:** the first 30 days of CRX-only billing, starting 2027-01-01.
- **Posting** an invoice locks it as a real bill the customer owes.
- **Tie-out:** checking that two numbers that should agree really do, and writing down why when they don't.
- **Business day:** a day the office is open. The check covers the previous business day.

## Contents

1. [Daily pilot check (16.5)](#1-daily-pilot-check-165)
2. [Emergency brake (16.6)](#2-emergency-brake-166)
3. [Outage paper fallback (16.7)](#3-outage-paper-fallback-167)
4. [Launch support (16.8)](#4-launch-support-168)

---

## 1. Daily pilot check (16.5)

**Purpose:** every business morning of the pilot, prove that yesterday's money and stock in CRX add
up, and catch any difference while it is one day old.

**Who:** [OWNER: Mason to name] runs it. Backup: [OWNER: Mason to name]. Reviewed by Mason and the
bookkeeper ([OWNER: Mason to name the bookkeeper]).

**When:** Phase D requires every one of the first 30 days to be reconciled, so the sheet has one row
per calendar day, January 1 through January 30, including weekends and holidays. **Draft
suggestion:** run it each morning the office is open, by 10 AM Central, for the day before. After a
closed day, the next morning's check covers each closed day on its own row. The first check is the
morning of January 2 (a Saturday), so someone has to run it that day, or it waits for Monday,
January 4, and covers January 1–3 separately (question 5 below). Roughly 30–45 minutes once
practiced; the December rehearsal should time it.

**Needs:** an admin login. The Data Integrity, A/R Workspace and Prepay screens are admin-only.

**What you record:** one row per day in the **Pilot Daily Check sheet** and one row per difference in
the **Pilot Difference Log** (both described at the end of this section). **Draft suggestion:** a
shared spreadsheet, so Mason and the bookkeeper can see it the same day.

### Step 1. Run the Integrity Report

Open **Data Integrity** in the sidebar (under the money section). The **Report** tab runs 10 checks
each time it opens: Order Totals, Inventory Ledger, Invoice Payments, Invoice Balance Formula,
Commission Splits, Quote-Hold Parity, Delivery-Invoice Quantity Parity, Pre-booked Inventory,
Return-Credit Linkage and Customer AR Consistency.

- Write down the time at the top ("Run at …") and the discrepancy count next to it.
- Every check should say **PASS**. A check that says "N issues" lists the records with what it
  expected, what it found and the difference. Money is shown **in cents** (12345 means $123.45).
  **The screen shows at most 50 records per check** ("Showing first 50 of …"). Write down the full
  issue count, not just the rows you can see. If a check has more than 50, report it to launch
  support (procedure 4), who can pull the full list.
- If a check's description ends in **[ERROR: …]**, that check didn't run. If the page says **Failed
  to load report**, none of them ran. Either way, treat it as **not clear**, press **Re-run** (or
  reload the page), and log it if it fails again.
- Compare with yesterday's sheet. A problem that was already on yesterday's sheet and is already in
  the Difference Log doesn't need a new row; anything new does.

**Known before the pilot:** some flags existed before launch (for example, products that flag until
the stock count is done; see `docs/manual/KNOWN_ISSUES.md`). The opening-balance and stock-count work
(To-Do 15.1 and 15.2) has to clear them before January 1. Phase D says no unresolved money, stock or
compliance defect is accepted just to hit the date. So each flag is either fixed or shown not to be a
defect, with Mason's sign-off, before the pilot starts. The first day's sheet records that the list
started clear, or names each signed-off exception.

### Step 2. Check the Cleanup tab

On the same page, open the **Cleanup** tab and write down the count for each section:

- **Data-integrity alerts:** found by an automatic sweep that runs every night (06:45 UTC, which
  is 12:45 AM Central in winter). It looks for new negative stock, negative invoice balances, stock
  holds stuck on closed quotes and over-drawn bookings. It changes nothing; it only warns. Every new
  alert gets a Difference Log row. As the screen says: investigate the record, fix it if needed, then
  press **Mark resolved**, and write what you found in the log.
- **Negative inventory**, **Over-received PO items**, **Completed deliveries without invoices** and
  **Phantom inventory rows:** compare the rows themselves with yesterday's (product and location, PO
  number, delivery number), not only the counts. One row can be fixed while a new one appears, and
  the count stays the same. Every new row gets a Difference Log row.
- **Completed deliveries without invoices** is a list of old, historical exceptions. It leaves out
  deliveries recorded as billed outside CRX, so it can't prove that yesterday's deliveries were
  billed. Step 6 checks yesterday's deliveries directly.
- If a red box says "These sections could not be loaded", the check isn't clear. Press **Refresh**.

### Step 3. Balances

Open **A/R Workspace**. The strip at the top shows four numbers: **Total Owed**, **Unused Prepay**,
**Credit Memos** and **Net Position**. Write all four on the sheet. If the strip doesn't appear at all,
one of its reads failed. That isn't the same as zero: the balance check isn't clear. Reload the page,
and report it to launch support if the strip still doesn't appear.

Then explain the change from yesterday. **Draft suggestion** (the bookkeeper sets the final rule):

> yesterday's Total Owed + invoices posted yesterday − payment amounts applied to invoices yesterday
> − credits and prepay applied yesterday ± corrections (for example a reversed credit) = today's Total
> Owed

Payment money that wasn't applied to an invoice doesn't lower Total Owed, so it's tracked separately
(Step 4). If it doesn't add up, the gap gets a Difference Log row. The **AR Aging** tab on the same page shows
each customer's balance when one needs a closer look.

### Step 4. Payments

On **A/R Workspace**, open the **Payment History** tab and list yesterday's payments.

- The total of yesterday's payments matches the checks and transfers actually received yesterday:
  the deposit slip, the bank's record of transfers, and any paper payment log.
- Each payment went to the right customer and the right invoices. Money that wasn't applied to an
  invoice is written down with who will apply it.
- **Known gap (To-Do 6.7, MUST, open):** **Record Payments** has no "date received" box. CRX stamps
  each payment with the server's date, which runs on UTC (six hours ahead of Central in winter). A
  payment entered after 6 PM Central lands on the **next** day, and on December 31 or January 31 in
  the wrong month. A payment received one day and entered later shows the entry date. Writing the
  real date in **Notes** helps a person reading it, but it **doesn't change the recorded date**.
  Until 6.7 is fixed: **Draft suggestion:** enter payments before 6 PM Central, and when matching
  yesterday's payments, also look at payments dated today that were entered last evening. 6.7 should
  be fixed before the pilot.

### Step 5. Credits and prepay

- **Credits:** each return credited yesterday has its credit memo (the Integrity Report's
  Return-Credit Linkage check covers this). The **Credit Memos** total from Step 3 changed only by
  credits issued, applied or reversed yesterday, or another approved correction.
- **Prepay:** **Unused Prepay** from Step 3 changed only by prepay received, applied or edited
  yesterday, or another approved correction. For a customer whose prepay changed, open **Prepay**
  (Manager tab) and check their balance.
- **Not built yet:** there's no automatic check that each customer's prepay balance equals the sum
  of their prepay credits (To-Do 6.8). Until it exists, this step is a manual spot check.

### Step 6. Stock

- The Integrity Report's **Inventory Ledger** and **Pre-booked Inventory** checks pass (Step 1).
- No new **Negative inventory** rows (Step 2). A shortage only warns and never blocks a delivery
  (Mason, 2026-10-15, permanent), so a new negative row usually means a delivery went out against
  stock CRX didn't show. Find out why.
- Each delivery completed yesterday was billed. The Integrity Report's **Delivery-Invoice Quantity
  Parity** check passes (delivered quantity matches invoiced quantity for each order and product).
  Then, on **Deliveries**, list yesterday's completed deliveries, and confirm each customer's draft or
  posted invoice for it on **Invoices — Chemical** (completing a delivery creates a draft invoice).
- Any count difference found in **Cycle Counts** gets a Difference Log row.

### Step 7. Work waiting for review

- **Offline Work Review** is empty, or every item on it has been handled.
- **Watchdog Flags:** look at any new flag. Flags are advice only; log the ones that turn out to be
  a real problem.
- Paper records from an outage or an emergency brake (procedures 2 and 3) that aren't entered yet:
  write the count, and the oldest one's date.

### Step 8. QuickBooks

The way this step works isn't decided yet. Mason decides at the 2026-12-15 checkpoint (To-Do
decision 3):

- **If the QuickBooks Desktop sync is live (To-Do 14.2):** yesterday's sync finished with no failed
  or unresolved entries. Its counts and totals of invoices, payments and credits match Steps 3–5.
- **If QuickBooks is entered by hand (To-Do 14.3):** this branch can't be used until 14.3 is written
  and rehearsed. 14.3 requires a transaction-level CRX report, and written steps for entering
  invoices, payments **with their allocations**, credits, prepay and corrections by hand. Each one is
  marked when entered, so nothing goes in twice, and each customer is tied out daily, signed by the
  bookkeeper. This step then checks that every one of yesterday's entries was made, once.

Neither the sync nor the hand-entry report exists yet. This step gets written properly once one is
chosen.

### Step 9. Close the day

- Fill in the day's row on the Pilot Daily Check sheet: date, time run, who ran it, the counts
  from Steps 1–2, the four balances from Step 3, yesterday's payment total, and "all clear" or the
  Difference Log numbers.
- **Every unexplained difference** gets a Difference Log row the same morning, with an owner. A
  money, stock or compliance difference that comes from a defect in the app goes to launch support
  (procedure 4) at once. Launch support decides whether it needs the emergency brake (procedure 2).
- **Draft suggestion:** Mason and the bookkeeper read the sheet and the open Difference Log rows
  every day, and sign each week. At the end of the 30 days they sign the pilot result, as Phase D
  requires, with the senior developer.

**Pilot Daily Check sheet columns (draft):** date · run by · time · Integrity discrepancies ·
Cleanup counts (alerts / negative stock / over-received / deliveries without invoices / phantom
rows) · Total Owed · Unused Prepay · Credit Memos · Net Position · payments recorded (count and
total) · deposit total · QuickBooks status · paper records not yet entered · all clear? · Difference
Log rows opened · reviewed by.

**Pilot Difference Log columns (draft):** number · date found · found by · what is different
(record, expected, found) · money or stock effect · cause · owner · fix (and the PR, if it was an
app fix) · date fixed · checked by.

### Questions for Mason (daily check)

1. Who runs the daily check, and who is the backup? (To-Do decision 5.)
2. Who is the bookkeeper who signs, and is a daily read with a weekly signature enough, or should
   they sign every day?
3. Is 10 AM Central the right deadline?
4. Where should the sheet and the log live: a shared spreadsheet, paper in a binder, or somewhere
   else?
5. Does someone run the check on Saturdays and holidays (starting Saturday, January 2), or does the
   next open morning cover each closed day on its own row?
6. Should the missing prepay check (To-Do 6.8) be built before January 1? It's ranked SHOULD
   today. Without it, Step 5 is a manual spot check.
7. The payment-date fix (To-Do 6.7) is ranked MUST but not built. Until it is, is "enter payments
   before 6 PM Central" an acceptable rule for the office?

---

## 2. Emergency brake (16.6)

**Purpose:** when the pilot turns up a money, stock or compliance defect, stop only the affected
operation. That one job runs on numbered paper records until the fix ships, then the paper is entered
into CRX and checked. Everything else stays in CRX, and Chem Man is **not** restarted as a second
billing system (Mason, 2026-10-15).

**The app has no pause switch.** Pulling the brake means telling every affected person to stop
using one screen or one step, in writing, and switching that job to paper. **Draft suggestion:** if
Mason wants a real on/off switch, it is a code request, and it would need to be built and tested
before January.

**Who can pull the brake:** [OWNER: Mason to name], or the backup [OWNER: Mason to name]. **Draft
suggestion:** Mason, the named brake owner, and the senior developer during their launch-support
hours.

**Who releases it:** [OWNER: Mason to name]. **Draft suggestion:** Mason only.

### When to pull it

Pull the brake when one CRX operation is making records that are wrong in a way that costs money,
miscounts stock or breaks a compliance rule, **and** carrying on would make more wrong records
before a fix can ship. For example: payments landing on the wrong invoices, deliveries taking the
wrong stock, invoices posting at the wrong price, or a wrong regulated record (an RUP sale or an
application record).

Don't pull it for one wrong record that can be corrected, a slow screen, an email that failed, or a
problem with a known workaround. Those go to launch support (procedure 4). If the whole app is
down, use the outage fallback (procedure 3) instead.

### Steps to pull it

1. **Name the operation**, as narrowly as possible: for example "recording payments", "posting
   chemical invoices", "completing deliveries" or "receiving stock". Only that operation stops.
2. **Tell everyone affected**, in writing (**Draft suggestion:** a text to the staff group and a
   post on the in-app **Team Board**): which operation is paused, from what time, what to use
   instead, and who to call.
3. **Open the brake record** in the Pilot Difference Log: brake number, operation, time paused,
   who pulled it, the defect and the records already affected.
4. **Start the numbered paper records** for that operation (below). Don't keep using the CRX screen
   "just for this one".
5. **Get the fix going:** launch support writes up the defect, and the fix ships through the normal
   reviewed path. The 30-day pilot doesn't wait for it.
6. **Records made wrongly before the brake:** list them in the brake record. They are corrected
   during reconciliation (step 4 of "Steps to release it"), not on the spot.

### Numbered paper records

Each paused operation uses its own numbered form. **Draft suggestion:** pre-printed, numbered books
with a prefix per operation and brake, such as `B1-PAY-001`, `B1-PAY-002`. Never reuse or skip a
number; write VOID across a spoiled form and keep it.

| Paused operation | What each paper record must show |
|---|---|
| Recording payments | number, date received, customer, amount, check number or transfer reference, invoices it pays (and amounts), who received it |
| Completing deliveries | number, customer, delivery number if known, products and quantities, date, signer's printed name and signature, driver. Photograph it. (The Goal 5 signed paper ticket.) |
| Posting or creating invoices | number, customer, delivery or order it bills, lines, quantities, prices, total, who prepared it |
| Issuing credits or returns | number, customer, original invoice, products and quantities returned, reason, amount, who approved it |
| Receiving stock | number, supplier, PO number, products, quantities, package sizes, lot numbers, date, who received it |

Keep each operation's forms together in one folder, in number order.

### Steps to release it

1. The fix is live, and it was tested on staging (the test copy of CRX) before it shipped.
2. **Draft suggestion:** [OWNER: Mason to name] watches the first paper record go in and checks the
   result, before the rest are entered. Testing the fix on a real customer record any other way needs
   Mason's OK first.
3. **Enter the paper records** through the normal CRX screens, oldest number first. Put the
   paper number in the record's notes or reference box. Before entering one, check that customer's
   records for that number, so nothing goes in twice. Tick each form only after the entered record
   has been compared with the paper.
   - **Payments:** **Record Payments** stamps a payment with the server's date, not the day it was
     received (see the known gap in procedure 1, Step 4). Write the received date in **Notes**; it
     doesn't change the recorded date. The bookkeeper decides how that affects deposit matching and
     QuickBooks (question below).
   - **Deliveries:** the assigned driver completes each delivery from their own delivery screen. They
     tick **Customer signed a paper ticket (no signal at the site)**, add the photo of the signed
     ticket, type the signer's printed name from the ticket in the **Signed By** box, and enter
     **Delivered on (date on the ticket)**. The app never captures a signature after the fact.
4. **Correct the wrong records** listed when the brake was pulled, each through the normal screens
   (a posted invoice is corrected with a credit, never cancelled by a void).
5. **Reconcile:** count the paper forms against the entered records (every number entered once,
   VOIDs accounted for), then run the daily check (procedure 1) and confirm it's clean for the affected
   operation.
6. **Release:** [OWNER: Mason to name] tells everyone the operation is back in CRX, and closes the
   brake record with the release time, the count of forms entered and who checked them.
7. Store the paper forms. **Draft suggestion:** keep them with that month's records for the same
   period as the other billing records.

### Questions for Mason (emergency brake)

1. Who can pull the brake, and who releases it? (To-Do decision 5.)
2. Should anyone besides you be able to pull it, for example the senior developer, at night or on a
   weekend?
3. Is "a text plus a Team Board post" the right way to tell staff, or is there a better one?
4. Do you want a real on/off switch in the app for the riskiest operations (payments, posting,
   deliveries)? Today there isn't one; it would be a new build.
5. Pre-printed numbered books, or blank forms numbered by hand from a log?
6. Payments entered after the fact carry the entry date (and after 6 PM Central, the next day's).
   Is a note with the real date enough for the bookkeeper, or does Record Payments need a "date
   received" box before the pilot, alongside the To-Do 6.7 fix?
7. How long are the paper forms kept, and where?

---

## 3. Outage paper fallback (16.7)

**Purpose:** keep dispatch, delivery and payments going when CRX is down, then enter everything
afterwards with nothing lost and nothing entered twice. This expands the short version in
`docs/operations/production-runbook.md` section 4.8 (not yet rehearsed). Mason's recovery target
(2026-10-14): an outage may last overnight, and CRX is back by the next business morning.

**Who decides CRX is "down":** [OWNER: Mason to name]. **Draft suggestion:** when the app won't load
or save for 15 minutes for more than one person, and launch support (procedure 4) confirms it isn't one
phone or one computer.

**Who keeps the paper:** office: [OWNER: Mason to name]. Each driver keeps their own tickets.

### Before any outage: the outage kit

**Draft suggestion:** keep one outage kit in the office and one in each truck.

- **Office:** printed blank delivery tickets and payment log sheets (numbered), a pen, this page, and
  the phone list of drivers, the office and launch support.
- **Every evening before a delivery day:** print the next day's deliveries. On **Deliveries**, pick
  the next day's date, make sure **no deliveries are ticked** (the button reads **Load Sheet**, not
  **Load Sheet (3)**), and press it. With nothing ticked it prints every scheduled or in-progress
  delivery in the list, with each customer's contact, address and products (**Download PDF** prints
  only a one-line-per-delivery list). Check that the printout has as many deliveries as the screen.
  File it in the kit. This is the "last printed delivery schedule" the runbook relies on.
- **Each truck:** blank numbered delivery tickets. These are the same signed paper tickets Goal 5
  uses when there's no signal at a customer.

### During the outage

**Tell everyone:** [OWNER: Mason to name] tells staff and drivers that CRX is down, the time it
started, and that the paper fallback is on. **Draft suggestion:** a group text.

**Dispatch**
- Work from the last printed delivery schedule.
- Changes and new deliveries go to drivers by phone. The office writes each change on the printed
  schedule with the time and who was told.

**Deliveries**
- The driver fills in a numbered paper ticket at the customer: customer, products and quantities,
  date, the signer's printed name and signature. Then they photograph it.
- The customer keeps a copy if the ticket has one. **Draft suggestion:** two-part (carbon) tickets.
- If the product isn't on the printed schedule, write "NOT ON SCHEDULE" on the ticket, so the
  office knows to look for it in CRX afterwards.

**Payments**
- Write every check, cash payment and transfer on the numbered payment log: line number, customer,
  invoice numbers it pays, amount, date received, method and check number, who took it.
- **Draft suggestion:** photograph or copy each check and keep the copy with its log line. Then the
  check can be deposited as usual. Write the deposit date on each log line, so the log matches the
  deposit slip. The log and the copies, not the checks, are what get entered afterwards.
- A check that bounces, or a transfer that's returned, follows the payment steps in To-Do 14.5. Those
  steps aren't written yet.

**Don't** start a second record anywhere else (a spreadsheet, Chem Man, a notes app). The paper is
the one record until CRX is back.

### After CRX is back

1. **Launch support confirms CRX is working** (it loads and saves) before anyone enters paper.
2. **Enter oldest first**, using the normal screens. Before entering a record, check for its paper
   number so nothing goes in twice; put the paper number in the record's notes or reference box.
   Tick it on the paper only after the entered record has been compared with the paper.
   - **Dispatch changes:** update the deliveries in CRX to match the changes written on the schedule.
   - **Deliveries:** for a "NOT ON SCHEDULE" ticket, first search CRX for that customer's open
     orders and deliveries. A delivery missing from the printout may still exist in CRX. Use it if it
     does; create a new delivery only once you've confirmed there isn't one. Then the assigned driver
     completes each one from their own delivery screen. They tick **Customer signed a paper ticket
     (no signal at the site)**, add the ticket photo, type the signer's name in **Signed By**, and
     enter **Delivered on (date on the ticket)**.
   - **Payments:** enter each log line in **Record Payments**, with the check number in the
     reference box and the date received in **Notes**. The note doesn't change the recorded date;
     see the known gap in procedure 1, Step 4.
3. **Reconcile:** every ticket and log line is entered exactly once. Then run the daily check
   (procedure 1). If the outage needed a database restore, the runbook's after-restore checklist
   (section 4.7) also applies before anything resumes syncing.
4. **Log the outage** in the Pilot Difference Log: start and end times, how many tickets and payments
   were entered, who checked them, and any problems.

### Rehearsal (required before January)

The goals doc (Goal 6) requires this fallback to be **rehearsed**. **Draft suggestion:** in December,
on staging, run a pretend half-day outage. Dispatch from the printout, do two or three paper
deliveries and two payments, then enter them and reconcile. Time it, and record it in the runbook's
drill log (section 4.9).

### Questions for Mason (outage fallback)

1. Who declares an outage and tells staff? Who keeps the office paper? (To-Do decision 5.)
2. Is "down for 15 minutes for more than one person" the right trigger?
3. Do you want pre-printed, numbered carbon tickets and payment logs? Who orders them?
4. Who prints the next day's schedule each evening?
5. If the outage lasts past one business day, does anything change? For example, holding deliveries
   that aren't urgent.
6. When in December should the rehearsal happen, and who takes part?

---

## 4. Launch support (16.8)

**Purpose:** during the pilot, every staff member knows where to report a problem, someone answers
within a set time, and the serious problems reach the person who can pull the emergency brake.

**Who answers:** first contact: [OWNER: Mason to name]. Backup: [OWNER: Mason to name]. Technical
escalation: the senior developer ([OWNER: Mason to name], To-Do 16.2), with the agents working the
fix through the normal reviewed path.

**Hours covered:** **Draft suggestion:** office hours, plus a phone number for "can't deliver" or
"can't take payment" problems on delivery days.

### Where to report

**Draft suggestion:** one place for everything, so nothing is lost:

- **Urgent** (can't deliver, can't take a payment, CRX is down, money or stock looks wrong, or an RUP
  sale or application record looks wrong):
  **call or text** [OWNER: Mason to name] at [phone number].
- **Not urgent:** post on the in-app **Team Board**. **Draft suggestion:** also keep a shared
  issue log.
- Every report says: who, when, which screen, which customer or record number, what you expected
  and what happened. Add a screenshot or a photo of the screen if you can.

### What to do for each kind of problem

The response times are **draft suggestions** for Mason to set.

| Problem | Staff do this first | Who answers | Answer within | Pull the brake? |
|---|---|---|---|---|
| **CRX is down** (won't load or save for several people) | Switch to the outage paper fallback (procedure 3). Call. | First contact, then the senior developer. Runbook section 6.1. | 15 minutes | No: it's an outage (procedure 3). |
| **App error on one screen** (an error message, a blank screen) | Screenshot it, try once more, then report. Don't keep retrying a save. Always report it, even if you think it was logged. | First contact, who also checks the error tracker (Sentry, runbook section 6.1). | 1 business hour | Only if it stops a money or stock job and there's no workaround. |
| **No signal at a customer** | Use the signed paper ticket (Goal 5) and complete the delivery when back in signal. | Nobody needs to answer: it's the normal process. | n/a | No |
| **Email didn't go out** (invoice, receipt) | The app tells the driver when a receipt didn't send; the office resends it. Report it if resending fails. | First contact. Runbook section 6.2. | Same business day | No |
| **Stuck bill** (an invoice won't post, a delivery has no draft invoice, a bill shows the wrong amount) | Don't post it again, and don't change it by hand. Report the invoice number. | First contact, with the bookkeeper. | 2 business hours | Yes, if the same wrong price or amount keeps happening on new bills. |
| **Payment problem** (a payment applied to the wrong invoice, a balance that looks wrong) | Stop and report the payment and invoice numbers. | First contact, with the bookkeeper. | 2 business hours | Yes, as soon as it looks like the next payment will go wrong too (procedure 2, "When to pull it"). |
| **QuickBooks sync failure** or a hand-entry gap | Report it. Don't re-enter or re-send anything in QuickBooks. | The bookkeeper, then first contact. | Same business day | Only if the books can't be kept straight by hand. |
| **Stock difference** (a count doesn't match, new negative stock) | Recount once, then report the product, location and both numbers. | [OWNER: Mason to name]. Mason owns inventory (goals doc, decision 6h). | Same business day | Yes, if deliveries or receiving keep moving the wrong stock. |
| **Compliance problem** (an RUP sale or application record looks wrong) | Stop that sale or record and call or text (urgent). | [OWNER: Mason to name]. Mason owns compliance (goals doc, decision 6h). | 1 business hour | Yes, if the app keeps making the wrong regulated record. |
| **Difference found by the daily check** | Logged in the Pilot Difference Log (procedure 1). | Daily check owner, with first contact. | Same business day | Yes, if it comes from an app defect that keeps making wrong money, stock or compliance records. |

### When to pull the emergency brake

First contact brings it to whoever can pull the brake (procedure 2) as soon as a problem is all of
these:

- it makes wrong **money**, **stock** or **compliance** records, not just a slow or awkward
  screen;
- it will keep happening as staff carry on, not a one-off that can be corrected;
- there's no safe workaround inside CRX.

If unsure, call. Pausing one operation for an hour costs less than a day of wrong bills.

### Closing a report

Every report is closed with what was wrong, what was done, and whether it needs an app fix. App
fixes are tracked through to their PR. **Draft suggestion:** Mason reads the open reports each day
with the daily check.

### Questions for Mason (launch support)

1. Who is the first contact, who is the backup, and what phone number do staff call? (To-Do decision 5.)
2. Is the senior developer on call during the pilot, and for which hours? (To-Do 16.2, open question 6d.)
3. Are the response times in the table right?
4. Which hours are covered: office hours only, or also early mornings and Saturdays on delivery days?
5. Team Board plus a shared issue log, or one place only?
6. Should the bookkeeper be the first contact for QuickBooks and payment problems instead of the
   general first contact?
