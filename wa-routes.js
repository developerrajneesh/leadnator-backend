// WhatsApp Marketing routes — proxies the Meta WhatsApp Cloud Graph API
// and stores per-user contacts/campaigns/messages in MongoDB.

const express = require("express");
const axios = require("axios");
const multer = require("multer");
const FormData = require("form-data");
const WhatsAppConnection = require("./models/WhatsAppConnection");
const WhatsAppContact    = require("./models/WhatsAppContact");
const WhatsAppCampaign   = require("./models/WhatsAppCampaign");
const WhatsAppMessage    = require("./models/WhatsAppMessage");
const WhatsAppFlow       = require("./models/WhatsAppFlow");
const WhatsAppChatbot    = require("./models/WhatsAppChatbot");
const WhatsAppLabel      = require("./models/WhatsAppLabel");
const { emitToUser }     = require("./services/socket");
const { tenantId }       = require("./middleware/tenant");
const {
  onWaPhoneNumberChange,
  repairInboxAfterPhoneChange,
  stripAllLineTags,
  inboxLineMatch,
  contactScope,
} = require("./services/waScope");
const { ensureWabaSubscribed } = require("./services/waSubscribe");

const FB_API_VERSION = process.env.META_API_VERSION || "v23.0";
const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_API_VERSION}`;

const router = express.Router();

// Meta's limits: images 5MB, video 16MB, audio 16MB, document 100MB, sticker 500KB.
// We use 100MB as the generous upper bound; Meta itself enforces per-type limits.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

async function fb({ method, url, params, data, token }) {
  const res = await axios({
    method, url, data,
    params: { ...(params || {}), access_token: token },
    validateStatus: () => true,
  });
  if (res.status >= 200 && res.status < 300) return res.data;
  const fbErr = res.data?.error || { message: res.statusText, code: res.status };
  // Prefer Meta's user-friendly message, fall back to the technical one.
  const friendly = fbErr.error_user_msg || fbErr.message || "WhatsApp API error";
  const e = new Error(friendly);
  e.status = res.status;
  e.fb = fbErr;
  throw e;
}

function defaultRegisterPin() {
  return String(process.env.WHATSAPP_REGISTER_PIN || "000000").trim() || "000000";
}

function phoneNeedsRegistration(phoneInfo = {}) {
  const status = String(phoneInfo.status || "").toLowerCase();
  const codeStatus = String(phoneInfo.code_verification_status || "").toLowerCase();
  if (status === "pending") return true;
  if (codeStatus === "not_verified" || codeStatus === "pending") return true;
  return false;
}

function isAlreadyRegisteredError(err) {
  const msg = String(err?.message || "").toLowerCase();
  const code = err?.fb?.code;
  return code === 133016
    || msg.includes("already registered")
    || msg.includes("already been registered");
}

/** POST /{phone-number-id}/register — activates Cloud API on a new/pending number. */
async function registerWhatsAppPhone(phoneNumberId, accessToken, pin) {
  return fb({
    method: "post",
    url: `${FB_GRAPH_BASE}/${phoneNumberId}/register`,
    data: {
      messaging_product: "whatsapp",
      pin: String(pin || defaultRegisterPin()),
    },
    token: accessToken,
  });
}

/**
 * Register a WhatsApp business phone when newly connected or Meta reports pending.
 * Best-effort — connect succeeds even if register fails (e.g. wrong PIN).
 */
async function ensureWhatsAppPhoneRegistered(conn, { force = false, pin } = {}) {
  const phoneNumberId = conn?.phoneNumberId;
  const accessToken = conn?.accessToken;
  if (!phoneNumberId || !accessToken) {
    return { attempted: false, registered: false, reason: "missing credentials" };
  }

  const registerPin = pin || defaultRegisterPin();

  if (!force) {
    try {
      const preview = await fb({
        method: "get",
        url: `${FB_GRAPH_BASE}/${phoneNumberId}`,
        params: { fields: "status,code_verification_status" },
        token: accessToken,
      });
      if (!phoneNeedsRegistration(preview)) {
        return { attempted: false, registered: false, status: preview.status };
      }
    } catch {
      /* If status check fails on a forced-new connect, still try register below. */
      if (!force) return { attempted: false, registered: false, reason: "status check failed" };
    }
  }

  try {
    const result = await registerWhatsAppPhone(phoneNumberId, accessToken, registerPin);
    return { attempted: true, registered: true, result };
  } catch (err) {
    if (isAlreadyRegisteredError(err)) {
      return { attempted: true, registered: true, alreadyRegistered: true };
    }
    return { attempted: true, registered: false, error: err.message, fb: err.fb };
  }
}

// Meta rejects buttons that contain emoji, variables, newlines, or formatting.
// Strip them automatically so a copy-pasted "✅ Confirm" still works.
function cleanButtonText(text = "") {
  return String(text)
    // remove emoji + symbol blocks
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}]/gu, "")
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, "")  // zero-width / RTL controls
    .replace(/\{\{[^}]+\}\}/g, "")                  // variables not allowed
    .replace(/[\r\n\t]+/g, " ")                     // no newlines / tabs
    .replace(/[*_~`]/g, "")                         // no markdown formatting
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 25);                                  // Meta caps at 25 chars
}

function orgConnFilter(req) {
  return { organization: tenantId(req) };
}

/** WhatsApp automation flows are scoped per organization (not shared across orgs). */
function flowScope(req) {
  return { user: req.user._id, organization: tenantId(req) };
}

async function loadConnection(req) {
  const tid = tenantId(req);
  let conn = await WhatsAppConnection.findOne({ organization: tid }).select("+accessToken +webhookVerifyToken");
  if (!conn) {
    conn = await WhatsAppConnection.findOne({
      user: req.user._id,
      $or: [{ organization: null }, { organization: { $exists: false } }],
    }).select("+accessToken +webhookVerifyToken");
  }
  return conn;
}

async function inboxScope(req) {
  const conn = await loadConnection(req);
  if (!conn?.phoneNumberId) return null;
  const phoneNumberId = String(conn.phoneNumberId);
  const inboxSince = conn.inboxSince || conn.connectedAt;
  return {
    conn,
    match: inboxLineMatch(req.user._id, phoneNumberId, inboxSince),
    phoneNumberId,
    inboxSince,
    displayPhone: conn.phoneNumber || "",
  };
}

// Pull fresh phone + WABA details from Meta Graph and cache them on the
// WhatsAppConnection doc. Returns { phone, waba, phoneNumbers, warnings }.
// Every Graph call is guarded individually so a single permission gap
// doesn't wipe out the rest of the payload.
async function fetchAndCacheAccountInfo(conn) {
  const token = conn.accessToken;
  const warnings = [];

  const phoneTiers = [
    ["id", "display_phone_number", "verified_name", "quality_rating",
     "code_verification_status", "name_status", "new_name_status"],
    ["platform_type", "throughput", "messaging_limit_tier", "account_mode"],
    ["is_official_business_account", "is_pin_enabled", "status", "search_visibility"],
  ];
  let phone = {};
  for (const fields of phoneTiers) {
    try {
      const part = await fb({
        method: "get",
        url: `${FB_GRAPH_BASE}/${conn.phoneNumberId}`,
        params: { fields: fields.join(",") },
        token,
      });
      Object.assign(phone, part);
    } catch (e) {
      const code = e.fb?.code || e.fb?.error_subcode || e.status;
      warnings.push({ field: `phone:${fields.join(",")}`, message: `${code ? `[${code}] ` : ""}${e.message}` });
    }
  }
  if (Object.keys(phone).length === 0) phone = null;

  if (phone && phoneNeedsRegistration(phone)) {
    const reg = await ensureWhatsAppPhoneRegistered(conn, { force: true });
    if (reg.registered) {
      try {
        const refreshed = await fb({
          method: "get",
          url: `${FB_GRAPH_BASE}/${conn.phoneNumberId}`,
          params: { fields: "status,code_verification_status,display_phone_number,verified_name,quality_rating" },
          token,
        });
        Object.assign(phone, refreshed);
      } catch (e) {
        warnings.push({ field: "register:refresh", message: e.message });
      }
    } else if (reg.attempted && reg.error) {
      warnings.push({ field: "register", message: reg.error });
    }
  }

  // Meta bundles all-or-nothing — if ONE requested field fails
  // permission check, the whole call returns an error. So split into
  // tiers: cheap public fields first, then management-scope fields.
  let waba = null;
  if (conn.businessAccountId) {
    const fieldTiers = [
      ["id", "name", "currency", "timezone_id", "message_template_namespace"],
      ["business_verification_status"],
      ["primary_funding_id"],
      ["owner_business_info"],
      ["on_behalf_of_business_info"],
    ];
    waba = {};
    for (const fields of fieldTiers) {
      try {
        const part = await fb({
          method: "get",
          url: `${FB_GRAPH_BASE}/${conn.businessAccountId}`,
          params: { fields: fields.join(",") },
          token,
        });
        Object.assign(waba, part);
      } catch (e) {
        const code = e.fb?.code || e.fb?.error_subcode || e.status;
        warnings.push({ field: `waba:${fields.join(",")}`, message: `${code ? `[${code}] ` : ""}${e.message}` });
      }
    }
    if (Object.keys(waba).length === 0) waba = null;
  }

  let phoneNumbers = [];
  if (conn.businessAccountId) {
    try {
      const list = await fb({
        method: "get",
        url: `${FB_GRAPH_BASE}/${conn.businessAccountId}/phone_numbers`,
        params: {
          fields: [
            "id", "display_phone_number", "verified_name",
            "quality_rating", "messaging_limit_tier", "code_verification_status",
            "platform_type", "status", "name_status",
          ].join(","),
        },
        token,
      });
      phoneNumbers = list?.data || [];
    } catch (e) { warnings.push({ field: "phone_numbers", message: e.message }); }
  }

  const businessId =
    waba?.owner_business_info?.id ||
    waba?.on_behalf_of_business_info?.id ||
    "";
  const businessName =
    waba?.owner_business_info?.name ||
    waba?.on_behalf_of_business_info?.name ||
    "";

  // Only overwrite a DB field when Meta actually returned something
  // for it — don't clobber a good cached value with "" because of a
  // transient permissions hiccup.
  const assign = (target, key, value) => {
    if (value === undefined || value === null || value === "") return;
    target[key] = value;
  };

  if (phone) {
    assign(conn, "phoneNumber",              phone.display_phone_number);
    assign(conn, "verifiedName",             phone.verified_name);
    assign(conn, "quality",                  phone.quality_rating);
    assign(conn, "phoneCodeVerification",    phone.code_verification_status);
    assign(conn, "phoneNameStatus",          phone.name_status || phone.new_name_status);
    assign(conn, "phonePlatformType",        phone.platform_type);
    assign(conn, "phoneThroughputLevel",     phone.throughput?.level);
    assign(conn, "phoneMessagingLimitTier",  phone.messaging_limit_tier);
    assign(conn, "phoneAccountMode",         phone.account_mode);
    assign(conn, "phoneStatus",              phone.status);
    if (typeof phone.is_official_business_account === "boolean") {
      conn.phoneIsOfficial = phone.is_official_business_account;
    }
  }
  if (waba) {
    assign(conn, "wabaName",                 waba.name);
    assign(conn, "wabaCurrency",             waba.currency);
    assign(conn, "wabaTimezoneId",           waba.timezone_id);
    assign(conn, "wabaBusinessVerification", waba.business_verification_status);
    assign(conn, "wabaTemplateNamespace",    waba.message_template_namespace);
    assign(conn, "businessId",               businessId);
    assign(conn, "businessName",             businessName);
  }
  conn.infoRefreshedAt = new Date();
  conn.lastInfoWarnings = warnings;
  await conn.save();

  return { phone, waba: waba ? { ...waba, businessId, businessName } : null, phoneNumbers, warnings };
}

// Probe whether a phone number is reachable on WhatsApp. Meta's Cloud API
// does not expose a dedicated validation endpoint, so we call the legacy
// `/{PHONE_NUMBER_ID}/contacts` probe which still works on most setups.
// Returns:
//   { isOnWhatsapp: true|false, waId }  on a clear answer
//   { isOnWhatsapp: null }                on any error (endpoint gone, auth
//                                          failed, rate limit, etc.). The
//                                          status is considered "unknown"
//                                          and will be updated later when
//                                          the first message flows in/out.
async function checkIsOnWhatsapp(conn, phone) {
  const clean = String(phone || "").replace(/[^\d+]/g, "");
  if (!clean || !conn?.phoneNumberId || !conn?.accessToken) return { isOnWhatsapp: null };
  try {
    const resp = await axios({
      method: "post",
      url: `${FB_GRAPH_BASE}/${conn.phoneNumberId}/contacts`,
      params: { access_token: conn.accessToken },
      data: { blocking: "wait", contacts: [clean], force_check: true },
      timeout: 8000,
      validateStatus: () => true,
    });
    const entry = resp?.data?.contacts?.[0];
    if (entry && entry.status === "valid") {
      return { isOnWhatsapp: true, waId: entry.wa_id || clean.replace(/^\+/, "") };
    }
    if (entry && entry.status === "invalid") {
      return { isOnWhatsapp: false, waId: "" };
    }
    return { isOnWhatsapp: null };
  } catch {
    return { isOnWhatsapp: null };
  }
}

async function requireWa(req, res, next) {
  const conn = await loadConnection(req);
  if (!conn) return res.status(401).json({ error: "WhatsApp not connected", code: "WA_NOT_CONNECTED" });
  req.wa = conn;
  next();
}

// ---------- CONNECT / STATUS ----------
router.post("/connect", async (req, res, next) => {
  try {
    const { phoneNumberId, accessToken, businessAccountId = "", webhookVerifyToken = "", pin } = req.body || {};
    if (!phoneNumberId || !accessToken) {
      return res.status(400).json({ error: "phoneNumberId and accessToken are required" });
    }

    // Verify by fetching phone number details
    let phoneInfo = null;
    try {
      phoneInfo = await fb({
        method: "get",
        url: `${FB_GRAPH_BASE}/${phoneNumberId}`,
        params: { fields: "display_phone_number,verified_name,quality_rating,id" },
        token: accessToken,
      });
    } catch (err) {
      return res.status(401).json({ error: "Could not verify WhatsApp credentials", details: err.fb || err.message });
    }

    const existing = await WhatsAppConnection.findOne(orgConnFilter(req)).select("phoneNumberId businessAccountId");
    const oldPhoneNumberId = existing?.phoneNumberId || null;
    const oldWabaId = existing?.businessAccountId || null;
    const isNewPhone = !oldPhoneNumberId || oldPhoneNumberId !== phoneNumberId;
    const isNewWaba = !!businessAccountId && (!oldWabaId || oldWabaId !== businessAccountId);

    const lineStartedAt = new Date();
    const conn = await WhatsAppConnection.findOneAndUpdate(
      orgConnFilter(req),
      {
        user: req.user._id,
        organization: tenantId(req),
        phoneNumberId,
        accessToken,
        businessAccountId,
        webhookVerifyToken,
        phoneNumber: phoneInfo?.display_phone_number || "",
        verifiedName: phoneInfo?.verified_name || "",
        quality: phoneInfo?.quality_rating || "",
        connectedAt: lineStartedAt,
        ...(isNewPhone ? { inboxSince: lineStartedAt } : {}),
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).select("+accessToken");

    const registration = await ensureWhatsAppPhoneRegistered(
      { phoneNumberId, accessToken: conn.accessToken },
      { force: isNewPhone, pin }
    );

    const wabaSubscription = await ensureWabaSubscribed(
      { businessAccountId: businessAccountId || conn.businessAccountId, accessToken: conn.accessToken },
      { force: isNewWaba || (isNewPhone && !!businessAccountId) }
    );

    // Best-effort: pull the rest of the WABA + phone info right away so the
    // Settings page renders with real data on first load instead of dashes.
    try { await fetchAndCacheAccountInfo(conn); } catch { /* non-fatal */ }

    await onWaPhoneNumberChange(req.user._id, oldPhoneNumberId, phoneNumberId);
    if (isNewPhone) {
      await stripAllLineTags(req.user._id, phoneNumberId);
    }

    res.json({ connected: true, connection: conn.toJSON(), registration, wabaSubscription });
  } catch (err) { next(err); }
});

// ---------- WEBHOOK CONFIG ----------
// Returns this user's webhook URL + verify token for pasting into Meta's
// WhatsApp Business Manager. Generates a token on first read if missing.
router.get("/webhook", async (req, res, next) => {
  try {
    let conn = await WhatsAppConnection.findOne(orgConnFilter(req)).select("+webhookVerifyToken");
    if (!conn) return res.status(404).json({ error: "Connect WhatsApp first in Settings." });

    if (!conn.webhookVerifyToken) {
      conn.webhookVerifyToken = require("crypto").randomBytes(18).toString("base64url");
      await conn.save();
    }

    const base = process.env.PUBLIC_WEBHOOK_BASE || `${req.protocol}://${req.get("host")}`;
    const globalVerify = String(process.env.WEBHOOK_VERIFY_TOKEN || "").trim();
    res.json({
      url: `${base.replace(/\/$/, "")}/webhooks/whatsapp`,
      verifyToken: conn.webhookVerifyToken,
      globalVerifyToken: globalVerify || null,
      phoneNumberId: conn.phoneNumberId,
      wabaId: conn.businessAccountId,
      recommendedFields: [
        "messages",
        "message_template_status_update",
        "account_update",
      ],
      metaAppWebhookFields: [
        "messages",
        "message_template_status_update",
        "account_update",
      ],
      setupNote:
        "In Meta Developer App → Webhooks → WhatsApp Business Account: paste Callback URL + Verify Token, then subscribe to messages (required for inbox). "
        + "Use WEBHOOK_VERIFY_TOKEN from .env OR the per-user verifyToken above.",
    });
  } catch (err) { next(err); }
});

// Rotate the verify token (e.g. if it leaked). New token returned — user must
// paste it into Meta dashboard and re-verify.
router.post("/webhook/rotate-token", async (req, res, next) => {
  try {
    const conn = await WhatsAppConnection.findOne(orgConnFilter(req)).select("+webhookVerifyToken");
    if (!conn) return res.status(404).json({ error: "Connect WhatsApp first." });
    conn.webhookVerifyToken = require("crypto").randomBytes(18).toString("base64url");
    await conn.save();
    res.json({ verifyToken: conn.webhookVerifyToken });
  } catch (err) { next(err); }
});

// Let the user supply their OWN verify token (some prefer predictable ones).
router.put("/webhook/verify-token", async (req, res, next) => {
  try {
    const token = String(req.body?.token || "").trim();
    if (token.length < 8) return res.status(400).json({ error: "Token must be at least 8 characters." });
    const conn = await WhatsAppConnection.findOneAndUpdate(
      orgConnFilter(req), { $set: { webhookVerifyToken: token } }, { new: true }
    );
    if (!conn) return res.status(404).json({ error: "Connect WhatsApp first." });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Public-ish FB config for the frontend embedded-signup widget
router.get("/embedded-config", (_req, res) => {
  const fbAppId = String(process.env.WHATSAPP_FB_APP_ID || process.env.FB_APP_ID || "").trim();
  const configId = String(process.env.WHATSAPP_FB_CONFIG_ID || process.env.FB_CONFIG_ID || "").trim();
  const apiVersion = process.env.META_API_VERSION || "v25.0";
  res.json({ fbAppId, configId, apiVersion });
});

// Embedded Signup — exchanges the FB auth code for a long-lived token,
// verifies the phone number, and saves the connection. Called after the
// frontend's WA_EMBEDDED_SIGNUP popup finishes.
router.post("/embedded-connect", async (req, res, next) => {
  try {
    const { code, phoneNumberId, wabaId = "", businessId = "", pin } = req.body || {};
    if (!code || !phoneNumberId) {
      return res.status(400).json({ error: "code and phoneNumberId required" });
    }

    const clientId = process.env.WHATSAPP_FB_APP_ID || process.env.FB_APP_ID;
    const clientSecret = process.env.WHATSAPP_FB_APP_SECRET || process.env.FB_APP_SECRET;
    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: "Server missing FB_APP_ID / FB_APP_SECRET" });
    }

    // 1. Exchange the embedded-signup code for an access token
    const exchange = await axios.get(`${FB_GRAPH_BASE}/oauth/access_token`, {
      params: {
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code).trim(),
        ...(process.env.WHATSAPP_OAUTH_REDIRECT_URI ? { redirect_uri: process.env.WHATSAPP_OAUTH_REDIRECT_URI } : {}),
      },
      validateStatus: () => true,
    });
    if (exchange.status !== 200 || !exchange.data?.access_token) {
      return res.status(exchange.status || 500).json({
        error: "Token exchange failed",
        details: exchange.data?.error || exchange.data,
      });
    }
    const accessToken = exchange.data.access_token;

    // 2. Verify the phone number details
    let phoneInfo = null;
    try {
      phoneInfo = await fb({
        method: "get",
        url: `${FB_GRAPH_BASE}/${phoneNumberId}`,
        params: { fields: "display_phone_number,verified_name,quality_rating,id" },
        token: accessToken,
      });
    } catch (err) {
      return res.status(401).json({ error: "Could not verify WhatsApp phone number", details: err.fb || err.message });
    }

    // 3. Persist connection
    const existing = await WhatsAppConnection.findOne(orgConnFilter(req)).select("phoneNumberId businessAccountId");
    const oldPhoneNumberId = existing?.phoneNumberId || null;
    const oldWabaId = existing?.businessAccountId || null;
    const isNewPhone = !oldPhoneNumberId || oldPhoneNumberId !== phoneNumberId;
    const isNewWaba = !!wabaId && (!oldWabaId || oldWabaId !== wabaId);

    const lineStartedAt = new Date();
    const conn = await WhatsAppConnection.findOneAndUpdate(
      orgConnFilter(req),
      {
        user: req.user._id,
        organization: tenantId(req),
        phoneNumberId,
        accessToken,
        businessAccountId: wabaId,
        phoneNumber: phoneInfo?.display_phone_number || "",
        verifiedName: phoneInfo?.verified_name || "",
        quality: phoneInfo?.quality_rating || "",
        connectedAt: lineStartedAt,
        ...(isNewPhone ? { inboxSince: lineStartedAt } : {}),
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).select("+accessToken");

    const registration = await ensureWhatsAppPhoneRegistered(
      { phoneNumberId, accessToken },
      { force: isNewPhone, pin }
    );

    const wabaSubscription = await ensureWabaSubscribed(
      { businessAccountId: wabaId || conn.businessAccountId, accessToken },
      { force: isNewWaba || (isNewPhone && !!wabaId) }
    );

    try { await fetchAndCacheAccountInfo(conn); } catch { /* non-fatal */ }

    await onWaPhoneNumberChange(req.user._id, oldPhoneNumberId, phoneNumberId);
    if (isNewPhone) {
      await stripAllLineTags(req.user._id, phoneNumberId);
    }

    res.json({ connected: true, connection: conn.toJSON(), businessId, registration, wabaSubscription });
  } catch (err) { next(err); }
});

router.get("/status", async (req, res, next) => {
  try {
    const conn = await loadConnection(req);
    if (!conn) return res.json({ connected: false });
    res.json({ connected: true, connection: conn.toJSON() });
  } catch (err) { next(err); }
});

// Diagnostic — inspects what Meta actually returns for each field, and
// reports the scopes / permissions the current access token carries.
// Use this to figure out why WABA fields are blank (usually a missing
// `whatsapp_business_management` scope).
router.get("/diag", requireWa, async (req, res, next) => {
  try {
    const token = req.wa.accessToken;
    const out = { phoneNumberId: req.wa.phoneNumberId, wabaId: req.wa.businessAccountId };

    // Token debug (reveals granted scopes)
    try {
      const dbg = await fb({
        method: "get",
        url: `${FB_GRAPH_BASE}/debug_token`,
        params: { input_token: token },
        token,
      });
      out.scopes = dbg?.data?.scopes || [];
      out.appId  = dbg?.data?.app_id;
      out.tokenType = dbg?.data?.type;
    } catch (e) { out.debugTokenError = e.fb || e.message; }

    // Try each WABA field individually so we know exactly which one fails.
    if (req.wa.businessAccountId) {
      out.wabaFields = {};
      const probe = [
        "name", "currency", "timezone_id", "message_template_namespace",
        "business_verification_status", "primary_funding_id",
        "owner_business_info", "on_behalf_of_business_info",
      ];
      for (const f of probe) {
        try {
          const r = await fb({
            method: "get",
            url: `${FB_GRAPH_BASE}/${req.wa.businessAccountId}`,
            params: { fields: f },
            token,
          });
          out.wabaFields[f] = r?.[f] ?? "(returned but empty)";
        } catch (e) {
          out.wabaFields[f] = { error: e.message, code: e.fb?.code, subcode: e.fb?.error_subcode };
        }
      }
    }

    res.json(out);
  } catch (err) { next(err); }
});

router.post("/disconnect", async (req, res, next) => {
  try {
    await WhatsAppConnection.deleteOne(orgConnFilter(req));
    res.json({ disconnected: true });
  } catch (err) { next(err); }
});

// Fetch a full "Account info" payload straight from Meta Graph —
// combines:
//   • Phone number details (status, throughput, limit tier, platform…)
//   • WABA details (name, timezone, currency, business verification,
//     template namespace, owner business info)
//   • All phone numbers linked to this WABA
// Each call is guarded individually so a single Meta error doesn't
// blank the whole page — we return whatever we could gather plus a
// list of warnings.
router.get("/account-info", requireWa, async (req, res, next) => {
  try {
    const wabaSubscription = await ensureWabaSubscribed(req.wa, { force: true });
    const live = await fetchAndCacheAccountInfo(req.wa);
    const conn = req.wa; // mutated by the helper

    // Build the response by merging live Meta data with the DB cache.
    // Live values win when present; otherwise the DB snapshot fills in
    // so the UI never shows "—" just because a Graph call flaked.
    const phone = {
      id:                          live.phone?.id || conn.phoneNumberId,
      display_phone_number:        live.phone?.display_phone_number        || conn.phoneNumber,
      verified_name:               live.phone?.verified_name               || conn.verifiedName,
      quality_rating:              live.phone?.quality_rating              || conn.quality,
      code_verification_status:    live.phone?.code_verification_status    || conn.phoneCodeVerification,
      name_status:                 live.phone?.name_status || live.phone?.new_name_status || conn.phoneNameStatus,
      platform_type:               live.phone?.platform_type               || conn.phonePlatformType,
      throughput:                  live.phone?.throughput || (conn.phoneThroughputLevel ? { level: conn.phoneThroughputLevel } : null),
      messaging_limit_tier:        live.phone?.messaging_limit_tier        || conn.phoneMessagingLimitTier,
      account_mode:                live.phone?.account_mode                || conn.phoneAccountMode,
      is_official_business_account:typeof live.phone?.is_official_business_account === "boolean"
                                      ? live.phone.is_official_business_account
                                      : conn.phoneIsOfficial,
      status:                      live.phone?.status                      || conn.phoneStatus,
    };

    const waba = {
      id:                           live.waba?.id                           || conn.businessAccountId,
      name:                         live.waba?.name                         || conn.wabaName,
      currency:                     live.waba?.currency                     || conn.wabaCurrency,
      timezone_id:                  live.waba?.timezone_id                  || conn.wabaTimezoneId,
      business_verification_status: live.waba?.business_verification_status || conn.wabaBusinessVerification,
      message_template_namespace:   live.waba?.message_template_namespace   || conn.wabaTemplateNamespace,
      businessId:                   live.waba?.businessId                   || conn.businessId,
      businessName:                 live.waba?.businessName                 || conn.businessName,
    };

    res.json({
      connection:   conn.toJSON(),
      phone,
      waba,
      phoneNumbers: live.phoneNumbers,
      warnings:     live.warnings,
      wabaSubscription,
      cached:       !live.phone && !live.waba, // everything from DB
      refreshedAt:  conn.infoRefreshedAt,
    });
  } catch (err) { next(err); }
});

// ---------- TEMPLATES ----------
router.get("/templates", requireWa, async (req, res, next) => {
  try {
    if (!req.wa.businessAccountId) {
      return res.status(400).json({ error: "WhatsApp Business Account ID (WABA) is required for templates. Reconnect with WABA ID." });
    }
    const data = await fb({
      method: "get",
      url: `${FB_GRAPH_BASE}/${req.wa.businessAccountId}/message_templates`,
      params: { fields: "name,status,category,language,components", limit: 100 },
      token: req.wa.accessToken,
    });
    res.json({ templates: data?.data || [], paging: data?.paging });
  } catch (err) { next(err); }
});

router.post("/templates", requireWa, async (req, res, next) => {
  try {
    if (!req.wa.businessAccountId) {
      return res.status(400).json({ error: "WABA ID required to create templates." });
    }
    const { name, language = "en_US", category = "MARKETING", body, header, footer, buttons } = req.body || {};
    if (!name || !body) return res.status(400).json({ error: "name and body are required" });

    const components = [];
    if (header) components.push({ type: "HEADER", format: "TEXT", text: header });
    components.push({ type: "BODY", text: body });
    if (footer) components.push({ type: "FOOTER", text: footer });
    if (Array.isArray(buttons) && buttons.length) {
      // Buttons can be strings (quick replies, legacy) OR objects with explicit type:
      //   { type: "QUICK_REPLY", text }
      //   { type: "URL", text, url }
      //   { type: "PHONE_NUMBER", text, phone_number }
      //   { type: "COPY_CODE", text, example: ["WELCOME50"] }
      const normalized = buttons.map((b) => {
        if (typeof b === "string") return { type: "QUICK_REPLY", text: cleanButtonText(b) };
        const t = String(b.type || "QUICK_REPLY").toUpperCase();
        const out = { type: t, text: cleanButtonText(b.text || "") };
        if (t === "URL")          out.url          = b.url || "";
        if (t === "PHONE_NUMBER") out.phone_number = b.phone_number || b.phone || "";
        if (t === "COPY_CODE")    out.example      = Array.isArray(b.example) ? b.example : (b.example ? [b.example] : []);
        return out;
      }).filter((b) => b.text);  // drop empty buttons after cleaning
      components.push({ type: "BUTTONS", buttons: normalized });
    }

    const data = await fb({
      method: "post",
      url: `${FB_GRAPH_BASE}/${req.wa.businessAccountId}/message_templates`,
      data: { name, language, category, components },
      token: req.wa.accessToken,
    });
    res.status(201).json({ template: data });
  } catch (err) { next(err); }
});

// Delete a message template from WhatsApp Business Manager.
// Meta's API: DELETE /{WABA_ID}/message_templates?name=...&hsm_id=...
router.delete("/templates", requireWa, async (req, res, next) => {
  try {
    if (!req.wa.businessAccountId) {
      return res.status(400).json({ error: "WABA ID required to delete templates." });
    }
    const { name, hsm_id } = req.query || {};
    if (!name) return res.status(400).json({ error: "template name required" });

    const params = { name };
    if (hsm_id) params.hsm_id = hsm_id;

    const data = await fb({
      method: "delete",
      url: `${FB_GRAPH_BASE}/${req.wa.businessAccountId}/message_templates`,
      params,
      token: req.wa.accessToken,
    });
    res.json({ ok: !!data?.success, data });
  } catch (err) { next(err); }
});

// ---------- CONTACTS ----------
router.get("/contacts", async (req, res, next) => {
  try {
    const { q = "" } = req.query;
    const filter = { user: req.user._id };
    if (q.trim()) {
      const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { phone: rx }, { email: rx }];
    }
    const contacts = await WhatsAppContact.find(filter).sort({ createdAt: -1 });

    // Backfill isOnWhatsapp=true for any contact where we've exchanged at
    // least one message. Meta's Cloud API has no pre-check endpoint, so
    // "has a message in history" is the strongest proof we can compute
    // without sending anything.
    const unknown = contacts.filter((c) => c.isOnWhatsapp == null).map((c) => c.phone);
    if (unknown.length) {
      const withMessages = await WhatsAppMessage.distinct("contactPhone", {
        user: req.user._id, contactPhone: { $in: unknown },
      });
      if (withMessages.length) {
        const set = new Set(withMessages);
        await WhatsAppContact.updateMany(
          { user: req.user._id, phone: { $in: withMessages } },
          { $set: { isOnWhatsapp: true, waCheckedAt: new Date() } }
        );
        contacts.forEach((c) => {
          if (set.has(c.phone)) {
            c.isOnWhatsapp = true;
            c.waCheckedAt = new Date();
          }
        });
      }
    }
    res.json({ contacts });
  } catch (err) { next(err); }
});

router.post("/contacts", async (req, res, next) => {
  try {
    const { name, phone, email = "", tags = [], notes = "" } = req.body || {};
    if (!name || !phone) return res.status(400).json({ error: "name and phone required" });
    // Upsert — if the phone already exists for this user, return it rather
    // than 409. Lets the inbox "Label" button always end up with a valid
    // contact to attach labels to, even for new conversations.
    const existing = await WhatsAppContact.findOne({ user: req.user._id, phone }).populate("labels");
    if (existing) return res.status(200).json({ contact: existing });

    // Probe WhatsApp reachability — best-effort, doesn't block creation.
    const conn = await loadConnection(req);
    const probe = conn ? await checkIsOnWhatsapp(conn, phone) : { isOnWhatsapp: null };

    const contact = await WhatsAppContact.create({
      user: req.user._id, name, phone, email, tags, notes,
      isOnWhatsapp: probe.isOnWhatsapp,
      waId: probe.waId || "",
      waCheckedAt: new Date(),
    });
    res.status(201).json({ contact });
  } catch (err) {
    if (err.code === 11000) {
      // Race — another insert happened between our check and create. Fetch.
      const existing = await WhatsAppContact.findOne({ user: req.user._id, phone: req.body?.phone }).populate("labels");
      if (existing) return res.status(200).json({ contact: existing });
      return res.status(409).json({ error: "A contact with this phone already exists." });
    }
    next(err);
  }
});

router.put("/contacts/:id", async (req, res, next) => {
  try {
    const { _id, id, user, ...rest } = req.body || {};
    const contact = await WhatsAppContact.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id }, rest, { new: true, runValidators: true }
    );
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    res.json({ contact });
  } catch (err) { next(err); }
});

router.delete("/contacts/:id", async (req, res, next) => {
  try {
    const r = await WhatsAppContact.deleteOne({ _id: req.params.id, user: req.user._id });
    if (!r.deletedCount) return res.status(404).json({ error: "Contact not found" });
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

// Mark a conversation as read — stamps `lastReadAt` on the contact so the
// unread counter resets. Upserts the contact if it doesn't exist yet so
// brand-new chats can still be "read".
router.post("/conversations/:phone/read", async (req, res, next) => {
  try {
    const scope = await inboxScope(req);
    if (!scope) return res.status(400).json({ error: "WhatsApp not connected" });
    const { phoneNumberId } = scope;
    const phone = req.params.phone;

    await WhatsAppContact.updateOne(
      contactScope(req.user._id, phoneNumberId, phone),
      {
        $setOnInsert: {
          user: req.user._id,
          phoneNumberId,
          phone,
          name: phone,
        },
        $set: { lastReadAt: new Date() },
      },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Delete a lead / conversation by phone — wipes both the contact AND every
// message exchanged with them. Used by the inbox's "Delete lead" action.
router.delete("/conversations/:phone", async (req, res, next) => {
  try {
    const scope = await inboxScope(req);
    if (!scope) return res.status(400).json({ error: "WhatsApp not connected" });
    const { match, phoneNumberId } = scope;
    const phone = req.params.phone;
    const msgs = await WhatsAppMessage.deleteMany({ ...match, contactPhone: phone });
    const contact = await WhatsAppContact.deleteOne(contactScope(req.user._id, phoneNumberId, phone));
    res.json({ deleted: phone, messages: msgs.deletedCount, contact: contact.deletedCount });
  } catch (err) { next(err); }
});

router.post("/contacts/bulk", async (req, res, next) => {
  try {
    const list = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
    if (!list.length) return res.status(400).json({ error: "contacts array required" });

    const docs = list
      .filter((c) => c?.name && c?.phone)
      .map((c) => ({
        user: req.user._id,
        name: String(c.name).trim(),
        phone: String(c.phone).trim(),
        email: String(c.email || "").trim(),
        tags: Array.isArray(c.tags) ? c.tags : [],
        notes: c.notes || "",
      }));

    // One connection lookup for the whole batch — probe each number
    // sequentially (Meta rate-limits us, so parallel calls get throttled).
    const conn = await loadConnection(req);

    let inserted = 0, skipped = 0, onWhatsapp = 0;
    for (const d of docs) {
      const probe = conn ? await checkIsOnWhatsapp(conn, d.phone) : { isOnWhatsapp: null };
      try {
        await WhatsAppContact.create({
          ...d,
          isOnWhatsapp: probe.isOnWhatsapp,
          waId: probe.waId || "",
          waCheckedAt: new Date(),
        });
        inserted += 1;
        if (probe.isOnWhatsapp === true) onWhatsapp += 1;
      } catch (e) {
        if (e.code === 11000) skipped += 1;
        else throw e;
      }
    }
    res.json({ inserted, skipped, onWhatsapp, total: docs.length });
  } catch (err) { next(err); }
});

// Manually verify a contact is reachable on WhatsApp by sending the
// hello_world template (Meta's default). The /messages response returns
// `contacts[0].wa_id` iff the number is on WhatsApp. If the number isn't
// on WhatsApp, Meta responds with error code 131026 / 131049 — we treat
// any such error as "not on WhatsApp".
router.post("/contacts/:id/verify", requireWa, async (req, res, next) => {
  try {
    const contact = await WhatsAppContact.findOne({ _id: req.params.id, user: req.user._id });
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    const templateName = (req.body?.template || "hello_world").trim();
    const language     = (req.body?.language || "en_US").trim();
    const to = contact.phone.replace(/^\+/, "");

    try {
      const resp = await fb({
        method: "post",
        url: `${FB_GRAPH_BASE}/${req.wa.phoneNumberId}/messages`,
        data: {
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: { name: templateName, language: { code: language } },
        },
        token: req.wa.accessToken,
      });
      const waId = resp?.contacts?.[0]?.wa_id || "";
      contact.isOnWhatsapp = true;
      contact.waId = waId;
      contact.waCheckedAt = new Date();
      await contact.save();
      return res.json({ isOnWhatsapp: true, waId, contact });
    } catch (e) {
      // 131026 = Message undeliverable (number not on WhatsApp)
      // 131049 = not subscribed / invalid
      const code = e.fb?.code;
      const notOnWa = code === 131026 || code === 131049 || code === 470;
      if (notOnWa) {
        contact.isOnWhatsapp = false;
        contact.waId = "";
        contact.waCheckedAt = new Date();
        await contact.save();
        return res.json({ isOnWhatsapp: false, contact });
      }
      // Unrelated error (template missing, auth expired, etc.) — bubble up.
      return res.status(e.status || 500).json({ error: e.message, details: e.fb });
    }
  } catch (err) { next(err); }
});

// ---------- CAMPAIGNS ----------
router.get("/campaigns", async (req, res, next) => {
  try {
    const list = await WhatsAppCampaign.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json({ campaigns: list });
  } catch (err) { next(err); }
});

router.post("/campaigns", async (req, res, next) => {
  try {
    const { name, templateName, templateLang = "en_US", contactIds = [] } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const c = await WhatsAppCampaign.create({
      user: req.user._id, name, templateName, templateLang, contacts: contactIds, status: "draft",
    });
    res.status(201).json({ campaign: c });
  } catch (err) { next(err); }
});

// ---------- SENDING ----------
async function sendTemplate(token, phoneNumberId, to, templateName, language = "en_US", parameters = []) {
  const components = parameters.length
    ? [{ type: "body", parameters: parameters.map((t) => ({ type: "text", text: String(t) })) }]
    : undefined;
  return fb({
    method: "post",
    url: `${FB_GRAPH_BASE}/${phoneNumberId}/messages`,
    data: {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name: templateName, language: { code: language }, ...(components ? { components } : {}) },
    },
    token,
  });
}

async function sendText(token, phoneNumberId, to, body) {
  return fb({
    method: "post",
    url: `${FB_GRAPH_BASE}/${phoneNumberId}/messages`,
    data: {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body, preview_url: false },
    },
    token,
  });
}

// Proxy any WhatsApp media id back to the browser as real bytes. Meta's
// media URLs require an authorized GET, so we can't use them directly as
// `<img src>`. This endpoint fetches the URL + streams the file with the
// right content-type — works for images, video, audio, documents.
router.get("/media/:mediaId", requireWa, async (req, res, next) => {
  try {
    const metaRes = await axios.get(`${FB_GRAPH_BASE}/${req.params.mediaId}`, {
      params: { access_token: req.wa.accessToken },
      validateStatus: () => true,
    });
    if (metaRes.status < 200 || metaRes.status >= 300 || !metaRes.data?.url) {
      return res.status(metaRes.status || 404).json({
        error: metaRes.data?.error?.message || "Media not found on Meta",
      });
    }
    const fileRes = await axios.get(metaRes.data.url, {
      responseType: "stream",
      headers: { Authorization: `Bearer ${req.wa.accessToken}` },
      validateStatus: () => true,
    });
    if (fileRes.status < 200 || fileRes.status >= 300) {
      return res.status(fileRes.status || 500).json({ error: "Failed to download from Meta" });
    }
    res.setHeader("Content-Type", metaRes.data.mime_type || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Disposition", "inline");
    fileRes.data.pipe(res);
  } catch (err) { next(err); }
});

// ---------- MEDIA UPLOAD ----------
// Uploads a file from the client to Meta's /PHONE_NUMBER_ID/media endpoint and
// returns the media ID. Chatbot media bodies reference this ID instead of a
// public URL — no need to host the file anywhere, and Meta's media IDs are
// valid for 30 days before re-upload is required.
router.post("/media/upload", requireWa, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    fd.append("type", req.file.mimetype);
    fd.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    const url = `${FB_GRAPH_BASE}/${req.wa.phoneNumberId}/media`;
    const response = await axios.post(url, fd, {
      headers: { ...fd.getHeaders(), Authorization: `Bearer ${req.wa.accessToken}` },
      params: { access_token: req.wa.accessToken },
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300 || !response.data?.id) {
      const fbErr = response.data?.error || {};
      return res.status(response.status || 500).json({
        error: fbErr.error_user_msg || fbErr.message || "Upload to WhatsApp failed",
        details: fbErr,
      });
    }

    res.json({
      id: response.data.id,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
    });
  } catch (err) { next(err); }
});

router.post("/send-template", requireWa, async (req, res, next) => {
  try {
    const { to, templateName, language = "en_US", parameters = [] } = req.body || {};
    if (!to || !templateName) return res.status(400).json({ error: "to and templateName required" });

    const result = await sendTemplate(req.wa.accessToken, req.wa.phoneNumberId, to, templateName, language, parameters);
    const messageId = result?.messages?.[0]?.id || "";

    // Render a preview of the text using the parameters so the inbox row
    // preview + chat bubble don't just show an empty string.
    const previewText = Array.isArray(parameters) && parameters.length
      ? `[Template] ${templateName} — ${parameters.join(" · ")}`
      : `[Template] ${templateName}`;

    const msg = await WhatsAppMessage.create({
      user: req.user._id, phoneNumberId: req.wa.phoneNumberId, contactPhone: to, direction: "outbound",
      type: "template", templateName, text: previewText,
      messageId, status: "sent",
      meta: { template: { name: templateName, language, parameters } },
    });

    // Push it over the socket so any open Inbox updates in real time.
    emitToUser(req.user._id, "wa.outbound", { message: msg.toJSON() });

    res.json({ result, messageId, message: msg });
  } catch (err) { next(err); }
});

// ---------- META FLOWS (interactive multi-screen forms) ----------
// List flows from the connected WABA. `status` filter: DRAFT, PUBLISHED, etc.
router.get("/meta-flows", requireWa, async (req, res, next) => {
  try {
    if (!req.wa.businessAccountId) {
      return res.status(400).json({ error: "WABA ID required — reconnect in WhatsApp settings and include your Business Account ID." });
    }
    const data = await fb({
      method: "get",
      url: `${FB_GRAPH_BASE}/${req.wa.businessAccountId}/flows`,
      params: { fields: "id,name,status,categories,updated_time" },
      token: req.wa.accessToken,
    });
    res.json({ flows: data?.data || [] });
  } catch (err) { next(err); }
});

// Get a single flow with its latest asset JSON (if any). We fetch the flow
// metadata + the assets list + download the active flow_json file.
router.get("/meta-flows/:id", requireWa, async (req, res, next) => {
  try {
    const id = req.params.id;
    const flow = await fb({
      method: "get",
      url: `${FB_GRAPH_BASE}/${id}`,
      params: { fields: "id,name,status,categories,validation_errors,preview" },
      token: req.wa.accessToken,
    });
    let assetJson = null;
    try {
      const assets = await fb({
        method: "get",
        url: `${FB_GRAPH_BASE}/${id}/assets`,
        token: req.wa.accessToken,
      });
      const doc = assets?.data?.find?.((a) => a.name === "flow.json") || assets?.data?.[0];
      if (doc?.download_url) {
        const r = await axios.get(doc.download_url, { validateStatus: () => true });
        if (r.status >= 200 && r.status < 300) assetJson = r.data;
      }
    } catch { /* asset may not exist yet */ }
    res.json({ flow, flowJson: assetJson });
  } catch (err) { next(err); }
});

// Create a new (DRAFT) flow on the WABA.
router.post("/meta-flows", requireWa, async (req, res, next) => {
  try {
    if (!req.wa.businessAccountId) {
      return res.status(400).json({ error: "WABA ID required — reconnect in WhatsApp settings." });
    }
    const { name, categories = ["OTHER"] } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "name required" });
    if (!Array.isArray(categories) || !categories.length) {
      return res.status(400).json({ error: "categories[] required (at least one)" });
    }

    const data = await fb({
      method: "post",
      url: `${FB_GRAPH_BASE}/${req.wa.businessAccountId}/flows`,
      data: { name: name.trim(), categories },
      token: req.wa.accessToken,
    });
    res.status(201).json({ flow: data });
  } catch (err) { next(err); }
});

// Upload / update the flow.json asset for an existing flow.
router.put("/meta-flows/:id/asset", requireWa, async (req, res, next) => {
  try {
    const id = req.params.id;
    const { flowJson } = req.body || {};
    if (!flowJson) return res.status(400).json({ error: "flowJson required" });
    const jsonStr = typeof flowJson === "string" ? flowJson : JSON.stringify(flowJson);

    // Meta expects multipart upload: file + asset_type + name.
    const fd = new FormData();
    fd.append("file", Buffer.from(jsonStr, "utf8"), { filename: "flow.json", contentType: "application/json" });
    fd.append("name", "flow.json");
    fd.append("asset_type", "FLOW_JSON");

    const response = await axios.post(
      `${FB_GRAPH_BASE}/${id}/assets`,
      fd,
      {
        headers: { ...fd.getHeaders(), Authorization: `Bearer ${req.wa.accessToken}` },
        params: { access_token: req.wa.accessToken },
        validateStatus: () => true,
        maxBodyLength: Infinity,
      }
    );
    if (response.status < 200 || response.status >= 300) {
      const fbErr = response.data?.error || {};
      return res.status(response.status).json({
        error: fbErr.error_user_msg || fbErr.message || "Flow asset upload failed",
        details: fbErr,
      });
    }
    res.json({ ok: true, validation_errors: response.data?.validation_errors || [] });
  } catch (err) { next(err); }
});

// Publish a draft flow so you can send it to real users.
router.post("/meta-flows/:id/publish", requireWa, async (req, res, next) => {
  try {
    const data = await fb({
      method: "post",
      url: `${FB_GRAPH_BASE}/${req.params.id}/publish`,
      token: req.wa.accessToken,
    });
    res.json({ ok: !!data?.success, data });
  } catch (err) { next(err); }
});

// Delete a DRAFT flow (Meta only allows deleting drafts — published flows
// have to be deprecated instead).
router.delete("/meta-flows/:id", requireWa, async (req, res, next) => {
  try {
    const data = await fb({
      method: "delete",
      url: `${FB_GRAPH_BASE}/${req.params.id}`,
      token: req.wa.accessToken,
    });
    res.json({ ok: !!data?.success, data });
  } catch (err) { next(err); }
});

// Send a flow to a contact. The flow must already exist & be PUBLISHED in Meta.
router.post("/send-flow", requireWa, async (req, res, next) => {
  try {
    const {
      to,
      flowId,
      cta = "Open form",
      body = "Tap below to continue",
      header = "",
      footer = "",
      firstScreen = "",           // optional: initial screen id inside the flow
      flowToken,                  // optional: caller-supplied token (we generate if missing)
      mode = "published",         // "published" or "draft" — draft lets you test before publishing
    } = req.body || {};
    if (!to)     return res.status(400).json({ error: "'to' phone number required" });
    if (!flowId) return res.status(400).json({ error: "flowId required" });

    const token = flowToken || require("crypto").randomBytes(12).toString("base64url");

    const interactive = {
      type: "flow",
      ...(header ? { header: { type: "text", text: String(header).slice(0, 60) } } : {}),
      body: { text: String(body).slice(0, 1024) },
      ...(footer ? { footer: { text: String(footer).slice(0, 60) } } : {}),
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: token,
          flow_id: String(flowId),
          flow_cta: String(cta).slice(0, 20),
          flow_action: firstScreen ? "navigate" : "data_exchange",
          ...(firstScreen ? { flow_action_payload: { screen: firstScreen } } : {}),
          ...(mode === "draft" ? { mode: "draft" } : {}),
        },
      },
    };

    const result = await fb({
      method: "post",
      url: `${FB_GRAPH_BASE}/${req.wa.phoneNumberId}/messages`,
      data: { messaging_product: "whatsapp", to, type: "interactive", interactive },
      token: req.wa.accessToken,
    });

    const messageId = result?.messages?.[0]?.id || "";
    const msg = await WhatsAppMessage.create({
      user: req.user._id, phoneNumberId: req.wa.phoneNumberId, contactPhone: to, direction: "outbound",
      type: "interactive", text: body, messageId, status: "sent",
      meta: {
        flow: { id: flowId, cta, header, footer, firstScreen, token, mode },
      },
    });

    emitToUser(req.user._id, "wa.outbound", { message: msg.toJSON() });
    res.json({ ok: true, messageId, flowToken: token });
  } catch (err) { next(err); }
});

router.post("/send-text", requireWa, async (req, res, next) => {
  try {
    const { to, body } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: "to and body required" });
    const result = await sendText(req.wa.accessToken, req.wa.phoneNumberId, to, body);
    const messageId = result?.messages?.[0]?.id || "";
    await WhatsAppMessage.create({
      user: req.user._id, phoneNumberId: req.wa.phoneNumberId, contactPhone: to, direction: "outbound",
      type: "text", text: body, messageId, status: "sent",
    });
    res.json({ result, messageId });
  } catch (err) { next(err); }
});

router.post("/bulk-messages", requireWa, async (req, res, next) => {
  try {
    const { templateName, language = "en_US", contactIds = [], parameters = [] } = req.body || {};
    if (!templateName) return res.status(400).json({ error: "templateName required" });
    if (!Array.isArray(contactIds) || !contactIds.length) {
      return res.status(400).json({ error: "contactIds[] required" });
    }

    const contacts = await WhatsAppContact.find({ _id: { $in: contactIds }, user: req.user._id });
    if (!contacts.length) return res.status(404).json({ error: "No matching contacts" });

    const campaign = await WhatsAppCampaign.create({
      user: req.user._id,
      name: `Bulk: ${templateName} → ${contacts.length} contacts`,
      templateName, templateLang: language,
      contacts: contacts.map((c) => c._id),
      status: "sending",
    });

    let sent = 0, failed = 0;
    for (const c of contacts) {
      try {
        const r = await sendTemplate(req.wa.accessToken, req.wa.phoneNumberId, c.phone, templateName, language, parameters);
        const messageId = r?.messages?.[0]?.id || "";
        sent += 1;
        campaign.log.push({ phone: c.phone, status: "sent", messageId });
        await WhatsAppMessage.create({
          user: req.user._id, phoneNumberId: req.wa.phoneNumberId, contactPhone: c.phone, direction: "outbound",
          type: "template", templateName, messageId, status: "sent",
          campaign: campaign._id,
        });
      } catch (e) {
        failed += 1;
        campaign.log.push({ phone: c.phone, status: "failed", error: e.message });
      }
    }
    campaign.sent = sent;
    campaign.failed = failed;
    campaign.status = failed === 0 ? "completed" : (sent === 0 ? "failed" : "completed");
    await campaign.save();

    res.json({ campaign, sent, failed });
  } catch (err) { next(err); }
});

// ---------- CONVERSATIONS / INBOX ----------
router.post("/inbox/repair-scope", async (req, res, next) => {
  try {
    const conn = await loadConnection(req);
    if (!conn?.phoneNumberId) {
      return res.json({ ok: false, cleared: 0, reason: "not_connected" });
    }
    const phoneNumberId = String(conn.phoneNumberId);
    let inboxSince = conn.inboxSince || conn.connectedAt;
    if (!conn.inboxSince) {
      inboxSince = new Date();
      conn.inboxSince = inboxSince;
      await conn.save();
    }
    const result = await repairInboxAfterPhoneChange(
      req.user._id,
      phoneNumberId,
      inboxSince,
    );
    res.json({
      ok: true,
      phoneNumberId,
      inboxSince,
      displayPhone: conn.phoneNumber || "",
      ...result,
    });
  } catch (err) { next(err); }
});

router.get("/conversations", async (req, res, next) => {
  try {
    const scope = await inboxScope(req);
    if (!scope) {
      return res.json({ conversations: [], connected: false, phoneNumberId: null });
    }
    const { match, phoneNumberId } = scope;

    const agg = await WhatsAppMessage.aggregate([
      { $match: match },
      { $sort: { ts: -1 } },
      {
        $group: {
          _id: "$contactPhone",
          lastMessage: { $first: "$text" },
          lastTemplate: { $first: "$templateName" },
          lastDirection: { $first: "$direction" },
          lastTs: { $first: "$ts" },
          count: { $sum: 1 },
        },
      },
      { $sort: { lastTs: -1 } },
    ]);
    const phones = agg.map((a) => a._id);
    const contacts = await WhatsAppContact
      .find({ ...match, phone: { $in: phones } })
      .populate("labels");
    const byPhone = Object.fromEntries(contacts.map((c) => [c.phone, c]));

    // Compute unread per conversation: inbound messages newer than the
    // contact's lastReadAt.
    const unreadAgg = await WhatsAppMessage.aggregate([
      { $match: { ...match, direction: "inbound", contactPhone: { $in: phones } } },
      {
        $group: {
          _id: "$contactPhone",
          newest: { $max: "$ts" },
          all: { $push: "$ts" },
        },
      },
    ]);
    const unreadByPhone = {};
    for (const row of unreadAgg) {
      const c = byPhone[row._id];
      const cutoff = c?.lastReadAt ? new Date(c.lastReadAt).getTime() : 0;
      unreadByPhone[row._id] = row.all.filter((t) => new Date(t).getTime() > cutoff).length;
    }

    res.json({
      connected: true,
      phoneNumberId,
      displayPhone: scope.displayPhone,
      conversations: agg.map((a) => {
        const c = byPhone[a._id];
        return {
          phone: a._id,
          name: c?.name || a._id,
          lastMessage: a.lastMessage || (a.lastTemplate ? `[Template] ${a.lastTemplate}` : ""),
          lastDirection: a.lastDirection,
          lastTs: a.lastTs,
          count: a.count,
          unread: unreadByPhone[a._id] || 0,
          labels: (c?.labels || []).map((l) => ({ id: l._id?.toString?.() || l.id, name: l.name, color: l.color })),
        };
      }),
    });
  } catch (err) { next(err); }
});

router.get("/conversations/:phone", async (req, res, next) => {
  try {
    const scope = await inboxScope(req);
    if (!scope) {
      return res.status(400).json({ error: "WhatsApp not connected", code: "WA_NOT_CONNECTED" });
    }
    const { match, phoneNumberId } = scope;
    const phone = req.params.phone;

    const messages = await WhatsAppMessage
      .find({ ...match, contactPhone: phone })
      .sort({ ts: 1 });
    const contact = await WhatsAppContact
      .findOne(contactScope(req.user._id, phoneNumberId, phone))
      .populate("labels");

    // Look up a CRM Lead whose phone matches — normalizing both sides to
    // digits-only so "+91 98123 45678" and "919812345678" match.
    const Lead = require("./models/Lead");
    const digits = String(phone).replace(/\D/g, "");
    const last10 = digits.slice(-10);
    const leads = await Lead.find({ owner: req.user._id });
    const matched = leads.find((l) => {
      const d = String(l.phone || "").replace(/\D/g, "");
      return d && (d === digits || d.slice(-10) === last10);
    });
    // toJSON() runs the transform that adds `id` and strips internals.
    const lead = matched ? matched.toJSON() : null;

    res.json({ messages, contact, lead });
  } catch (err) { next(err); }
});

router.post("/conversations/:phone/reply", requireWa, async (req, res, next) => {
  try {
    const { body } = req.body || {};
    if (!body) return res.status(400).json({ error: "body required" });
    const result = await sendText(req.wa.accessToken, req.wa.phoneNumberId, req.params.phone, body);
    const messageId = result?.messages?.[0]?.id || "";
    const msg = await WhatsAppMessage.create({
      user: req.user._id, phoneNumberId: req.wa.phoneNumberId, contactPhone: req.params.phone, direction: "outbound",
      type: "text", text: body, messageId, status: "sent",
    });
    emitToUser(req.user._id, "wa.outbound", { message: msg.toJSON() });
    res.json({ message: msg, messageId });
  } catch (err) { next(err); }
});

// Send a media message (image/video/audio/document) to a conversation. The
// file is uploaded to Meta in one go, then referenced by id in the message.
router.post("/conversations/:phone/reply-media", requireWa, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const phone   = req.params.phone;
    const caption = (req.body?.caption || "").trim();
    const mime    = req.file.mimetype || "application/octet-stream";

    // Pick the right WhatsApp message type from the file's MIME.
    let kind = "document";
    if (mime.startsWith("image/")) kind = "image";
    else if (mime.startsWith("video/")) kind = "video";
    else if (mime.startsWith("audio/")) kind = "audio";
    else if (mime === "image/webp")     kind = "sticker";

    // Step 1: upload the file → media id.
    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    fd.append("type", mime);
    fd.append("file", req.file.buffer, { filename: req.file.originalname, contentType: mime });

    const uploadRes = await axios.post(
      `${FB_GRAPH_BASE}/${req.wa.phoneNumberId}/media`,
      fd,
      {
        headers: { ...fd.getHeaders(), Authorization: `Bearer ${req.wa.accessToken}` },
        params: { access_token: req.wa.accessToken },
        validateStatus: () => true, maxBodyLength: Infinity,
      }
    );
    if (uploadRes.status < 200 || uploadRes.status >= 300 || !uploadRes.data?.id) {
      const fbErr = uploadRes.data?.error || {};
      return res.status(uploadRes.status || 500).json({
        error: fbErr.error_user_msg || fbErr.message || "Upload to WhatsApp failed",
      });
    }
    const mediaId = uploadRes.data.id;

    // Step 2: send the message referencing the uploaded media.
    const msgBody = {
      messaging_product: "whatsapp",
      to: phone,
      type: kind,
      [kind]: {
        id: mediaId,
        ...(kind !== "audio" && kind !== "sticker" && caption ? { caption } : {}),
        ...(kind === "document" ? { filename: req.file.originalname } : {}),
      },
    };
    const sendRes = await axios.post(
      `${FB_GRAPH_BASE}/${req.wa.phoneNumberId}/messages`,
      msgBody,
      { params: { access_token: req.wa.accessToken }, validateStatus: () => true }
    );
    if (sendRes.status < 200 || sendRes.status >= 300) {
      const fbErr = sendRes.data?.error || {};
      return res.status(sendRes.status || 500).json({
        error: fbErr.error_user_msg || fbErr.message || "Send failed",
      });
    }

    const messageId = sendRes.data?.messages?.[0]?.id || "";
    const msg = await WhatsAppMessage.create({
      user: req.user._id, phoneNumberId: req.wa.phoneNumberId, contactPhone: phone, direction: "outbound",
      type: kind,
      text: caption,
      messageId, status: "sent",
      meta: { media: { kind, id: mediaId, filename: req.file.originalname, mime } },
    });
    emitToUser(req.user._id, "wa.outbound", { message: msg.toJSON() });
    res.json({ ok: true, message: msg, messageId, mediaId });
  } catch (err) { next(err); }
});

// ---------- LABELS ----------
// Default labels seeded on first fetch so every user gets a sane starter set.
// Users can still create/edit/delete their own from the inbox popover.
const DEFAULT_LABELS = [
  { name: "New",       color: "#10b981" },
  { name: "Important", color: "#ef4444" },
  { name: "VIP",       color: "#f59e0b" },
];

// List all labels with the number of contacts using each one.
router.get("/labels", async (req, res, next) => {
  try {
    let labels = await WhatsAppLabel.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();

    // Seed defaults on first visit — skipped once the user has deleted them.
    if (labels.length === 0) {
      try {
        await WhatsAppLabel.insertMany(
          DEFAULT_LABELS.map((l) => ({ ...l, user: req.user._id })),
          { ordered: false }
        );
        labels = await WhatsAppLabel.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
      } catch (e) { /* swallow — a concurrent create would hit the unique index */ }
    }
    // Count contacts per label in a single aggregation call.
    const counts = await WhatsAppContact.aggregate([
      { $match: { user: req.user._id } },
      { $unwind: "$labels" },
      { $group: { _id: "$labels", count: { $sum: 1 } } },
    ]);
    const countMap = Object.fromEntries(counts.map((c) => [String(c._id), c.count]));
    res.json({
      labels: labels.map((l) => ({
        id: l._id.toString(),
        name: l.name,
        color: l.color,
        description: l.description,
        contactCount: countMap[l._id.toString()] || 0,
        createdAt: l.createdAt,
      })),
    });
  } catch (err) { next(err); }
});

router.post("/labels", async (req, res, next) => {
  try {
    const { name, color = "#7c3aed", description = "" } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "name required" });
    try {
      const label = await WhatsAppLabel.create({
        user: req.user._id, name: name.trim(), color, description,
      });
      res.status(201).json({ label });
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ error: `A label named "${name}" already exists.` });
      throw e;
    }
  } catch (err) { next(err); }
});

router.put("/labels/:id", async (req, res, next) => {
  try {
    const { _id, id, user, createdAt, updatedAt, ...patch } = req.body || {};
    const label = await WhatsAppLabel.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      patch,
      { new: true, runValidators: true }
    );
    if (!label) return res.status(404).json({ error: "Label not found" });
    res.json({ label });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A label with that name already exists." });
    next(err);
  }
});

router.delete("/labels/:id", async (req, res, next) => {
  try {
    const r = await WhatsAppLabel.deleteOne({ _id: req.params.id, user: req.user._id });
    if (!r.deletedCount) return res.status(404).json({ error: "Label not found" });
    // Also strip the label id from any contact that had it.
    await WhatsAppContact.updateMany(
      { user: req.user._id, labels: req.params.id },
      { $pull: { labels: req.params.id } }
    );
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

// Assign / unassign labels on a specific contact.
router.put("/contacts/:contactId/labels", async (req, res, next) => {
  try {
    const { labelIds = [] } = req.body || {};
    if (!Array.isArray(labelIds)) return res.status(400).json({ error: "labelIds must be an array" });
    const contact = await WhatsAppContact.findOneAndUpdate(
      { _id: req.params.contactId, user: req.user._id },
      { $set: { labels: labelIds } },
      { new: true }
    ).populate("labels");
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    res.json({ contact });
  } catch (err) { next(err); }
});

// ---------- DASHBOARD STATS ----------
router.get("/stats", async (req, res, next) => {
  try {
    const [contacts, campaigns, messages, conn] = await Promise.all([
      WhatsAppContact.countDocuments({ user: req.user._id }),
      WhatsAppCampaign.countDocuments({ user: req.user._id }),
      WhatsAppMessage.countDocuments({ user: req.user._id }),
      loadConnection(req),
    ]);
    res.json({
      connected: !!conn,
      contacts, campaigns, messagesSent: messages,
      phoneNumber: conn?.phoneNumber || "",
      verifiedName: conn?.verifiedName || "",
    });
  } catch (err) { next(err); }
});

// ---------- ANALYTICS ----------
// Returns aggregated WhatsApp metrics scoped to the current user for the
// analytics dashboard. `days` query param controls the time window (default 30).
router.get("/analytics", async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86400_000);

    const [totals, directionSplit, byDay, byStatus, byHour, topContacts, botStats] = await Promise.all([
      // Totals in window
      WhatsAppMessage.aggregate([
        { $match: { user: req.user._id, ts: { $gte: since } } },
        { $group: { _id: null, total: { $sum: 1 } } },
      ]),
      // Inbound vs outbound
      WhatsAppMessage.aggregate([
        { $match: { user: req.user._id, ts: { $gte: since } } },
        { $group: { _id: "$direction", count: { $sum: 1 } } },
      ]),
      // Per-day trend — inbound / outbound / total
      WhatsAppMessage.aggregate([
        { $match: { user: req.user._id, ts: { $gte: since } } },
        { $group: {
            _id: { d: { $dateToString: { format: "%Y-%m-%d", date: "$ts" } }, dir: "$direction" },
            count: { $sum: 1 },
          }
        },
        { $sort: { "_id.d": 1 } },
      ]),
      // Delivery status distribution (sent/delivered/read/failed/received)
      WhatsAppMessage.aggregate([
        { $match: { user: req.user._id, ts: { $gte: since } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      // By hour-of-day — when people message
      WhatsAppMessage.aggregate([
        { $match: { user: req.user._id, ts: { $gte: since }, direction: "inbound" } },
        { $group: { _id: { $hour: "$ts" }, count: { $sum: 1 } } },
      ]),
      // Top conversations
      WhatsAppMessage.aggregate([
        { $match: { user: req.user._id, ts: { $gte: since } } },
        { $group: { _id: "$contactPhone", count: { $sum: 1 }, inbound: { $sum: { $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0] } } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      // Chatbot stats
      WhatsAppChatbot.find({ user: req.user._id })
        .select("name status messagesHandled lastHandledAt").lean(),
    ]);

    // Normalize day-series — fill missing days with zeros.
    const dayMap = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000);
      const key = d.toISOString().slice(0, 10);
      dayMap[key] = { d: key, inbound: 0, outbound: 0 };
    }
    for (const row of byDay) dayMap[row._id.d][row._id.dir === "inbound" ? "inbound" : "outbound"] = row.count;
    const perDay = Object.values(dayMap);

    // Hour-of-day — fill 0..23.
    const hourMap = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [h, 0]));
    for (const row of byHour) hourMap[row._id] = row.count;

    // Fetch contact names for top list.
    const phones = topContacts.map((t) => t._id);
    const contactDocs = await WhatsAppContact.find({ user: req.user._id, phone: { $in: phones } }).select("phone name").lean();
    const nameByPhone = Object.fromEntries(contactDocs.map((c) => [c.phone, c.name]));

    const dirTotals = Object.fromEntries(directionSplit.map((d) => [d._id, d.count]));
    const statusTotals = Object.fromEntries(byStatus.map((s) => [s._id || "unknown", s.count]));

    res.json({
      days,
      total:     totals[0]?.total || 0,
      inbound:   dirTotals.inbound || 0,
      outbound:  dirTotals.outbound || 0,
      statusTotals,
      perDay,
      perHour:   Object.entries(hourMap).map(([h, count]) => ({ hour: Number(h), count })),
      topContacts: topContacts.map((t) => ({
        phone: t._id, name: nameByPhone[t._id] || t._id,
        count: t.count, inbound: t.inbound, outbound: t.count - t.inbound,
      })),
      chatbots: botStats.map((b) => ({
        id: b._id.toString(), name: b.name, status: b.status,
        messagesHandled: b.messagesHandled || 0, lastHandledAt: b.lastHandledAt,
      })),
    });
  } catch (err) { next(err); }
});

// ---------- REPORTS ----------
// Delivery-focused report: total sent / delivered / read / failed /
// replied + daily trend + per-campaign breakdown. Supports:
//   ?days=7|14|30|90|365|all  (default 30)
//   ?campaignId=<id>          (narrow to one campaign)
router.get("/reports", async (req, res, next) => {
  try {
    const { campaignId } = req.query;
    const daysParam = String(req.query.days || "30");
    const days = daysParam === "all" ? null : Math.min(Math.max(Number(daysParam) || 30, 1), 365);
    const since = days ? new Date(Date.now() - days * 86400_000) : null;

    // Scope filter shared by every aggregation below.
    const baseMatch = { user: req.user._id };
    if (since) baseMatch.ts = { $gte: since };
    if (campaignId) {
      try { baseMatch.campaign = new (require("mongoose")).Types.ObjectId(campaignId); }
      catch { return res.status(400).json({ error: "Invalid campaignId" }); }
    }

    const [
      outboundByStatus,
      replies,
      perDay,
      allCampaigns,
    ] = await Promise.all([
      // Outbound messages grouped by status (sent / delivered / read / failed / ...)
      WhatsAppMessage.aggregate([
        { $match: { ...baseMatch, direction: "outbound" } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      // Replies = inbound messages from contacts we had sent outbound to.
      // For simplicity we just count inbound messages in the same window —
      // this is the standard "reply rate" definition.
      WhatsAppMessage.countDocuments({ ...baseMatch, direction: "inbound" }),
      // Daily trend — sent vs delivered vs read vs replied.
      WhatsAppMessage.aggregate([
        { $match: baseMatch },
        { $group: {
            _id: {
              d: { $dateToString: { format: "%Y-%m-%d", date: "$ts" } },
              direction: "$direction",
              status: "$status",
            },
            count: { $sum: 1 },
          }
        },
        { $sort: { "_id.d": 1 } },
      ]),
      // Campaigns list (with their counters) — scoped to user, no date
      // filter so the dropdown can always pick historical campaigns.
      WhatsAppCampaign
        .find({ user: req.user._id })
        .select("name templateName status sent delivered read failed createdAt contacts")
        .sort({ createdAt: -1 }),
    ]);

    // Normalize status totals.
    const statusMap = Object.fromEntries(outboundByStatus.map((r) => [r._id || "unknown", r.count]));
    const sent      = (statusMap.sent      || 0) + (statusMap.delivered || 0) + (statusMap.read || 0);
    const delivered = (statusMap.delivered || 0) + (statusMap.read || 0);
    const read      = (statusMap.read      || 0);
    const failed    = (statusMap.failed    || 0) + (statusMap.undelivered || 0) + (statusMap.error || 0);
    const notDelivered = Math.max(0, sent - delivered);
    const outboundTotal = Object.values(statusMap).reduce((s, n) => s + n, 0);

    // Fill-in per-day trend so the chart doesn't have gaps.
    const dayKeys = [];
    if (days) {
      for (let i = days - 1; i >= 0; i--) {
        dayKeys.push(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10));
      }
    } else if (perDay.length) {
      const unique = Array.from(new Set(perDay.map((r) => r._id.d))).sort();
      dayKeys.push(...unique);
    }
    const trend = dayKeys.map((k) => ({ d: k, sent: 0, delivered: 0, read: 0, replied: 0 }));
    const ix = Object.fromEntries(trend.map((r, i) => [r.d, i]));
    for (const row of perDay) {
      const i = ix[row._id.d];
      if (i == null) continue;
      const st = row._id.status;
      const dir = row._id.direction;
      if (dir === "inbound") {
        trend[i].replied += row.count;
      } else {
        // outbound buckets — each message contributes to every stage it reached.
        if (st === "sent" || st === "delivered" || st === "read") trend[i].sent += row.count;
        if (st === "delivered" || st === "read")                  trend[i].delivered += row.count;
        if (st === "read")                                        trend[i].read += row.count;
      }
    }

    res.json({
      window:  { days, since: since ? since.toISOString() : null },
      campaignId: campaignId || null,
      totals: {
        sent, delivered, read, failed, notDelivered,
        replied: replies,
        outboundTotal,
        deliveryRate: sent ? Math.round((delivered / sent) * 100) : 0,
        readRate:     sent ? Math.round((read / sent) * 100)      : 0,
        replyRate:    sent ? Math.round((replies / sent) * 100)   : 0,
      },
      trend,
      campaigns: allCampaigns.map((c) => ({
        id: c._id.toString(),
        name: c.name,
        templateName: c.templateName,
        status: c.status,
        contacts: (c.contacts || []).length,
        sent: c.sent || 0,
        delivered: c.delivered || 0,
        read: c.read || 0,
        failed: c.failed || 0,
        notDelivered: Math.max(0, (c.sent || 0) - (c.delivered || 0)),
        deliveryRate: c.sent ? Math.round(((c.delivered || 0) / c.sent) * 100) : 0,
        readRate:     c.sent ? Math.round(((c.read      || 0) / c.sent) * 100) : 0,
        createdAt: c.createdAt,
      })),
    });
  } catch (err) { next(err); }
});

// ---------- AUTOMATION FLOWS ----------
router.get("/flows", async (req, res, next) => {
  try {
    const flows = await WhatsAppFlow.find(flowScope(req)).sort({ createdAt: -1 });
    res.json({ flows });
  } catch (err) { next(err); }
});

router.get("/flows/:id", async (req, res, next) => {
  try {
    const flow = await WhatsAppFlow.findOne({ _id: req.params.id, ...flowScope(req) });
    if (!flow) return res.status(404).json({ error: "Flow not found" });
    res.json({ flow });
  } catch (err) { next(err); }
});

router.post("/flows", async (req, res, next) => {
  try {
    const { name, nodes = [], edges = [], status = "draft" } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const flow = await WhatsAppFlow.create({
      user: req.user._id,
      organization: tenantId(req),
      name,
      nodes,
      edges,
      status,
    });
    res.status(201).json({ flow });
  } catch (err) { next(err); }
});

router.put("/flows/:id", async (req, res, next) => {
  try {
    const { _id, id, user, organization, ...patch } = req.body || {};
    const flow = await WhatsAppFlow.findOneAndUpdate(
      { _id: req.params.id, ...flowScope(req) },
      patch,
      { new: true, runValidators: true }
    );
    if (!flow) return res.status(404).json({ error: "Flow not found" });
    res.json({ flow });
  } catch (err) { next(err); }
});

router.delete("/flows/:id", async (req, res, next) => {
  try {
    const r = await WhatsAppFlow.deleteOne({ _id: req.params.id, ...flowScope(req) });
    if (!r.deletedCount) return res.status(404).json({ error: "Flow not found" });
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

// ---------- CHATBOT (keyword-driven with CTA buttons) ----------
router.get("/chatbots", async (req, res, next) => {
  try {
    const bots = await WhatsAppChatbot.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json({ chatbots: bots });
  } catch (err) { next(err); }
});

router.get("/chatbots/:id", async (req, res, next) => {
  try {
    const bot = await WhatsAppChatbot.findOne({ _id: req.params.id, user: req.user._id });
    if (!bot) return res.status(404).json({ error: "Chatbot not found" });
    res.json({ chatbot: bot });
  } catch (err) { next(err); }
});

router.post("/chatbots", async (req, res, next) => {
  try {
    const { name, description = "", status = "draft", fallback, steps = [] } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const bot = await WhatsAppChatbot.create({
      user: req.user._id, name, description, status,
      fallback: fallback || undefined,
      steps: steps.length ? steps : [
        // Seed with a sensible starting step so the builder isn't blank.
        {
          id: "start",
          isStart: true,
          triggers: ["hi", "hello", "hey", "start", "menu"],
          message: "Hi 👋 How can we help you today?",
          buttons: [
            { id: "b_pricing", kind: "quick_reply", label: "See pricing",  nextStepId: "" },
            { id: "b_support", kind: "quick_reply", label: "Talk to human", nextStepId: "" },
          ],
        },
      ],
    });
    res.status(201).json({ chatbot: bot });
  } catch (err) { next(err); }
});

router.put("/chatbots/:id", async (req, res, next) => {
  try {
    const { _id, id, user, createdAt, updatedAt, messagesHandled, lastHandledAt, ...patch } = req.body || {};
    const bot = await WhatsAppChatbot.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id }, patch, { new: true, runValidators: true }
    );
    if (!bot) return res.status(404).json({ error: "Chatbot not found" });
    res.json({ chatbot: bot });
  } catch (err) { next(err); }
});

router.delete("/chatbots/:id", async (req, res, next) => {
  try {
    const r = await WhatsAppChatbot.deleteOne({ _id: req.params.id, user: req.user._id });
    if (!r.deletedCount) return res.status(404).json({ error: "Chatbot not found" });
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

// Try-it endpoint — given an input message, returns which step would fire.
// Lets the builder preview the bot without a real WhatsApp connection.
router.post("/chatbots/:id/simulate", async (req, res, next) => {
  try {
    const { input = "", fromStepId = "" } = req.body || {};
    const bot = await WhatsAppChatbot.findOne({ _id: req.params.id, user: req.user._id });
    if (!bot) return res.status(404).json({ error: "Chatbot not found" });

    const steps = bot.steps || [];
    const lower = String(input).trim().toLowerCase();

    // If coming from a button tap (fromStepId set), honor the button's nextStepId first.
    if (fromStepId) {
      const from = steps.find((s) => s.id === fromStepId);
      const btn = (from?.buttons || []).find((b) => b.label.toLowerCase() === lower || b.id === lower);
      if (btn?.kind === "quick_reply" && btn.nextStepId) {
        const target = steps.find((s) => s.id === btn.nextStepId);
        if (target) return res.json({ match: "button", step: target });
      }
    }

    // Otherwise match against triggers (contains, case-insensitive).
    const matched = steps.find((s) =>
      (s.triggers || []).some((t) => t && lower.includes(t.toLowerCase()))
    );
    if (matched) return res.json({ match: "trigger", step: matched });

    const start = steps.find((s) => s.isStart);
    if (start && !lower) return res.json({ match: "start", step: start });

    return res.json({ match: "fallback", fallback: bot.fallback });
  } catch (err) { next(err); }
});

module.exports = router;
