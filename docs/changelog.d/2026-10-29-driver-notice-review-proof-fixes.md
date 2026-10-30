## 2026-10-29 - Driver-notice proof review fixes

The disposable driver-notice proof now checks the newly reported deliveries instead of assuming an empty notification history. Repeated runs can retain earlier office recipients, so the committed check counts distinct delivery identities; the chain still checks one notice per current recipient and delivery. The existing weather case also verifies that an explanation longer than 2,000 characters is trimmed and truncated at the exact boundary.

Synthetic profile names include their random identifiers so the replay also respects the existing unique-name constraint when prior fixtures persist.
