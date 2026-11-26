## 2026-11-26 — Count-once: retried undo of a zero-move ticket reads already reversed

From Taha's review of PR #2679: a ticket that moved nothing under count once, once reversed, now answers `already_reversed` (not `not_found`) on a retry with a fresh key, because its own write-once `job_applied` rows still name the record. The three rewritten function bodies no longer carry the migration stamp in their comments, so a later restamp leaves their fingerprints unchanged. The prover adds that retry case and widens its race windows to 6 seconds for busy machines.
