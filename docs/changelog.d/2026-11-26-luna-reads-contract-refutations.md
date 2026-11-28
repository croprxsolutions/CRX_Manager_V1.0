## 2026-11-26 - Luna reads the plan contract's refuted findings

A Luna round with no `--settled` file now gets, as its settled list, the `## Settled for Luna` section of
every `docs/plans/*-CONTRACT.md` in the diff: one line per refuted or deferred finding, written by the
author, headed "from the plan contract; same rules as the settled list". Whole review sections are never
sent, so fixed findings and open items cannot be marked settled (Taha, #2669 MED 1). Branch and
`--commit` rounds read the contract at the reviewed commit; only `--uncommitted` reads the disk (MED 2).
On PR #2610 Luna rounds 3 and 4 repeated findings the contract had already refuted because nobody passed
`--settled` (retro item 2). It uses the same untrusted-data section and 8 KB cap as `--settled`; over
the cap it is not sent and the result says so. `--settled` still wins. Sol and Terra never see it, and
without such a section in the diff the prompt is unchanged.
