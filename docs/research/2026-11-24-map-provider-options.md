# Map provider options: Mapbox vs Leaflet vs Google vs MapLibre (2026-11-24)

Status: **design agreed by Mason 2026-11-24. Not built.** Mason asked whether to move CRX off
Mapbox (to Leaflet, Google Maps, or something else) for more flexibility and built-in features.

## 0. Agreed design (Mason, 2026-11-24)

"Use Google Maps for it all, like Chem Man, and offer a choice between USDA, Google Maps and Mapbox."

1. **Google satellite is the default picture everywhere:** live screens, boundary drawing, dispatch,
   phones and printed/PDF job and applicator sheets.
2. **Picture switch** on every map: Google (default), USDA aerial (NAIP), Mapbox. Each person's last
   choice is remembered. Prints use a company-wide picture setting (default Google), so a change is a
   switch, not a rebuild.
3. **Engine:** MapLibre (free, open source) replaces Mapbox's engine. It shows Google's official
   satellite tiles (Map Tiles API), USDA and Mapbox pictures, and keeps our tuned boundary-drawing
   tool. Leaflet was considered; it would force a rebuild of the drawing tool for no visible gain.
   The screen looks the same to staff either way.
4. **Google credits and logo shown** on screen and on prints (required, cheap). Every field gets an "Open in Google Maps" link on
   sheets and phones (already on the field-build gap list).
5. Boundaries, obstacles, acres and crop colours stay CRX's own data, drawn on top of whichever picture is chosen.

**Risk Mason accepted (his business call, after the terms were explained):** Google's terms forbid
tracing new content from its pictures and storing them offline, and are grey on printing in
app-made documents (§§4b–4e). Chem Man does the same. Realistic worst case: Google ends CRX's key,
the Google picture goes blank, and staff switch to USDA or Mapbox. Customer data and billing are unaffected.
Offline phones (spring) will be designed then; USDA is the clean offline fallback.

**Mason actions (accounts/billing are his):** create a Google Cloud billing account and Maps API key
(restricted to croprxsolutions.app + staging); later decide whether to keep the Mapbox account.

**Costs to check before build:** Google 2D Map Tiles has 100,000 free tile requests a month, then about $0.60 per 1,000
([price list](https://developers.google.com/maps/billing-and-pricing/pricing)); one map screen loads many tiles, so model staff use. Static
picture pricing for prints is unverified.

### What rides where

| Part | When | Collides with |
|---|---|---|
| Engine swap to MapLibre + picture switch (Google/USDA/Mapbox) + credits on live screens | **After slice 1 lands, before slice 2 starts**, so the new dispatch and phone maps are built on it | `FieldSetup.tsx` (Field Setup lane) and every map screen. Must wait for those lanes to land. |
| Dispatch board and applicator phone maps | **Slice 2 (January)**, built on the new engine with the picture switch | Slice 2 itself; no extra work if the engine swap lands first |
| "Open in Google Maps" link on sheets and phones | Slice 1 or 2 (already planned as gap item 1f) | Paperwork lane (`applicatorSheetPdf.ts`) |
| Printed maps use the print picture setting (Google default) | **After slice 1 paperwork lands** | `jobMapImages.ts` + applicator sheets (paperwork lane). Fix Sol's print risks at the same time: silently dropped obstacle pins, distorted outlines, one-at-a-time fetches. |
| Offline phone maps, crop-colour toggle, print window, ink saver | **Spring** (already on the spring list) | — |

Taha's areas (quotes, bookings, holds, chemical billing): **none touched.**

## 1. What Mapbox does in CRX today (checked on `origin/staging`, 2026-11-24)

Mapbox does four separate jobs. Any replacement has to cover all four.

| Job | Where | Mapbox piece | Size |
|---|---|---|---|
| A. Live interactive map (satellite + roads) | `src/components/map/CRXMap.tsx`, `MapContainer.tsx`, `FieldBoundaryLayer.tsx`, `FieldMarkerLayer.tsx`, `FieldMarkers.tsx`, `FieldObstacleLayer.tsx`, `fields/ImportPreviewMap.tsx`; used by `Fields`, `FieldView`, `FieldSetup`, `FieldDashboard`, `CustomerDetail`, `DispatchBoard`, `JobFieldMap`, `JobFieldPickerModal`, `field-app/SelectLocationsModal` | `mapbox-gl` v3 + `react-map-gl/mapbox`; styles `satellite-streets-v12`, `streets-v12`, `outdoors-v12` | ~1,100 lines of map components + map sections of ~9 pages |
| B. Drawing and editing field boundaries | `DrawControl.tsx` (342 lines, custom `static` mode, custom styles, corner counting, button disabling), `DrawingHud.tsx`, `lib/fieldGeometry.ts`, `lib/csbAdopt.ts` | `@mapbox/mapbox-gl-draw` | ~700 lines, heavily tuned |
| C. Address search | `AddressSearch.tsx` | Mapbox Geocoding v5 (temporary geocoding) | 129 lines |
| D. Printed map pictures (job sheets, applicator sheets) | `lib/jobMapImages.ts` (746 lines) + test | Mapbox **Static Images API**: builds a URL with field GeoJSON, simplifies shapes to stay under an 8,000-character URL limit, fetches a PNG, 10 s timeout | 746 lines + 347 test |

Also: `VITE_MAPBOX_TOKEN` in Vercel + GitHub secrets; `vendor-mapbox` chunk in `vite.config.ts`;
a gotcha entry for the `react-map-gl/mapbox` import path. USDA field boundaries (CSB) are our own code
and work with any engine. Open item: `TO_DO_LIST.md` 16.10 "Mapbox and satellite map licensing terms
checked for business use" — **not done**. `SERVICES_AND_ACCOUNTS.md` §7: owner/plan/cost unconfirmed.

**Busy right now:** the field-application build is editing `jobMapImages.ts` + applicator sheets
(slice 1 paperwork lane) and `FieldSetup.tsx` (Field Setup lane). Slice 2 (January) adds dispatch-board
combined/per-field maps and applicator phone maps. Spring list: crop-coloured map toggle, map print
window, ink saver, offline phones.

## 2. The options

Important distinction: a map has two layers — the **engine** (the code that draws and lets you pan,
draw, click) and the **data** (satellite pictures, road maps, address search, printed pictures).
Mapbox and Google sell both. Leaflet and MapLibre are engines only; data comes from someone else.

### Option 1 — Stay on Mapbox
- Covers A–D today. No work.
- Cost (third-party 2026 summaries; verify on Mapbox's own page): ~50,000 free web map loads/month,
  then ~$5 per 1,000; static images ~50,000 free then ~$1 per 1,000; temporary geocoding ~100,000 free.
  CRX's internal staff volume is very likely inside the free allowance.
- Risks: single vendor; `mapbox-gl` v2+ is not open source (proprietary licence, needs a token
  even to run the engine); business-use licence check still open.

### Option 2 — Leaflet (+ an imagery company + a search company)
- Free, open-source engine. Leaflet 1.9 is stable; 2.0 is still beta (beta 4) as of late 2026.
- Drawing: Leaflet-Geoman is good and mature, but our 342-line tuned `DrawControl` would be rebuilt
  from scratch, with its custom modes and safety behaviour.
- Raster/canvas engine: no smooth rotation/tilt, vector tiles only through plugins, slower with
  hundreds of field polygons on one map (dispatch board, customer map).
- Does **not** provide imagery, search or printed pictures. Job D needs a new approach (another
  static-image API, or render tiles to a canvas ourselves).
- Effort: rewrite all of A and B, replace C and D. Largest change of any option.
- Gain over today: free engine, no vendor lock-in. Not more built-in features — fewer.

### Option 3 — Google Maps Platform
- Best address search and place data; good imagery; Static Maps API exists for job D.
- Drawing Library deprecated 2025-08-08, scheduled unavailable from the May 2026 release; Google points
  to Terra Draw. So job B would be rebuilt on a third-party tool anyway.
- Strict terms (Google imagery cannot be mixed with other map data or cached), usually the most
  expensive at volume. Rewrite A, B, C, D.
- Gain: better address/place search. Loss: drawing, flexibility, cost.

### Option 4 — MapLibre GL JS (+ pick an imagery source)
- Free, open-source (BSD) fork of the Mapbox engine. `react-map-gl` ships `react-map-gl/maplibre`
  with the same components (`Map`, `Source`, `Layer`, `Marker`, `Popup`, `useControl`).
- Drawing: `mapbox-gl-draw` is documented as working with MapLibre through react-map-gl's plugin
  support; MapLibre forks and Terra Draw / maplibre-geoman exist as fallbacks. Our `DrawControl`
  likely survives with small changes (needs a spike to prove it).
- Imagery is a separate choice and can change later without touching code again:
  - keep Mapbox satellite tiles (same look, still a Mapbox account, smaller bill), or
  - MapTiler (commercial plan needed; free plan is non-commercial), Esri World Imagery via ArcGIS
    Location Platform (session pricing since Oct 2025; terms forbid bulk tile export), or
  - USDA NAIP via USGS (public domain with attribution, free; refreshed every 2–3 years per state,
    so can be a couple of seasons old).
- Job C: keep Mapbox geocoding, or swap to MapTiler/Esri/Google search independently.
- Job D: MapTiler has a static maps API; or render with MapLibre off-screen to a picture ourselves
  (removes the URL-length limit and the outside fetch — but more code).
- Offline phone maps (spring): MapLibre + PMTiles is the standard open approach; easier than with Mapbox.
- Effort: swap imports and styles in ~15 files, prove drawing, decide imagery; job D only if the
  imagery source changes.

### Others considered briefly
- **ArcGIS Maps SDK (Esri):** strong GIS/ag tooling, but heavy and a full rewrite; overkill for CRX.
- **OpenLayers:** powerful free engine, full rewrite, steeper learning curve, no real gain over MapLibre.
- **Stadia Maps / Protomaps:** data providers that pair with MapLibre; useful later for cheap road maps.

## 3. Side-by-side

| | Covers A–D now | Rewrite size | Drawing | Vendor lock-in | Offline (spring) | Likely cost at CRX volume |
|---|---|---|---|---|---|---|
| Mapbox (today) | Yes | None | Excellent (tuned) | High | Possible, licence-limited | ~Free (unconfirmed) |
| Leaflet | No (engine only) | Largest | Rebuild on Geoman | Low | Plugins | Imagery + search fees |
| Google | Mostly | Large | Rebuild (Terra Draw) | High | Poor | Highest |
| MapLibre | Yes, with chosen data | Small–medium | Likely reuse | Low | Best | Free engine + chosen data |

## 4. Working recommendation (for Sol to challenge)

1. **Do not move to Leaflet or Google.** Neither adds features CRX needs; both force a rebuild of the
   boundary-drawing tool we just tuned, during the field build.
2. **Now (no code):** confirm the actual Mapbox bill/usage, turn on the URL restriction on the token,
   and close TO_DO 16.10 (business-use licence check). If the bill is ~$0 and the licence is fine,
   there is no urgency.
3. **Later, after slice 1 lands and outside the field lanes:** a small **MapLibre spike** — swap
   one screen (`Fields`) to `react-map-gl/maplibre` keeping Mapbox tiles, and prove `DrawControl`
   still works. If it works, switch the engine everywhere, keep Mapbox data, and decide imagery
   separately (NAIP as a free fallback layer is a cheap win).
4. Leave job D (printed pictures) on the Mapbox Static API until the print-window/ink-saver work
   in spring, then decide whether to render prints ourselves.

## 4b. Mason's preference (2026-11-24): Google satellite imagery

Mason finds Google's imagery much better and wants it. Two legitimate ways to get it:

- **Path G1: Google's own engine + Terra Draw.** Google retired its drawing tools and its docs show
  Terra Draw (`terra-draw` + `terra-draw-google-maps-adapter`, MIT) as the replacement. Licence is
  clean. Cost: rewrite all map components (job A) and rebuild the boundary tool (job B) on Terra Draw.
- **Path G2: MapLibre engine + Google Map Tiles API (2D satellite tiles).** Google's Map Tiles API
  sells satellite tiles (official price list: 100,000 free/month, then about $0.60 per 1,000). Our
  drawing tool may survive (see Option 4). **Open question:** Google's terms on showing those tiles
  in a non-Google engine; older sources say no, the Map Tiles API and the EEA terms change suggest
  yes in some cases. This must be confirmed from Google's current Map Tiles API terms before relying on it.
- **Leaflet + Google imagery:** only through the "GoogleMutant" workaround (Google's map embedded
  inside Leaflet). Leaflet's own FAQ says it is not a perfect experience. Not recommended.
- Either Google path: Google terms forbid caching tiles, so **offline phone maps (spring) cannot use
  Google imagery**; offline would need a free fallback layer (USDA NAIP). Printed map pictures (job D)
  would move to Google's Static Maps API; confirm its printing terms.

## 4c. Sol review, round 1 (gpt-6.2-sol, high, 2026-11-24): AGREE-WITH-CHANGES

Sol agreed: no Leaflet or Google full migration, and protect the boundary editor during the field build. Changes it asked for:
- **Licences come before engines (BLOCKER).** Mapbox's public Static Maps page limits printing to
  personal, non-commercial use. Get written confirmation that CRX's account covers satellite pictures
  in commercial job/applicator PDFs. Ask about **tracing rights** at the same time: can staff save
  boundaries traced over the imagery and use them for billing?
- **Map credits are switched off.** Confirmed: `CRXMap.tsx` and `MapContainer.tsx` set
  `attributionControl={false}`. Providers require visible credits. This is a small fix, independent of any switch.
- **Token restriction:** live maps, search and prints share one token. Restrict it carefully and test all three.
- **Offline (BLOCKER for spring):** the current PWA reopens the app offline but has no offline map.
  Mapbox offline downloads exist only in its native phone SDKs. Possible approaches: a downloadable
  "job packet" of pictures, or a MapLibre pilot with a small downloaded imagery area.
- **Sequence:** pilot MapLibre on the read-only applicator phone map first. Switch staff maps only
  if that pilot pays off and a separate drawing trial proves saved shapes and acres match.
- **Print risks in today's code** (feed to the paperwork lane): obstacle pins can silently drop off a
  printed map; heavy shape simplification can distort outlines; timeouts run one image at a time.
- **Other options worth a look:** Stadia (paid static maps with print allowances), Esri via ArcGIS
  Location Platform (commercial, works with MapLibre), OpenLayers (strong drawing tools).

## 4d. Sol review, round 2: Google imagery (gpt-6.2-sol, high, 2026-11-24)

Sol checked Google's public US Maps Platform terms. CRX's own account agreements are unverified.
- **Tracing and saving boundaries over Google imagery: No.** Terms §3.2.3(c): "Customer will not
  create content based on Google Maps Content". The examples given include tracing from satellite imagery. This applies with Terra Draw or MapLibre alike.
- **Google satellite in MapLibre/Leaflet for online viewing: Yes**, via the Map Tiles API, with
  session tokens, the Google logo and credits, and no storing tiles. The terms also restrict mixing with non-Google maps in the same app.
- **Google satellite pictures in printed/PDF job sheets: No.** The Platform FAQ says no Google Maps
  Platform images may be included in app-generated documents. A link or QR code is allowed.
- **Offline: No.** The Map Tiles policy prohibits offline use.
- **Others:** Stadia and MapTiler also forbid tracing; Stadia allows commercial prints through its
  cacheable static endpoint. Esri and Mapbox tracing/print rights are unverified for CRX's account.
- **USDA NAIP: Yes to all three** (public domain; credit "USDA NAIP" + capture year). It is aerial photography, about
  60 cm (30 cm in some areas), taken in the growing season, refreshed up to every 3 years.
- **Sol's recommendation: NAIP for drawing, prints and offline.** First check: trace a handful of real
  billed fields on NAIP and compare acres with trusted GPS/acre records.

**Implication:** Google's better-looking imagery cannot be the layer staff trace on, print, or
take offline, which are CRX's three main map jobs. At most it could be an online look-only view, and
even that runs into the "no mixing with other maps" restriction.

## 4e. How Chem Man does it (from the 2026-11-20 captures in the chem-man review)

Chem Man draws its map with Leaflet and gets its picture by loading Google's official Maps JavaScript API
(`maps.googleapis.com/maps-api-v3`, `maps/vt`), with a Mapbox option alongside (`api.mapbox.com/styles/v1`),
an ArcGIS feature service, and an "Open this area in Google Maps" link. Boundaries and obstacles are drawn on top as
its own shapes. The captures can't show whether Chem Man has a special Google agreement covering
tracing and prints.

**Proposed middle path (pending Mason):** copy Chem Man's look, but keep each job on a licensed source.
- Live screens: a picture switch (Google / Mapbox / USDA). Google is the default for *looking*;
  CRX boundaries, obstacles and crop colours are drawn on top (allowed).
- Drawing a new boundary: draw on the USDA picture (or Mapbox once confirmed), or start from the
  USDA field outline CRX already imports. Once saved, it shows on Google like any other boundary.
- Printed sheets: USDA, Mapbox (if confirmed) or Stadia, plus an "Open in Google Maps" link/QR.
- Offline phones: USDA.
- Remaining risk: Google's "no mixing with non-Google maps" clause may cover a picture switch. Worst
  realistic case: Google cuts off our key, the Google option goes dark, and the other pictures keep working.

**Update (Mason: Chem Man prints Google pictures on every job and phone):** the printing rule is a
grey area, not a clear no. Google's current [Platform FAQ](https://developers.google.com/maps/faq) says app-generated printed/PDF
documents may not contain Google Maps images; Google's [Geo Guidelines](https://about.google/brand-resource-center/products-and-services/geo-guidelines/) list business print uses
as allowed. Online phones may show Google live. The clear no's remain: **tracing new boundaries**
and **offline** storage. Revised option: Google for viewing, phones online, and prints (Mason's risk
call); USDA for drawing new boundaries and offline. Make the picture a setting per use, so a change
of mind or a licence answer is a switch rather than a rebuild.

## 5. Collision and lane notes
- Engine swap touches `FieldSetup.tsx`, `DispatchBoard.tsx`, `jobMapImages.ts` (if imagery moves) —
  all live field-build lanes. Do not build until slice 1 lands; fold into or after slice 2.
- Nothing here touches Taha's areas (quotes, bookings, holds, chemical billing).
- Billing/account changes with Mapbox or a new provider need Mason (accounts, secrets, payment).

## Sources
- Mapbox pricing summaries: https://storerocket.io/learn/mapbox-pricing , https://www.woosmap.com/blog/mapbox-pricing , https://superdupr.com/blog/mapbox-pricing (third-party; verify on docs.mapbox.com/accounts/overview/pricing/)
- Google deprecations: https://developers.google.com/maps/deprecations
- react-map-gl MapLibre support: https://visgl.github.io/react-map-gl/docs/whats-new , https://maplibre.org/maplibre-gl-js/docs/plugins
- Esri basemap pricing/terms: https://www.esri.com/about/newsroom/announcements/esri-arcgis-location-platform-adds-session-usage-pricing-for-basemaps , https://www.esri.com/content/dam/esrisites/en-us/media/legal/product-specific-terms-of-use/e300.pdf
- MapTiler: https://www.maptiler.com/cloud/pricing/ , https://www.maptiler.com/cloud/terms/
- Leaflet 2.0: https://leafletjs.com/2025/05/18/leaflet-2.0.0-alpha.html , https://www.github.com/geoman-io/leaflet-geoman/releases
- USDA NAIP: https://registry.opendata.aws/naip/index.html , https://www.usgs.gov/faqs/how-often-orthoimagery-national-map-updated-and-what-are-acquisition-dates
