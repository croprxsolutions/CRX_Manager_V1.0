# Better Product Labels — Step 0 findings

24 November 2026, US Central. CRX staging source `59280e2e7` and read-only Supabase results.

The read-only count found effective brand entries without dedicated manufacturer links, active liquid groups without an approved weight, and multi-brand liquid groups with an existing approved weight that need a one-time review. The exact counts and group worklist are retained privately.

The live grouping switch is on. Grouped products read active rows from `product_parent_brands`. Ungrouped products read their own rows from `product_brands`. Neither path has dedicated manufacturer label or SDS fields. The count uses the effective brand list and excludes old standalone rows for grouped products. Some products need a brand entry before an admin can add per-brand links.

## What staff see when a weight is missing

- **Blend Ticket Detail and manual ticket entry.** A product line says that it has no approved weight, and the ticket withholds its product-weight total when a positive-quantity line lacks weight. A saved ticket that captured no weight says that it had no approved weight when saved, even after a weight is approved later. See `src/lib/blendTicketWeights.ts` and `src/pages/BlendTicketDetail.tsx`.
- **Blend Tickets PDF export.** The current file lists ticket headers and status. It has no per-product weights or product-weight total. The detail screen has no dedicated Print/PDF action. See `src/pages/BlendTickets.tsx`.
- **Loader Worksheet PDF.** The amount still prints. The product line prints the missing-weight reason, and the load prints “Product weight not shown” with the reason when a positive-quantity line lacks weight. See `src/lib/loaderWorksheetPdf.ts` and `src/lib/loaderWeights.ts`.

Five focused test files passed, 84 tests total. The current detail and loader output already flag missing weights. Staging browser proof for the new lifecycle remains part of Step 2. Mason confirmed that Step 2 must verify these outputs and add a printable Blend Ticket Detail.
