#!/usr/bin/env node
/**
 * Standing undo-path regression suite: reversing, voiding, cancelling, unposting and reopening money
 * and inventory records puts totals, balances and stock back exactly, a same-key retry changes
 * nothing twice, a wrong-role user is refused, and undoing an already-undone record is refused.
 *
 * Builds ONE disposable database (checked-in baseline + every migration on this checkout, see
 * harness.mjs) and runs each area file against it. Each area seeds its own committed fixtures under
 * its own ids and checks every action in rolled-back probes.
 *
 * Run all:   npm run proof:undo-paths            (needs Docker; no network, never touches live)
 * Run some:  node scripts/smoke/undo-paths/run.mjs invoices deliveries
 * Reuse a built database while writing tests: UNDO_PATHS_CONTAINER=<name> UNDO_PATHS_REUSE=1 (it is
 * then left running; remove it yourself by name).
 * Prints UNDO_PATHS_PROOF_PASS on success.
 */
import { buildContainer, removeContainer, seedUsers, NAME } from './harness.mjs';

const AREAS = ['invoices', 'deliveries', 'purchasing', 'payables', 'returns', 'periods-pricing', 'commission'];
const picked = process.argv.slice(2);
for (const a of picked) if (!AREAS.includes(a)) throw new Error(`unknown area ${a}; one of ${AREAS.join(', ')}`);
const reuse = process.env.UNDO_PATHS_REUSE === '1';

try {
  if (!reuse) { buildContainer(); seedUsers(); }
  for (const area of picked.length ? picked : AREAS) {
    const mod = await import(`./${area}.mjs`);
    console.log(`\n[undo-paths] === ${area} ===`);
    mod.run();
    console.log(`[undo-paths] ${area}: PASS`);
  }
  console.log('\nUNDO_PATHS_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
  else console.log(`[undo-paths] left ${NAME} running (UNDO_PATHS_REUSE=1)`);
}
