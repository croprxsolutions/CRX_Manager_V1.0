import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decidePurchaseOrderEmail,
  type PoGateLine,
  type PoGateOrder,
  type PoGateVendor,
} from '../../supabase/functions/_shared/purchaseOrderEmailGate';

const order: PoGateOrder = { id: 'po-1', vendor: ' Spinner Ag ', status: 'submitted' };
const lines: PoGateLine[] = [
  { unit_cost: 12.5, cost_needs_review: false },
  { unit_cost: '3.00', cost_needs_review: false },
];
const vendors: PoGateVendor[] = [
  { id: 'v-1', name: 'spinner ag', email: 'Orders@Spinner.example' },
  { id: 'v-2', name: 'Hydrite', email: null },
];

describe('purchase order -> vendor email gate', () => {
  it('allows the vendor email on file, ignoring case and spaces', () => {
    expect(decidePurchaseOrderEmail(order, lines, vendors, ' orders@spinner.example ')).toEqual({ ok: true, vendorId: 'v-1' });
  });

  it('refuses any other recipient', () => {
    expect(decidePurchaseOrderEmail(order, lines, vendors, 'someone@else.example')).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a vendor with no email on file', () => {
    const hydrite = { ...order, vendor: 'Hydrite' };
    expect(decidePurchaseOrderEmail(hydrite, lines, vendors, '')).toMatchObject({ ok: false, status: 400, error: 'Vendor has no email on file' });
  });

  it('refuses a PO whose vendor is not in the vendors list, or is ambiguous', () => {
    expect(decidePurchaseOrderEmail({ ...order, vendor: 'we' }, lines, vendors, 'x@y.example')).toMatchObject({ ok: false, status: 404 });
    expect(decidePurchaseOrderEmail({ ...order, vendor: '' }, lines, vendors, 'x@y.example')).toMatchObject({ ok: false, status: 404 });
    const twice = [...vendors, { id: 'v-3', name: 'SPINNER AG', email: 'orders@spinner.example' }];
    expect(decidePurchaseOrderEmail(order, lines, twice, 'orders@spinner.example')).toMatchObject({ ok: false, status: 409 });
  });

  it('refuses draft, cancelled and fully received POs, and a missing PO', () => {
    for (const status of ['draft', 'cancelled', 'fully_received']) {
      expect(decidePurchaseOrderEmail({ ...order, status }, lines, vendors, 'orders@spinner.example')).toMatchObject({ ok: false, status: 409 });
    }
    expect(decidePurchaseOrderEmail({ ...order, status: 'partially_received' }, lines, vendors, 'orders@spinner.example').ok).toBe(true);
    expect(decidePurchaseOrderEmail(null, lines, vendors, 'orders@spinner.example')).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses a PO with no lines, a zero cost, or a cost still awaiting confirmation', () => {
    const to = 'orders@spinner.example';
    expect(decidePurchaseOrderEmail(order, [], vendors, to)).toMatchObject({ ok: false, status: 409 });
    expect(decidePurchaseOrderEmail(order, [{ unit_cost: 0, cost_needs_review: false }], vendors, to)).toMatchObject({ ok: false, status: 409 });
    expect(decidePurchaseOrderEmail(order, [{ unit_cost: null, cost_needs_review: false }], vendors, to)).toMatchObject({ ok: false, status: 409 });
    expect(decidePurchaseOrderEmail(order, [{ unit_cost: 9, cost_needs_review: true }], vendors, to)).toMatchObject({ ok: false, status: 409 });
  });
});

// CRLF-normalized so Windows checkouts match the LF snippets below.
const source = readFileSync('supabase/functions/send-email/index.ts', 'utf8').replace(/\r\n/g, '\n');

describe('send-email purchase order wiring', () => {
  it('limits purchase_order emails to admins', () => {
    expect(source).toContain('admin: ALL_EMAIL_TYPES,');
    expect(source).toContain('sales_rep: CUSTOMER_EMAIL_TYPES,');
    expect(source).toContain('driver: new Set(["delivery_completed"]),');
    const customerTypes = source.slice(source.indexOf('const CUSTOMER_EMAIL_TYPES'), source.indexOf(']);', source.indexOf('const CUSTOMER_EMAIL_TYPES')));
    expect(customerTypes).not.toContain('purchase_order');
  });

  it('checks the vendor recipient before the write-ahead log and again before the provider call', () => {
    const firstGate = source.indexOf('const poGate = await checkPurchaseOrderEmail(adminClient, resource_id, to);');
    const logInsert = source.indexOf('.from("email_log")\n        .insert(');
    const finalGate = source.indexOf('const finalPoGate = await checkPurchaseOrderEmail(adminClient, resource_id, to);');
    const outbound = source.indexOf('await fetch("https://api.resend.com/emails"');
    expect(firstGate).toBeGreaterThan(-1);
    expect(logInsert).toBeGreaterThan(firstGate);
    expect(finalGate).toBeGreaterThan(logInsert);
    expect(outbound).toBeGreaterThan(finalGate);
  });

  it('skips the customer lookup only for a purchase order, which must carry no customer_id', () => {
    expect(source).toContain('Purchase order emails must not carry a customer_id');
    expect(source).toContain("Purchase order emails require resource_type='purchase_order' and resource_id");
    expect(source).toContain('} else if (!customer_id) {');
  });
});
