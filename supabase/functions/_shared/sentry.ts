// =============================================================================
// Edge Function Sentry helper — Sprint F #7
//
// Small helper that posts events to Sentry's HTTP store endpoint without
// pulling in a Node-only SDK. Safe to import from any Deno-hosted Edge
// Function. If SENTRY_DSN is not set, captureEdgeException sends nothing so
// dev/test environments never accidentally hit production Sentry. Every function also
// calls warnIfSentryMisconfigured() at module top so a missing key is logged
// as an error on each cold start (KI-38).
//
// Usage:
//   import { captureEdgeException } from "../_shared/sentry.ts";
//   try { ... } catch (err) {
//     await captureEdgeException(err, {
//       function: "send-email",
//       extra: { email_type, customer_id },
//     });
//     throw err; // or return error response
//   }
//
// Set SENTRY_DSN as a Supabase Function secret to enable.
// =============================================================================

interface CaptureContext {
  function: string;
  level?: "fatal" | "error" | "warning" | "info";
  extra?: Record<string, unknown>;
  tags?: Record<string, string>;
  user?: { id?: string; email?: string };
}

interface ParsedDsn {
  host: string;
  projectId: string;
  publicKey: string;
}

function parseSentryDsn(dsn: string): ParsedDsn | null {
  // DSN format: https://<publicKey>@<host>/<projectId>
  const match = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(\d+)$/);
  if (!match) return null;
  return { publicKey: match[1], host: match[2], projectId: match[3] };
}

/**
 * KI-38: call once at module top of every Edge Function. On every cold start
 * with a missing or malformed SENTRY_DSN it writes an ERROR-level
 * [SENTRY_MISCONFIG] line, even if no request ever fails. It deliberately
 * never throws: a missing alert key must not stop an email send or a user
 * creation, so the function keeps serving and only the alerting is degraded.
 */
export function warnIfSentryMisconfigured(functionName: string): void {
  try {
    const dsn = Deno.env.get("SENTRY_DSN");
    const problem = !dsn
      ? "SENTRY_DSN is not set"
      : !parseSentryDsn(dsn)
      ? "SENTRY_DSN is malformed (expected https://<publicKey>@<host>/<projectId>)"
      : null;
    if (problem) {
      // eslint-disable-next-line no-console -- KI-38: must be ERROR level in Supabase logs
      console.error(
        `[SENTRY_MISCONFIG] function=${functionName}: ${problem}. Errors from this function will NOT reach Sentry until the secret is fixed.`,
      );
    }
  } catch {
    // Never let the alerting check stop the function from serving.
  }
}

/**
 * Send an exception to Sentry. Resolves to true if sent, false on failure
 * or when no DSN is configured. Never throws — Sentry is observability,
 * not a user-facing dependency.
 */
export async function captureEdgeException(
  err: unknown,
  context: CaptureContext,
): Promise<boolean> {
  const dsn = Deno.env.get("SENTRY_DSN");
  if (!dsn) {
    // Audit #28: previously silent — now logs prominently with a SENTRY_MISCONFIG
    // sentinel that's easy to grep in Supabase function logs. Most functions
    // won't have DSN set in dev, so this is expected to be a no-op there.
    // In prod with the secret correctly set this branch never fires.
    console.warn(
      `[SENTRY_MISCONFIG] SENTRY_DSN not configured — captured exception NOT sent (function=${context.function}). warnIfSentryMisconfigured() also flags this at cold start.`,
    );
    return false;
  }

  const parsed = parseSentryDsn(dsn);
  if (!parsed) {
    // Audit #28: was a quiet warn. Same sentinel makes log-grep easy.
    // A malformed DSN in prod is always a misconfiguration worth investigating.
    console.warn(
      `[SENTRY_MISCONFIG] Invalid SENTRY_DSN — alerting silently disabled (function=${context.function}). Expected https://<publicKey>@<host>/<projectId>.`,
    );
    return false;
  }

  const error = err instanceof Error ? err : new Error(String(err));
  const eventId = crypto.randomUUID().replace(/-/g, "");
  const timestamp = new Date().toISOString();

  const payload = {
    event_id: eventId,
    timestamp,
    platform: "javascript",
    level: context.level ?? "error",
    server_name: `edge-function:${context.function}`,
    environment: Deno.env.get("SENTRY_ENVIRONMENT") || "production",
    release: Deno.env.get("SENTRY_RELEASE") || undefined,
    tags: {
      edge_function: context.function,
      ...(context.tags ?? {}),
    },
    user: context.user ?? undefined,
    extra: context.extra ?? undefined,
    exception: {
      values: [
        {
          type: error.name,
          value: error.message,
          stacktrace: error.stack
            ? {
              frames: error.stack
                .split("\n")
                .slice(1)
                .map((line) => ({ filename: line.trim() }))
                .reverse(),
            }
            : undefined,
        },
      ],
    },
  };

  try {
    const url =
      `https://${parsed.host}/api/${parsed.projectId}/store/?sentry_version=7&sentry_key=${parsed.publicKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (sentryErr) {
    console.warn("Sentry capture failed:", sentryErr);
    return false;
  }
}
