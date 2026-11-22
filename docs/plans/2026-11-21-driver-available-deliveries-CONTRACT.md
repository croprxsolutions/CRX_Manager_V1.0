# Behavior contract: drivers see and take open deliveries (#2018)

Read at `origin/staging` dab22364c (2026-11-21).

## Facts (with sources)

- The driver Deliveries screen shows an "Available Deliveries" card with a "Take This Delivery" button (`src/pages/Deliveries.tsx`, the `isDriver` effect and the `my-available` section). It reads `deliveries` directly where `assigned_driver IS NULL` and `status = 'scheduled'`, the 20 soonest by `scheduled_date` (ascending).
- The read rule `del_select` lets a driver read only rows where `assigned_driver = auth.uid()` (`20261129100000_deliveries_read_rules_check_role_once.sql`). So the card's read always returns nothing for a driver. That is the bug.
- `reassign_delivery` (wrapper `20261110160000`, body `_reassign_delivery_replay_impl_20261015` from `20260511010000`) already lets an active driver assign a delivery whose `assigned_driver IS NULL`. The check runs before the row lock, and it does not require the new driver to be the caller.
- Delivery statuses: scheduled, in_progress, completed, cancelled, voided (`.claude/schema-registry.json`).
- Farm group shown in lists is the TOP parent (#2032, `20270201110000_farm_group_top_parent_lists.sql`).

## Established decisions

- Mason, 2026-11-21 (in chat, this session): **every active driver may see all open, unassigned scheduled deliveries and take one.**

## Outcome and authority

- Result: the card lists open deliveries for a driver, and "Take This Delivery" assigns one to that driver.
- Smallest change: one new read function, `get_available_deliveries_for_driver()`, `SECURITY DEFINER`, `STABLE`, `search_path = public, pg_temp`, executable by `authenticated` (and `service_role`, as every app function is granted; never `anon`). It returns every open delivery (no cap: Mason said all), soonest scheduled date first, then delivery number, then id: `id, delivery_number, scheduled_date, customer_name, farm_group_name (top parent)`. Nothing else (no address, notes, items, prices). Reason it cannot reuse the list: the list function is `SECURITY INVOKER`, so the read rule hides these rows; widening `del_select` would also expose items, notes and addresses.
- Who may call it: an active profile with role `driver` (checked inside the function from `auth.uid()`; anyone else gets an error). It takes no arguments, so the screen sends nothing the server must trust.
- Rows: `assigned_driver IS NULL AND status = 'scheduled' AND deleted_at IS NULL`.
- Take hardening (same migration, `reassign_delivery` wrapper only): when the caller is a driver (not admin or sales rep), the server requires an active driver not denied the Deliveries page and `p_new_driver = caller`, checks the idempotency key (a bound same-key replay returns its stored result only while the delivery is still the caller's), then locks the delivery row and requires it scheduled, not deleted and unassigned (one already the caller's gets "already assigned to you"), then re-checks the driver's access holding their profile row. A stale row gets "This delivery was already taken or changed. Refresh the list.", not a permission error. A driver can therefore only take an open delivery for themself, and two drivers cannot both take it. Admin and sales rep behavior is unchanged.
- Files: new migration, ledger note, `src/pages/Deliveries.tsx` (screen PR), a real-schema prover, `smoke-specs` entry if required.

## State and failure

- Nothing is written by the read. No existing rows change.
- Timing: two drivers tap Take on the same delivery. The first wins; the second waits on the row lock, re-reads it as taken, and gets "already taken or changed". One driver's double tap with the same key: the second call waits, then replays the first result (one assignment, one notification). A lost-reply retry replays. A delivery assigned, started, cancelled or deleted after the card loaded: refused with "already taken or changed".
- The screen reloads the Available list on entry, after a take succeeds, and after a take is refused, and shows a load failure as an error, not an empty list.
- Existing callers of `reassign_delivery` (Deliveries take button, DeliveryDetail "Take This Delivery") both assign the caller, so the driver restriction keeps them working; admin and sales rep paths are unchanged.
- Other ways a driver could set `assigned_driver`: `del_update` lets a driver update only rows already assigned to them in progress or completed (`20261129100000` header); unchanged.
- Rollout: the old screen never calls the new function, and its only driver call to `reassign_delivery` assigns the caller. Rollback order: screen first, then `DROP FUNCTION get_available_deliveries_for_driver()`. The `reassign_delivery` hardening is corrected forward, never rolled back (rolling back reopens the race).
- Known limit, unchanged: a driver who took the wrong delivery asks the office, who reassigns it; nobody can put a delivery back to "unassigned" today.

## Delivery

1. Database PR (migration + prover + ledger) into `staging`. Sol required.
2. Screen PR switches the card to the new function and closes #2018. It merges only after the staging database has the function.

## Proof cases (local Docker real-schema prover, never live)

All in `scripts/smoke/prove-driver-available-deliveries-real-schema.mjs`:
1. When an active driver calls the read, then they get exactly every open delivery in order (33 open of 40 seeded: 8 named + 25), only the five fields, and none assigned, started or deleted.
2. When an admin, sales rep, applicator, inactive driver or a driver denied the Deliveries page calls it, then it is refused; anon has no execute.
3. When the customer is C in A > B > C, then `farm_group_name` is A; with no parent it is null; with a forced loop the read still returns (direct parent).
4. When a driver takes an open delivery for themself, then it becomes theirs and leaves the list; assigning someone else, an inactive driver, a driver denied the Deliveries page, an applicator are refused; a fresh key on a delivery already theirs gets "already assigned to you"; taken, started, deleted deliveries get "already taken or changed"; a same-key retry replays.
5. When two drivers take the same delivery at once, then the second waits for the first, is refused, and the first owns it. A same-driver double tap notifies once.
6. When an admin or sales rep reassigns a scheduled or in-progress delivery, then it still works.
7. Browser (screen PR): a driver on a local run sees the card with deliveries, takes one, and it moves to their list.

## Astra challenge (gpt-6.2-astra, high, 2026-11-21): 50 findings, settled

- Fixed: cap removed (#1), order wording (#2), retry replays (#14), take requires scheduled (#15), deleted refused (#16), clear stale message (#32), exact-list, five-key, loop, waiting, double-tap and inactive/applicator proofs (#9, #11, #13, #18, #21, #26), rollback order (#43, #44), screen refresh and error state planned for the screen PR (#30, #31, #33, #37).
- Settled by evidence: top parent (#4) is the #2032 follow-up on this issue; hidden ancestor name (#5) is covered by Mason's yes to showing farm name and top farm group; existing callers (#41) both self-assign; other write routes (#29) via `del_update`; NOT NULL on number, date, status (#12, #17) from the schema registry; replay binding unchanged (#19, #20); the prover builds every migration (#39).
- Declined: live refresh while the page is open (#34), account-switch state (#35, the page unmounts on sign-out), paging (#48, open queues are small), dispatch "unassign" (#45, existing limit, noted above).

## Open business decisions

None. Mason, 2026-11-21: "Yes, show them" (drivers see open deliveries with farm name, top farm group and date).

## Luna (gpt-6-luna xhigh, head 7c54df20a): 2 findings

- MED, refuted: a driver's same-key retry after the office reassigned or deleted the delivery gets "already taken or changed", not the stored success. Intended: the stored success no longer says who owns the delivery (Astra #22), so the current state wins and the screen reloads the list.
- LOW, fixed here: the contract now names the `service_role` grant, which matches every app function.

## Sol round 1 (gpt-6.2-sol high, head f302c5b): 1 HIGH, 2 MED, 5 LOW, all fixed

- HIGH: a driver an admin denied the Deliveries page could still list and take open deliveries. Both the read and the driver take now refuse a driver whose `denied_pages` holds `deliveries` (the app's page key, `src/appPages.tsx`); proven.
- MED: lock order. A driver took the row lock before the idempotency key lock, the reverse of admin and sales rep. The driver path now checks the key (and returns a bound replay) first, then locks the row. So a driver's same-key retry after the office moved the delivery now replays its stored success, like every other replayed call (this supersedes the Luna MED note above); the screen reloads the list either way.
- MED: the SQL header's rollback now matches the ledger (screen first, then drop the read; the take hardening is corrected forward).
- LOW: a fresh key on a delivery already the caller's now says "already assigned to you", not a permission error.
- LOW: the race proof measures the second driver's time inside the database call (at least 1 s of lock wait), not from process launch.
- LOW: the post-take list check now requires the list call to succeed.
- LOW: the changelog names the replay condition (same key, caller and request). LOW: the seeded count is 29.

## Sol round 2 (gpt-6.2-sol high, head 45bbdecd9): 1 HIGH, 3 MED, 4 LOW, all fixed

- HIGH: a take waiting on the row lock could commit after an admin denied the driver Deliveries. After the lock the take now re-checks access and holds the driver's profile row (`FOR SHARE`) until commit; proven.
- MED: a driver's same-key replay is returned only while the delivery is still theirs; otherwise "already taken or changed" (the Luna MED position again; Sol round 1's note above is superseded).
- MED: preflight and postflight refuse more than one `reassign_delivery` overload.
- MED: the double-tap proof now requires that one tap waited on the other (both overlap), and both race proofs are order-independent.
- LOW: the denied-page test is null-safe (`array_position`), so a stray null entry does not lock a driver out; proven.
- LOW: "already assigned to you" only while the delivery is still scheduled; otherwise "already taken or changed".
- LOW: the list proof adds a delivery whose number sorts first but date last, and checks dates and ids.
- LOW: the take-hardening rule above now states the implemented order.

## Luna (gpt-6-luna xhigh, commit 28bc36eb4): 1 MED, fixed

- MED: a driver's same-key retry that waited on the key lock could replay success after an admin denied Deliveries. The replay path now re-checks the driver's access holding their profile row, as the fresh path does. Not separately proven (the window needs three interleaved sessions); the full prover still passes.

## Sol round 3 (gpt-6.2-sol high, head 69153cae2): 1 HIGH, 2 MED, 2 LOW, all fixed

- HIGH: the office/driver decision was made before the key wait, so a sales rep demoted to driver mid-wait kept office power. After the key lock an office caller is re-checked (active admin or sales rep) holding their profile row; proven with a rep demoted while their call waits. Same mechanism as round 2 (permission change during a lock wait): every caller's authority is now re-checked after its last wait, so no stale decision is left.
- MED: a driver's replay reads ownership `FOR SHARE`, so it waits for an open dispatch change and re-reads.
- MED: race proofs hold their locks 4 s, so a slow container start still overlaps.
- LOW: the denied-page test is `NOT COALESCE('deliveries' = ANY (denied_pages), false)`: null-safe and safe on a nested array.
- LOW: the changelog and record name all five returned fields, id included.

## Sol round 4 (gpt-6.2-sol high, head 7b350ead4): 2 HIGH waiting on Mason; 1 MED, 2 LOW fixed

- HIGH 1 (Mason's decision): once a driver takes a delivery, the existing customer read rule lets every assigned driver read that farm's credit limit, prepayment balance, payment terms and internal notes. That is today's rule for any assigned driver; this change lets a driver pick which farm.
- HIGH 2 (Mason's decision): the existing driver update rule lets an assigned driver edit fields of their own delivery through the table API (e.g. the quick-delivery flag, which changes stock release on a later cancel). Also today's rule for any assigned driver; this change lets a driver pick which delivery.
- MED, fixed: a driver's replay is refused once the delivery is no longer scheduled or in progress (e.g. dispatch cancelled it); proven.
- LOW, fixed: the list proof seeds an unassigned cancelled delivery; the double-tap proof requires both sessions to commit.

## Part 2: driver data and edit protections (Mason, 2026-11-21: "fix both")

Mason rejected accepting Sol round 4's two HIGHs: a driver must not read a farm's credit limit, prepay balance, payment terms or internal notes, and must change only what delivering needs, enforced by the database.

### Facts (real-schema container at `origin/staging` 3e5954f86 + every migration; frontend inventory)

- `customers_select` driver branch: a driver reads WHOLE customer rows (every column) for any customer with a delivery assigned to them dated today-1 or later. `authenticated` has table-wide SELECT on `customers`, so row rules cannot hide columns.
- `del_update` driver branch: an assigned driver may UPDATE any column of their delivery while it is `in_progress` or `completed` (e.g. `is_quick_delivery`, `customer_id`, `order_id`, `scheduled_date`). No trigger limits which columns a driver changes.
- The app never updates `deliveries` directly (`src/` has no `.from('deliveries').update/insert/upsert/delete`). Every driver delivery action is an RPC (`complete_delivery`, `confirm_delivery`, `edit_delivery`, `reassign_delivery`, `process_offline_action`, ...). No SECURITY INVOKER function executable by `authenticated` updates `deliveries`. So a SECURITY DEFINER RPC is the only write path the app uses, and dropping the driver branch of `del_update` breaks no app flow. `delivery_items` UPDATE is already admin-only.
- Driver customer reads in the app (all go through `customers_select`): `FieldRoute.tsx:78` embed `farm_name`; `FieldStop.tsx:165` embed `farm_name, email` (contact_name unused); `DeliveryDetail.tsx:387` `select('*')`, the driver layout uses `id, farm_name, phone, email, billing_address`; `Deliveries.tsx:451` office customer filter (also runs for drivers, unused there); `Deliveries.tsx:892/906` the #2018 card (replaced by the new list). `DeliveryDetail.tsx:3167` invoice embed returns no rows to drivers (`invoices_select`).
- `get_deliveries_keyset_page` (SECURITY INVOKER, `20270201110000`) joins `customers` three times for `customer_name` and the top farm group; for a driver it relies on `customers_select`.
- No other table's row rule reads `customers`.

### Outcome and authority

1. `customers_select` loses its driver branch: a driver reads no customer row directly. Admin, sales rep, applicator and the dispatchee rule are unchanged.
2. New `get_driver_customers(p_customer_ids uuid[])`, SECURITY DEFINER, STABLE, `search_path = public, pg_temp`, `authenticated` + `service_role` only. An active driver not denied the Deliveries page gets, for each requested customer that is on a non-deleted delivery assigned to them dated today-1 or later (today's window), only: `id, farm_name, contact_name, phone, email, billing_address, shipping_address, city, state, zip`. Never credit limit, prepay, payment terms, notes, finance or commission fields, tier, discount or account number. Anyone else: refused. Ids outside the rule are silently omitted.
3. New `_delivery_list_customer_labels()`, SECURITY DEFINER, STABLE, returning `id, farm_name, parent_customer_id` only: every customer for an active admin or sales rep; for anyone else only customers on a delivery assigned to them plus those customers' ancestors (so the top farm group still resolves). `get_deliveries_keyset_page` reads names and the farm-group walk from it instead of `customers`; its output, order, search and paging are unchanged.
4. `del_update` loses its driver branch: only admin and sales rep may UPDATE `deliveries` directly. Drivers change deliveries only through the existing server functions, which already decide what a driver may change.
5. Screens (second PR, "Closes #2018"): FieldRoute, FieldStop and the DeliveryDetail driver layout read customer details through `get_driver_customers`; the Available card uses `get_available_deliveries_for_driver`; the office customer-filter read is skipped for drivers.

### Delivery

- DB PR (this branch) carries parts 1-4 with the #2018 functions; the screens PR carries part 5. The screens cannot land first (their RPCs must be live on staging). Between the two merges, staging drivers see "Unknown customer" and no phone or address on the delivery screen. Both PRs must ship in the same release; the merge captain is told so.

### Proof cases (added to the real-schema prover)

8. A driver reading `customers` directly gets no row, even for a delivery assigned to them; admin and sales rep still read every column.
9. `get_driver_customers` returns exactly the ten safe fields for a customer on the driver's delivery; omits a customer not on their deliveries and one only on an old (before today-1) delivery; refuses admin, sales rep, applicator, inactive and denied drivers; anon has no execute.
10. `get_deliveries_keyset_page` for a driver still returns the customer name and top farm group of their deliveries; for an admin, unchanged.
11. A driver's direct UPDATE of their in-progress delivery (`is_quick_delivery`, `status`) changes nothing; admin direct UPDATE still works; a driver still completes a delivery through its RPC.

### Mason's decisions on Part 2 (2026-11-21, in this session, answering Astra's DECISION findings 6, 7, 23, 33)

- Address (Astra 6): drivers see the farm's **shipping** address; when it is blank, the billing address.
- Contact access (Astra 7, 8, 9, 29): drivers may see the farm name, phone, email and delivery address of **every** farm, any time (not only farms on their deliveries). Credit limit, prepay balance, payment terms and notes stay hidden. This removes the date window, the per-delivery entitlement and its time-zone boundary.
- Driver actions (Astra 17, 19, 23): drivers keep every action the app's buttons offer today; only the direct table edit (`del_update` driver branch) is removed.
- Go-live (Astra 33, 34): two steps. Release 1: edit lock, `get_driver_customers`, the list's label helper, the screens. Release 2 (a later small PR): drop the `customers_select` driver branch once release-1 screens are live. No gap for drivers on an old app copy.

### Part 2 as built (release 1) and Astra's 36 findings

Built in `20270204120000` (release 1): the `del_update` driver branch is removed; `get_driver_customers(uuid[])` returns `id, farm_name, phone, email, address` (shipping, else billing) for any farm to an active driver, refuses everyone else, caps a request at 500 ids, and never returns another column. Screens PR: FieldRoute, FieldStop and the DeliveryDetail driver layout read farms through it (`src/lib/driverFarms.ts`). Release 2 (a later small PR, after release-1 screens are live): drop the `customers_select` driver branch and give `get_deliveries_keyset_page` a definer label source for drivers. Items 2 and 3 of "Outcome and authority" above move to release 2; the label helper is designed there, not here.

Proof (prover parts 6-8): five safe fields only, address rule, unknown and duplicate ids, empty and over-cap requests, admin/rep/applicator/inactive/anon refused; a driver's direct edit of their in-progress and completed delivery worked before the candidate and changes nothing after (quick flag, notes, status), with admin and rep direct edits unchanged; and a sweep calls every SECURITY DEFINER function `authenticated` may run as a driver with a seeded farm (41 answered) and finds none returning the seeded credit limit, prepay balance, payment terms or notes, while the same sweep as an admin finds them in 7 functions (so the sweep can see a leak).

| Astra # | Settlement |
|---|---|
| 1, 2, 27 | Release 2 (the whole-row read stays in release 1 by Mason's two-step decision). `_is_dispatched_to_me` and the role predicates re-read the active profile on every call (definitions checked); release 2 will prove a driver with a dispatch, an applicator and a dispatchee. |
| 3 | Fixed by evidence: the definer-function sweep above. Invoker functions return only what the table read returns, which release 2 removes. |
| 4 | Refuted: `deliveries` has no money or credit column (column list checked); drivers already see their delivery's notes on screen. |
| 5, 6, 7, 8, 9, 28, 29 | Settled by Mason's decisions: any farm, any time, five fields, shipping else billing. No date window or per-delivery rule remains; one row per distinct known id is proven. |
| 10-16, 31, 32 | Release 2 (label helper and keyset change); not in this PR. 32 for `get_driver_customers`: definer, fixed search path, authenticated + service_role only, checked by postflight and the anon proof. |
| 17, 19, 23 | Settled by Mason: drivers keep every app action as is; only the direct table edit is removed. |
| 18, 20, 21, 22 | Unchanged functions; this PR adds no driver write path and removes one. The existing RPCs keep their own checks (not re-audited here). |
| 24, 25 | Accepted: the app has no direct `deliveries` update anywhere in `src/`; any assigned non-office user loses only that unused path. |
| 26 | Fixed: flag-only, notes-only and status-only driver edits on both states, the "before" case proves the edit worked pre-candidate, and an independent read confirms the rows unchanged. |
| 30 | Screens: each driver read throws on failure and the page shows its existing load error; FieldStop clears the old address before the new stop's address loads. Browser proof in the screens PR. |
| 33, 34 | Settled by Mason's two-step go-live; rollback stated in the migration header. |
| 35 | Release 2: old devices hold only what the driver already saw; the whole-row read ends there. |
| 36 | Screens PR: browser proof of take, open the stop, see the farm contact. |

## Release 2 (#2162): drivers read farms only through `get_driver_customers`

Read at `origin/staging` 3a9694685 (2026-11-22), plus #2165 head 09d7ffade for the screens; real-schema container with every migration.

### Facts

- `customers_select` (`20261013220000`, unchanged since; live md5 `7b5322d9…`): admin, sales rep, a driver for any farm on a delivery assigned to them dated yesterday or later (whole row), an applicator for the farm of their job in the last 7 days. `customers_select_location_dispatchee` is a separate rule (job dispatches; no crew member is a driver live, 2026-11-22).
- Invoker functions a driver's screens call that read `customers`: only `get_deliveries_keyset_page` (the driver Deliveries list) and `get_notes_for_entity` (notes linked to a customer: a driver loses them, as they lose the farm row; delivery notes are unaffected). No view reads `customers`; no other table's rule reads it except office-only storage rules.
- #2165 screens: every driver farm read goes through `get_driver_customers`. Three direct reads still run for a driver and come back empty after this change with no visible effect: the office customer filter on Deliveries (hidden for drivers), the team-board note context card (hidden when empty), the related-invoice embed on DeliveryDetail (never shown to drivers).
- Live, 2026-11-22: 154 customers, 110 deliveries, 2 active drivers; deliveries assigned to non-drivers are admin or sales rep only.
- Old app copies (before #2165) read `customers` directly in FieldRoute, FieldStop and DeliveryDetail; after this change they show "Unknown customer" and no phone or address.

### Outcome and authority

1. `customers_select` loses its driver branch; everything else in it is unchanged. `customers_select_location_dispatchee` is unchanged: office staff may add any profile to a field crew (`ground_crew_members_insert`), and a driver on a dispatched crew is field crew and sees what field crew sees, the whole farm record and the job paperwork included (Mason, 2026-11-22, "2: Yes"; Astra #2, Sol round 1 #1). Live: no driver is on a crew.
2. New `_delivery_list_customer_labels()` (definer, stable, fixed search path, authenticated + service_role): `id, farm_name, farm_group_name` (top parent) only. Active admin or sales rep: every customer on a delivery. Active driver allowed the Deliveries page (the `get_driver_available_deliveries` check): customers on deliveries assigned to them. Anyone else (inactive, or another role holding an assignment): nothing, as `is_driver()` gave them before (Astra #3). A driver already may see every farm's name (Mason, 2026-11-21), so this is narrower than allowed.
3. `get_deliveries_keyset_page` reads names from the helper; otherwise byte-for-byte the `20270201110000` body (still invoker). Office output identical. A driver's list now also shows the top farm group and names on deliveries older than yesterday (before: none and "Unknown", since a driver could not read the parent farm), within Mason's "every farm's name" decision.
4. No screen change: #2165 already reads farms through the lookup.

### Delivery (timing)

- The open release PR follows `staging`, so a merge into `staging` ships in the next release. This PR therefore **merges into `staging` only after #2165 is live in production** (not just merged), so the farm read is removed in a later release than the screens that replace it. Drivers' installed app updates on its next open; with two drivers, the release that carries #2162 should wait until both have opened the app since #2165 went live, or accept a one-open "Unknown customer" for a driver who has not.
- Recovery: fix forward (repair the helper, the list or the screens). Restoring the drivers' whole-row read would reopen the exposure and needs Mason's explicit security decision first.

### Proof cases (`scripts/smoke/prove-drivers-read-farms-only-through-lookup-real-schema.mjs`, local Docker)

1. When a driver reads `customers` directly, then no row through a delivery, not even the farm on their own delivery (before: the whole row); a driver on a dispatched crew still reads that job's farm; an inactive driver on that crew reads nothing.
2. When admin or sales rep read `customers`, then every row and column; an applicator still reads their recent job's farm and the farm of a job location dispatched to them, and no other.
3. When a driver loads their Deliveries list, then each delivery keeps its farm name and top farm group (also an old delivery), search by farm group works, no other delivery and no secret appears; admin and sales rep responses are identical to before for every sort key both ways, two searches, a status filter and a short page.
4. When anyone calls the helper, then only three columns; driver: their deliveries' farms; office: every farm on a delivery; an applicator holding a delivery assignment, an inactive driver and a driver denied the Deliveries page: nothing; anon: no execute.
5. When a driver calls `get_driver_customers`, then it still answers.
6. When a driver calls every function a signed-in user may run (definer and invoker; every uuid argument tried as the delivery farm, the crew farm, its job and its job field), then none returns the delivery farms' seeded credit limit, prepay, terms or notes; the same sweep as an admin does find them. Limit: other argument types get NULL and erroring calls are skipped; the guarantee is the read rule, proved directly in case 1.

### Challenge settlement (Astra gpt-6.2-astra high, 38 findings, 2026-11-22)

| Finding | Settlement |
|---|---|
| #2 crew-dispatched driver keeps the whole row | DECISION: Mason, 2026-11-22: a driver on a crew is field crew ("2: Yes"); rule unchanged; proof 1 |
| #3 helper gave labels to any active assignee | Fixed: driver only; proof 4 |
| #4 inactive driver | Refuted: `is_driver()` requires an active profile, same as before; proof 4 |
| #5 helper office branch vs `is_admin()`/`is_sales_rep()` | Refuted: same active-role check; no service_role caller of the list |
| #6 farm group shown to drivers | Settled: Mason's "drivers see every farm's name" (2026-11-21); the Available list already shows it |
| #1, #38 a smaller design (no helper) | Refuted: #2162 prescribes a server-side farm-name source for drivers; the helper is narrower than `get_driver_customers` |
| #11, #14 screen still offers direct reads | Server denies; the three remaining reads are hidden or empty (Facts) |
| #12 team-board context card | Only the credit-limit card disappears for drivers, as intended |
| #24, #25 office parity coverage | Proof 3 widened to 20 variants; driver list is unpaged |
| #28-#30 old app copies / timing | Delivery (timing) above; Mason's two-step decision |
| #31 cached REST responses | Refuted: the service worker does not cache Supabase REST |
| #36, #37 rollback reopens exposure | Recovery is fix-forward |
| #15-#18 | Belong to #2165 or earlier proofs |
| Others | Wording, or declined as out of scope |

### Sol round 1 settlement (2026-11-22)

| Finding | Settlement |
|---|---|
| HIGH 1 crew driver gets account number via billed-customer functions | DECISION: Mason "2: Yes", crew drivers are field crew; dispatch rule left unchanged |
| HIGH 2 preflight passes without the address lookup | Fixed: preflight pins the 20270207120000 `get_driver_customers` body |
| MED 3 helper skips the Deliveries page check | Fixed: driver branch requires the page; proof 4 |
| MED 4 service_role / applicator assignee lose labels | Refuted: no service_role caller (no Edge Function calls the list); live, non-driver assignees are admin or sales rep only |
| MED 5 autocommit without ON_ERROR_STOP | Refuted: `scripts/apply-migration-file.mjs` runs the file and its ledger row in one transaction |
| MED 6 row level security off | Fixed: preflight and postflight require it on `customers` |
| MED 7 sweep uses one uuid | Fixed: four uuids; remaining limit named in proof 6 |
| LOW 8 comment | Fixed |

### Open business decisions

None. Mason, 2026-11-22: a driver put on a field crew is field crew ("2: Yes"). Mason, 2026-11-21: two-step go-live, drivers see every farm's name, phone, email and addresses through the lookup only.
