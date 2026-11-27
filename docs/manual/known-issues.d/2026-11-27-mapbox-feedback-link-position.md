## 2026-11-27 — "Improve this map" opens Mapbox feedback without the map's position

**Severity:** LOW. **Area:** Maps. **Status:** OPEN.
**Owner:** unassigned. **Tracked:** #2703 (Taha's delta review, LOW 2).

After the MapLibre engine swap, the "Improve this map" credit link opens Mapbox's feedback page at a fixed address. The old mapbox-gl engine, and the step 0 proof, added the map's center and zoom to the link, so the page opened at the place on screen. Now a user reporting a wrong road name has to find the place again by hand.

A first fix, which set the link from the map's position when it was tapped, was dropped from #2703. With it, the Field Setup corner-drag walkthrough failed in both lanes. With it switched off, that walkthrough passed. Find out why before you retry, and prove the fix with `scripts/local-app/e2e/maps-step1.spec.ts` in both lanes.

On a 390 px phone, "Improve this map" also wraps onto a second credit line. That is cosmetic.
