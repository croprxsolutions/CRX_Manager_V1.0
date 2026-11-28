## 2026-11-24 - Manufacturer links by brand

- The database can store a specimen label, a safety data sheet, and supplemental links with state and expiration for each brand. Admins enter and correct links. Staff can report a broken link. Reports and admin resolutions leave an append-only history.
- Agreeing links carry into new groups. Conflicting links stop the grouping or size move and identify the brand and document to reconcile.
- Migration `20270306170000_brand_document_links.sql`. The product screens and workbook are a separate change.
