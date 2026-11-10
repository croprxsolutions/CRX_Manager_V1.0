// A Supabase error is a plain object, so `new Error(String(err))` sent Sentry "[object Object]" (KI-115).
// Keep real Errors as they are; give anything else its own message.
export function toSentryError(err: unknown): Error {
  if (err instanceof Error) return err;
  const message = typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : String(err);
  return new Error(message);
}
