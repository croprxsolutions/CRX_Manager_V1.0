# Team Board follow-ups

The November 26 brief asked for a faster office board and for work needing a separate decision to be recorded here. Sizes are small (S), medium (M), and large (L). Risks refer to what could go wrong if the proposed change is made without the checks it needs.

## What the August audit had already addressed

- Delegated completion and assignment notifications are implemented in `supabase/migrations/20260809130108_team_note_completion_rpc_and_assignment_notify.sql`. Team Board uses that completion function. The creator and admin edit rules are separate from checking a task off.
- Both notification deep-link paths point to Team Board. The board waits for its first load and can fetch a missing note directly. See `NotificationsPanel.tsx`, `src/pages/Notifications.tsx`, and `src/pages/TeamBoard.tsx`.
- The October delivery priority and recap timestamp work is already in the code and migration history. The audit preserved that behavior.

## Quick wins

| Improvement | Why it helps | Size | Risk | Files |
| --- | --- | --- | --- | --- |
| Show a retry inside Today's Deliveries and Yesterday's Recap when their read fails. | Staff can tell an unavailable dispatch summary from an empty one after the toast fades. | S | Low. Verify no-delivery and request-failed cases separately. | `TodaysDeliveries.tsx`, `YesterdayRecap.tsx` |
| Surface loading or error states for note activity, comments, and tag filters, and refresh the board comment count after a post. | A failed read should not look like a quiet discussion or a tag that never existed. | M | Low. Requests can resolve after a note or filter changes. | `ActivityFeed.tsx`, `CommentsSection.tsx`, `TeamBoardFilters.tsx`, `TeamBoard.tsx` |
| Cover edited/deleted comment actions in the global Activity filter and make missing/deleted note rows visibly noninteractive. | Staff can narrow the audit trail and tell which rows can open. | S | Low. Preserve the visible history even after a note is gone. | `TeamBoard.tsx` |
| Finish keyboard and screen-reader labels on the bell, tags, comments, and remaining form fields. Move embedded card actions into separate native controls across the legacy cards. | Users can identify, tab to, and operate each control independently. | M | Low. Changes card hit areas and focus return. | `NotificationsPanel.tsx`, `TagsManager.tsx`, `CommentsSection.tsx`, `TeamBoard.tsx`, `NoteCard.tsx`, `StaleTasksAlert.tsx`, `QuickTaskModal.tsx` |
| Use the existing entity badge links consistently and guard unexpected link types. | An older or unsupported record link should not open a dead link or break a card. | S | Low. Verify each supported destination and legacy data. | `EntityBadge.tsx`, `StaleTasksAlert.tsx`, `TeamBoard.tsx` |
| Replace the comment insert's unhandled failure path and add a real confirmation for comment removal. | A failed post should retain its draft and let the employee retry. Removal should be clear on keyboard and phone. | S | Low. Protect draft text and preserve the existing author-only removal action. | `CommentsSection.tsx`, `CommentsSection.test.tsx` |

Component paths above are under `src/components/team/`. `TeamBoard.tsx` is under `src/pages/`.

## Bigger UI work

| Improvement | Why it helps | Size | Risk | Files |
| --- | --- | --- | --- | --- |
| Replace “paste entity UUID” with a searchable link picker and carry supported record types through the whole UI. | The office can attach a task to a record by searching its name or number. | M | Medium. Search must respect what the current employee can read and use the right record type. | `src/pages/TeamBoard.tsx`, `src/components/team/EntityBadge.tsx`, `src/components/team/StaleTasksAlert.tsx`, shared record picker and record detail pages |
| Open a member's tasks directly from Workload, expose unassigned work, and make deep links preserve the staff member's current view. | The office can move from “who is busy?” to the actual tasks in one step. | M | Medium. First reconcile which items the workload function counts and which the board reads. | `src/components/team/WorkloadView.tsx`, `src/pages/TeamBoard.tsx`, `src/components/team/TeamBoardFilters.tsx` |
| Provide one-to-one mention selection and a consistent tag catalog refresh. | Staff can reliably choose the intended coworker and find new tags immediately. | M | Medium. Verify who receives notices and ambiguous names. | `src/components/team/CommentsSection.tsx`, `src/components/team/TagsManager.tsx`, `src/components/team/TeamBoardFilters.tsx` |
| Refresh a customer or other record’s Team Notes as soon as Quick Task saves. | Staff can verify the linked task without reloading the detail page. The local customer walkthrough showed a count of 0 after save and 1 after reload. | M | Medium. Reload after a verified save across every detail-page caller. | `src/components/team/QuickTaskModal.tsx`, `src/components/team/RelatedNotes.tsx`, record detail callers |
| Confirm before discarding a changed note when closing the form and protect linked-task drafts too. | Closing the dialog by accident should not lose work. | M | Low. Verify modal focus, Escape, route changes, saves, and explicit cancellation. | `src/pages/TeamBoard.tsx`, `src/components/team/QuickTaskModal.tsx` |

## Needs a planned change

| Improvement | Why it helps | Size | Risk | Files |
| --- | --- | --- | --- | --- |
| Make create retries safe if the database saves a note but the reply is lost. | Staff can retry after a connection drop without creating a duplicate. The existing create path has no server-side retry key. | M | Medium. Needs an agreed database write contract and a lost-response test. | `src/pages/TeamBoard.tsx`, `src/components/team/QuickTaskModal.tsx`, the Team Board write path and tests |
| Give the board stable paging and bounded batch reads for tags, comments and names. | Older open work and counts should remain complete when the board grows beyond the default row limit. | L | Medium. Counts, lookup batches and sort order need to stay consistent as tasks change. | `src/pages/TeamBoard.tsx`, `src/components/team/WorkloadView.tsx`, relevant query policies and tests |
| Make photo upload and its attachment record recover cleanly if one succeeds and the other fails. | Staff can retry a failed attachment without leaving duplicate or unlisted files. | M | Medium. File cleanup needs proof that a successful attachment is not removed after a lost response. | `src/components/team/NotePhotoUpload.tsx`, `src/components/team/NoteAttachments.tsx`, storage policy and tests |
| Add due-date reminders only after defining cadence and deduplication. | Staff get a prompt without opening the board. | M | Medium. Requires changes to the scheduled notification path. | `src/components/team/NotificationsPanel.tsx`, `src/pages/TeamBoard.tsx`, notification migrations and scheduled jobs |

## Needs Mason to decide

| Improvement | Why it helps | Size | Risk | Files |
| --- | --- | --- | --- | --- |
| Decide whether announcements should expire, and whether old ones remain visible in history. | The office can keep today's board clear without manually deleting announcements. | M | Medium. Expiry changes a record's lifecycle. | `src/pages/TeamBoard.tsx`, `src/components/team/NoteCard.tsx`, Team Board schema and policies |
| Decide whether notes and announcements with dates or assignees are tracked work, alongside To-Do items. | The “My Tasks,” overdue and Workload totals can tell the same story. | M | Medium. Changes what appears in the office's daily queue and may alter existing counts and completion controls. | `src/pages/TeamBoard.tsx`, `src/components/team/WorkloadView.tsx`, `src/components/team/StaleTasksAlert.tsx`, workload function |
