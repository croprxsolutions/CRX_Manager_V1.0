import { activateNewUser, activationKeyFor, type RpcClientLike } from "./logic.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      message ?? `Expected ${expectedJson}, received ${actualJson}`,
    );
  }
}

type RpcReply = { data: unknown; error: { message: string } | null };

function fakeClient(reply: RpcReply | (() => never)) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClientLike = {
    rpc(fn, args) {
      calls.push({ fn, args });
      if (typeof reply === "function") return reply();
      return Promise.resolve(reply);
    },
  };
  return { client, calls };
}

const USER = "11111111-2222-3333-4444-555555555555";

Deno.test("activates through admin_update_profile with the chosen name, role and phone", async () => {
  const { client, calls } = fakeClient({ data: { success: true }, error: null });
  const result = await activateNewUser(client, {
    userId: USER,
    fullName: "Jane Doe",
    role: "applicator",
    phone: "555-0100",
  });
  assertEquals(result, null);
  assertEquals(calls, [{
    fn: "admin_update_profile",
    args: {
      target_user_id: USER,
      new_role: "applicator",
      new_full_name: "Jane Doe",
      new_phone: "555-0100",
      new_is_active: true,
      p_idempotency_key: `create-user-activate:${USER}`,
    },
  }]);
});

Deno.test("an empty phone is sent as null, never as an empty string", async () => {
  const { client, calls } = fakeClient({ data: { success: true }, error: null });
  await activateNewUser(client, { userId: USER, fullName: "A", role: "driver", phone: "" });
  assertEquals(calls[0].args.new_phone, null);
});

Deno.test("the retry key is tied to the new user, so it differs per user", () => {
  assertEquals(activationKeyFor(USER) === activationKeyFor("other"), false);
  assertEquals(activationKeyFor(USER), activationKeyFor(USER));
});

Deno.test("a database error is reported, not swallowed", async () => {
  const { client } = fakeClient({
    data: null,
    error: { message: 'duplicate key value violates unique constraint "uq_profiles_full_name"' },
  });
  const result = await activateNewUser(client, { userId: USER, fullName: "A", role: "driver" });
  assertEquals(result, 'duplicate key value violates unique constraint "uq_profiles_full_name"');
});

Deno.test("an error result from the function is reported", async () => {
  const { client } = fakeClient({ data: { error: "Active admin access required" }, error: null });
  const result = await activateNewUser(client, { userId: USER, fullName: "A", role: "driver" });
  assertEquals(result, "Active admin access required");
});

Deno.test("anything but an explicit success counts as not activated", async () => {
  for (const data of [{}, { success: "true" }, { success: false }]) {
    const { client } = fakeClient({ data, error: null });
    const result = await activateNewUser(client, { userId: USER, fullName: "A", role: "driver" });
    assertEquals(result, "Activation returned no result", `data ${JSON.stringify(data)}`);
  }
  const { client } = fakeClient({ data: null, error: null });
  const result = await activateNewUser(client, { userId: USER, fullName: "A", role: "driver" });
  assertEquals(result, "admin_update_profile returned no data");
});

Deno.test("a thrown network error is reported, never thrown on", async () => {
  const { client } = fakeClient(() => {
    throw new Error("fetch failed");
  });
  const result = await activateNewUser(client, { userId: USER, fullName: "A", role: "driver" });
  assertEquals(result, "fetch failed");
});
