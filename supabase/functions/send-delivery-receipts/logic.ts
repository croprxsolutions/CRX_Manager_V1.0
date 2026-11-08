// KI-25 sender core: no Deno globals, so the real-schema prover can run this exact code under Node.
// For each owed receipt: claim -> confirm immediately before the send -> Resend -> finish.
// Every attempt for one receipt sends the identical request under the provider key delivery-receipt/<queue id>,
// so a retry after a lost answer is answered by Resend (its 24-hour duplicate guard) instead of emailing twice.
import { buildDeliveryReceiptHtml } from "../_shared/deliveryReceiptHtml.ts";

export interface FrozenReceipt {
  delivery_number: string;
  delivered_on: string; // YYYY-MM-DD, Central
  signed_by: string | null;
  contact_name: string | null;
  is_partial: boolean;
  lines: { name: string; qty: number }[];
}

export interface ReceiptClaim {
  id: string;
  claim_token: string;
  to: string;
  receipt: FrozenReceipt;
}

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;
export type Outcome =
  | { outcome: "sent"; messageId: string }
  | { outcome: "retry" | "check"; detail: string };

export interface ResendRequest {
  idempotencyKey: string;
  body: { from: string; to: string[]; subject: string; html: string };
}

export const RESEND_TIMEOUT_MS = 30_000;

// "2026-11-08" -> "11/8/2026", as the phone's toLocaleDateString() printed it.
export function receiptDateText(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate ?? "");
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : String(isoDate ?? "");
}

// Built only from the claim, so every attempt for one receipt is byte-identical.
export function buildReceiptRequest(claim: ReceiptClaim, from: string): ResendRequest {
  const r = claim.receipt;
  return {
    idempotencyKey: `delivery-receipt/${claim.id}`,
    body: {
      from,
      to: [claim.to],
      subject: `Delivery ${r.delivery_number} Completed — Crop RX Solutions`,
      html: buildDeliveryReceiptHtml({
        variant: "completed",
        deliveryNumber: r.delivery_number,
        contactName: r.contact_name ?? null,
        dateText: receiptDateText(r.delivered_on),
        lines: (r.lines ?? []).filter((line) => Number(line.qty) > 0),
        signedBy: r.signed_by || null,
        isPartial: r.is_partial === true,
      }),
    },
  };
}

// retry: may succeed later and is safe to repeat under the same key (Resend replays a send it already made).
// check: repeating cannot help (the address or request was refused, or the key was used with another body).
export async function sendViaResend(
  request: ResendRequest,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Outcome> {
  let status = 0;
  let text = "";
  try {
    const resp = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Idempotency-Key": request.idempotencyKey,
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    status = resp.status;
    text = await resp.text();
  } catch (err) {
    return { outcome: "retry", detail: `Email provider did not answer: ${(err as Error)?.message ?? String(err)}`.slice(0, 300) };
  }
  let parsed: { id?: unknown; name?: unknown; message?: unknown } | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (status >= 200 && status < 300) {
    if (typeof parsed?.id === "string" && parsed.id !== "") return { outcome: "sent", messageId: parsed.id };
    return { outcome: "retry", detail: `Email provider accepted the request but its reply was unreadable: ${text.slice(0, 200)}` };
  }
  const detail = `Email provider replied ${status}: ${typeof parsed?.message === "string" ? parsed.message : text.slice(0, 200)}`;
  if (status === 409) return { outcome: parsed?.name === "concurrent_idempotent_requests" ? "retry" : "check", detail };
  if (status === 408 || status === 429 || status >= 500) return { outcome: "retry", detail };
  return { outcome: "check", detail };
}

export interface BatchDeps {
  rpc: Rpc;
  send: (request: ResendRequest) => Promise<Outcome>;
  from: string;
  newKey: () => string;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface BatchResult {
  claimed: number;
  sent: number;
  retry: number;
  check: number;
  skipped: number;
  lost: number;
}

// One retry of a call whose answer may have been lost; the idempotency key makes the repeat safe.
async function call(rpc: Rpc, fn: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await rpc(fn, args);
  } catch {
    return await rpc(fn, args);
  }
}

export async function runReceiptBatch(deps: BatchDeps, limit = 10): Promise<BatchResult> {
  const result: BatchResult = { claimed: 0, sent: 0, retry: 0, check: 0, skipped: 0, lost: 0 };
  const claims = await call(deps.rpc, "claim_delivery_receipts", {
    p_limit: limit,
    p_idempotency_key: `claim/${deps.newKey()}`,
  }) as ReceiptClaim[] | null;
  for (const claim of claims ?? []) {
    result.claimed += 1;
    try {
      const request = buildReceiptRequest(claim, deps.from);
      // Immediately before the send: the database re-checks the delivery, customer and address under lock.
      const verdict = await call(deps.rpc, "confirm_delivery_receipt_send", {
        p_id: claim.id,
        p_claim_token: claim.claim_token,
        p_idempotency_key: `confirm/${claim.id}/${claim.claim_token}`,
      });
      if (verdict !== "send") {
        if (verdict === "needs_check") result.check += 1; // the database flagged it for the office list
        else result.skipped += 1;
        continue;
      }
      const sent = await deps.send(request);
      const finishArgs = sent.outcome === "sent"
        ? { p_outcome: "sent", p_detail: null, p_resend_message_id: sent.messageId, p_sent_to: claim.to }
        : { p_outcome: sent.outcome, p_detail: sent.detail, p_resend_message_id: null, p_sent_to: null };
      const recorded = await call(deps.rpc, "finish_delivery_receipt", {
        p_id: claim.id,
        p_claim_token: claim.claim_token,
        ...finishArgs,
        p_idempotency_key: `finish/${claim.id}/${claim.claim_token}`,
      });
      // Count what the database recorded, not what the provider said ('stale' = the claim was no longer ours).
      if (recorded === "sent") result.sent += 1;
      else if (recorded === "pending") result.retry += 1;
      else if (recorded === "needs_check") result.check += 1;
      else {
        result.lost += 1;
        deps.log?.("delivery receipt finish was not recorded", { id: claim.id, status: String(recorded) });
      }
    } catch (err) {
      // The claim's lease runs out in 10 minutes and the next run resends under the same provider key.
      result.lost += 1;
      deps.log?.("delivery receipt attempt did not finish", { id: claim.id, error: (err as Error)?.message ?? String(err) });
    }
  }
  return result;
}
