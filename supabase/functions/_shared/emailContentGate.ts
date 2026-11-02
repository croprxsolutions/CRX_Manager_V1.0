// =============================================================================
// Email content gate (audit finding 7, 2026-11-02)
//
// The browser still writes each email's subject and HTML, so send-email refuses
// anything beyond plain formatting: no scripts, styles, forms or frames, and
// links/images only to hosts our own templates use. It refuses rather than
// rewrites, so what is logged in email_log is exactly what was sent.
//
// Pure, with no Deno or Supabase imports, so the app's Vitest suite tests it
// directly (src/lib/emailContentGate.test.ts) against the real email builders.
// =============================================================================

const ALLOWED_TAGS = new Set([
  "html", "head", "meta", "body",
  "table", "thead", "tbody", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "p", "br", "hr", "div", "span",
  "strong", "b", "em", "i", "u", "small", "ul", "ol", "li",
  "a", "img",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "style", "width", "height", "align", "valign", "cellpadding", "cellspacing",
  "border", "colspan", "rowspan", "bgcolor", "alt", "href", "src",
  "charset", "name", "content",
]);

// The field-map snapshot and its live-map link (src/lib/proofNotification.ts),
// plus our own site.
const ALLOWED_URL_HOSTS = new Set([
  "croprxsolutions.app",
  "www.croprxsolutions.app",
  "staticmap.openstreetmap.de",
  "www.openstreetmap.org",
]);

const MAX_SUBJECT_LENGTH = 200;
const MAX_HTML_LENGTH = 200_000;

// Sticky (y) regexes are matched at one position, so the scan stays linear.
const DOCTYPE = /<!DOCTYPE html>/iy;
const COMMENT = /<!--[^<>[\]]*-->/y;
// Every attribute value must be quoted and free of < and >. Only HTML's own
// whitespace (never JS \s, which also matches Unicode spaces) separates
// attributes, so this parse and a mail client's parse always agree.
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[\t\n\f\r ]+[a-zA-Z-]+(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"[^"<>]*"|'[^'<>]*'))?)*)[\t\n\f\r ]*\/?>/y;
const ATTRIBUTE = /([a-zA-Z-]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'))?/g;
// Entities, quotes and comments are refused outright: a mail client decodes or
// strips them before reading the CSS.
const UNSAFE_STYLE = /url|image|expression|@import|javascript|\\|&|"|'|\/\*/i;

function urlProblem(value: string): string | null {
  // escapeHtml turns & into &amp;; any other entity could hide a scheme.
  if (/&(?!amp;)/.test(value)) return "Email link contains an encoded character";
  let url: URL;
  try {
    url = new URL(value.replace(/&amp;/g, "&"));
  } catch {
    return "Email link is not a full web address";
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !ALLOWED_URL_HOSTS.has(url.hostname)) {
    return `Email links and images may only point to ${[...ALLOWED_URL_HOSTS].join(", ")}`;
  }
  return null;
}

/** Why this subject + HTML body may not be sent, or null when it may. */
export function emailContentProblem(subject: string, html: string): string | null {
  // deno-lint-ignore no-control-regex
  if (!subject.trim() || subject.length > MAX_SUBJECT_LENGTH || /[\u0000-\u001f\u007f]/.test(subject)) {
    return `Email subject must be one line of plain text, at most ${MAX_SUBJECT_LENGTH} characters`;
  }
  if (html.length > MAX_HTML_LENGTH) return "Email body is too large";

  let at = html.indexOf("<");
  while (at !== -1) {
    let end = -1;
    for (const literal of [DOCTYPE, COMMENT]) {
      literal.lastIndex = at;
      if (literal.test(html)) end = literal.lastIndex;
    }
    if (end === -1) {
      TAG.lastIndex = at;
      const tag = TAG.exec(html);
      if (!tag) return "Email body contains markup the server cannot verify";
      const name = tag[2].toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return `Email body may not contain <${name}>`;
      for (const attribute of tag[3].matchAll(ATTRIBUTE)) {
        const attributeName = attribute[1].toLowerCase();
        const value = attribute[2] ?? attribute[3] ?? "";
        if (!ALLOWED_ATTRIBUTES.has(attributeName)) {
          return `Email body may not use the ${attributeName} attribute`;
        }
        if (attributeName === "href" || attributeName === "src") {
          const problem = urlProblem(value);
          if (problem) return problem;
        }
        if (attributeName === "style" && UNSAFE_STYLE.test(value)) {
          return "Email body style may not load or run anything";
        }
      }
      end = TAG.lastIndex;
    }
    at = html.indexOf("<", end);
  }
  return null;
}

/** Why this attachment may not be sent, or null when it is a plainly named PDF. */
export function attachmentProblem(filename: unknown, content: unknown): string | null {
  // deno-lint-ignore no-control-regex
  if (typeof filename !== "string" || !/^[^\\/:*?"<>|\u0000-\u001f]{1,150}\.pdf$/i.test(filename)) {
    return "Each attachment must be a PDF with a plain file name";
  }
  // "%PDF-" encodes to "JVBERi0" in base64. Only the file type is checked: a valid
  // PDF can say anything, so parsing it deeper would add no safety.
  if (typeof content !== "string" || !content.startsWith("JVBERi0") ||!/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    return "Each attachment must be a base64 PDF";
  }
  return null;
}
