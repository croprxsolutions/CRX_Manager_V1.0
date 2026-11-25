# Behavior contract: a delivered line under 0.01 beside real lines counts as zero

Known issue `docs/manual/known-issues.d/2026-11-24-2324-tiny-line-beside-real-lines.md`. Read at `origin/staging` 3454db56b (includes #2324).

## Facts

- #2324 (`20270306230000_f05b_delivery_line_checks.sql`) refuses a completion when **every** line is under 0.01 (`DELIVERY_NOTHING_DELIVERED`). A line under 0.01 beside a line of at least 0.01 still completes with its tiny figure: #2324's own proof (case 2c) and Taha's re-check ("0.005 on one line and 5 on another ... the invoice gets a 0.0050 line (24 cents)").
- Every completion (complete_delivery, start_and_complete_delivery, offline sync) reaches `_complete_delivery_authorized_impl` (#2324's wrapper), which calls the body `_complete_delivery_authorized_impl_20270122` (newest definition `20270227110000`).
- The body's figure per line is `GREATEST(0, LEAST(sent, scheduled))`, or the scheduled quantity when no figures are sent. A figure of 0: no stock move, `delivery_items.quantity_delivered = 0`, no order-line move, the line is skipped on the auto invoice (`quantity_delivered > 0`), the load is a partial and the line's full quantity becomes a pending remainder; a draft invoice already tied to this delivery gets that line set to 0.
- The open proof-bound-to-load PRs (`20270307030000`, `…proof_binding_required`) replace `_complete_delivery_authorized_impl`, `complete_delivery` and `start_and_complete_delivery` with md5-pinned preflights, and compare the screen's delivered figures with the figures **as sent** (`_delivery_lines_match`). They do not touch the body.

## Established decision

- Taha, #2324 review 2026-11-24: "a line under 0.01 next to real lines still reaches the invoice as a tiny quantity; I'd like those lines treated as zero too, in a small separate PR." Logged by #2480. Mason's Slack rule 2026-11-23: under 0.01 must not make an invoice.

## Outcome and authority

- Result: at completion, a line whose effective figure (what the body would deliver: the figure sent, kept between 0 and the scheduled quantity, or the scheduled quantity when none is sent) is above 0 and under 0.01 is delivered as **exactly 0**, the same as a driver typing 0. No stock, order-line, invoice or Bill Split effect from that line; its scheduled quantity becomes a remainder like any typed 0.
- Smallest change: one migration. The body is renamed `_complete_delivery_body_impl_20270307` unchanged; a thin wrapper takes the old name, replaces each such figure with 0 (building the full figure list from the scheduled quantities when none was sent), and calls it. Nothing else changes. This keeps the proof-bound PRs' pinned functions and their "figures as sent" comparison untouched.
- Files: the migration, its rollback script and real-schema prover under `scripts/smoke/`, its migrations.d record and changelog entry, this contract, and the known-issue note. (`src/lib/rpcContracts.test.ts` and `src/lib/rpcIdempotencyScope.test.ts` pass unchanged.)
- Who may act: unchanged. Both functions are SECURITY DEFINER, `search_path = public, pg_temp`, EXECUTE revoked from PUBLIC, anon, authenticated, service_role; only the authorizing wrapper above reaches them.
- The screen sends figures keyed by line id; the server already checks they are numbers and match the delivery's lines (#2324). The wrapper only rewrites number figures of this delivery's lines that fall in (0, 0.01); anything else passes through untouched for the existing checks.

## State and failure

- Automatic record change: a tiny figure becomes 0, authorized by Taha's ask and Mason's 2026-11-23 rule. Not a refusal: the real lines still complete.
- Rules that always hold: a completed line's `quantity_delivered` is 0 or at least 0.01; the all-under-0.01 refusal is unchanged (it runs earlier, in #2324's step).
- Existing rows: none rewritten. Completed deliveries with tiny lines stay as they are; Fix Delivery after completion is not changed here.
- Timing: same transaction and locks as today (the wrapper reads the lines #2324's step already locked). A retry with the same key returns the saved receipt before any figure is used.
- Known side effect (unchanged code): #2324's step creates an empty Main Warehouse stock row for a product whose only figure is tiny, as it does today for any positive figure. Harmless (0 / 0), not changed here to keep the proof-bound PRs' pinned function untouched.

## Delivery

Database only, one PR to staging, compatible with the deployed app (no new parameter). The screens' "above zero" checks are follow-up #2527, not here.

## Proof cases (real migrated database, `scripts/smoke/prove-tiny-line-counts-as-zero-real-schema.mjs`)

1. Before the candidate: 0.005 beside 1 completes with a 0.005 line (the gap).
2. After: 0.005 beside 1 completes; the tiny line has delivered 0, no stock or order-line move for it, the load is partial with a remainder of that line's full quantity; the real line moves stock and the order line by 1; the auto invoice has no line for it.
3. No figures sent, a line scheduled at 0.005 beside a line of 1: the tiny line is delivered 0, the other 1.
4. Exactly 0.01 beside 1: delivered 0.01 (not zeroed).
5. Every line under 0.01: still refused `DELIVERY_NOTHING_DELIVERED`.
6. start_and_complete_delivery: same as case 2.
7. A retry of a saved completion returns the same receipt.
8. Grants: neither function callable by anon, authenticated or service_role.
9. Rollback script restores the old chain; case 1's behavior returns.

## Open business decisions

None: Taha and Mason settled "treated as zero".

## Cold challenge (Astra, gpt-6.2-astra high, 2026-11-25: FINDINGS 46) and how each was settled

- **Contract corrected.** The threshold is on the effective figure after capping to the scheduled quantity (1 sent for a line scheduled at 0.005 is 0.005, so it is zeroed: proof case 3b). "Same as typing 0" means the body's existing typed-0 path, including its existing draft-invoice, tote-copy, remainder, follow-up and allocated-order behavior (Astra 16–24 describe that existing path; none is changed or widened here). The receipt says `partial`, the delivery row says `completed` (13). The invariant is a postcondition of a fresh completion only; Fix Delivery and old rows are outside it (30). A retry returns the saved receipt only where the replay path's authorization still passes (33).
- **Known exception, accepted (11).** #2324's step creates an empty (0 / 0, manufactured at delivery) Main Warehouse row for a product that has none and whose only figure is tiny; a typed 0 does not. Live check 2026-11-25 (read-only): every product on a scheduled or in-progress load already has a Main Warehouse row (0 missing), so this needs a product never stocked. Fixing it means changing the step the proof-bound PRs pin.
- **Already settled by the rule, not re-asked (5, 9, 23).** What a tiny line means is decided: it is zero (Taha 2026-11-24, Mason 2026-11-23). So its scheduled quantity stays owed, as for a typed 0. The screens still show/sign "above zero" figures and a remainder under 0.01 can still be scheduled: both are follow-up #2527 (owned by the proof-bound-to-load session), not here.
- **Evidence added.** Live read-only 2026-11-25: 0 delivery lines with a delivered or scheduled quantity above 0 and under 0.01, in any status (31). The prover adds: a typed-0 twin load compared field by field with the tiny load (38); both lines on one product, with prebooked and the stock ledger checked (12); 0, negative, and above-the-schedule figures beside a real line (37); malformed figures still refused by the earlier check (35). The rollback checks the wrapper's own md5 before dropping it (42).
- **Disproved.** 29: plpgsql resolves the body by name at call time, and the only caller in the migration chain is #2324's step (search of `supabase/migrations/`, `src/`, `scripts/`). 2–4, 7, 26, 41: the proof-bound PRs compare the figures as sent, which this wrapper never changes (it runs after their check, inside the body call). 36: the wrapper reads the lines #2324's step has already locked for an in-progress load; it takes no lock of its own.
- **Out of scope, unchanged existing behavior (8, 10, 14–15, 20–22, 24, 25, 27, 28, 34, 39, 40, 44).** Each concerns the existing typed-0, replay, undo, authorization or rollout behavior, which this change neither alters nor relies on newly. The rollback note says records completed while the rule was on stay as they are (40).
- **Declined suggestions.** 45 (normalize inside #2324's step): it would change the function both proof-bound PRs pin. 46 (edit the body in place): a 570-line re-emit for a 20-line rule.
- **#2324's prover (43).** Its own replay check stops at any later file touching `_complete_delivery_authorized_impl*`, so it now names this file if re-run; it is a historical proof, not CI.
