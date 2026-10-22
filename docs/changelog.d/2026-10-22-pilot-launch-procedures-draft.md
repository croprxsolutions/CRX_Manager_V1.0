## 2026-10-22 — First drafts of the four pilot launch procedures (To-Do 16.5–16.8)

- New `docs/plans/2026-10-22-pilot-launch-procedures-draft.md` holds first drafts, for Mason to
  correct, of the daily pilot check (16.5), the emergency brake (16.6), the outage paper fallback
  (16.7) and launch support (16.8). Each names the real CRX screens staff use (Data Integrity
  Report and Cleanup tabs, A/R Workspace, Prepay, Record Payments, Deliveries' Load Sheet and the
  Goal 5 paper-ticket completion). Every role still to be chosen is an "[OWNER: Mason to name]"
  placeholder (To-Do decision 5 is open); Mason is named only where the goals doc already records
  him (owner of inventory and compliance, decision 6h). Each procedure ends with the questions Mason
  must answer.
- Facts the drafts surface: the app has no on/off switch for one operation, so the brake is a
  written staff instruction; **Record Payments** has no "date received" box and stamps the server's
  UTC date, so a payment entered after 6 PM Central lands on the next day (To-Do 6.7, open); the
  Integrity Report shows at most 50 records per check; the Cleanup tab's unbilled-deliveries list is
  historical, so yesterday's deliveries are checked directly; the prepay balance check (To-Do 6.8)
  and the QuickBooks sync or hand-entry report (14.2 / 14.3) don't exist yet, so those steps are
  manual or placeholders.
- One Luna accuracy round checked the drafts against the app source (22 findings); each was checked
  against the code and fixed. Two were partly refuted: a check's `[ERROR: …]` marker does exist
  (`src/lib/reconciliation.ts`), and Mason's ownership of inventory and compliance is a recorded
  decision.
- Codex GitHub App review fix: **Payment History** neither shows nor searches a payment's Notes
  (`src/pages/PaymentHistory.tsx`), so the drafts no longer rely on Notes. The paper number goes in
  Record Payments' **Reference #** box next to the check number (it shows and searches that box), and
  the real received date stays on the paper form.
- Second Codex GitHub App round (four findings, all confirmed in the code and fixed). The A/R strip is
  a live snapshot, so the daily check records it before the day's money activity. The Deliveries
  screen filters by scheduled date, so yesterday's completions come from Export CSV's Completed column.
  CRX can't search a paper ticket number, so an outage ticket list guards against double entry.
  **New Delivery** needs an existing order, so a phone order taken during an outage is entered as an
  order first.
- Third Codex GitHub App round (four findings, all confirmed and fixed). The daily check runs every
  calendar day, because the integrity screens and A/R strip keep no history. The invoice list shows
  only the invoice date, not the posting date, so posted invoices are written on a posting list (and
  a question asks Mason about a posting-date filter). The sheet records counts and totals for the
  QuickBooks comparison. Pausing invoice creation also pauses delivery completion, which creates
  invoices automatically.
- Fourth Codex GitHub App round (three findings, all confirmed and fixed). The A/R equation and the
  sheet include write-offs, which CRX shows only per invoice, so they go on the posting list. Brake
  payment forms record the method (Record Payments starts on "Check"). Return forms record each
  item's condition and whether it is restocked.
- Fifth Codex GitHub App round (four findings, all confirmed). Fixed by closing the two underlying
  gaps throughout, not case by case. A hand-kept **Daily Money Activity List** records every money
  event CRX can't list by date (postings, write-offs, credit and prepay applications and reversals,
  payment voids); the A/R equation includes voids and reversals; and question 9 asks Mason about a
  dated report to replace the list. Every brake operation keeps a **form list** mapping paper numbers
  to CRX record numbers, because only payments can be searched by a paper number. Payment forms and
  the outage log record the amount for each invoice and any prepay remainder.
- Sixth Codex GitHub App round (three findings, all confirmed). The Daily Money Activity List now
  also covers unposting and voiding invoices and issuing credits (Returns shows only the requested
  date), plus a catch-all for any other balance change. A December 31 snapshot of the four A/R
  numbers is the starting point for the first daily check.
- Seventh Codex GitHub App round (two findings, both confirmed). Brake invoice forms record the
  invoice date and terms; receiving forms record the storage location and each item's condition. A
  general rule now says each paper form copies every field of its CRX screen, especially fields CRX
  fills in by default, and the December rehearsal checks each form against its screen.
- The drafts live in `docs/plans/` rather than `docs/operations/`, like the Goal 6 restore
  procedure draft: they move into `docs/operations/production-runbook.md` once approved and
  rehearsed.
- `docs/manual/TO_DO_LIST.md` rows 16.5–16.8 now read "Draft written, awaiting Mason".
- Documentation only; no app or database change.
