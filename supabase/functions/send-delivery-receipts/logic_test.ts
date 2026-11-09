import { assertEquals } from "jsr:@std/assert@1.0.14";
import { buildReceiptRequest, receiptDateText, type ReceiptClaim, runReceiptBatch, sendViaResend } from "./logic.ts";

const claim: ReceiptClaim = {
  id: "11111111-1111-1111-1111-111111111111",
  claim_token: "22222222-2222-2222-2222-222222222222",
  to: "farm@example.invalid",
  receipt: {
    delivery_number: "D-1",
    delivered_on: "2026-11-08",
    signed_by: "Pat <b>",
    contact_name: "Pat",
    is_partial: false,
    lines: [{ name: "Gly & Co", qty: 10 }, { name: "Zero", qty: 0 }],
  },
};

const reply = (status: number, body: unknown) => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as typeof fetch;

Deno.test("the request is identical on every attempt and escapes typed text", () => {
  const a = buildReceiptRequest(claim, "noreply@x.invalid");
  const b = buildReceiptRequest(structuredClone(claim), "noreply@x.invalid");
  assertEquals(JSON.stringify(a), JSON.stringify(b));
  assertEquals(a.idempotencyKey, `delivery-receipt/${claim.id}`);
  assertEquals(a.body.to, ["farm@example.invalid"]);
  assertEquals(a.body.html.includes("Gly &amp; Co"), true);
  assertEquals(a.body.html.includes("Pat &lt;b&gt;"), true);
  assertEquals(a.body.html.includes("Zero"), false);
  assertEquals(receiptDateText("2026-11-08"), "11/8/2026");
});

Deno.test("provider answers map to sent / retry / check", async () => {
  const req = buildReceiptRequest(claim, "f@x.invalid");
  assertEquals(await sendViaResend(req, "k", reply(200, { id: "m1" })), { outcome: "sent", messageId: "m1" });
  assertEquals((await sendViaResend(req, "k", reply(200, {}))).outcome, "retry");
  assertEquals((await sendViaResend(req, "k", reply(503, {}))).outcome, "retry");
  assertEquals((await sendViaResend(req, "k", reply(429, {}))).outcome, "retry");
  assertEquals((await sendViaResend(req, "k", reply(409, { name: "concurrent_idempotent_requests" }))).outcome, "retry");
  assertEquals((await sendViaResend(req, "k", reply(409, { name: "invalid_idempotent_request" }))).outcome, "check");
  assertEquals((await sendViaResend(req, "k", reply(422, { message: "bad to" }))).outcome, "check");
  const down = (() => Promise.reject(new Error("offline"))) as typeof fetch;
  assertEquals((await sendViaResend(req, "k", down)).outcome, "retry");
});

Deno.test("the tally follows what the database recorded, not the provider", async () => {
  const run = (finish: string) => runReceiptBatch({
    rpc: (fn) => Promise.resolve(
      fn === "claim_delivery_receipts" ? [claim] : fn === "confirm_delivery_receipt_send" ? "send" : finish,
    ),
    send: () => Promise.resolve({ outcome: "sent", messageId: "m" }),
    from: "f@x.invalid",
    newKey: () => "k",
  });
  assertEquals((await run("sent")).sent, 1);
  const stale = await run("stale");
  assertEquals([stale.sent, stale.lost], [0, 1]);
  assertEquals((await run("needs_check")).check, 1);
});

Deno.test("nothing is sent unless confirm says send", async () => {
  const sends: unknown[] = [];
  const calls: string[] = [];
  const result = await runReceiptBatch({
    rpc: (fn) => {
      calls.push(fn);
      return Promise.resolve(fn === "claim_delivery_receipts" ? [claim] : "needs_check");
    },
    send: (r) => { sends.push(r); return Promise.resolve({ outcome: "sent", messageId: "m" }); },
    from: "f@x.invalid",
    newKey: () => "k",
  });
  assertEquals(sends.length, 0);
  assertEquals(calls, ["claim_delivery_receipts", "confirm_delivery_receipt_send"]);
  assertEquals([result.skipped, result.check], [0, 1]);
});
