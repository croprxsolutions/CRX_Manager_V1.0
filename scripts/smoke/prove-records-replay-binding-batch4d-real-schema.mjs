#!/usr/bin/env node
/** Container-only, both-order proof of KI-10 records batch 4d. */
import { proveReplayBinding } from './prove-replay-binding-batch4de-common.mjs';

proveReplayBinding({
  tag: '4d',
  specKey: 'records_replay_binding_batch4d',
  pass: 'RECORDS_REPLAY_BINDING_BATCH4D_PROOF_PASS',
  first: 'save_vendor',
  candidate: '20261114200000_bind_records_replay_receipts_batch4d.sql',
  // 4d is live; 4e (20261123110000) now requires 4d first, so no other-first order is left to prove.
  other: null,
  chain: 'smoke-records-replay-binding-batch4d.sql',
});
