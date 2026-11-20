# Shared data loading: Product pages pilot (step 2 of the hardening order)

**Status:** PLAN, not built. Waiting for Mason's go. Written 2026-11-20 from `origin/staging` `afd562cb3`.
**Database changes:** none. If building turns one up, stop and ask.
**Hands off:** `src/components/ui/`, and quote, booking, invoice and billing screens (Taha's until 2026-12-15).
**Merge timing:** staging is frozen until release #1990 is live. Draft PRs may open sooner; nothing merges before then.

## What is wrong today

The Product pages have no shared way to load data. Every screen hand-writes its own load, loading flag, error
handling and "ignore an old answer" check, and five different checks are in use:

1. `let cancelled` / `let active` in the effect cleanup (most files).
2. A sequence counter in a ref (`loadSeqRef`, `requestIdRef`, `loadSequence`).
3. A `forKey` / `requestKey` match plus an `attempt` counter (`useLastChargedPrices`, `ProductWeightCard`,
   `ProductChemistrySection`, `ChemistryActiveCosts`).
4. A mount flag (`ProductMarginFloorCard`).
5. Remount by `key` (`ProductDetailRoute`, `ProductStockCard`, `ProductVendorsSection`, `ProductBrandsSection`).

Some loads have no check at all, so a slow old answer can overwrite a newer one: in `ProductDetail.tsx`, the unit
conversions, categories, timing options, crop options and vendor-name reads (about L580-597); in
`ProductVendorsSection` both reads; in `Products.tsx` the categories and rate-lock reads (L304, L313). Error display
also varies: some loads toast, some show text, some only go to Sentry and leave an empty list that looks like "none".

There is no data library installed (no TanStack Query or SWR), and none is needed. `docs/workflows/UI_PATTERNS.md`
documents `useState` + `useEffect`. The closest existing template is `src/hooks/useLastChargedPrices.ts`.

Stale-data issues this is meant to prevent:
- **KI-100 (products):** an open product page learns that another admin locked rates only on reload or a refused
  save, and the refused save wipes the typed rate edits.
- **KI-82 (quotes):** same class (a screen shows a figure from before its own save). The quote screen is Taha's;
  the hook is offered to him after 2026-12-15, not applied here.

## The helper

One new hook, `src/hooks/useLoad.ts` (about 60 lines), shaped like `useLastChargedPrices`:

```ts
const lock = useLoad('rate-lock', loadProductRateLock, { action: 'load_rate_lock', refreshOnFocus: true });
// lock.status: 'loading' | 'loaded' | 'failed'
// lock.data (when loaded, and kept while a reload runs), lock.refreshing
// await lock.reload() -> true if fresh data arrived, false if the read failed
```

What it does, so no screen has to:
- **Ignores stale answers.** Every call gets a ticket. An answer is shown only if its ticket is the newest one,
  the screen is still open, and the key it was asked for is the current key. A ticket per call (not per record)
  also covers going A, then B, then back to A.
- **Never shows the wrong record.** Data remembers the key it was loaded for. If the key changes (another
  product), the hook reports "loading" at once instead of the old product's data.
- **Loading, error, retry.** `status` drives the skeleton or `LoadFailedState` (Try again calls `reload`). A failed
  read is never shown as an empty list.
- **Reload keeps the old data on screen** (marked `refreshing`) so the page does not flash, and returns
  true/false so existing "Saved, but the page could not refresh" warnings keep working.
- **Errors go to Sentry** with `{ source: 'fetch', action }`. The hook never toasts; each screen decides
  (a silent reload stays silent, which keeps today's `reportError = false` mode).
- **Optional re-read when the browser tab regains focus** (`refreshOnFocus`). Used only for read-only facts
  (rate lock, stock, histories), never for data that fills a form the user is editing.
- `key = null` means "do not load" (for example, staff-only reads for a non-admin).

The load function throws on failure. Raw `supabase.from(...)` reads add `if (error) throw error`. Writes are
unchanged: `assertRpcResult()` / `checkMutationResult()` stay where they are.

## How a page refreshes after a save

No shared cache and no cross-page invalidation (that is what a library would add, and it is out of scope).
The rule is the one the pages already follow, made uniform:

1. The save succeeds (write checked as today).
2. The save handler awaits `reload()` on each load the write affects.
3. If a reload returns false, show the existing "Saved, but could not refresh. Reload" message, never stale
   figures presented as current.
4. Child cards keep the existing `reloadToken` / `reloadKey` prop; it becomes part of the child's `useLoad` key.

Moving between pages already re-reads (the Products list remounts when you return to it; `ProductDetailRoute`
remounts per product id), so nothing extra is needed there.

**KI-100 fix:** the product page's rate-lock read uses `refreshOnFocus`. When the admin comes back to the tab and
rates are now locked, rate fields switch to read-only with a notice "Rates were locked by another admin; your
rate edits were not saved", and the typed values stay visible instead of being wiped by a refused save.

## Which files switch (two PRs)

`ProductDetail.tsx`, `Products.tsx` and any file whose name has a money word (price, cost, stock, margin, ...)
are on the Sol-review list (`docs/reference/sol-required-paths.md`). Splitting keeps the first PR cheap.

**PR A, no Sol needed (off the list):**
- New `src/hooks/useLoad.ts` + `src/hooks/useLoad.test.ts`.
- `src/components/products/ProductChangeHistory.tsx` (two chained reads).
- `src/components/products/ProductVendorsSection.tsx` (both reads currently unguarded).
- `src/pages/GroupProducts.tsx`: replace the local `useProposalData` with `useLoad`.
- `src/lib/productParents.ts` `useProductParents`: gains an error state instead of Sentry-only.
- `docs/workflows/UI_PATTERNS.md` "Data Fetching Pattern": the documented pattern becomes `useLoad`.

**PR B, Sol review (on the list):**
- `src/pages/ProductDetail.tsx`: the unguarded side reads (unit conversions, categories, timings, crops, vendor
  names) and the rate lock (with the KI-100 change). The main `fetchProduct` / `fetchCostHistory` /
  `fetchCostBasisWorkspace` stay as they are in this pilot: they feed the edit form and the pricing-reload lock,
  and move when Product Master Wave 2 splits the page.
- `src/pages/Products.tsx`: categories and rate lock. The main paged `fetchProducts` stays (same reason).
- `ProductPriceHistory`, `ProductSellPriceHistory`, `ProductStockCard`, `ProductMarginFloorCard`.

Every converted file should get shorter; `npm run check:code-health` must stay green.

## Tests

- `useLoad.test.ts`: answers arrive out of order (only the newest shows); A then B then A; key change shows
  loading, never old data; screen closed mid-load (no update, no warning); failure gives `failed` and Sentry
  once; `reload` keeps old data, returns true/false; `null` key loads nothing; focus re-read fires only when on.
- Each converted file's existing tests must pass unchanged in what they assert (only their mocks may move).
  New tests only where behavior changes: vendors section and change history out-of-order answers; KI-100 lock
  notice keeps typed rates.
- `npm run typecheck`, `npm run lint`, `npm test` on touched areas, `npm run check:code-health`, `npm run build`.

## Proof in the running app

Unit tests are not the proof. For each PR, in the browser:
1. **Local run (`npm run dev`, port 5173):** open Products, open a product, Group Products. Watch each converted
   section show its skeleton, then data, and no console errors.
2. **Failed read:** in the open page, make one read fail on purpose (temporarily make that request error from the
   browser console, debugging only) and confirm the section shows "could not be loaded" with Try again, not
   "none", and that Try again recovers.
3. **Stale answer:** click quickly between product A, B and back to A; the page must end on A's data.
4. **Refresh after save (staging, test data only):** change a vendor link on a test product; the section shows the
   new link without a page reload.
5. **KI-100 (PR B, staging):** two tabs on the same test product; lock rates in one, return to the other; the
   notice appears and typed rates remain on screen.
6. After staging merge (only once #1990 is live): repeat 1, 3, 4 and 5 on `staging.croprxsolutions.app` and post
   `Staging proof: <link>` per `ship.md`.

## Risks

- **A refactor can change what a screen shows on failure.** Mitigation: existing tests keep their assertions;
  browser step 2 per converted section.
- **Over-reaching into form data.** Re-reading data that fills a form could wipe unsaved edits. Mitigation: the
  pilot converts only read-only displays; the edit-form loads stay put; `refreshOnFocus` is off by default.
- **Order of reloads after a save** (PR B): pricing apply reloads three things together today. Unchanged in
  this pilot because those loads are not converted.
- **Two PRs on Product files while Wave 2 waits.** Wave 2 starts after PR B lands, on the new pattern.
- **Sol cost** for PR B; kept small by leaving the main loads alone.

## Out of scope

- Adding TanStack Query, SWR or any dependency; a shared cache; cross-page invalidation; realtime updates.
- Converting the main product load, the paged products list, cost history and cost-basis workspace (Wave 2,
  with the ProductDetail split).
- The chemistry, weight, brands, EPA, workbook and import components: they already guard their loads; they move
  when Wave 2 touches them.
- Any screen outside Products; quote, booking, invoice and billing screens (KI-82 included) wait for Taha after
  2026-12-15; `src/components/ui/` untouched.
- Database changes.
