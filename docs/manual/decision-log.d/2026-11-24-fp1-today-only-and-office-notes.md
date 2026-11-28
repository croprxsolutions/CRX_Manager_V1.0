## 2026-11-24 — Field splits: changes start today until FP-4; payer notes are office only (FP-1)

**Decision (Mason, 2026-11-24, "I agree with all recommendations", answering Sol HIGHs raised on the Field Setup screen branch against FP-1):**
1. Until FP-4 (job billing reads split history), a field split change can start only on today's Central date; `set_field_billing_split` refuses any other date (`FIELD_SPLIT_STARTS_TODAY_UNTIL_FP4`). History is still recorded.
2. Payer collection notes are office only: the read-only copy `field_billing_defaults` (which applicators assigned to a field can read) no longer carries them, and `save_field` ignores notes; notes are saved through `set_field_billing_split`.
**Why:** job billing reads today's copy, not the split in force on the job's date, so a scheduled or backdated change could bill work under the wrong split; and payer notes were readable by field applicators.
**What this forbids/implies:** the Field Setup screen must not offer a start date other than today until FP-4 turns scheduling back on. Do not copy payer notes into any table applicators can read.
