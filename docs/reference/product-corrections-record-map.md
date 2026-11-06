# Product label corrections: record map

**Owner rule (2026-10-28):** When a product's re-entry interval (REI) or pre-harvest interval (PHI) is corrected, open jobs with filled-in chemical line values offer to update them. Blank lines already follow the product. Posted invoices never change.

| Record | Copies what | When | Does a product correction reach it? |
|---|---|---|---|
| `job_chemicals` | `epa_registration` | Set from the product by the database whenever a line is written or its product changes, whichever path writes it (`20261123100000`). Lines that existed then got their product's number. | Only through a parent EPA correction, and only on `scheduled` or `in_progress` jobs. Completed, invoiced, cancelled and deleted jobs keep theirs. |
| `job_chemicals` | `rei_hours`, `phi_days` | Values are copied when a product is picked on a line, when a recipe is loaded (`src/lib/recipeHelpers.ts`), or when a crop program is loaded (`src/lib/cropProgramHelpers.ts`); `save_job` saves the line. A job made from a quote leaves these values blank. Blank lines follow the product's current value at print time on any job status; filled-in lines keep their copied value. | Blank lines: yes, automatically. Filled-in lines: only if a user accepts the offer on an open job and saves. |
| `invoice_items` | `epa_registration` | When an invoice line is made. A line written for a product with no number of its own gets the product's number from the database (`20261123100000`). | No. Posted invoices are regulated printed records. Draft lines also keep their copy (Mason, 2026-11-02). |
| `rup_sales_records` | `epa_registration`, `signal_word` | When a restricted-use pesticide sale is posted. | No. A wrong posted record needs a formal correction (void), not a silent edit. |
| Quotes and orders (`quote_items`, `order_items`) | No product label facts | They read the product's current values when needed. | Yes, automatically; there is no stored label copy. |
| WPS notice | No copy of its own | Job Detail reads `products` when printing. EPA number: the job line's copy once the screens PR lands. | REI/PHI: yes, automatically. EPA number: see the parent EPA correction below. |
| FieldView | No product label facts | Reads `products.rei_hours` and `products.phi_days`. | Yes, automatically. |
| Field application invoice screen | No REI/PHI or max label rate copy for its label lookups | REI/PHI and max label rate come from the product; the EPA number reloads from the `invoice_items` copy. | Product REI/PHI and max label rate: yes, automatically. Copied EPA number: no. |
| Applicator sheet and chemical application report | No stored copy of their own | Filled job line `rei_hours` / `phi_days` values print first; blank values fall back to the product. EPA number comes from the product today, from the job line's copy once the screens PR lands. | REI/PHI corrections reach blank lines automatically, even when completed jobs are reprinted. Filled lines change only through the open-job offer below. |

| Sent spray-job proof (`get_job_proof_data`) and customer year-end summary (`get_customer_year_end_summary`) | No copy of their own | EPA number from the job line's copy, and from the invoice line's copy (the product's only for a line with none) (`20261123100000`). | No. |
| Purchase orders (screen, PDF, email) | No copy | Read the product's current EPA number. | Yes, accepted: a purchase order is a buying request, not a compliance record. |

`product_brands` holds each brand's own registration. `product_label_drafts` holds inbound label drafts that feed products. Neither is a copy of the product label facts covered here.

The WPS notice and FieldView show the product's current REI/PHI, while the applicator sheet shows the job's filled-in copy; on a job with a kept override, these printouts differ (existing behaviour).

## Open-job offer

On the Chemicals / Charges tab of a saved `scheduled` or `in_progress` job, an office role that can edit the job (Job Detail's edit flag) sees an offer for filled-in chemical line REI/PHI values that differ from the product's current values, including inactive products. Blank job line values already follow the product and are not offered; a blank product value never clears a job value. **Update to current label** changes the form only; the normal **Save** action persists the updated `job_chemicals` lines. **Keep job values** hides the offer for that set of differences until a line or product value changes, or the page reloads. A failed lookup shows a small note.

Labels load when the set of products on the job changes, so a product correction made while the page is open shows after a reload.

New, completed, invoiced, and cancelled jobs never show this offer. Posted invoices and restricted-use pesticide sale records remain as issued because they are regulated records; any correction to those records follows the formal process.

## Parent EPA correction

Mason (2026-11-06): "yes i want to be able to fix epa issues". An admin corrects a parent's generic EPA number with a reason and evidence (`correct_product_parent_identity`). In one transaction it writes the parent, every size, and the job lines of that parent's sizes on `scheduled` and `in_progress` jobs, and logs one event listing each size's before and after. Spray jobs that have happened, invoices and restricted-use sale records keep the number they were made with.

It is refused while any invoice line for one of the sizes (on an invoice not deleted) has no EPA number of its own, because that line would show the new number; the refusal names the invoices. A draft is fixed by opening and saving it; a posted one by unposting, saving and posting it again.

The database switch `_product_parent_epa_correction_enabled()` is off until the screens that print a job's EPA number (Job Detail's applicator sheet, chemical application report and WPS notice) read the job line's copy; the migration that ships with those screens turns it on.

## Follow-ups for the owner

1. Decided (Mason, 2026-11-02): draft or unposted invoice lines keep the EPA number copied when made; no update offer is built for them (`docs/manual/DECISION_LOG.md`).
2. Should the product page list open jobs still carrying old REI or PHI values? That list is not built here because Product Detail is being changed by other work.
3. The database's `save_job` does not itself refuse edits to a completed job; the screen blocks them. A server-side status check is separate follow-up work.
4. Restricted-use sale records copy the product's EPA number when the invoice is posted, not the invoice line's copy. An invoice still in draft when a parent EPA correction is made therefore posts a record with the corrected number while its line keeps the number it was made with; likewise an invoice made from a finished job after a correction takes the corrected number while the job line keeps its own. Accepted for now on the rule that a record keeps what it showed when it was made and a record made after a correction takes the corrected number. If Mason wants the restricted-use record or the job's invoice to follow the job line instead, that is a small follow-up.
5. A completed job re-saved through the database directly (the screen blocks it, follow-up 3) re-copies its lines' EPA numbers from the products, the same protection every other field on that job has today.
