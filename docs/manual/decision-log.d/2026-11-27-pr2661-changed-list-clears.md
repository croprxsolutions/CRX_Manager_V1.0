## 2026-11-27 — Record Payments: a re-pick that finds the invoice list changed clears the amounts (#2661)

**Decision (Mason, 2026-11-27, in chat: "whatever you recommend", on Sol's round-6 HIGH for #2661; the recommendation was to clear only when the list changed):** when re-picking the same farm reloads its open invoices and the list or any balance has changed, the typed allocations clear and a warning tells the clerk to allocate again. When nothing changed, the allocations stay. The check amount and number stay in both cases.
**Why:** amounts allocated against an older list could pay a newer invoice ahead of an older one posted since.
**What this forbids/implies:** this allows one more Sol round on #2661, on the head with this rule. A further round needs a new decision from Mason.
