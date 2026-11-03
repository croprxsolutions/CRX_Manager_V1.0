import { describe, expect, it } from 'vitest';
import type { DetailedStatementData } from '../types';
import {
  attachmentProblem,
  emailContentProblem,
} from '../../supabase/functions/_shared/emailContentGate';
import { buildEmailHtml, buildInvoiceEmailPayload, buildPurchaseOrderEmailPayload } from './emailService';
import { buildDeliveryReceiptHtml } from './deliveryReceiptEmail';
import { buildPostNotificationEmailPayload } from './postNotification';
import { buildPreNotificationEmailPayload } from './preNotification';
import { buildProofDraft, buildProofEmailPayload, type JobProofData } from './proofNotification';
import { buildStatementEmailContent } from './statementEmail';

const proofData: JobProofData = {
  job_id: 'job-1',
  job_number: 'FJOB-003',
  status: 'completed',
  application_date: '2026-06-12',
  applicator_name: 'Carl <Applicator> & Sons',
  fields: [{
    field_id: 'f1',
    field_name: 'South "Creek"',
    county: 'Dakota',
    state: 'MN',
    acres: 118.4,
    acres_source: 'measured',
    centroid_geojson: '{"type":"Point","coordinates":[-93.05,44.75]}',
    boundary_geojson: null,
    harvest_date: '2026-07-01',
    sort_order: 0,
  }],
  products: [{
    product_name: 'Headline <b>Fungicide</b>',
    rate_per_acre: 1,
    rate_unit: 'oz/ac',
    rei_hours: 12,
    phi_days: 21,
    signal_word: 'Caution',
    epa_registration: 'EPA-123',
    sort_order: 0,
  }],
  weather: { temperature: 78, wind_speed: 6.5, wind_direction: 'NW', humidity: 55, actual_start: null, actual_end: null },
};

const statement = {
  customer: { id: 'c1', farm_name: 'Smith & <Sons>', contact_name: null, account_number: 'A-1', email: 'x@example.test',
    phone: null, billing_address: null, city: null, state: null, zip: null, payment_terms: 'Net 30' },
  transactions: [{ invoice_number: 'INV-1' }],
  aging: { current_cents: 10_000, days_30_cents: 0, days_60_cents: 0, days_90_cents: 0, over_120_cents: 0 },
  outstanding_balance_cents: 10_000,
  open_credit_cents: 0,
  net_account_position_cents: 10_000,
  as_of_date: '2026-08-03',
  mode: 'summary',
} as DetailedStatementData;

describe('emailContentProblem accepts every email the app builds', () => {
  const payloads = [
    buildInvoiceEmailPayload({ customerEmail: 'a@b.test', customerId: 'c1', invoiceId: 'i1', invoiceNumber: 'INV-1',
      invoiceDate: '2026-11-02', balanceCents: 12_345, attachmentBase64: 'JVBERi0x',
      snapshot: { invoice_number: 'INV-1', total_amount_cents: 12_345, paid_amount_cents: 0, prepay_applied_cents: 0, balance_cents: 12_345, lines_total_cents: 12_345 } }),
    buildPurchaseOrderEmailPayload({ vendorName: 'Spinner <Ag>', purchaseOrderId: 'po-1', poNumber: 'PO-1',
      expectedDeliveryDate: '11/3/2026', attachmentBase64: 'JVBERi0x', attachmentFilename: 'Purchase-Order-PO-1.pdf',
      idempotencyKey: 'k', snapshot: { po_number: 'PO-1', vendor: null, submitted_date: null, expected_delivery_date: null, notes: null, lines: [] } }),
    buildPreNotificationEmailPayload({ customerEmail: 'a@b.test', customerId: 'c1', jobId: 'j1',
      subject: 'Upcoming application', body: 'Hi <Farm> & co\n\nSee you soon' }),
    buildPostNotificationEmailPayload({ customerEmail: 'a@b.test', customerId: 'c1', jobId: 'j1',
      subject: 'Done', body: 'Line one\n\nLine "two"' }),
    buildProofEmailPayload({ customerEmail: 'a@b.test', customerId: 'c1', customerName: '<Green> Acres', jobId: 'job-1',
      invoiceId: 'i1', draft: buildProofDraft(proofData), emailIdempotencyKey: 'k:c1' }),
  ];
  it.each(payloads.map((p) => [p.email_type, p]))('%s payload', (_type, p) => {
    expect(emailContentProblem(p.subject, p.html)).toBeNull();
  });

  it('proof email keeps its map image and link', () => {
    expect(payloads[4].html).toContain('staticmap.openstreetmap.de');
    expect(payloads[4].html).toContain('<a href="https://www.openstreetmap.org/');
  });

  it('delivery receipt and statement bodies', () => {
    const receipt = buildEmailHtml(buildDeliveryReceiptHtml({ variant: 'completed', deliveryNumber: 'DEL-1',
      contactName: 'Pat <x>', dateText: '10/23/2026', lines: [{ name: '2,4-D <Amine>', qty: 5 }], signedBy: 'Pat', isPartial: true }));
    expect(emailContentProblem('Delivery DEL-1 Completed — Crop RX Solutions', receipt)).toBeNull();
    expect(emailContentProblem('Statement of Account', buildEmailHtml(buildStatementEmailContent(statement, '8/3/2026')))).toBeNull();
  });
});

describe('emailContentProblem refuses anything beyond plain formatting', () => {
  const ok = 'Invoice INV-1';
  it.each([
    ['script', '<p>hi</p><script>alert(1)</script>'],
    ['style tag', '<style>p{}</style>'],
    ['iframe', '<iframe src="https://croprxsolutions.app"></iframe>'],
    ['form', '<form><input name="pw"></form>'],
    ['event handler', '<p onclick="x()">hi</p>'],
    ['javascript link', '<a href="javascript:alert(1)">x</a>'],
    ['outside link', '<a href="https://evil.example/login">Pay here</a>'],
    ['lookalike host', '<a href="https://croprxsolutions.app.evil.example/">x</a>'],
    ['http link', '<a href="http://croprxsolutions.app/">x</a>'],
    ['userinfo link', '<a href="https://user@croprxsolutions.app/">x</a>'],
    ['other port', '<img src="https://croprxsolutions.app:8443/x.png">'],
    ['entity-hidden scheme', '<a href="&#106;avascript:alert(1)">x</a>'],
    ['tracking image', '<img src="https://evil.example/pixel.gif">'],
    ['map image with extra data', '<img src="https://staticmap.openstreetmap.de/staticmap.php?center=40.12345,-90.12345&amp;zoom=14&amp;size=480x280&amp;markers=40.12345,-90.12345,red-pushpin&amp;c=Smith+Farms">'],
    ['map image other path', '<img src="https://staticmap.openstreetmap.de/track.php?id=Smith">'],
    ['map link with extra data', '<a href="https://www.openstreetmap.org/?mlat=40.12345&amp;mlon=-90.12345&amp;who=Smith#map=14/40.12345/-90.12345">x</a>'],
    ['css url', '<p style="background:url(https://evil.example/x)">x</p>'],
    ['css escape', '<p style="background:\\75rl(x)">x</p>'],
    ['unquoted attribute', '<p style=color:red>x</p>'],
    ['bare angle bracket', '<p>a <b c</p>'],
    ['conditional comment', '<!--[if mso]><script>x</script><![endif]-->'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
  ])('%s', (_name, html) => {
    expect(emailContentProblem(ok, html)).not.toBeNull();
  });

  it('treats only HTML whitespace as an attribute separator', () => {
    for (const space of [' ', '﻿', ' ', '　']) {
      expect(emailContentProblem(ok, `<p style=${space}"color:red">x</p>`)).not.toBeNull();
      expect(emailContentProblem(ok, `<p${space}style="color:red">x</p>`)).not.toBeNull();
    }
    expect(emailContentProblem(ok, '<p\tstyle =\n"color:red">x</p>')).toBeNull();
  });

  it('refuses entities, quotes and image functions in a style', () => {
    for (const style of ['color:&#114;ed', 'color:&lt;', 'font-family:\'x\'', 'background-image:none', 'background:url', 'background:u/**/rl(x)']) {
      expect(emailContentProblem(ok, `<p style="${style}">x</p>`)).not.toBeNull();
    }
  });

  it('subject must be one plain line', () => {
    expect(emailContentProblem('Hi\nBcc: x@evil.example', '<p>x</p>')).not.toBeNull();
    expect(emailContentProblem('  ', '<p>x</p>')).not.toBeNull();
    expect(emailContentProblem('x'.repeat(201), '<p>x</p>')).not.toBeNull();
  });
});

describe('attachmentProblem', () => {
  it('accepts a plainly named base64 PDF', () => {
    expect(attachmentProblem('Statement-Smith___Sons-2026-08-03.pdf', 'JVBERi0xLjM=')).toBeNull();
  });
  it('refuses other files, odd names and non-PDF content', () => {
    expect(attachmentProblem('invoice.html', 'JVBERi0x')).not.toBeNull();
    expect(attachmentProblem('../x.pdf', 'JVBERi0x')).not.toBeNull();
    expect(attachmentProblem('x.pdf', 'PGh0bWw+')).not.toBeNull();
    expect(attachmentProblem('x.pdf', 'JVBERi0x\n<html>')).not.toBeNull();
    expect(attachmentProblem('x.pdf', 'JVBERA==')).not.toBeNull();
    expect(attachmentProblem(undefined, 'JVBERi0x')).not.toBeNull();
  });
});
