// =============================================================================
// Invoice email content (KNOWN_ISSUES KI-97)
//
// send-email builds an invoice email's subject, wording, amount and attachment
// name from the saved invoice; whatever the browser sends for those is ignored.
// The PDF is still drawn by the app (jsPDF), so the app also sends the money the
// PDF prints, and the send is refused unless that is the saved invoice today:
// the same binding the purchase-order copy uses (purchaseOrderEmailGate.ts).
// Not covered, by design: the PDF bytes themselves (the server trusts the
// signed-in staff member's app to draw the summary it sent; the email can only
// go to the customer's own address on file), and the moment between send-email's
// final re-read of the invoice and the provider call (a payment saved in it still
// goes out with the earlier Amount Due; the purchase-order copy has the same window).
//
// Pure, with no Deno or Supabase imports, so the app's Vitest suite tests it
// directly (src/lib/invoiceEmailGate.test.ts).
// =============================================================================

export interface InvoiceEmailRow {
  invoice_number: string | null;
  invoice_type: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_amount_cents: number | string | null;
  paid_amount_cents: number | string | null;
  prepay_applied_cents: number | string | null;
  balance_cents: number | string | null;
}

/** The money the attached PDF prints, sent by the app alongside the PDF. All whole cents. */
export interface InvoiceEmailSnapshot {
  invoice_number: string;
  total_amount_cents: number;
  paid_amount_cents: number;
  prepay_applied_cents: number;
  balance_cents: number;
  /** Sum of the printed lines' amounts. */
  lines_total_cents: number;
}

export type InvoiceEmailResult =
  | { ok: true; subject: string; html: string; filename: string }
  | { ok: false; status: number; error: string };

const SNAPSHOT_CENTS_FIELDS = [
  "total_amount_cents",
  "paid_amount_cents",
  "prepay_applied_cents",
  "balance_cents",
  "lines_total_cents",
] as const;

/** The snapshot the app sent, or null when it is missing or not whole cents. */
export function parseInvoiceEmailSnapshot(value: unknown): InvoiceEmailSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.invoice_number !== "string") return null;
  if (!SNAPSHOT_CENTS_FIELDS.every((field) => Number.isSafeInteger(raw[field]))) return null;
  return {
    invoice_number: raw.invoice_number,
    total_amount_cents: raw.total_amount_cents as number,
    paid_amount_cents: raw.paid_amount_cents as number,
    prepay_applied_cents: raw.prepay_applied_cents as number,
    balance_cents: raw.balance_cents as number,
    lines_total_cents: raw.lines_total_cents as number,
  };
}

/** PostgREST returns bigint columns as numbers (or strings); anything else is not whole cents. */
function wholeCents(value: number | string | null): number | null {
  const cents = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  return typeof cents === "number" && Number.isSafeInteger(cents) ? cents : null;
}

/** "-$1,234.56" from whole cents, with integer arithmetic only. */
export function formatUsdCents(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** Control characters become spaces: they would break a subject line or a file name. */
function withoutControlCharacters(text: string): string {
  return [...text].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The CRX email frame. Must stay identical to buildEmailHtml in src/lib/emailService.ts (a test checks). */
export function wrapEmailHtml(bodyContent: string): string {
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

/**
 * Builds the invoice email from the saved invoice and its lines' amounts, or refuses
 * when the PDF the app attached (described by `snapshot`) is not the invoice today.
 */
export function buildInvoiceEmail(
  invoice: InvoiceEmailRow | null,
  lineExtendedCents: readonly (number | string | null)[],
  snapshot: InvoiceEmailSnapshot,
): InvoiceEmailResult {
  if (!invoice) return { ok: false, status: 404, error: "Invoice not found" };
  const total = wholeCents(invoice.total_amount_cents);
  const paid = wholeCents(invoice.paid_amount_cents);
  const prepay = wholeCents(invoice.prepay_applied_cents);
  const balance = wholeCents(invoice.balance_cents);
  const lineCents = lineExtendedCents.map(wholeCents);
  if (total === null || paid === null || prepay === null || balance === null || lineCents.includes(null)) {
    return { ok: false, status: 503, error: "Invoice amounts could not be read as whole cents; send refused" };
  }
  // BigInt: exact however the lines add up along the way.
  const linesTotal = (lineCents as number[]).reduce((sum, cents) => sum + BigInt(cents), 0n);

  const invoiceNumber = invoice.invoice_number || "DRAFT";
  if (
    snapshot.invoice_number !== invoiceNumber ||
    snapshot.total_amount_cents !== total ||
    snapshot.paid_amount_cents !== paid ||
    snapshot.prepay_applied_cents !== prepay ||
    snapshot.balance_cents !== balance ||
    BigInt(snapshot.lines_total_cents) !== linesTotal
  ) {
    return { ok: false, status: 409, error: "The invoice changed after its PDF was built. Reload it and send again" };
  }

  const number = escapeHtml(invoiceNumber);
  const heading = invoice.invoice_type === "field_application" ? "Field Application Invoice" : "Invoice";
  const dueLine = invoice.due_date
    ? `\n          <p style="margin:0 0 8px;color:#374151;">Due Date: ${escapeHtml(invoice.due_date)}</p>`
    : "";
  const html = wrapEmailHtml(`
          <h2 style="margin:0 0 16px;color:#111827;font-size:18px;">${heading} ${number}</h2>
          <p style="margin:0 0 8px;color:#374151;">Amount Due: <strong>${formatUsdCents(balance)}</strong></p>
          <p style="margin:0 0 8px;color:#374151;">Invoice Date: ${escapeHtml(invoice.invoice_date || "N/A")}</p>${dueLine}
          <p style="margin:16px 0 0;color:#374151;">Please find your invoice attached to this email.</p>
          <p style="margin:8px 0 0;color:#6b7280;font-size:13px;">If you have questions about this invoice, please contact us.</p>
        `);
  return {
    ok: true,
    subject: `Invoice ${withoutControlCharacters(invoiceNumber)} from Crop RX Solutions`,
    html,
    filename: `Invoice-${withoutControlCharacters(invoiceNumber).replace(/[\\/:*?"<>|]/g, "-")}.pdf`,
  };
}
