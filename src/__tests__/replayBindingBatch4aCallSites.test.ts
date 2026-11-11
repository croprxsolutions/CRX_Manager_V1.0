/**
 * Replay-binding batch 4a (migration 20261102180000): unpost_invoice, unpost_invoice_group,
 * transfer_invoice_to_job, close/reopen_accounting_period, save_field_app_invoice,
 * update_field_app_invoice_billing, consolidate_draft_invoices, create_rebate_claim and
 * transition_rebate_claim replay a saved result only for the same person and the exact same request.
 *
 * Each screen retires a refused key ONLY when the refusal proves nothing ran under it ('intent' or
 * 'actor'), as batch 1 does for money: a 'receipt' refusal keeps the key, since an earlier attempt
 * may have committed and the key is the only way to replay it instead of repeating it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const INTENT_OR_ACTOR =
  /const bindingRejection = getIdempotencyBindingRejection\([\w.]+\);\n\s*if \(bindingRejection === 'intent' \|\| bindingRejection === 'actor'\) /g;

// File -> [number of batch 4a sites, the retire statement each site must contain].
const SITES: Record<string, [number, string[]]> = {
  'src/pages/MonthEndClose.tsx': [2, ['closePeriodIdem.resetKey();', 'reopenPeriodIdem.resetKeyFor(reopenScope);']],
  // OrderDetail has batch 4b's price_order site in the same form (its consolidate site was retired 2026-11-11).
  'src/pages/OrderDetail.tsx': [1, ['priceOrderIdem.resetKey();']],
  'src/pages/Rebates.tsx': [2, ['createClaimKey.resetKey();', 'transitionKeysRef.current.delete(scope);']],
  // InvoiceDetail also has batch 1's write-off site in the same form.
  'src/pages/InvoiceDetail.tsx': [3, ['delete unpostKeysRef.current[', 'transferToSchedulingIdem.resetKey();']],
  'src/components/field-invoices/FieldInvoicesPostedPanel.tsx': [1, ['delete unpostKeysRef.current[row.id];']],
  'src/pages/FieldApplicationInvoice.tsx': [4, ['saveIdem.resetKey();', "return 'key_refused';", 'delete unpostKeysRef.current[', 'transferToSchedulingIdem.resetKey();']],
};

describe('replay-binding batch 4a call sites retire a key only when nothing ran under it', () => {
  for (const [file, [count, retires]] of Object.entries(SITES)) {
    it(`${file}: ${count} intent/actor site(s)`, () => {
      const source = read(file);
      const sites = [...source.matchAll(INTENT_OR_ACTOR)];
      // OrderDetail also keeps batch 3b's void_order site, which retires on any refusal by design.
      expect(sites.length).toBe(count);
      for (const retire of retires) {
        expect(sites.some((m) => source.slice(m.index, m.index + 400).includes(retire)), `${file}: ${retire}`).toBe(true);
      }
    });
  }

  it('reopen keys each (period, reason) pair apart', () => {
    const source = read('src/pages/MonthEndClose.tsx');
    expect(source).toContain('const reopenScope = JSON.stringify([reopenTarget.id, reopenReason]);');
    expect(source).toContain('const key = reopenPeriodIdem.getKeyFor(reopenScope);');
    expect(source).not.toContain('reopenPeriodIdem.getKey()');
  });

  it('a field invoice save refused for other values recovers the earlier save instead of creating again', () => {
    const source = read('src/pages/FieldApplicationInvoice.tsx');
    expect(source).toContain("const mismatch = error ? getIdempotencyMismatchResult(error, 'save_field_app_invoice') : null;");
    expect(source).toContain('const earlierSave = Array.isArray(mismatch?.invoice_ids) ? (mismatch as unknown as FieldAppInvoiceResult) : null;');
    expect(source).toContain('const retryMayReplayOldValues = send.mayReplayOtherValues || earlierSave !== null;');
    expect(source).toContain("let result = earlierSave ?? assertRpcResult<FieldAppInvoiceResult>(data, 'save_field_app_invoice');");
  });

  it('a rebate claim an earlier attempt created is reported, not created again', () => {
    const source = read('src/pages/Rebates.tsx');
    expect(source).toContain("const earlier = getIdempotencyMismatchResult(error, 'create_rebate_claim');");
    expect(source).toMatch(/was already created by an earlier attempt/);
  });
});
