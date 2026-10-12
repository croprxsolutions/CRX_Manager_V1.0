## 2026-10-09 - Invoice screens: last season's open invoices are back, and no duplicate field-application invoices

Two fixes to the invoice screens. Both are app-only; no database change.

Delivered as PR #893, which replaces PR #892 with the same code. CodeRabbit kept a stale "changes
requested" on #892 after the requested doc fix landed, and would not re-review a commit it had
already reviewed.

### 1. Last season's open invoices show again on the invoice lists

**What staff will notice:** since October 1, the Chemical Sales invoice list and the Field
Invoices tabs (Drafts, Posted, All Invoices, and the tab counts) were empty of last season's
work. Every invoice from before October 1 that was still a draft, unposted, posted-but-unpaid or
overdue had disappeared. They are back on the lists. The bulk actions (Post All, Unpost All,
Select All) still act on this season's invoices only; an older one is handled one at a time (see
below).

- An **open** invoice (draft, unposted, posted, overdue) now shows on these lists whatever
  season it belongs to. A small **"Season 2026"** tag next to its date marks an invoice from an
  earlier season.
- A **closed** invoice (paid, voided, cancelled) still shows only for the current season, as
  before.
- The server posting step (`post_invoice` / `post_invoice_group`) does **not** check the
  invoice's season. It **does** refuse an invoice dated in a closed accounting period
  (`check_period_open`, run inside `_post_invoice_impl_20260714` and, for every group member,
  `_post_invoice_group_customer_scope_impl`; live read of the function bodies, 2026-10-09). All
  9 live accounting periods are open today, so nothing is refused yet. Because nothing stops a
  last-season invoice posting into its own invoice-date month (for example August), the bulk
  actions leave other-season invoices out by default:
  - **Post All** on the Drafts tab posts only **this season's** invoices. Last season's
    unposted invoices are listed (with their season tag) and counted in the totals, but Post All
    leaves them out and its confirm says how many; post each one from its own invoice page. A
    split group is left out if **any** of its members is from another season, including a member
    hidden by the current filters (the group post would post it too).
  - **Unpost All** on the Posted tab, in the default "This Season + older unpaid" scope, still
    reverses only **this season's** posted invoices, as it did before. Older unpaid invoices are
    listed but left out (the confirm and the footer say how many); to unpost one, choose its
    month batch in Scope. Month batches from an earlier season are marked "unpaid only", because
    paid invoices from that season are not on this list. The "spans more than one month-end
    batch" warning now looks at what Unpost All would change, not at every row shown.
  - On the Chemical Sales list, **Select All** picks only this season's invoices, so one Select
    All + Post / Void / Delete cannot reach last season's work. An older invoice can still be
    ticked by hand (it shows a "Season N" tag); if one is selected, the Post confirm says how
    many are not from this season. The button goes by **which** invoices are ticked, not how
    many: it reads **Select All** until every this-season invoice in view is ticked, then
    **Deselect All** (which clears everything, including hand-ticked older ones). When every
    invoice in view is from an older season, Select All is greyed out instead of silently doing
    nothing.
  - The Chemical Sales bulk buttons (Post / Void / Print / Delete and their counts) only ever act on ticked invoices that are on screen right now: a ticked invoice that a filter or the search box hides, or that the list no longer loads, is dropped from the selection, **Select All** replaces the selection with exactly this season's invoices in view (it no longer keeps rows ticked earlier), and **Clear selection** shows whenever anything on screen is ticked.
  - An invoice with no season, or a later season, counts as "not this season" for these actions.
    An invoice with no season shows a **"Season unknown"** tag, so it is never an untagged row
    that the bulk actions quietly skip. (The live `invoices.season` column cannot be empty today;
    this only matters if that ever changes.)
- The Posted tab's **Print Invoice Report** PDF now names its scope in the subtitle (for example
  "This season + older seasons' unpaid invoices", or "June 2026 batch — unpaid invoices only"),
  so a printed total says what it covers.
- The Chemical Sales **Posted Total** and **Outstanding** cards now count overdue invoices too
  (an overdue invoice is a posted invoice past its due date; before, the two live overdue
  invoices were listed but left out of both totals). A note under the cards says older open
  invoices are included.
- The Posted tab's scope menu now reads "This Season + older unpaid", and the All Invoices tab
  says it also shows older unposted or unpaid invoices.

Live check (read-only, 2026-10-09): 12 open invoices exist, all from before October 1
(11 chemical sale, 1 unposted field invoice). The old list filters showed **0** of them; the new
filters show **all 12**. The one paid invoice from last season stays hidden, as intended.

### 2. Saving a new field-application invoice no longer shows a false "Unsaved Changes" box

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
  the usual "Unsaved Changes" box asks before the page moves. If the check cannot run, the page
  stays where it is and Save refuses until a reload, so there is neither a duplicate nor an
  unchecked invoice; Save also waits while the check runs. A Save still running when the user
  presses New finishes its writes but no longer pulls them back to the old invoice.
- If the database created the invoice but its reply was lost (a network blip) and the page is
  then refreshed, saving again no longer creates a second invoice (CodeRabbit on PR #893, second
  review). Just before the first Save sends its create, the page writes a draft tag into its
  address (`?draft=<tag>`); the create's repeat-protection key is built from that tag and the
  user, so a Save from the refreshed page sends the same key and the database answers with the
  invoice it already created. New starts a new draft with a new tag.
- Deleting a field-application invoice, or transferring it back to scheduling, also leaves the
  page without a false "Unsaved Changes" prompt.

### Not in this change

The regular invoice editor (chemical sales, misc charges, job/blend field invoices) can still
Post with unsaved edits on screen: it posts the saved amounts, exactly as before. That fix moved
to the admin-only invoicing change, together with a server-side check that the invoice was not
changed between review and posting (Codex Sol HIGH on PR #892, 2026-10-09: a check in the browser
cannot bind what `post_invoice` posts). Tracked OPEN in `docs/manual/KNOWN_ISSUES.md`.

### Proof

- New component tests, each run first against the unfixed code (where they failed for the
  reason described above) and then against the fix (where they pass):
  `src/pages/Invoices.seasonWindow.test.tsx`,
  `src/components/field-invoices/FieldInvoicesSeasonWindow.test.tsx`,
  `src/pages/FieldApplicationInvoice.saveNavigation.test.tsx` (real router and real leave-page
  guard). The list tests apply the pages' real filters to an in-memory set of invoices, so they
  show which rows the queries actually return.
- The new list filter was sent to the live API read-only with the public key. It got past the
  filter parser (it stopped at the permission check), while a deliberately broken filter was
  rejected by the parser. So the filter syntax is valid on the real server.
- Review round 1 added tests for: the Post All earlier-season notice, Unpost All's this-season
  default, and overdue invoices in the Chemical Sales cards.
- Review round 2 added tests for: Post All leaving last season's invoices out and posting only
  this season's; Post All skipping a split group whose last-season member is hidden by a date
  filter; Chemical Sales Select All picking only this season (and the Post confirm naming a
  hand-ticked older invoice); plus unit tests for the season filter and the season labels. The
  Select All test was run against the round-1 code and failed there.
- Final fix round added tests for: Select All with an older invoice ticked by hand (now: selects
  exactly this season's invoices in view, see the selection fix below), Deselect All clearing a mix of this-season and older invoices,
  Clear selection, Select All greyed out when only older or unknown-season invoices are in view,
  and the "Season unknown" tag. Each was run against the round-2 code and failed there.
- Selection fix (after the final review) added tests for: a row ticked and then hidden by a
  filter not being carried into Select All + Post; a selection left under a filter with no
  selectable rows being dropped (no Print / Post button acting on it); the same for a row hidden
  by the search box; Clear selection shown
  alongside Deselect All; and a failed post re-selecting an invoice the reload no longer returns
  (it is dropped from the counts). Each was run against the previous commit (2e185c34b) and
  failed there.
- Refresh fix (CodeRabbit, PR #893): `FieldApplicationInvoice.saveNavigation.test.tsx` now runs
  the real route wrapper and also covers: the first Save writing the created id into the address
  while keeping the typed values; a refresh of that address opening the created invoice with no
  second create; an address whose id is not an invoice id staying a new invoice; and New pressed
  on that address starting a genuinely new invoice. The three new behaviour tests failed against
  the previous commit (f1b415fe3); the New test also fails with only the route-wrapper change
  undone. A first version kept the id in the browser tab's storage instead; two Luna rounds
  found it could be lost (a redirect stopped by the leave-page prompt, React's development
  double-run) or outlive its draft (leaving to another site and coming back), so it was replaced
  by the address. A third Luna round on the address version found Back/Forward between two
  drafts kept the wrong page, and any well-formed id redirected; fixed with tests for Back
  between two drafts, five kinds of address that must be ignored, and a failed check. Those
  seven tests failed against the previous commit (877163547). The "New" test drives the plain
  /new navigation the top-bar and Field Invoices New buttons perform; this page has no New
  button of its own. A fourth Luna round (no BLOCKER/HIGH) led to: the failed check refusing
  Save instead of opening the invoice, Save's wait decided from the address itself, a Save left
  behind by New not moving the user, any UUID version accepted, and future-dated drafts
  rejected; four new tests failed against 608f5dd5d. Not changed: the redirect tests land on a
  stand-in for the invoice page; loading an existing invoice is covered by
  `FieldApplicationInvoice.test.tsx`. A fifth Luna round found the one-day limit could itself
  cause a duplicate after a late refresh, and that the check's move skipped the leave-page
  prompt: the time limit is gone (the check is owner, kind and unposted status), the move asks
  as usual, and the route wrapper keeps the page for the page's own address rewrites (REPLACE)
  while New (PUSH) and Back/Forward (POP) get a fresh page. Three new tests failed against
  eb84edea4. Accepted: a hand-made link to the user's own unposted field invoice opens it.
  A sixth Luna round: New pressed while the first Save was still creating the invoice kept the
  same page; the route wrapper now gives a fresh page on every New (PUSH) or Back/Forward (POP)
  arrival and keeps it only for the page's own REPLACE address rewrites (new test failed with the
  previous wrapper). Two items are recorded below as known gaps, not fixed here.
  CodeRabbit's second review (head eb1200120): a lost create reply followed by a refresh could
  still duplicate. Fixed with the draft tag; three new tests (draft written before the create is
  sent and used for its key; a refresh at the draft address reusing the key; New giving a new
  key) failed against eb1200120. The invoice-list half of this PR moved to its own PR (#895) on
  2026-10-12 so it is not held up by this page. Luna round 8 (no BLOCKER/HIGH): a rejected
  address now also drops its draft tag (new test failed against fb788f29d), and the "page was
  left" flag is cleared in the same commit that removes the page (a layout effect). Not
  changed: the lost-reply test proves the page re-sends the same key; the database's replay of
  a stored answer for a repeated key is existing `save_field_app_invoice` behaviour.
- After the split (the invoice-editor Post changes taken out), typecheck, lint, the fix-1 and
  fix-2 test files, the full Vitest suite, the production build and the doc-drift check pass.

### Known gaps and deferred items (not fixed in this change)

In plain English, everything the review rounds found that this change deliberately does not fix:

- **"This season" comes from the computer's clock.** Which invoices get a season tag and which ones
  the bulk actions (Post All, Unpost All, Select All) leave out depends on the date on the
  person's computer, not the server. A wrong computer date around October 1 would treat last
  season's invoices as this season's, or the reverse. Also, invoices created through paths that
  use the database's default season are stamped from UTC time, so for about five hours on each
  September 30 evening a new invoice is stamped "next season" and the bulk actions skip it until
  midnight Chicago time.
- **Lists still stop at 2,000 rows, newest first.** The lists now include older open invoices, so
  if a list ever reaches its 2,000-row cap, the oldest still-open invoices are the first to be cut
  off — the original bug again, for exactly those rows. A message appears when the cap is hit.
  Not reachable at today's volume.
- **The Orders list is still limited to this season.** `src/pages/Orders.tsx` uses the same
  current-season-only filter the invoice lists used to, so last season's open orders (20 at the
  time of the review) are hidden from it.
- **Split-group season check looks at the selected rows.** On the Chemical Sales list, batch Post
  checks the season of the selected rows only, while posting a split group posts every member
  (including one from another season). Theoretical today: there are no live split groups, and a
  database rule keeps split members in the same season.
- **A partly-failed first save of a new field-application invoice.** If the first Save creates the
  invoice but a later step fails (for example the billing details), the page keeps a link to the
  invoice it created and a second Save updates it (a refresh opens that invoice instead). But
  some checks (season date guard, split preview, billing key) still behave as if the invoice were
  new until the page moves to the saved invoice (the server still refuses a filed-season change).
- **Leaving while the first Save is still running, then re-typing it.** If someone presses Save
  on a new field-application invoice, leaves for another page before it finishes, and later
  types the same application into a fresh New page, that Save creates a second invoice — as it
  does on main today. The first Save's "Invoice created" message still appears. A screen cannot
  tell a re-typed application from a new one; the real guard would be a database rule (for
  example one draft invoice per field application), which is not part of this change.
- **New pressed during a Save can be dropped.** If someone presses New while a new invoice's
  first Save is running and the Save finishes while the "Unsaved Changes" box is still open,
  the New press can be lost and the page goes on to the saved invoice. Nothing is duplicated
  or lost; press New again. (Luna round 7, MED, accepted.)
- **A different sign-in while the page stays open is not re-checked by the page.** Signing out
  sends the browser to the login page, which closes this page; the database decides who may
  edit an invoice either way.
- **Post All on the Drafts tab never includes older-season invoices.** Last season's unposted
  field invoice has to be posted from its own page. Whether Post All should get an "include
  older seasons" option is an owner decision.

### Not verified here

- Not clicked through in a signed-in browser against live data. Before shipping: the Invoices
  list showing the 2 overdue and the drafts; the Drafts tab showing last season's unposted field invoice
  and the Post All confirm saying it is left out; that invoice posting from its own invoice page; a
  new field-app Save landing on the saved invoice.
- The list-test helper returns whole rows whatever columns a query selects, so it would not
  notice a list that stopped selecting `season`. (Deferred product gaps are listed in "Known gaps
  and deferred items" above.)
- Owner decision (not made here): whether the server should also refuse posting an invoice into
  a **season** other than its own (it already refuses a closed accounting period).
