## 2026-10-30 - Align order reads and cap assertions with current schema

Add the existing, non-cost `orders.row_version` to the shared safe read list now that the live schema registry records it, and remove the editor's duplicate selection. Update the invoice-cap trigger assertion to require all three guarded update fields. These changes address the full CI test run without weakening schema or trigger checks.

Validation: all 485 local test files passed (6,755 tests passed; 123 intentional skips), plus type checking, lint, production build, code-health checks, and independent type/compliance review. The migration bytes and successful full PostgreSQL proof are unchanged by this follow-up.
