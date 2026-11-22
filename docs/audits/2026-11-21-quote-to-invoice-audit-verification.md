# Quote-to-invoice audit: independent verification (2026-11-21)

Independent Claude re-check of the seven Codex quote-to-invoice audit reports (plus the reconciliation and two Terra checks). The reports were treated as untrusted leads: every claim was re-read against current source and, where safe, read-only production data. Private evidence (customer records, amounts) stays outside this repo; this page holds only public-safe conclusions.

**Baselines.** Production code = `origin/main` 00003d8a2. Staging = `origin/staging` f08df8ad6. Live migration ledger high-water `20261121061349`. "Live" below means confirmed in that ledger or by a read-only production query.

**Verdict words.** CONFIRMED (true on main and staging), STAGING-FIXED (true on main, fixed on staging, not yet released), TRACKED (true, already covered), CLOSED (fixed live), NARROWED (partly true), DATA REVIEW (needs a records check, not code).

## Claim register

| Claim | Report | Verdict | Where it is now | Tracker |
|---|---|---|---|---|
| P1 Piksi Dust Plus rate unit wrong | 1 Product master | CONFIRMED live (18 MG vs label text "18 grams per Acre"; on 4 March 2026 order lines, none rate-based) | Needs Mason's label check | KI-114, #1958 |
| P2 Name and EPA on split re-save and PDFs (the split writer falls back to the live name and omits EPA; the PDF mapper prefers the live name and falls back to live EPA only when the saved one is blank, `supabase/functions/_shared/pdf/invoicePdf.ts` ~L98-112) | 1 | TRACKED | Open | KI-157, KI-117 (path refreshed to `20270129171000`) |
| P3 Application Report ignores saved EPA number | 1 | CONFIRMED | Open | **KI-195**, To-Do 10.10, #2183 |
| P4/P5 Search, labels, Summary grouping | 1 | CONFIRMED (LOW) | Open | **KI-196** |
| P6 Catalog gaps (missing EPA, units, sizes) | 1 | TRACKED (report's KI-30 link is wrong) | Open | To-Do decision 27 (catalog gaps); KI-138 covers container sizes only |
| C1 P&L commission on billed share | 2 Pricing and cost | STAGING-FIXED (#2149) | Awaiting release | KI-125, To-Do 2.16 |
| C2 Commission basis | 2 | TRACKED; added: commission figured before the standing discount | Open | KI-154, KI-13, KI-184, To-Do 8.5 |
| C3 Stale PO cost / C6 receipt-date label | 2 | CONFIRMED (LOW) | Open | **KI-197** |
| C4 Return after repriced line credits order price (discounted and taxed returns too) | 2 | CONFIRMED (0 of 6 eligible live lines differ today) | Open | **KI-189**, To-Do 7.6, #2180 |
| C5 Month-End commission | 2 | STAGING-FIXED (#2149) | Awaiting release | KI-126, KI-130 |
| C7 Vendor-bill value check | 2 | TRACKED | Open | KI-151 |
| Q1/Q6 Duplicate/template quote sent without repricing | 3 Quote builder | CONFIRMED | Open | **KI-193**, To-Do 1.14, #2182 |
| Q2/Q3 Smaller send gaps | 3 | NARROWED (LOW) | Open | **KI-194** |
| Q4 Which version prices earlier field work | 3 | TRACKED | Needs decision 32 | #2075, #1966 (KI-177 related) |
| Q5 Unit falls back to "Ea" | 3 | TRACKED | Open | KI-166 |
| Q7 Quote PDF items / footer | 3 | Items fixed (#1892); footer open (mapping as reported by the audit) | Open | #1881 |
| B1 Partial Order uses current, not reviewed, terms | 4 Quote to order | CONFIRMED (no partial orders live) | Open | **KI-190**, To-Do 1.13, #2181 |
| B2/B3 Booking changes with a live job | 4 | TRACKED | Bookings Phase B | D1, #2065 |
| B4 Converted orders have no salesperson | 4 | CONFIRMED live (no trigger fills it) | Needs decision 30 | **KI-191**, To-Do 1.15 |
| B5 "Left to draw" dollars use an average price | 4 | CONFIRMED | Open | **KI-192** (D2) |
| B6 Booking follow-up (Phase B) | 4 | TRACKED | Bookings Phase B | #2097 |
| S1 Stale partial delivery accepted | 5 Chemical sales | STAGING-FIXED (#2045) | Awaiting release | **KI-199**, To-Do 2.16 |
| S2 Cancelled/voided follow-up leaves Remainders queue | 5 | CONFIRMED (reproduced by the audit; no remainder rows live) | Open | **KI-188**, To-Do 2.15, #2179 |
| S3/S4 Commission | 5 | Same as C1/C2 | — | KI-125, KI-154 |
| S5 Void filters to draft and posted | 5 | TRACKED | Open | KI-128 |
| S6 Field-invoice void remainder | 5 | TRACKED (mapping as reported by the audit; KI-03 has a field-invoice subset) | Open | KI-03 |
| S7 Void keeps write-offs | 5 | CLOSED (live void body reverses write-offs; 0 write-offs exist) | Closed | KI-99 → Closed list |
| S8 Two deliveries with inactive prior invoices | 5 | DATA REVIEW, not re-run | Office review | To-Do 15.1 (S8 check added) |
| F1 Job bills planned acres | 6 Field application | CONFIRMED (one unposted live draft shows it) | Needs decision 33 | **KI-185**, To-Do 5.7, #2176 |
| F2 Ticket and job both bill: a blend invoice then the linked job through per-line split (#2063); Transfer after a soft-deleted ticket's live invoice (#2061, reachable only from already-inconsistent old data: soft deletion is refused while an active invoice exists) | 6 | TRACKED | Open | #2061, #2063 |
| F3 Blend ticket + job both deduct stock | 6 | CONFIRMED (latent: no live tickets) | Open | **KI-187**, To-Do 5.8, #2178 |
| F4 Field-draft payer change | 6 | STAGING-FIXED (#2142, #2171; #2164 closed) | Awaiting release | **KI-199** |
| F5 Carrier water dropped on transfer | 6 | CONFIRMED | Open | **KI-186**, To-Do 5.7, #2177 |
| F6 Cross-invoice cap and rounding | 6 | TRACKED | Open | #1926, #2105, #2139, To-Do 5.3 |
| W1 | 7 Walkthrough | Same as C1 | — | KI-125 |
| W2 Commission clawback | 7 | TRACKED | Open | KI-13 |
| W3 Shared-field job price | 7 | CONFIRMED | Needs decision 31 | **KI-198** |
| W4 Unit price / one-invoice confirmation | 7 | CONFIRMED | Open | **KI-186**, #2177 |
| T1 | Terra | Same as Q4 | — | #2075 |
| T2 Partial-delivery cost rounding | Terra | CONFIRMED (LOW) | Open | KI-16 (bullet added) |

## Coverage

Each claim ID counted once (46 IDs). Grouped IDs (P4/P5, C3/C6, Q1/Q6, Q2/Q3, B2/B3, F5+W4) count as separate IDs.

| Report | IDs | Confirmed, newly tracked | Already tracked | Fixed on staging | Closed live | Narrowed / mixed | Needs data or label check |
|---|---|---|---|---|---|---|---|
| 1 Product master | 6 (P1-P6) | 3 (P3, P4, P5) | 2 (P2, P6) | 0 | 0 | 0 | 1 (P1) |
| 2 Pricing and cost | 7 (C1-C7) | 3 (C3, C4, C6) | 2 (C2, C7) | 2 (C1, C5) | 0 | 0 | 0 |
| 3 Quote builder | 7 (Q1-Q7) | 2 (Q1, Q6) | 2 (Q4, Q5) | 0 | 0 | 3 (Q2, Q3 narrowed; Q7 mixed) | 0 |
| 4 Quote to order | 6 (B1-B6) | 3 (B1, B4, B5) | 3 (B2, B3, B6) | 0 | 0 | 0 | 0 |
| 5 Chemical sales | 8 (S1-S8) | 1 (S2) | 3 (S4, S5, S6) | 2 (S1, S3) | 1 (S7) | 0 | 1 (S8) |
| 6 Field application | 6 (F1-F6) | 3 (F1, F3, F5) | 2 (F2, F6) | 1 (F4) | 0 | 0 | 0 |
| 7 Walkthrough | 4 (W1-W4) | 2 (W3, W4) | 1 (W2) | 1 (W1) | 0 | 0 | 0 |
| Terra | 2 (T1, T2) | 1 (T2) | 1 (T1) | 0 | 0 | 0 | 0 |

New tracker entries: KI-185 to KI-199 (15) and issues #2176 to #2183 (8).

## Sol review (2026-11-21)

An independent Sol (gpt-6.2-sol, high) pass over this change, with production and staging source, returned 33 findings and refuted no defect. Corrections applied: the C4 return exemption (HIGH), the decision 30 salesperson guard (HIGH), proof criteria for F1, F5, S2, Q1, Q6, B1, KI-199, citation paths (shared PDF renderer, S2 per-branch completion, T2 main lines, W3 pricing path), status words, the KI-99 closed-list placement, coverage recount, and decision 15. Not changed, with reasons: the reviewer-directed text it flagged is in existing migrations and docs, not this change; owner names (Mason, Taha) are used throughout this public repo by design and are not customer data; KI-100 and KI-85 ID collisions predate this change; the open and closed totals are carried forward from the file and adjusted only by the verified deltas (+14 open, +1 closed, KI-99), as the file has no stricter counting rule; #1966's wording was confirmed from the issue text.

**Round 2.** A second Sol pass confirmed 18 corrections and 2 refutations; 13 round-1 points were still open and 5 were new, all wording, scope and proof criteria: split returns on a repriced line (KI-189), the conversion-only salesperson rule (decision 30), all three carrier-water writers, both outcomes of the remainder proof, the two quote-price fixtures, the sent proof and applicator sheet in KI-195, decision 31's eligibility rules, KI-199's evidence split, two email-outcome messages, and citations. Applied; round 3 found six of them only partly resolved.

**Round 3.** Sol confirmed decision 30, carrier-water scope, the quote fixtures, EPA output scope, KI-199's browser proof, P2, the email messages, F2, B1 and KI-197, and accepted the totals and the packet-text point (about the review input, not this change). Its 10 remaining points were applied as the final pass (Mason, 2026-11-21, no fourth round): split returns narrowed (split invoices refuse repricing; refusal only when no billed quantity remains), the remainder proof, decision 31's fallback and conflict rules, the P6 and S6 mappings, an S8 office check, the To-Do 8.5 acceptance checks, release row 2.16, EPA "not recorded" proof, #2061's old-data condition, and one citation.

## Limits

- Source verdicts are by reading code; no change was run against a database in this pass. The audit's own reproductions were not re-run: S2 in an isolated database, Q1 with stubbed calls (both reported evidence).
- Production checks were read-only aggregate queries; S8 was not re-run.
- Side findings not edited here: KI-161 and KI-163 call `20270126110000` "not applied live" but it is live; the KI-99 migration record still says not applied; KI-156's two migrations are both live, so it may be closeable.
