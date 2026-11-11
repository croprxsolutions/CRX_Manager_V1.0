// eslint-disable-next-line no-restricted-imports
import * as Sentry from '@sentry/react';
// eslint-disable-next-line no-restricted-imports
import type { Event, StackFrame } from '@sentry/react';
import { toSentryError } from './sentryError';

// Network errors that aren't bugs
const NETWORK_ERRORS = ['Failed to fetch', 'NetworkError', 'Load failed'];
// The whole message is a browser fetch failure (supabase-js adds "TypeError: " and " (host)"),
// so a database error that merely mentions fetching is kept.
const NETWORK_BLIP = /^(?:TypeError: )?(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)(?: \([^)]*\))?$/;

// Query strings and fragments carry filter values, login tokens and one-time codes.
const pathOnly = (url: string | undefined) => url?.replace(/[?#].*$/s, '');
// The one free text Sentry gets (Mason, 2026-11-10): tokens removed whole, then figures blanked.
const scrub = (text: string | undefined) => (text === undefined ? undefined : toSentryError(text).message);

// Supabase errors are plain objects: Sentry titles them "Object captured as exception"
// and ignoreErrors never sees their message, so read it here.
function plainErrorMessage(original: unknown): string | null {
  if (typeof original !== 'object' || original === null || original instanceof Error) return null;
  const { message } = original as { message?: unknown };
  return typeof message === 'string' && message !== '' ? message : null;
}

function safeFrame(frame: StackFrame): StackFrame {
  return {
    filename: pathOnly(frame.filename),
    abs_path: pathOnly(frame.abs_path),
    function: frame.function,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
  };
}

// Mason, 2026-11-10 (DECISION_LOG, option B): Sentry gets only fields known to be safe, built
// fresh. Everything else (extra, other contexts, request query, headers and cookies, the
// serialized copy of a plain object, breadcrumb messages and data) never leaves the browser.
// The error and message text is the only free text kept, scrubbed by toSentryError.
function safeEvent<T extends Event>(event: T): T {
  const trace = event.contexts?.trace;
  const meta = event.sdkProcessingMetadata;
  const dsc = meta?.dynamicSamplingContext;
  const safe: Event = {
    type: event.type,
    event_id: event.event_id,
    timestamp: event.timestamp,
    start_timestamp: event.start_timestamp,
    platform: event.platform,
    level: event.level,
    release: event.release,
    dist: event.dist,
    environment: event.environment,
    sdk: event.sdk,
    tags: event.tags,
    user: event.user?.id === undefined ? undefined : { id: event.user.id },
    transaction: pathOnly(event.transaction),
    transaction_info: event.transaction_info && { source: event.transaction_info.source },
    message: scrub(event.message),
    exception: event.exception && {
      values: event.exception.values?.map((value) => ({
        type: value.type,
        value: scrub(value.value),
        mechanism: value.mechanism && {
          type: value.mechanism.type,
          handled: value.mechanism.handled,
          synthetic: value.mechanism.synthetic,
          source: value.mechanism.source,
          exception_id: value.mechanism.exception_id,
          parent_id: value.mechanism.parent_id,
        },
        stacktrace: value.stacktrace && { frames: value.stacktrace.frames?.map(safeFrame) },
      })),
    },
    breadcrumbs: event.breadcrumbs?.map((crumb) => ({
      type: crumb.type,
      category: crumb.category,
      level: crumb.level,
      timestamp: crumb.timestamp,
    })),
    contexts: trace && {
      trace: {
        trace_id: trace.trace_id,
        span_id: trace.span_id,
        parent_span_id: trace.parent_span_id,
        op: trace.op,
        status: trace.status,
        origin: trace.origin,
      },
    },
    spans: event.spans?.map((span) => ({
      data: {},
      span_id: span.span_id,
      trace_id: span.trace_id,
      parent_span_id: span.parent_span_id,
      start_timestamp: span.start_timestamp,
      timestamp: span.timestamp,
      op: span.op,
      status: span.status,
      origin: span.origin,
      description: pathOnly(span.description),
    })),
    measurements: event.measurements,
    // Source-map ids only: lets Sentry show the real file and line.
    debug_meta: event.debug_meta && {
      images: event.debug_meta.images?.flatMap((image) => (image.type === 'sourcemap'
        ? [{ type: 'sourcemap' as const, code_file: pathOnly(image.code_file) ?? '', debug_id: image.debug_id }]
        : [])),
    },
    request: event.request?.url ? { url: pathOnly(event.request.url) } : undefined,
    // Never sent (the SDK deletes it); it carries the trace header and live SDK objects.
    sdkProcessingMetadata: meta && {
      ...meta,
      // The trace header Sentry sends with the event: listed fields only.
      dynamicSamplingContext: dsc && {
        trace_id: dsc.trace_id,
        public_key: dsc.public_key,
        sample_rate: dsc.sample_rate,
        sample_rand: dsc.sample_rand,
        sampled: dsc.sampled,
        release: dsc.release,
        environment: dsc.environment,
        org_id: dsc.org_id,
        transaction: pathOnly(dsc.transaction),
      },
    },
  };
  return safe as T;
}

export function initSentry() {
  // Only init in production (VITE_SENTRY_DSN must be set)
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Only send errors in production
    enabled: import.meta.env.PROD,
    // Sample 100% of errors, 10% of transactions for performance
    sampleRate: 1.0,
    tracesSampleRate: 0.1,
    // Filter out noisy errors
    ignoreErrors: [
      'ResizeObserver loop',
      'ResizeObserver loop completed with undelivered notifications',
      'Non-Error promise rejection captured',
      ...NETWORK_ERRORS,
    ],
    beforeSend(event, hint) {
      const plain = plainErrorMessage(hint?.originalException);
      if (plain !== null) {
        if (NETWORK_BLIP.test(plain)) return null;
        const first = event.exception?.values?.[0];
        if (first) first.value = plain;
      }
      return safeEvent(event);
    },
    // Performance samples carry span names and urls too.
    beforeSendTransaction(event) {
      return safeEvent(event);
    },
  });
}

// Re-export for use in components
export { Sentry };
