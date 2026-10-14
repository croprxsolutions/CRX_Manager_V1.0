## 2026-10-14 — docs cleanup: restore four rule sentences changed in part 2 (#916)

#916 merged before its final Sol review ran. A post-merge Sol review of its diff flagged four
sentences in rule documents whose edits changed what the rule says, not only a fact. Mason's
instruction for the cleanup was to never reword or loosen a rule, so their original wording is
restored here and each one goes to Mason as a decision instead:

- `docs/manual/AGENT_ONBOARDING.md`: "A destructive migration is refused for agents and Mason
  applies it himself" (restored). #916 had said the agent applies it after Mason's `I approve`
  reply, which is how `AGENTS.md`, `.claude/commands/ship.md` and the apply guard work today.
- `docs/manual/AGENT_ONBOARDING.md`: the push-guard is again described as requiring "a Codex
  verdict before a risky push" (restored; #916 had narrowed it to pushes to `main`).
- `docs/manual/OWNER_PLAYBOOK.md`: "If the correction deletes data, the agent cannot apply it — it
  hands it to you" (restored).
- `docs/reference/coderabbit-native-review.md`: the fix-loop paragraph and its "Never post
  `@coderabbitai` commands by hand" sentence (restored exactly; #916 had added the once-per-head
  `@coderabbitai review` exception that `AGENTS.md` and the page's own banner already state).

Every other #916 correction stays.
