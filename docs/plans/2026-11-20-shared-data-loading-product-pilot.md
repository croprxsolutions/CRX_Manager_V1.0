# Shared data loading: Product pages pilot (step 2 of the hardening order)

**Status:** PLAN r2, not built. Waiting for Mason's go. Written 2026-11-20 from `origin/staging` `afd562cb3`.
r2 answers an advisory Sol 6.2 (high) review of r1 (50 findings, 1 BLOCKER: r1's KI-100 fix targeted rate boxes
that are already read-only).
**Database changes:** none. If building turns one up, stop and ask.
**Hands off:** `src/components/ui/`, and quote, booking, invoice and billing screens (Taha's until 2026-12-15).
**Merge timing:** staging is frozen until release #1990 is live. Draft PRs may open sooner; nothing merges before then.

## What is wrong today

Product screens each hand-write their own load, loading flag, error handling and "ignore an old answer" check.
Several patterns are in use, often combined in one file (effect cleanup flags, request counters, key/attempt
matching, mount flags, remount by `key`). Most loads are guarded; the gaps are:

- `ProductVendorsSection.tsx`: the admin vendor-picker read (L64-69) has no cleanup and reads one page only, so
  with more than 1,000 vendors some never appear (the 1,000-row cap in `UI_PATTERNS.md`).
- `ProductDetail.tsx` L579-600: unit conversions, categories, timings, crops and vendor/manufacturer suggestions
  run once per mount with no cleanup; failures are toast-only or silent. They are catalog-wide and the route
  remounts per product, so the risk is a late answer after leaving the page, not the wrong product.
- `ProductDetail.tsx` main `fetchProduct` / `fetchCostHistory` and `Products.tsx` `fetchProducts`: two reads of
  the same record can finish out of order. Not converted in this pilot (see Out of scope), so the pilot does not
  claim the whole Product page is protected.
- The rate-lock banner on an open product page changes only after a parent edit, a rate correction or a reload.

No data library is installed and none is needed. `docs/workflows/UI_PATTERNS.md` documents `useState` +
`useEffect`.

**KI-100 is out of date.** Since RT-4b the product page's rate boxes are read-only (`ProductDetail.tsx` ~L1957)
and the page never sends rate fields (`nonpricingProductPayload`, L116-122). Rates change only in the Setup
Workbook, the Parent panel or the Correct rates dialog. So "typed rate edits are lost" no longer happens on this
page. What remains is the passive part: an open page does not notice the lock flip. PR B fixes that and updates
KI-100's text. KI-82 (quotes) is Taha's; the hook is offered to him after 2026-12-15.

## The helper: `src/hooks/useLoad.ts`

```ts
const history = useLoad(`change-history:${productId}`, () => readChangeHistory(productId), {
  action: 'load_product_change_history', refreshToken: reloadToken,
});
// history.status: 'idle' | 'loading' | 'loaded' | 'failed'
// history.data (only when loaded), history.refreshing, history.stale
// await history.reload() -> { status: 'applied', data } | { status: 'failed' } | { status: 'skipped' }
```

Contract (each line is a test):

1. **Identity vs refresh.** `key` says *which record*. When it changes, the old data disappears at once and the
   screen shows loading. `refreshToken` (and `reload()`) says *same record, read again*: the old data stays on
   screen with `refreshing: true`.
2. **Only the newest request counts.** Every request takes a generation number. A key change, a newer request,
   `key = null` and unmount all end the authority of older requests at commit, before any new effect runs. An old
   success *or* an old failure changes nothing: no state, no Sentry report, no `refreshing` change.
3. **A, then B, then back to A** shows loading for the second A until a new A read returns; old A data never
   comes back.
4. **`key = null` is idle**, not loading: no data, no reads, no focus reads, `reload()` returns `skipped`.
5. **`reload()` reports what happened to *its* request:** `applied` (with the fresh data, so callers such as the
   vendor save can use it directly), `failed`, or `skipped` (superseded, disabled or unmounted). Callers warn only
   on `failed`; `skipped` is never a "could not refresh" warning.
6. **A failed refresh keeps the old data but marks it `stale: true`.** Screens show "may be out of date. Try
   again" and disable actions that depend on it. Safety reads (the rate lock) ignore stale data and treat a
   failed refresh as failed.
7. **Success is "the promise resolved"**, including `null` (no margin floor, no proposal). A loader that throws
   before returning a promise counts as a failure.
8. **Loader identity:** the hook calls the latest loader (held with `useLatestRef`), so an inline arrow causes no
   read loop. Everything that decides *what* to read must be in `key`.
9. **Errors:** the hook reports a current request's failure to Sentry once, with `sanitizeError` for Supabase
   error objects and the file's existing tag or `extra.context` name carried over, so alert grouping does not
   change. It never toasts; each screen decides.
10. **`refreshOnFocus` (off by default):** reads again when the page becomes visible again (`visibilitychange`
    only, one trigger). Skipped while a read is in flight. Never used for a read that fills a form.

The hook runs no caller side effects. Writes are unchanged (`assertRpcResult()` / `checkMutationResult()`).

## How a page refreshes after a save

No shared cache and no cross-page invalidation. In converted code:

1. The write succeeds (checked as today).
2. The handler awaits `reload()` on the reads it depends on and uses `applied` data where it needs fresh values.
3. `failed`: show "Saved, but could not refresh. Try again". `skipped`: nothing (a newer read is already running).
4. Cards refreshed by a token (histories) show their own stale notice if their refresh fails; the page's success
   message speaks only for reads it awaited.

Save handlers that are not converted keep today's behavior; the pilot does not change their messages.

## Which files change

Sol-review rule: `ProductDetail.tsx`, `Products.tsx`, and any `src/` path containing a money word (price, stock,
margin, ...) need Sol. Re-run the classifier on each PR's final diff, not this list.

**PR A, no Sol (re-check the final diff):**
- New `src/hooks/useLoad.ts` + `src/hooks/useLoad.test.ts`.
- `ProductChangeHistory.tsx`: the main read through `useLoad`; the parent-name lookup stays an optional extra
  inside the loader, so a failed name lookup still shows the history rows with "Changed on parent".
- `ProductVendorsSection.tsx`: the linked-vendors read through `useLoad` (link/unlink use `reload()`'s `applied`
  data for the preferred vendor, keeping today's fallback when the re-read fails). The picker read gets its own
  `useLoad` (key `null` for non-admins) and reads every page with `fetchAllRows`. Add and link stay disabled
  while the picker is loading or failed. A failed picker never hides the linked list.
- `docs/workflows/UI_PATTERNS.md`: a short "Pilot: `useLoad` on Product pages" note. The app-wide pattern text
  changes only after the pilot proves out.

**PR B, Sol review, branched from PR A (draft, base PR A's branch until A merges; Sol on B's final head):**
- `ProductDetail.tsx`:
  - Rate lock through `useLoad('rate-lock', ...)` with `refreshOnFocus`. Loading or failed (including a failed
    refresh) stays read-only with Retry, as `rateLockFailed` does today. The banner shows the lock's own status
    and audit summary, no claims about drafts or who changed it.
  - The five side reads, each keeping its own fallback: categories and timings failures keep today's messages
    and blocks; crops fall back to crop codes; unit conversions failure shows a notice. `UseTimingChoicesModal`'s
    `onReload` goes through the timings `reload()` and still returns the fresh list.
- `Products.tsx`: rate lock through `useLoad` (initial read, `refreshOnFocus`). After a lock or unlock,
  `ProductRateLockControl`'s `onChanged` triggers `reload()`, whose newer generation makes any earlier read
  irrelevant. `categoryChoices` (the configured list) through `useLoad`; the row-derived filter list is unchanged.
- `ProductRateLockControl.tsx`: unlock copy no longer promises editing "on product pages again" (L99).
- `ProductPriceHistory.tsx`, `ProductSellPriceHistory.tsx`: `useLoad` with `refreshToken`. The supplier filter
  resets only when the product changes; chart selection actions are disabled while refreshing or stale.
- `ProductStockCard.tsx`: inner read through `useLoad`; the parent's remount key after Tote Fill stays; no focus
  refresh (it reads the whole inventory position).
- `docs/manual/KNOWN_ISSUES.md` KI-100: rewrite to the current behavior and mark fixed once proven.

## Tests

- `useLoad.test.ts` with deferred promises: stale success and stale failure ignored (no state, no Sentry); A to B
  to A with settled and in-flight data; key to `null` and back; unmount mid-read; React Strict Mode double
  effects; `reload()` returning `applied` / `failed` / `skipped` (superseded, disabled, unmounted); refresh keeps
  data then marks stale on failure; `null` result counts as loaded; synchronous loader throw; inline loader causes
  no read loop; focus re-read off by default, coalesced, removed on unmount, never with `key = null`.
- Converted files: existing assertions stay unless the behavior change is deliberate; each deliberate change is
  listed in the PR body. New tests: vendor picker paging and failure keeping the linked list; vendor save using
  fresh data and the fallback on failed re-read; change history partial success; (PR B) lock refresh failure is
  read-only; timings modal reload; history stale notice and disabled actions.
- `npm run typecheck`, `npm run lint`, focused `npm test`, `npm run check:code-health`, `npm run build`.

## Proof in the running app

The candidate is the PR head commit run locally (`npm run dev`, port 5173) and signed in as staff, recorded by
commit in the PR. Shared staging before the freeze lifts would show old code and proves nothing.

PR A:
1. Open a product as an admin and as a sales rep (if a test login exists, else say so): change history and
   vendors load; no console errors.
2. **Failed read:** in the page, wrap `window.fetch` to fail one GET to `/rest/v1/product_change_history` once,
   then release it (debugging only, reads only). Expect "could not be loaded" with Try again, and Try again
   recovers. Same for the vendor picker read: the linked list stays visible, Add is disabled.
3. **Out-of-order answers:** the same wrap delays the first change-history answer; trigger a refresh so a second
   read finishes first; the screen must end on the newer answer.
4. **Save then refresh (test product):** link a vendor; the list and the product's vendor field update without
   reload. Repeat with the re-read forced to fail: the fallback name shows and the "could not refresh" notice too.

PR B (adds):
5. Rate lock: Products in one tab, a product in another. Lock, return to the product tab: the banner flips with no
   reload; check a second product too; an unsaved edit to another field survives the refresh. Unlock after.
   The lock is one switch for everyone on that database: **NEEDS MASON at PR B time** to pick a quiet window (or a
   local database copy if one is available).
6. History refresh after a pricing apply on a test product, and the same with the history re-read forced to fail
   (stale notice, actions disabled).

After each staging merge (only once #1990 is live): repeat that PR's steps on `staging.croprxsolutions.app` with
the deployed commit named, and post `Staging proof: <link>` per `ship.md`.

## Risks

- **A refactor changes what a screen shows on failure.** Proof step 2 per converted read; tests keep assertions.
- **Overwriting typed input.** Only display reads are converted; focus refresh is off by default and never on a
  form-filling read; Margin Floor (an edit form) is excluded.
- **Shared rate lock during proof.** Mason picks the window (step 5).
- **Stacked PRs.** B is based on A; if A changes in review, B is rebased and re-checked before Sol.
- **Pilot spreading before it is proven.** The UI guide labels it a pilot until PR B is live.

## Out of scope

- TanStack Query, SWR or any dependency; a shared cache; cross-page invalidation; realtime.
- Main product load, paged products list, cost history, cost-basis workspace (Product Master Wave 2, with the
  ProductDetail split).
- `GroupProducts.tsx` (its loader also keeps typed answers and selection; convert with Wave 2), `useProductParents`
  (needs the Products consumer to show failures), `ProductMarginFloorCard` (edit form), chemistry, weight, brands,
  EPA, workbook and import components (already guarded).
- Screens outside Products; quote, booking, invoice and billing screens (KI-82 included); `src/components/ui/`.
- Database changes.
