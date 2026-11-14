## 2026-11-10 — REG-1: re-saving an order-linked invoice keeps working after the switch-on (database, applied live 2026-11-11)

- `20270102160000_rup_capture_fk_on_update_cascade`: the link from a line's restricted-use capture to its invoice
  line now follows the line when a save moves it back to its original id. Without it, once the EPA registration seed
  runs, re-saving any draft invoice made from an order would fail (found by the Brand PR B session, #1765).
- No data, function or permission changes. The seed waits for this to be live.
- Proof: `node scripts/smoke/prove-epa-registration-step2-real-schema.mjs` (case 16).
