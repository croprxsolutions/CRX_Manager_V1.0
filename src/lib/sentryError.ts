// A Supabase error is a plain object, so `new Error(String(err))` sent Sentry "[object Object]" (KI-115).
// Give it its own message instead (Mason, 2026-11-10: send the wording, figures blanked).
// Login tokens go first, whole, so blanking figures can never leave a token behind in pieces.
const TOKENS = [
  /eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g, // a whole JWT: header, payload and signature
  /\bBearer\s+[^\s"',;]+/gi,
  /\b\w+=[^&#\s"',;]+/g, // any name=value (access_token, code_verifier, ...): no guessing which names are secret
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
    // Keep where it was thrown. Only the first line repeats the message; the frames stay as they are.
    // The cause is not copied: its text would reach Sentry unscrubbed.
    const head = `${err.name}: ${err.message}`;
    if (err.stack?.startsWith(head)) blanked.stack = `${err.name}: ${message}${err.stack.slice(head.length)}`;
    // Firefox and Safari stacks hold frames only.
    else if (err.stack && !err.stack.includes(err.message)) blanked.stack = err.stack;
    return blanked;
  }
  const message = typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : String(err);
  return new Error(scrubMessage(message));
}
