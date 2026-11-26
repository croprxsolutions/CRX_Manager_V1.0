## 2026-11-25 - Migrations restamp once, at merge time, by the merge captain

- `.claude/commands/ship.md` step 4b: the merge captain restamps a migration PR once, right before merging, when staging moved past its stamp. Authors and CI watchers no longer restamp a waiting PR (#2539 was restamped three times in one day). `docs/reference/sol-proof-mechanics.md` points to it.
- Unchanged (Mason, 2026-11-25: change 1 only): `--carry-restamp` still needs the restamp commit directly on the reviewed head; the PR stamp check (a new stamp must be newer than everything on staging); the live in-order rule; the apply proof gate; every merge gate. No code or `.github/` change.
