# Maps Step 0 proof

This throwaway page uses one MapLibre map, Mapbox Draw, and two solid-color raster tile routes served by Vite. It needs no API key and makes no requests outside the local test server.

MapLibre GL JS 6 ships its map worker as a separate ES module. The Vite setup imports `maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` and passes the emitted URL to `maplibregl.setWorkerUrl()` before creating the map. Vite serves the worker as a same-origin asset. Step 1's app Vite bundle needs the same setup; its Content Security Policy can allow `worker-src 'self'` without `blob:`. The proof's tests check that worker loading produces no external request or browser error.

From the repository root, run:

```powershell
npx playwright test --config=proofs/maps-step0/playwright.config.ts
```

The proof checks polygon drawing, picture switches during drawing and vertex dragging, draw-layer order, and the existing trash/restart expectation. It does not cover real Google tiles, an installed-phone hand test, or the deployed Content Security Policy.
