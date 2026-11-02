**LOCAL CANDIDATE — NOT APPLIED.** `20261102230000_chicago_season_and_statement_dates.sql` (SQL sha256: `54902fd8aa1b2d4a7f54a95e1b1420a036ec088a51d0a5f7ba64b6f5e66bf674`). `current_season()` reads the America/Chicago date instead of the UTC date, and the customer statement dates prepay applications and undated payment allocation sets by the Chicago date. Two read-only functions; no table, grant or data change; both live bodies are pinned (md5) before the edit.

Rollback: a reviewed migration restoring the two pinned bodies. Proof: `scripts/smoke/prove-chicago-season-and-statement.mjs`.

**Live capture — 2026-11-02 (read-only ledger query):** effective high-water is `20261102200000` (`cost_definer_leaks_closed`, recorded as version `20261102183928`); this candidate's stamp follows it. Re-read before applying.
