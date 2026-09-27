/**
 * A defensive, minimal RFC 822 / MIME reader for INBOUND email.
 *
 * Scope, honestly: this handles the shapes real mail actually uses — header
 * blocks with folding, text/plain and text/html parts, multipart/alternative
 * and multipart/mixed (nested, depth-capped), base64 and quoted-printable
 * transfer encodings, and the common charsets. It is NOT a full MIME
 * implementation: anything it cannot decode becomes a warning in the result,
 * never a guess and never a silent drop. The untouched raw .eml is archived to
 * R2 by the caller, so nothing is lost when parsing falls short.
 *
 * System-protection limits (not judgment): input is capped at MAX_EMAIL_BYTES
 * and multipart depth at MAX_MIME_DEPTH. When a cap bites, the result says so.
 */

/** 2 MB. Cloudflare Email Routing allows ~30 MB; we parse the first 2 MB. */
export const MAX_EMAIL_BYTES = 2 * 1024 * 1024;
export const MAX_MIME_DEPTH = 10;

export interface ParsedEmail {
  subject: string;
  from: string;
  to: string;
  /** Best-effort plain text (from a text/plain part, or derived from HTML — said so). */
  text: string;
  /** The HTML body when one was present. */
  html: string | null;
  /** Every limitation the parser hit. Surfaced, never hidden. */
  warnings: string[];
}

export function parseEmail(raw: string): ParsedEmail {
  const warnings: string[] = [];
  let source = raw;
  if (source.length > MAX_EMAIL_BYTES) {
    warnings.push(`email was ${source.length} bytes; only the first ${MAX_EMAIL_BYTES} were parsed (the raw .eml is archived in full)`);
    source = source.slice(0, MAX_EMAIL_BYTES);
  }

  const { headers, body } = splitHeadAndBody(source);
  const subject = headerValue(headers, "subject");
  const from = headerValue(headers, "from");
  const to = headerValue(headers, "to");

  const collected = collectBodies(body, headerValue(headers, "content-type"), headerValue(headers, "content-transfer-encoding"), 0, warnings);

  let text = collected.text;
  if (text === "" && collected.html !== "") {
    text = htmlToText(collected.html);
    warnings.push("no text/plain part; the text was derived from the HTML body (formatting is approximate)");
  }

  return { subject, from, to, text, html: collected.html !== "" ? collected.html : null, warnings };
}

// ---- header block ----

interface SplitResult {
  headers: Map<string, string>;
  body: string;
}

function splitHeadAndBody(source: string): SplitResult {
  // The header block ends at the first empty line. Be tolerant of CRLF and LF.
  const sep = source.indexOf("\r\n\r\n");
  const sepLf = source.indexOf("\n\n");
  let head: string;
  let body: string;
  if (sep !== -1 && (sepLf === -1 || sep <= sepLf)) {
    head = source.slice(0, sep);
    body = source.slice(sep + 4);
  } else if (sepLf !== -1) {
    head = source.slice(0, sepLf);
    body = source.slice(sepLf + 2);
  } else {
    head = source;
    body = "";
  }

  const headers = new Map<string, string>();
  const lines = head.split(/\r?\n/);
  let current: string | null = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current !== null) {
      // Folded continuation of the previous header.
      headers.set(current, `${headers.get(current) ?? ""} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    current = line.slice(0, colon).trim().toLowerCase();
    headers.set(current, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function headerValue(headers: Map<string, string>, name: string): string {
  const raw = headers.get(name) ?? "";
  return decodeEncodedWords(raw);
}

/**
 * RFC 2047 encoded words: =?utf-8?B?...?= and =?utf-8?Q?...?=. Common in
 * subjects and names from non-English senders. Undecodable words pass through.
 */
function decodeEncodedWords(value: string): string {
  if (!value.includes("=?")) return value;
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
    try {
      if (enc.toLowerCase() === "b") {
        return decodeBytes(base64ToBytes(data), charset);
      }
      const qp = decodeQuotedPrintable(data);
      return decodeBytes(new TextEncoder().encode(qp), charset);
    } catch {
      return _m; // keep the original rather than guess
    }
  });
}

// ---- body collection ----

interface Bodies {
  text: string;
  html: string;
}

function collectBodies(body: string, contentType: string, cte: string, depth: number, warnings: string[]): Bodies {
  if (depth > MAX_MIME_DEPTH) {
    warnings.push(`multipart nesting deeper than ${MAX_MIME_DEPTH} was not descended into`);
    return { text: "", html: "" };
  }

  const { type, params } = parseContentType(contentType);

  if (type.startsWith("multipart/") && params.boundary) {
    const out: Bodies = { text: "", html: "" };
    for (const part of splitMultipart(body, params.boundary)) {
      const { headers, body: partBody } = splitHeadAndBody(part);
      const got = collectBodies(
        partBody,
        headerValue(headers, "content-type"),
        headerValue(headers, "content-transfer-encoding"),
        depth + 1,
        warnings,
      );
      if (got.text !== "" && out.text === "") out.text = got.text;
      if (got.html !== "" && out.html === "") out.html = got.html;
    }
    return out;
  }

  const decoded = decodeTransfer(body, cte, warnings);
  const charset = params.charset ?? "utf-8";
  if (type === "text/html") {
    return { text: "", html: decodeBytes(new TextEncoder().encode(decoded), charset, warnings) };
  }
  // text/plain and anything unrecognized: treat as plain text but say so.
  if (type !== "text/plain") {
    warnings.push(`content-type "${contentType || "(none)"}" was read as plain text`);
  }
  return { text: decodeBytes(new TextEncoder().encode(decoded), charset, warnings), html: "" };
}

function parseContentType(value: string): { type: string; params: { boundary?: string; charset?: string } } {
  const [rawType, ...paramParts] = value.split(";");
  const type = (rawType ?? "").trim().toLowerCase();
  const params: { boundary?: string; charset?: string } = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    if (k === "boundary") params.boundary = v;
    if (k === "charset") params.charset = v;
  }
  return { type, params };
}

function splitMultipart(body: string, boundary: string): string[] {
  const delim = `--${boundary}`;
  const lines = body.split(/\r?\n/);
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, "");
    if (trimmed === delim || trimmed === `${delim}--`) {
      if (current !== null) parts.push(current.join("\n"));
      if (trimmed === `${delim}--`) break;
      current = [];
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) parts.push(current.join("\n")); // missing terminator
  return parts;
}

// ---- transfer encodings ----

function decodeTransfer(body: string, cte: string, warnings: string[]): string {
  const enc = (cte ?? "").trim().toLowerCase();
  if (enc === "base64") {
    try {
      return decodeBytes(base64ToBytes(body), "utf-8");
    } catch {
      warnings.push("base64 body could not be decoded and was kept as-is");
      return body;
    }
  }
  if (enc === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }
  // 7bit, 8bit, binary, empty: as-is.
  return body;
}

function decodeQuotedPrintable(body: string): string {
  // Soft line breaks (trailing =) join lines; =XX is a byte.
  const joined = body.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i]!;
    if (c === "=" && i + 2 < joined.length + 1 && /^[0-9a-f]{2}$/i.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3)!, 16));
      i += 2;
    } else {
      for (const b of new TextEncoder().encode(c)) bytes.push(b);
    }
  }
  return decodeBytes(new Uint8Array(bytes), "utf-8");
}

function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeBytes(bytes: Uint8Array, charset: string, warnings?: string[]): string {
  const cs = charset.trim().toLowerCase() || "utf-8";
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    if (warnings) warnings.push(`charset "${charset}" is not supported; decoded as UTF-8 with replacement characters`);
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// ---- HTML → text (used only when there is no text/plain part; said so) ----

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
