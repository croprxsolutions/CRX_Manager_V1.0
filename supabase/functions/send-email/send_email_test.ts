// Behaviour tests for send-email (PR #1302 review, finding 2). They run the real
// handler against an in-memory stand-in for the database's REST API and for
// Resend, both reached through a stubbed global fetch, so nothing leaves this
// process. Run with the command in .github/workflows/ci.yml (Edge Function unit tests).

type Row = Record<string, unknown>;
type Handler = (req: Request) => Promise<Response>;

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message ?? "assertEquals"}: expected ${e}, received ${a}`);
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// index.ts calls Deno.serve on load; capture its handler instead of listening.
let handler: Handler | null = null;
(Deno as unknown as { serve: (h: Handler) => unknown }).serve = (h) => {
  handler = h;
  return {};
};
Deno.env.set("SUPABASE_URL", "http://db.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
Deno.env.set("ALLOWED_ORIGIN", "https://app.test");
Deno.env.set("RESEND_API_KEY", "resend-key");
Deno.env.delete("SENTRY_DSN");
await import("./index.ts");

const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const REP = "aaaaaaaa-0000-4000-8000-000000000002";
const CUSTOMER = "cccccccc-0000-4000-8000-000000000001";
const OTHER_CUSTOMER = "cccccccc-0000-4000-8000-000000000002";
const QUOTE = "dddddddd-0000-4000-8000-000000000001";
const OTHER_QUOTE = "dddddddd-0000-4000-8000-000000000002";

interface ResendCall {
  body: Record<string, unknown>;
}

// Minimal PostgREST: eq / neq / in / gte filters, exact counts, unique email_log keys,
// and object replies with the 406 "0 rows" error postgrest-js turns into null.
function makeWorld(resend: (call: ResendCall, signal: AbortSignal | null) => Promise<Response>) {
  const tables: Record<string, Row[]> = {
    profiles: [
      { id: ADMIN, role: "admin", is_active: true },
      { id: REP, role: "sales_rep", is_active: true },
    ],
    customers: [
      { id: CUSTOMER, email: "farmer@example.com", farm_name: "Test Farm" },
      { id: OTHER_CUSTOMER, email: "other@example.com", farm_name: "Other Farm" },
    ],
    quotes: [
      { id: QUOTE, customer_id: CUSTOMER, quote_number: "Q-1" },
      { id: OTHER_QUOTE, customer_id: OTHER_CUSTOMER, quote_number: "Q-2" },
    ],
    email_log: [],
  };
  const resendCalls: ResendCall[] = [];
  let nextId = 1;

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  function matches(row: Row, params: URLSearchParams): boolean {
    for (const [col, raw] of params) {
      if (["select", "limit", "order", "columns"].includes(col)) continue;
      const dot = raw.indexOf(".");
      const op = raw.slice(0, dot);
      const value = raw.slice(dot + 1);
      const cell = row[col] == null ? null : String(row[col]);
      // uuid columns compare without regard to case, as in Postgres
      if (op === "eq" && cell?.toLowerCase() !== value.toLowerCase()) return false;
      if (op === "gte" && (cell == null || cell < value)) return false;
      if (op === "neq" && cell === value) return false;
      if (op === "like") {
        const pattern = value.replace(/\\(.)|([%_])|([^\\%_]+)/g, (_m, esc, wild, lit) =>
          esc ? esc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          : wild ? (wild === "%" ? ".*" : ".")
          : lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        if (cell == null || !new RegExp(`^${pattern}$`, "s").test(cell)) return false;
      }
      if (op === "in") {
        const list = value.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|[^,]+/g)?.map((v) => v.replace(/^"|"$/g, "")) ?? [];
        if (cell == null || !list.includes(cell)) return false;
      }
    }
    return true;
  }

  function reply(rows: Row[], req: Request): Response {
    if ((req.headers.get("accept") ?? "").includes("vnd.pgrst.object")) {
      if (rows.length !== 1) {
        return json({ code: "PGRST116", details: `The result contains ${rows.length} rows`, message: "JSON object requested, multiple (or no) rows returned" }, 406);
      }
      return json(rows[0]);
    }
    return json(rows);
  }

  async function fakeFetch(input: Request | URL | string, init?: RequestInit): Promise<Response> {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === "api.resend.com") {
      const call = {
        body: await req.json(),
      };
      resendCalls.push(call);
      return world.resend(call, init?.signal ?? null);
    }
    if (url.pathname === "/auth/v1/user") {
      const token = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
      return json({ id: token, aud: "authenticated", role: "authenticated" });
    }
    const table = url.pathname.replace("/rest/v1/", "");
    const rows = (tables[table] ??= []);
    // Let other requests run between reading and writing, as a real server would.
    await new Promise((r) => setTimeout(r, 0));
    if (req.method === "HEAD" || req.method === "GET") {
      const found = rows.filter((row) => matches(row, url.searchParams));
      if (req.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-range": `*/${found.length}` } });
      }
      return reply(found, req);
    }
    // email_log_one_pending_send: one pending row per send_lock_key (NULL never clashes).
    const lockClash = (row: Row, self?: Row) =>
      table === "email_log" && row.status === "pending" && row.send_lock_key != null &&
      rows.some((r) => r !== self && r.status === "pending" && r.send_lock_key === row.send_lock_key);
    const unique = (name: string) =>
      json({ code: "23505", message: `duplicate key value violates unique constraint "${name}"`, details: null, hint: null }, 409);
    if (req.method === "POST") {
      const body = await req.json();
      const inserted: Row[] = [];
      for (const row of Array.isArray(body) ? body : [body]) {
        if (table === "email_log" && row.idempotency_key != null &&
          rows.some((r) => r.idempotency_key === row.idempotency_key)) {
          return unique("email_log_idempotency_key_key");
        }
        if (lockClash(row)) return unique("email_log_one_pending_send");
        const saved = { id: `log-${nextId++}`, created_at: new Date().toISOString(), ...row };
        rows.push(saved);
        inserted.push(saved);
      }
      return reply(inserted, req);
    }
    if (req.method === "PATCH") {
      const patch = await req.json();
      const updated = rows.filter((row) => matches(row, url.searchParams));
      if (updated.some((row) => lockClash({ ...row, ...patch }, row))) return unique("email_log_one_pending_send");
      for (const row of updated) Object.assign(row, patch);
      if ((req.headers.get("prefer") ?? "").includes("return=representation")) return reply(updated, req);
      return new Response(null, { status: 204 });
    }
    throw new Error(`fake database: unexpected ${req.method} ${req.url}`);
  }

  const world = { tables, resendCalls, resend, fakeFetch };
  return world;
}

const okResend = () => Promise.resolve(new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));

// Every fetch in this file goes to the world the running test set up, and never
// to the real network (the test run is also given no network permission).
let currentWorld: ReturnType<typeof makeWorld> | null = null;
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  if (!currentWorld) throw new Error("fetch outside a test world");
  return currentWorld.fakeFetch(input, init);
}) as typeof fetch;

async function send(
  world: ReturnType<typeof makeWorld>,
  caller: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  currentWorld = world;
  const res = await handler!(new Request("http://edge.test/send-email", {
    method: "POST",
    headers: { Authorization: `Bearer ${caller}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

const statementEmail = {
  to: "farmer@example.com",
  email_type: "statement",
  customer_id: CUSTOMER,
  subject: "Your statement",
  html: "<p>Your statement is attached.</p>",
};
const quoteEmail = (quoteId: string, key?: string) => ({
  to: "farmer@example.com",
  email_type: "quote",
  customer_id: CUSTOMER,
  resource_type: "quote",
  resource_id: quoteId,
  subject: "Your quote",
  html: "<p>Your quote.</p>",
  ...(key ? { idempotency_key: key } : {}),
});

// --- Who may send what (item 1) ----------------------------------------------

Deno.test("a sales rep is refused an A/R reminder; nothing is logged or sent", async () => {
  const world = makeWorld(okResend);
  const res = await send(world, REP, { ...statementEmail, email_type: "ar_reminder" });
  assertEquals(res.status, 403);
  assertEquals(res.body.error, "Role 'sales_rep' is not permitted to send 'ar_reminder' emails");
  assertEquals(world.resendCalls.length, 0, "Resend calls");
  assertEquals(world.tables.email_log.length, 0, "email_log rows");
});

for (const [who, caller] of [["an admin", ADMIN], ["a sales rep", REP]]) {
  Deno.test(`${who} may send a statement`, async () => {
    const world = makeWorld(okResend);
    const res = await send(world, caller, statementEmail);
    assertEquals(res.status, 200);
    assertEquals(res.body.success, true);
    assertEquals(world.resendCalls.length, 1, "Resend calls");
    assertEquals(world.tables.email_log[0].status, "sent");
  });
}

Deno.test("a sales rep may still send a quote for the quote's customer", async () => {
  const world = makeWorld(okResend);
  const res = await send(world, REP, quoteEmail(QUOTE));
  assertEquals(res.status, 200);
  assertEquals(world.resendCalls.length, 1, "Resend calls");
});

// --- Record ownership and retry keys (#1302 checks) --------------------------

Deno.test("a quote belonging to another customer is refused before anything is logged or sent", async () => {
  const world = makeWorld(okResend);
  const res = await send(world, ADMIN, quoteEmail(OTHER_QUOTE));
  assertEquals(res.status, 403);
  assertEquals(res.body.error, "quote does not belong to customer_id");
  assertEquals(world.resendCalls.length, 0, "Resend calls");
  assertEquals(world.tables.email_log.length, 0, "email_log rows");
});

Deno.test("a key already used for a different email is refused with 409", async () => {
  const world = makeWorld(okResend);
  world.tables.email_log.push({
    id: "old-1", idempotency_key: `confirm-${QUOTE}`, email_type: "order_confirmed",
    customer_id: CUSTOMER, status: "sent", resend_message_id: "re_old",
  });
  const res = await send(world, ADMIN, quoteEmail(QUOTE, `confirm-${QUOTE}`));
  assertEquals(res.status, 409);
  assertEquals(res.body.error, "This idempotency_key was already used for a different email");
  assertEquals(world.resendCalls.length, 0, "Resend calls");
});

Deno.test("an old key that does not name the record is refused rather than reported as sent", async () => {
  const world = makeWorld(okResend);
  world.tables.email_log.push({
    id: "old-1", idempotency_key: "quote-123", email_type: "quote",
    customer_id: CUSTOMER, status: "sent", resend_message_id: "re_old", attachment_name: null,
  });
  const res = await send(world, ADMIN, quoteEmail(QUOTE, "quote-123"));
  assertEquals(res.status, 409);
  assert(String(res.body.error).startsWith("This idempotency_key was used before keys were tied"), String(res.body.error));
  assertEquals(world.resendCalls.length, 0, "Resend calls");
});

Deno.test("an old key that names the record still dedupes: no second email", async () => {
  const world = makeWorld(okResend);
  world.tables.email_log.push({
    id: "old-1", idempotency_key: `quote-${QUOTE}`, email_type: "quote",
    customer_id: CUSTOMER, status: "sent", resend_message_id: "re_old",
  });
  const res = await send(world, ADMIN, quoteEmail(QUOTE, `quote-${QUOTE}`));
  assertEquals(res.status, 200);
  assertEquals(res.body.deduplicated, true);
  assertEquals(res.body.email_log_id, "old-1");
  assertEquals(world.resendCalls.length, 0, "Resend calls");
});

Deno.test("the same key on a different record is a separate email", async () => {
  const world = makeWorld(okResend);
  world.tables.quotes.push({ id: "dddddddd-0000-4000-8000-000000000003", customer_id: CUSTOMER, quote_number: "Q-3" });
  assertEquals((await send(world, ADMIN, quoteEmail(QUOTE, "shared-key"))).status, 200);
  assertEquals((await send(world, ADMIN, quoteEmail("dddddddd-0000-4000-8000-000000000003", "shared-key"))).status, 200);
  assertEquals(world.resendCalls.length, 2, "Resend calls");
});

Deno.test("a retry spelling the customer and record ids in capitals still dedupes", async () => {
  const world = makeWorld(okResend);
  assertEquals((await send(world, ADMIN, quoteEmail(QUOTE, "caps-key"))).status, 200);
  const res = await send(world, ADMIN, {
    ...quoteEmail(QUOTE.toUpperCase(), "caps-key"),
    customer_id: CUSTOMER.toUpperCase(),
  });
  assertEquals(res.status, 200);
  assertEquals(res.body.deduplicated, true);
  assertEquals(world.resendCalls.length, 1, "Resend calls");
});

// --- The database lock: one pending send per email ---------------------------

const quoteLock = `quote:quote:${QUOTE}:${CUSTOMER}`;

Deno.test("the database lock refuses a send the early check cannot see", async () => {
  const world = makeWorld(okResend);
  // Pending under a key the early check does not recognise, but naming the same email.
  world.tables.email_log.push({
    id: "held-1", idempotency_key: "other-format-key", send_lock_key: quoteLock,
    email_type: "quote", customer_id: CUSTOMER, status: "pending",
  });
  const res = await send(world, ADMIN, quoteEmail(QUOTE, "fresh-key"));
  assertEquals(res.status, 409);
  assertEquals(res.body.needs_reconciliation, true);
  assertEquals(res.body.email_log_id, "held-1");
  assertEquals(world.resendCalls.length, 0, "Resend calls");
});

Deno.test("a retry of a failed send is refused while the same email is held by another pending row", async () => {
  const world = makeWorld(okResend);
  world.tables.email_log.push(
    {
      id: "failed-1", idempotency_key: `quote:quote:${QUOTE}:retry-key`, send_lock_key: quoteLock,
      email_type: "quote", customer_id: CUSTOMER, status: "failed",
    },
    {
      id: "held-2", idempotency_key: "other-format-key", send_lock_key: quoteLock,
      email_type: "quote", customer_id: CUSTOMER, status: "pending",
    },
  );
  const res = await send(world, ADMIN, quoteEmail(QUOTE, "retry-key"));
  assertEquals(res.status, 409);
  assertEquals(res.body.email_log_id, "held-2");
  assertEquals(world.tables.email_log[0].status, "failed", "failed row left as it was");
  assertEquals(world.resendCalls.length, 0, "Resend calls");
});

Deno.test("a confirmed send is logged sent with no error message", async () => {
  const world = makeWorld(okResend);
  assertEquals((await send(world, ADMIN, quoteEmail(QUOTE, "ok-key"))).status, 200);
  assertEquals(world.tables.email_log[0].status, "sent");
  assertEquals(world.tables.email_log[0].resend_message_id, "re_1");
  assertEquals(world.tables.email_log[0].error_message, null);
});

Deno.test("every new pending row names its email in send_lock_key", async () => {
  const world = makeWorld(okResend);
  assertEquals((await send(world, ADMIN, quoteEmail(QUOTE.toUpperCase(), "lock-key"))).status, 200);
  assertEquals(world.tables.email_log[0].send_lock_key, quoteLock);
});

Deno.test("a retry that claims a failed row logged before the lock gives it the lock key", async () => {
  const world = makeWorld(okResend);
  world.tables.email_log.push({
    id: "old-failed", idempotency_key: `quote:quote:${QUOTE}:old-key`, send_lock_key: null,
    email_type: "quote", customer_id: CUSTOMER, status: "failed", created_by: REP,
  });
  assertEquals((await send(world, ADMIN, quoteEmail(QUOTE, "old-key"))).status, 200);
  assertEquals(world.tables.email_log.length, 1, "the failed row was reused");
  assertEquals(world.tables.email_log[0].send_lock_key, quoteLock);
  assertEquals(world.tables.email_log[0].created_by, ADMIN, "the retry counts toward the hourly limit of whoever sent it");
});

// --- Two retries at the same moment (item 3) ---------------------------------

Deno.test("two retries of the same failed email at the same moment send it once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const world = makeWorld(async () => {
    await gate;
    return new Response(JSON.stringify({ id: "re_retry" }), { status: 200 });
  });
  const key = `quote-${QUOTE}`;
  world.tables.email_log.push({
    id: "log-failed", idempotency_key: `quote:quote:${QUOTE}:${key}`, email_type: "quote",
    customer_id: CUSTOMER, status: "failed", resend_message_id: null,
  });
  // The first send is held at Resend until the other request has answered (or,
  // if both wrongly reached Resend, for half a second), so they overlap.
  const sends = [send(world, ADMIN, quoteEmail(QUOTE, key)), send(world, ADMIN, quoteEmail(QUOTE, key))];
  Promise.race(sends).then(() => release());
  const fallback = setTimeout(() => release(), 500);
  const results = await Promise.all(sends);
  clearTimeout(fallback);
  assertEquals(world.resendCalls.length, 1, "Resend calls");
  assertEquals(results.map((r) => r.status).sort(), [200, 409]);
  assertEquals(results.find((r) => r.status === 409)!.body.needs_reconciliation, true);
  assertEquals(world.tables.email_log[0].status, "sent");
});

Deno.test("a racing send that finds the email already sent reports it as sent", async () => {
  const world = makeWorld(okResend);
  const results = await Promise.all([
    send(world, ADMIN, quoteEmail(QUOTE, `quote-${QUOTE}`)),
    send(world, ADMIN, quoteEmail(QUOTE, `quote-${QUOTE}`)),
  ]);
  assertEquals(world.resendCalls.length, 1, "Resend calls");
  const fresh = results.filter((r) => r.status === 200 && !r.body.deduplicated);
  const others = results.filter((r) => !fresh.includes(r));
  assertEquals(fresh.length, 1, "exactly one real send");
  // The other either saw it already sent or still in progress, depending on timing.
  assert(others[0].status === 409 || others[0].body.deduplicated === true, JSON.stringify(others[0]));
});

// --- A slow or broken email provider (item 4) --------------------------------

Deno.test("a provider that never answers stops the request in time and blocks a blind re-send", async () => {
  const realTimeout = AbortSignal.timeout;
  const askedMs: number[] = [];
  AbortSignal.timeout = (ms: number) => {
    askedMs.push(ms);
    return realTimeout.call(AbortSignal, 20);
  };
  try {
    const world = makeWorld((_call, signal) =>
      new Promise((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason));
      })
    );
    const first = await send(world, ADMIN, quoteEmail(QUOTE, `quote-${QUOTE}`));
    assertEquals(first.status, 504);
    assertEquals(first.body.needs_reconciliation, true);
    assert(String(first.body.error).includes("Email provider did not answer within 30 seconds. It may still have been sent"), String(first.body.error));
    assertEquals(askedMs, [30_000]);
    const row = world.tables.email_log[0];
    assertEquals(row.status, "pending", "unknown outcome stays pending");
    assert(String(row.error_message).startsWith("Email provider did not answer"), "the reason is written on the row");

    // It may have reached the customer, so the same email is not sent again until someone checks.
    const retry = await send(world, ADMIN, quoteEmail(QUOTE, `quote-${QUOTE}`));
    assertEquals(retry.status, 409);
    assertEquals(retry.body.needs_reconciliation, true);
    // A screen that makes a new key on every click is held back too.
    const newClick = await send(world, ADMIN, quoteEmail(QUOTE, `quote-${QUOTE}-${Date.now()}`));
    assertEquals(newClick.status, 409);
    assertEquals(newClick.body.needs_reconciliation, true);
    assertEquals(newClick.body.email_log_id, row.id);
    // Another quote for the same customer is a different email and still goes.
    const otherQuote = "dddddddd-0000-4000-8000-000000000009";
    world.tables.quotes.push({ id: otherQuote, customer_id: CUSTOMER, quote_number: "Q-9" });
    AbortSignal.timeout = realTimeout;
    world.resend = okResend;
    assertEquals((await send(world, ADMIN, quoteEmail(otherQuote, `quote-${otherQuote}`))).status, 200);
    assertEquals(world.resendCalls.length, 2, "Resend calls");
  } finally {
    AbortSignal.timeout = realTimeout;
  }
});

function withNoAnswerProvider<T>(run: (world: ReturnType<typeof makeWorld>) => Promise<T>): Promise<T> {
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => realTimeout.call(AbortSignal, 20);
  const world = makeWorld((_call, signal) =>
    new Promise((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason));
    })
  );
  return run(world).finally(() => (AbortSignal.timeout = realTimeout));
}

Deno.test("a send with no key, or with the record id in capitals, is still held back by an unconfirmed send", async () => {
  await withNoAnswerProvider(async (world) => {
    assertEquals((await send(world, ADMIN, quoteEmail(QUOTE))).status, 504);
    assert(String(world.tables.email_log[0].idempotency_key).startsWith(`quote:quote:${QUOTE}:auto-`), "keyless row is tagged with its record");
    const again = await send(world, ADMIN, quoteEmail(QUOTE));
    assertEquals(again.status, 409);
    const capitals = await send(world, ADMIN, quoteEmail(QUOTE.toUpperCase(), "another-key"));
    assertEquals(capitals.status, 409);
    assertEquals(world.resendCalls.length, 1, "Resend calls");
  });
});

Deno.test("one customer's unconfirmed job notice does not hold back another customer's notice for the same job", async () => {
  await withNoAnswerProvider(async (world) => {
    const job = "eeeeeeee-0000-4000-8000-000000000001";
    world.tables.job_notifications = [
      { idempotency_key: "notice-a", job_id: job, customer_id: CUSTOMER, notification_type: "pre" },
      { idempotency_key: "notice-b", job_id: job, customer_id: OTHER_CUSTOMER, notification_type: "pre" },
    ];
    const notice = (customer: string, to: string, key: string) => ({
      to, email_type: "pre_application_notice", customer_id: customer,
      subject: "Application planned", html: "<p>We plan to apply soon.</p>", idempotency_key: key,
    });
    assertEquals((await send(world, ADMIN, notice(CUSTOMER, "farmer@example.com", "notice-a"))).status, 504);
    world.resend = okResend;
    const other = await send(world, ADMIN, notice(OTHER_CUSTOMER, "other@example.com", "notice-b"));
    assertEquals(other.status, 200, JSON.stringify(other.body));
    const sameCustomerAgain = await send(world, ADMIN, notice(CUSTOMER, "farmer@example.com", "notice-a"));
    assertEquals(sameCustomerAgain.status, 409);
  });
});

Deno.test("a refused request (4xx) marks the email failed, and a retry may send it", async () => {
  const world = makeWorld(() =>
    Promise.resolve(new Response(JSON.stringify({ message: "Invalid `to` field" }), { status: 422 }))
  );
  const res = await send(world, ADMIN, quoteEmail(QUOTE, `quote-${QUOTE}`));
  assertEquals(res.status, 502);
  assertEquals(world.tables.email_log[0].status, "failed");
  assertEquals(world.tables.email_log[0].error_message, "Invalid `to` field");
  const retry = await send(world, ADMIN, quoteEmail(QUOTE, `quote-${QUOTE}`));
  assertEquals(retry.status, 502);
  assertEquals(world.resendCalls.length, 2, "Resend calls");
});

Deno.test("a gateway error (5xx, not JSON) stays pending: the email may have gone out", async () => {
  const world = makeWorld(() => Promise.resolve(new Response("<html>Bad gateway</html>", { status: 502 })));
  const res = await send(world, ADMIN, quoteEmail(QUOTE));
  assertEquals(res.status, 504);
  assertEquals(res.body.needs_reconciliation, true);
  assertEquals(world.tables.email_log[0].status, "pending");
  assert(String(world.tables.email_log[0].error_message).startsWith("Email provider replied 502"), "error message");
  assert(String(res.body.error).startsWith("Not confirmed: this email may have reached the customer"), "caller message");
});

Deno.test("a 408 reply is not a refusal: the email stays pending", async () => {
  const world = makeWorld(() => Promise.resolve(new Response(JSON.stringify({ message: "Request Timeout" }), { status: 408 })));
  const res = await send(world, ADMIN, quoteEmail(QUOTE));
  assertEquals(res.status, 504);
  assertEquals(world.tables.email_log[0].status, "pending");
});

Deno.test("an OK reply that cannot be read stays pending, not sent and not failed", async () => {
  const world = makeWorld(() => Promise.resolve(new Response("OK", { status: 200 })));
  const res = await send(world, ADMIN, quoteEmail(QUOTE));
  assertEquals(res.status, 504);
  assertEquals(world.tables.email_log[0].status, "pending");
});

Deno.test("a send of the same email confirmed after the early check stops this one", async () => {
  const world = makeWorld(okResend);
  // Another request sent it moments ago, under its own key: no pending row is left
  // for the early check or the unique index to see.
  world.tables.email_log.push({
    id: "sent-now", idempotency_key: "other-click-key", send_lock_key: quoteLock,
    email_type: "quote", customer_id: CUSTOMER, status: "sent", resend_message_id: "re_0",
    created_at: new Date().toISOString(),
  });
  const res = await send(world, ADMIN, quoteEmail(QUOTE, "second-click-key"));
  assertEquals(res.status, 200);
  assertEquals(res.body.deduplicated, true);
  assertEquals(res.body.email_log_id, "sent-now");
  assertEquals(world.resendCalls.length, 0, "Resend calls");
  assertEquals(world.tables.email_log[1].status, "sent", "this request's row gives up the lock as a deduplicated send");
  assertEquals(world.tables.email_log[1].resend_message_id, "re_0");
  // Replayed after the few-second window (its first answer lost): still no second email.
  world.tables.email_log[0].created_at = new Date(Date.now() - 60_000).toISOString();
  const replay = await send(world, ADMIN, quoteEmail(QUOTE, "second-click-key"));
  assertEquals(replay.status, 200);
  assertEquals(replay.body.deduplicated, true);
  assertEquals(world.resendCalls.length, 0, "Resend calls after replay");
});

Deno.test("a corrected email sent again two seconds later goes out", async () => {
  const world = makeWorld(okResend);
  world.tables.email_log.push({
    id: "sent-2s", idempotency_key: "first-click-key", send_lock_key: quoteLock,
    email_type: "quote", customer_id: CUSTOMER, status: "sent", resend_message_id: "re_0",
    created_at: new Date(Date.now() - 2000).toISOString(),
  });
  const res = await send(world, ADMIN, quoteEmail(QUOTE, "corrected-key"));
  assertEquals(res.status, 200);
  assertEquals(res.body.deduplicated, undefined);
  assertEquals(world.resendCalls.length, 1, "Resend calls");
});

Deno.test("an earlier confirmed send of the same email does not block a new one", async () => {
  const world = makeWorld(okResend);
  world.tables.email_log.push({
    id: "sent-earlier", idempotency_key: "yesterday-key", send_lock_key: quoteLock,
    email_type: "quote", customer_id: CUSTOMER, status: "sent", resend_message_id: "re_0",
    created_at: new Date(Date.now() - 60_000).toISOString(),
  });
  const res = await send(world, ADMIN, quoteEmail(QUOTE, "today-key"));
  assertEquals(res.status, 200);
  assertEquals(res.body.deduplicated, undefined);
  assertEquals(world.resendCalls.length, 1, "Resend calls");
});

Deno.test("a bounced send is retried with its original key", async () => {
  const world = makeWorld(okResend);
  world.tables.email_log.push({
    id: "bounced-1", idempotency_key: `quote:quote:${QUOTE}:bounce-key`, send_lock_key: quoteLock,
    email_type: "quote", customer_id: CUSTOMER, status: "bounced",
    created_at: new Date(Date.now() - 60_000).toISOString(),
  });
  const res = await send(world, ADMIN, quoteEmail(QUOTE, "bounce-key"));
  assertEquals(res.status, 200);
  assertEquals(world.tables.email_log[0].status, "sent");
  assertEquals(world.resendCalls.length, 1, "Resend calls");
});
