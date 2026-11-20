# Shared data loading: Product pages pilot (step 2 of the hardening order)

**Status:** PLAN r3.1, not built. Written 2026-11-20 from `origin/staging` `afd562cb3`.
**History:** advisory Sol 6.2 (high) reviews: r1 drew 50 findings (1 BLOCKER: its KI-100 fix targeted rate boxes
that are already read-only); r2 drew 37, mostly in its second batch (rate-lock switch, timings, units, price
history). Mason chose on 2026-11-20 to shrink the pilot to the first batch; the rest moves to Product Master Wave 2.
r3 drew 30 (1 BLOCKER: the proof's cleanup removed a preferred vendor, which the screen and database refuse).
r3.1 fixes that blocker and the two HIGHs below; the remaining MED/LOW items are implementation detail that
the build's tests and the code review (Luna, then Sol if the diff is Sol-listed) settle against real code.
Review record: the shared side-session notes folder.
**Database changes:** none. **No Sol-listed file changes** (re-check the final diff).
**Hands off:** `src/components/ui/`; quote, booking, invoice and billing screens (Taha's until 2026-12-15).
**Merge timing:** staging is frozen until release #1990 is live. A draft PR may open sooner; no merge before then.

## Goal

One small shared hook for reading data on a screen, proven on two real Product sections, so Wave 2 builds the
split Product page on it instead of hand-writing each load again.

## What the pilot fixes

- `ProductVendorsSection.tsx`:
  - The admin vendor-picker read (L64-69) has no cleanup and reads a single page, so with more than 1,000 vendors
    some can never be added (the 1,000-row cap in `UI_PATTERNS.md`).
  - The linked-vendors read (`reload`, L48-60) has no guard: a slow first read can land after a newer read
    started by link or unlink and show the old list.
  - A failed picker read today hides nothing but leaves Add usable with a stale pick.
- `ProductChangeHistory.tsx` is already guarded; converting it proves the hook on a two-stage read (history, then
  optional parent names) and removes about 25 lines of hand-written guard code.

## The helper: `src/hooks/useLoad.ts`

```ts
const history = useLoad(`change-history:${productId}`, (isCurrent) => readChangeHistory(productId, isCurrent), {
  refreshToken: reloadToken,
  report: { extra: { context: 'product_change_history' } }, // the file's existing Sentry context
});
// history.status: 'idle' | 'loading' | 'loaded' | 'failed'; history.data; history.error; history.refreshing; history.stale
// await history.reload() -> { status: 'applied', data } | { status: 'failed', error } | { status: 'skipped' }
```

Contract (each line is a test):

1. **Identity vs refresh.** `key` names the record. A new key drops the old data at once and shows loading.
   `refreshToken` or `reload()` reads the same record again and keeps the old data on screen with
   `refreshing: true`.
2. **Only the newest request counts.** A request's authority ends when a newer request starts, when the key or
   `refreshToken` changes (at commit, before the next effect runs), when the key becomes `null`, and on unmount.
   An old success or failure then changes nothing: no state, no Sentry report.
3. **A, then B, then back to A** shows loading until a new A read returns; old A data never comes back.
4. **`key = null` is idle:** no data, no reads; `reload()` returns `skipped`.
5. **`reload()` reports its own request:** `applied` with the fresh data, `failed` with the error, or `skipped`
   (superseded, idle or unmounted). A superseded `reload()` resolves `skipped` as soon as a newer request starts,
   so an awaiting caller is released even if the old read never settles. A `reload` captured before a key change
   reads the current key, never the old one. Callers warn only on `failed`; on `skipped` they do nothing further
   (no guessed values, no parent callbacks).
6. **A failed refresh keeps the old data marked `stale: true`;** the screen says it may be out of date, offers
   Try again, and disables actions that depend on it.
7. **Success means the loader's promise resolved,** `null` included. A loader that throws before returning a
   promise is a failure. Loaders must throw when Supabase or `fetchAllRows` returns an `error` (they resolve
   with it rather than throwing), and check the payload shape.
8. **Multi-stage loaders** receive `isCurrent()` and check it before starting each later stage, so a superseded
   load starts no further requests and logs nothing. (`fetchAllRows`'s inner page loop cannot be stopped midway;
   `shortcut:` comment, upgrade if a long paged read ever goes through the hook.)
9. **Loader identity:** the hook calls the latest loader (`useLatestRef`), so inline arrows cause no read loop.
   Anything that decides *what* to read must be in `key`.
10. **Errors** go to Sentry once per current failure, through `sanitizeError`, with the caller's existing
    `report` tags or `extra`, so Sentry alert grouping does not change. `report: false` keeps a read that today
    shows its error without logging it. The hook never toasts.
11. **No focus or visibility refresh** in this pilot (no consumer needs it yet).

Writes are unchanged (`assertRpcResult()` / `checkMutationResult()`).

## File changes (one PR, no Sol-listed paths)

- New `src/hooks/useLoad.ts` (target under 100 lines) and `src/hooks/useLoad.test.ts`.
- `src/components/products/ProductChangeHistory.tsx`: history read through `useLoad` (`refreshToken` =
  `reloadToken`). The parent-name lookup stays optional: it runs only if `isCurrent()`, a failure still shows the
  rows with "Changed on parent", and its Sentry report keeps `extra.context: 'product_change_history_parent_names'`
  and fires only for a current request. Loading and empty texts unchanged.
- `src/components/products/ProductVendorsSection.tsx`:
  - Linked vendors through `useLoad` (key `vendors:${productId}:${isAdmin}`; the RPC returns costs only to
    admins, so a role change is a new record). Link and unlink await `reload()`.
  - Preferred-vendor mirroring after link: `applied` uses the re-read's preferred vendor, falling back as today
    when the list has none; `failed` keeps today's fallback (the vendor just made preferred, or the first vendor;
    see "Known, not fixed"); `skipped` mirrors nothing (a newer read already owns the screen).
  - Picker through its own `useLoad` (key `null` unless admin), read with `fetchAllRows` + `pageWithList`,
    `count: 'exact'`, ordered by `name` then `id`.
  - Add is enabled only when the picker is loaded and the picked id is still in the current addable list; the pick
    clears when the picker reloads or fails. A picker failure shows its message with Try again and never hides the
    linked list. "Make preferred" and "Remove" do not depend on the picker.
- `docs/workflows/UI_PATTERNS.md`: a short "Pilot: `useLoad`" note (where it is used, the contract above). The
  app-wide pattern text changes only after Wave 2 uses it.

## Known, not fixed (pre-existing; logged in KNOWN_ISSUES with the PR)

- **Two admins adding the first vendor at once:** if A's re-read after linking fails, the fallback can name A's
  vendor as preferred when B's link actually won. Rare (needs a simultaneous first link and a failed read); the
  database holds the true preferred vendor and a reload shows it. Fixing it means changing what the product page
  saves, a Sol-listed file, so it goes to Wave 2.
- **Role change with Remove open:** an admin demoted while the Remove confirmation is open can still press it;
  the database refuses (`unlink_product_vendor` requires an admin, migration `20261105180000`).

## Moved to Product Master Wave 2 (Mason, 2026-11-20)

Rate lock on Products and the product page (with KI-100's passive-refresh gap and its proof, which flips a switch
shared by everyone on that database), the five side reads on the product page (units, categories, timings, crops,
vendor/manufacturer suggestions), Products categories and parents, supplier and sell price history, stock card,
margin floor, Group Products, and the main product, list, cost-history and cost-basis loads. Sol's r2 findings on
those areas are kept with this plan's review record for Wave 2 to answer.

## Tests

- `useLoad.test.ts`, with deferred promises and React Strict Mode: stale success and stale failure ignored (no
  state, no Sentry); a response settling between the key-change commit and the next effect is ignored; same for a
  `refreshToken` change; A to B to A with settled and in-flight data; key to `null` and back; unmount mid-read;
  `reload()` results `applied` / `failed` / `skipped` (superseded, idle, unmounted); a `reload` captured before a
  key change; refresh keeps data then marks stale on failure; `null` result is loaded; synchronous throw; inline
  loader causes no read loop; `isCurrent()` false after supersession; `report` metadata passed through and
  `report: false`.
- `ProductChangeHistory.test.tsx`: existing assertions kept; add parent-name failure still shows rows, and a
  superseded load does not start the name lookup.
- Vendors tests: picker paging (two pages), picker failure keeps the linked list and disables only Add, stale
  pick cleared, out-of-order linked reads end on the newest, link mirrors the re-read's preferred vendor, and the
  fallback path when the re-read fails.
- `npm run typecheck`, `npm run lint`, focused `npm test`, `npm run check:code-health`, `npm run build`, and the
  Sol-path classifier on the final diff (expect "not required"; if it says required, Sol runs).

## Proof in the running app

The candidate is the PR head commit run locally (`npm run dev`, port 5173), signed in as an admin, with the commit
written in the PR. Before starting, record which Supabase project the local app points at (the project URL shown in
the browser's network requests, never the `.env` file) and use only a test product there. `src/lib/db.ts` L29-39
calls the browser's global `fetch` on every request, so a `window.fetch` wrapper installed in the page intercepts
the app's reads (debugging only, reads only, removed afterwards).

1. Open a test product: Change History and Vendors load; no console errors.
2. **Failed read:** fail the next `get_product_vendors` request once. Expect the error with Try again; Try again
   recovers. Fail the next vendor-picker read once (`/rest/v1/vendors`): the linked list stays, Add is disabled,
   Make preferred still works, Try again recovers. Fail the next `product_change_history` read once: "could not be
   loaded", Try again recovers.
3. **Out-of-order answers:** hold the first `get_product_vendors` response for 10 seconds; meanwhile link a vendor
   (this starts a newer read). When the held response is released, the list must still show the new vendor.
4. **Save then refresh** (a test product that already has a preferred vendor; note it first): add a second
   vendor: the Vendor field stays the same. Press Make preferred on the second: the Vendor field changes. Restore:
   press Make preferred on the original vendor, then remove the added one (a preferred vendor cannot be removed,
   by the screen or the database). The first-vendor case (an empty product's first link becomes preferred) is
   covered by tests only, because that link cannot be removed afterwards.
   Writes happen only on a database the PR names as a test target (local copy or staging), never live; if the
   local app points at live, stop and use staging after the freeze lifts.
5. A sales-rep view if a test rep login exists; otherwise the PR says it was not shown.

After the staging merge (only once #1990 is live): repeat 1, 3 and 4 on `staging.croprxsolutions.app` with the
deployed commit named, and post `Staging proof: <link>` per `ship.md`.

## Risks

- **Failure display changes.** Step 2 per read; existing test assertions kept.
- **Vendor field mirror.** Behavior kept exactly; tests pin both the re-read and fallback paths.
- **Pilot spreading before Wave 2 proves it on a larger page.** The UI guide labels it a pilot.

## Out of scope

Everything under "Moved to Product Master Wave 2"; TanStack Query, SWR or any dependency; a shared cache;
cross-page invalidation; realtime; focus refresh; database changes; screens outside Products; Taha's screens;
`src/components/ui/`.
