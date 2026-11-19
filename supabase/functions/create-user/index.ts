import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { captureEdgeException, warnIfSentryMisconfigured } from "../_shared/sentry.ts";
import { requireActiveProfile } from "../_shared/auth.ts";
import { corsHeaders, preflightResponse } from "../_shared/cors.ts";
import { activateNewUser } from "./logic.ts";
import { adminResetPassword, type PasswordResetClient } from "../_shared/passwordReset.ts";

warnIfSentryMisconfigured("create-user");

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

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    // Codex audit F1 (P1, 2026-05-16): is_active gate enforced server-side.
    const gate = await requireActiveProfile(adminClient, caller.id, ["admin"]);
    if ("error" in gate) {
      return new Response(JSON.stringify({ error: gate.error }), {
        status: gate.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { action } = body;

    // --- Reset Password action ---
    if (action === "reset_password") {
      // KI-122: shared with reset-user-password; checks the target, writes the
      // server audit row, then changes the password (see _shared/passwordReset.ts).
      const outcome = await adminResetPassword(adminClient as unknown as PasswordResetClient, caller.id, body.user_id, body.password);
      return new Response(JSON.stringify(outcome.body), {
        status: outcome.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Create User action (default) ---
    const { email, password, full_name, role, phone } = body;

    if (!email || !password || !full_name) {
      return new Response(
        JSON.stringify({ error: "Email, password, and full name are required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const validRoles = ["admin", "sales_rep", "driver", "applicator"];
    if (role && !validRoles.includes(role)) {
      return new Response(
        JSON.stringify({ error: `Invalid role: ${role}. Must be one of: ${validRoles.join(", ")}` }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: newUser, error: createError } =
      await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name, role: role || "sales_rep" },
      });

    if (createError) {
      return new Response(JSON.stringify({ error: createError.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Activate in the same request, as the calling admin (see logic.ts). On
    // failure the login still exists but stays blocked; `activated: false`
    // tells the page to retry the step itself or say so. The reason goes to
    // Sentry only, never into the reply.
    const newUserId = newUser.user.id;
    const activationError = await activateNewUser(callerClient, {
      userId: newUserId,
      fullName: full_name,
      role: role || "sales_rep",
      phone,
    });
    if (activationError) {
      await captureEdgeException(new Error(activationError), {
        function: "create-user",
        level: "warning",
        extra: { context: "activate_new_user", user_id: newUserId },
      });
    }

    return new Response(
      JSON.stringify({
        user: { id: newUserId, email },
        activated: activationError === null,
      }),
      {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    // Audit #28: surface unhandled errors to Sentry — admin user creation
    // failures are security-relevant (e.g. service-role permission issues,
    // mass-create attempts) and need oncall visibility.
    await captureEdgeException(err, {
      function: "create-user",
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
