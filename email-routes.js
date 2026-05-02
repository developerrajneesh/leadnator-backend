// Email Marketing routes — per-user SMTP via Nodemailer + templates +
// subscribers + campaigns + bulk send.

const express = require("express");
const nodemailer = require("nodemailer");
const EmailConfig     = require("./models/EmailConfig");
const EmailTemplate   = require("./models/EmailTemplate");
const EmailSubscriber = require("./models/EmailSubscriber");
const EmailCampaign   = require("./models/EmailCampaign");
const EmailLog        = require("./models/EmailLog");

const router = express.Router();

async function loadConfig(userId) {
  return EmailConfig.findOne({ user: userId }).select("+password");
}

function makeTransporter(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: !!cfg.secure,
    auth: { user: cfg.username, pass: cfg.password },
  });
}

function fromHeader(cfg) {
  if (cfg.fromName && cfg.fromEmail) return `"${cfg.fromName}" <${cfg.fromEmail}>`;
  return cfg.fromEmail || cfg.username;
}

// Render simple {{var}} placeholders. `vars` may be an object or a Map-like.
function renderTemplate(text = "", vars = {}) {
  return String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = vars?.[k];
    return v === undefined || v === null ? "" : String(v);
  });
}

// Append the saved signature HTML (with a divider) when enabled and non-empty.
// `useSignature` lets the caller force-disable for a single send.
function withSignature(bodyHtml, cfg, useSignature) {
  const sig = cfg?.signature;
  if (!sig || !sig.html?.trim() || !sig.enabled || useSignature === false) return bodyHtml;
  return `${bodyHtml}
<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e5e7eb;color:#6b7280;font-family:Arial,sans-serif">
  ${sig.html}
</div>`;
}

// ---------- CONFIG ----------
router.get("/config", async (req, res, next) => {
  try {
    let cfg = await EmailConfig.findOne({ user: req.user._id });
    if (!cfg) {
      cfg = await EmailConfig.create({
        user: req.user._id,
        host: "smtp.gmail.com", port: 587, secure: false,
      });
    }
    res.json({ config: cfg.toJSON() });
  } catch (err) { next(err); }
});

router.put("/config", async (req, res, next) => {
  try {
    const { _id, id, user, verified, verifiedAt, lastError, ...patch } = req.body || {};
    // Only update password if a non-empty one was sent (so blank field doesn't wipe it)
    if (!patch.password) delete patch.password;
    const cfg = await EmailConfig.findOneAndUpdate(
      { user: req.user._id }, { ...patch, user: req.user._id, verified: false },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );
    res.json({ config: cfg.toJSON() });
  } catch (err) { next(err); }
});

router.post("/config/test", async (req, res, next) => {
  try {
    const cfg = await loadConfig(req.user._id);
    if (!cfg) return res.status(400).json({ error: "Save SMTP config first." });
    if (!cfg.password) return res.status(400).json({ error: "Set the SMTP password before testing." });

    const transporter = makeTransporter(cfg);
    try {
      await transporter.verify();
      cfg.verified = true; cfg.verifiedAt = new Date(); cfg.lastError = "";
      await cfg.save();
      res.json({ ok: true, message: "SMTP connection verified successfully." });
    } catch (err) {
      cfg.verified = false; cfg.lastError = err.message;
      await cfg.save();
      res.status(400).json({ ok: false, error: err.message });
    }
  } catch (err) { next(err); }
});

// Save signature (and toggle) — kept inside EmailConfig.signature
router.put("/signature", async (req, res, next) => {
  try {
    const allowed = ["enabled", "html", "name", "title", "company", "email", "phone", "website", "avatarUrl"];
    const set = {};
    for (const k of allowed) {
      if (req.body?.[k] !== undefined) set[`signature.${k}`] = req.body[k];
    }
    const cfg = await EmailConfig.findOneAndUpdate(
      { user: req.user._id }, { $set: set, user: req.user._id },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ signature: cfg.signature });
  } catch (err) { next(err); }
});

// Quick one-off send — used by pipeline / kanban "email this lead" modal.
// Accepts { to, subject, html, useSignature? } and sends via the per-user SMTP config.
router.post("/quick-send", async (req, res, next) => {
  try {
    const { to, subject, html, useSignature } = req.body || {};
    if (!to) return res.status(400).json({ error: "'to' email required" });
    if (!subject?.trim()) return res.status(400).json({ error: "Subject required" });
    if (!html?.trim())    return res.status(400).json({ error: "Message body required" });

    const cfg = await loadConfig(req.user._id);
    if (!cfg)          return res.status(400).json({ error: "No SMTP config — open /email/config first." });
    if (!cfg.password) return res.status(400).json({ error: "SMTP password not set — open /email/config." });

    const transporter = makeTransporter(cfg);
    try {
      const info = await transporter.sendMail({
        from: fromHeader(cfg),
        to,
        replyTo: cfg.replyTo || undefined,
        subject,
        html: withSignature(html, cfg, useSignature !== false),
      });
      EmailLog.create({ user: req.user._id, to, subject, html, messageId: info.messageId, status: "sent" })
        .catch((e) => console.warn("[email log] persist failed:", e.message));
      res.json({ ok: true, messageId: info.messageId });
    } catch (sendErr) {
      EmailLog.create({ user: req.user._id, to, subject, html, status: "failed", error: sendErr.message })
        .catch(() => {});
      throw sendErr;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Return last N emails sent to a given address from this user — used by the
// Quick Contact modal to show prior correspondence.
router.get("/quick-send/history", async (req, res, next) => {
  try {
    const to = String(req.query.to || "").trim().toLowerCase();
    if (!to) return res.status(400).json({ error: "'to' query param required" });
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const logs = await EmailLog.find({ user: req.user._id, to }).sort({ ts: -1 }).limit(limit);
    res.json({ history: logs.map((l) => l.toJSON()).reverse() });
  } catch (err) { next(err); }
});

router.post("/config/test-send", async (req, res, next) => {
  try {
    const { to } = req.body || {};
    if (!to) return res.status(400).json({ error: "to email required" });
    const cfg = await loadConfig(req.user._id);
    if (!cfg?.password) return res.status(400).json({ error: "Save SMTP config + password first." });

    const transporter = makeTransporter(cfg);
    const info = await transporter.sendMail({
      from: fromHeader(cfg),
      to,
      replyTo: cfg.replyTo || undefined,
      subject: "Test email from Leadnator",
      html: withSignature(
        `<p>Hello!</p><p>This is a test email from your Leadnator SMTP config.</p><p>If you got this, your setup works ✅.</p>`,
        cfg, true
      ),
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- TEMPLATES ----------
router.get("/templates", async (req, res, next) => {
  try {
    const list = await EmailTemplate.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json({ templates: list });
  } catch (err) { next(err); }
});

router.post("/templates", async (req, res, next) => {
  try {
    const { name, subject, body, category = "general" } = req.body || {};
    if (!name || !subject || !body) return res.status(400).json({ error: "name, subject, body required" });
    const t = await EmailTemplate.create({ user: req.user._id, name, subject, body, category });
    res.status(201).json({ template: t });
  } catch (err) { next(err); }
});

router.put("/templates/:id", async (req, res, next) => {
  try {
    const { _id, id, user, ...patch } = req.body || {};
    const t = await EmailTemplate.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id }, patch, { new: true, runValidators: true }
    );
    if (!t) return res.status(404).json({ error: "Template not found" });
    res.json({ template: t });
  } catch (err) { next(err); }
});

router.delete("/templates/:id", async (req, res, next) => {
  try {
    const r = await EmailTemplate.deleteOne({ _id: req.params.id, user: req.user._id });
    if (!r.deletedCount) return res.status(404).json({ error: "Template not found" });
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

// ---------- SUBSCRIBERS ----------
router.get("/subscribers", async (req, res, next) => {
  try {
    const { q = "", status = "all" } = req.query;
    const filter = { user: req.user._id };
    if (status !== "all") filter.status = status;
    if (q.trim()) {
      const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { email: rx }];
    }
    const list = await EmailSubscriber.find(filter).sort({ createdAt: -1 });
    res.json({ subscribers: list });
  } catch (err) { next(err); }
});

router.post("/subscribers", async (req, res, next) => {
  try {
    const { name = "", email, tags = [] } = req.body || {};
    if (!email) return res.status(400).json({ error: "email required" });
    const s = await EmailSubscriber.create({ user: req.user._id, name, email, tags });
    res.status(201).json({ subscriber: s });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "That email is already subscribed." });
    next(err);
  }
});

router.put("/subscribers/:id", async (req, res, next) => {
  try {
    const { _id, id, user, ...patch } = req.body || {};
    const s = await EmailSubscriber.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id }, patch, { new: true, runValidators: true }
    );
    if (!s) return res.status(404).json({ error: "Subscriber not found" });
    res.json({ subscriber: s });
  } catch (err) { next(err); }
});

router.delete("/subscribers/:id", async (req, res, next) => {
  try {
    const r = await EmailSubscriber.deleteOne({ _id: req.params.id, user: req.user._id });
    if (!r.deletedCount) return res.status(404).json({ error: "Subscriber not found" });
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

router.post("/subscribers/bulk", async (req, res, next) => {
  try {
    const list = Array.isArray(req.body?.subscribers) ? req.body.subscribers : [];
    const docs = list
      .filter((s) => s?.email)
      .map((s) => ({
        user: req.user._id,
        name: String(s.name || "").trim(),
        email: String(s.email).trim().toLowerCase(),
        tags: Array.isArray(s.tags) ? s.tags : [],
        source: s.source || "import",
      }));

    let inserted = 0, skipped = 0;
    for (const d of docs) {
      try { await EmailSubscriber.create(d); inserted += 1; }
      catch (e) { if (e.code === 11000) skipped += 1; else throw e; }
    }
    res.json({ inserted, skipped, total: docs.length });
  } catch (err) { next(err); }
});

// ---------- CAMPAIGNS ----------
router.get("/campaigns", async (req, res, next) => {
  try {
    const list = await EmailCampaign.find({ user: req.user._id })
      .populate("template", "name").sort({ createdAt: -1 });
    res.json({ campaigns: list });
  } catch (err) { next(err); }
});

router.post("/campaigns", async (req, res, next) => {
  try {
    const { name, subject, body, templateId, recipientIds = [] } = req.body || {};
    if (!name || !subject || !body) return res.status(400).json({ error: "name, subject, body required" });
    const c = await EmailCampaign.create({
      user: req.user._id, name, subject, body,
      template: templateId || null,
      recipients: recipientIds,
      status: "draft",
    });
    res.status(201).json({ campaign: c });
  } catch (err) { next(err); }
});

router.delete("/campaigns/:id", async (req, res, next) => {
  try {
    const r = await EmailCampaign.deleteOne({ _id: req.params.id, user: req.user._id });
    if (!r.deletedCount) return res.status(404).json({ error: "Campaign not found" });
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

// SEND a campaign (or test) immediately.
router.post("/campaigns/:id/send", async (req, res, next) => {
  try {
    const cfg = await loadConfig(req.user._id);
    if (!cfg?.password) {
      return res.status(400).json({ error: "Set up SMTP config first under Email → Config." });
    }
    const camp = await EmailCampaign.findOne({ _id: req.params.id, user: req.user._id })
      .populate("recipients", "name email status");
    if (!camp) return res.status(404).json({ error: "Campaign not found" });

    const recipients = (camp.recipients || []).filter((r) => r.status === "active");
    if (!recipients.length) return res.status(400).json({ error: "No active recipients selected" });

    // Per-call signature override; defaults to whatever the user has saved.
    // Only honors `useSignature: false` if the saved signature actually has HTML.
    const signatureSet = !!cfg?.signature?.html?.trim();
    const useSignature = req.body?.useSignature === false ? false : (signatureSet && cfg.signature.enabled);

    const transporter = makeTransporter(cfg);
    camp.status = "sending"; await camp.save();

    let sent = 0, failed = 0;
    for (const r of recipients) {
      const vars = { name: r.name || r.email.split("@")[0], firstName: (r.name || "").split(" ")[0], email: r.email };
      try {
        const info = await transporter.sendMail({
          from: fromHeader(cfg),
          to: r.email,
          replyTo: cfg.replyTo || undefined,
          subject: renderTemplate(camp.subject, vars),
          html:    withSignature(renderTemplate(camp.body, vars), cfg, useSignature),
        });
        sent += 1;
        camp.log.push({ email: r.email, status: "sent", messageId: info.messageId });
      } catch (e) {
        failed += 1;
        camp.log.push({ email: r.email, status: "failed", error: e.message });
      }
    }

    camp.sent = sent;
    camp.failed = failed;
    camp.status = failed === recipients.length ? "failed" : "completed";
    camp.sentAt = new Date();
    await camp.save();
    res.json({ campaign: camp, sent, failed });
  } catch (err) { next(err); }
});

// ---------- STATS ----------
router.get("/stats", async (req, res, next) => {
  try {
    const [campaigns, subs, templates, cfg] = await Promise.all([
      EmailCampaign.find({ user: req.user._id }),
      EmailSubscriber.countDocuments({ user: req.user._id, status: "active" }),
      EmailTemplate.countDocuments({ user: req.user._id }),
      EmailConfig.findOne({ user: req.user._id }),
    ]);
    const totalSent   = campaigns.reduce((s, c) => s + (c.sent   || 0), 0);
    const totalFailed = campaigns.reduce((s, c) => s + (c.failed || 0), 0);
    res.json({
      campaigns: campaigns.length,
      activeSubscribers: subs,
      templates,
      totalSent,
      totalFailed,
      configured: !!(cfg && cfg.verified),
    });
  } catch (err) { next(err); }
});

module.exports = router;
