## 2026-11-17 — Bookings with a spray job can be saved again (sections keep their ids)

- New migration `20270124100000_save_quote_keeps_section_ids.sql` (not applied live; record in `docs/reference/migrations.d/`).
- Saving a booking whose section has a spray job failed with a raw database error. The save now keeps each section's id, so the job stays linked to its section.
- The order screen sends each section's saved id (marker `section_ids_v1`) and installs the ids the save returns. A save that would drop a section a job was scheduled from is refused in plain English, naming the job. Restoring an earlier version of a booking with a job shows a plain message instead of "Failed to restore version".
- While a live spray job comes from a booking, its customer cannot change, and the job's own section keeps its products, quantities, prices and field (name, notes and needed-by date may change). This keeps the job and both invoice paths at what was booked (Sol round 1). A cancelled job releases the lock.
- The lock also holds each line's id, order and quote-time cost, and the section's place, so swapping or reordering lines cannot move what the job and partial orders are priced from; an empty value counts as a value (Sol round 2). Schedule job on a section the last save did not return explains how to fix it instead of failing.
- Proof: container prover reproduces the bug before, passes the new chain after, and five existing save_quote chains end exactly as before. Not yet verified on staging.
