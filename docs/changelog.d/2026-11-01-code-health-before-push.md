## 2026-11-01 - Run the code-health size check before pushing

- `npm run check:code-health` is now in the Product Master mission's "before every commit" list and in `ship.md` Step 2, so a function or file over the size limit fails locally rather than in CI.
- Why: PR #1245 failed CI's code-health check after it was pushed, because the check was not in the mission's list, and that cost one of the package's three build rounds. The round limit itself is unchanged.
- This changes written instructions only. Nothing enforces the local run; CI's code-health check remains the hard stop.
