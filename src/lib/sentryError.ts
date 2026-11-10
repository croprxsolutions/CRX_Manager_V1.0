// A Supabase error is a plain object, so `new Error(String(err))` sent Sentry "[object Object]" (KI-115).
// Give it its own message instead. Messages can quote amounts and invoice numbers (e.g. an allocation
// above a balance): Sentry needs the reason, not the figures, so every run of digits becomes "#".
const blankFigures = (text: string) => text.replace(/\d+(?:[.,]\d+)*/g, '#');

export function toSentryError(err: unknown): Error {
  if (err instanceof Error) {
    const message = blankFigures(err.message);
    if (message === err.message) return err;
    const blanked = new Error(message);
    blanked.name = err.name;
    // Keep where it was thrown; the stack's first line repeats the message (split/join: no `$&` patterns).
    if (err.stack) blanked.stack = err.stack.split(err.message).join(message);
    // Sentry reports the underlying cause as a linked error.
    if ('cause' in err) Object.assign(blanked, { cause: (err as { cause?: unknown }).cause });
    return blanked;
  }
  const message = typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : String(err);
  return new Error(blankFigures(message));
}
