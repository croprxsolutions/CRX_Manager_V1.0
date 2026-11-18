// Admin "set password" for another user, shared by create-user (action
// reset_password) and reset-user-password (KI-122). The caller has already been
// verified as an active admin; callerId comes from that verified token, never
// from the request body.
//
// Order: the target must load and be a real login (not an entity_recipient
// payout profile), then the server writes its own activity_feed row, then Auth
// changes the password. No row, no reset. Supabase Auth's admin password update
// already ends the target's existing sign-ins (GoTrue Logout in the same
// transaction), so nothing else is needed for that.

type DbError = { message: string } | null;

// The narrow slice of the service-role SupabaseClient this uses (callers cast:
// the full client type is too deep for structural checking), or a test double.
export interface PasswordResetClient {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => PromiseLike<{ data: { role?: string | null } | null; error: DbError }>;
      };
    };
    insert: (row: Record<string, unknown>) => PromiseLike<{ error: DbError }>;
  };
  auth: {
    admin: {
      updateUserById: (id: string, attrs: { password: string }) => PromiseLike<{ error: DbError }>;
    };
  };
}

export interface ResetOutcome {
  status: number;
  body: { success: true } | { error: string };
}

function auditRow(callerId: string, userId: string, eventType: string, description: string) {
  return {
    event_type: eventType,
    description,
    performed_by: callerId,
    related_entity_type: "profile",
    related_entity_id: userId,
  };
}

export async function adminResetPassword(
  adminClient: PasswordResetClient,
  callerId: string,
  userId: unknown,
  password: unknown,
): Promise<ResetOutcome> {
  if (typeof userId !== "string" || !userId || typeof password !== "string" || !password) {
    return { status: 400, body: { error: "user_id and password are required" } };
  }
  if (password.length < 8) {
    return { status: 400, body: { error: "Password must be at least 8 characters" } };
  }

  // entity_recipient profiles (migration 20260516090000) only receive commission
  // payouts and must never gain a usable login. A lookup error or a missing
  // profile refuses too: fail closed.
  const { data: target, error: lookupError } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (lookupError) {
    return { status: 500, body: { error: "Could not check that user. Password not changed." } };
  }
  if (!target) {
    return { status: 404, body: { error: "User not found. Password not changed." } };
  }
  if (target.role === "entity_recipient") {
    return { status: 403, body: { error: "Cannot reset password for service profiles" } };
  }

  const { error: auditError } = await adminClient
    .from("activity_feed")
    .insert(auditRow(callerId, userId, "user_password_reset", "Admin set a new password for this user"));
  if (auditError) {
    return { status: 500, body: { error: "Could not record the reset. Password not changed." } };
  }

  const { error: updateError } = await adminClient.auth.admin.updateUserById(userId, { password });
  if (updateError) {
    // Best effort: the request row is already written, so a failed second row
    // still leaves a record that a reset was attempted.
    await adminClient
      .from("activity_feed")
      .insert(auditRow(callerId, userId, "user_password_reset_failed", "Password reset failed in Auth; password not changed"));
    return { status: 400, body: { error: updateError.message } };
  }

  return { status: 200, body: { success: true } };
}
