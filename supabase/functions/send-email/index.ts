import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { jsPDF } from "npm:jspdf@4.2.1";
import { autoTable } from "npm:jspdf-autotable@5.0.9";
import { captureEdgeException } from "../_shared/sentry.ts";
import { requireActiveProfile } from "../_shared/auth.ts";
import { corsHeaders, preflightResponse } from "../_shared/cors.ts";
import {
  decidePurchaseOrderEmail,
  parsePurchaseOrderSnapshot,
  type PoGateLine,
  type PoGateOrder,
  type PoGateSnapshot,
} from "../_shared/purchaseOrderEmailGate.ts";
import { appSuppliedPdfProblem, attachmentProblem, emailContentProblem } from "../_shared/emailContentGate.ts";
import {
  buildInvoiceEmail,
  invoiceEmailSnapshot,
  parseInvoiceEmailSnapshot,
  type InvoiceEmailResult,
  type InvoiceEmailSnapshot,
} from "../_shared/invoiceEmailGate.ts";
import { drawInvoicePdf, loadInvoicePdfData } from "../_shared/pdf/invoicePdf.ts";
import { loadCompanyInfo } from "../_shared/pdf/companyInfo.ts";
import {
  buildPurchaseOrderPdfData,
  drawPurchaseOrderPdf,
  loadPurchaseOrderVendor,
  purchaseOrderPdfFilename,
} from "../_shared/pdf/purchaseOrderPdf.ts";

// =============================================================================
// CRX send-email — Sprint F #1 lockdown
//
// Hardens the email Edge Function against arbitrary-recipient + arbitrary-type
// abuse vectors flagged in the security audit:
//   1. Recipient `to` MUST match customer.email for the supplied customer_id
//      (server-side lookup; caller-provided `to` is validated, never trusted).
//      A 'purchase_order' email is a PO copy for placing the order through the
//      supplier's portal: `to` must be the company ordering address, never a
//      vendor (To-Do 0.15; _shared/purchaseOrderEmailGate.ts).
//   2. email_type is allowlisted per role:
//        admin            -> every type, including purchase_order
//        sales_rep        -> the customer types except ar_reminder
//        driver           -> only delivery_completed (with proof of assignment)
//        (ar_reminder is admin-only; reps send invoices and statements;
//        Mason, 2026-11-05)
//   3. Drivers must supply resource_type='delivery' + resource_id and be the
//      assigned driver of that delivery; the delivery's customer_id must
//      match the request's customer_id.
//   4. Attachments capped at 5 files / 10MB total decoded.
//   5. Per-user rate limit of 50 emails per rolling hour (counts email_log).
//   6. Every customer email names one record that belongs to its customer
//      (an invoice, delivery, order, quote, or job notice; statements and AR
//      reminders are about the customer's account). The caller still writes the
//      HTML, so _shared/emailContentGate.ts refuses anything beyond plain
//      formatting, and attachments must be PDFs (audit finding 7, 2026-11-02).
//   7. The idempotency key is scoped to email_type + record, so a reused key
//      can never replay or block a different email; a key already used for a
//      different email is refused (audit finding 8, 2026-11-02).
//   8. An invoice email's subject, wording, amount and attachment name are built
//      here from the saved invoice; the caller's are ignored. The screen it was
//      sent from must show the invoice's money as saved now (KI-97).
//   9. Invoice and purchase order PDFs are drawn here from the saved record
//      (_shared/pdf/); a PDF the caller attaches to those is refused (KI-98).
// =============================================================================

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// --- Allowlists ---------------------------------------------------------------

const CUSTOMER_EMAIL_TYPES = new Set([
  "invoice",
  "statement",
  "order_confirmed",
  "delivery_completed",
  "quote",
  "ar_reminder",
  // Field-app parity #40: before-application customer notice. Sendable by
  // admin + sales_rep (it is in ALL_EMAIL_TYPES, which both roles map to below);
  // NOT a driver type. This line is PREPARED but its effect only goes live when
  // this edge function is DEPLOYED — that deploy is GATED for Mason. The local
  // `pre_application_notice` enum value migration is applied to LOCAL only.
  "pre_application_notice",
  // Field-app parity #41: after-application customer notice. Same as the pre
  // notice above — admin + sales_rep only (via ALL_EMAIL_TYPES), NOT a driver
  // type. PREPARED here but its effect only goes live when this edge function is
  // DEPLOYED — that deploy is GATED for Mason. The local `post_application_notice`
  // enum value migration is applied to LOCAL only.
  "post_application_notice",
]);

// To-Do 0.15: a copy of a purchase order emailed to the company ordering address.
// It shows purchase costs, which are admin-only (Mason, 2026-10-18), so only
// admins may send it.
const PURCHASE_ORDER_EMAIL_TYPE = "purchase_order";
// A malformed PO id is a bad request (400), not a failed lookup (503).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALL_EMAIL_TYPES = new Set([...CUSTOMER_EMAIL_TYPES, PURCHASE_ORDER_EMAIL_TYPE]);

// The record each of these types is about, checked to belong to customer_id.
// invoice, the job notices and purchase_order are checked in their own steps;
// statement and ar_reminder are about the customer's whole account.
const RECORD_BY_EMAIL_TYPE: Record<string, { resourceType: string; table: string }> = {
  delivery_completed: { resourceType: "delivery", table: "deliveries" },
  order_confirmed: { resourceType: "order", table: "orders" },
  quote: { resourceType: "quote", table: "quotes" },
};
const JOB_NOTICE_TYPE_BY_EMAIL_TYPE: Record<string, string> = {
  pre_application_notice: "pre",
  post_application_notice: "post",
};

// Collection reminders are admin-only; reps may send invoices and statements
// (Mason, 2026-11-05, revising the 2026-11-02 #1302 answer).
const ADMIN_ONLY_CUSTOMER_EMAIL_TYPES = new Set(["ar_reminder"]);

// What email types each role may send.
//   admin     -> all types in ALL_EMAIL_TYPES (incl. purchase_order)
//   sales_rep -> the customer types except ar_reminder
//   driver    -> only delivery_completed
const EMAIL_TYPES_BY_ROLE: Record<string, Set<string>> = {
  admin: ALL_EMAIL_TYPES,
  sales_rep: new Set([...CUSTOMER_EMAIL_TYPES].filter((t) => !ADMIN_ONLY_CUSTOMER_EMAIL_TYPES.has(t))),
  driver: new Set(["delivery_completed"]),
};

// Attachment limits
const MAX_ATTACHMENTS = 5;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB after base64 decode

// Rate limit
const RATE_LIMIT_PER_HOUR = 50;

// How long to wait for the email provider before marking the send failed.
const RESEND_TIMEOUT_MS = 30_000;
// Resend's documented error replies for a request it refused (nothing sent).
const RESEND_REFUSAL_STATUSES = new Set([400, 401, 403, 404, 405, 409, 422, 429]);

// jsPDF's data URI is "data:application/pdf;filename=...;base64,<data>".
function pdfBase64(doc: { output: (type: "datauristring") => string }): string {
  return doc.output("datauristring").split("base64,")[1] ?? "";
}

function decodedBase64Length(b64: string): number {
  // base64 expands 3 bytes -> 4 chars (with == padding). Use the standard formula:
  // bytes = (len(b64) * 3 / 4) - padding_count
  const padding = (b64.match(/=+$/) || [""])[0].length;
  return Math.floor((b64.length * 3) / 4) - padding;
}

// Reads the saved invoice and its lines and builds the email from them. Any read
// error refuses the send (503): never state an amount on a guess.
async function loadInvoiceEmail(
  adminClient: SupabaseClient,
  invoiceId: string,
  snapshot: InvoiceEmailSnapshot,
): Promise<InvoiceEmailResult> {
  const { data: invoice, error: invoiceErr } = await adminClient
    .from("invoices")
    .select("invoice_number, invoice_type, invoice_date, due_date, total_amount_cents, paid_amount_cents, prepay_applied_cents, balance_cents")
    .eq("id", invoiceId)
    .maybeSingle();
  if (invoiceErr) return { ok: false, status: 503, error: `Invoice lookup failed: ${invoiceErr.message}` };
  const { data: lines, error: linesErr } = await adminClient
    .from("invoice_items")
    .select("extended_cents")
    .eq("invoice_id", invoiceId);
  if (linesErr || !Array.isArray(lines)) {
    return { ok: false, status: 503, error: `Invoice lines lookup failed: ${linesErr?.message ?? "no list"}` };
  }
  return buildInvoiceEmail(invoice, lines.map((line) => line.extended_cents), snapshot);
}

// Reads what the purchase-order gate needs and lets it decide; on a pass, returns
// the order and lines read, which the PDF is drawn from. Any read error refuses
// the send (503): never send a PO copy on a guess.
async function checkPurchaseOrderEmail(
  adminClient: SupabaseClient,
  purchaseOrderId: string,
  to: string,
  snapshot: PoGateSnapshot,
): Promise<
  | { ok: true; order: PoGateOrder; lines: PoGateLine[] }
  | { ok: false; status: number; error: string }
> {
  const { data: order, error: orderErr } = await adminClient
    .from("purchase_orders")
    .select("id, po_number, status, vendor, submitted_date, expected_delivery_date, notes")
    .eq("id", purchaseOrderId)
    .maybeSingle();
  if (orderErr) return { ok: false, status: 503, error: `Purchase order lookup failed: ${orderErr.message}` };
  if (!order) {
    const missing = decidePurchaseOrderEmail(null, [], to, snapshot);
    return missing.ok ? { ok: false, status: 404, error: "Purchase order not found" } : missing;
  }

  const { data: lines, error: linesErr } = await adminClient
    .from("purchase_order_items")
    .select("id, product_id, quantity_ordered, unit_cost, cost_needs_review, unit_size, notes, product_name, product:products(product_name, epa_registration)")
    .eq("purchase_order_id", purchaseOrderId);
  if (linesErr || !Array.isArray(lines)) {
    return { ok: false, status: 503, error: `Purchase order lines lookup failed: ${linesErr?.message ?? "no list"}` };
  }

  // `product` is a many-to-one embed, so PostgREST returns one object (or null); the
  // untyped client infers an array, hence the cast.
  const poLines = lines as unknown as PoGateLine[];
  const decision = decidePurchaseOrderEmail(order, poLines, to, snapshot);
  return decision.ok ? { ok: true, order, lines: poLines } : decision;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return preflightResponse(req);
  }

  try {
    // 1. JWT validation
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing authorization" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) {
      return jsonResponse({ error: "Invalid token" }, 401);
    }

    // 2. Role lookup (Codex audit F1, P1, 2026-05-16): is_active gate enforced.
    // Pass `undefined` for allowedRoles because send-email branches on role via
    // EMAIL_TYPES_BY_ROLE below — we still need a check, but the role membership
    // is enforced by that lookup, not by requireActiveProfile.
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const gate = await requireActiveProfile(adminClient, caller.id);
    if ("error" in gate) {
      return jsonResponse({ error: gate.error }, gate.status);
    }
    const role = gate.profile.role;
    if (!EMAIL_TYPES_BY_ROLE[role]) {
      return jsonResponse({ error: "Insufficient role" }, 403);
    }

    // 3. Parse body
    const body = await req.json();
    const {
      to,
      email_type,
      customer_id: rawCustomerId,
      resource_type,
      resource_id: rawResourceId,
      idempotency_key,
      // Renamed from purchase_order_snapshot with KI-98, so a send-email from before
      // KI-98 refuses this app's PO copy instead of mailing it with no PDF.
      purchase_order_screen,
      invoice_snapshot,
    } = body;
    // Postgres answers uuids in lowercase; compare like with like (Luna r6).
    const customer_id = typeof rawCustomerId === "string" ? rawCustomerId.toLowerCase() : rawCustomerId;
    const resource_id = typeof rawResourceId === "string" ? rawResourceId.toLowerCase() : rawResourceId;
    // An invoice email's subject, body and attachment name are replaced below (step 6c).
    let { subject, html, attachments } = body;
    const isInvoiceEmail = email_type === "invoice";

    if (!to || !email_type || (!isInvoiceEmail && (!subject || !html))) {
      return jsonResponse({ error: "to, subject, html, and email_type are required" }, 400);
    }
    // What the attached PDF prints; the invoice must still say the same (KI-97).
    const invoiceSnapshot = isInvoiceEmail ? parseInvoiceEmailSnapshot(invoice_snapshot) : null;
    if (isInvoiceEmail && !invoiceSnapshot) {
      return jsonResponse(
        { error: "Invoice emails require invoice_snapshot (what the PDF shows). Reload the app and send again" },
        400,
      );
    }
    const isPurchaseOrderEmail = email_type === PURCHASE_ORDER_EMAIL_TYPE;
    // What the attached PDF printed; the gate refuses unless it is the PO today.
    const poSnapshot = isPurchaseOrderEmail ? parsePurchaseOrderSnapshot(purchase_order_screen) : null;
    if (isPurchaseOrderEmail) {
      if (!poSnapshot) {
        return jsonResponse({ error: "Purchase order emails require purchase_order_screen (what the screen showed). Reload the app and send again" }, 400);
      }
      // A PO copy is about a PO, never a customer.
      if (customer_id) {
        return jsonResponse({ error: "Purchase order emails must not carry a customer_id" }, 400);
      }
      if (resource_type !== "purchase_order" || typeof resource_id !== "string" || !UUID_PATTERN.test(resource_id)) {
        return jsonResponse(
          { error: "Purchase order emails require resource_type='purchase_order' and resource_id" },
          400,
        );
      }
    } else if (!customer_id) {
      return jsonResponse({ error: "customer_id is required" }, 400);
    }
    if (typeof to !== "string" || (!isInvoiceEmail && (typeof subject !== "string" || typeof html !== "string"))) {
      return jsonResponse({ error: "to, subject, html must be strings" }, 400);
    }
    if (idempotency_key != null && (typeof idempotency_key !== "string" || !idempotency_key || idempotency_key.length > 256)) {
      return jsonResponse({ error: "idempotency_key must be a non-empty string of at most 256 characters" }, 400);
    }
    const contentProblem = isInvoiceEmail ? null : emailContentProblem(subject, html);
    if (contentProblem) {
      return jsonResponse({ error: contentProblem }, 400);
    }
    const appPdfProblem = appSuppliedPdfProblem(email_type, attachments);
    if (appPdfProblem) {
      return jsonResponse({ error: appPdfProblem }, 400);
    }

    // 4. email_type allowlist (catch unknown values + per-role gate)
    if (!ALL_EMAIL_TYPES.has(email_type)) {
      return jsonResponse({ error: `Unknown email_type: ${email_type}` }, 400);
    }
    const allowedForRole = EMAIL_TYPES_BY_ROLE[role];
    if (!allowedForRole.has(email_type)) {
      return jsonResponse(
        { error: `Role '${role}' is not permitted to send '${email_type}' emails` },
        403,
      );
    }

    // 5a. Purchase order copy (To-Do 0.15). The recipient (the company ordering
    // address), the PO's status, every line's cost and the screen's match to the PO
    // are all checked server-side, and the PDF is drawn here from the saved PO (KI-98).
    if (isPurchaseOrderEmail && poSnapshot) {
      const poGate = await checkPurchaseOrderEmail(adminClient, resource_id, to, poSnapshot);
      if (!poGate.ok) {
        return jsonResponse({ error: poGate.error }, poGate.status);
      }
      let vendor;
      try {
        vendor = poGate.order.vendor ? await loadPurchaseOrderVendor(adminClient, poGate.order.vendor) : null;
      } catch (err) {
        return jsonResponse({ error: `Purchase order vendor lookup failed: ${(err as Error).message}` }, 503);
      }
      // The Settings company details print on the PO; a failed read refuses rather than guess.
      let company;
      try {
        company = await loadCompanyInfo(adminClient);
      } catch (err) {
        return jsonResponse({ error: `Company details lookup failed: ${(err as Error).message}` }, 503);
      }
      const poPdf = drawPurchaseOrderPdf(
        { jsPDF, autoTable },
        buildPurchaseOrderPdfData(poGate.order, vendor, poGate.lines),
        company,
      );
      attachments = [{ filename: purchaseOrderPdfFilename(poGate.order.po_number), content: pdfBase64(poPdf) }];
    } else {
      // 5. Customer email match — recipient is validated server-side from customer_id
      // PR-03 fix: column is `farm_name`, not `name`. Surface the error explicitly so
      // future schema drifts don't get silently swallowed by the `!customerRow` 404 path.
      const { data: customerRow, error: customerErr } = await adminClient
        .from("customers")
        .select("id, email, farm_name")
        .eq("id", customer_id)
        .maybeSingle();

      if (customerErr) {
        console.warn("send-email: customers lookup failed", {
          customer_id,
          code: customerErr.code,
          message: customerErr.message,
        });
        return jsonResponse(
          { error: `Customer lookup failed: ${customerErr.message}` },
          500,
        );
      }

      if (!customerRow) {
        return jsonResponse({ error: "customer_id not found" }, 404);
      }

      const customerEmail = (customerRow.email || "").trim().toLowerCase();
      const requestedTo = to.trim().toLowerCase();
      if (!customerEmail) {
        return jsonResponse({ error: "Customer has no email on file" }, 400);
      }
      if (customerEmail !== requestedTo) {
        return jsonResponse(
          { error: "Recipient does not match customer email on file" },
          403,
        );
      }
    }

    // 5b. The record this email is about (audit finding 7). It must belong to
    // customer_id, and it scopes the idempotency key below (finding 8).
    let recordRef = `customer:${customer_id}`;
    let legacyQuoteAttachment: string | null = null;
    const recordSpec = RECORD_BY_EMAIL_TYPE[email_type];
    if (isPurchaseOrderEmail || email_type === "invoice") {
      // Ownership is checked in their own steps; both require a resource_id.
      recordRef = `${resource_type}:${resource_id}`;
    } else if (recordSpec) {
      if (resource_type !== recordSpec.resourceType || typeof resource_id !== "string" || !UUID_PATTERN.test(resource_id)) {
        return jsonResponse(
          { error: `${email_type} emails require resource_type='${recordSpec.resourceType}' and resource_id` },
          400,
        );
      }
      const { data: recordRow, error: recordErr } = await adminClient
        .from(recordSpec.table)
        .select(email_type === "quote" ? "customer_id, quote_number" : "customer_id")
        .eq("id", resource_id)
        .maybeSingle<{ customer_id: string | null; quote_number?: string | null }>();
      if (recordErr) {
        return jsonResponse({ error: `${recordSpec.resourceType} lookup failed: ${recordErr.message}` }, 503);
      }
      if (!recordRow) {
        return jsonResponse({ error: `${recordSpec.resourceType} not found` }, 404);
      }
      if (recordRow.customer_id !== customer_id) {
        return jsonResponse({ error: `${recordSpec.resourceType} does not belong to customer_id` }, 403);
      }
      recordRef = `${resource_type}:${resource_id}`;
      // QuoteBuilder's keys never held the quote id; its old rows name the quote's PDF instead.
      if (email_type === "quote" && recordRow.quote_number) legacyQuoteAttachment = `Quote-${recordRow.quote_number}.pdf`;
    } else if (!JOB_NOTICE_TYPE_BY_EMAIL_TYPE[email_type] && resource_type &&
      (resource_type !== "customer" || resource_id !== customer_id)) {
      return jsonResponse({ error: `${email_type} emails are about the customer's account only` }, 400);
    }

    // Invoice sends are gated again inside the server boundary. The browser also
    // checks immediately before calling us for fast feedback, but that check can
    // be bypassed or race with a status change. Never trust it as the authority.
    if (email_type === "invoice" && (resource_type !== "invoice" || !resource_id)) {
      return jsonResponse(
        { error: "Invoice emails require resource_type='invoice' and resource_id" },
        400,
      );
    }
    let invoiceGateId = resource_type === "invoice" ? resource_id : null;
    let invoiceGateCustomerId: string | null = null;

    // Proof notices can originate on JobDetail before billing or from an invoice
    // after billing. Do not trust the caller to say which. The notification RPC's
    // server-created idempotency key binds the send to its job/customer; if that
    // job has invoices, derive the correct child (or sole legacy un-split invoice)
    // and enforce its disposition. If billing has not happened, no invoice gate
    // exists yet and the ordinary post-application notice remains sendable.
    // Pre-application notices are bound the same way, minus the invoice gate.
    const jobNoticeType = JOB_NOTICE_TYPE_BY_EMAIL_TYPE[email_type];
    let notificationRow: { job_id: string; customer_id: string } | null = null;
    if (jobNoticeType) {
      if (!idempotency_key) {
        return jsonResponse({ error: "Job notices require their notification's idempotency key" }, 400);
      }
      const { data: noticeRow, error: notificationErr } = await adminClient
        .from("job_notifications")
        .select("job_id, customer_id, notification_type")
        .eq("idempotency_key", idempotency_key)
        .maybeSingle();
      if (notificationErr) {
        return jsonResponse({ error: `Notification lookup failed: ${notificationErr.message}` }, 500);
      }
      if (!noticeRow || noticeRow.customer_id !== customer_id || noticeRow.notification_type !== jobNoticeType) {
        return jsonResponse({ error: "Notification key does not match this customer" }, 403);
      }
      notificationRow = noticeRow;
      recordRef = `job:${noticeRow.job_id}`;
    }
    if (email_type === "post_application_notice" && notificationRow) {
      const { data: jobInvoices, error: jobInvoicesErr } = await adminClient
        .from("invoices")
        .select("id, customer_id, status, deleted_at")
        .eq("job_id", notificationRow.job_id);
      if (jobInvoicesErr) {
        return jsonResponse({ error: `Invoice gate lookup failed: ${jobInvoicesErr.message}` }, 500);
      }
      const matchingInvoices = (jobInvoices ?? []).filter((invoice) => invoice.customer_id === customer_id);
      const activeMatchingInvoices = matchingInvoices.filter(
        (invoice) =>
          invoice.deleted_at == null &&
          invoice.status !== "voided" &&
          invoice.status !== "cancelled",
      );
      if (activeMatchingInvoices.length > 1) {
        return jsonResponse({ error: "Multiple active invoices match this proof-notice recipient" }, 409);
      }
      // Prefer the sole active replacement after a void-and-rebill. If none is
      // active, retain a sole terminal match so the lifecycle gate below blocks
      // it instead of mistaking the job for an unbilled legacy notification.
      const derivedInvoice = activeMatchingInvoices[0] ??
        (matchingInvoices.length === 1 ? matchingInvoices[0] : null) ??
        (jobInvoices?.length === 1 ? jobInvoices[0] : null);
      if ((jobInvoices?.length ?? 0) > 0 && !derivedInvoice) {
        return jsonResponse({ error: "Could not resolve the recipient invoice send gate" }, 409);
      }
      if (
        derivedInvoice &&
        resource_type === "invoice" &&
        resource_id !== derivedInvoice.id
      ) {
        return jsonResponse({ error: "Invoice resource does not match the server-derived notification invoice" }, 400);
      }
      invoiceGateId = derivedInvoice?.id ?? null;
    }

    if (invoiceGateId) {
      const primaryInvoiceLookup = await adminClient
        .from("invoices")
        .select("id, customer_id, send_disposition, status, deleted_at")
        .eq("id", invoiceGateId)
        .maybeSingle();
      let invoiceRow = primaryInvoiceLookup.data as {
        id: string;
        customer_id: string;
        send_disposition?: string;
        status: string;
        deleted_at: string | null;
      } | null;
      let invoiceErr = primaryInvoiceLookup.error;
      const preMigrationMissingDisposition =
        !!invoiceErr && (invoiceErr.code === "42703" || invoiceErr.code === "PGRST204");
      if (preMigrationMissingDisposition) {
        // Compatibility for an edge-first rollout: lifecycle/customer checks still
        // run, while the later invoice-only gate permits only this exact missing-
        // column condition. No suppressed split children can exist before schema.
        const fallbackLookup = await adminClient
          .from("invoices")
          .select("id, customer_id, status, deleted_at")
          .eq("id", invoiceGateId)
          .maybeSingle();
        invoiceRow = fallbackLookup.data as typeof invoiceRow;
        invoiceErr = fallbackLookup.error;
      }
      if (invoiceErr) {
        return jsonResponse({ error: `Invoice send-status lookup failed: ${invoiceErr.message}` }, 500);
      }
      if (!invoiceRow) {
        return jsonResponse({ error: "Invoice not found" }, 404);
      }
      if (invoiceRow.deleted_at != null || invoiceRow.status === "voided" || invoiceRow.status === "cancelled") {
        return jsonResponse({ error: "A voided, cancelled, or deleted invoice must not be emailed" }, 409);
      }
      if (email_type === "invoice" && invoiceRow.customer_id !== customer_id) {
        return jsonResponse({ error: "Invoice customer does not match customer_id" }, 400);
      }
      invoiceGateCustomerId = invoiceRow.customer_id;
      if (
        email_type === "invoice" &&
        invoiceRow.send_disposition != null &&
        invoiceRow.send_disposition !== "normal" &&
        invoiceRow.send_disposition !== "sendable"
      ) {
        return jsonResponse(
          { error: invoiceRow.send_disposition === "suppressed_zero_total"
              ? "This $0 split invoice is suppressed and must not be emailed"
              : "Invoice send status is unavailable" },
          409,
        );
      }
    }

    // 6. Driver per-resource auth (only relevant when role='driver')
    if (role === "driver") {
      if (resource_type !== "delivery" || !resource_id) {
        return jsonResponse(
          { error: "Drivers must supply resource_type='delivery' and resource_id" },
          400,
        );
      }
      const { data: deliveryRow } = await adminClient
        .from("deliveries")
        .select("id, assigned_driver, customer_id, status")
        .eq("id", resource_id)
        .maybeSingle();

      if (!deliveryRow) {
        return jsonResponse({ error: "Delivery not found" }, 404);
      }
      if (deliveryRow.assigned_driver !== caller.id) {
        return jsonResponse(
          { error: "Driver is not assigned to this delivery" },
          403,
        );
      }
      if (deliveryRow.customer_id !== customer_id) {
        return jsonResponse(
          { error: "Delivery customer does not match customer_id" },
          400,
        );
      }
    }

    // 6b. Zero-invoice suppression (Codex r4 P1 / r5 P1+P1). A $0 per-line split child invoice is
    // marked send_disposition='suppressed_zero_total' by the split writer and must NEVER be emailed.
    // The client helper isInvoiceEmailSuppressed() gates the UI, but a direct call could bypass it —
    // enforce server-side. (r5) An invoice email MUST carry a real invoice resource so the check
    // can't be skipped by omitting/falsifying resource_*; and the lookup FAILS CLOSED on any error
    // except the pre-migration missing-column case (no suppressed invoices exist then).
    if (email_type === "invoice") {
      if (resource_type !== "invoice" || !resource_id) {
        return jsonResponse(
          { error: "Invoice emails require resource_type='invoice' and a resource_id" },
          400,
        );
      }
      const { data: invRow, error: invErr } = await adminClient
        .from("invoices")
        .select("id, send_disposition, customer_id")
        .eq("id", resource_id)
        .maybeSingle();
      // Pre-migration only: the send_disposition column doesn't exist yet — Postgres 42703
      // (undefined_column) or PostgREST PGRST204 (schema-cache miss). No suppressed invoices
      // exist then, so it's safe to fall through. EVERY other error fails closed.
      const preMigrationMissingColumn =
        !!invErr && (invErr.code === "42703" || invErr.code === "PGRST204");
      if (invErr && !preMigrationMissingColumn) {
        // eslint-disable-next-line no-console -- This fail-closed production error must remain error-level in Edge logs.
        console.error("send-email: invoice suppression lookup failed — refusing send", {
          resource_id,
          code: invErr.code,
          message: invErr.message,
        });
        return jsonResponse(
          { error: "Could not verify invoice email eligibility; send refused" },
          503,
        );
      }
      if (invErr) {
        console.warn(
          "send-email: send_disposition column absent (pre-migration) — suppression check skipped",
          { resource_id, code: invErr.code },
        );
      } else if (!invRow) {
        return jsonResponse({ error: "Invoice resource_id not found" }, 404);
      } else {
        if (invRow.customer_id && invRow.customer_id !== customer_id) {
          return jsonResponse({ error: "Invoice does not belong to customer_id" }, 400);
        }
        if (invRow.send_disposition === "suppressed_zero_total") {
          return jsonResponse(
            {
              error:
                "This $0 split invoice is recorded but not emailable (send_disposition=suppressed_zero_total)",
            },
            409,
          );
        }
      }
    }

    // 6c. The invoice email itself (KI-97): subject, wording, amount and file name
    // come from the saved invoice, and the screen it was sent from must show its money
    // as saved. The PDF is drawn here from the saved invoice (KI-98).
    if (isInvoiceEmail && invoiceSnapshot) {
      const built = await loadInvoiceEmail(adminClient, resource_id, invoiceSnapshot);
      if (!built.ok) {
        return jsonResponse({ error: built.error }, built.status);
      }
      // The PDF is read with the service client, so first confirm the sender may read this
      // invoice under their own row security (a rep sees only invoices they own).
      const { data: callerInvoice, error: callerInvoiceErr } = await callerClient
        .from("invoices")
        .select("id")
        .eq("id", resource_id)
        .maybeSingle<{ id: string }>();
      if (callerInvoiceErr) {
        return jsonResponse({ error: `Invoice access check failed: ${callerInvoiceErr.message}` }, 503);
      }
      if (!callerInvoice) {
        return jsonResponse({ error: "You do not have access to this invoice" }, 403);
      }
      let invoicePdfData;
      try {
        invoicePdfData = await loadInvoicePdfData(adminClient, resource_id);
      } catch (err) {
        return jsonResponse({ error: `Invoice details lookup failed: ${(err as Error).message}` }, 503);
      }
      // The drawn PDF must print the money the email states, as saved now.
      const pdfCheck = await loadInvoiceEmail(adminClient, resource_id, invoiceEmailSnapshot(invoicePdfData));
      if (!pdfCheck.ok) {
        return jsonResponse({ error: `Invoice PDF check: ${pdfCheck.error}` }, pdfCheck.status);
      }
      // An unusual stored invoice number (very long, odd characters) must not slip past the content gate.
      const builtProblem = emailContentProblem(built.subject, built.html);
      if (builtProblem) {
        return jsonResponse({ error: builtProblem }, 409);
      }
      subject = built.subject;
      html = built.html;
      attachments = [{ filename: built.filename, content: pdfBase64(drawInvoicePdf({ jsPDF, autoTable }, invoicePdfData)) }];
    }

    // 7. Attachment limits
    if (attachments && Array.isArray(attachments)) {
      if (attachments.length > MAX_ATTACHMENTS) {
        return jsonResponse(
          { error: `Too many attachments (max ${MAX_ATTACHMENTS})` },
          400,
        );
      }
      let totalBytes = 0;
      for (const att of attachments) {
        const problem = attachmentProblem(att?.filename, att?.content);
        if (problem) {
          return jsonResponse({ error: problem }, 400);
        }
        totalBytes += decodedBase64Length(att.content);
      }
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        return jsonResponse(
          { error: `Attachments exceed ${MAX_TOTAL_ATTACHMENT_BYTES} byte cap` },
          400,
        );
      }
    }

    // 8. Rate limit — count this caller's email_log rows in the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recentCount } = await adminClient
      .from("email_log")
      .select("id", { count: "exact", head: true })
      .eq("created_by", caller.id)
      .gte("created_at", oneHourAgo);

    if ((recentCount ?? 0) >= RATE_LIMIT_PER_HOUR) {
      return jsonResponse(
        {
          error: `Rate limit: ${RATE_LIMIT_PER_HOUR} emails/hour exceeded for this user. Try again later.`,
        },
        429,
      );
    }

    // 9. Idempotency replay — return cached success if we've already sent
    //    successfully under this key.
    //    The stored key is scoped to type + record (audit finding 8), and is
    //    shared by every caller so a second staff member cannot re-send the
    //    same email. Rows written before this change hold the raw key and no
    //    record id, so one counts only when that raw key names this record
    //    (the app's keys embed the record id) or, for job notices, when the
    //    key was already matched to this job through job_notifications above,
    //    or, for quotes, when the row's attachment is this quote's PDF;
    //    any other raw-key row is refused as ambiguous rather than reported
    //    as already sent.
    let emailLogId: string | null = null;
    // Record ids are UUIDs: one spelling, so an upper-case retry finds the same email.
    recordRef = recordRef.toLowerCase();
    const scopedIdempotencyKey = idempotency_key
      ? `${email_type}:${recordRef}:${idempotency_key}`
      : null;
    // A send without a key is still stored under its type + record, so the
    // unconfirmed-send check below can see it.
    const storedIdempotencyKey = scopedIdempotencyKey ?? `${email_type}:${recordRef}:auto-${crypto.randomUUID()}`;
    // Names this email; the database allows one pending row per value
    // (email_log_one_pending_send, migration 20261110110000).
    const sendLockKey = `${email_type}:${recordRef}:${customer_id ?? "none"}`;

    if (scopedIdempotencyKey) {
      const { data: keyRows, error: existingErr } = await adminClient
        .from("email_log")
        .select("id, resend_message_id, status, email_type, customer_id, idempotency_key, attachment_name")
        .in("idempotency_key", [scopedIdempotencyKey, idempotency_key]);
      if (existingErr) {
        return jsonResponse({ error: `Idempotency lookup failed: ${existingErr.message}` }, 503);
      }
      const scopedRow = keyRows?.find((row) => row.idempotency_key === scopedIdempotencyKey);
      const legacyRow = scopedRow ? undefined : keyRows?.find((row) => row.idempotency_key === idempotency_key);
      const recordId = recordRef.slice(recordRef.indexOf(":") + 1);
      const legacyMatchesRecord = notificationRow != null ||
        (!!recordId && idempotency_key.includes(recordId)) ||
        (legacyQuoteAttachment != null && legacyRow?.attachment_name === legacyQuoteAttachment);
      if (legacyRow && !legacyMatchesRecord) {
        return jsonResponse({
          error: "This idempotency_key was used before keys were tied to a record and cannot be matched to this one. Send again with a new key.",
        }, 409);
      }
      const existing = scopedRow ?? legacyRow;
      if (existing && (existing.email_type !== email_type || existing.customer_id !== (customer_id ?? null))) {
        return jsonResponse({ error: "This idempotency_key was already used for a different email" }, 409);
      }

      if (existing && existing.status === "sent") {
        // Already successfully sent — return cached success.
        return jsonResponse({
          success: true,
          email_log_id: existing.id,
          resend_message_id: existing.resend_message_id,
          deduplicated: true,
        });
      }

      // Codex P2 fix (PR #59, 2026-05-16 review of e5de0f2): refuse to re-send
      // when an existing row for this idempotency_key is still 'pending'. The
      // prior attempt may have already reached Resend and succeeded — only the
      // post-send DB update failed. A re-send here would duplicate the
      // customer email. Operator reconciles by inspecting Resend dashboard
      // and updating the email_log row to 'sent' (replay deduplicates) or
      // 'failed' (replay retries) before the same key can be reused.
      if (existing && existing.status === "pending") {
        return jsonResponse({
          success: false,
          error:
            "Previous attempt with this idempotency_key is still pending. " +
            "The email may already have been sent. Check Resend dashboard, " +
            "then update email_log row to 'sent' (treat as deduplicated) or " +
            "'failed' (allow retry) before reusing this key.",
          email_log_id: existing.id,
          needs_reconciliation: true,
        }, 409);
      }

      // If existing failed scoped row: reuse its id, update to pending below,
      // and overwrite the result after the next send attempt. A failed legacy
      // row keeps its own audit details; this attempt gets a new scoped row.
      if (scopedRow) emailLogId = scopedRow.id;
    }

    // 10. Write-ahead log (2026-05-16 ultra-review P2 #5): insert/update the
    //     email_log row to status='pending' BEFORE calling Resend. If this
    //     write fails, we DON'T send — otherwise the customer could receive
    //     an email with no audit record and no idempotency replay marker.
    // Another request holds this email. If it already sent it to this customer,
    // report that send as this one's result; if it already failed, say so; while
    // it is pending, it may still be sending.
    const alreadyInProgress = async () => {
      const { data: holder, error: holderErr } = await adminClient
        .from("email_log")
        .select("id, status, resend_message_id, customer_id")
        .eq("idempotency_key", scopedIdempotencyKey!)
        .maybeSingle<{ id: string; status: string; resend_message_id: string | null; customer_id: string | null }>();
      if (holderErr) {
        return jsonResponse({ error: `Another send of this email is under way, and checking it failed: ${holderErr.message}` }, 503);
      }
      if (holder?.status === "sent" && holder.customer_id === (customer_id ?? null)) {
        return jsonResponse({
          success: true,
          email_log_id: holder.id,
          resend_message_id: holder.resend_message_id,
          deduplicated: true,
        });
      }
      if (holder?.status === "failed") {
        return jsonResponse({ error: "Another send of this email just failed. Send it again.", email_log_id: holder.id }, 409);
      }
      return jsonResponse({
        success: false,
        error: "Another send of this email is already in progress. Wait a minute, then check whether it was sent.",
        email_log_id: holder?.id ?? emailLogId,
        needs_reconciliation: true,
      }, 409);
    };

    // An earlier send of this same email whose outcome is unknown blocks a new one
    // under ANY key: some screens make a new key on every click, and the customer
    // may already have the first.
    const unconfirmedSend = (heldBy: string | null) => jsonResponse({
      success: false,
      error: "An earlier send of this email has not been confirmed and may have reached the customer. " +
        "Check Resend, then mark that email_log row 'sent' or 'failed' before sending again.",
      email_log_id: heldBy,
      needs_reconciliation: true,
    }, 409);
    // The database refused a second pending row for this email: a send that
    // started at the same instant holds it.
    const isLockConflict = (err: { code?: string; message?: string } | null) =>
      err?.code === "23505" && (err.message ?? "").includes("email_log_one_pending_send");
    const lockHolder = async () => {
      const { data } = await adminClient
        .from("email_log")
        .select("id")
        .eq("send_lock_key", sendLockKey)
        .eq("status", "pending")
        .limit(1);
      return unconfirmedSend(data?.[0]?.id ?? null);
    };

    // A send of this email that STARTS after this check, and is confirmed before this
    // request takes the lock, is found by the re-check below. Each attempt stamps
    // created_at from this clock just before its row is written; the 1s margin
    // covers that gap and clock skew. A send that started more than 1s earlier is a separate
    // send (a corrected quote mailed again) and is never deduplicated.
    const lockCheckFrom = new Date(Date.now() - 1000).toISOString();
    // Early check; the unique index above is what holds when two arrive together.
    // It also sees pending rows logged before send_lock_key existed (scoped keys
    // begin with type + record).
    {
      const recordKeyPrefix = `${email_type}:${recordRef}:`.replace(/[\\%_]/g, (c) => "\\" + c);
      const unsettledQuery = adminClient
        .from("email_log")
        .select("id")
        .eq("status", "pending")
        .eq("email_type", email_type)
        .like("idempotency_key", `${recordKeyPrefix}%`);
      // One job's notices go to several customers (split billing); each is its own email.
      const { data: unsettled, error: unsettledErr } = await (customer_id
        ? unsettledQuery.eq("customer_id", customer_id)
        : unsettledQuery.is("customer_id", null)).limit(1);
      if (unsettledErr) {
        return jsonResponse({ error: `Pending-send check failed: ${unsettledErr.message}` }, 503);
      }
      if (unsettled && unsettled.length > 0) {
        return unconfirmedSend(unsettled[0].id);
      }
    }

    if (emailLogId) {
      // Existing failed row from a prior attempt — reset it to pending and
      // record THIS attempt's content, so the log shows what was actually sent.
      // Only a row still 'failed' (or 'bounced') is claimed: of two retries at the same moment,
      // the second finds it 'pending' and stops (PR #1302 review, finding 3).
      const { data: claimedRow, error: updateErr } = await adminClient
        .from("email_log")
        .update({
          status: "pending",
          resend_message_id: null,
          error_message: null,
          idempotency_key: scopedIdempotencyKey,
          send_lock_key: sendLockKey,
          recipient_email: to,
          subject,
          html_body: html,
          attachment_name: attachments?.[0]?.filename || null,
          // This attempt's time and sender: the re-check and the hourly limit read them.
          created_at: new Date().toISOString(),
          created_by: caller.id,
        })
        .eq("id", emailLogId)
        .in("status", ["failed", "bounced"])
        .select("id")
        .maybeSingle();
      if (!updateErr && !claimedRow) {
        return await alreadyInProgress();
      }
      if (isLockConflict(updateErr)) {
        return await lockHolder();
      }
      if (updateErr) {
        await captureEdgeException(
          new Error(`email_log pre-send reset failed: ${updateErr.message}`),
          {
            function: "send-email",
            level: "error",
            tags: { email_type, phase: "pre-send-log-reset" },
            extra: { customer_id, idempotency_key, email_log_id: emailLogId },
            user: { id: caller.id },
          },
        );
        return jsonResponse(
          { error: `Email pre-flight log reset failed: ${updateErr.message}` },
          500,
        );
      }
    } else {
      // Fresh send — insert new pending row.
      const { data: newRow, error: insertErr } = await adminClient
        .from("email_log")
        .insert({
          customer_id: customer_id,
          recipient_email: to,
          email_type,
          subject,
          html_body: html,
          attachment_name: attachments?.[0]?.filename || null,
          resend_message_id: null,
          status: "pending",
          error_message: null,
          idempotency_key: storedIdempotencyKey,
          send_lock_key: sendLockKey,
          created_by: caller.id,
          created_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (isLockConflict(insertErr)) {
        return await lockHolder();
      }
      // email_log.idempotency_key is unique: a first send racing this one already holds the key.
      if (insertErr?.code === "23505") {
        return await alreadyInProgress();
      }
      if (insertErr || !newRow) {
        await captureEdgeException(
          new Error(`email_log pre-send insert failed: ${insertErr?.message || 'no row returned'}`),
          {
            function: "send-email",
            level: "error",
            tags: { email_type, phase: "pre-send-log-insert" },
            extra: { customer_id, idempotency_key },
            user: { id: caller.id },
          },
        );
        return jsonResponse(
          { error: `Email pre-flight log insert failed: ${insertErr?.message || 'unknown'}` },
          500,
        );
      }
      emailLogId = newRow.id;
    }

    // The unique index stops only a second PENDING row. A send of the same email
    // that began after the early check and was confirmed before this request took
    // the lock is caught here: give up the lock and report that send.
    {
      const { data: justSent, error: justSentErr } = await adminClient
        .from("email_log")
        .select("id, resend_message_id")
        .eq("send_lock_key", sendLockKey)
        .eq("status", "sent")
        .gte("created_at", lockCheckFrom)
        .neq("id", emailLogId)
        .limit(1);
      if (justSentErr || (justSent && justSent.length > 0)) {
        const reason = justSentErr
          ? `Not sent: checking for a send of this email at the same moment failed: ${justSentErr.message}`
          : `Not sent again: the same email went out at the same moment as email_log ${justSent![0].id}.`;
        // A deduplicated row is stored as sent, with the other send's message id, so a
        // replay of this key returns that send instead of sending again.
        const { error: releaseErr } = await adminClient
          .from("email_log")
          .update(justSentErr
            ? { status: "failed", error_message: reason }
            : { status: "sent", resend_message_id: justSent![0].resend_message_id, error_message: reason })
          .eq("id", emailLogId)
          .eq("status", "pending");
        if (justSentErr || releaseErr) {
          // A row left pending blocks new sends until someone checks it: safe.
          return jsonResponse({ error: releaseErr ? `${reason}; releasing its log row also failed: ${releaseErr.message}` : reason }, 503);
        }
        return jsonResponse({
          success: true,
          email_log_id: justSent![0].id,
          resend_message_id: justSent![0].resend_message_id,
          deduplicated: true,
        });
      }
    }

    // 11. Resend send
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("FROM_EMAIL") || "noreply@croprxsolutions.app";

    if (!resendApiKey) {
      // RESEND_API_KEY missing — mark the pending row as failed so the audit
      // trail reflects reality.
      await adminClient
        .from("email_log")
        .update({ status: "failed", error_message: "RESEND_API_KEY not configured" })
        .eq("id", emailLogId);
      return jsonResponse({ error: "RESEND_API_KEY not configured", email_log_id: emailLogId }, 500);
    }

    const resendBody: Record<string, unknown> = {
      from: fromEmail,
      to: [to],
      subject,
      html,
    };

    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      resendBody.attachments = attachments.map(
        (att: { filename: string; content: string }) => ({
          filename: att.filename,
          content: att.content,
        }),
      );
    }

    // Re-read the authoritative invoice state at the last possible boundary.
    // The earlier gate protects all pre-send work, but another session can
    // void/cancel/delete/suppress an invoice while attachments, rate limits,
    // idempotency, and the write-ahead log are being processed. Fail closed
    // here before making the irreversible outbound request.
    if (invoiceGateId) {
      const finalGateLookup = await adminClient
        .from("invoices")
        .select("id, customer_id, send_disposition, status, deleted_at")
        .eq("id", invoiceGateId)
        .maybeSingle();
      let finalInvoiceRow = finalGateLookup.data as {
        id: string;
        customer_id: string;
        send_disposition?: string;
        status: string;
        deleted_at: string | null;
      } | null;
      let finalGateError = finalGateLookup.error;
      const finalGatePreMigrationFallback =
        !!finalGateError && (finalGateError.code === "42703" || finalGateError.code === "PGRST204");
      if (finalGatePreMigrationFallback) {
        const fallbackLookup = await adminClient
          .from("invoices")
          .select("id, customer_id, status, deleted_at")
          .eq("id", invoiceGateId)
          .maybeSingle();
        finalInvoiceRow = fallbackLookup.data as typeof finalInvoiceRow;
        finalGateError = fallbackLookup.error;
      }

      let finalGateRefusal: string | null = null;
      let finalGateStatus = finalGateError ? 503 : 409;
      if (finalGateError) {
        finalGateRefusal = `Final invoice eligibility lookup failed: ${finalGateError.message}`;
      } else if (!finalInvoiceRow) {
        finalGateRefusal = "Invoice no longer exists";
      } else if (
        finalInvoiceRow.deleted_at != null ||
        finalInvoiceRow.status === "voided" ||
        finalInvoiceRow.status === "cancelled"
      ) {
        finalGateRefusal = "Invoice became voided, cancelled, or deleted before send";
      } else if (finalInvoiceRow.customer_id !== invoiceGateCustomerId) {
        finalGateRefusal = "Invoice customer changed before send";
      } else if (
        email_type === "invoice" &&
        finalInvoiceRow.send_disposition != null &&
        finalInvoiceRow.send_disposition !== "normal" &&
        finalInvoiceRow.send_disposition !== "sendable"
      ) {
        finalGateRefusal = "Invoice became suppressed or unavailable before send";
      } else if (isInvoiceEmail && invoiceSnapshot) {
        // A payment or edit since step 6c would make the stated amount or the PDF wrong.
        const rebuilt = await loadInvoiceEmail(adminClient, invoiceGateId, invoiceSnapshot);
        if (!rebuilt.ok) {
          finalGateRefusal = rebuilt.error;
          finalGateStatus = rebuilt.status;
        } else if (rebuilt.subject !== subject || rebuilt.html !== html) {
          finalGateRefusal = "Invoice changed before send";
        }
      }

      if (finalGateRefusal) {
        const finalLogResult = await adminClient
          .from("email_log")
          .update({ status: "failed", error_message: finalGateRefusal })
          .eq("id", emailLogId)
          .select("id")
          .maybeSingle();
        if (finalLogResult.error || !finalLogResult.data) {
          await captureEdgeException(
            new Error(`Final gate refusal log failed: ${finalLogResult.error?.message || "no row returned"}`),
            {
              function: "send-email",
              level: "error",
              tags: { email_type, phase: "final-gate-log" },
              extra: { customer_id, email_log_id: emailLogId, final_gate_refusal: finalGateRefusal },
              user: { id: caller.id },
            },
          );
          return jsonResponse(
            { error: "Email refused, but the audit log could not be finalized", email_log_id: emailLogId },
            500,
          );
        }
        return jsonResponse(
          { error: `${finalGateRefusal}; email send refused`, email_log_id: emailLogId },
          finalGateStatus,
        );
      }
    }

    // Same last-moment recheck for a purchase order: it may have been cancelled,
    // or a cost or date changed, while the steps above ran.
    if (isPurchaseOrderEmail && poSnapshot) {
      const finalPoGate = await checkPurchaseOrderEmail(adminClient, resource_id, to, poSnapshot);
      if (!finalPoGate.ok) {
        const poRefusal = `${finalPoGate.error}; email send refused`;
        const poLogResult = await adminClient
          .from("email_log")
          .update({ status: "failed", error_message: poRefusal })
          .eq("id", emailLogId)
          .select("id")
          .maybeSingle();
        if (poLogResult.error || !poLogResult.data) {
          await captureEdgeException(
            new Error(`Final purchase order gate log failed: ${poLogResult.error?.message || "no row returned"}`),
            {
              function: "send-email",
              level: "error",
              tags: { email_type, phase: "final-po-gate-log" },
              extra: { resource_id, email_log_id: emailLogId, final_gate_refusal: poRefusal },
              user: { id: caller.id },
            },
          );
          return jsonResponse(
            { error: "Email refused, but the audit log could not be finalized", email_log_id: emailLogId },
            500,
          );
        }
        return jsonResponse({ error: poRefusal, email_log_id: emailLogId }, finalPoGate.status);
      }
    }

    // The call to Resend gives up after RESEND_TIMEOUT_MS, so a slow reply can no
    // longer hold the request until the platform kills it (PR #1302 review,
    // finding 4). Only a documented refusal marks the row 'failed', so a retry
    // may send it. No answer, a dropped connection, a 408 or 5xx reply or an
    // unreadable success may mean the customer already
    // has the email, so the row stays 'pending' with the reason written on it:
    // the pending check above then refuses a re-send under the same key until
    // someone checks Resend and settles the row.
    let resendStatus = 0;
    let success = false;
    let outcomeUnknown = false;
    let resendMessageId: string | null = null;
    let errorMessage: string | null = null;
    try {
      const resendResp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${resendApiKey}`,
        },
        body: JSON.stringify(resendBody),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      resendStatus = resendResp.status;
      const resendText = await resendResp.text();
      let resendResult: { id?: unknown; message?: unknown } | null = null;
      try {
        resendResult = JSON.parse(resendText);
      } catch {
        resendResult = null;
      }
      success = resendResp.ok && typeof resendResult?.id === "string" && resendResult.id !== "";
      resendMessageId = success ? resendResult!.id as string : null;
      if (success) {
        // Confirmed: no error message.
      } else if (resendResp.ok) {
        outcomeUnknown = true;
        errorMessage = `Email provider accepted the request but its reply was unreadable: ${resendText.slice(0, 200)}`;
      } else if (!RESEND_REFUSAL_STATUSES.has(resendResp.status)) {
        // Only Resend's documented refusals prove the email was not sent; a
        // timeout (408), a server or gateway error, or anything else does not.
        outcomeUnknown = true;
        errorMessage = `Email provider replied ${resendResp.status}: ${resendText.slice(0, 200)}`;
      } else {
        errorMessage = typeof resendResult?.message === "string"
          ? resendResult.message
          : `Email provider replied ${resendResp.status}: ${resendText.slice(0, 200)}`;
      }
    } catch (err) {
      outcomeUnknown = true;
      errorMessage = (err as Error)?.name === "TimeoutError"
        ? `Email provider did not answer within ${RESEND_TIMEOUT_MS / 1000} seconds`
        : `Email provider request failed: ${(err as Error)?.message ?? String(err)}`;
    }
    if (outcomeUnknown) {
      errorMessage += ". It may still have been sent: check Resend, then mark this email_log row 'sent' or 'failed' before sending again.";
    }

    // 12. Update the pending row to sent/failed (or leave it pending, with the
    //     reason, when the outcome is unknown). Even if this update fails, the
    //     pending row exists for idempotency replay — durability is already achieved.
    const { error: postUpdateErr } = await adminClient
      .from("email_log")
      .update({
        resend_message_id: resendMessageId,
        status: success ? "sent" : outcomeUnknown ? "pending" : "failed",
        error_message: errorMessage,
      })
      .eq("id", emailLogId);

    if (postUpdateErr) {
      console.warn("[email_log] post-send update failed:", postUpdateErr);
      await captureEdgeException(postUpdateErr, {
        function: "send-email",
        level: "warning",
        tags: { email_type, phase: "post-send-log-update" },
        extra: { customer_id, email_log_id: emailLogId, resend_message_id: resendMessageId, send_succeeded: success },
        user: { id: caller.id },
      });
    }

    if (!success) {
      // Sprint F #7 — alert on Resend send failures (high-impact: customer
      // didn't get the email they expected).
      await captureEdgeException(new Error(errorMessage || "Resend send failed"), {
        function: "send-email",
        level: "error",
        tags: { email_type, status_code: String(resendStatus) },
        extra: { customer_id, email_log_id: emailLogId, resend_message_id: resendMessageId },
        user: { id: caller.id },
      });
      return jsonResponse({
        success: false,
        error: outcomeUnknown
          ? `Not confirmed: this email may have reached the customer. Check before sending it again. (${errorMessage})`
          : errorMessage,
        email_log_id: emailLogId,
        ...(outcomeUnknown ? { needs_reconciliation: true } : {}),
      }, outcomeUnknown ? 504 : 502);
    }

    return jsonResponse({
      success: true,
      email_log_id: emailLogId,
      resend_message_id: resendMessageId,
    });
  } catch (err) {
    await captureEdgeException(err, {
      function: "send-email",
      level: "fatal",
    });
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
});
