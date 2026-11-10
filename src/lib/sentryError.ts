// A Supabase error is a plain object, so `new Error(String(err))` sent Sentry "[object Object]" (KI-115).
// Give it its own message instead (Mason, 2026-11-10: send the wording, figures blanked).
// Login tokens go first, whole, so blanking figures can never leave a token behind in pieces.
const TOKENS = [
  /eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g, // a whole JWT: header, payload and signature
  /\bBearer\s+[^\s"',;]+/gi,
  /\b\w*(?:token|code)(?:_hash)?=[^&#\s"',;]+/gi, // access_token=, refresh_token=, token_hash=, code=
];
// Amounts and invoice numbers: Sentry needs the reason, not the figures.
const FIGURES = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu;

function scrubMessage(text: string): string {
  return TOKENS.reduce((out, token) => out.replace(token, '[REDACTED]'), text).replace(FIGURES, '#');
}

export function toSentryError(err: unknown): Error {
  if (err instanceof Error) {
    const message = scrubMessage(err.message);
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
  return new Error(scrubMessage(message));
}
