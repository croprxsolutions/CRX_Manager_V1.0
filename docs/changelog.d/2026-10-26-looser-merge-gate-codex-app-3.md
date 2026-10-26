## 2026-10-26 — Looser merge gate: Codex App fix 3 on #1128

Two more spellings from the Codex GitHub App (P2), both fixed in `.claude/hooks/codex-push-lib.mjs` with
cases in `.claude/hooks/guards.test.mjs`:

- Letters glued after a quoted variable (`A=g; M=mer; "$A"h pr "$M"ge 951`): a double quote is now kept
  as a boundary marker in the glue check instead of being deleted, so `"$A"h` reads as glued while
  `"$NODE" x.mjs` still does not.
- Perl's pipe-open (`open my $p, "|-", "gh", @ARGV`) counts as running a program; an ordinary
  `open(my $f, "<", "file")` does not.

This is the last fix round for spellings on this PR. Further spellings of a hidden merge are the
accepted speed-bump residual (`2026-10-26-looser-merge-gate-residual-accepted.md`): reading command
text cannot close them, and GitHub's required checks remain the boundary.
