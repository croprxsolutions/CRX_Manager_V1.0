#!/usr/bin/env node
/** Container-only proof of KI-10 operations batch 4e on the live post-4d state. */
import { proveReplayBinding } from './prove-replay-binding-batch4de-common.mjs';

proveReplayBinding({
  tag: '4e',
  specKey: 'ops_replay_binding_batch4e',
  pass: 'OPS_REPLAY_BINDING_BATCH4E_PROOF_PASS',
  first: 'record_job_post_notifications',
  candidate: '20261123110000_bind_ops_replay_receipts_batch4e.sql',
  other: '20261114200000_bind_records_replay_receipts_batch4d.sql',
  // Batch 4d is live (ledger 20261106035950): replay it into the baseline; 4e applies on top.
  otherInBaseline: true,
  chain: 'smoke-ops-replay-binding-batch4e.sql',
});
