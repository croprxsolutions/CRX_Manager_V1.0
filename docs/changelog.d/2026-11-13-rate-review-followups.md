## 2026-11-13 - Rate review workbook and retry follow-ups

- Rate Outcomes now has a Reconfirm choice so a changed rate and a renewed parent outcome can be reviewed in one upload. Leaving Reconfirm blank still clears an old outcome when its rates change.
- The visible parent name on each Rate Outcomes row must match the downloaded parent name. This prevents a pasted or sorted name from redirecting a new rate to another parent.
- An unanswered Confirm can be retried after leaving and returning to Products in the same browser tab. The original preview and request are kept for that retry; expired or conflicting attempts require a fresh-download check.
- The workbook format changed. A workbook downloaded before this update must be downloaded again and any in-progress edits copied over before upload.
- Returning to an unanswered confirmation keeps the original request available for manual checking even if another response has already cleared the browser record. Confirm sends only after the browser can read back the exact retry record. The two additional regression cases passed with the existing workbook/modal coverage (33 tests).
