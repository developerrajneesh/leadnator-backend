// Executes an autopilot workflow against an inbound webhook payload and returns
// a per-node execution trace (what ran, the input payload it saw, and the
// output/response it produced). The trace is stored on the call log so the
// builder's "Execution log" can show exactly what happened at each node.
//
// Data/logic nodes run for real:
//   • field_mapper  — renames fields on the flowing payload
//   • condition     — evaluates field/op/value and follows the yes/no branch
//   • call_webhook  — POSTs the payload to the configured URL (records response)
//   • run_js        — runs the script in a vm2 sandbox (records return value)
//   • wait.delay    — recorded as planned (not actually blocking)
// Integration actions (email/whatsapp/crm) are LOGGED with their resolved
// config but not dispatched here — a raw webhook run has no lead context.

const axios = require("axios");
const { VM } = require("vm2");
const EmailConfig = require("../models/EmailConfig");
const EmailMessage = require("../models/EmailMessage");
const Lead = require("../models/Lead");
const { sendViaSes, sesReady, resolveSender } = require("./sesSend");
const { emitToUser } = require("./socket");

const isBranch = (t) => t === "condition.if_else";

// Wait helpers. setTimeout caps at ~24.8 days (32-bit ms); enough for
// minutes/hours/days. Note: timers are in-memory — a server restart drops
// pending waits, and serverless (Vercel) won't run them after the response.
const MAX_TIMER_MS = 2147483647;
function waitDurationMs(c = {}) {
  const amt = Math.max(0, Number(c.amount || 0));
  const unit = c.unit || "minutes";
  const mult = unit === "days" ? 86400000 : unit === "hours" ? 3600000 : 60000;
  return amt * mult;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, MAX_TIMER_MS)));
}

// Resolve a possibly-nested value from the payload. Supports:
//   • flat keys        → "email"
//   • dotted paths     → "data.email"
//   • array indexes    → "data.source[0]"  or  "data.source.0"
// Returns undefined if any segment along the way is missing.
function getByPath(obj, path) {
  if (obj == null || path == null || path === "") return undefined;
  // A literal top-level key wins first (covers keys that contain dots/brackets).
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  const parts = String(path)
    .replace(/\[(\w+)\]/g, ".$1")   // data.source[0] → data.source.0
    .split(".")
    .filter((p) => p !== "");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Resolve a value from the payload given a config spec — supports a {{template}},
// a dotted path ("contact.email"), a direct key ("email"), and a list of
// fallback candidate keys (auto-detect when the user left the field blank).
function resolveValue(spec, payload, candidates, interp) {
  const v = String(spec || "").trim();
  if (v) {
    if (/\{\{/.test(v)) { const r = interp(v, payload).trim(); if (r) return r; }
    const direct = payload?.[v];
    if (direct != null && String(direct).trim()) return String(direct).trim();
    if (v.includes(".") || v.includes("[")) {
      const cur = getByPath(payload, v);
      if (cur != null && String(cur).trim()) return String(cur).trim();
    }
  }
  for (const cand of candidates || []) {
    if (payload?.[cand] != null && String(payload[cand]).trim()) return String(payload[cand]).trim();
  }
  return "";
}

// Resolve the recipient email from the configured key. Supports a plain
// payload key ("email"), a {{template}}, a dotted path ("contact.email"),
// or a literal email address.
function resolveRecipient(to, payload, interp) {
  const v = String(to || "").trim();
  if (!v) return "";
  if (/\{\{/.test(v)) return interp(v, payload).trim();
  const direct = payload?.[v];
  if (direct != null && String(direct).includes("@")) return String(direct).trim();
  if (v.includes(".") || v.includes("[")) {
    const cur = getByPath(payload, v);
    if (cur != null && String(cur).includes("@")) return String(cur).trim();
  }
  if (v.includes("@")) return v;
  return direct != null ? String(direct).trim() : "";
}

function clone(o) {
  try { return JSON.parse(JSON.stringify(o ?? {})); } catch { return {}; }
}
function interp(str, vars) {
  // Supports {{email}}, {{data.email}} and {{data.source[0]}} placeholders.
  return String(str == null ? "" : str).replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_, k) => {
    const v = getByPath(vars, k);
    return v != null ? String(v) : "";
  });
}
function stepOf(node, status, input, output, message) {
  return { nodeId: node.id, type: node.type, title: node.title || node.type, status, input, output, message };
}

function evalCondition(node, payload) {
  const c = node.config || {};
  const actual = getByPath(payload, c.field);
  switch (c.op) {
    case "not equals": return String(actual) !== String(c.value);
    case "contains":   return String(actual ?? "").includes(String(c.value ?? ""));
    case "is empty":   return actual == null || actual === "";
    case "equals":
    default:           return String(actual) === String(c.value);
  }
}

async function runNode(node, payload, ctx = {}) {
  const t = node.type;
  const c = node.config || {};
  const input = clone(payload);

  if (t === "action.send_email") {
    const cfg = ctx.emailCfg;
    const to = resolveRecipient(c.to, payload, interp);
    const subject = interp(c.subject, payload);
    const bodyRaw = interp(c.body, payload);
    if (!to) {
      return { step: stepOf(node, "error", input, { toField: c.to || "" }, `No recipient — couldn't find an email in payload field "${c.to || "(unset)"}"`) };
    }
    if (!sesReady(cfg)) {
      return { step: stepOf(node, "error", input, { to }, "No verified sending domain — set up Email → Config first") };
    }
    const html = /<[a-z][\s\S]*>/i.test(bodyRaw) ? bodyRaw : String(bodyRaw).replace(/\n/g, "<br/>");
    try {
      const info = await sendViaSes(cfg, { to, subject: subject || "(no subject)", html, senderId: c.senderId || undefined });
      const from = resolveSender(cfg, c.senderId);
      EmailMessage.create({
        user: ctx.owner, organization: ctx.organization || null,
        direction: "outbound", mailbox: from.email, counterparty: String(to).toLowerCase(),
        fromName: from.name || "", fromEmail: from.email, toEmails: [to],
        subject: subject || "(no subject)", html, messageId: info.messageId || "", read: true, ts: new Date(),
      }).then((m) => emitToUser(ctx.owner, "email.outbound", { message: m.toJSON() })).catch(() => {});
      return { step: stepOf(node, "ok", input, { to, from: from.email, messageId: info.messageId }, `Email sent → ${to}`) };
    } catch (err) {
      return { step: stepOf(node, "error", input, { to }, `Send failed: ${err.message}`) };
    }
  }

  if (t === "action.field_mapper") {
    const next = clone(payload);
    const applied = [];
    for (const m of c.mappings || []) {
      // `from` supports nested/array paths ("data.email", "data.source[0]");
      // `to` is the flat key downstream nodes (Create contact, Send email) read.
      if (m.from && m.to) { next[m.to] = getByPath(payload, m.from); applied.push(`${m.from} → ${m.to}`); }
    }
    return { payload: next, step: stepOf(node, "ok", input, next, applied.length ? `Mapped ${applied.join(", ")}` : "No field mappings set") };
  }

  if (t === "action.call_webhook") {
    const url = interp(c.url, payload);
    if (!url) return { step: stepOf(node, "error", input, null, "No URL configured") };
    try {
      const res = await axios.post(url, payload, { timeout: 8000, validateStatus: () => true });
      const ok = res.status >= 200 && res.status < 300;
      const body = typeof res.data === "string" ? res.data.slice(0, 2000) : res.data;
      return { step: stepOf(node, ok ? "ok" : "error", input, { status: res.status, body }, `POST ${url} → ${res.status}`) };
    } catch (err) {
      return { step: stepOf(node, "error", input, { error: err.message }, `Request failed: ${err.message}`) };
    }
  }

  if (t === "action.run_js") {
    const script = String(c.script || "").trim();
    if (!script) return { step: stepOf(node, "skipped", input, null, "No script configured") };
    try {
      const vm = new VM({ timeout: 1000, sandbox: { payload: clone(payload), body: clone(payload) } });
      const out = vm.run(`(function(payload, body){ ${script} })(payload, body)`);
      return { step: stepOf(node, "ok", input, out === undefined ? null : out, "Script ran") };
    } catch (err) {
      return { step: stepOf(node, "error", input, { error: err.message }, `JS error: ${err.message}`) };
    }
  }

  if (t === "action.create_contact") {
    const owner = ctx.owner;
    if (!owner) return { step: stepOf(node, "error", input, null, "No owner on this autopilot") };
    const email = resolveValue(c.emailField, payload, ["email", "Email", "email_address", "emailId", "user_email", "contact_email"], interp);
    const name  = resolveValue(c.nameField,  payload, ["name", "Name", "full_name", "fullName", "firstName", "first_name"], interp);
    const phone = resolveValue(c.phoneField, payload, ["phone", "Phone", "mobile", "phone_number", "contact_number", "whatsapp"], interp);
    if (!email && !phone) {
      return { step: stepOf(node, "error", input, { tried: { emailField: c.emailField || "auto", phoneField: c.phoneField || "auto" } }, "Couldn't find an email or phone in the payload to create a contact") };
    }
    const source = interp(c.list, payload) || "Autopilot";
    try {
      const filter = email ? { owner, email: email.toLowerCase() } : { owner, phone };
      let lead = await Lead.findOne(filter);
      const wasNew = !lead;
      if (lead) {
        if (name) lead.name = name;
        if (email && !lead.email) lead.email = email.toLowerCase();
        if (phone && !lead.phone) lead.phone = phone;
        await lead.save();
      } else {
        lead = await Lead.create({
          owner, organization: ctx.organization || null,
          name: name || "", email: email ? email.toLowerCase() : "", phone: phone || "",
          source, status: "new",
        });
        await require("./leadAssignment").autoAssignLead(lead);
      }
      return { step: stepOf(node, "ok", input, { id: String(lead._id), email: lead.email, name: lead.name, phone: lead.phone }, `Contact ${wasNew ? "created" : "updated"} → ${email || phone}`) };
    } catch (err) {
      return { step: stepOf(node, "error", input, null, `Create contact failed: ${err.message}`) };
    }
  }

  // Integration actions — log the resolved config, don't dispatch.
  const resolved = {};
  for (const [k, v] of Object.entries(c)) resolved[k] = typeof v === "string" ? interp(v, payload) : v;
  return { step: stepOf(node, "logged", input, resolved, "Action logged (not dispatched in webhook trace run)") };
}

// Run a workflow. `onProgress(steps)` (optional) is awaited after each step so
// the caller can persist progress — important for flows with real wait/delay
// nodes that resolve over time.
async function runAutopilot(ap, reqData = {}, onProgress) {
  const cfg = ap.config || {};
  const steps = [];
  let payload = { ...clone(reqData.query), ...clone(reqData.body) };

  const report = async () => { try { await onProgress?.(steps); } catch { /* persist best-effort */ } };

  // Owner context — used by integration actions (e.g. send_email via SES).
  const owner = ap.createdBy;
  let emailCfg = null;
  if (owner) {
    emailCfg = await EmailConfig.findOne({ user: owner, sesVerified: true })
      || await EmailConfig.findOne({ user: owner });
  }
  const ctx = { owner, organization: ap.organization || null, emailCfg };

  if (cfg.trigger) {
    steps.push(stepOf(cfg.trigger, "ok", clone(payload), clone(payload), "Triggered"));
    await report();
  }

  async function walk(list) {
    for (const node of list || []) {
      if (isBranch(node)) {
        const res = evalCondition(node, payload);
        const s = stepOf(node, "ok", clone(payload), { result: res }, `Condition → ${res ? "YES" : "NO"} branch`);
        s.branch = res ? "yes" : "no";
        steps.push(s);
        await report();
        await walk(res ? node.yes : node.no);
        return; // a condition is terminal on its trunk
      }
      if (node.type === "wait.delay") {
        const cfg = node.config || {};
        // "Wait until customer replies" — a synchronous webhook run can't block for an
        // external reply, so we record the intent and continue. (True reply-wait needs
        // a durable scheduler that resumes the run when a reply event arrives.)
        if (cfg.mode === "reply") {
          steps.push(stepOf(
            node, "ok", clone(payload),
            { waitFor: "reply", channel: cfg.replyChannel || "any", onTimeout: cfg.onTimeout || "continue" },
            `Wait for customer reply${cfg.replyChannel && cfg.replyChannel !== "any" ? ` on ${cfg.replyChannel}` : ""}`,
          ));
          await report();
          if (cfg.onTimeout === "stop") return { steps }; // stop here until reply support lands
          continue;
        }
        const ms = waitDurationMs(cfg);
        const label = `${cfg.amount || 0} ${cfg.unit || "minutes"}`;
        steps.push(stepOf(node, "ok", clone(payload), { waitMs: ms }, ms > 0 ? `Waiting ${label}…` : "No wait set"));
        await report();
        if (ms > 0) await sleep(ms);
        continue;
      }
      const r = await runNode(node, payload, ctx);
      steps.push(r.step);
      if (r.payload) payload = r.payload;
      await report();
    }
  }

  await walk(cfg.steps);
  return { steps };
}

module.exports = { runAutopilot };
