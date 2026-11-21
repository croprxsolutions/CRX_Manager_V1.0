import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { captureEdgeException, warnIfSentryMisconfigured } from "../_shared/sentry.ts";
import { requireActiveProfile } from "../_shared/auth.ts";
import { corsHeaders, preflightResponse } from "../_shared/cors.ts";
import { adminResetPassword, type PasswordResetClient } from "../_shared/passwordReset.ts";

warnIfSentryMisconfigured("reset-user-password");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return preflightResponse(req);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify the caller is authenticated
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user: caller },
    } = await callerClient.auth.getUser();
    if (!caller) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Codex audit F1 (P1, 2026-05-16): is_active gate enforced server-side.
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const gate = await requireActiveProfile(adminClient, caller.id, ["admin"]);
    if ("error" in gate) {
      return new Response(JSON.stringify({ error: gate.error }), {
        status: gate.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { user_id, password } = await req.json();

    // KI-122: checks the target, writes the server audit row, then changes the
    // password (see _shared/passwordReset.ts).
    const outcome = await adminResetPassword(adminClient as unknown as PasswordResetClient, caller.id, user_id, password);
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    // Audit #28: surface unhandled errors — admin password resets are
    // security-relevant and need oncall visibility.
    await captureEdgeException(err, {
      function: "reset-user-password",
      level: "error",
    });
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
