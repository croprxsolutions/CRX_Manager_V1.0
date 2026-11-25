## 2026-11-24 — A job sprayed before its product had an EPA number is first invoiced under the later number

**Severity:** LOW. **Area:** field application job invoices. **Status:** OPEN.
**Owner:** Mason (field billing work). **Tracked:** #2457, #2381.

If a job is sprayed while one of its products has no EPA number, and that product later gets its
first number, the job's first invoice shows the new number while the spray record still shows a
dash. The invoice and the spray record then disagree on that product's number. Found while
reviewing #2381; it comes from #2457's job-invoice code. Taha asked (2026-11-24) for it to stay with
the field billing work.
