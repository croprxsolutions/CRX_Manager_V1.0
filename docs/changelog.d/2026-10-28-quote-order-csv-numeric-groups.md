## 2026-10-28 - CSV numeric edges and consistent order headers

Follow-up to To-Do 1.10 on `codex/quote-order-quoted-fields`, parked locally at
Mason's explicit no-merge instruction. No migration, production import, or deployment.

- Quote and order CSV numbers share decimal/scientific syntax validation. Nondecimal
  literals, nonfinite values, underflow to zero, unsafe magnitudes, and decimal digits
  lost during Number conversion are rejected. Ordinary decimals, signs, trailing zeroes,
  and scientific notation remain supported. Quotes reject negative quantities/prices
  and validity days that cannot produce a valid expiry date.
- Rows sharing one order number must agree on customer, order date, and order notes.
  A conflict or any invalid numeric/item row excludes the whole order. Other valid orders
  in the file remain available. Product `Description` aliases and per-item notes remain
  item fields; they do not cause false order-header conflicts.
- Quote money conversion and quantity multiplication use the existing exact decimal
  half-up money helpers used by orders. Examples: 1.005 becomes 1.01 dollars; 0.145
  becomes 0.15 dollars. Both importers reject unsupported cent totals before an RPC.
- Twenty new regression cases were observed failing against the previously parked
  implementation before these fixes. Final focused verification covers the parser,
  grouping helper, both import dialogs, and existing money helpers (120 tests).
- Browser proof uses the actual dialogs with synthetic dependency stubs for admin and
  sales rep, checking conflicts, complete groups, supported/invalid numeric forms, exact
  cent rounding, and out-of-range amounts. It does not prove production DB execution.
  All 44 checks passed with zero external requests and zero page errors. Lint, typecheck,
  build, and code-health checks passed. Compliance and Luna xhigh reviews are clean after
  the rounding and Description-alias fixes. Sol/CodeRabbit/remote CI remain release-time gates.

Parking base: original `a3423a812`; main advanced to documentation-only `5b0246530` during
verification, with no overlapping files. No main merge or history rewrite was performed.

Rollback: revert this follow-up commit; no data rollback is needed. Release work still
requires current protected PR checks and final release reviews. Shared batch status
documents are intentionally reserved for the coordinator.
