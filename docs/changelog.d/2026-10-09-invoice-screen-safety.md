## 2026-10-09 - New field-application invoices: no false "Unsaved Changes" box, no duplicate invoice

App-only; no database change. Delivered as PR #893, which replaced PR #892 with the same code
(CodeRabbit kept a stale "changes requested" on #892). The invoice-list half of the original
change (last season's open invoices back on the lists) shipped separately in PR #895; see
`2026-10-12-invoice-lists-season.md`.

### Saving a new field-application invoice

**What staff will notice:** after the first Save of a new field-application invoice, the page now
goes straight to the saved invoice. Before, an "Unsaved Changes" box appeared even though the save
had worked, and choosing **Stay** then **Save** created a **second, duplicate** invoice.

- A fully successful save moves to the saved invoice with no prompt.
- If part of the save fails (for example the billing details), the form keeps your typed values
  and the prompt still appears, as before. Choosing Stay and saving again now **updates the
  invoice that was already created** instead of creating another one.
- If the page is **refreshed** (or reached again with Back) after that first Save created the
  invoice, it now opens the **already-created invoice** with a note to re-enter anything that did
  not save, instead of a blank new form whose Save would create a second invoice (CodeRabbit on
  PR #893). The first Save writes the created invoice's id into the page address
  (`/invoices/field-app/new?created=<id>`, same page, typed values kept), so nothing is stored in
  the browser. Pressing **New** there starts a genuinely new, blank invoice, and Back/Forward
  between two such drafts opens the right one. Before opening an invoice named in the address,
  the page checks it is still a field-application invoice (draft or unposted) that the same
  user created, with no time limit, so a late refresh can never lead to a duplicate. A link
  naming anything else (no such invoice, someone else's, a posted one, another kind) is
  ignored and the page stays a new invoice; a link to the user's own unposted field invoice
  simply opens it, like opening it from the list. If something was typed while the check ran,
  the usual "Unsaved Changes" box asks before the page moves; if the user stays, the page never
  saves over that invoice (its form was not loaded here, and a save replaces the invoice's lines):
  Save waits and a box at the top links to it (Codex Sol on PR #893). If the check cannot run, the page
  stays where it is and Save refuses until a reload, so there is neither a duplicate nor an
  unchecked invoice; Save also waits while the check runs. A Save still running when the user
  presses New finishes its writes but no longer pulls them back to the old invoice.
- If the database created the invoice but its reply was lost (a network blip) and the page is
  then refreshed, saving again no longer creates a second invoice (CodeRabbit on PR #893, second
  review). Just before the first Save sends its create, the page writes a draft tag into its
  address (`?draft=<tag>`); the create's repeat-protection key is built from that tag and the
  user. New starts a new draft with a new tag.
- The database keeps the answer for that key only 24 hours, and it repeats the FIRST
  submission, not what was re-typed after the refresh (Codex review on PR #893: P1 and P2; the
  24-hour expiry was confirmed read-only on the live database, 2026-10-12). So a page reopened at
  a draft address no longer saves blind. It first looks for field-application invoices this user
  created since the draft started (the draft tag carries its start time; the search allows an
  hour for a computer clock running fast). If there are any, a box at the top lists them with
  links, and Save waits until the user opens one or presses **Start a new invoice instead**
  (which starts a new draft, keeping what was typed). The search runs again right before the
  create, once the earlier create has certainly finished (the database stops a signed-in request
  after 8 seconds; the page waits two minutes from the first Save, and says so if Save is pressed
  sooner). Nothing found then means the earlier Save saved nothing, so the same draft key holds
  no stored answer and the create saves what is on screen (Codex Sol on PR #893). Deleted
  invoices count in the search too. If the search cannot run, Save refuses. **Start a new invoice
  instead** follows the same rule: it waits out the two minutes, searches again, and if an
  invoice appeared that was not in the list it shows the new list and asks once more (Codex Sol on
  PR #893: an unrelated invoice in the list must not let a second create race the first).
- If the billing details step fails after the invoice was created and the user changes a
  billing value (discount, PO, terms, notes) before saving again, the retry now uses a new
  repeat-protection key, so the change is written instead of the server answering with its first
  result. An unchanged retry keeps the same key, so a first attempt that did land is not applied
  twice (Codex Sol on PR #893).
- Deleting a field-application invoice, or transferring it back to scheduling, also leaves the
  page without a false "Unsaved Changes" prompt.

### Not in this change

The regular invoice editor (chemical sales, misc charges, job/blend field invoices) can still
Post with unsaved edits on screen: it posts the saved amounts, exactly as before. That fix moved
to the admin-only invoicing change, together with a server-side check that the invoice was not
changed between review and posting (Codex Sol HIGH on PR #892, 2026-10-09: a check in the browser
cannot bind what `post_invoice` posts). Tracked OPEN in `docs/manual/KNOWN_ISSUES.md`.

### Proof

- `src/pages/FieldApplicationInvoice.saveNavigation.test.tsx` runs the real router, the real
  route wrapper and the real leave-page guard (only the database, sign-in and toasts are
  mocked). Each new test was run first against the code before its fix, where it failed.
- Refresh fix (CodeRabbit, PR #893): tests cover the first Save writing the created id into the
  address while keeping the typed values; a refresh of that address opening the created invoice
  with no second create; an address whose id is not an invoice id staying a new invoice; and New
  pressed on that address starting a genuinely new invoice. They failed against f1b415fe3. A
  first version kept the id in the browser tab's storage instead; two Luna rounds found it could
  be lost or outlive its draft, so it was replaced by the address.
- Luna rounds 3 to 8 (rounds 4, 7 and 8 had no BLOCKER/HIGH) added tests for Back between two
  drafts, five kinds of address that must be ignored, a failed check refusing Save, Save waiting
  while the check runs, a Save left behind by New not moving the user, any UUID version
  accepted, the check's move asking before leaving, the route wrapper giving a fresh page on New
  (PUSH) and Back/Forward (POP) while keeping it for the page's own REPLACE rewrites, and a
  rejected address dropping its draft tag. Each failed against the commit before its fix
  (877163547, 608f5dd5d, eb84edea4, fb788f29d).
- CodeRabbit's second review (head eb1200120): three tests for the draft tag (written before the
  create is sent and used for its key; a refresh at the draft address reusing the key; New
  giving a new key) failed against eb1200120.
- Codex review of 585b34f74 (P1: the stored answer expires after 24 hours; P2: a replay keeps
  the first submission): three new page tests (an invoice created two days earlier is listed and
  Save waits, then "Start a new invoice instead" creates under a new draft; Save refuses when the
  check cannot run; a new draft tag carries its start time) failed against 585b34f74; unit tests
  in `src/lib/fieldAppNewInvoiceAddress.test.ts` cover the draft tag's time.
- Codex Sol on d5e4568d9 (HIGH: a billing retry with changed values replayed the first result;
  HIGH: a reload while the first create was still running could replay the first submission):
  three new tests (a billing retry with changed values gets a new key and an unchanged one keeps
  it; Save waits while the earlier create may still be running; an invoice found by the search
  right before saving stops the create) failed against d5e4568d9.
- Codex Sol on cd9a1f46b (HIGH: after Stay, Save updated the address's invoice from a partly
  re-typed form): the test that expected that update now expects Save to wait with a link to the
  invoice; it failed against cd9a1f46b.
- Codex Sol on 06622fe1f (HIGH: "Start a new invoice instead" skipped the two-minute wait): two
  new tests (the button waits while the first create may be running; it searches again and shows
  an invoice that appeared since) failed against 06622fe1f.
- After merging main (with #895) on 2026-10-12: typecheck, lint and the full Vitest suite pass.

### Known gaps and deferred items (not fixed in this change)

- **A partly-failed first save of a new field-application invoice.** If the first Save creates the
  invoice but a later step fails (for example the billing details), the page keeps a link to the
  invoice it created and a second Save updates it (a refresh opens that invoice instead). But
  some checks (season date guard, split preview, billing key) still behave as if the invoice were
  new until the page moves to the saved invoice (the server still refuses a filed-season change).
- **Leaving while the first Save is still running, then re-typing it.** If someone presses Save
  on a new field-application invoice, leaves for another page before it finishes, and later
  types the same application into a fresh New page, that Save creates a second invoice, as it
  does on main today. A screen cannot tell a re-typed application from a new one; the real guard
  would be a database rule (for example one draft invoice per field application).
- **New pressed during a Save can be dropped.** If someone presses New while a new invoice's
  first Save is running and the Save finishes while the "Unsaved Changes" box is still open,
  the New press can be lost and the page goes on to the saved invoice. Nothing is duplicated
  or lost; press New again. (Luna round 7, MED, accepted.)
- **A different sign-in while the page stays open is not re-checked by the page.** Signing out
  sends the browser to the login page, which closes this page; the database decides who may
  edit an invoice either way.

### Not verified here

- Not clicked through in a signed-in browser against live data: a new field-app Save landing on
  the saved invoice, and a refresh at a draft address showing the list of recent invoices.
