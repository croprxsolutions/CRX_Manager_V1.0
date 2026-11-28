## 2026-11-25 - Agent guidance size check ignores Windows line endings

`npm run check:agent-guidance` measured `AGENTS.md` and `CLAUDE.md` against their startup-context byte budgets as checked out. On Windows (`core.autocrlf=true`) each line gains a carriage return, so `AGENTS.md` measured 12060 bytes against its 12000 budget while the committed file is 11978 bytes; CI on Linux passed. The check now measures the text with Windows line endings converted to plain line feeds, and a built-in self-check proves both forms count the same. Budgets and `AGENTS.md` are unchanged.
