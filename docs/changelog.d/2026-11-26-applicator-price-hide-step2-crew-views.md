## 2026-11-26 - Applicator price hide, step 2: crew screens read the crew views (#2574)

- Jobs list, Job Detail, Field View, the dispatch board, field sheet, loader worksheet and chemical report prints now load jobs, chemicals, payer shares and field billing defaults from `jobs_crew`, `job_chemicals_crew`, `job_field_shares_crew` and `field_billing_defaults_crew` for anyone who is not an admin or sales rep. Applicators no longer receive selling prices, chemical prices, the internal memo, the commission split or split percentages; they still see payer names and account numbers.
- Crew field sheets list payers from `get_job_billed_customers` and refuse to print (error toast, no PDF) when that list cannot be loaded. Crew Job Detail no longer shows price-based save warnings (crew cannot save a job).
- Admin and sales rep reads are unchanged.
- Proof: local Docker walkthrough as applicator, location dispatchee, crew driver, sales rep and admin; no crew request reached the four base tables and no crew response held a protected key.
- Not yet: step 3 (removing crew access to the base tables) and the later customer/product/service price step. Crew still receive the customer record (credit limit, prepay, discount, notes, default commission split): that is the step-2 customer item.
