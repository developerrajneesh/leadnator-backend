require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const socketService = require("./services/socket");

const connectDB = require("./config/db");
const User        = require("./models/User");
const Lead        = require("./models/Lead");
const Campaign    = require("./models/Campaign");
const MetaAccount = require("./models/MetaAccount");
const Ticket      = require("./models/Ticket");
const Plan        = require("./models/Plan");
const { router: metaRouter, metaErrorHandler } = require("./meta-routes");
const aiRouter = require("./ai-routes");
const waRouter = require("./wa-routes");
const calendarRouter = require("./calendar-routes");
const publicRouter   = require("./public-routes");
const pricingRouter  = require("./pricing-routes");
const profileRouter  = require("./profile-routes");
const emailRouter    = require("./email-routes");
const storageRouter  = require("./storage-routes");
const supportRouter  = require("./support-routes");
const LeadFlow       = require("./models/LeadFlow");
const flowRunner     = require("./services/flowRunner");
const webhooksRouter = require("./webhooks");

const app = express();

// app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173", credentials: true }));
app.use(morgan("dev"));
app.use(cors({
  origin: "*"
}));

// Webhooks MUST be mounted before the global JSON parser so individual webhook
// files can pull the raw body for HMAC signature verification (Razorpay/Stripe/
// Meta all sign the raw bytes). See backend/webhooks/index.js for the pattern.
app.use("/webhooks", webhooksRouter);

app.use(express.json({ limit: "5mb" }));
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 }));

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

const signToken = (u) => jwt.sign({ id: u._id.toString(), role: u.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

async function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  // Accept JWT from Authorization header OR ?token query param. The query
  // fallback is required for <img src="..."> / <video src="..."> since the
  // browser can't set custom headers on those requests.
  const token = (header.startsWith("Bearer ") ? header.slice(7) : null) || req.query.token;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(payload.id);
    if (!user) return res.status(401).json({ error: "User not found" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- HEALTH ----------
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, service: "leadnator-api", uptime: process.uptime() })
);

// ---------- PUBLIC (no auth) ----------
app.use("/api/public", publicRouter);

// ---------- AUTH ----------
app.post("/api/auth/login", ah(async (req, res) => {
  const { email = "", password = "" } = req.body || {};
  const user = await User.findOne({ email: email.trim().toLowerCase() }).select("+password");
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const ok = await user.comparePassword(password);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });
  res.json({ token: signToken(user), user: user.toJSON() });
}));

app.post("/api/auth/signup", ah(async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
  const exists = await User.findOne({ email: email.trim().toLowerCase() });
  if (exists) return res.status(409).json({ error: "Email already in use" });
  const user = await User.create({ name, email: email.trim().toLowerCase(), password });
  res.status(201).json({ token: signToken(user), user: user.toJSON() });
}));

app.get("/api/auth/me", authRequired, (req, res) => {
  res.json({ user: req.user.toJSON() });
});

// ---------- PASSWORD RESET ----------
// Step 1: user submits their email → we generate a one-time token, stash it on
// the user (hashed), and email them a link. We *always* respond 200 even if
// the email doesn't exist, to avoid leaking which addresses have accounts.
app.post("/api/auth/forgot-password", ah(async (req, res) => {
  const crypto = require("crypto");
  const nodemailer = require("nodemailer");

  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Email required" });

  const user = await User.findOne({ email });
  if (user) {
    // Store a hash of the token (so even a DB leak doesn't expose raw tokens).
    const rawToken  = crypto.randomBytes(32).toString("hex");
    const hashed    = crypto.createHash("sha256").update(rawToken).digest("hex");
    user.passwordResetToken     = hashed;
    user.passwordResetExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    const appUrl = (process.env.CLIENT_URL || "http://localhost:5173").replace(/\/$/, "");
    const resetLink = `${appUrl}/reset-password/${rawToken}`;

    // Send via the SMTP creds in backend/.env. If missing, log the link so
    // devs can copy-paste it during local testing.
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
    if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
      try {
        const transporter = nodemailer.createTransport({
          host: SMTP_HOST, port: Number(SMTP_PORT) || 587,
          secure: Number(SMTP_PORT) === 465,
          auth: { user: SMTP_USER, pass: SMTP_PASS },
        });
        await transporter.sendMail({
          from: SMTP_FROM || `"Leadnator" <${SMTP_USER}>`,
          to: email,
          subject: "Reset your Leadnator password",
          html: `
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#111">
              <h2 style="color:#7c3aed;margin:0 0 16px">Reset your password</h2>
              <p>Hi ${user.name || "there"}, click the button below to set a new password. This link expires in 1 hour.</p>
              <p style="margin:24px 0;text-align:center">
                <a href="${resetLink}" style="background:#7c3aed;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Reset password</a>
              </p>
              <p style="font-size:12px;color:#6b7280">Or copy this link into your browser:<br/>
                <a href="${resetLink}" style="color:#7c3aed;word-break:break-all">${resetLink}</a>
              </p>
              <p style="font-size:12px;color:#6b7280;margin-top:24px">If you didn't request this, you can ignore this email — your password won't change.</p>
            </div>
          `,
        });
        console.log(`[auth] password reset email sent to ${email}`);
      } catch (err) {
        console.warn(`[auth] failed to send reset email: ${err.message}. Reset link: ${resetLink}`);
      }
    } else {
      // No SMTP configured — surface the link in the console for dev.
      console.log(`\n[auth] PASSWORD RESET for ${email}\n  Link: ${resetLink}\n  (Configure SMTP_HOST / SMTP_USER / SMTP_PASS in backend/.env to email it instead)\n`);
    }
  }

  // Always 200 — don't reveal whether the address is registered.
  res.json({ ok: true, message: "If that email is registered, a reset link has been sent." });
}));

// Step 2: the reset page first verifies the token is valid before showing
// the new-password form. Returns the masked email on success so the UI can
// display "Resetting password for r*****@gmail.com".
app.get("/api/auth/verify-reset-token/:token", ah(async (req, res) => {
  const crypto = require("crypto");
  const hashed = crypto.createHash("sha256").update(req.params.token).digest("hex");
  const user = await User.findOne({
    passwordResetToken: hashed,
    passwordResetExpiresAt: { $gt: new Date() },
  }).select("+passwordResetToken +passwordResetExpiresAt");
  if (!user) return res.status(400).json({ error: "This reset link is invalid or has expired." });

  const [local, domain] = user.email.split("@");
  const masked = local.length <= 2 ? local[0] + "*" : local[0] + "***" + local.slice(-1);
  res.json({ ok: true, email: `${masked}@${domain}` });
}));

// Step 3: user submits new password + confirm, we verify the token again and
// update. On success the token is cleared so the link becomes single-use.
app.post("/api/auth/reset-password", ah(async (req, res) => {
  const crypto = require("crypto");
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: "Token and password required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const hashed = crypto.createHash("sha256").update(token).digest("hex");
  const user = await User.findOne({
    passwordResetToken: hashed,
    passwordResetExpiresAt: { $gt: new Date() },
  }).select("+password +passwordResetToken +passwordResetExpiresAt");
  if (!user) return res.status(400).json({ error: "This reset link is invalid or has expired." });

  user.password = password;
  user.passwordResetToken = "";
  user.passwordResetExpiresAt = null;
  await user.save();

  res.json({ ok: true, message: "Password reset. You can now sign in." });
}));

// ---------- LEADS ----------
app.get("/api/leads", authRequired, ah(async (req, res) => {
  const { q = "", status = "all", source = "all" } = req.query;
  const filter = req.user.role === "admin" ? {} : { owner: req.user._id };
  if (status !== "all") filter.status = status;
  if (source !== "all") filter.source = source;
  if (q.trim()) {
    const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }
  const leads = await Lead.find(filter).sort({ createdAt: -1 });
  res.json({ leads, total: leads.length });
}));

app.get("/api/leads/:id", authRequired, ah(async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  res.json({ lead });
}));

app.post("/api/leads", authRequired, ah(async (req, res) => {
  const { name, email, phone = "", source = "Manual", status = "new", tags = [], notes = "", value = 0 } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: "Name and email required" });
  const lead = await Lead.create({
    owner: req.user._id, name, email, phone, source, status, tags, notes, value: Number(value) || 0,
  });
  // Fire any active Lead automation flows — non-blocking
  flowRunner.runTrigger("trigger.new_lead", { user: req.user, lead }).catch(() => {});
  res.status(201).json({ lead });
}));

app.put("/api/leads/:id", authRequired, ah(async (req, res) => {
  const { id, ownerId, createdAt, updatedAt, owner, _id, ...rest } = req.body || {};
  const prev = await Lead.findById(req.params.id);
  if (!prev) return res.status(404).json({ error: "Lead not found" });

  const lead = await Lead.findByIdAndUpdate(req.params.id, rest, { new: true, runValidators: true });
  res.json({ lead });

  // Fire automation triggers for mutations — non-blocking, don't fail the request.
  try {
    const prevStatus = String(prev.status || "").toLowerCase();
    const nextStatus = String(lead.status || "").toLowerCase();
    if (nextStatus && prevStatus !== nextStatus) {
      flowRunner.runTrigger("trigger.status_changed", {
        user: req.user, lead, context: { oldStatus: prevStatus, newStatus: nextStatus },
      }).catch(() => {});
    }
    const prevTags = new Set((prev.tags || []).map((t) => String(t).toLowerCase()));
    const addedTags = (lead.tags || []).filter((t) => !prevTags.has(String(t).toLowerCase()));
    for (const tag of addedTags) {
      flowRunner.runTrigger("trigger.tag_added", {
        user: req.user, lead, context: { tag },
      }).catch(() => {});
    }
  } catch (err) {
    console.warn("[leads PUT] trigger dispatch failed:", err.message);
  }
}));

app.delete("/api/leads/:id", authRequired, ah(async (req, res) => {
  const lead = await Lead.findByIdAndDelete(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  res.json({ deleted: req.params.id });
}));

// ---------- LEAD SETTINGS (per-user source toggles) ----------
const LeadSettings = require("./models/LeadSettings");

app.get("/api/lead-settings", authRequired, ah(async (req, res) => {
  const s = await LeadSettings.forUser(req.user._id);
  res.json({ settings: s });
}));

app.put("/api/lead-settings", authRequired, ah(async (req, res) => {
  // Allow-list the sections a client can update so they can't patch
  // `user` or other internals.
  const { metaForms, whatsapp } = req.body || {};
  const update = {};
  if (metaForms) update.metaForms = metaForms;
  if (whatsapp)  update.whatsapp  = whatsapp;

  const s = await LeadSettings.findOneAndUpdate(
    { user: req.user._id },
    { $set: update, $setOnInsert: { user: req.user._id } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
  res.json({ settings: s });
}));

// ---------- LEAD AUTOMATION FLOWS ----------
app.get("/api/lead-flows", authRequired, ah(async (req, res) => {
  const flows = await LeadFlow.find({ user: req.user._id }).sort({ createdAt: -1 });
  res.json({ flows });
}));
app.get("/api/lead-flows/:id", authRequired, ah(async (req, res) => {
  const flow = await LeadFlow.findOne({ _id: req.params.id, user: req.user._id });
  if (!flow) return res.status(404).json({ error: "Flow not found" });
  res.json({ flow });
}));
app.post("/api/lead-flows", authRequired, ah(async (req, res) => {
  const { name, nodes = [], edges = [], status = "draft" } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const flow = await LeadFlow.create({ user: req.user._id, name, nodes, edges, status });
  res.status(201).json({ flow });
}));
app.put("/api/lead-flows/:id", authRequired, ah(async (req, res) => {
  const { _id, id, user, ...patch } = req.body || {};
  const flow = await LeadFlow.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id }, patch, { new: true, runValidators: true }
  );
  if (!flow) return res.status(404).json({ error: "Flow not found" });
  res.json({ flow });
}));
app.delete("/api/lead-flows/:id", authRequired, ah(async (req, res) => {
  const r = await LeadFlow.deleteOne({ _id: req.params.id, user: req.user._id });
  if (!r.deletedCount) return res.status(404).json({ error: "Flow not found" });
  res.json({ deleted: req.params.id });
}));
// Test-run: pick a lead (or the latest) and fire the flow, returning per-step results.
// Bypasses the draft/active gate so builders can verify before activating.
app.post("/api/lead-flows/:id/test", authRequired, ah(async (req, res) => {
  const flow = await LeadFlow.findOne({ _id: req.params.id, user: req.user._id });
  if (!flow) return res.status(404).json({ error: "Flow not found" });

  let lead = null;
  if (req.body?.leadId) lead = await Lead.findOne({ _id: req.body.leadId, owner: req.user._id });
  else                  lead = await Lead.findOne({ owner: req.user._id }).sort({ createdAt: -1 });
  if (!lead) return res.status(400).json({ error: "No lead to run the flow on. Create a lead first." });

  const result = await flowRunner.testRunFlow(flow, lead, req.user);
  res.json({
    ok: result.ok,
    message: result.message,
    steps: result.steps || [],
    lead: { id: lead._id, name: lead.name, email: lead.email, phone: lead.phone },
  });
}));

// Recent run history for a flow (last 20 runs, each with per-step outcomes)
app.get("/api/lead-flows/:id/logs", authRequired, ah(async (req, res) => {
  const flow = await LeadFlow.findOne({ _id: req.params.id, user: req.user._id })
    .select("name status runs lastRunAt runLog");
  if (!flow) return res.status(404).json({ error: "Flow not found" });
  res.json({
    name: flow.name,
    status: flow.status,
    runs: flow.runs || 0,
    lastRunAt: flow.lastRunAt,
    runLog: flow.runLog || [],
  });
}));

// ---------- CAMPAIGNS ----------
app.get("/api/campaigns", authRequired, ah(async (_req, res) => {
  const campaigns = await Campaign.find().sort({ createdAt: -1 });
  res.json({ campaigns });
}));

app.post("/api/campaigns", authRequired, ah(async (req, res) => {
  const { name, status = "draft", subject = "", body = "" } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name required" });
  const campaign = await Campaign.create({ owner: req.user._id, name, status, subject, body });
  res.status(201).json({ campaign });
}));

// ---------- META (Facebook Graph API proxy) ----------
app.use("/api/meta", authRequired, metaRouter);
app.use("/api/meta", metaErrorHandler);

// ---------- AI (OpenAI content generator) ----------
app.use("/api/ai", authRequired, aiRouter);

// ---------- WHATSAPP MARKETING (Meta WhatsApp Cloud API) ----------
app.use("/api/wa", authRequired, waRouter);

// ---------- CALENDAR (events, availability, booking types) ----------
app.use("/api/calendar", authRequired, calendarRouter);

// ---------- PRICING (Razorpay subscriptions) ----------
app.use("/api/pricing", authRequired, pricingRouter);

// ---------- PROFILE (info, password, settings, api keys, team) ----------
app.use("/api/profile", authRequired, profileRouter);

// ---------- EMAIL MARKETING (Nodemailer / SMTP) ----------
app.use("/api/email", authRequired, emailRouter);

// ---------- FILE STORAGE (Supabase S3-compatible) ----------
app.use("/api/storage", authRequired, storageRouter);

// ---------- SUPPORT (tickets, FAQ, docs) ----------
app.use("/api/support", authRequired, supportRouter);

// ---------- LEGACY META ACCOUNTS (in-DB, kept for dashboards) ----------
app.get("/api/meta-db/accounts", authRequired, ah(async (_req, res) => {
  const accounts = await MetaAccount.find();
  res.json({ accounts });
}));

// ---------- PLANS ----------
app.get("/api/plans", ah(async (_req, res) => {
  const plans = await Plan.find().sort({ price: 1 });
  res.json({ plans });
}));

// ---------- DASHBOARD STATS ----------
app.get("/api/dashboard/stats", authRequired, ah(async (req, res) => {
  const filter = req.user.role === "admin" ? {} : { owner: req.user._id };
  const [leads, campaigns] = await Promise.all([Lead.find(filter), Campaign.find()]);

  const byStatus = leads.reduce((acc, l) => ((acc[l.status] = (acc[l.status] || 0) + 1), acc), {});
  const bySource = leads.reduce((acc, l) => ((acc[l.source] = (acc[l.source] || 0) + 1), acc), {});
  const pipelineValue = leads.reduce((s, l) => s + (l.value || 0), 0);
  const campaignSent   = campaigns.reduce((s, c) => s + c.sent,   0);
  const campaignOpens  = campaigns.reduce((s, c) => s + c.opens,  0);
  const campaignClicks = campaigns.reduce((s, c) => s + c.clicks, 0);

  res.json({
    totalLeads: leads.length,
    byStatus, bySource, pipelineValue,
    campaignSent, campaignOpens, campaignClicks,
    activeCampaigns: campaigns.filter((c) => c.status === "active").length,
  });
}));

// Rich overview — one-shot fetch for the dashboard pages. Pulls the user's
// real leads + email campaigns + WhatsApp messages + Meta connection summary
// + file storage totals so the UI doesn't need dummy data.
app.get("/api/dashboard/overview", authRequired, ah(async (req, res) => {
  const EmailCampaign = require("./models/EmailCampaign");
  const WhatsAppMessage = require("./models/WhatsAppMessage");
  const WhatsAppContact = require("./models/WhatsAppContact");
  const StorageItem = require("./models/StorageItem");

  const leadFilter = req.user.role === "admin" ? {} : { owner: req.user._id };
  const [leads, emailCamps, waMessages, waContacts, waCampaigns, storageFiles] = await Promise.all([
    Lead.find(leadFilter).sort({ createdAt: -1 }),
    EmailCampaign.find({ user: req.user._id }).sort({ createdAt: -1 }),
    WhatsAppMessage.countDocuments({ user: req.user._id }),
    WhatsAppContact.countDocuments({ user: req.user._id }),
    require("./models/WhatsAppCampaign").countDocuments({ user: req.user._id }),
    StorageItem.countDocuments({ user: req.user._id, type: "file", deleted: false }),
  ]);

  // Day-by-day buckets — past 14 days, zero-filled.
  const dayBuckets = Array.from({ length: 14 }).map((_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86400000);
    return { key: d.toISOString().slice(0, 10), label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }), value: 0 };
  });
  const bucketIx = Object.fromEntries(dayBuckets.map((b, i) => [b.key, i]));
  for (const l of leads) {
    const key = new Date(l.createdAt).toISOString().slice(0, 10);
    if (bucketIx[key] != null) dayBuckets[bucketIx[key]].value++;
  }
  // 7-day slice for the smaller Overview chart.
  const leadsByDay = dayBuckets.slice(-7).map((b) => ({ label: b.label.split(" ")[0], value: b.value }));

  // Source breakdown (top 6, rest lumped into "Other").
  const sourceMap = leads.reduce((acc, l) => ((acc[l.source || "Other"] = (acc[l.source || "Other"] || 0) + 1), acc), {});
  const palette = ["#7c3aed", "#ec4899", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444"];
  const sortedSources = Object.entries(sourceMap).sort((a, b) => b[1] - a[1]);
  const top6 = sortedSources.slice(0, 6);
  const rest = sortedSources.slice(6).reduce((s, [, v]) => s + v, 0);
  const totalLeads = leads.length || 1;
  const sourceBreakdown = top6.map(([label, v], i) => ({
    label, value: Math.round((v / totalLeads) * 100), count: v, color: palette[i % palette.length],
  }));
  if (rest > 0) sourceBreakdown.push({ label: "Other", value: Math.round((rest / totalLeads) * 100), count: rest, color: "#9ca3af" });

  // Campaign totals (email + WhatsApp merged for the "Marketing" stat cards).
  const emailSent   = emailCamps.reduce((s, c) => s + (c.sent   || 0), 0);
  const emailOpens  = emailCamps.reduce((s, c) => s + (c.opens  || 0), 0);
  const emailClicks = emailCamps.reduce((s, c) => s + (c.clicks || 0), 0);

  res.json({
    user: { name: req.user.name, email: req.user.email, plan: req.user.plan },
    leads: {
      total: leads.length,
      byStatus: leads.reduce((acc, l) => ((acc[l.status] = (acc[l.status] || 0) + 1), acc), {}),
      pipelineValue: leads.reduce((s, l) => s + (l.value || 0), 0),
      avgDealSize: leads.length ? Math.round(leads.reduce((s, l) => s + (l.value || 0), 0) / leads.length) : 0,
      recent: leads.slice(0, 6).map((l) => l.toJSON()),
      top:   [...leads].sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 5).map((l) => l.toJSON()),
      leadsByDay,       // 7 days (bar chart)
      leadsByDay14: dayBuckets, // 14 days (line chart)
      sourceBreakdown,
    },
    email: {
      campaigns: emailCamps.length,
      active: emailCamps.filter((c) => c.status === "active" || c.status === "sending").length,
      sent: emailSent, opens: emailOpens, clicks: emailClicks,
      recent: emailCamps.slice(0, 5).map((c) => ({
        id: c._id?.toString?.(),
        name: c.name, status: c.status,
        sent: c.sent || 0, opens: c.opens || 0, clicks: c.clicks || 0,
      })),
    },
    whatsapp: {
      contacts: waContacts,
      messages: waMessages,
      campaigns: waCampaigns,
    },
    storage: { files: storageFiles },
  });
}));

// Dashboard activity feed — chronological lead events (creation + status
// changes) for the last N days. Keeps the page cheap by limiting to 40 rows.
app.get("/api/dashboard/activity", authRequired, ah(async (req, res) => {
  const filter = req.user.role === "admin" ? {} : { owner: req.user._id };
  const leads = await Lead.find(filter).sort({ updatedAt: -1 }).limit(40);
  const events = [];
  for (const l of leads) {
    events.push({
      kind: "lead_created",
      text: `New lead ${l.name} from ${l.source || "Manual"}`,
      status: l.status,
      ts: l.createdAt,
      leadId: l._id.toString(),
      leadName: l.name,
    });
    if (l.updatedAt && new Date(l.updatedAt).getTime() - new Date(l.createdAt).getTime() > 1000) {
      events.push({
        kind: "status_changed",
        text: `${l.name} moved to ${l.status}`,
        status: l.status,
        ts: l.updatedAt,
        leadId: l._id.toString(),
        leadName: l.name,
      });
    }
  }
  events.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  res.json({ events: events.slice(0, 40) });
}));

// CSV export (real, on-demand). Supported kinds: leads, campaigns.
app.get("/api/dashboard/export/:kind", authRequired, ah(async (req, res) => {
  const kind = req.params.kind;
  const filter = req.user.role === "admin" ? {} : { owner: req.user._id };

  function toCsv(rows, cols) {
    const esc = (v) => {
      if (v == null) return "";
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const header = cols.map((c) => esc(c.label || c.key)).join(",");
    const body = rows.map((r) => cols.map((c) => esc(typeof c.get === "function" ? c.get(r) : r[c.key])).join(",")).join("\n");
    return header + "\n" + body + "\n";
  }

  if (kind === "leads") {
    const rows = await Lead.find(filter).sort({ createdAt: -1 });
    const csv = toCsv(rows, [
      { key: "name" }, { key: "email" }, { key: "phone" }, { key: "source" },
      { key: "status" }, { key: "value" },
      { key: "tags", get: (r) => (r.tags || []).join("; ") },
      { key: "createdAt", get: (r) => new Date(r.createdAt).toISOString() },
    ]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="leads-${Date.now()}.csv"`);
    return res.send(csv);
  }
  if (kind === "campaigns") {
    const EmailCampaign = require("./models/EmailCampaign");
    const rows = await EmailCampaign.find({ user: req.user._id }).sort({ createdAt: -1 });
    const csv = toCsv(rows, [
      { key: "name" }, { key: "status" }, { key: "sent" }, { key: "opens" }, { key: "clicks" },
      { key: "createdAt", get: (r) => new Date(r.createdAt).toISOString() },
    ]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="email-campaigns-${Date.now()}.csv"`);
    return res.send(csv);
  }
  res.status(400).json({ error: "Unknown export kind. Use 'leads' or 'campaigns'." });
}));

// ---------- ADMIN ----------
app.get("/api/admin/users", authRequired, adminOnly, ah(async (_req, res) => {
  const users = await User.find({ role: { $ne: "admin" } }).sort({ createdAt: -1 });

  // attach lead count per user
  const counts = await Lead.aggregate([
    { $group: { _id: "$owner", count: { $sum: 1 } } },
  ]);
  const countMap = counts.reduce((a, c) => ((a[c._id.toString()] = c.count), a), {});
  const payload = users.map((u) => ({ ...u.toJSON(), leads: countMap[u._id.toString()] || 0 }));

  res.json({ users: payload });
}));

app.put("/api/admin/users/:id", authRequired, adminOnly, ah(async (req, res) => {
  const { password, _id, id, ...rest } = req.body || {};
  const user = await User.findByIdAndUpdate(req.params.id, rest, { new: true, runValidators: true });
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user: user.toJSON() });
}));

app.delete("/api/admin/users/:id", authRequired, adminOnly, ah(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.role === "admin") return res.status(400).json({ error: "Cannot delete admin" });
  await target.deleteOne();
  res.json({ deleted: req.params.id });
}));

app.get("/api/admin/stats", authRequired, adminOnly, ah(async (_req, res) => {
  const [
    allUsers, plans, openTickets, totalTickets,
    activeCampaigns, totalCampaigns, allLeads, recentTickets,
  ] = await Promise.all([
    User.find({ role: { $ne: "admin" } }),
    Plan.find(),
    Ticket.countDocuments({ status: "open" }),
    Ticket.countDocuments(),
    Campaign.countDocuments({ status: "active" }),
    Campaign.countDocuments(),
    Lead.find().select("createdAt status owner source value"),
    Ticket.find().sort({ updatedAt: -1 }).limit(5),
  ]);

  const priceByName = plans.reduce((a, p) => ((a[p.name] = p.price), a), {});
  const totalUsers  = allUsers.length;
  const activeUsers = allUsers.filter((u) => u.status === "active").length;
  const pausedUsers = allUsers.filter((u) => u.status === "paused").length;
  const mrr = allUsers.filter((u) => u.status === "active").reduce((s, u) => s + (priceByName[u.plan] || 0), 0);

  // Signups for last 14 days — bucket by ISO date key.
  const signupBuckets = Array.from({ length: 14 }).map((_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86400000);
    return { key: d.toISOString().slice(0, 10), label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }), value: 0 };
  });
  const ix = Object.fromEntries(signupBuckets.map((b, i) => [b.key, i]));
  for (const u of allUsers) {
    const k = new Date(u.createdAt).toISOString().slice(0, 10);
    if (ix[k] != null) signupBuckets[ix[k]].value++;
  }
  const newThisWeek = signupBuckets.slice(-7).reduce((s, d) => s + d.value, 0);

  // Platform leads in the last 7 days (bar chart).
  const leadsByDay = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(Date.now() - (6 - i) * 86400000);
    return { key: d.toISOString().slice(0, 10), label: d.toLocaleDateString("en-IN", { weekday: "short" }), value: 0 };
  });
  const lix = Object.fromEntries(leadsByDay.map((b, i) => [b.key, i]));
  for (const l of allLeads) {
    const k = new Date(l.createdAt).toISOString().slice(0, 10);
    if (lix[k] != null) leadsByDay[lix[k]].value++;
  }

  // Leads-this-month growth vs last-month for the stat chip.
  const now = Date.now();
  const leads30d = allLeads.filter((l) => now - new Date(l.createdAt).getTime() < 30 * 86400000).length;
  const leads60d = allLeads.filter((l) => {
    const age = now - new Date(l.createdAt).getTime();
    return age >= 30 * 86400000 && age < 60 * 86400000;
  }).length;
  const leadsMoMPct = leads60d ? Math.round(((leads30d - leads60d) / leads60d) * 100) : (leads30d ? 100 : 0);

  // Plan distribution (percentages).
  const planPalette = { Starter: "#6366f1", Growth: "#7c3aed", Pro: "#ec4899" };
  const planCounts = allUsers.reduce((acc, u) => ((acc[u.plan] = (acc[u.plan] || 0) + 1), acc), {});
  const planDistribution = Object.entries(planCounts).map(([label, count]) => ({
    label, count,
    value: totalUsers ? Math.round((count / totalUsers) * 100) : 0,
    color: planPalette[label] || "#9ca3af",
  }));

  // Platform-wide source breakdown (top 6 + Other).
  const sourcePalette = ["#7c3aed", "#ec4899", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444"];
  const sourceCounts = allLeads.reduce((acc, l) => ((acc[l.source || "Other"] = (acc[l.source || "Other"] || 0) + 1), acc), {});
  const sortedSources = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]);
  const top6  = sortedSources.slice(0, 6);
  const rest  = sortedSources.slice(6).reduce((s, [, v]) => s + v, 0);
  const totalLeadsCount = allLeads.length || 1;
  const sourceBreakdown = top6.map(([label, v], i) => ({
    label, count: v, value: Math.round((v / totalLeadsCount) * 100),
    color: sourcePalette[i % sourcePalette.length],
  }));
  if (rest > 0) sourceBreakdown.push({ label: "Other", count: rest, value: Math.round((rest / totalLeadsCount) * 100), color: "#9ca3af" });

  // Activity feed — mix recent signups and recent ticket updates so admins
  // always see something actionable without us building a dedicated audit log.
  const recentSignups = [...allUsers]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 3)
    .map((u) => ({
      kind: "signup",
      text: `New user signup — ${u.name} (${u.plan} plan)`,
      ts: u.createdAt,
    }));
  const ticketEvents = recentTickets.map((t) => ({
    kind: t.status === "resolved" ? "ticket_resolved" : "ticket_open",
    text: `Ticket #${t.code} — ${t.subject}`,
    ts: t.updatedAt || t.createdAt,
  }));
  const activity = [...recentSignups, ...ticketEvents]
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, 6);

  res.json({
    totals: {
      users: totalUsers, activeUsers, pausedUsers,
      mrr, leads: allLeads.length,
      openTickets, totalTickets,
      activeCampaigns, totalCampaigns,
      newThisWeek, leadsMoMPct,
      leads30d,
    },
    signupTrend: signupBuckets,
    leadsByDay,
    planDistribution,
    sourceBreakdown,
    activity,
  });
}));

// ---------- 404 + ERROR ----------
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

const PORT = Number(process.env.PORT) || 8080;

connectDB()
  .then(async () => {
    const count = await User.countDocuments();
    const server = http.createServer(app);
    socketService.init(server);
    server.listen(PORT, () => {
      console.log(`🚀 Leadnator API running on http://localhost:${PORT}`);
      console.log(`   Users in DB: ${count}. Run 'npm run seed' to seed demo data.`);
    });
  })
  .catch((err) => {
    console.error("Failed to start:", err.message);
    process.exit(1);
  });
