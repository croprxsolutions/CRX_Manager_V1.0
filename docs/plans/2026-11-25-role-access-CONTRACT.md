# Watchdog, Crop Programs and Receiving access contract

This change uses the existing role checks and workflows. Rebate, Settings, Notifications and Vehicles updates have separate delivery steps.

- Admin and sales rep continue to use Watchdog detection and dismissal. The database writes flags and dismissals through the existing guarded functions. Existing flag history and system-role grants are preserved.
- Sales reps can read and expand Crop Programs. Admins can also create, update, duplicate, activate and delete templates.
- Sales reps can select and export Receiving Log records. Admins can also reverse a receipt. A change from admin access clears an open privileged confirmation.

## Verification and rollback

Use the local Docker walkthrough with invented records. Check the Watchdog service role and all four signed-in roles. Test replay and saved actor attribution. Prove the allowed reads and exports and the admin write paths. A read-only role must not see the admin controls. Check that a delayed save leaves the editor busy until completion.

If the existing Watchdog functions fail after apply, restore only the prior needed table grants through a reviewed compensating migration. Frontend changes can be reverted through the normal reviewed application delivery.
