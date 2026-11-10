## 2026-11-09 — Use timings become crop + timing pairs; admins can add and retire them (USE-1, database half)

- New migration `20261229120000_product_crop_use_pairs.sql`: a crop list (Corn, Soybeans, Wheat, Milo, Cotton,
  Alfalfa, Pasture/Hay, Range/Pasture/Turf; blank means any crop), one active option per crop + timing, and a new
  "Burndown (preplant)" Herbicide option. Volunteer Corn moves to "any crop"; Range/Pasture/Turf gets its own crop.
  Every product keeps its codes and its saved timing text.
- Two admin-only, retry-safe database calls add an option and turn one off or on (the screens come in the next PR).
  A turned-off option stays on the products that hold it and can no longer be picked; grouped sizes still inherit
  it from their parent. A product or parent can no longer hold the same crop + timing twice.
