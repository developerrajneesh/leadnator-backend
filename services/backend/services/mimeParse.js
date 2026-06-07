// Minimal RFC-822 / MIME parser — enough for inbound SES email (multipart,
// base64 / quoted-printable bodies, MIME encoded-word headers). Not a full
// implementation; attachments are ignored, we only extract text + html.

function nodeCharset(cs) {
  const c = String(cs || "utf-8").toLowerCase().replace(/["']/g, "").trim();
  if (c === "utf-8" || c === "utf8" || c === "us-ascii" || c === "ascii") return "utf8";
  if (c === "iso-8859-1" || c === "latin1" || c === "windows-1252" || c === "cp1252") return "latin1";
  if (c === "utf-16" || c === "utf-16le") return "utf16le";
  return "utf8";
}

function decodeBase64(data, cs) {
  return Buffer.from(String(data).replace(/\s+/g, ""), "base64").toString(nodeCharset(cs));
}

function decodeQuotedPrintable(input, cs) {
  const cleaned = String(input).replace(/=\r?\n/g, ""); // soft line breaks
  const bytes = [];
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(cleaned.substr(i + 1, 2))) {
      bytes.push(parseInt(cleaned.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(cleaned.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString(nodeCharset(cs));
}

function decodeBody(body, encoding, charset) {
  const enc = String(encoding || "7bit").toLowerCase();
  if (enc === "base64") return decodeBase64(body, charset);
  if (enc === "quoted-printable") return decodeQuotedPrintable(body, charset);
  return Buffer.from(body, "binary").toString(nodeCharset(charset));
}

// Decode MIME "encoded-words" in header values: =?charset?B?..?= / =?charset?Q?..?=
function decodeHeaderWords(value = "") {
  return String(value).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    try {
      if (enc.toUpperCase() === "B") return decodeBase64(txt, cs);
      return decodeQuotedPrintable(txt.replace(/_/g, " "), cs);
    } catch { return txt; }
  });
}

// Split a raw block into { headerText, body }.
function splitHeaderBody(raw) {
  const idx = raw.search(/\r?\n\r?\n/);
  if (idx === -1) return { headerText: raw, body: "" };
  const sep = raw.slice(idx).match(/^\r?\n\r?\n/)[0];
  return { headerText: raw.slice(0, idx), body: raw.slice(idx + sep.length) };
}

// Parse header block into a lowercase-keyed map (unfolds continuation lines).
function parseHeaders(headerText) {
  const out = {};
  const lines = String(headerText).split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    if (/^\s/.test(line) && cur) {
      out[cur] += " " + line.trim();
    } else {
      const m = line.match(/^([!-9;-~]+):\s?(.*)$/);
      if (m) { cur = m[1].toLowerCase(); out[cur] = (out[cur] ? out[cur] + ", " : "") + m[2]; }
    }
  }
  return out;
}

function parseContentType(value = "") {
  const v = String(value);
  const type = (v.split(";")[0] || "").trim().toLowerCase();
  const boundary = (v.match(/boundary\s*=\s*"?([^";]+)"?/i) || [])[1] || "";
  const charset = (v.match(/charset\s*=\s*"?([^";]+)"?/i) || [])[1] || "utf-8";
  return { type, boundary, charset };
}

// Recursively walk a MIME part, collecting text/plain and text/html into `acc`.
function walkPart(raw, acc) {
  const { headerText, body } = splitHeaderBody(raw);
  const headers = parseHeaders(headerText);
  const ct = parseContentType(headers["content-type"] || "text/plain");
  const enc = headers["content-transfer-encoding"] || "7bit";

  if (ct.type.startsWith("multipart/") && ct.boundary) {
    const delim = `--${ct.boundary}`;
    const segments = body.split(delim);
    // segments[0] is preamble; last is closing "--\n"
    for (let i = 1; i < segments.length; i++) {
      let seg = segments[i];
      if (seg.startsWith("--")) break; // closing boundary
      seg = seg.replace(/^\r?\n/, "");
      walkPart(seg, acc);
    }
    return;
  }

  const decoded = decodeBody(body, enc, ct.charset);
  if (ct.type === "text/html" && !acc.html) acc.html = decoded;
  else if (ct.type === "text/plain" && !acc.text) acc.text = decoded;
  else if (!acc.text && ct.type.startsWith("text/")) acc.text = decoded;
}

// Pull just the address out of a "Name <addr@x>" header value.
function extractEmail(value = "") {
  const m = String(value).match(/<([^>]+)>/);
  const addr = (m ? m[1] : String(value)).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : "";
}
function extractName(value = "") {
  const v = decodeHeaderWords(String(value)).trim();
  const m = v.match(/^("?)(.*?)\1\s*<[^>]+>$/);
  return (m ? m[2] : "").trim();
}
function splitAddresses(value = "") {
  return String(value).split(",").map((s) => extractEmail(s)).filter(Boolean);
}

// Main entry — returns the fields the mailbox needs.
function parseEmail(raw) {
  const text = String(raw || "");
  const { headerText } = splitHeaderBody(text);
  const headers = parseHeaders(headerText);
  const acc = { text: "", html: "" };
  try { walkPart(text, acc); } catch { /* best effort */ }

  return {
    from: extractEmail(headers["from"]),
    fromName: extractName(headers["from"]),
    to: splitAddresses(headers["to"]),
    cc: splitAddresses(headers["cc"]),
    subject: decodeHeaderWords(headers["subject"] || "").trim(),
    messageId: (headers["message-id"] || "").trim(),
    inReplyTo: (headers["in-reply-to"] || "").trim(),
    date: headers["date"] ? new Date(headers["date"]) : null,
    text: acc.text || "",
    html: acc.html || "",
  };
}

module.exports = { parseEmail };
