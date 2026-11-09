## 2026-11-08 — Customer form warns about a likely duplicate before saving (KI-77)

- Creating a customer, or changing an existing one's farm name, phone or email, first looks for customers on file
  (active or not) with a similar farm name (filler words such as "Farms" or "LLC" ignored, one name inside the other,
  or two typos apart), the same phone (last 10 digits) or the same email. Any match opens a warning listing them,
  with "Create anyway"/"Save anyway" or "Go back". It never blocks: if the check fails or takes over 4 seconds, the
  save goes ahead. The form is locked while a save (and its check) runs.
  Every customer is compared in the browser (about 150 today), so a typo anywhere in a name or an accent ("José")
  cannot hide one. A save left while its check runs never resumes, even if the user comes back to the same customer.
  New helper `src/lib/customerDuplicates.ts`; no database change.
- Bulk sales-rep assignment already exists on the Customers list (PR #381, `assign_customers_sales_rep`, live). A
  read-only live count on 2026-11-08 found 146 of 151 active customers without a rep; KI-30 and KI-77 now say so.
