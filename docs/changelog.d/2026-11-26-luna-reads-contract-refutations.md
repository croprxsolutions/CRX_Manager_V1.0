## 2026-11-26 - Luna reads the plan contract's refuted findings

A Luna round with no `--settled` file now gets, as its settled list, the review sections (cold challenge,
peer review, Luna and Sol rounds, anything headed refuted, settled, answered or decided) of every
`docs/plans/*-CONTRACT.md` in the diff, minus lines already marked fixed, headed "already decided; do not
re-raise unless the code changed". On PR #2610 Luna rounds 3 and 4 repeated findings the contract had
already refuted because nobody passed `--settled` (retro item 2). It uses the same untrusted-data section
and 8 KB cap as `--settled`; over the cap it is not sent and the result says so. `--settled` still wins.
Sol and Terra never see it, and without a contract in the diff the prompt is unchanged.
