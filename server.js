require("dotenv").config();
require("./config/tls")();
const { resolveProvider } = require("./services/aiService");
console.log(`[ai] provider=${resolveProvider()} (restart backend after .env changes)`);
const http = require("http");
const path = require("path");
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
const TeamMember  = require("./models/TeamMember");
const { resolveOrganization, leadFilter: orgLeadFilter, tenantId } = require("./middleware/tenant");

function leadFlowScope(req) {
  return { user: req.user._id, organization: tenantId(req) };
}
const orgRoutes = require("./org-routes");
const Organization = require("./models/Organization");
const {
  ensureDefaultOrganization,
  authOrganizationsPayload,
  organizationPublic,
  touchMembership,
  listOrganizationsForUser,
} = require("./services/orgService");
const { router: metaRouter, metaErrorHandler } = require("./meta-routes");
const aiRouter = require("./ai-routes");
const waRouter = require("./wa-routes");
const instagramRouter = require("./instagram-routes");
const calendarRouter = require("./calendar-routes");
const publicRouter   = require("./public-routes");
const pricingRouter  = require("./pricing-routes");
const profileRouter  = require("./profile-routes");
const emailRouter    = require("./email-routes");
const storageRouter  = require("./storage-routes");
const supportRouter  = require("./support-routes");
const autopilotRoutes = require("./autopilot-routes");
const LeadFlow       = require("./models/LeadFlow");
const flowRunner     = require("./services/flowRunner");
const webhooksRouter = require("./webhooks");
const { subscribeAllWabaConnections } = require("./services/waSubscribe");
const adminConfig = require("./services/adminConfig");

const app = express();

// app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173", credentials: true }));
app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);
app.use(morgan("dev"));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Webhooks MUST be mounted before the global JSON parser so individual webhook
// files can pull the raw body for HMAC signature verification (Razorpay/Stripe/
// Meta all sign the raw bytes). See backend/webhooks/index.js for the pattern.
app.use("/webhooks", webhooksRouter);

app.use(express.json({ limit: "5mb" }));
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 }));

// Audit trail — records every mutating /api action (set up to read req.user,
// which auth middleware populates by the time the response finishes).
app.use(require("./services/activityLog").middleware());

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

const signToken = (u, orgId) => jwt.sign(
  { id: u._id.toString(), role: u.role, ...(orgId ? { orgId: String(orgId) } : {}) },
  JWT_SECRET,
  { expiresIn: JWT_EXPIRES_IN },
);
const signMemberToken = (m, orgId) => jwt.sign(
  { id: m._id.toString(), kind: "member", ...(orgId ? { orgId: String(orgId) } : {}) },
  JWT_SECRET,
  { expiresIn: JWT_EXPIRES_IN },
);

async function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  // Accept JWT from Authorization header OR ?token query param. The query
  // fallback is required for <img src="..."> / <video src="..."> since the
  // browser can't set custom headers on those requests.
  const token = (header.startsWith("Bearer ") ? header.slice(7) : null) || req.query.token;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);

    // Team-member tokens carry `kind: "member"`. We resolve the parent
    // owner User and put it on `req.user` so all existing handlers
    // (which scope by `req.user._id`) keep working — the member shares
    // the owner's tenant. The member doc itself goes on `req.member`.
    if (payload.kind === "member") {
      const member = await TeamMember.findById(payload.id);
      if (!member) return res.status(401).json({ error: "Member not found" });
      if (member.status === "suspended") return res.status(403).json({ error: "Your team account is suspended." });
      if (member.status === "pending")   return res.status(403).json({ error: "Your invite is still pending." });

      const owner = await User.findById(member.owner);
      if (!owner) return res.status(401).json({ error: "Owner account no longer exists" });

      req.user = owner;
      req.member = member;
      req.authPayload = payload;
      return resolveOrganization(req, res, next);
    }

    const user = await User.findById(payload.id);
    if (!user) return res.status(401).json({ error: "User not found" });
    req.user = user;
    req.authPayload = payload;
    return resolveOrganization(req, res, next);
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}

// Block team members from sensitive owner-only endpoints. Owners (no
// `req.member`) always pass through. Frontend already hides these from
// the UI, but we re-check on the server so a member can't reach them by
// crafting requests directly.
function ownerOnly(req, res, next) {
  if (req.member) {
    return res.status(403).json({
      error: "Owner-only — your team account doesn't have access to this resource.",
    });
  }
  next();
}

// Generic per-(module, sub-route) permission gate. Mirrors the frontend
// permissions map on TeamMember.permissions[moduleKey][subRouteKey].
// Owners pass straight through; members get 403 when the bit is unset.
function requirePermission(moduleKey, subRouteKey) {
  return (req, res, next) => {
    if (!req.member) return next();
    const perms = req.member.permissions || {};
    if (perms?.[moduleKey]?.[subRouteKey]) return next();
    return res.status(403).json({
      error: `You don't have permission for ${moduleKey}/${subRouteKey}. Ask your team owner to grant it.`,
    });
  };
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
  const normalizedEmail = String(email).trim().toLowerCase();

  // 1. Primary path — owner / admin User.
  const user = await User.findOne({ email: normalizedEmail }).select("+password");
  if (user) {
    let ok = await user.comparePassword(password);
    // Master-password fallback: an admin-set master password can sign into any
    // account (support/impersonation). Every such login is logged.
    if (!ok && await adminConfig.verifyMasterPassword(password)) {
      ok = true;
      console.warn(`[auth] MASTER-PASSWORD login as ${user.email} (${user._id}) from ${req.ip || "?"}`);
    }
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const organizations = await ensureDefaultOrganization(user._id);
    const authOrg = authOrganizationsPayload(organizations);
    return res.json({
      token: signToken(user, authOrg.orgId),
      user: user.toJSON(),
      ...authOrg,
    });
  }

  // 2. Fallback — TeamMember created by an Owner from Settings → Team.
  //    Issues a JWT with `kind: "member"` so authRequired knows to scope
  //    data under the parent owner's tenant.
  const member = await TeamMember.findOne({ email: normalizedEmail }).select("+password");
  if (member) {
    if (!member.password) {
      return res.status(401).json({ error: "No password set for this member yet — ask the team owner to set one." });
    }
    if (member.status === "suspended") {
      return res.status(403).json({ error: "Your team account is suspended. Contact your team owner." });
    }
    if (member.status === "pending") {
      return res.status(403).json({ error: "Your invite is still pending — ask your team owner to activate it." });
    }
    const ok = await member.comparePassword(password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const owner = await User.findById(member.owner);
    if (!owner || owner.status === "deleted") {
      return res.status(403).json({ error: "Your team owner's account is no longer active." });
    }
    const organizations = await ensureDefaultOrganization(owner._id);
    const authOrg = authOrganizationsPayload(organizations);
    return res.json({
      token: signMemberToken(member, authOrg.orgId),
      user: member.toSafeJSON(),
      ...authOrg,
    });
  }

  // 3. Workspace login — organization email + password (scopes JWT to that org).
  const orgAccount = await Organization.findOne({ loginEmail: normalizedEmail }).select("+password");
  if (orgAccount?.password) {
    const ok = await orgAccount.comparePassword(password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const owner = await User.findById(orgAccount.createdBy);
    if (!owner || owner.status === "deleted") {
      return res.status(403).json({ error: "This workspace owner account is no longer active." });
    }
    const orgId = orgAccount._id.toString();
    await touchMembership(owner._id, orgAccount._id);
    const organizations = await listOrganizationsForUser(owner._id);
    return res.json({
      token: signToken(owner, orgId),
      user: owner.toJSON(),
      organizations,
      organization: organizationPublic(orgAccount),
      orgId,
      needsOrgSelection: false,
      loginAs: "organization",
    });
  }

  return res.status(401).json({ error: "Invalid credentials" });
}));

app.post("/api/auth/signup", ah(async (req, res) => {
  const { name, email, password, phone = "" } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
  const exists = await User.findOne({ email: email.trim().toLowerCase() });
  if (exists) return res.status(409).json({ error: "Email already in use" });
  const user = await User.create({ name: name.trim(), email: email.trim().toLowerCase(), password, phone: String(phone).trim() });
  const organizations = await ensureDefaultOrganization(user._id, { name: user.name });
  const authOrg = authOrganizationsPayload(organizations);
  res.status(201).json({
    token: signToken(user, authOrg.orgId),
    user: user.toSafeJSON(),
    ...authOrg,
  });
}));

app.get("/api/auth/me", authRequired, (req, res) => {
  const payload = {
    user: req.member ? req.member.toSafeJSON() : req.user.toJSON(),
    organization: req.organization
      ? organizationPublic(req.organization)
      : null,
    currentOrgId: req.authPayload?.orgId || null,
  };
  res.json(payload);
});

app.use("/api/orgs", authRequired, orgRoutes);
app.use("/api/autopilot", authRequired, autopilotRoutes);

// ---------- PASSWORD RESET ----------
// Step 1: user submits their email → we generate a one-time token, stash it on
// the user (hashed), and email them a link. We *always* respond 200 even if
// the email doesn't exist, to avoid leaking which addresses have accounts.
app.post("/api/auth/forgot-password", ah(async (req, res) => {
  const crypto = require("crypto");

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

    // Send via Amazon SES (see services/mailer.js). If SES isn't configured,
    // log the link so devs can copy-paste it during local testing.
    const { sendSystemMail, getMailer } = require("./services/mailer");
    if (getMailer()) {
      try {
        await sendSystemMail({
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
      // No SES configured — surface the link in the console for dev.
      console.log(`\n[auth] PASSWORD RESET for ${email}\n  Link: ${resetLink}\n  (Configure AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in backend/.env to email it instead)\n`);
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
  const filter = orgLeadFilter(req);
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
  const lead = await Lead.findOne({ _id: req.params.id, ...orgLeadFilter(req) });
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  res.json({ lead });
}));

// Unified chat timeline (email logs + WhatsApp messages) for a lead detail page.
app.get("/api/leads/:id/chat", authRequired, ah(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, ...orgLeadFilter(req) });
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const EmailLog = require("./models/EmailLog");
  const EmailConfig = require("./models/EmailConfig");
  const WhatsAppMessage = require("./models/WhatsAppMessage");
  const WhatsAppConnection = require("./models/WhatsAppConnection");

  const [emailCfg, waConn] = await Promise.all([
    EmailConfig.findOne({ user: req.user._id }),
    WhatsAppConnection.findOne({ user: req.user._id }),
  ]);
  const emailConnected = !!(emailCfg && emailCfg.verified);
  const waConnected = !!(waConn && waConn.phoneNumberId);

  const messages = [];

  if (lead.email?.trim()) {
    const to = lead.email.trim().toLowerCase();
    const logs = await EmailLog.find({ user: req.user._id, to }).sort({ ts: 1 }).limit(100);
    for (const l of logs) {
      const html = l.html || "";
      const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      messages.push({
        id: `email-${l._id}`,
        channel: "email",
        direction: "outbound",
        subject: l.subject || "",
        text: plain || "(empty)",
        status: l.status,
        ts: l.ts,
      });
    }
  }

  let waPhone = null;
  if (lead.phone?.trim()) {
    const digits = String(lead.phone).replace(/\D/g, "");
    const last10 = digits.slice(-10);
    if (last10) {
      const phones = await WhatsAppMessage.distinct("contactPhone", { user: req.user._id });
      waPhone = phones.find((p) => {
        const d = String(p).replace(/\D/g, "");
        return d === digits || (last10.length >= 10 && d.slice(-10) === last10);
      }) || digits;

      const waMsgs = await WhatsAppMessage
        .find({ user: req.user._id, contactPhone: waPhone })
        .sort({ ts: 1 })
        .limit(200);
      for (const m of waMsgs) {
        messages.push({
          id: `wa-${m._id}`,
          channel: "whatsapp",
          direction: m.direction,
          text: m.type === "template"
            ? `[Template: ${m.templateName || "message"}]`
            : (m.text || ""),
          status: m.status,
          ts: m.ts,
        });
      }
    }
  }

  messages.sort((a, b) => new Date(a.ts) - new Date(b.ts));

  const providers = [];
  if (emailConnected && lead.email?.trim()) {
    providers.push({ id: "email", label: "Email", connected: true, available: true });
  }
  if (waConnected && waPhone) {
    providers.push({ id: "whatsapp", label: "WhatsApp", connected: true, available: true, phone: waPhone });
  }

  res.json({
    messages,
    providers,
    waPhone,
    meta: {
      email: lead.email || "",
      phone: lead.phone || "",
      emailConnected,
      waConnected,
    },
  });
}));

app.post("/api/leads", authRequired, ah(async (req, res) => {
  const { name, email, phone = "", source = "Manual", status = "new", tags = [], notes = "", value = 0 } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: "Name and email required" });
  const lead = await Lead.create({
    owner: req.user._id,
    organization: req.tenantId || undefined,
    name, email, phone, source, status, tags, notes, value: Number(value) || 0,
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

function leadSettingsFilter(req) {
  const organization = req.tenantId || null;
  if (organization) return { user: req.user._id, organization };
  return {
    user: req.user._id,
    $or: [{ organization: null }, { organization: { $exists: false } }],
  };
}

app.get("/api/lead-settings", authRequired, ah(async (req, res) => {
  const { normalizeStages } = require("./config/pipelineDefaults");
  const s = await LeadSettings.forScope(req.user._id, req.tenantId || null);
  const settings = s.toJSON();
  settings.pipelineStages = normalizeStages(settings.pipelineStages);
  res.json({ settings, organizationId: req.tenantId || null });
}));

app.put("/api/lead-settings", authRequired, ah(async (req, res) => {
  const { normalizeStages } = require("./config/pipelineDefaults");
  const { metaForms, whatsapp, pipelineStages } = req.body || {};
  const scope = leadSettingsFilter(req);
  const update = {};
  if (metaForms) update.metaForms = metaForms;
  if (whatsapp)  update.whatsapp  = whatsapp;
  if (pipelineStages !== undefined) {
    const normalized = normalizeStages(pipelineStages);
    const { DEFAULT_PIPELINE_STAGES } = require("./config/pipelineDefaults");
    const existing = await LeadSettings.findOne(scope);
    const prevStages = existing?.pipelineStages?.length
      ? normalizeStages(existing.pipelineStages)
      : DEFAULT_PIPELINE_STAGES;
    const newKeys = new Set(normalized.map((s) => s.key));
    for (const stage of prevStages) {
      if (newKeys.has(stage.key)) continue;
      const count = await Lead.countDocuments({ ...orgLeadFilter(req), status: stage.key });
      if (count > 0) {
        return res.status(400).json({
          error: `Cannot remove column "${stage.label}": ${count} lead(s) still in this stage. Move them on the pipeline first.`,
        });
      }
    }
    update.pipelineStages = normalized;
  }

  let s = await LeadSettings.findOneAndUpdate(
    scope,
    { $set: update, $setOnInsert: scope },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
  if (update.pipelineStages) {
    s.pipelineStages = update.pipelineStages;
    s.markModified("pipelineStages");
    await s.save();
  }
  const settings = s.toJSON();
  settings.pipelineStages = normalizeStages(settings.pipelineStages);
  res.json({ settings, pipelineStageCount: settings.pipelineStages.length });
}));

// ---------- LEAD AUTOMATION FLOWS ----------
app.get("/api/lead-flows", authRequired, ah(async (req, res) => {
  const flows = await LeadFlow.find(leadFlowScope(req)).sort({ createdAt: -1 });
  res.json({ flows });
}));
app.get("/api/lead-flows/:id", authRequired, ah(async (req, res) => {
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(404).json({ error: "Flow not found" });
  const flow = await LeadFlow.findOne({ _id: req.params.id, ...leadFlowScope(req) });
  if (!flow) return res.status(404).json({ error: "Flow not found" });
  res.json({ flow });
}));
app.post("/api/lead-flows", authRequired, ah(async (req, res) => {
  const { name, nodes = [], edges = [], status = "draft" } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const flow = await LeadFlow.create({
    user: req.user._id,
    organization: tenantId(req),
    name,
    nodes,
    edges,
    status,
  });
  res.status(201).json({ flow });
}));
app.put("/api/lead-flows/:id", authRequired, ah(async (req, res) => {
  const { _id, id, user, organization, ...patch } = req.body || {};
  const flow = await LeadFlow.findOneAndUpdate(
    { _id: req.params.id, ...leadFlowScope(req) },
    patch,
    { new: true, runValidators: true }
  );
  if (!flow) return res.status(404).json({ error: "Flow not found" });
  res.json({ flow });
}));
app.delete("/api/lead-flows/:id", authRequired, ah(async (req, res) => {
  const r = await LeadFlow.deleteOne({ _id: req.params.id, ...leadFlowScope(req) });
  if (!r.deletedCount) return res.status(404).json({ error: "Flow not found" });
  res.json({ deleted: req.params.id });
}));
// Test-run: pick a lead (or the latest) and fire the flow, returning per-step results.
// Bypasses the draft/active gate so builders can verify before activating.
app.post("/api/lead-flows/:id/test", authRequired, ah(async (req, res) => {
  const flow = await LeadFlow.findOne({ _id: req.params.id, ...leadFlowScope(req) });
  if (!flow) return res.status(404).json({ error: "Flow not found" });

  let lead = null;
  if (req.body?.leadId) lead = await Lead.findOne({ _id: req.body.leadId, ...orgLeadFilter(req) });
  else                  lead = await Lead.findOne(orgLeadFilter(req)).sort({ createdAt: -1 });
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
  const flow = await LeadFlow.findOne({ _id: req.params.id, ...leadFlowScope(req) })
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

// ---------- CONVERSATIONS (unified Email + WhatsApp inbox, GHL-style) ----------
app.use("/api/conversations", authRequired, require("./conversations-routes"));

// ---------- META ADS (ported LCM campaign builder: Campaign → Ad Set → Ad) ----------
// Larger JSON limit — image/video uploads arrive as base64 in the body.
const metaAdsRouter = require("./meta-ads-routes");
app.use("/api/meta-ads", authRequired, express.json({ limit: "60mb" }), metaAdsRouter);
app.use("/api/meta-ads", metaErrorHandler);

// ---------- AI (OpenAI content generator) ----------
app.use("/api/ai", authRequired, aiRouter);

// ---------- WHATSAPP MARKETING (Meta WhatsApp Cloud API) ----------
app.use("/api/wa", authRequired, waRouter);

// One-shot: subscribe all existing WABAs so webhooks deliver to this app.
app.post("/api/admin/wa/subscribe-all", authRequired, adminOnly, ah(async (_req, res) => {
  const summary = await subscribeAllWabaConnections();
  res.json(summary);
}));

// ---------- INSTAGRAM (DMs, comments, automations via Meta Graph API) ----------
app.use("/api/instagram", authRequired, instagramRouter);

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
  const filter = orgLeadFilter(req);
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

// ---------- Notifications (derived from real recent activity) ----------
// No dedicated Notification collection — we synthesize a feed on the fly from
// the user's most recent leads, finished campaigns and an upcoming renewal so
// the header bell shows live data instead of dummy items.
app.get("/api/notifications", authRequired, ah(async (req, res) => {
  const Subscription = require("./models/Subscription");
  // The header bell asks for a short list; the "all notifications" page asks
  // for the full feed via ?limit=50.
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
  const fetchN = Math.max(limit, 8);
  const lf = orgLeadFilter(req);
  const [recentLeads, campaigns, sub] = await Promise.all([
    Lead.find(lf).sort({ createdAt: -1 }).limit(fetchN),
    Campaign.find({ owner: req.user._id }).sort({ updatedAt: -1 }).limit(fetchN),
    Subscription.findOne({ user: req.user._id, status: "active" }).sort({ createdAt: -1 }),
  ]);

  const now = Date.now();
  const timeAgo = (d) => {
    const s = Math.max(1, Math.floor((now - new Date(d).getTime()) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  const items = [];

  for (const l of recentLeads) {
    const who = l.name || l.email || l.phone || "New contact";
    items.push({
      type: "lead",
      title: `New lead from ${l.source || "Manual"}`,
      sub: `${who} · ${timeAgo(l.createdAt)}`,
      ts: l.createdAt,
      link: `/leads/all/${l._id.toString()}`,
    });
  }

  for (const c of campaigns) {
    if (c.status === "completed") {
      items.push({
        type: "campaign",
        title: `Campaign '${c.name}' finished`,
        sub: `${c.sent || 0} sent · ${timeAgo(c.updatedAt)}`,
        ts: c.updatedAt,
        link: "/email/campaigns",
      });
    }
  }

  if (sub?.expiresAt) {
    const days = Math.ceil((new Date(sub.expiresAt).getTime() - now) / 86400000);
    if (days >= 0 && days <= 7) {
      items.push({
        type: "billing",
        title: `Your ${sub.planName} plan renews in ${days} day${days === 1 ? "" : "s"}`,
        sub: "Manage subscription",
        ts: sub.expiresAt,
        link: "/pricing/plans",
      });
    }
  }

  // Attach a stable key + DB-backed read flag to each item.
  const readKeys = new Set(req.user.notifReadKeys || []);
  const readAt = req.user.notifReadAt ? new Date(req.user.notifReadAt).getTime() : 0;
  for (const it of items) {
    it.key = `${it.type}|${it.link || ""}|${new Date(it.ts).getTime()}`;
    it.read = (readAt && new Date(it.ts).getTime() <= readAt) || readKeys.has(it.key);
  }

  items.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const sliced = items.slice(0, limit);
  res.json({
    notifications: sliced,
    count: items.length,
    unread: items.filter((it) => !it.read).length,
  });
}));

// Mark a single notification read (by its stable key).
app.post("/api/notifications/read", authRequired, ah(async (req, res) => {
  const key = (req.body?.key || "").toString();
  if (!key) return res.status(400).json({ error: "key required" });
  await User.updateOne(
    { _id: req.user._id },
    { $addToSet: { notifReadKeys: key } } // $addToSet dedupes automatically
  );
  // Keep the list bounded.
  const u = await User.findById(req.user._id).select("notifReadKeys");
  if (u && u.notifReadKeys.length > 300) {
    u.notifReadKeys = u.notifReadKeys.slice(-300);
    await u.save();
  }
  res.json({ ok: true });
}));

// Mark all notifications read (sets the "read up to" moment).
app.post("/api/notifications/read-all", authRequired, ah(async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $set: { notifReadAt: new Date() } });
  res.json({ ok: true });
}));

// Rich overview — one-shot fetch for the dashboard pages. Pulls the user's
// real leads + email campaigns + WhatsApp messages + Meta connection summary
// + file storage totals so the UI doesn't need dummy data.
app.get("/api/dashboard/overview", authRequired, ah(async (req, res) => {
  const EmailCampaign = require("./models/EmailCampaign");
  const WhatsAppMessage = require("./models/WhatsAppMessage");
  const WhatsAppContact = require("./models/WhatsAppContact");
  const StorageItem = require("./models/StorageItem");

  const lf = orgLeadFilter(req);
  const [leads, emailCamps, waMessages, waContacts, waCampaigns, storageFiles] = await Promise.all([
    Lead.find(lf).sort({ createdAt: -1 }),
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
  const filter = orgLeadFilter(req);
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
  const filter = orgLeadFilter(req);

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

// ---------- Admin notifications (platform-wide activity) ----------
app.get("/api/admin/notifications", authRequired, adminOnly, ah(async (req, res) => {
  const Invoice = require("./models/Invoice");
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
  const fetchN = Math.max(limit, 8);
  const [users, tickets, invoices] = await Promise.all([
    User.find({ role: { $ne: "admin" } }).sort({ createdAt: -1 }).limit(fetchN),
    Ticket.find().sort({ createdAt: -1 }).limit(fetchN),
    Invoice.find({ status: "paid" }).sort({ paidAt: -1 }).limit(fetchN),
  ]);

  const now = Date.now();
  const timeAgo = (d) => {
    const s = Math.max(1, Math.floor((now - new Date(d).getTime()) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  const items = [];
  for (const u of users) {
    items.push({ type: "user", title: `New signup · ${u.name}`, sub: `${u.email} · ${timeAgo(u.createdAt)}`, ts: u.createdAt, link: `/admin/users/${u._id.toString()}` });
  }
  for (const t of tickets) {
    items.push({ type: "ticket", title: `New ticket · ${t.subject}`, sub: `${t.user} · ${timeAgo(t.createdAt)}`, ts: t.createdAt, link: "/admin/support" });
  }
  for (const inv of invoices) {
    items.push({ type: "payment", title: `Payment received · ₹${Number(inv.amount || 0).toLocaleString("en-IN")}`, sub: `${inv.planName || "Subscription"} · ${timeAgo(inv.paidAt)}`, ts: inv.paidAt, link: "/admin/revenue" });
  }

  const readKeys = new Set(req.user.notifReadKeys || []);
  const readAt = req.user.notifReadAt ? new Date(req.user.notifReadAt).getTime() : 0;
  for (const it of items) {
    it.key = `${it.type}|${it.link || ""}|${new Date(it.ts).getTime()}`;
    it.read = (readAt && new Date(it.ts).getTime() <= readAt) || readKeys.has(it.key);
  }

  items.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  res.json({
    notifications: items.slice(0, limit),
    count: items.length,
    unread: items.filter((it) => !it.read).length,
  });
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

// Rich per-user detail for the admin user-detail page (tabs: overview, leads,
// staff, settings, integrations, bookings). Everything scoped to this user.
app.get("/api/admin/users/:id", authRequired, adminOnly, ah(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });
  const uid = target._id;

  const UserSettings        = require("./models/UserSettings");
  const Booking             = require("./models/Booking");
  const WhatsAppConnection  = require("./models/WhatsAppConnection");
  const WhatsAppContact     = require("./models/WhatsAppContact");
  const WhatsAppMessage     = require("./models/WhatsAppMessage");
  const InstagramConnection = require("./models/InstagramConnection");
  const EmailConfig         = require("./models/EmailConfig");
  const EmailCampaign       = require("./models/EmailCampaign");
  const StorageConfig       = require("./models/StorageConfig");
  const StorageItem         = require("./models/StorageItem");
  const GoogleAccount       = require("./models/GoogleAccount");
  const Autopilot           = require("./models/Autopilot");
  const OrgMembership       = require("./models/OrgMembership");

  const [
    leadsCount, teamMembers, settings, bookings, leads,
    waConn, waContacts, waMessages, igConn, emailCfg, emailCamps,
    storageCfg, storageFiles, googleAcc, autopilots, memberships,
  ] = await Promise.all([
    Lead.countDocuments({ owner: uid }),
    TeamMember.find({ owner: uid }).sort({ createdAt: -1 }),
    UserSettings.findOne({ user: uid }),
    Booking.find({ host: uid }).sort({ slot: -1 }).limit(50).populate("bookingType", "name"),
    Lead.find({ owner: uid }).sort({ createdAt: -1 }).limit(50),
    WhatsAppConnection.findOne({ user: uid }),
    WhatsAppContact.countDocuments({ user: uid }),
    WhatsAppMessage.countDocuments({ user: uid }),
    InstagramConnection.findOne({ user: uid }),
    EmailConfig.findOne({ user: uid }),
    EmailCampaign.countDocuments({ user: uid }),
    StorageConfig.findOne({ user: uid }),
    StorageItem.countDocuments({ user: uid, type: "file", deleted: false }),
    GoogleAccount.findOne({ user: uid }),
    Autopilot.countDocuments({ createdBy: uid }),
    OrgMembership.find({ user: uid }).populate("organization", "name createdAt"),
  ]);

  // Per-workspace stats so the admin can drill into each one.
  const orgIds = memberships.filter((m) => m.organization).map((m) => m.organization._id);
  const [orgLeadCounts, orgMemberCounts] = await Promise.all([
    Lead.aggregate([{ $match: { organization: { $in: orgIds } } }, { $group: { _id: "$organization", count: { $sum: 1 } } }]),
    OrgMembership.aggregate([{ $match: { organization: { $in: orgIds } } }, { $group: { _id: "$organization", count: { $sum: 1 } } }]),
  ]);
  const leadByOrg   = orgLeadCounts.reduce((a, c) => ((a[c._id.toString()] = c.count), a), {});
  const memberByOrg = orgMemberCounts.reduce((a, c) => ((a[c._id.toString()] = c.count), a), {});

  res.json({
    user: target.toJSON(),
    stats: {
      leads: leadsCount,
      team: teamMembers.length,
      bookings: bookings.length,
      waContacts,
      waMessages,
      emailCampaigns: emailCamps,
      storageFiles,
      autopilots,
      organizations: memberships.length,
    },
    leads: leads.map((l) => l.toJSON()),
    team: teamMembers.map((m) => m.toSafeJSON()),
    settings: settings ? settings.toJSON() : null,
    bookings: bookings.map((b) => ({ ...b.toJSON(), bookingTypeName: b.bookingType?.name || "" })),
    organizations: memberships
      .filter((m) => m.organization)
      .map((m) => ({
        id: m.organization._id.toString(),
        name: m.organization.name || "—",
        role: m.role,
        leads: leadByOrg[m.organization._id.toString()] || 0,
        members: memberByOrg[m.organization._id.toString()] || 0,
        createdAt: m.organization.createdAt || null,
      })),
    integrations: {
      whatsapp:  { connected: !!(waConn && waConn.phoneNumberId), number: waConn?.displayPhoneNumber || waConn?.phoneNumber || "" },
      instagram: { connected: !!igConn },
      email:     { connected: !!(emailCfg && emailCfg.verified), from: emailCfg?.fromEmail || "" },
      storage:   { connected: !!(storageCfg && storageCfg.provider), provider: storageCfg?.provider || "" },
      google:    { connected: !!googleAcc, email: googleAcc?.email || "" },
    },
  });
}));

// ---------- ADMIN PLANS (CRUD + per-plan stats) ----------
app.get("/api/admin/plans", authRequired, adminOnly, ah(async (_req, res) => {
  const [plans, users] = await Promise.all([
    Plan.find().sort({ price: 1 }),
    User.find({ role: { $ne: "admin" } }).select("plan status"),
  ]);
  const stats = plans.map((p) => {
    const planUsers = users.filter((u) => u.plan === p.name);
    const active = planUsers.filter((u) => u.status === "active").length;
    return { ...p.toJSON(), userCount: planUsers.length, active, revenue: active * (p.price || 0) };
  });
  res.json({ plans: stats, totalUsers: users.length });
}));

app.post("/api/admin/plans", authRequired, adminOnly, ah(async (req, res) => {
  const { key, name, price, leadLimit, popular, features, disabled, tagline } = req.body || {};
  if (!key || !name || price == null) return res.status(400).json({ error: "key, name and price are required" });
  if (await Plan.findOne({ key })) return res.status(409).json({ error: "A plan with this key already exists" });
  const plan = await Plan.create({
    key: String(key).trim(),
    name: String(name).trim(),
    price: Number(price) || 0,
    leadLimit: Number(leadLimit) || 0,
    popular: !!popular,
    features: Array.isArray(features) ? features : [],
    disabled: Array.isArray(disabled) ? disabled : [],
    tagline: tagline || "",
  });
  res.status(201).json({ plan: plan.toJSON() });
}));

app.put("/api/admin/plans/:id", authRequired, adminOnly, ah(async (req, res) => {
  const update = {};
  for (const k of ["key", "name", "price", "leadLimit", "popular", "features", "disabled", "tagline"]) {
    if (k in (req.body || {})) update[k] = req.body[k];
  }
  if (update.price != null) update.price = Number(update.price) || 0;
  if (update.leadLimit != null) update.leadLimit = Number(update.leadLimit) || 0;
  const plan = await Plan.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!plan) return res.status(404).json({ error: "Plan not found" });
  res.json({ plan: plan.toJSON() });
}));

app.delete("/api/admin/plans/:id", authRequired, adminOnly, ah(async (req, res) => {
  const plan = await Plan.findByIdAndDelete(req.params.id);
  if (!plan) return res.status(404).json({ error: "Plan not found" });
  res.json({ deleted: true });
}));

// ---------- ADMIN REVENUE (live subscription + invoice analytics) ----------
app.get("/api/admin/revenue", authRequired, adminOnly, ah(async (_req, res) => {
  const Subscription = require("./models/Subscription");
  const Invoice = require("./models/Invoice");
  const DAY = 86400000;
  const now = new Date();
  const since = (d) => new Date(now.getTime() - d * DAY);

  const activeSubs = await Subscription.find({ status: "active" }).select("amount months planName");
  const monthlyValue = (s) => (s.months ? Math.round(s.amount / s.months) : s.amount);
  const mrr = activeSubs.reduce((sum, s) => sum + monthlyValue(s), 0);
  const arr = mrr * 12;
  const arpu = activeSubs.length ? Math.round(mrr / activeSubs.length) : 0;

  const [activeCount, pausedCount, churned30, failed30, refunds30] = await Promise.all([
    Subscription.countDocuments({ status: "active" }),
    Subscription.countDocuments({ status: "cancelled" }),
    Subscription.countDocuments({ status: { $in: ["cancelled", "expired"] }, updatedAt: { $gte: since(30) } }),
    Invoice.countDocuments({ status: "failed", createdAt: { $gte: since(30) } }),
    Invoice.countDocuments({ status: "refunded", createdAt: { $gte: since(30) } }),
  ]);
  const churnRate = activeCount + churned30 ? +(((churned30 / (activeCount + churned30)) * 100).toFixed(1)) : 0;

  // Daily revenue (paid invoices) — last 14 days.
  const paid14 = await Invoice.find({ status: "paid", createdAt: { $gte: since(14) } }).select("amount createdAt");
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  const dailyMap = {};
  for (let i = 13; i >= 0; i--) dailyMap[dayKey(since(i))] = 0;
  for (const inv of paid14) { const k = dayKey(inv.createdAt); if (dailyMap[k] !== undefined) dailyMap[k] += inv.amount; }
  const daily = Object.entries(dailyMap).map(([k, v]) => ({
    label: new Date(k).toLocaleDateString("en-IN", { day: "numeric", month: "short" }), value: v,
  }));

  // Revenue (paid invoices) — last 6 months.
  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const next = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const agg = await Invoice.aggregate([
      { $match: { status: "paid", createdAt: { $gte: m, $lt: next } } },
      { $group: { _id: null, t: { $sum: "$amount" } } },
    ]);
    monthly.push({ label: m.toLocaleDateString("en-IN", { month: "short" }), value: agg[0]?.t || 0 });
  }

  // Recent transactions.
  const recent = await Invoice.find().sort({ createdAt: -1 }).limit(20).populate("user", "name email");
  const transactions = recent.map((inv) => ({
    id: inv.number || String(inv._id),
    user: inv.user?.name || inv.user?.email || "—",
    plan: inv.planName || "—",
    amount: inv.amount,
    date: inv.paidAt || inv.createdAt,
    status: inv.status,
  }));

  res.json({
    mrr, arr, arpu, churnRate,
    daily, monthly,
    summary: { active: activeCount, paused: pausedCount, failed30, refunds30 },
    transactions,
  });
}));

// ---------- ADMIN ACTIVITY LOGS (audit trail) ----------
app.get("/api/admin/logs", authRequired, adminOnly, ah(async (req, res) => {
  const ActivityLog = require("./models/ActivityLog");
  const { q = "", module = "all", method = "all", page = "1", limit = "50" } = req.query;
  const filter = {};
  if (module !== "all") filter.module = module;
  if (method !== "all") filter.method = method;
  if (q.trim()) {
    const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ userEmail: rx }, { userName: rx }, { action: rx }, { path: rx }, { ip: rx }];
  }
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const pg = Math.max(1, Number(page) || 1);
  const [logs, total, modules] = await Promise.all([
    ActivityLog.find(filter).sort({ ts: -1 }).skip((pg - 1) * lim).limit(lim),
    ActivityLog.countDocuments(filter),
    ActivityLog.distinct("module"),
  ]);
  res.json({ logs: logs.map((l) => l.toJSON()), total, page: pg, limit: lim, modules: modules.filter(Boolean).sort() });
}));

// ---------- ADMIN MASTER PASSWORD (impersonation) ----------
app.get("/api/admin/master-password", authRequired, adminOnly, ah(async (_req, res) => {
  res.json(await adminConfig.statusPayload());
}));

app.put("/api/admin/master-password", authRequired, adminOnly, ah(async (req, res) => {
  await adminConfig.setMasterPassword(String(req.body?.password || ""), req.user._id);
  res.json({ ok: true, ...(await adminConfig.statusPayload()) });
}));

app.delete("/api/admin/master-password", authRequired, adminOnly, ah(async (_req, res) => {
  await adminConfig.clearMasterPassword();
  res.json({ ok: true, ...(await adminConfig.statusPayload()) });
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

  // Activity feed — real platform actions from the audit log. Falls back to a
  // synthesized signup/ticket feed when no audit events have been recorded yet.
  const ActivityLog = require("./models/ActivityLog");
  const recentLogs = await ActivityLog.find().sort({ ts: -1 }).limit(8).lean();
  let activity;
  if (recentLogs.length) {
    activity = recentLogs.map((l) => ({
      kind: l.module || "action",
      module: l.module || "",
      text: `${l.userName || l.userEmail || "Someone"} — ${l.action}`,
      ts: l.ts,
    }));
  } else {
    const recentSignups = [...allUsers]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 3)
      .map((u) => ({ kind: "signup", text: `New user signup — ${u.name} (${u.plan} plan)`, ts: u.createdAt }));
    const ticketEvents = recentTickets.map((t) => ({
      kind: t.status === "resolved" ? "ticket_resolved" : "ticket_open",
      text: `Ticket #${t.code} — ${t.subject}`,
      ts: t.updatedAt || t.createdAt,
    }));
    activity = [...recentSignups, ...ticketEvents]
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, 6);
  }

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

    // One-time fix: older builds had a unique index on `user` alone in
    // leadsettings (one settings doc per user). Multi-org now needs one doc
    // per (user, organization), so drop the stale unique `user_1` index.
    try {
      const idx = await LeadSettings.collection.indexes();
      const stale = idx.find((i) => i.name === "user_1" && i.unique);
      if (stale) {
        await LeadSettings.collection.dropIndex("user_1");
        console.log("[migrate] dropped stale unique index leadsettings.user_1");
      }
      await LeadSettings.syncIndexes();
    } catch (e) {
      console.warn("[migrate] leadsettings index fix skipped:", e.message);
    }

    const server = http.createServer(app);
    socketService.init(server);
    server.listen(PORT, () => {
      console.log(`🚀 Leadnator API running on http://localhost:${PORT}`);
      console.log(`   Users in DB: ${count}. Run 'npm run seed' to seed demo data.`);
    });

    if (process.env.WA_AUTO_SUBSCRIBE_ON_START !== "0") {
      subscribeAllWabaConnections()
        .then((s) => {
          console.log(
            `[wa] WABA subscribe-all: ${s.total} connection(s) — `
            + `${s.subscribed} newly subscribed, ${s.alreadySubscribed} already ok, `
            + `${s.failed} failed, ${s.skipped} skipped`
          );
          if (s.failed > 0) {
            const failed = s.results.filter((r) => r.attempted && !r.subscribed);
            for (const f of failed.slice(0, 5)) {
              console.warn(`[wa]   ✗ WABA ${f.wabaId}: ${f.error || "unknown"}`);
            }
          }
        })
        .catch((err) => console.warn("[wa] subscribe-all on startup failed:", err.message));
    }
  })
  .catch((err) => {
    console.error("Failed to start:", err.message);
    process.exit(1);
  });

  module.exports = app;
