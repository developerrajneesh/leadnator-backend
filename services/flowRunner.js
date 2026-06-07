// Runs a LeadFlow against a lead. Supports multi-channel (Email + WhatsApp)
// actions, wait nodes, condition branching. In-memory scheduling — fine for
// dev / small workloads; production should use a durable queue (BullMQ).
//
// Every send uses the PER-USER credentials stored in MongoDB:
//   • Email  — EmailConfig (host/port/user/pass) scoped to user._id
//   • WhatsApp — WhatsAppConnection (phoneNumberId + accessToken) scoped to user._id

const axios = require("axios");
const { VM } = require("vm2");

const LeadFlow = require("../models/LeadFlow");
const Lead = require("../models/Lead");
const EmailConfig = require("../models/EmailConfig");
const { sendViaSes, sesReady } = require("./sesSend");
const EmailTemplate = require("../models/EmailTemplate");
const WhatsAppConnection = require("../models/WhatsAppConnection");
const WhatsAppMessage = require("../models/WhatsAppMessage");

const FB_API_VERSION = process.env.META_API_VERSION || "v23.0";
const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_API_VERSION}`;
const MAX_LOGS = 20;

function render(text = "", vars = {}) {
  return String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) =>
    vars?.[k] != null ? String(vars[k]) : ""
  );
}
function leadVars(lead) {
  const first = (lead.name || "").split(" ")[0] || "";
  return {
    name: lead.name || "",
    firstName: first,
    email: lead.email || "",
    phone: lead.phone || "",
    source: lead.source || "",
    status: lead.status || "",
  };
}

async function sendEmail({ user, lead, config }) {
  if (!lead.email) return { ok: false, message: "Lead has no email address" };
  const userId = user._id || user;
  // Prefer the user's verified-domain config; fall back to any config doc.
  let cfg = await EmailConfig.findOne({ user: userId, sesVerified: true });
  if (!cfg) cfg = await EmailConfig.findOne({ user: userId });
  if (!sesReady(cfg)) {
    return { ok: false, message: "No verified sending domain — open /email/config and set up SES." };
  }

  let subject = config.subject || "Hello {{firstName}}";
  let body    = config.body    || "Hi {{firstName}}, thanks for reaching out.";
  if (config.templateId) {
    const t = await EmailTemplate.findOne({ _id: config.templateId, user: userId });
    if (t) { subject = t.subject; body = t.body; }
  }

  const vars = leadVars(lead);
  let html = render(body, vars);
  if (cfg.signature?.html && cfg.signature?.enabled) {
    html += `\n<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e5e7eb;color:#6b7280;font-family:Arial,sans-serif">${cfg.signature.html}</div>`;
  }

  try {
    const info = await sendViaSes(cfg, {
      to: lead.email,
      replyTo: cfg.replyTo || undefined,
      subject: render(subject, vars),
      html,
    });
    return { ok: true, message: `Email → ${lead.email} (id ${info.messageId})` };
  } catch (err) {
    return { ok: false, message: `SES error: ${err.message}` };
  }
}

async function sendWhatsApp({ user, lead, config }) {
  if (!lead.phone) return { ok: false, message: "Lead has no phone number" };
  const userId = user._id || user;
  const conn = await WhatsAppConnection.findOne({ user: userId }).select("+accessToken");
  if (!conn) return { ok: false, message: "WhatsApp not connected — open /whatsapp/settings." };
  if (!conn.accessToken || !conn.phoneNumberId) {
    return { ok: false, message: "WhatsApp access token / phoneNumberId missing — reconnect." };
  }

  const vars = leadVars(lead);
  const toNumber = String(lead.phone).replace(/[^\d+]/g, "");

  try {
    let data, type = "text";
    if (config.templateName) {
      const components = Array.isArray(config.parameters) && config.parameters.length
        ? [{ type: "body", parameters: config.parameters.map((t) => ({ type: "text", text: render(String(t), vars) })) }]
        : undefined;
      const res = await axios.post(
        `${FB_GRAPH_BASE}/${conn.phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          to: toNumber,
          type: "template",
          template: { name: config.templateName, language: { code: config.language || "en_US" }, ...(components ? { components } : {}) },
        },
        { params: { access_token: conn.accessToken }, validateStatus: () => true }
      );
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, message: `WA template error: ${res.data?.error?.message || "failed"}` };
      }
      type = "template"; data = res.data;
    } else {
      const bodyText = render(config.body || "Hi {{firstName}}, thanks!", vars);
      const res = await axios.post(
        `${FB_GRAPH_BASE}/${conn.phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          to: toNumber,
          type: "text",
          text: { body: bodyText, preview_url: false },
        },
        { params: { access_token: conn.accessToken }, validateStatus: () => true }
      );
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, message: `WA text error: ${res.data?.error?.message || "failed"}` };
      }
      data = res.data;
      await WhatsAppMessage.create({
        user: userId, phoneNumberId: conn.phoneNumberId, contactPhone: toNumber, direction: "outbound",
        type: "text", text: bodyText, messageId: data?.messages?.[0]?.id || "", status: "sent",
      });
    }
    const mid = data?.messages?.[0]?.id || "";
    return { ok: true, message: `WA ${type} → ${toNumber}${mid ? ` (id ${mid})` : ""}` };
  } catch (err) {
    return { ok: false, message: `WA network error: ${err.message}` };
  }
}

async function evalCondition(node, lead) {
  const t = node.type;
  const cfg = node.config || {};
  if (t === "condition.has_tag")   return (lead.tags || []).includes(cfg.tag);
  if (t === "condition.has_email") return !!(lead.email && lead.email.trim());
  if (t === "condition.has_phone") return !!(lead.phone && lead.phone.trim());
  if (t === "condition.status_is") return (lead.status || "").toLowerCase() === String(cfg.status || "").toLowerCase();
  return true;
}

async function applyAction(node, lead, user) {
  const cfg = node.config || {};
  const t = node.type;

  if (t === "action.add_tag") {
    if (!cfg.tag) return { ok: false, message: "No tag configured" };
    const tags = new Set(lead.tags || []);
    tags.add(cfg.tag);
    await Lead.findByIdAndUpdate(lead._id, { tags: [...tags] });
    lead.tags = [...tags];
    return { ok: true, message: `Tag "${cfg.tag}" added` };
  }
  if (t === "action.change_status") {
    if (!cfg.status) return { ok: false, message: "No status configured" };
    await Lead.findByIdAndUpdate(lead._id, { status: cfg.status });
    lead.status = cfg.status;
    return { ok: true, message: `Status → "${cfg.status}"` };
  }
  if (t === "action.send_message") {
    const channels = Array.isArray(cfg.channels) && cfg.channels.length ? cfg.channels : ["email"];
    const parts = [];
    let anyOk = false;
    for (const ch of channels) {
      let r;
      if (ch === "email")    r = await sendEmail({ user, lead, config: cfg });
      else if (ch === "whatsapp") r = await sendWhatsApp({ user, lead, config: cfg });
      else r = { ok: false, message: `Unknown channel ${ch}` };
      if (r.ok) anyOk = true;
      parts.push(`${ch.toUpperCase()}: ${r.ok ? "✓" : "✗"} ${r.message}`);
    }
    return { ok: anyOk, message: parts.join("  |  ") };
  }
  if (t === "action.run_js") {
    const script = String(cfg.script || cfg.code || "").trim();
    if (!script) return { ok: false, message: "No script configured" };
    try {
      const body = lead; // expose the current payload/lead as `body` param
      const vars = leadVars(lead);
      const wrapper = `(function(body, lead, user, vars){\n${script}\n})(body, lead, user, vars)`;
      const vm = new VM({ timeout: 1000, sandbox: { body, lead: JSON.parse(JSON.stringify(lead || {})), user: user && user._id ? String(user._id) : user || {}, vars } });
      const out = vm.run(wrapper);
      // Normalize output
      if (out && typeof out === "object") {
        return { ok: out.ok !== undefined ? !!out.ok : true, message: out.message || JSON.stringify(out) };
      }
      return { ok: true, message: String(out === undefined ? "(no output)" : out) };
    } catch (err) {
      return { ok: false, message: `JS runner error: ${err.message}` };
    }
  }
  return { ok: true, message: "Skipped (no handler)" };
}

function waitMillis(node) {
  const cfg = node.config || {};
  if (node.type === "wait.minutes") return Math.max(0, Number(cfg.minutes || 0)) * 60_000;
  if (node.type === "wait.hours")   return Math.max(0, Number(cfg.hours   || 0)) * 3_600_000;
  if (node.type === "wait.days")    return Math.max(0, Number(cfg.days    || 0)) * 86_400_000;
  return 0;
}

function nextNodes(flow, fromId, port = "out") {
  return (flow.edges || [])
    .filter((e) => e.fromNode === fromId && e.fromPort === port)
    .map((e) => flow.nodes.find((n) => n.id === e.toNode))
    .filter(Boolean);
}

function logStep(stepsBucket, node, ok, message) {
  if (!stepsBucket) return;
  stepsBucket.push({
    nodeId: node.id,
    nodeType: node.type,
    nodeTitle: node.title || "",
    ok,
    message: String(message || "").slice(0, 500),
  });
}

async function runFromNode(flow, node, lead, user, visited = new Set(), steps = null) {
  if (!node || visited.has(node.id)) return;
  visited.add(node.id);

  if (node.type.startsWith("trigger.")) {
    logStep(steps, node, true, "Triggered");
  } else if (node.type.startsWith("condition.")) {
    const yes = await evalCondition(node, lead);
    logStep(steps, node, true, yes ? "Condition → YES branch" : "Condition → NO branch");
    for (const nx of nextNodes(flow, node.id, yes ? "yes" : "no")) {
      await runFromNode(flow, nx, lead, user, visited, steps);
    }
    return;
  } else if (node.type.startsWith("wait.")) {
    const ms = waitMillis(node);
    logStep(steps, node, true, `Waiting ${ms} ms before next step`);
    for (const nx of nextNodes(flow, node.id)) {
      if (ms <= 0) await runFromNode(flow, nx, lead, user, new Set(visited), steps);
      else setTimeout(() => runFromNode(flow, nx, lead, user, new Set(visited), null).catch(console.error), ms);
    }
    return;
  } else if (node.type.startsWith("action.")) {
    try {
      const r = await applyAction(node, lead, user);
      logStep(steps, node, !!r.ok, r.message || "");
    } catch (err) {
      logStep(steps, node, false, `Exception: ${err.message}`);
    }
  }

  for (const nx of nextNodes(flow, node.id)) {
    await runFromNode(flow, nx, lead, user, new Set(visited), steps);
  }
}

async function recordRun(flow, triggerType, lead, steps) {
  try {
    flow.runs = (flow.runs || 0) + 1;
    flow.lastRunAt = new Date();
    const entry = {
      ts: new Date(),
      trigger: triggerType,
      leadName:  lead.name  || "",
      leadEmail: lead.email || "",
      leadPhone: lead.phone || "",
      steps,
    };
    flow.runLog = [entry, ...(flow.runLog || [])].slice(0, MAX_LOGS);
    await flow.save();
  } catch (err) {
    console.warn("[flowRunner] persist failed:", err.message);
  }
}

// Decide whether a flow's trigger node matches the runtime context.
// `context` carries trigger-specific hints (e.g. { newStatus } or { tag }).
function triggerMatches(trig, context = {}) {
  const cfg = trig.config || {};
  if (trig.type === "trigger.status_changed") {
    // If the flow doesn't pin a status, fire on any status change.
    if (!cfg.status) return true;
    return String(cfg.status).toLowerCase() === String(context.newStatus || "").toLowerCase();
  }
  if (trig.type === "trigger.tag_added") {
    if (!cfg.tag) return true;
    return String(cfg.tag).toLowerCase() === String(context.tag || "").toLowerCase();
  }
  return true; // new_lead and anything else: no extra filter.
}

async function runTrigger(triggerType, { user, lead, context }) {
  try {
    const orgId = lead?.organization;
    if (!orgId) {
      console.warn("[flowRunner] skip: lead has no organization");
      return;
    }
    const flows = await LeadFlow.find({
      user: user._id || user,
      organization: orgId,
      status: "active",
      "nodes.type": triggerType,
    });
    let matched = 0;
    for (const flow of flows) {
      const trig = flow.nodes.find((n) => n.type === triggerType);
      if (!trig) continue;
      if (!triggerMatches(trig, context)) continue;
      matched++;
      const steps = [];
      try { await runFromNode(flow, trig, lead, user, new Set(), steps); }
      catch (err) { logStep(steps, trig, false, `Run failed: ${err.message}`); }
      await recordRun(flow, triggerType, lead, steps);
    }
    console.log(`[flowRunner] ${triggerType} → ${matched}/${flows.length} active flow(s) fired (context=${JSON.stringify(context || {})})`);
  } catch (err) {
    console.warn("[flowRunner] runTrigger failed:", err.message);
  }
}

async function testRunFlow(flow, lead, user) {
  const trig = flow.nodes.find((n) => n.type.startsWith("trigger."));
  if (!trig) return { ok: false, message: "Flow has no trigger node", steps: [] };
  const steps = [];
  try { await runFromNode(flow, trig, lead, user, new Set(), steps); }
  catch (err) { logStep(steps, trig, false, `Run failed: ${err.message}`); }
  await recordRun(flow, trig.type + " (test)", lead, steps);
  return { ok: true, steps };
}

module.exports = { runTrigger, runFromNode, testRunFlow };
