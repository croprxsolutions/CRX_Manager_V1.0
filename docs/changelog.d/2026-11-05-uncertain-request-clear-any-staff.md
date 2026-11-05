## 2026-11-05 — Any staff member can clear their own stuck request (KI-27 follow-up, database half)

- New migration `20261107160000_uncertain_request_clear_any_staff.sql` (record in `docs/reference/migrations.d/`).
  Mason's decision (2026-11-05): a sales rep, driver or applicator whose request got stuck had no way out inside
  the app, because a stuck request lives only in the sender's own browser under their own login, so an admin
  can never clear someone else's. `retire_uncertain_request` now accepts any active profile with a staff role
  (`admin`, `sales_rep`, `driver`, `applicator`) instead of active admins only; `entity_recipient` service
  profiles and inactive accounts still get `NOT_AUTHORIZED`.
- Nothing else changes: the body is byte-for-byte `20261107150000`'s apart from that check (own keys only, the
  `in_progress` lock check, the signed 15-minute server-time wait, the retire row and receipt guard), with the
  same SECURITY DEFINER, `search_path = public, pg_temp` and EXECUTE for `authenticated` only. A preflight
  refuses unless the installed body is `20261107150000`'s (md5 `482ac2199575547aac2899e6621d9168`); a
  postflight checks the new body (md5 `addf6df43b0e9d23c91e88dba315a1d0`) and the grants.
- Smoke chain `smoke-uncertain-request-clear-check.sql` now pins the new body and proves an active non-admin
  staff member is answered (`first_check`) for their own key and refused another user's
  (`REQUEST_KEY_NOT_OWNED`), and a service profile is refused (`NOT_AUTHORIZED`).
- The screens half (showing the button to every staff member) follows in a separate PR after this is live.
