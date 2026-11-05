#!/usr/bin/env node
/** Container-only, both-order proof of KI-10 operations batch 4c. */
import { proveReplayBinding } from './prove-replay-binding-batch4de-common.mjs';

proveReplayBinding({
  tag: '4e',
  specKey: 'ops_replay_binding_batch4e',
  pass: 'OPS_REPLAY_BINDING_BATCH4E_PROOF_PASS',
  first: 'record_job_post_notifications',
  candidate: '20261111210000_bind_ops_replay_receipts_batch4e.sql',
  other: '20261111200000_bind_records_replay_receipts_batch4d.sql',
  chain: 'smoke-ops-replay-binding-batch4e.sql',
});
