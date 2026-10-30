## 2026-10-30 - Prune the applied order-version trigger inventory entry

The live schema refresh records the already-applied order-version migration. Its private trigger is therefore no longer part of the unapplied function inventory and needs no exemption there. Remove that stale entry while retaining the new, still-unapplied invoice-first trigger classification. The guard continues to reject unused exemptions and unclassified callable mutators.
