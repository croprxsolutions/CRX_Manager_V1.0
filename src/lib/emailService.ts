import { supabase } from './db';
import { buildEmailHtml } from '../../supabase/functions/_shared/deliveryReceiptHtml.ts';
import { COMPANY_ORDERING_EMAIL } from './companyInfo';
import type { InvoiceEmailSnapshot } from '../../supabase/functions/_shared/invoiceEmailGate.ts';

// ── Types ──────────────────────────────────────────────────────────────

export type EmailType =
  | 'invoice'
  | 'statement'
  | 'order_confirmed'
  | 'delivery_completed'
  | 'quote'
  | 'ar_reminder'
  | 'low_stock_alert'
  | 'month_end_close'
  // Field-app parity #40: before-application courtesy notice to the job's
  // customer(s). The matching send-email edge allow-list entry is PREPARED but
  // its deploy is gated for Mason (see supabase/functions/send-email/index.ts).
  | 'pre_application_notice'
  // Field-app parity #41: after-application courtesy notice to the job's
  // customer(s). Same gated-deploy story as the pre notice above.
  | 'post_application_notice'
  // To-Do 0.15: a copy of a purchase order emailed to the company ordering address
  // (never a vendor). Admin-only; the edge function checks the recipient.
  | 'purchase_order';

/** What a PO copy's PDF prints; the server refuses the send unless it is still the PO. */
export interface PurchaseOrderEmailSnapshot {
  po_number: string;
  vendor: string | null;
  submitted_date: string | null;
  expected_delivery_date: string | null;
  notes: string | null;
  lines: Array<{
    id: string;
    product_id: string;
    product_name: string;
    epa_registration: string | null;
    unit_size: string | null;
    notes: string | null;
    quantity_ordered: number;
    unit_cost: number;
  }>;
}

// What an invoice email's PDF prints, in whole cents; the server refuses the send unless it is the saved invoice (KI-97).
export { invoiceEmailSnapshot } from '../../supabase/functions/_shared/invoiceEmailGate.ts';
export type { InvoiceEmailSnapshot } from '../../supabase/functions/_shared/invoiceEmailGate.ts';

interface SendEmailBase {
  to: string;
  subject: string;
  html: string;
  /**
   * Optional resource the email is about. REQUIRED for drivers (only allowed
   * email_type='delivery_completed' with resource_type='delivery'). Admins
   * and sales reps may omit; populated for completeness in the audit log.
   */
  resource_type?: 'delivery' | 'invoice' | 'order' | 'quote' | 'customer' | 'purchase_order';
  resource_id?: string;
  idempotency_key?: string;
  attachments?: Array<{ filename: string; content: string }>; // base64
}

/** The server draws the invoice and PO PDFs from the saved record and refuses any the app attaches (KI-98). */
type NoAppAttachments = { attachments?: undefined };

/**
 * Every customer email names its customer; a PO copy names none and carries its snapshot.
 * For an invoice the server writes the subject and body from the saved invoice and ignores
 * these (still sent so an older server keeps working).
 */
export type SendEmailParams =
  | (SendEmailBase & { email_type: Exclude<EmailType, 'purchase_order' | 'invoice'>; customer_id: string })
  | (SendEmailBase & NoAppAttachments & { email_type: 'invoice'; customer_id: string; invoice_snapshot: InvoiceEmailSnapshot })
  | (SendEmailBase & NoAppAttachments & {
      email_type: 'purchase_order';
      customer_id?: undefined;
      purchase_order_screen: PurchaseOrderEmailSnapshot;
    });

export interface SendEmailResult {
  success: boolean;
  email_log_id?: string;
  resend_message_id?: string;
  /** true when the edge function deduped this call via its idempotency key — no new email went out */
  deduplicated?: boolean;
  error?: string;
}

/** The email may have reached the customer, but the server could not confirm it. Not a failure. */
export class EmailUnconfirmedError extends Error {}

// ── sendEmail ──────────────────────────────────────────────────────────

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw new Error(`Auth session error: ${sessionError.message}`);
  if (!session) throw new Error('Not authenticated');

  // Once the request leaves, the server may send the email even if no answer comes back.
  const resp = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-email`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(params),
    },
  ).catch((err: unknown) => {
    throw new EmailUnconfirmedError(`Lost the connection to the email service; this email may have been sent (${err instanceof Error ? err.message : String(err)})`);
  });

  let result: Record<string, unknown>;
  try {
    result = await resp.json();
  } catch {
    throw new EmailUnconfirmedError(`Email service returned an unreadable response (HTTP ${resp.status}); this email may have been sent`);
  }
  if (!resp.ok) {
    const message = (result.error as string) || 'Email send failed';
    // A definite refusal says success: false. A 5xx without it (a gateway timeout, a
    // server error) does not say whether the email went out.
    const unconfirmed = result.needs_reconciliation === true || (resp.status >= 500 && result.success !== false);
    throw unconfirmed ? new EmailUnconfirmedError(message) : new Error(message);
  }
  return result as unknown as SendEmailResult;
}

// ── pdfToBase64 ────────────────────────────────────────────────────────
// Converts a jsPDF doc instance to a raw base64 string (no data URI prefix).

export function pdfToBase64(doc: { output: (type: string) => string }): string {
  // jsPDF.output('datauristring') returns "data:application/pdf;filename=...;base64,<data>"
  const dataUri = doc.output('datauristring');
  const base64Part = dataUri.split('base64,')[1];
  return base64Part;
}

// ── buildInvoiceEmailPayload ───────────────────────────────────────────
// Pure builder for an "email this invoice to the customer" send. Centralises the
// recipient guard + subject + branded body + idempotency key
// so every field-app screen (editor toolbar, list rows) sends an IDENTICAL,
// correctly-addressed payload. Throws the honest, user-facing error when there is
// no email on file so the caller never sends to a blank/wrong address.
//
// No PDF goes with it: the send-email server draws the invoice PDF from the saved
// invoice and attaches that (KNOWN_ISSUES KI-98).

export interface InvoiceEmailInput {
  /** The customer's billing email, already resolved from THIS invoice's customer. */
  customerEmail: string | null | undefined;
  customerId: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  /** Authoritative AR balance in cents (GENERATED invoices.balance_cents). */
  balanceCents: number;
  /** What the screen's PDF prints — see invoiceEmailSnapshot(). */
  snapshot: InvoiceEmailSnapshot;
  /** Unique-per-send token; defaults to a per-invoice + timestamp key. */
  nowMs?: number;
}

/** Per-line split billing: a $0 split child invoice is recorded + shown in the account
 *  summary but must never be emailed. Gate on the server-computed send_disposition ONLY
 *  (a paid-in-full invoice is also $0 but stays emailable). */
export function isInvoiceEmailSuppressed(
  invoice: { send_disposition?: string | null } | null | undefined
): boolean {
  return invoice?.send_disposition === 'suppressed_zero_total';
}

export function buildInvoiceEmailPayload(input: InvoiceEmailInput): SendEmailParams {
  const email = input.customerEmail?.trim();
  if (!email) {
    // Same wording the InvoiceDetail / list handlers use — honest, not a silent send.
    throw new Error('Customer does not have an email address on file');
  }

  const amountStr = (input.balanceCents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
  const html = buildEmailHtml(`
          <h2 style="margin:0 0 16px;color:#111827;font-size:18px;">Field Application Invoice ${input.invoiceNumber}</h2>
          <p style="margin:0 0 8px;color:#374151;">Amount Due: <strong>${amountStr}</strong></p>
          <p style="margin:0 0 8px;color:#374151;">Invoice Date: ${input.invoiceDate}</p>
          <p style="margin:16px 0 0;color:#374151;">Please find your invoice attached to this email.</p>
        `);

  return {
    to: email,
    subject: `Invoice ${input.invoiceNumber} from Crop RX Solutions`,
    html,
    email_type: 'invoice',
    customer_id: input.customerId,
    resource_type: 'invoice',
    resource_id: input.invoiceId,
    idempotency_key: `invoice-email-${input.invoiceId}-${input.nowMs ?? Date.now()}`,
    invoice_snapshot: input.snapshot,
  };
}

// ── Purchase order copy (To-Do 0.15) ──────────────────────────────────
// Mason places each order himself through the supplier's portal, so a PO copy
// goes to the company ordering address, never to a vendor. The send-email edge
// function repeats these checks; here they give the honest message before
// anything is built or sent.

const PO_EMAIL_STATUSES = ['submitted', 'partially_received'] as const;

export interface PurchaseOrderEmailCheckInput {
  status: string;
  /** Each line's unit cost (dollars) and whether an admin still has to confirm it. */
  lines: ReadonlyArray<{ unit_cost?: number | null; cost_needs_review?: boolean }>;
}

/** Why this PO copy cannot be emailed yet, or null when it can. */
export function purchaseOrderEmailBlocker(input: PurchaseOrderEmailCheckInput): string | null {
  if (!(PO_EMAIL_STATUSES as readonly string[]).includes(input.status)) {
    return 'Only a submitted or partly received purchase order can be emailed. Download the PDF instead.';
  }
  if (input.lines.length === 0) return 'This purchase order has no lines to send.';
  if (input.lines.some((line) => !line.unit_cost || line.unit_cost <= 0 || line.cost_needs_review)) {
    return 'Confirm the unit cost on every line before emailing this purchase order.';
  }
  return null;
}

export interface PurchaseOrderEmailInput {
  vendorName: string;
  purchaseOrderId: string;
  poNumber: string;
  /** Already formatted for display, or null. */
  expectedDeliveryDate: string | null;
  /** The screen's retained idempotency key, so a retry after a lost response replays one send. */
  idempotencyKey: string;
  /** What the PDF prints (dollar unit costs, as stored). */
  snapshot: PurchaseOrderEmailSnapshot;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildPurchaseOrderEmailPayload(input: PurchaseOrderEmailInput): SendEmailParams {
  const poNumber = escapeHtml(input.poNumber);
  const delivery = input.expectedDeliveryDate
    ? `<p style="margin:0 0 8px;color:#374151;">Requested delivery: ${escapeHtml(input.expectedDeliveryDate)}</p>`
    : '';
  const html = buildEmailHtml(`
          <h2 style="margin:0 0 16px;color:#111827;font-size:18px;">Purchase Order ${poNumber} (copy)</h2>
          <p style="margin:0 0 8px;color:#374151;">Vendor: ${escapeHtml(input.vendorName)}</p>
          ${delivery}
          <p style="margin:16px 0 0;color:#374151;">The purchase order PDF is attached, for placing this order through the vendor's portal.</p>
        `);

  return {
    to: COMPANY_ORDERING_EMAIL,
    subject: `PO copy ${input.poNumber} - ${input.vendorName}`,
    html,
    email_type: 'purchase_order',
    resource_type: 'purchase_order',
    resource_id: input.purchaseOrderId,
    idempotency_key: input.idempotencyKey,
    purchase_order_screen: input.snapshot,
  };
}

// buildEmailHtml wraps body content in the CRX-branded HTML email template (shared with Edge Functions).
export { buildEmailHtml };
