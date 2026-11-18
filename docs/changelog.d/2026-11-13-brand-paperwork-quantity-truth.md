## 2026-11-13 — Brand quantities on invoices and delivery paper (#1853)

- A partial ordinary invoice shows recorded brand names and EPA numbers without repeating the full load's brand amounts. Bill Split invoices keep amounts labelled `on the load`. Repeated delivery snapshots on one invoice also omit amounts. Billing totals and the restricted-use register are unchanged.
- Pre-delivery paper names a pick-versus-planned-load mismatch, and the delivery-paper reader pages through all relevant brand events so a late correction is not silently missed.
- Synthetic invoice and delivery PDFs were rendered and text-extracted; focused formatter, event paging and invoice detail DOM tests passed. Full checks and independent reviews are recorded with the branch before delivery.
- This branch is not live. `send-email` bundles the shared invoice PDF and must be deployed with a later approved release; until then, an emailed invoice can differ from an updated in-app download.
