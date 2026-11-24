# Google Maps design for CRX (agreed by Mason 2026-11-24, pre-build)

Background, options and the two earlier Sol reviews: `2026-11-24-map-provider-options.md`.
Status: **design only, revision 4: Sol READY-WITH-CHANGES (changes adopted).** Nothing built.
Build starts after the field build's slice 1 lands.

## What Mason wants
"Use Google Maps for it all, like Chem Man, and offer a choice between USDA, Google Maps and Mapbox."
Google's satellite picture is the default on every map and every printed sheet, and staff can switch pictures.

## Behaviour contract

**Changes**
1. Every CRX map (Fields, Field Setup, Field View, Field Dashboard, Dispatch Board, Customer Detail,
   job field map and picker, field-app location picker, import preview) shows **Google satellite with road
   labels** by default.
2. One **picture switch** on every map: Google (default), USDA aerial, Mapbox. It extends the
   existing `LayerToggle`. The choice is remembered per browser (localStorage). Switching (or an automatic fallback)
   **only swaps the background picture**: the map, the drawing tool and any unsaved boundary edit
   stay as they are. A fallback is shown ("Google unavailable — showing USDA") and is not saved as
   the person's choice.
3. **Printed job and applicator sheets** use Google by default. If Google fails for a field, that field
   falls back to Mapbox (the existing print path), and failing that, to "no picture" with the reason.
   The print provider is a Vercel setting (`VITE_PRINT_MAP_PROVIDER`), so changing it is a settings
   change plus a redeploy, with no database or admin screen. USDA is a live-map picture only; it is not used for prints.
4. **Every job field appears on the sheet**, map or not. The sheet is built **from the saved job's
   ordered field list and treatment acres first**. Pictures, outlines and obstacles are then
   attached to those rows by the job-field identity; they're never used to decide which fields
   appear. Obstacles are always listed as text with their type and description. "None recorded"
   appears only after a successful obstacle read for that field. A failed or partial read prints "Obstacles could not be
   checked — confirm on site". An obstacle that could not be placed on the picture says so. If the
   job's field list itself can't be loaded, or comes back incomplete (row count doesn't match the job), show an error
   instead of a sheet that looks complete.
5. Credits follow the picture actually shown: the Google logo plus the viewport's live credit text
   for Google; Mapbox's logo and credits; the USGS service credit for USDA. Prints keep the marks
   the provider bakes into the image. This replaces today's `attributionControl={false}`.
6. Each field gets an "Open in Google Maps" link (keyless `api=1` URL from the field location) on sheets
   and the phone view. It doesn't depend on the map picture loading.

**Must NOT change**
- Saved boundaries, obstacles and acres. Acres stay computed by `@turf/area` (`src/lib/fieldGeometry.ts`)
  and the existing save RPC. No database change, no migration, no stored geometry rewrite.
- The boundary-drawing behaviour in `DrawControl.tsx`: multipart saves, Done/Start Over, the obstacle lock, the
  `static` mode, corner counting and button disabling.
- Who can see or edit which fields (no permission change).
- A map or picture failure never blocks saving a field, building a job or printing a sheet.

## How (engineering)

- **Step 0 — prove before building (a gate on everything below).** On a staging deploy:
  1. A browser Google key restricted to our websites can create a Map Tiles session and load
     tiles. If Google requires IP-restricted keys for Map Tiles, stop and add a small authenticated
     server route for session + tiles, then re-plan the costs.
  2. `@mapbox/mapbox-gl-draw` on `maplibre-gl` (pinned versions, MapLibre's compatibility shim set
     up once, CSS and button lookups scoped to our control) passes the existing drawing tests plus a
     hand test on phone and desktop.
  3. Switching pictures mid-draw and mid-drag keeps the draft.
  4. Google Static Maps returns bytes the PDF renderer can embed (CORS checked), at 640×640 scale 2.
  If any of these fails, come back to Mason before building.
- **Engine:** replace `mapbox-gl` + `react-map-gl/mapbox` with `maplibre-gl` + `react-map-gl/maplibre`
  across both wrappers (`CRXMap.tsx`, `MapContainer.tsx`) and every direct import (re-inventory after
  slice 1 lands). One map instance per screen. The picture is a raster source swapped in place,
  with no remount. Field layers stay above the picture, and labels use local fonts.
- **Pictures:**
  - Google: Map Tiles API 2D, **one combined session** (`mapType: satellite`, `layerTypes: ["layerRoadmap"]`,
    `overlay: false`). Sessions are shared across maps, refreshed before expiry and on app resume,
    and late responses after a picture change are ignored. Credits come from the viewport metadata.
  - USDA: USGS National Map `USGSImageryOnly` (`/tile/{z}/{y}/{x}`, 256 px, its own max zoom).
  - Mapbox: HTTPS Static Tiles for satellite-streets with the existing token (scopes checked).
  - Fallback: on repeated auth or quota errors, or no usable picture within a few seconds, move to the
    next picture and show a notice. If no picture works, show field outlines on a plain background.
- **Prints** (`src/lib/jobMapImages.ts`, after the paperwork lane lands, agreeing the result shape with
  that lane first): add a Google Static Maps path (closed encoded outlines per part and hole; URL ≤
  16,384 after encoding) beside the Mapbox path. Return one result per job field and the overview
  (picture used or reason, obstacle status). Bounded parallel fetches under one overall deadline that
  leaves time for the fallback and the PDF. Simplification is capped and topology-checked, and the
  saved geometry is never altered.
- **Keys:** separate Google keys for live maps and prints, and for staging vs production. Set budget
  alerts and per-day quota caps. Keys and session tokens are kept out of Sentry and logs. Mason creates the
  Google Cloud billing account.
- **CSP and caching:** exact Google, USGS and Mapbox hosts in `vercel.json` `img-src`/`connect-src`,
  checked inside the installed PWA. Google tiles are never put in the service-worker cache.

## Pre-existing drawing-tool bugs Sol found (fix in step 1, since it retests this code anyway)
Verify each first; fix only the ones that reproduce:
- A one-gesture move of several selected parts records only `features[0]` (`DrawControl.tsx:181–194`).
- Entering obstacle mode can commit an in-progress sketch through `draw.create`.
- The initial geometry load waits a fixed 200 ms. It can race a slow map and leave partial geometry.

## Accepted risk (Mason's business call, 2026-11-24)
Google's standard terms forbid creating content traced from Google pictures and storing them
offline, and its FAQ forbids Google images in app-made documents (its brand guidelines are looser).
Chem Man does all of this. Mason accepted the risk after it was explained. Worst case: Google revokes the
key. Live maps then fall back to USDA or Mapbox and prints fall back to Mapbox or "no picture", while
fields, jobs and sheets keep working. Offline phones (spring) are designed separately; USDA is the
clean offline source.

## Costs (Google's list prices via Sol; confirm in the Google console)
2D Map Tiles: 100,000 free a month, then $0.60 per 1,000. Google's billing page lists a default daily limit of 15,000 requests;
its May 2026 release notes say 100,000 a day. Record the real limit from the console. Separate keys
in one Google Cloud project share its quota, so use separate projects for staging and production.
Count a full fallback day too: Mapbox tiles, reprints and retries. Sessions and
viewport metadata are not billed. Static Maps (prints): 10,000 free a month, then $2 per 1,000.

## Order of work
| Step | When | Collides with |
|---|---|---|
| 0. Prove-first checks | Any time (staging only, no shared files) | — |
| 1. Engine swap + picture switch + credits on live screens + drawing-bug fixes | After slice 1 lands, before slice 2 | `FieldSetup.tsx` (Field Setup lane), all map screens |
| 2. Slice 2 dispatch and phone maps built on it | January | — |
| 3. Google prints + per-field print results + obstacle text | After the paperwork lane lands | `jobMapImages.ts`, applicator sheets |
| 4. Offline phones, crop colours, print window, ink saver | Spring | — |

Each step has its own rollback: step 1 reverts to the Mapbox engine. In step 3, a Google picture outage is handled by setting the print
provider back to Mapbox, and a bug in the new sheet code by redeploying the last known-good print build (tested on an already-open installed app).
Taha's areas (quotes, bookings, holds, chemical billing): none touched.

## Proof before calling it done
- Draw, edit, multipart-save and reopen real fields (one with a hole, one multipart, one with obstacles,
  one with an acreage override) on each picture. Saved geometry, obstacles, measured and billable
  acres must match before vs after.
- Switch pictures during a draw and a drag: the draft is kept.
- Break the Google key on staging while the app is **already open**: maps fall back with a notice,
  fields still save, jobs still build, sheets still print.
- Print a 10+ field job including a field with no boundary and one with obstacles: every field is
  listed, obstacles are listed as text, the time is acceptable, and the paper copy is readable.
- Count real Google tile and image requests for a normal dispatch day against the quota.

## Build checklist (Sol design review 2)
Step 0 additions:
- Prove **automatic** fallback and Retry, not just the manual switch, during a sketch and a drag, then
  save and reopen. Provider failures never use the engine's remount path, and the camera doesn't jump.
- Prove on the **oldest work phone, inside the installed app**, with the production build and real CSP.
- Static Maps failure cases (bad key, quota, malformed outline): the app must tell a real picture from
  Google's error/warning image. If it can't, prints stay on Mapbox until it can.
- One deployed render per fallback (Mapbox token scope `styles:tiles`; USGS tiles and credits).
Step 1:
- The map starts with a blank local style. A missing provider key never stops the map, the other
  pictures or the drawing tool loading. Non-map actions stay usable if the engine itself fails.
- Inventory every caller after slice 1 and map the old Roads/Terrain/`printMode` options.
- Fallback order for each choice: Google→USDA→Mapbox, USDA→Mapbox→Google, Mapbox→USDA→Google. The
  chosen and the displayed picture are kept separate, and failed providers are retried on the next
  map open, not in a loop.
- One shared Google session refresh per app; refresh once on expiry before treating it as a failure.
  Credits update after pan and zoom settle and are tied to the visible picture. The USGS credit names both USDA and USGS.
- Each drawing bug gets a targeted reproduction: a multi-part drag, a mode switch with a committable
  sketch, and a slow initial load.
- Tile sizes, zoom limits and overzoom are set per source and checked against a known boundary.
- The picture switch is accessible (labelled; fallback announced quietly). Check `geolocation=()` in
  `vercel.json` against the phone location flows.
Step 3:
- The overview acre-label fix (paperwork lane) lands first. If the label position can't be verified
  for a provider, acres go in the field table only.
- The same outline-fidelity limit (in metres, holes and parts checked on the final encoded shape) applies to Google and
  Mapbox. If a faithful outline can't fit, show "no picture: field too detailed".
- One deadline covers obstacle reads, images and conversion; fallback gets a fixed share; at the
  cutoff every row is finalised.
- The overview follows Google → Mapbox → none and names the fields missing from it.
- Provider requests carry only geometry and styling (no names or notes). Map-image URLs are never sent to
  Sentry. Mapbox puts outlines in the URL **path**, so record only provider, operation and status.
- The "Open in Google Maps" link uses the saved field location; if there is none, it says unavailable.
  Paper copies also print the coordinates.
- Name the exact print entry points (job sheet, applicator sheet) and verify each.
- If a proxy is ever needed: prove a fixed outbound IP from the host first.
Installed-app rollback: test an already-open phone moving to the rollback build.

## Sol design review 3 (2026-11-24): READY-WITH-CHANGES
The print blocker is resolved. Its three HIGH changes are adopted above: an incomplete field list stops the print, map URLs
are kept out of Sentry, and there's a separate rollback build for sheet-code bugs.

## Sol design review 2 (2026-11-24): NOT-READY, 4 of 5 blockers resolved
Resolved: draft loss, acre proof, browser key, USDA print. Remaining: the print data path (fixed in
contract item 4, revision 3). Sol accepted all four omissions for a one-company tool: the list-only phone
fallback is acceptable if the work phones pass Step 0.

## Sol design review 1 (gpt-6.2-sol, high, 2026-11-24): NOT-READY → handled
Blockers and how revision 2 answers them: (11) browser key auth → step 0.1 prove-first; (1) fallback
could lose a draft → swap the picture in place, no remount, plus a test; (7) acre proof too weak → compare
geometry, obstacles, measured and billable acres; (25) USDA print path missing → USDA dropped from
prints, Mapbox is the print fallback; (26) sheets lose fields and obstacle status → contract items 4
and 3. Most HIGH/MED items are folded in above. **Not adopted, for Mason to confirm:**
- A company-admin print setting in the database (a Vercel setting instead, since CRX is one company).
- A cross-tab live sync of the picture choice.
- A list-only fallback for phones without WebGL (today's Mapbox maps have the same limit).
- A server proxy for tiles (only if step 0.1 fails).
Sent to the paperwork lane: overview acre labels are mirrored north–south in today's prints
(verified), plus the obstacle-drop, missing-field and serial-timeout risks.
