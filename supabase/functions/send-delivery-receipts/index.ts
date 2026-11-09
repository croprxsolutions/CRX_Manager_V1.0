// KI-25: sends customer delivery receipts owed in delivery_receipt_queue. Woken every 2 minutes by the
// deliver-receipt-queue pg_cron job (20261113140000) with the x-receipt-worker-secret header; deploy with
// verify_jwt off (the wake carries no user token). The wake is only a hint: every database call is service_role,
// and the reply carries counts only, never customer data.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { captureEdgeException, warnIfSentryMisconfigured } from "../_shared/sentry.ts";
import { runReceiptBatch, sendViaResend } from "./logic.ts";

warnIfSentryMisconfigured("send-delivery-receipts");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Each worker RPC always answers (a list or a status word); no answer means something is wrong, so the attempt
// stops and its lease expires instead of being treated as done.
function assertRpcResult<T>(data: unknown, rpcName: string): T {
  if (data === null || data === undefined) throw new Error(`${rpcName} returned no data`);
  return data as T;
}

async function sameSecret(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("DELIVERY_RECEIPT_WORKER_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!secret || !supabaseUrl || !serviceKey || !resendKey) {
    return json({ error: "send-delivery-receipts is not configured" }, 503);
  }
  if (!(await sameSecret(req.headers.get("x-receipt-worker-secret") ?? "", secret))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const result = await runReceiptBatch({
      rpc: async (fn, args) => {
        const { data, error } = await admin.rpc(fn, args);
        if (error) throw new Error(`${fn}: ${error.message}`);
        return assertRpcResult<unknown>(data, fn);
      },
      send: (request) => sendViaResend(request, resendKey),
      from: Deno.env.get("FROM_EMAIL") || "noreply@croprxsolutions.app",
      newKey: () => crypto.randomUUID(),
      log: (message, extra) => console.warn(`[send-delivery-receipts] ${message}`, extra),
    });
    return json({ ok: true, ...result });
  } catch (error) {
    await captureEdgeException(error, { function: "send-delivery-receipts" });
    return json({ error: "Receipt run failed; the next wake retries" }, 500);
  }
});
