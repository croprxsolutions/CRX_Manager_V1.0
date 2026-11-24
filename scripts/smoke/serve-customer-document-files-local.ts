// Serves TODAY's supabase/functions/customer-document-files (unmodified) on one loopback origin next to
// the local test stack, so supabase-js can use a single URL for auth, rest, storage and functions
// (the real hosted layout). Started by run-customer-document-bytes-proof.mjs; not a deploy tool.
//   /functions/v1/customer-document-files -> the function's own handler
//   everything else                       -> the local gateway (127.0.0.1 only)
// Env: GATEWAY_URL, SERVE_PORT, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ALLOWED_ORIGIN.
const gateway = Deno.env.get("GATEWAY_URL")!;
const port = Number(Deno.env.get("SERVE_PORT"));
for (const url of [gateway, Deno.env.get("SUPABASE_URL")!]) {
  if (new URL(url).hostname !== "127.0.0.1") throw new Error(`Refusing non-loopback ${url}`);
}

// The function calls Deno.serve itself; capture its handler instead of opening port 8000.
type Handler = (req: Request) => Response | Promise<Response>;
let handler: Handler | undefined;
const realServe = Deno.serve;
const denoServe = Deno as unknown as { serve: unknown };
denoServe.serve = (a: unknown, b?: Handler) => {
  handler = (typeof a === "function" ? a : b) as Handler;
  return { shutdown: () => Promise.resolve() };
};
await import("../../supabase/functions/customer-document-files/index.ts");
denoServe.serve = realServe;
if (!handler) throw new Error("customer-document-files did not register a handler");

realServe({ hostname: "127.0.0.1", port }, (req: Request) => {
  const { pathname, search } = new URL(req.url);
  if (pathname === "/functions/v1/customer-document-files") return handler!(req);
  return fetch(new Request(`${gateway}${pathname}${search}`, req));
});
