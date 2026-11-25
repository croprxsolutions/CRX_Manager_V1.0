**LOCAL CANDIDATE — NOT APPLIED.** `20270305130000_field_marker_write_access.sql` (SQL sha256: `bf3e15f25e901ff81b3f1e2c76e33c0b86c0e1566349d06c8fec16f963dbb1d1`) lets assigned applicators add markers and maintain their own pins, adds eight marker types, and assigns permanent entrance numbers within each field.

The migration keeps existing marker reads and leaves stored pins untouched. The database owns marker identity, dates, point validation and entrance numbering. The marker read function distinguishes a complete empty list from a field that the caller cannot check.

Rollout and role proof are in [the field marker contract](../../plans/2026-11-24-field-markers-CONTRACT.md). If crew writes need to be withdrawn, restore the office-only write policies in a follow-up migration and keep the new marker types, entrance numbers and reads.
