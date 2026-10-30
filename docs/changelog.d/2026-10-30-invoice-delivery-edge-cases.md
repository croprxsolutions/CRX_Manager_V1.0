## 2026-10-30 - Preserve delivery recording and accumulated split rounding

- Preserve the existing exact draft-line adjustment when a quick delivery completes. Physical delivery, follow-up completion, and inventory recording can finish while an edited draft remains blocked from posting until corrected; valid completed draft groups still reserve quantity.
- Conserve every source line's split quantity in integer ten-thousandths using deterministic largest remainders. Existing penny allocations and acres stay unchanged; the order-line, product, and zero-delivery caps stay strict.
- Remove the former fractional tolerance now that split generation conserves quantities. The read-only production preflight found no existing order-line or product totals above delivered quantities.
- Match the database-enforced billing shape's quantity precision: order-level splits round the full physical line total, while delivery invoices retain individually stored delivery-row quantities. This preserves both supported routes without a blanket tolerance.
- Classify split-invoice creation as an invoice dependency in the generated workflow map.
- Add real-RPC disposable database proofs for edited quick drafts, completion replay, ten repeated product lines split among three owners, and rejection of genuine excess.
