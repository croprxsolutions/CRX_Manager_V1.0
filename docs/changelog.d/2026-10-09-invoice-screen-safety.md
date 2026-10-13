## 2026-10-09 - New field-application invoices: no false "Unsaved Changes" box, no duplicate after Stay

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
- Once the create has answered, the page writes the created invoice's id into its address
  (`/invoices/field-app/new?created=<id>`, same page, typed values kept). A **refresh** (or Back)
  of that address opens the **already-created invoice** with a note to re-enter anything that did
  not save, instead of a blank form whose Save would create a second invoice (CodeRabbit on
  PR #893). It opens whatever its status: a posted or returned-to-scheduling invoice is proof the
  create happened (Codex Sol 6.1 on PR #893). The page never saves onto that invoice from a form
  it did not load (a save replaces the invoice's lines): if the user chose Stay while it opened,
  Save waits and a box at the top links to it (Codex Sol on PR #893).
- If the address names an invoice this page cannot open (deleted since, someone else's, another
  kind, or not found), the page does **not** quietly become a new invoice: a box explains, and
  Save waits until the user presses **Start a new invoice instead** (typed values kept). If the
  check cannot run, Save refuses until a reload; Save also waits while the check runs.
- Pressing **New** starts a genuinely new, blank page; Back/Forward between two such pages opens
  the right invoice; a Save still running when the user presses New finishes its writes but no
  longer pulls them back to the old invoice.
- Two Save clicks before the page redraws send one save, not two.
- If the billing details step fails and the user changes a billing value before saving again,
  the retry uses a new repeat-protection key, so the change is written instead of the server
  answering with its first result; an unchanged retry keeps the key (Codex Sol on PR #893).
- If the page cannot tell which customer each saved invoice belongs to, it no longer writes the
  billing details with zero discounts while reporting success: it says the billing details did
  not save and keeps the form unsaved (Codex Sol 6.1 on PR #893).
- Deleting a field-application invoice, or transferring it back to scheduling, also leaves the
  page without a false "Unsaved Changes" prompt.

### Removed before landing: the "lost reply" recovery

Earlier heads of #893 also tried to stop a duplicate when the database created the invoice but
its reply was lost and the page was then refreshed: a draft tag in the address keyed the create,
and a reopened draft searched the user's recent invoices. Codex Sol blocked that four times in a
row, each time on a new edge case of the same guess (time windows, a capped search, a clock
running fast). A design review by Codex Sol 6.1 (2026-10-12) confirmed a screen cannot settle it
and recommended a permanent database record of each create request. That is planned as its own
change after admin-only invoicing (it has to build on that migration's version of
`save_field_app_invoice`), so this PR ships without the draft tag and the search.

### Not in this change

The regular invoice editor (chemical sales, misc charges, job/blend field invoices) can still
Post with unsaved edits on screen: it posts the saved amounts, exactly as before. That fix moved
to the admin-only invoicing change, together with a server-side check that the invoice was not
changed between review and posting (Codex Sol HIGH on PR #892, 2026-10-09: a check in the browser
cannot bind what `post_invoice` posts). Tracked OPEN in `docs/manual/KNOWN_ISSUES.md`.

### Proof

- `src/pages/FieldApplicationInvoice.saveNavigation.test.tsx` runs the real router, the real
  route wrapper and the real leave-page guard (only the database, sign-in and toasts are
  mocked). Its tests cover: no false prompt; Stay then Save updating the created invoice; the
  created id in the address with typed values kept; a refresh opening the created invoice (draft,
  unposted, posted, cancelled, created days ago, any UUID version); four kinds of address that
  must wait for "Start a new invoice instead"; typing while the check runs; a failed or running
  check refusing Save; New and Back/Forward; a Save left behind by New; two quick Save clicks; the
  billing key; and the billing customer lookup failing or coming back short.
- The four 2026-10-13 fixes (posted opens, unopenable address waits, two clicks send one save,
  billing lookup refuses) were each broken on purpose and their tests failed, then restored.
- Earlier rounds (Luna 3 to 8, CodeRabbit, Codex Sol) each added tests that failed against the
  commit before their fix.

### Known gaps (not fixed in this change)

- **Lost reply, then refresh, then re-type: still a second invoice, exactly as on main.** If the
  database creates the invoice but the reply never reaches the browser and the page is refreshed,
  the address has no created id, the typed form is gone, and saving the re-typed form creates a
  second invoice. Planned fix: the permanent create-request record above (Codex Sol 6.1 design,
  2026-10-12).
- **A retry after an unknown outcome, with changed values, on the same page.** If a Save gets no
  answer and the user changes the locations or chemicals before pressing Save again, the
  database may answer with the first attempt's result (same repeat-protection key), and the new
  values in those fields are not applied, while the later steps save the current billing and
  applied info. This is how main behaves today; the planned create-request record covers it for
  new invoices.
- **The billing key is protected by the screen only.** The server does not check that a reused
  key carries the same values, and a delayed older billing write could still land after a newer
  one.
- **One Save is several separate writes** (invoice, applied info, billing details, override
  note); a failure part way is reported and the form stays unsaved, but the steps are not one
  transaction.
- **A partly-failed first save** keeps some checks (season date guard, split preview) behaving
  as if the invoice were new until the page moves to the saved invoice (the server still refuses
  a filed-season change).
- **New pressed during a Save can be dropped** if the Save finishes while the "Unsaved Changes"
  box is open; nothing is duplicated or lost; press New again (Luna round 7, MED, accepted).
- **Re-typing the same application on a fresh page** creates another invoice; a screen cannot
  tell a re-typed application from a new one.

### Not verified here

- Not clicked through in a signed-in browser against live data.
