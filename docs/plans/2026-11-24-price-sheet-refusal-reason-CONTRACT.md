# Behavior contract: why was this price sheet refused? (database half)

Read at `origin/staging` ef21134fc, 2026-11-24. Related: KNOWN_ISSUES "Pricing workbook: … tell an already-applied replay from a bad file" (line 1540).

## 1. Outcome and authority

- **Business result.** When an uploaded product price sheet is refused, the screen can say which single reason applies instead of one combined message.
- **Smallest change.** One new read-only function `public.get_pricing_workbook_export_refusal_reason(p_export_id uuid) RETURNS text`. No table, column, status, trigger or policy changes. The preview and apply functions and their refusal codes stay exactly as they are; the screen half lands later (after `claude/pricing-ux-followups` merges).
- **Files.** `supabase/migrations/20270303140000_price_sheet_refusal_reason.sql`, its proof `scripts/smoke/prove-price-sheet-refusal-reason-real-schema.mjs`, the ledger record, `docs/reference/rpc-functions.md`, `docs/reference/migrations.d/…`, this contract.
- **Who may act.** Active admins only (`public.is_admin()`, which also requires `is_active`). Anyone else: `ADMIN_REQUIRED`; no session: `AUTH_REQUIRED`. Execute granted to `authenticated` only; revoked from `PUBLIC`, `anon` and `service_role` (it has no signed-in user, so it could only ever get `AUTH_REQUIRED`).
- **Why SECURITY DEFINER.** `pricing_workbook_exports` is RPC-only: every table privilege is revoked from `authenticated` (20260717042803 line 240), so an invoker function could not read it. The admin check is inside the body; `SET search_path = public, pg_temp`.
- **Inputs.** `p_export_id` is only a locator. The caller is `auth.uid()`, never a parameter.
- **What it returns.** Exactly one of these codes, checked in this order, or `NULL` when the sheet itself is still usable:

| Order | Code | When | Today's combined code |
|---|---|---|---|
| 1 | `EXPORT_NOT_FOUND` | no export with that id (or a null id) | `WORKBOOK_V2_EXPORT_REQUIRED` / `…INVALID_OR_EXPIRED` |
| 2 | `DOWNLOADED_BY_OTHER_USER` | `created_by` is not the caller | same |
| 3 | `ALREADY_APPLIED` | `status = 'consumed'` | same / `…CONSUMED_OR_EXPIRED` |
| 4 | `OLD_TEMPLATE` | `format_version` is not `crx-product-pricing-phase2-v2` | `WORKBOOK_V2_EXPORT_REQUIRED` |
| 5 | `EXPIRED` | `status = 'expired'` or `expires_at <= now()` | same |
| – | `NULL` | owned, active, v2, not past expiry | (the sheet passes this check) |

- **Why this order.** "Someone else's sheet" is checked before any state, so an admin learns nothing about another user's export beyond "not yours" (no status, dates, names or prices). Permanent facts (applied, old template) come before the time-based one. Every reason has the same fix: download a fresh sheet.
- **Never returned.** Other users' names or ids, prices, costs, dates, row counts. The result is one text code.

## 2. State and failure

- No automatic record changes; the function reads one row and writes nothing. It is `STABLE`.
- **Existing rows.** `status` CHECK allows `active`, `consumed`, `expired`; all three are handled. Production today (read-only, 2026-11-24): 3 exports, all `active` + v2. Old v1 exports (if any reach staging) return `OLD_TEMPLATE`.
- **Timing.** Read-only, so no idempotency key (`p_idempotency_key` is not needed; said in a comment). A sheet that expires or is applied between the refusal and this call returns the reason true at call time, which is still the right advice. `NULL` means the sheet-level check passes; row-level refusals (row count, tampered rows, conflicts) keep their own existing distinct codes.
- **Undo and history.** None: nothing is written.

## 3. Delivery

- Database first, alone in this PR to `staging`. Compatible with the deployed app (nothing calls it yet). Recovery: a forward migration that drops the function.
- The screen half (mapping each code to a plain sentence after a refusal) is a later PR, after `claude/pricing-ux-followups` merges.

## 4. Proof cases (real-schema container, test data only; never production)

1. When the caller's own active v2 export is within its expiry, then `NULL`.
2. When the caller's export is `consumed`, then `ALREADY_APPLIED`.
3. When the caller's export is past `expires_at` (and when `status = 'expired'`), then `EXPIRED`.
4. When the caller's export has an older `format_version`, then `OLD_TEMPLATE` (even if also expired).
5. When another admin's export (also when it is applied), then `DOWNLOADED_BY_OTHER_USER`.
6. When the id does not exist or is null, then `EXPORT_NOT_FOUND`.
7. When a sales rep, driver or applicator calls, then `ADMIN_REQUIRED`; an inactive admin is refused; anon gets permission denied.
8. Function is SECURITY DEFINER, STABLE, `search_path=public, pg_temp`, one overload, `authenticated` can execute, `anon`/`PUBLIC`/`service_role` cannot.
9. Staging, after merge: a real staging export in each state that can be produced through the app (usable, applied, another user's) returns the matching code.

## Cold challenge (Astra gpt-6.2-astra high, 2026-11-24, 44 findings) and how each is settled

- **Corrected:** `NULL` wording is now "passes the export-level check", not "still usable" (#4). `ALREADY_APPLIED` is documented as "a change set from this export was applied", not "these exact edits went live" (#1, #44); the screen copy must say "already used, check pricing history". Preflight now pins the status list, so a new status cannot be silently called `EXPIRED` (#30). `service_role` execute revoked and checked (#25). Proof adds applied+old+expired, another user's old+expired, and a non-admin asking about an unknown id (#35). No-session vs anon split: anon has no execute (permission denied); `AUTH_REQUIRED` is the in-function guard for an executing role with no user (#22); both are proven.
- **Disproved with evidence:** `format_version` is `NOT NULL` with a non-blank CHECK (20260722091359 lines 12-14), so no null legacy rows (#28). The definer reads the RPC-only table the same way the existing preview/apply definers do; the proof's positive lookups run as `authenticated` (#24). The whole file runs in one transaction via the apply script, and the proof applies it with `psql -1` and checks autocommit is refused (#37).
- **Client-half requirements (the later screen PR, not this one):** call the function only after `WORKBOOK_V2_EXPORT_REQUIRED`, `WORKBOOK_EXPORT_INVALID_OR_EXPIRED` or `WORKBOOK_EXPORT_CONSUMED_OR_EXPIRED`, never after success, idempotent replays, row errors, auth or payload errors (#14, #15); it describes the export at call time, which can differ from the instant of refusal (#2, #16); a missing or unreadable id is the parser's message, not this function's (#5, #6); keep the original message whenever the lookup returns NULL, an unknown code or fails (#19); ignore a late answer for a different upload (#20); a lost apply response is checked against pricing history, not this function (#17). For an old and expired sheet, apply's own check fires on expiry first while this returns `OLD_TEMPLATE`; both mean "download a fresh sheet" (#11).
- **Declined:** attach the reason inside the preview/apply errors instead (#43): the task forbids changing those functions now, and the separate read keeps the deployed app untouched. Rename `OLD_TEMPLATE` to "unsupported" (#29): only two formats have ever existed (v1, v2). Distinct code for a null id (#5): the screen never calls without an id. Rename "downloaded by" (#7): an export row is created by the download itself.
- **Not a business decision:** existence disclosure (#23). Only active admins can call it, they already control every price, ids are random UUIDs, and another admin's export reveals only "not yours". Precedence (#18) and copy (#9, #10) are technical/copy choices for the client half. Recovery (#38, #40): the function is new and nothing calls it; a later screen must fall back to today's message if it is missing.
- **Staging proof (#41):** states are produced on staging test data only; an applied state is produced by applying an unchanged sheet (no price moves).

## Open business decisions

None. (Order and wording of codes are technical; the screen sentences come with the client half.)
