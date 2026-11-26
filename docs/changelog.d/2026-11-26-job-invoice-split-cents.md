## 2026-11-26 - Job invoices split between owners add up to the job's line, to the cent

- Create Invoice on a job billed to several owners now rounds each chemical line once, as a single invoice would, and hands the cents to the owners by acre share (largest remainder). The owners' lines always add up to the line, and each owner is within a cent of its exact share.
- Before: 10 Gal at $10.00 split 50.01% / 50.00% billed $100.01 for a $100.00 line, and 10 Gal at $12.34 split in thirds billed $123.39 for $123.40 (each owner was rounded on its own since the 2026-11-22 redesign).
- Never $0 (Mason, 2026-11-22): an owner with a quantity always bills at least 1 cent when the line has enough cents (3 cents across three owners bill 1 + 1 + 1, where the old split billed 4 cents). A line with fewer cents than owners is still refused by name, as before.
- Quantities, prices, costs, the 50-cent checks, the per-acre fee, who is the main payer and one-owner invoices are unchanged. An owner's commission base is its amount less its cost, so it follows the owner's amount and can move by a cent.
- Known limit: each owner's booked cost is still its own cost x quantity, so the owners' costs can differ from the whole line's by under a cent each (tying them needs a stored booked cost, a schema change).
- Mason, 2026-11-26 (Slack): "Job-invoice cents: yes please, fix it before Dec 15".
- Migration `20270311200000_job_invoice_split_cents` (no row changes). Proof: `node scripts/smoke/prove-job-invoice-split-cents-real-schema.mjs`.
