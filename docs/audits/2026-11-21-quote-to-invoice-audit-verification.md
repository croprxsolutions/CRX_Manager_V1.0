# Quote-to-invoice audit: independent verification (2026-11-21)

Independent Claude re-check of the seven Codex quote-to-invoice audit reports (plus the reconciliation and two Terra checks). The reports were treated as untrusted leads: every claim was re-read against current source and, where safe, read-only production data. Private evidence (customer records, amounts) stays outside this repo; this page holds only public-safe conclusions.

**Baselines.** Production code = `origin/main` 00003d8a2. Staging = `origin/staging` f08df8ad6. Live migration ledger high-water `20261121061349`. "Live" below means confirmed in that ledger or by a read-only production query.

**Verdict words.** CONFIRMED (true on main and staging), STAGING-FIXED (true on main, fixed on staging, not yet released), TRACKED (true, already covered), CLOSED (fixed live), NARROWED (partly true), DATA REVIEW (needs a records check, not code).

## Claim register

| Claim | Report | Verdict | Where it is now | Tracker |
|---|---|---|---|---|
| P1 Piksi Dust Plus rate unit wrong | 1 Product master | CONFIRMED live (18 MG vs label text "18 grams per Acre"; on 4 March 2026 order lines, none rate-based) | Needs Mason's label check | KI-114, #1958 |
| P2 Printouts use current product name/EPA | 1 | TRACKED | Open | KI-157, KI-117 (path refreshed to `20270129171000`) |
| P3 Application Report ignores saved EPA number | 1 | CONFIRMED | Open | **KI-195**, To-Do 10.10, #2183 |
| P4/P5 Search, labels, Summary grouping | 1 | CONFIRMED (LOW) | Open | **KI-196** |
| P6 Catalog gaps | 1 | TRACKED (report's KI-30 link is wrong) | Open | KI-138 |
| C1 P&L commission on billed share | 2 Pricing and cost | STAGING-FIXED (#2149) | Awaiting release | KI-125, To-Do 2.16 |
| C2 Commission basis | 2 | TRACKED; added: commission figured before the standing discount | Open | KI-154, KI-13, KI-184, To-Do 8.5 |
| C3 Stale PO cost / C6 receipt-date label | 2 | CONFIRMED (LOW) | Open | **KI-197** |
| C4 Return after repriced line credits order price | 2 | CONFIRMED (0 of 6 eligible live lines differ today) | Open | **KI-189**, To-Do 7.6, #2180 |
| C5 Month-End commission | 2 | STAGING-FIXED (#2149) | Awaiting release | KI-126, KI-130 |
| C7 | 2 | TRACKED | Open | KI-151 |
| Q1/Q6 Duplicate/template quote sent without repricing | 3 Quote builder | CONFIRMED | Open | **KI-193**, To-Do 1.14, #2182 |
| Q2/Q3 Smaller send gaps | 3 | NARROWED (LOW) | Open | **KI-194** |
| Q4 Which version prices earlier field work | 3 | TRACKED | Needs decision 32 | #2075, #1966, KI-177 |
| Q5 | 3 | TRACKED | Open | KI-166 |
| Q7 Quote PDF items / footer | 3 | Items fixed (#1892); footer open | Open | #1881 |
| B1 Partial Order uses current, not reviewed, terms | 4 Quote to order | CONFIRMED (no partial orders live) | Open | **KI-190**, To-Do 1.13, #2181 |
| B2/B3 | 4 | TRACKED | Bookings Phase B | D1, #2065 |
| B4 Converted orders have no salesperson | 4 | CONFIRMED live (no trigger fills it) | Needs decision 30 | **KI-191**, To-Do 1.15 |
| B5 | 4 | CONFIRMED | Open | **KI-192** (D2) |
| B6 | 4 | TRACKED | Bookings Phase B | #2097 |
| S1 Stale partial delivery accepted | 5 Chemical sales | STAGING-FIXED (#2045) | Awaiting release | **KI-199**, To-Do 2.16 |
| S2 Cancelled/voided follow-up leaves Remainders queue | 5 | CONFIRMED (reproduced by the audit; no remainder rows live) | Open | **KI-188**, To-Do 2.15, #2179 |
| S3/S4 Commission | 5 | Same as C1/C2 | — | KI-125, KI-154 |
| S5 | 5 | TRACKED | Open | KI-128 |
| S6 | 5 | TRACKED | Open | KI-03 |
| S7 Void keeps write-offs | 5 | CLOSED (live void body reverses write-offs; 0 write-offs exist) | Closed | KI-99 → Closed list |
| S8 Two deliveries with inactive prior invoices | 5 | DATA REVIEW, not re-run | Office review | To-Do 15.1 |
| F1 Job bills planned acres | 6 Field application | CONFIRMED (one unposted live draft shows it) | Needs decision 33 | **KI-185**, To-Do 5.7, #2176 |
| F2 | 6 | TRACKED | Open | #2061, #2063 |
| F3 Blend ticket + job both deduct stock | 6 | CONFIRMED (latent: no live tickets) | Open | **KI-187**, To-Do 5.8, #2178 |
| F4 Field-draft payer change | 6 | STAGING-FIXED (#2142, #2171; #2164 closed) | Awaiting release | **KI-199** |
| F5 Carrier water dropped on transfer | 6 | CONFIRMED | Open | **KI-186**, To-Do 5.7, #2177 |
| F6 | 6 | TRACKED | Open | #1926, #2105, #2139, To-Do 5.3 |
| W1 | 7 Walkthrough | Same as C1 | — | KI-125 |
| W2 | 7 | TRACKED | Open | KI-13 |
| W3 Shared-field job price | 7 | CONFIRMED | Needs decision 31 | **KI-198** |
| W4 Unit price / one-invoice confirmation | 7 | CONFIRMED | Open | **KI-186**, #2177 |
| T1 | Terra | Same as Q4 | — | #2075 |
| T2 Partial-delivery cost rounding | Terra | CONFIRMED (LOW) | Open | KI-16 (bullet added) |

## Coverage

| Report | Claims checked | Confirmed new | Already tracked | Staging-fixed | Closed | Data review |
|---|---|---|---|---|---|---|
| 1 Product master | 6 | 2 (P3, P4/P5) | 3 | 0 | 0 | 0 (P1 needs label check) |
| 2 Pricing and cost | 7 | 2 (C3/C6, C4) | 2 | 2 | 0 | 0 |
| 3 Quote builder | 6 | 2 (Q1/Q6, Q2/Q3) | 3 | 0 | 0 | 0 (Q7 part-fixed) |
| 4 Quote to order | 6 | 3 (B1, B4, B5) | 3 | 0 | 0 | 0 |
| 5 Chemical sales | 8 | 1 (S2) | 4 | 1 | 1 | 1 |
| 6 Field application | 6 | 3 (F1, F3, F5) | 2 | 1 | 0 | 0 |
| 7 Walkthrough | 4 | 1 (W3) | 3 | 0 | 0 | 0 |
| Terra | 2 | 1 (T2) | 1 | 0 | 0 | 0 |

## Limits

- Source verdicts are by reading code; no change was run against a database in this pass. The audit's own isolated-database reproductions (S2, Q1) were not re-run.
- Production checks were read-only aggregate queries; S8 was not re-run.
- Side findings not edited here: KI-161 and KI-163 call `20270126110000` "not applied live" but it is live; the KI-99 migration record still says not applied; KI-156's two migrations are both live, so it may be closeable.
