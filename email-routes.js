// Email Marketing routes — per-user Amazon SES (the user attaches & verifies
// their own domain) + templates + subscribers + campaigns + bulk send.

const express = require("express");
const EmailConfig     = require("./models/EmailConfig");
const EmailTemplate   = require("./models/EmailTemplate");
const EmailSubscriber = require("./models/EmailSubscriber");
const EmailCampaign   = require("./models/EmailCampaign");
const EmailLog        = require("./models/EmailLog");
const EmailMessage    = require("./models/EmailMessage");

const { tenantId, orgFilter } = require("./middleware/tenant");
const {
  SESClient,
  VerifyDomainIdentityCommand,
  VerifyDomainDkimCommand,
  GetIdentityVerificationAttributesCommand,
  GetIdentityDkimAttributesCommand,
  SendEmailCommand,
} = require("@aws-sdk/client-ses");
const { sendViaSes, sesReady, resolveSender } = require("./services/sesSend");

const router = express.Router();

function cleanDomain(input = "") {
  const raw = String(input || "").trim().toLowerCase();
  const stripped = raw
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0]
    .split("#")[0]
    .trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(stripped)) return "";
  return stripped;
}

function cleanEmail(input = "") {
  const email = String(input || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function emailOnDomain(email, domain) {
  if (!email || !domain) return false;
  return email === domain || email.endsWith(`@${domain}`);
}

// Migrate the legacy single sender into the senders[] list and guarantee
// exactly one default. Mutates cfg (caller saves).
function normalizeSenders(cfg) {
  if (!Array.isArray(cfg.senders)) cfg.senders = [];
  // Seed from legacy fields if the list is empty.
  if (cfg.senders.length === 0 && cfg.sesFromEmail) {
    cfg.senders.push({ name: cfg.sesFromName || "", email: cfg.sesFromEmail, isDefault: true });
  }
  if (cfg.senders.length && !cfg.senders.some((s) => s.isDefault)) {
    cfg.senders[0].isDefault = true;
  }
  // Keep legacy fields mirrored to the default for backward compatibility.
  const def = cfg.senders.find((s) => s.isDefault);
  if (def) { cfg.sesFromEmail = def.email; cfg.sesFromName = def.name || ""; }
  return cfg;
}

function sesClient() {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  return new SESClient({
    region,
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
  });
}

async function loadConfig(req) {
  const tid = tenantId(req);
  let cfg = await EmailConfig.findOne({ organization: tid }).select("+password");
  if (!cfg) {
    cfg = await EmailConfig.findOne({
      user: req.user._id,
      $or: [{ organization: null }, { organization: { $exists: false } }],
    }).select("+password");
  }
  return cfg;
}

// Render simple {{var}} placeholders. `vars` may be an object or a Map-like.
function renderTemplate(text = "", vars = {}) {
  return String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = vars?.[k];
    return v === undefined || v === null ? "" : String(v);
  });
}

// Public base URL the backend is reachable at (for email open-tracking pixels).
// In production set API_PUBLIC_URL to your deployed backend URL — a localhost
// pixel won't load in real inboxes, so opens won't track in local dev.
function trackingBase() {
  return (process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, "");
}

// Invisible 1x1 open-tracking pixel, unique per (campaign, recipient).
function openPixel(campaignId, email) {
  const r = Buffer.from(String(email), "utf8").toString("base64url");
  return `<img src="${trackingBase()}/api/public/email/open?c=${campaignId}&r=${r}" width="1" height="1" alt="" style="display:none;max-width:0;max-height:0;opacity:0" />`;
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
    let cfg = await loadConfig(req);
    if (!cfg) {
      cfg = await EmailConfig.create({
        user: req.user._id,
        organization: tenantId(req),
        host: "smtp.gmail.com", port: 587, secure: false,
      });
    }
    // Lazily migrate a legacy single sender into senders[] so the UI sees it.
    if ((cfg.senders || []).length === 0 && cfg.sesFromEmail) {
      normalizeSenders(cfg);
      await cfg.save();
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
      orgFilter(req),
      { ...patch, user: req.user._id, organization: tenantId(req), verified: false },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );
    res.json({ config: cfg.toJSON() });
  } catch (err) { next(err); }
});

// ---------- SES: Attach domain + show DNS records ----------
router.post("/ses/domain/attach", async (req, res, next) => {
  try {
    const domain = cleanDomain(req.body?.domain);
    if (!domain) return res.status(400).json({ error: "Enter a valid domain (e.g. example.com)" });

    const cfg = await EmailConfig.findOneAndUpdate(
      orgFilter(req),
      { $setOnInsert: { user: req.user._id, organization: tenantId(req) } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const ses = sesClient();

    // 1) Domain identity TXT token
    const ident = await ses.send(new VerifyDomainIdentityCommand({ Domain: domain }));
    const token = ident?.VerificationToken || "";
    if (!token) return res.status(500).json({ error: "SES did not return a verification token" });

    // 2) DKIM tokens (Easy DKIM)
    const dkim = await ses.send(new VerifyDomainDkimCommand({ Domain: domain }));
    const dkimTokens = Array.isArray(dkim?.DkimTokens) ? dkim.DkimTokens : [];

    const records = [
      {
        type: "TXT",
        name: `_amazonses.${domain}`,
        value: token,
      },
      ...dkimTokens.slice(0, 3).map((t) => ({
        type: "CNAME",
        name: `${t}._domainkey.${domain}`,
        value: `${t}.dkim.amazonses.com`,
      })),
    ];

    cfg.sesDomain = domain;
    cfg.sesDnsRecords = records;
    cfg.sesVerified = false;
    cfg.sesStatus = "DNS records generated. Add them to your DNS, then click Verify.";
    cfg.sesLastCheckedAt = null;
    await cfg.save();

    res.json({ ok: true, domain, records });
  } catch (err) { next(err); }
});

router.get("/ses/domain/status", async (req, res, next) => {
  try {
    const cfg = await loadConfig(req);
    const domain = cleanDomain(req.query?.domain || cfg?.sesDomain);
    if (!domain) return res.status(400).json({ error: "No domain attached yet" });

    const ses = sesClient();
    const [v, d] = await Promise.all([
      ses.send(new GetIdentityVerificationAttributesCommand({ Identities: [domain] })),
      ses.send(new GetIdentityDkimAttributesCommand({ Identities: [domain] })),
    ]);

    const vAttr = v?.VerificationAttributes?.[domain] || null;
    const dAttr = d?.DkimAttributes?.[domain] || null;
    const verificationStatus = vAttr?.VerificationStatus || "Unknown";
    const dkimStatus = dAttr?.DkimVerificationStatus || "Unknown";

    const verified = verificationStatus === "Success" && dkimStatus === "Success";

    if (cfg) {
      cfg.sesDomain = domain;
      cfg.sesVerified = verified;
      cfg.sesStatus = `Identity: ${verificationStatus} · DKIM: ${dkimStatus}`;
      cfg.sesLastCheckedAt = new Date();
      // Once verified, default a sender on the domain if the user hasn't set one,
      // so sending works immediately (and never falls back to old SMTP).
      if (verified && !cfg.sesFromEmail && (cfg.senders || []).length === 0) {
        cfg.sesFromEmail = `noreply@${domain}`;
      }
      if (verified) normalizeSenders(cfg);
      await cfg.save();
    }

    res.json({
      ok: true,
      domain,
      verified,
      verificationStatus,
      dkimStatus,
      lastCheckedAt: new Date().toISOString(),
      records: cfg?.sesDnsRecords || [],
    });
  } catch (err) { next(err); }
});

router.put("/ses/from", async (req, res, next) => {
  try {
    const cfg = await loadConfig(req);
    if (!cfg?.sesDomain) {
      return res.status(400).json({ error: "Attach and verify a domain in SES first." });
    }
    const fromEmail = cleanEmail(req.body?.fromEmail);
    const fromName = String(req.body?.fromName || "").trim();
    if (!fromEmail) return res.status(400).json({ error: "Enter a valid sender email (e.g. support@yourdomain.com)" });
    if (!emailOnDomain(fromEmail, cfg.sesDomain)) {
      return res.status(400).json({
        error: `Sender must use your verified domain (@${cfg.sesDomain}), e.g. support@${cfg.sesDomain}`,
      });
    }
    cfg.sesFromEmail = fromEmail;
    cfg.sesFromName = fromName;
    await cfg.save();
    res.json({ ok: true, config: cfg.toJSON() });
  } catch (err) { next(err); }
});

// ---------- SES: Sender profiles (support@, sales@, …) ----------
// Add a sender profile on the verified domain.
router.post("/ses/senders", async (req, res, next) => {
  try {
    const cfg = await loadConfig(req);
    if (!cfg?.sesDomain) return res.status(400).json({ error: "Attach and verify a domain first." });

    const email = cleanEmail(req.body?.email);
    const name = String(req.body?.name || "").trim();
    if (!email) return res.status(400).json({ error: "Enter a valid sender email (e.g. sales@yourdomain.com)" });
    if (!emailOnDomain(email, cfg.sesDomain)) {
      return res.status(400).json({ error: `Sender must be on your verified domain (@${cfg.sesDomain})` });
    }
    if (!Array.isArray(cfg.senders)) cfg.senders = [];
    if (cfg.senders.some((s) => (s.email || "").toLowerCase() === email)) {
      return res.status(409).json({ error: "That sender already exists." });
    }
    const makeDefault = cfg.senders.length === 0 || !!req.body?.isDefault;
    if (makeDefault) cfg.senders.forEach((s) => { s.isDefault = false; });
    cfg.senders.push({ name, email, isDefault: makeDefault });
    normalizeSenders(cfg);
    await cfg.save();
    res.status(201).json({ ok: true, config: cfg.toJSON() });
  } catch (err) { next(err); }
});

// Mark a sender profile as the default.
router.put("/ses/senders/:sid/default", async (req, res, next) => {
  try {
    const cfg = await loadConfig(req);
    const target = cfg && Array.isArray(cfg.senders) ? cfg.senders.id(req.params.sid) : null;
    if (!target) return res.status(404).json({ error: "Sender not found" });
    cfg.senders.forEach((s) => { s.isDefault = String(s._id) === String(req.params.sid); });
    normalizeSenders(cfg);
    await cfg.save();
    res.json({ ok: true, config: cfg.toJSON() });
  } catch (err) { next(err); }
});

// Delete a sender profile.
router.delete("/ses/senders/:sid", async (req, res, next) => {
  try {
    const cfg = await loadConfig(req);
    const target = cfg && Array.isArray(cfg.senders) ? cfg.senders.id(req.params.sid) : null;
    if (!target) return res.status(404).json({ error: "Sender not found" });
    const wasDefault = target.isDefault;
    cfg.senders.pull(req.params.sid);
    if (wasDefault && cfg.senders.length) cfg.senders[0].isDefault = true;
    normalizeSenders(cfg);
    await cfg.save();
    res.json({ ok: true, config: cfg.toJSON() });
  } catch (err) { next(err); }
});

router.post("/ses/test-send", async (req, res, next) => {
  try {
    const to = cleanEmail(req.body?.to);
    if (!to) return res.status(400).json({ error: "Recipient email required" });

    const cfg = await loadConfig(req);
    if (!cfg?.sesDomain) {
      return res.status(400).json({ error: "Attach your domain in the SES section first." });
    }
    if (!cfg.sesVerified) {
      return res.status(400).json({ error: "Domain not verified yet. Add DNS records and click Verify." });
    }

    const fromEmail = cleanEmail(req.body?.fromEmail || cfg.sesFromEmail);
    const fromName = String(req.body?.fromName ?? cfg.sesFromName ?? "").trim();
    if (!fromEmail) {
      return res.status(400).json({ error: `Set a sender address on @${cfg.sesDomain} (e.g. support@${cfg.sesDomain})` });
    }
    if (!emailOnDomain(fromEmail, cfg.sesDomain)) {
      return res.status(400).json({ error: `Sender must be on @${cfg.sesDomain}` });
    }

    cfg.sesFromEmail = fromEmail;
    if (fromName) cfg.sesFromName = fromName;
    await cfg.save();

    const source = fromName ? `"${fromName.replace(/"/g, "")}" <${fromEmail}>` : fromEmail;
    const ses = sesClient();
    const out = await ses.send(new SendEmailCommand({
      Source: source,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: "Test email from Leadnator (Amazon SES)", Charset: "UTF-8" },
        Body: {
          Html: {
            Data: `<p>Hello!</p><p>This is a test email sent via <strong>Amazon SES</strong> from <code>${fromEmail}</code>.</p><p>If you received this, SES sending works ✅.</p>`,
            Charset: "UTF-8",
          },
          Text: {
            Data: `Test email from ${fromEmail} via Leadnator Amazon SES.`,
            Charset: "UTF-8",
          },
        },
      },
    }));

    EmailLog.create({
      user: req.user._id,
      to,
      subject: "Test email from Leadnator (Amazon SES)",
      html: `SES test from ${fromEmail}`,
      messageId: out.MessageId || "",
      status: "sent",
    }).catch(() => {});

    res.json({ ok: true, messageId: out.MessageId, from: fromEmail });
  } catch (err) {
    const msg = err.message || "SES send failed";
    res.status(400).json({ error: msg });
  }
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
      orgFilter(req),
      { $set: set, user: req.user._id, organization: tenantId(req) },
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

    const cfg = await loadConfig(req);
    if (!sesReady(cfg)) {
      return res.status(400).json({ error: "Set up your sending domain under Email → Config first." });
    }

    try {
      const info = await sendViaSes(cfg, {
        to,
        subject,
        html: withSignature(html, cfg, useSignature !== false),
        replyTo: cfg.replyTo || undefined,
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

// Single campaign + its per-recipient delivery log (for the detail/analytics view).
router.get("/campaigns/:id", async (req, res, next) => {
  try {
    const camp = await EmailCampaign.findOne({ _id: req.params.id, user: req.user._id })
      .populate("template", "name")
      .populate("recipients", "name email status");
    if (!camp) return res.status(404).json({ error: "Campaign not found" });
    // Resolve the human-readable "from" for this campaign's chosen sender.
    const cfg = await loadConfig(req);
    const from = cfg ? resolveSender(cfg, camp.senderId) : null;
    res.json({ campaign: camp, from });
  } catch (err) { next(err); }
});

router.post("/campaigns", async (req, res, next) => {
  try {
    const { name, subject, body, templateId, recipientIds = [], senderId = "" } = req.body || {};
    if (!name || !subject || !body) return res.status(400).json({ error: "name, subject, body required" });
    const c = await EmailCampaign.create({
      user: req.user._id, name, subject, body,
      template: templateId || null,
      senderId: senderId || "",
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
    const cfg = await loadConfig(req);
    if (!sesReady(cfg)) {
      return res.status(400).json({ error: "Set up & verify your sending domain under Email → Config first." });
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

    camp.status = "sending"; await camp.save();

    let sent = 0, failed = 0;
    for (const r of recipients) {
      const vars = { name: r.name || r.email.split("@")[0], firstName: (r.name || "").split(" ")[0], email: r.email };
      try {
        const info = await sendViaSes(cfg, {
          to: r.email,
          replyTo: cfg.replyTo || undefined,
          senderId: camp.senderId || undefined,
          subject: renderTemplate(camp.subject, vars),
          html:    withSignature(renderTemplate(camp.body, vars), cfg, useSignature)
                     + openPixel(camp._id, r.email),
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
      configured: sesReady(cfg),
    });
  } catch (err) { next(err); }
});

// ---------- MAILBOX / INBOX ----------
// Strip quoted reply history ("On … wrote:" + > lines) for clean previews.
function stripQuotedText(text) {
  const t = String(text || "");
  const m = t.search(/\n\s*On\b[\s\S]{0,300}?\bwrote:/);
  let cut = m >= 0 ? t.slice(0, m) : t;
  cut = cut.split(/\r?\n/).filter((l) => !/^\s*>/.test(l)).join("\n");
  return cut.trim();
}

// List conversations (grouped by the other party), newest first, with unread counts.
router.get("/inbox", async (req, res, next) => {
  try {
    const convos = await EmailMessage.aggregate([
      { $match: { user: req.user._id } },
      { $sort: { ts: -1 } },
      {
        $group: {
          _id: "$counterparty",
          lastSubject: { $first: "$subject" },
          lastText:    { $first: "$text" },
          lastDir:     { $first: "$direction" },
          lastFromName:{ $first: "$fromName" },
          ts:          { $first: "$ts" },
          mailbox:     { $first: "$mailbox" },
          total:       { $sum: 1 },
          unread:      { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "inbound"] }, { $eq: ["$read", false] }] }, 1, 0] } },
        },
      },
      { $sort: { ts: -1 } },
      { $limit: 200 },
    ]);
    res.json({
      conversations: convos.map((c) => ({
        counterparty: c._id,
        name: c.lastFromName || "",
        lastSubject: c.lastSubject || "",
        preview: stripQuotedText(c.lastText || "").replace(/\s+/g, " ").trim().slice(0, 120),
        lastDirection: c.lastDir,
        mailbox: c.mailbox || "",
        ts: c.ts,
        total: c.total,
        unread: c.unread,
      })),
    });
  } catch (err) { next(err); }
});

// Full thread with one counterparty (oldest → newest). Marks inbound as read.
router.get("/inbox/:counterparty", async (req, res, next) => {
  try {
    const cp = String(req.params.counterparty || "").toLowerCase();
    const messages = await EmailMessage.find({ user: req.user._id, counterparty: cp }).sort({ ts: 1 });
    await EmailMessage.updateMany(
      { user: req.user._id, counterparty: cp, direction: "inbound", read: false },
      { $set: { read: true } }
    );
    res.json({ counterparty: cp, messages });
  } catch (err) { next(err); }
});

// Compose / reply — sends via the user's SES domain and records the outbound message.
router.post("/inbox/send", async (req, res, next) => {
  try {
    const to = cleanEmail(req.body?.to);
    const subject = String(req.body?.subject || "").trim();
    const html = String(req.body?.html || req.body?.body || "");
    const senderId = req.body?.senderId || "";
    const inReplyTo = String(req.body?.inReplyTo || "");
    if (!to) return res.status(400).json({ error: "Recipient email required" });
    if (!html.trim()) return res.status(400).json({ error: "Message body required" });

    const cfg = await loadConfig(req);
    if (!sesReady(cfg)) return res.status(400).json({ error: "Set up & verify your sending domain first." });

    const sender = resolveSender(cfg, senderId);
    const info = await sendViaSes(cfg, { to, subject: subject || "(no subject)", html, senderId });

    const msg = await EmailMessage.create({
      user: req.user._id,
      organization: tenantId(req),
      direction: "outbound",
      mailbox: sender.email,
      counterparty: to,
      fromName: sender.name || "",
      fromEmail: sender.email,
      toEmails: [to],
      subject: subject || "(no subject)",
      html,
      text: "",
      messageId: info.messageId || "",
      inReplyTo,
      read: true,
      ts: new Date(),
    });
    res.status(201).json({ ok: true, message: msg });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Unread count across the mailbox — for the sidebar badge.
router.get("/inbox-unread", async (req, res, next) => {
  try {
    const unread = await EmailMessage.countDocuments({ user: req.user._id, direction: "inbound", read: false });
    res.json({ unread });
  } catch (err) { next(err); }
});

module.exports = router;
