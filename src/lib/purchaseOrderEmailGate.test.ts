import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decidePurchaseOrderEmail,
  parsePurchaseOrderSnapshot,
  type PoGateLine,
  type PoGateOrder,
  type PoGateVendor,
} from '../../supabase/functions/_shared/purchaseOrderEmailGate';

const order: PoGateOrder = { id: 'po-1', vendor: ' Spinner  Ag ', status: 'submitted' };
// PostgREST returns numeric columns as numbers; strings are tolerated too.
const lines: PoGateLine[] = [
  { id: 'l-1', quantity_ordered: 3, unit_cost: 12.5, cost_needs_review: false },
  { id: 'l-2', quantity_ordered: '2.5', unit_cost: '3.00', cost_needs_review: false },
];
const snapshot = [
  { id: 'l-2', quantity_ordered: 2.5, unit_cost: 3 },
  { id: 'l-1', quantity_ordered: 3, unit_cost: 12.5 },
];
const vendors: PoGateVendor[] = [
  { id: 'v-1', name: 'spinner ag', email: 'Orders@Spinner.example' },
  { id: 'v-2', name: 'Hydrite', email: null },
];
const to = 'orders@spinner.example';

describe('purchase order -> vendor email gate', () => {
  it('allows the vendor email on file, ignoring case and runs of spaces', () => {
    expect(decidePurchaseOrderEmail(order, lines, vendors, ' orders@spinner.example ', snapshot)).toEqual({ ok: true, vendorId: 'v-1' });
  });

  it('refuses any other recipient', () => {
    expect(decidePurchaseOrderEmail(order, lines, vendors, 'someone@else.example', snapshot)).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a vendor with no email on file', () => {
    const hydrite = { ...order, vendor: 'Hydrite' };
    expect(decidePurchaseOrderEmail(hydrite, lines, vendors, '', snapshot)).toMatchObject({ ok: false, status: 400, error: 'Vendor has no email on file' });
  });

  it('refuses a PO whose vendor is not in the vendors list, or is ambiguous', () => {
    expect(decidePurchaseOrderEmail({ ...order, vendor: 'we' }, lines, vendors, to, snapshot)).toMatchObject({ ok: false, status: 404 });
    expect(decidePurchaseOrderEmail({ ...order, vendor: '' }, lines, vendors, to, snapshot)).toMatchObject({ ok: false, status: 404 });
    const twice = [...vendors, { id: 'v-3', name: 'SPINNER AG', email: to }];
    expect(decidePurchaseOrderEmail(order, lines, twice, to, snapshot)).toMatchObject({ ok: false, status: 409 });
  });

  it('refuses draft, cancelled and fully received POs, and a missing PO', () => {
    for (const status of ['draft', 'cancelled', 'fully_received']) {
      expect(decidePurchaseOrderEmail({ ...order, status }, lines, vendors, to, snapshot)).toMatchObject({ ok: false, status: 409 });
    }
    expect(decidePurchaseOrderEmail({ ...order, status: 'partially_received' }, lines, vendors, to, snapshot).ok).toBe(true);
    expect(decidePurchaseOrderEmail(null, lines, vendors, to, snapshot)).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses a PO with no lines, a zero cost, or a cost still awaiting confirmation', () => {
    const one = [{ id: 'l-1', quantity_ordered: 1, unit_cost: 9 }];
    expect(decidePurchaseOrderEmail(order, [], vendors, to, one)).toMatchObject({ ok: false, status: 409 });
    for (const line of [
      { id: 'l-1', quantity_ordered: 1, unit_cost: 0, cost_needs_review: false },
      { id: 'l-1', quantity_ordered: 1, unit_cost: null, cost_needs_review: false },
      { id: 'l-1', quantity_ordered: 1, unit_cost: 9, cost_needs_review: true },
    ]) {
      expect(decidePurchaseOrderEmail(order, [line], vendors, to, one)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/confirmed unit cost/) });
    }
  });

  it('refuses when the PDF no longer matches the PO (cost, quantity, or a line added or removed)', () => {
    const changed = /changed after its PDF was built/;
    const cost = [{ ...snapshot[0] }, { ...snapshot[1], unit_cost: 12.49 }];
    const qty = [{ ...snapshot[0], quantity_ordered: 2 }, snapshot[1]];
    expect(decidePurchaseOrderEmail(order, lines, vendors, to, cost)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(changed) });
    expect(decidePurchaseOrderEmail(order, lines, vendors, to, qty)).toMatchObject({ ok: false, error: expect.stringMatching(changed) });
    expect(decidePurchaseOrderEmail(order, lines, vendors, to, [snapshot[0]])).toMatchObject({ ok: false, error: expect.stringMatching(changed) });
    expect(decidePurchaseOrderEmail(order, lines, vendors, to, [...snapshot, { id: 'l-3', quantity_ordered: 1, unit_cost: 1 }])).toMatchObject({ ok: false, error: expect.stringMatching(changed) });
    expect(decidePurchaseOrderEmail(order, lines, vendors, to, [snapshot[0], snapshot[0]])).toMatchObject({ ok: false, error: expect.stringMatching(changed) });
  });

  it('parses only a well-formed snapshot', () => {
    expect(parsePurchaseOrderSnapshot(snapshot)).toEqual(snapshot);
    for (const bad of [undefined, null, [], 'x', [{ id: 'l-1', quantity_ordered: '3', unit_cost: 1 }], [{ id: 'l-1', quantity_ordered: 3 }], [{ id: 'l-1', quantity_ordered: 3, unit_cost: Number.NaN }]]) {
      expect(parsePurchaseOrderSnapshot(bad)).toBeNull();
    }
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

  it('checks the vendor recipient and the PDF lines before the write-ahead log and again before the provider call', () => {
    const firstGate = source.indexOf('const poGate = await checkPurchaseOrderEmail(adminClient, resource_id, to, poSnapshot);');
    const logInsert = source.indexOf('.from("email_log")\n        .insert(');
    const finalGate = source.indexOf('const finalPoGate = await checkPurchaseOrderEmail(adminClient, resource_id, to, poSnapshot);');
    const outbound = source.indexOf('await fetch("https://api.resend.com/emails"');
    expect(firstGate).toBeGreaterThan(-1);
    expect(logInsert).toBeGreaterThan(firstGate);
    expect(finalGate).toBeGreaterThan(logInsert);
    expect(outbound).toBeGreaterThan(finalGate);
    expect(source).toContain('.select("id, quantity_ordered, unit_cost, cost_needs_review")');
  });

  it('skips the customer lookup only for a purchase order, which must carry no customer_id and must carry its lines', () => {
    expect(source).toContain('Purchase order emails must not carry a customer_id');
    expect(source).toContain("Purchase order emails require resource_type='purchase_order' and resource_id");
    expect(source).toContain('Purchase order emails require purchase_order_lines');
    expect(source).toContain('} else if (!customer_id) {');
  });
});
