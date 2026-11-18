import { adminResetPassword, type PasswordResetClient } from "./passwordReset.ts";

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(message ?? `Expected ${e}, received ${a}`);
}

type Opts = {
  profile?: { data: { role?: string | null } | null; error: { message: string } | null };
  insertErrors?: Array<{ message: string } | null>;
  authError?: { message: string } | null;
};

function fake(opts: Opts = {}) {
  const log: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  let insertCall = 0;
  const client: PasswordResetClient = {
    from(table) {
      return {
        select: () => ({
          eq: (_c, v) => ({
            maybeSingle: () => {
              log.push(`lookup:${table}:${v}`);
              return Promise.resolve(opts.profile ?? { data: { role: "sales_rep" }, error: null });
            },
          }),
        }),
        insert: (row) => {
          log.push(`insert:${table}:${row.event_type}`);
          rows.push(row);
          return Promise.resolve({ error: opts.insertErrors?.[insertCall++] ?? null });
        },
      };
    },
    auth: {
      admin: {
        updateUserById: (id) => {
          log.push(`auth:${id}`);
          return Promise.resolve({ error: opts.authError ?? null });
        },
      },
    },
  };
  return { client, log, rows };
}

const ADMIN = "aaaaaaaa-0000-0000-0000-000000000001";
const TARGET = "bbbbbbbb-0000-0000-0000-000000000002";

Deno.test("writes the audit row naming the verified admin before changing the password", async () => {
  const { client, log, rows } = fake();
  const out = await adminResetPassword(client, ADMIN, TARGET, "longenough");
  assertEquals(out, { status: 200, body: { success: true } });
  assertEquals(log, [`lookup:profiles:${TARGET}`, "insert:activity_feed:user_password_reset", `auth:${TARGET}`]);
  assertEquals(rows[0].performed_by, ADMIN);
  assertEquals(rows[0].related_entity_type, "profile");
  assertEquals(rows[0].related_entity_id, TARGET);
});

Deno.test("refuses without changing the password when the audit row cannot be written", async () => {
  const { client, log } = fake({ insertErrors: [{ message: "denied" }] });
  const out = await adminResetPassword(client, ADMIN, TARGET, "longenough");
  assertEquals(out.status, 500);
  assertEquals(log.some((l) => l.startsWith("auth:")), false);
});

Deno.test("fails closed when the target lookup errors or finds nobody", async () => {
  for (const profile of [{ data: null, error: { message: "boom" } }, { data: null, error: null }]) {
    const { client, log } = fake({ profile });
    const out = await adminResetPassword(client, ADMIN, TARGET, "longenough");
    assertEquals(out.status === 500 || out.status === 404, true);
    assertEquals(log.length, 1, "no insert and no Auth call");
  }
});

Deno.test("refuses entity_recipient payout profiles", async () => {
  const { client, log } = fake({ profile: { data: { role: "entity_recipient" }, error: null } });
  const out = await adminResetPassword(client, ADMIN, TARGET, "longenough");
  assertEquals(out.status, 403);
  assertEquals(log.length, 1);
});

Deno.test("records a failed row when Auth refuses the change", async () => {
  const { client, log } = fake({ authError: { message: "weak password" } });
  const out = await adminResetPassword(client, ADMIN, TARGET, "longenough");
  assertEquals(out, { status: 400, body: { error: "weak password" } });
  assertEquals(log[log.length - 1], "insert:activity_feed:user_password_reset_failed");
});

Deno.test("validates input before touching anything", async () => {
  for (const [id, pw] of [[undefined, "longenough"], [TARGET, ""], [TARGET, "short"], [TARGET, 12345678]]) {
    const { client, log } = fake();
    const out = await adminResetPassword(client, ADMIN, id, pw);
    assertEquals(out.status, 400);
    assertEquals(log.length, 0);
  }
});
