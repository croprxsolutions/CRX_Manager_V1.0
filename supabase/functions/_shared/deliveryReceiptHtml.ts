// The CRX email shell and the customer delivery receipt, shared by the app (src/lib re-exports these) and the
// send-delivery-receipts Edge Function (KI-25), so a receipt looks the same whichever side sends it.
import { receiptBrandNotes, type ReceiptBrandInfo } from './brandNotes.ts';

/** Escapes text placed into email HTML (send-email does not escape the HTML it is given). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wraps body content in the CRX-branded HTML email template. */
export function buildEmailHtml(bodyContent: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:24px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <!-- Header -->
          <tr>
            <td style="background-color:#16a34a;padding:20px 24px;border-radius:8px 8px 0 0;">
              <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">
                Crop RX Solutions
              </h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background-color:#ffffff;padding:24px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
              ${bodyContent}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb;padding:16px 24px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:0;">
              <p style="margin:0 0 4px;color:#6b7280;font-size:12px;">
                Crop RX Solutions &bull; croprxsolutions.app
              </p>
              <p style="margin:0;color:#9ca3af;font-size:11px;">
                This is an automated message. Please contact us if you have questions.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** brands / brand_recorded / brand_picked_quantity: Brand PR B-3 (absent on a receipt queued before it). */
export interface DeliveryReceiptLine extends ReceiptBrandInfo {
  name: string;
  qty: number;
}

export interface DeliveryReceiptInput {
  /** 'completed' is sent when the delivery is completed; 'confirmation' is the office resend. */
  variant: 'completed' | 'confirmation';
  deliveryNumber: string;
  contactName: string | null;
  /** Already formatted for display (the completion day, or the paper-ticket day). */
  dateText: string;
  lines: DeliveryReceiptLine[];
  signedBy: string | null;
  isPartial: boolean;
}

/**
 * The customer's delivery receipt email, shared by completion and resend.
 *
 * Every typed value (product names, the contact name, the "Signed by" name) is escaped:
 * send-email does not escape the HTML it is given, so a name containing `<` or `&` would
 * otherwise break the email or inject markup into it. (Readability report B1, 2026-10-23.)
 */
export function buildDeliveryReceiptHtml(input: DeliveryReceiptInput): string {
  const completed = input.variant === 'completed';
  const deliveryNumber = escapeHtml(input.deliveryNumber);

  const lineRows = input.lines
    .map((line) => `<tr>
              <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;">${escapeHtml(line.name)}${receiptBrandNotes(line)
                .map((note) => `<br><span style="color:#64748b;font-size:12px;">${escapeHtml(note)}</span>`).join('')}</td>
              <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;text-align:right;">${line.qty}</td>
            </tr>`)
    .join('');

  // No delivery photos in the customer email (Mason, 2026-10-14): photos are
  // private staff records and a link in an email would work for anyone holding it.
  const signatureNote = input.signedBy
    ? `<p style="color:#475569;font-size:13px;">${completed ? '' : '✍️ '}Signed by: <strong>${escapeHtml(input.signedBy)}</strong></p>`
    : '';
  const partialNote = input.isPartial
    ? '<p style="color:#d97706;font-size:13px;font-weight:600;margin-top:8px;">This was a partial delivery. Remaining items will be delivered separately.</p>'
    : '';
  const intro = completed
    ? `Your delivery <strong>${deliveryNumber}</strong> has been completed.`
    : `Here is your delivery confirmation for <strong>${deliveryNumber}</strong>.`;

  return buildEmailHtml(`
            <h2 style="color:#1e293b;margin:0 0 12px;">${completed ? 'Delivery Completed' : 'Delivery Confirmation'}</h2>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Hi${input.contactName ? ` ${escapeHtml(input.contactName)}` : ''},
            </p>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              ${intro}
            </p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr>
                <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;color:#166534;">Delivery #</td>
                <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;font-weight:600;color:#166534;">${deliveryNumber}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">${completed ? 'Date' : 'Completed'}</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${escapeHtml(input.dateText)}</td>
              </tr>
            </table>
            <h3 style="color:#1e293b;font-size:14px;margin:16px 0 8px;">Delivered Items</h3>
            <table style="width:100%;border-collapse:collapse;">
              <tr style="background:#f8fafc;">
                <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:left;color:#64748b;">Product</th>
                <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:right;color:#64748b;">Qty Delivered</th>
              </tr>
              ${lineRows}
            </table>
            ${partialNote}
            ${signatureNote}
            <p style="color:#475569;font-size:14px;line-height:1.6;margin-top:16px;">
              Thank you for your business!
            </p>
          `);
}
