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
const { sendViaSes, sesReady, resolveSender } = require("./sesSend");
const { emitToUser } = require("./socket");

const isBranch = (t) => t === "condition.if_else";

// Resolve the recipient email from the configured key. Supports a plain
// payload key ("email"), a {{template}}, a dotted path ("contact.email"),
// or a literal email address.
function resolveRecipient(to, payload, interp) {
  const v = String(to || "").trim();
  if (!v) return "";
  if (/\{\{/.test(v)) return interp(v, payload).trim();
  const direct = payload?.[v];
  if (direct != null && String(direct).includes("@")) return String(direct).trim();
  if (v.includes(".")) {
    let cur = payload;
    for (const p of v.split(".")) cur = cur?.[p];
    if (cur != null && String(cur).includes("@")) return String(cur).trim();
  }
  if (v.includes("@")) return v;
  return direct != null ? String(direct).trim() : "";
}

function clone(o) {
  try { return JSON.parse(JSON.stringify(o ?? {})); } catch { return {}; }
}
function interp(str, vars) {
  return String(str == null ? "" : str).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) =>
    vars?.[k] != null ? String(vars[k]) : "",
  );
}
function stepOf(node, status, input, output, message) {
  return { nodeId: node.id, type: node.type, title: node.title || node.type, status, input, output, message };
}

function evalCondition(node, payload) {
  const c = node.config || {};
  const actual = payload?.[c.field];
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
      if (m.from && m.to) { next[m.to] = payload?.[m.from]; applied.push(`${m.from} → ${m.to}`); }
    }
    return { payload: next, step: stepOf(node, "ok", input, next, applied.length ? `Mapped ${applied.join(", ")}` : "No field mappings set") };
  }

  if (t === "wait.delay") {
    const plan = `${c.amount || 0} ${c.unit || "minutes"}`;
    return { step: stepOf(node, "ok", input, { waited: false, planned: plan }, `Would wait ${plan} (skipped in trace)`) };
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

  // Integration actions — log the resolved config, don't dispatch.
  const resolved = {};
  for (const [k, v] of Object.entries(c)) resolved[k] = typeof v === "string" ? interp(v, payload) : v;
  return { step: stepOf(node, "logged", input, resolved, "Action logged (not dispatched in webhook trace run)") };
}

async function runAutopilot(ap, reqData = {}) {
  const cfg = ap.config || {};
  const steps = [];
  let payload = { ...clone(reqData.query), ...clone(reqData.body) };

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
  }

  async function walk(list) {
    for (const node of list || []) {
      if (isBranch(node)) {
        const res = evalCondition(node, payload);
        const s = stepOf(node, "ok", clone(payload), { result: res }, `Condition → ${res ? "YES" : "NO"} branch`);
        s.branch = res ? "yes" : "no";
        steps.push(s);
        await walk(res ? node.yes : node.no);
        return; // a condition is terminal on its trunk
      }
      const r = await runNode(node, payload, ctx);
      steps.push(r.step);
      if (r.payload) payload = r.payload;
    }
  }

  await walk(cfg.steps);
  return { steps };
}

module.exports = { runAutopilot };
