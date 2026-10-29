## 2026-10-29 — CLAUDE.md notes Mason's user-level plugins

Mason: "are there any notes in our crx manager we need to make to acknoledge our use of
ponytail, context 7, impecibble etc", then "Yes, open the PR".

- `CLAUDE.md` gains a short "User-Level Plugins" section: Context7, Ponytail, and Impeccable
  live in Mason's own Claude install, not this repo, so other machines and cloud sessions may
  lack them and no gate may depend on one.
- Ponytail's smallest-change style never overrides `AGENTS.md`, hooks, or gates; Impeccable
  follows `docs/workflows/UI_PATTERNS.md` and does not restyle CRX unasked.
