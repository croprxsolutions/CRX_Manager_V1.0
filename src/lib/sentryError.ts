// A Supabase error is a plain object, so `new Error(String(err))` sent Sentry "[object Object]" (KI-115).
// Keep real Errors as they are; give anything else its own message.
// Database messages can quote amounts and invoice numbers (e.g. an allocation above a balance):
// Sentry needs the reason, not the figures, so every run of digits becomes "#".
export function toSentryError(err: unknown): Error {
  if (err instanceof Error) return err;
  const message = typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : String(err);
  return new Error(message.replace(/\d+(?:[.,]\d+)*/g, '#'));
}
