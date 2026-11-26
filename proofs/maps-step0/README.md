# Disposable Maps Step 0 proof

The protected staging drawing page is `https://staging.croprxsolutions.app/api/maps-step0-draw/index.html` when deployed. This bundle is generated only for Vercel's custom staging target from the staging branch. The normal app build contains no drawing page. First verify that the signed-out URL redirects to Vercel and the signed-in page has one route-specific Content Security Policy. Keep real records and non-test geometry out of the proof.

In staging, choose **Use live USDA and Mapbox** to enable the live providers. Check that USDA shows the USDA/USGS credit, and Mapbox shows its logo and attribution links. Start a synthetic polygon, place two corners, switch pictures, then select **Fail picture**. The staging fixture returns an intentional HTTP 503. Confirm that the alternate live picture and its credit appear without losing the draft or moving the camera. Select **Retry**, verify that the original picture and credit return, finish the polygon, and use **Save synthetic draft** and **Reopen**. Repeat while holding a vertex in a drag. The oldest-phone check must run in the installed staging app. If it opens the app shell after a weak connection, reconnect and open the exact proof path again.

After Step 0, remove the drawing bundle hook, its routing and policy, and the outage fixture along with the associated disposable proof.

This local page checks whether one MapLibre map can change raster pictures and recover from a failed tile while Mapbox Draw is still editing a synthetic polygon. The tile server generates two solid-color pictures. Save and Reopen use storage scoped to the current browser tab.

The original local recovery proof at `1c48e0942` was tested against staging `723992d59`. This copy adds a standalone production bundle and was tested against staging `40f75a8fe`. The root lockfile pins Mapbox Draw to 1.5.2. The local proof uses MapLibre GL JS 6.19.0. Its Vite config serves the MapLibre worker from the same origin.

## Run locally

Run from the worktree root with Chrome installed.

```powershell
npm ci
npm install --prefix proofs/maps-step0 --no-save --no-package-lock maplibre-gl@6.19.0
npm test -- src/components/map/DrawControl.test.tsx
npx --no-install playwright test --config=proofs/maps-step0/playwright.config.ts
```

The browser suite builds the standalone production bundle under `proofs/maps-step0/dist` and serves it on loopback. Both healthy picture files are part of that bundle. The preview server supplies the deliberate HTTP 503 fixture used by **Fail picture**. A deployed proof requires its own approved outage test setup.

To open the page for free play, run `npx --no-install vite --config proofs/maps-step0/vite.config.ts --host 127.0.0.1` and open the localhost address Vite prints. Click **Start polygon**, click the map to place corners, and click the first corner again to close the shape. Click the selected polygon to show its vertices, then drag a vertex. **Fail picture** makes the active tile route return HTTP 503. **Retry** restores its healthy local route. **Reopen** reloads the page and restores the last saved synthetic polygon in that tab.

## Local checks

Verified again on Nov. 26, 2026 at about 12:30 a.m. Central in desktop Google Chrome 158.0.8127.88 on Windows, using Playwright with software WebGL at 1000 × 800. The built page ran on a loopback URL. Three existing `DrawControl` tests and four Chrome scenarios passed. The proof also passed strict TypeScript and ESLint checks.

| Check | Evidence collected by the test |
| --- | --- |
| Drawing compatibility | Chrome draws and closes a four-corner polygon, shows the scoped Draw controls, and can trash a sketch and start again. The same-origin raster is below the drawing layers. |
| Manual switch, fallback and Retry during a sketch | Chrome switches A → B with two corners placed. A real local tile request returns 503 and the map renders A automatically. Retry renders B. The active geometry, mode, camera and map identity stay the same. The sketch closes with four corners and reopens with identical coordinates. |
| Manual switch, fallback and Retry during a vertex drag | Chrome starts dragging a vertex while B is visible, switches to A with the mouse still down, receives a tile 503 and automatically renders B, then retries A. The held edit, mode, camera and original canvas survive. The vertex reaches the intended release point and its final coordinates survive a reopen. |
| Local-only execution | The browser checks the rendered colors and observes the 503. The suite fails on any external HTTP request or unexpected browser error. Both recovery cases use a deliberately moved, zoomed, rotated and tilted camera. |

## Step 0 items that still need staging

- Use the restricted browser key on a staging build under its real Content Security Policy. Open a Google Map Tiles session and render tiles. Exercise live fallback to USDA and Mapbox with their actual credits and verify their token scopes, request counts and quotas.
- Verify Static Maps at 640 × 640, scale 2, including browser access to the image bytes and PDF embedding. Check bad key, quota and malformed-outline responses and distinguish an error or warning image from a usable picture.
- Confirm Places autocomplete and place details. Hand-test drawing, dragging, switching and outage recovery on the oldest work phone inside the installed staging app. Repeat a desktop hand test against the deployed build.

The prototype simulates one provider outage and restores the healthy route on Retry. Persistent outages, the full provider chain and blank-map fallback, deployed security policy, phone touch behavior and CRX field persistence remain unverified. The shared engine swap waits until the Step 0 staging checks pass.
