# Map engine swap — behavior contract

**Read at:** `1ff7bc7e2ce7f3797b29a11956f8e8937aa338df` (`feat/maps-step1-engine-swap`)

## Outcome and authority

Replace the live-map renderer with MapLibre GL 6.19.0 and `react-map-gl/maplibre`, preserving all current map callers and field editing. Use a local blank style. Mapbox style changes update its raster source in place; switching providers toggles the two provider layers without remounting the map or reloading its style. Both paths keep the map instance, camera, field overlays, draw layers, and an unsaved sketch or drag. Saved picture preference is browser-local. Missing or failed Mapbox imagery displays USDA and a quiet notice without replacing the preference; a later map open retries the saved preference.

Keep the existing Field Setup → `DrawLayer` → `DrawControl` → `set_field_boundary` save path. Field Setup roles, field access, obstacle placement, multipart storage, and the server's acreage authority do not change. The latest checked `set_field_boundary` definition (`supabase/migrations/20260623130000_set_field_boundary_rpc.sql`) binds its actor to `auth.uid()`, requires admin or sales rep, locks the field, validates and normalizes Polygon/MultiPolygon geometry, computes geodesic measured acres, applies the existing 0.1–5000 acre band and override, writes the authority columns, and refreshes `field_polygons`. It accepts the existing idempotency key. No schema, RPC, stored geometry format, acreage calculation, print code, or permission change is part of this work.

## State and failure

- A `draw.update` batch must update every feature in that event in one `DrawLayer` state change, matched by its existing `drawId`; a selected multipart drag must not silently keep only the first part.
- Switching into obstacle mode must not pass an interrupted sketch through the app's `draw.create` save callback. The existing static lock remains in force. A sketch does not become persisted until the existing save action and RPC run.
- Initial Draw features load only after the map style and Draw control are ready. No fixed delay is used, and a parent rerender during polygon drawing still cannot replace the current collection.
- The preference is one localStorage key shared by both wrappers. A storage exception uses Satellite. Without a Mapbox token the displayed picture is USDA; Mapbox menu choices are disabled. Mapbox HTTP tile failures fall back after three source errors within ten seconds and are retried on the next map open. Tile URLs and tokens are not logged or sent to Sentry.
- USDA uses 256 px tiles through zoom 16; the map's own max zoom remains unchanged and USDA imagery overzooms above its source maximum. Mapbox uses the specified Satellite, Roads, and Terrain Static Tiles templates at 512 px.
- Picture credits track the displayed provider. Field labels use local map markers with the current white text and black halo; no remote glyph host is introduced.

## Proof cases

- A selected drag emits two updated Polygon features; both saved parts retain their distinct geometry after save and reload. Proof: targeted `DrawControl`/`DrawLayer` tests and local Field Setup walkthrough.
- Entering obstacle mode while a polygon sketch is committable does not call the parent create/save callback. Proof: targeted `DrawControl` test and local Field Setup walkthrough.
- Initial geometry remains pending while the map style is unready and is fully added once `load` fires. Proof: targeted `DrawControl` test and delayed local map load.
- A picture switch during drawing or vertex dragging preserves map identity, draw mode, geometry, and layer order. Proof: step 0 Playwright spec adapted for app engine and local browser walkthrough.
- A missing token or repeated Mapbox HTTP errors displays USDA, the correct attribution and notice, and makes no credential-bearing log entry; the stored choice remains unchanged. Proof: local Docker browser run with no token and Playwright's fake token plus routed tile fixture.
- Each in-scope map opens with imagery, boundaries, and labels; no remote style or glyph request occurs. Proof: requested local screen screenshots and network capture.
- Existing geometry save/reload still goes through `set_field_boundary`; RPC-returned acres and parts match the reopened field. Proof: local Docker Field Setup save/reload.

## Decisions

The renderer, tile templates, fallback, credit text, and unchanged save authority are specified by the user brief and current source. The contract does not rely on a production database query or live-data change.

## Open technical choice

MapLibre 6.19.0's public `RasterTileSource.setTiles()` reloads its source from the original style options, so changing the public `tileSize` or `maxzoom` fields before calling it does not persist those values. One source therefore cannot represent the required 512 px Mapbox tiles and 256 px USDA tiles at their native scales with the public API. After no reply to the technical choice prompt, implementation proceeds with the recommended two-source design: one Mapbox source shared by its three styles and one USDA source. Provider switching changes layer visibility in place. This keeps each provider's native tile size and zoom limit while preserving map behavior; the source-count deviation is flagged for Claude's review.
