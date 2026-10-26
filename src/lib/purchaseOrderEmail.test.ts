import { describe, expect, it } from 'vitest';
import { buildPurchaseOrderEmailPayload, purchaseOrderEmailBlocker } from './emailService';

const goodLines = [{ unit_cost: 12, cost_needs_review: false }];

describe('purchaseOrderEmailBlocker', () => {
  it('lets a submitted PO with confirmed costs and a vendor email through', () => {
    expect(purchaseOrderEmailBlocker({ status: 'submitted', vendorEmail: 'a@b.example', lines: goodLines })).toBeNull();
    expect(purchaseOrderEmailBlocker({ status: 'partially_received', vendorEmail: 'a@b.example', lines: goodLines })).toBeNull();
  });

  it('explains a vendor with no email and points to the PDF download', () => {
    for (const vendorEmail of [null, undefined, '  ']) {
      expect(purchaseOrderEmailBlocker({ status: 'submitted', vendorEmail, lines: goodLines })).toMatch(/no email address on file.*download the PDF/);
    }
  });

  it('refuses the wrong status, no lines, and unconfirmed or zero costs', () => {
    expect(purchaseOrderEmailBlocker({ status: 'draft', vendorEmail: 'a@b.example', lines: goodLines })).toMatch(/submitted/);
    expect(purchaseOrderEmailBlocker({ status: 'submitted', vendorEmail: 'a@b.example', lines: [] })).toMatch(/no lines/);
    expect(purchaseOrderEmailBlocker({ status: 'submitted', vendorEmail: 'a@b.example', lines: [{ unit_cost: 0 }] })).toMatch(/Confirm the unit cost/);
    expect(purchaseOrderEmailBlocker({ status: 'submitted', vendorEmail: 'a@b.example', lines: [{ unit_cost: 5, cost_needs_review: true }] })).toMatch(/Confirm the unit cost/);
  });
});

describe('buildPurchaseOrderEmailPayload', () => {
  const input = {
    vendorEmail: ' orders@spinner.example ',
    vendorName: 'Spinner <Ag>',
    purchaseOrderId: 'po-1',
    poNumber: 'PO-2026-0040',
    expectedDeliveryDate: '11/3/2026',
    attachmentBase64: 'QUJD',
    attachmentFilename: 'Purchase-Order-PO-2026-0040.pdf',
    idempotencyKey: 'key-1',
  };

  it('addresses the vendor as a purchase_order send with no customer', () => {
    const payload = buildPurchaseOrderEmailPayload(input);
    expect(payload).toMatchObject({
      to: 'orders@spinner.example',
      subject: 'Purchase Order PO-2026-0040 from Crop RX Solutions',
      email_type: 'purchase_order',
      resource_type: 'purchase_order',
      resource_id: 'po-1',
      idempotency_key: 'key-1',
      attachments: [{ filename: 'Purchase-Order-PO-2026-0040.pdf', content: 'QUJD' }],
    });
    expect(payload.customer_id).toBeUndefined();
    expect(payload.html).toContain('Spinner &lt;Ag&gt;');
    expect(payload.html).toContain('Requested delivery: 11/3/2026');
  });

  it('refuses a blank vendor email', () => {
    expect(() => buildPurchaseOrderEmailPayload({ ...input, vendorEmail: '  ' })).toThrow(/no email address/);
  });
});
