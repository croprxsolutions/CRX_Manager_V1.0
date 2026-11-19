## 2026-11-18 - RT-4b: product rates change only through the rate tools

- Migration `20270126100000_product_rate_direct_writes_revoked.sql` removes the app's direct write access to a product's rate per acre, rate unit and suggested rate (Mason, 2026-11-18). Every rate tool keeps working: Correct rates and Parent rates on the product pages, the Setup Workbook's Rates tab, product import, adding or moving a size, and the RT-4a switch.
- Product page: the three rate boxes are always read-only. While rates are open, an admin sees where to change them (the Setup Workbook's Rates tab); while locked, Correct rates is unchanged. Saving product details never sends a rate.
- Price workbook: its refusal of a rate change now names the rate tools.
- Field app: a product with no rate unit and no stock unit leaves the line's units blank instead of inventing `oz`.
- RT-4a tidy-up (#1958): the read-only reporting role is named in the switch RPCs' revoke.
- Not in RT-4b: the Piksi `MG` to `g` rename (Mason kept both Piksi groups on today's values, 2026-11-17) and a one-step edit tool for switched groups.
- Proof: `node scripts/smoke/prove-rate-writers-real-schema.mjs` (`RATE_WRITERS_PROOF_PASS`).
