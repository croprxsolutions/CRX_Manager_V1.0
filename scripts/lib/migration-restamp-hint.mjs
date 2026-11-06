// The next step after the ordering guard refuses a migration because a newer stamp is live.
// A hand-picked restamp collided with a peer worktree's stamp (PR #1495, 2026-11-05);
// next-migration-stamp checks main, every worktree and every open PR.
export function withRestampHint(reason) {
  const text = String(reason ?? "");
  if (!/MIGRATION ORDERING GUARD: refusing to apply "/.test(text)) return text;
  const newest = text.match(/but (\d{14}) has ALREADY BEEN APPLIED/)?.[1];
  return `${text}\n\nIf this is a pending migration that a newer one overtook, restamp it (ship.md: "A restamp keeps the reviews"):\n` +
    `  1. Pick the stamp: npm run next-migration-stamp -- --live ${newest || "<newest live stamp>"}\n` +
    `  2. ONE commit: rename the .sql (byte-identical) and its migrations.d record; replace the old stamp in every other file.\n` +
    `  3. node scripts/write-codex-push-proof.mjs --carry-restamp, then node scripts/write-apply-proofs.mjs --restamp-from <old-name> <new-name>\n` +
    `  4. Push, wait for green checks, then ask Mason again: his approval does not carry to the new stamp.`;
}
