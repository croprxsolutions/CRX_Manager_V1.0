## 2026-11-03 - Script to re-key reviewed cost-sweep allowlist entries

- New `scripts/db-invariant-sweeps/rekey-allowlist.mjs` replaces the hand re-keying done for PRs #1300, #1318 and #1327: after a shared helper changes and a human re-reads the chain live, it reads the saved `db-sweeps:live` output, swaps each same-signature entry's key and appends the dated note.
- It refuses and writes nothing on an empty note, a brand-new function, or a signature shared by two entries. No change to any sweep predicate, to what counts as a violation, or to the live database.
- `rekey-allowlist.test.mjs` runs in `test:correction-guards`; replaying #1327's 21 re-keys reproduces that commit's allowlist byte for byte.
