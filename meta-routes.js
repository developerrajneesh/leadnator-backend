// Meta (Facebook) Graph API proxy routes
// All routes require the JWT-auth user (attached as req.user). They use
// req.user's stored meta.accessToken or the x-fb-access-token header.

const express = require("express");
const axios = require("axios");
const multer = require("multer");
const FormData = require("form-data");
const User = require("./models/User");
const Organization = require("./models/Organization");
const { tenantId } = require("./middleware/tenant");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const FB_API_VERSION = process.env.META_API_VERSION || "v23.0";
const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_API_VERSION}`;
const FB_APP_ID = process.env.FB_APP_ID || "";
const FB_APP_SECRET = process.env.FB_APP_SECRET || "";

function pickToken(req) {
  return req.header("x-fb-access-token")
    || req.organization?.meta?.accessToken
    || req.user?.meta?.accessToken
    || "";
}

async function loadOrgMeta(req) {
  if (req.organization?.meta?.accessToken) return req.organization;
  const org = await Organization.findById(tenantId(req)).select("+meta.accessToken");
  if (org) req.organization = org;
  return org;
}

async function saveOrgMeta(req, metaPatch) {
  const org = await Organization.findByIdAndUpdate(
    tenantId(req),
    { $set: { meta: metaPatch } },
    { new: true },
  ).select("+meta.accessToken");
  if (org) req.organization = org;
  return org;
}

async function fbRequest({ method, url, params, data, accessToken }) {
  const res = await axios({
    method, url,
    params: { ...params, access_token: accessToken },
    data,
    validateStatus: () => true,
  });
  if (res.status >= 200 && res.status < 300) return res.data;
  const fbErr = res.data?.error || { message: res.statusText, code: res.status };
  // Prefer Meta's user-friendly title/message ("Budget type change not allowed")
  // over the generic technical one ("Invalid parameter").
  const friendly = fbErr.error_user_msg
    || (fbErr.error_user_title ? `${fbErr.error_user_title} — ${fbErr.message || ""}`.trim() : null)
    || fbErr.message
    || "Facebook API error";
  const e = new Error(friendly);
  e.status = res.status;
  e.fb = fbErr;
  throw e;
}

function metaErrorHandler(err, _req, res, _next) {
  const expired = err.fb && err.fb.code === 190;
  res.status(err.status || 500).json({
    error: err.message || "Meta error",
    fb: err.fb,
    tokenExpired: expired,
  });
}

async function requireMetaToken(req, res, next) {
  await loadOrgMeta(req);
  if (!req.organization?.meta?.accessToken && !req.user.meta?.accessToken) {
    const u = await User.findById(req.user._id).select("+meta.accessToken");
    if (u?.meta?.accessToken) req.user.meta = u.meta;
  }
  const token = pickToken(req);
  if (!token) return res.status(401).json({ error: "Meta account not connected", code: "META_NOT_CONNECTED" });
  req.metaToken = token;
  next();
}

const router = express.Router();

// Save short-lived token + exchange for long-lived; persist to user
router.post("/connect", async (req, res, next) => {
  try {
    const { shortLivedToken } = req.body || {};
    if (!shortLivedToken) return res.status(400).json({ error: "shortLivedToken required" });
    if (!FB_APP_ID || !FB_APP_SECRET) {
      return res.status(500).json({ error: "Server missing FB_APP_ID / FB_APP_SECRET" });
    }

    // Exchange for long-lived token
    const exchange = await axios.get(`${FB_GRAPH_BASE}/oauth/access_token`, {
      params: {
        grant_type: "fb_exchange_token",
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        fb_exchange_token: shortLivedToken,
      },
      validateStatus: () => true,
    });
    if (exchange.status !== 200) {
      return res.status(exchange.status).json({ error: "Token exchange failed", fb: exchange.data?.error });
    }
    const longLivedToken = exchange.data.access_token;

    // Fetch basic FB profile + ad accounts
    const [me, accounts] = await Promise.all([
      fbRequest({ method: "get", url: `${FB_GRAPH_BASE}/me`, params: { fields: "id,name,email" }, accessToken: longLivedToken }),
      fbRequest({
        method: "get",
        url: `${FB_GRAPH_BASE}/me/adaccounts`,
        params: { fields: "id,account_id,name,account_status,currency" },
        accessToken: longLivedToken,
      }),
    ]);

    const adList = (accounts?.data || []).filter((a) => a?.id);
    const defaultAccount = adList[0]?.id || "";

    await saveOrgMeta(req, {
      accessToken: longLivedToken,
      fbUserId: me.id,
      fbUserName: me.name,
      adAccountId: defaultAccount,
      accounts: adList,
      connectedAt: new Date(),
    });

    // Auto-subscribe ALL of the user's Pages to `leadgen` webhooks the moment they
    // connect — so leads from every page (including existing/old forms) start
    // flowing into the CRM automatically. Silent + best-effort: never block connect.
    const webhookSummary = await autoSubscribeAllPages(req, longLivedToken).catch((e) => {
      console.error("Auto page webhook subscription failed:", e.message);
      return { subscribed: 0, total: 0 };
    });

    res.json({
      connected: true,
      fbUser: { id: me.id, name: me.name, email: me.email },
      accounts: adList,
      selectedAdAccountId: defaultAccount,
      webhooks: webhookSummary,
    });
  } catch (err) { next(err); }
});

// Fetch every Page the user manages, persist their page tokens, and subscribe
// each Page to `leadgen` webhook events. Used on connect so lead delivery is set
// up for the whole account with no extra UI/steps for the user.
async function autoSubscribeAllPages(req, userToken) {
  const summary = { subscribed: 0, total: 0, failed: 0 };

  const pagesResp = await fbRequest({
    method: "get",
    url: `${FB_GRAPH_BASE}/me/accounts`,
    params: { fields: "id,name,access_token", limit: 100 },
    accessToken: userToken,
  });
  const pageList = (pagesResp?.data || []).filter((p) => p?.id && p?.access_token);
  summary.total = pageList.length;
  if (pageList.length === 0) return summary;

  const user = await User.findById(req.user._id).select("+meta.pages.accessToken +meta.webhookVerifyToken");
  if (!user) return summary;
  user.meta = user.meta || {};
  // Ensure a webhook verify token exists for this user.
  if (!user.meta.webhookVerifyToken) {
    user.meta.webhookVerifyToken = require("crypto").randomBytes(18).toString("base64url");
  }

  // Subscribe each Page to leadgen events with its own Page access token.
  const results = await Promise.allSettled(
    pageList.map((p) =>
      fbRequest({
        method: "post",
        url: `${FB_GRAPH_BASE}/${p.id}/subscribed_apps`,
        data: { subscribed_fields: "leadgen" },
        accessToken: p.access_token,
      })
    )
  );

  // Persist pages (preserve prior subscribed flags on failure).
  const prevById = Object.fromEntries((user.meta.pages || []).map((p) => [p.id, p]));
  user.meta.pages = pageList.map((p, i) => {
    const ok = results[i].status === "fulfilled";
    if (ok) summary.subscribed += 1;
    else {
      summary.failed += 1;
      console.error(`Auto-subscribe failed for page ${p.id} (${p.name}):`, results[i].reason?.message);
    }
    return {
      id: p.id,
      name: p.name,
      accessToken: p.access_token,
      subscribed: ok || prevById[p.id]?.subscribed || false,
      subscribedAt: ok ? new Date() : (prevById[p.id]?.subscribedAt || null),
    };
  });

  await user.save();
  console.log(`✅ Auto-subscribed ${summary.subscribed}/${summary.total} page(s) to leadgen webhooks`);
  return summary;
}

router.post("/select-account", async (req, res, next) => {
  try {
    const { adAccountId } = req.body || {};
    if (!adAccountId) return res.status(400).json({ error: "adAccountId required" });
    const org = await loadOrgMeta(req);
    if (org?.meta?.accessToken) {
      await Organization.findByIdAndUpdate(tenantId(req), { "meta.adAccountId": adAccountId });
    } else {
      await User.findByIdAndUpdate(req.user._id, { "meta.adAccountId": adAccountId });
    }
    res.json({ selectedAdAccountId: adAccountId });
  } catch (err) { next(err); }
});

router.post("/disconnect", async (req, res, next) => {
  try {
    const empty = { accessToken: "", fbUserId: "", fbUserName: "", adAccountId: "", accounts: [], connectedAt: null };
    await saveOrgMeta(req, empty);
    res.json({ disconnected: true });
  } catch (err) { next(err); }
});

router.get("/status", async (req, res, next) => {
  try {
    const org = await loadOrgMeta(req);
    const meta = org?.meta;
    const connected = !!meta?.accessToken;
    res.json({
      connected,
      fbUser: connected ? { id: meta.fbUserId, name: meta.fbUserName } : null,
      accounts: connected ? meta.accounts : [],
      selectedAdAccountId: connected ? meta.adAccountId : "",
      connectedAt: connected ? meta.connectedAt : null,
    });
  } catch (err) { next(err); }
});

// --- Protected Graph API proxy routes below ---
router.use(requireMetaToken);

router.get("/ad-accounts", async (req, res, next) => {
  try {
    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/me/adaccounts`,
      params: { fields: "id,account_id,name,account_status,currency,amount_spent,balance,business_name" },
      accessToken: req.metaToken,
    });
    res.json({ adAccounts: data });
  } catch (err) { next(err); }
});

router.get("/ad-accounts/:adAccountId", async (req, res, next) => {
  try {
    const actId = req.params.adAccountId.startsWith("act_") ? req.params.adAccountId : `act_${req.params.adAccountId}`;
    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${actId}`,
      params: { fields: "id,account_id,name,account_status,currency,amount_spent,balance,business_name,funding_source_details,min_daily_budget" },
      accessToken: req.metaToken,
    });
    res.json({ account: data });
  } catch (err) { next(err); }
});

router.get("/campaigns", async (req, res, next) => {
  try {
    const { adAccountId, limit = 25, after } = req.query;
    if (!adAccountId) return res.status(400).json({ error: "adAccountId required" });
    const actId = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;
    const params = {
      fields: "id,name,status,objective,effective_status,created_time,updated_time,daily_budget,lifetime_budget",
      limit,
    };
    if (after) params.after = after;
    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${actId}/campaigns`,
      params,
      accessToken: req.metaToken,
    });
    res.json({ campaigns: data });
  } catch (err) { next(err); }
});

// Comprehensive field lists — request everything Meta exposes for the entity
// so the detail page can render whatever's available. Anything Meta doesn't
// have access to gracefully comes back as undefined.
const CAMPAIGN_FIELDS = [
  "id","name","status","effective_status","configured_status","objective",
  "buying_type","bid_strategy","budget_remaining","daily_budget","lifetime_budget",
  "spend_cap","special_ad_categories","special_ad_category_country",
  "start_time","stop_time","created_time","updated_time","account_id",
  "smart_promotion_type","source_campaign_id","can_use_spend_cap",
  "promoted_object","pacing_type",
].join(",");

const ADSET_FIELDS = [
  "id","name","status","effective_status","configured_status","campaign_id",
  "daily_budget","lifetime_budget","budget_remaining",
  "optimization_goal","billing_event","bid_amount","bid_strategy","pacing_type",
  "destination_type","start_time","end_time","created_time","updated_time","account_id",
  "targeting","promoted_object","attribution_spec","frequency_control_specs",
  "learning_stage_info","source_adset_id","is_dynamic_creative",
].join(",");

const AD_FIELDS = [
  "id","name","status","effective_status","configured_status",
  "adset_id","campaign_id","account_id",
  "tracking_specs","conversion_specs","preview_shareable_link","issues_info",
  "created_time","updated_time","source_ad_id",
  "creative{id,name,title,body,image_url,image_hash,video_id,thumbnail_url,object_story_spec,object_story_id,link_url,call_to_action_type,instagram_permalink_url,effective_object_story_id,status}",
].join(",");

// ----- Single-entity fetch (detail pages) -----
router.get("/campaign/:campaignId", async (req, res, next) => {
  try {
    const data = await fbRequest({
      method: "get", url: `${FB_GRAPH_BASE}/${req.params.campaignId}`,
      params: { fields: CAMPAIGN_FIELDS }, accessToken: req.metaToken,
    });
    res.json({ campaign: data });
  } catch (err) { next(err); }
});

router.get("/adset/:adsetId", async (req, res, next) => {
  try {
    const data = await fbRequest({
      method: "get", url: `${FB_GRAPH_BASE}/${req.params.adsetId}`,
      params: { fields: ADSET_FIELDS }, accessToken: req.metaToken,
    });
    res.json({ adset: data });
  } catch (err) { next(err); }
});

router.get("/ad/:adId", async (req, res, next) => {
  try {
    const data = await fbRequest({
      method: "get", url: `${FB_GRAPH_BASE}/${req.params.adId}`,
      params: { fields: AD_FIELDS }, accessToken: req.metaToken,
    });
    res.json({ ad: data });
  } catch (err) { next(err); }
});

// ----- Update (edit) endpoints — POST any subset of editable fields -----
// Meta's pattern is `POST /{ENTITY_ID}` with the modified fields in the body.
// We whitelist editable fields per entity so callers can't accidentally try to
// mutate read-only fields (account_id, created_time, etc.) which Meta rejects.
const CAMPAIGN_EDITABLE = new Set([
  "name","status","daily_budget","lifetime_budget","spend_cap",
  "bid_strategy","pacing_type","start_time","stop_time",
  "special_ad_categories","special_ad_category_country",
]);
const ADSET_EDITABLE = new Set([
  "name","status","daily_budget","lifetime_budget","bid_amount","bid_strategy",
  "optimization_goal","billing_event","start_time","end_time","pacing_type",
  "destination_type","targeting","promoted_object","frequency_control_specs",
  "attribution_spec",
]);
const AD_EDITABLE = new Set([
  "name","status","tracking_specs","conversion_specs","creative",
]);

function pick(body, allowed) {
  const out = {};
  for (const k of Object.keys(body || {})) {
    if (allowed.has(k) && body[k] !== undefined && body[k] !== "") out[k] = body[k];
  }
  return out;
}

router.post("/campaign/:id", async (req, res, next) => {
  try {
    const data = pick(req.body, CAMPAIGN_EDITABLE);
    if (!Object.keys(data).length) return res.status(400).json({ error: "No editable fields provided" });
    const result = await fbRequest({
      method: "post", url: `${FB_GRAPH_BASE}/${req.params.id}`,
      data, accessToken: req.metaToken,
    });
    res.json({ ok: !!result?.success, result, applied: data });
  } catch (err) { next(err); }
});

router.post("/adset/:id", async (req, res, next) => {
  try {
    const data = pick(req.body, ADSET_EDITABLE);
    if (!Object.keys(data).length) return res.status(400).json({ error: "No editable fields provided" });
    const result = await fbRequest({
      method: "post", url: `${FB_GRAPH_BASE}/${req.params.id}`,
      data, accessToken: req.metaToken,
    });
    res.json({ ok: !!result?.success, result, applied: data });
  } catch (err) { next(err); }
});

router.post("/ad/:id", async (req, res, next) => {
  try {
    const data = pick(req.body, AD_EDITABLE);
    if (!Object.keys(data).length) return res.status(400).json({ error: "No editable fields provided" });
    const result = await fbRequest({
      method: "post", url: `${FB_GRAPH_BASE}/${req.params.id}`,
      data, accessToken: req.metaToken,
    });
    res.json({ ok: !!result?.success, result, applied: data });
  } catch (err) { next(err); }
});

// ----- Lifetime / per-period insights for any entity -----
router.get("/insights/:entityId", async (req, res, next) => {
  try {
    const { datePreset = "lifetime" } = req.query;
    const data = await fbRequest({
      method: "get", url: `${FB_GRAPH_BASE}/${req.params.entityId}/insights`,
      params: {
        date_preset: datePreset,
        fields: "spend,impressions,reach,clicks,cpc,cpm,ctr,frequency,actions,cost_per_action_type,unique_clicks,unique_ctr",
      },
      accessToken: req.metaToken,
    });
    res.json({ insights: data?.data?.[0] || null });
  } catch (err) { next(err); }
});

// List ad sets that belong to a campaign.
router.get("/campaigns/:campaignId/adsets", async (req, res, next) => {
  try {
    const { campaignId } = req.params;
    const { limit = 50, after } = req.query;
    const params = { fields: ADSET_FIELDS, limit };
    if (after) params.after = after;
    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${campaignId}/adsets`,
      params,
      accessToken: req.metaToken,
    });
    res.json({ adsets: data });
  } catch (err) { next(err); }
});

// List ads under an ad set.
router.get("/adsets/:adsetId/ads", async (req, res, next) => {
  try {
    const { adsetId } = req.params;
    const { limit = 50, after } = req.query;
    const params = { fields: AD_FIELDS, limit };
    if (after) params.after = after;
    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${adsetId}/ads`,
      params,
      accessToken: req.metaToken,
    });
    res.json({ ads: data });
  } catch (err) { next(err); }
});

router.post("/campaigns", async (req, res, next) => {
  try {
    const {
      adAccountId, name, objective,
      status = "PAUSED",
      special_ad_categories = [],
      // Meta now requires this when not using campaign-level budget — opt out
      // by default so ad sets carry their own budgets (the wizard's pattern).
      // Pass `true` from the client to enable Advantage Campaign Budget.
      is_adset_budget_sharing_enabled,
      // Optional campaign-budget fields. If either is set, Meta accepts the
      // campaign as CBO and `is_adset_budget_sharing_enabled` is irrelevant.
      daily_budget,
      lifetime_budget,
      bid_strategy,
    } = req.body || {};
    if (!adAccountId || !name || !objective) {
      return res.status(400).json({ error: "adAccountId, name, objective required" });
    }
    const actId = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;

    const usingCBO = daily_budget || lifetime_budget;

    const payload = {
      name: String(name).trim(),
      objective,
      status: String(status).toUpperCase(),
      special_ad_categories: Array.isArray(special_ad_categories) ? special_ad_categories : [],
      // Default to false (ad-set budgets) so the wizard works without forcing
      // CBO. Caller can override.
      is_adset_budget_sharing_enabled:
        is_adset_budget_sharing_enabled === undefined ? false : !!is_adset_budget_sharing_enabled,
    };
    if (usingCBO) {
      if (daily_budget)    payload.daily_budget    = String(daily_budget);
      if (lifetime_budget) payload.lifetime_budget = String(lifetime_budget);
      if (bid_strategy)    payload.bid_strategy    = bid_strategy;
      // CBO conflicts with adset-budget sharing — drop the flag entirely.
      delete payload.is_adset_budget_sharing_enabled;
    }

    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${actId}/campaigns`,
      data: payload,
      accessToken: req.metaToken,
    });
    res.status(201).json({ campaign: data });
  } catch (err) { next(err); }
});

router.post("/campaigns/:campaignId/pause", async (req, res, next) => {
  try {
    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${req.params.campaignId}`,
      data: { status: "PAUSED" },
      accessToken: req.metaToken,
    });
    res.json({ result: data });
  } catch (err) { next(err); }
});

router.post("/campaigns/:campaignId/activate", async (req, res, next) => {
  try {
    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${req.params.campaignId}`,
      data: { status: "ACTIVE" },
      accessToken: req.metaToken,
    });
    res.json({ result: data });
  } catch (err) { next(err); }
});

router.delete("/campaigns/:campaignId", async (req, res, next) => {
  try {
    const data = await fbRequest({
      method: "delete",
      url: `${FB_GRAPH_BASE}/${req.params.campaignId}`,
      accessToken: req.metaToken,
    });
    res.json({ result: data });
  } catch (err) { next(err); }
});

router.get("/insights", async (req, res, next) => {
  try {
    const { adAccountId, datePreset = "last_30d", level, timeIncrement } = req.query;
    if (!adAccountId) return res.status(400).json({ error: "adAccountId required" });
    const actId = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;
    const params = {
      fields: [
        "campaign_id","campaign_name","adset_id","adset_name","ad_id","ad_name",
        "impressions","clicks","ctr","spend","reach","frequency","cpc","cpm","cpp","actions",
      ].join(","),
      date_preset: datePreset,
    };
    if (level) params.level = level;
    if (timeIncrement) params.time_increment = Number(timeIncrement);

    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${actId}/insights`,
      params,
      accessToken: req.metaToken,
    });
    res.json({ insights: data });
  } catch (err) { next(err); }
});

// Aggregated overview for a single ad account (account details + counts + funds + insights summary)
router.get("/overview/:adAccountId", async (req, res, next) => {
  try {
    const id = req.params.adAccountId;
    const actId = id.startsWith("act_") ? id : `act_${id}`;

    const params = {
      account: {
        fields: "id,account_id,name,account_status,currency,amount_spent,balance,spend_cap,business_name,timezone_name,funding_source,funding_source_details,min_daily_budget",
      },
      insights: {
        fields: "impressions,clicks,ctr,spend,reach,frequency,cpc,cpm",
        date_preset: "last_30d",
        level: "account",
      },
      summary: {
        fields: "id",
        summary: "total_count",
        limit: 1,
      },
    };

    const [account, insights, campaignsPage, adsetsPage, adsPage] = await Promise.all([
      fbRequest({ method: "get", url: `${FB_GRAPH_BASE}/${actId}`,            params: params.account,  accessToken: req.metaToken }).catch((e) => ({ _error: e.message })),
      fbRequest({ method: "get", url: `${FB_GRAPH_BASE}/${actId}/insights`,   params: params.insights, accessToken: req.metaToken }).catch(() => ({ data: [] })),
      fbRequest({ method: "get", url: `${FB_GRAPH_BASE}/${actId}/campaigns`,  params: params.summary,  accessToken: req.metaToken }).catch(() => ({})),
      fbRequest({ method: "get", url: `${FB_GRAPH_BASE}/${actId}/adsets`,     params: params.summary,  accessToken: req.metaToken }).catch(() => ({})),
      fbRequest({ method: "get", url: `${FB_GRAPH_BASE}/${actId}/ads`,        params: params.summary,  accessToken: req.metaToken }).catch(() => ({})),
    ]);

    const counts = {
      campaigns: campaignsPage?.summary?.total_count ?? (campaignsPage?.data?.length || 0),
      adsets:    adsetsPage?.summary?.total_count    ?? (adsetsPage?.data?.length    || 0),
      ads:       adsPage?.summary?.total_count       ?? (adsPage?.data?.length       || 0),
    };

    const insightTotals = (insights?.data?.[0]) || {};

    res.json({ account, counts, insights: insightTotals });
  } catch (err) { next(err); }
});

// Create an ad set (budget + targeting + destination)
router.post("/adsets", async (req, res, next) => {
  try {
    const {
      adAccountId, campaignId, name,
      dailyBudget, lifetimeBudget,
      optimizationGoal = "LINK_CLICKS",
      billingEvent   = "IMPRESSIONS",
      bidStrategy    = "LOWEST_COST_WITHOUT_CAP",
      destinationType,
      promotedObject,
      targeting      = { geo_locations: { countries: ["IN"] }, age_min: 18, age_max: 65 },
      status         = "PAUSED",
      startTime, endTime,
    } = req.body || {};

    if (!adAccountId || !campaignId || !name) {
      return res.status(400).json({ error: "adAccountId, campaignId, name required" });
    }
    const actId = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;

    const payload = {
      name, campaign_id: campaignId,
      optimization_goal: optimizationGoal,
      billing_event: billingEvent,
      bid_strategy: bidStrategy,
      targeting,
      status,
    };
    if (dailyBudget)    payload.daily_budget    = Math.round(Number(dailyBudget) * 100);  // in cents/paise
    if (lifetimeBudget) payload.lifetime_budget = Math.round(Number(lifetimeBudget) * 100);
    if (destinationType) payload.destination_type = destinationType;
    if (promotedObject)  payload.promoted_object = promotedObject;
    if (startTime)       payload.start_time      = startTime;
    if (endTime)         payload.end_time        = endTime;

    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${actId}/adsets`,
      data: payload,
      accessToken: req.metaToken,
    });
    res.status(201).json({ adset: data });
  } catch (err) { next(err); }
});

// Create an ad (links creative to ad set)
router.post("/ads", async (req, res, next) => {
  try {
    const { adAccountId, adsetId, name, creative, status = "PAUSED" } = req.body || {};
    if (!adAccountId || !adsetId || !name || !creative) {
      return res.status(400).json({ error: "adAccountId, adsetId, name, creative required" });
    }
    const actId = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;
    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${actId}/ads`,
      data: { name, adset_id: adsetId, creative, status },
      accessToken: req.metaToken,
    });
    res.status(201).json({ ad: data });
  } catch (err) { next(err); }
});

// ----- Lead Ads webhook config (verify token + Page subscription) -----
// Returns this user's webhook URL + verify token so they can paste it into
// Meta App Dashboard. Generates a token on first read.
router.get("/webhook", async (req, res, next) => {
  try {
    let user = await User.findById(req.user._id).select("+meta.webhookVerifyToken");
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.meta?.webhookVerifyToken) {
      user.meta = user.meta || {};
      user.meta.webhookVerifyToken = require("crypto").randomBytes(18).toString("base64url");
      await user.save();
    }
    const base = process.env.PUBLIC_WEBHOOK_BASE || `${req.protocol}://${req.get("host")}`;
    res.json({
      url: `${base.replace(/\/$/, "")}/webhooks/facebook`,
      verifyToken: user.meta.webhookVerifyToken,
      pages: (user.meta.pages || []).map((p) => ({ id: p.id, name: p.name, subscribed: p.subscribed, subscribedAt: p.subscribedAt })),
      recommendedFields: ["leadgen"],
    });
  } catch (err) { next(err); }
});

router.post("/webhook/rotate-token", async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select("+meta.webhookVerifyToken");
    user.meta = user.meta || {};
    user.meta.webhookVerifyToken = require("crypto").randomBytes(18).toString("base64url");
    await user.save();
    res.json({ verifyToken: user.meta.webhookVerifyToken });
  } catch (err) { next(err); }
});

// Refresh the user's pages list from Meta + persist their per-page tokens
// so the webhook handler can call Meta on the user's behalf later.
router.post("/webhook/sync-pages", async (req, res, next) => {
  try {
    const data = await fbRequest({
      method: "get", url: `${FB_GRAPH_BASE}/me/accounts`,
      params: { fields: "id,name,access_token", limit: 100 },
      accessToken: req.metaToken,
    });
    const list = data?.data || [];
    const user = await User.findById(req.user._id).select("+meta.pages.accessToken");
    user.meta = user.meta || {};
    // Merge — preserve existing `subscribed` flags.
    const byId = Object.fromEntries((user.meta.pages || []).map((p) => [p.id, p]));
    user.meta.pages = list.map((p) => ({
      id: p.id,
      name: p.name,
      accessToken: p.access_token,
      subscribed:   byId[p.id]?.subscribed   || false,
      subscribedAt: byId[p.id]?.subscribedAt || null,
    }));
    await user.save();
    res.json({ pages: user.meta.pages.map((p) => ({ id: p.id, name: p.name, subscribed: p.subscribed })) });
  } catch (err) { next(err); }
});

// Subscribe (or unsubscribe) a single Page for `leadgen` events. Meta requires
// us to call POST /{PAGE_ID}/subscribed_apps with the page's own access token.
router.post("/webhook/subscribe-page", async (req, res, next) => {
  try {
    const { pageId, subscribe = true } = req.body || {};
    if (!pageId) return res.status(400).json({ error: "pageId required" });

    const user = await User.findById(req.user._id).select("+meta.pages.accessToken");
    const page = (user.meta?.pages || []).find((p) => p.id === pageId);
    if (!page) return res.status(404).json({ error: "Page not found in your synced list. Run sync first." });
    if (!page.accessToken) return res.status(400).json({ error: "Missing page access token. Re-sync pages." });

    if (subscribe) {
      await fbRequest({
        method: "post",
        url: `${FB_GRAPH_BASE}/${pageId}/subscribed_apps`,
        data: { subscribed_fields: "leadgen" },
        accessToken: page.accessToken,
      });
      page.subscribed = true; page.subscribedAt = new Date();
    } else {
      await fbRequest({
        method: "delete",
        url: `${FB_GRAPH_BASE}/${pageId}/subscribed_apps`,
        accessToken: page.accessToken,
      });
      page.subscribed = false; page.subscribedAt = null;
    }
    await user.save();
    res.json({ ok: true, pageId, subscribed: page.subscribed });
  } catch (err) { next(err); }
});

router.get("/pages", async (req, res, next) => {
  try {
    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/me/accounts`,
      params: { fields: "id,name,category,access_token" },
      accessToken: req.metaToken,
    });
    res.json({ pages: data });
  } catch (err) { next(err); }
});

// List the Instagram accounts attached to a Facebook Page. Used so the wizard
// can let the user pick which Insta account "owns" the ad (e.g. Click-to-DM ads).
router.get("/pages/:pageId/instagram", async (req, res, next) => {
  try {
    const accounts = await fbRequest({
      method: "get", url: `${FB_GRAPH_BASE}/me/accounts`,
      params: { fields: "id,access_token" }, accessToken: req.metaToken,
    });
    const page = (accounts?.data || []).find((p) => p.id === req.params.pageId);
    if (!page) return res.status(404).json({ error: "Page not found." });
    const tokenToUse = page.access_token || req.metaToken;

    // The Page returns its connected business Instagram via `instagram_business_account`.
    const connected = await fbRequest({
      method: "get", url: `${FB_GRAPH_BASE}/${page.id}`,
      params: { fields: "instagram_business_account{id,username,name,profile_picture_url}" },
      accessToken: tokenToUse,
    });
    const ig = connected?.instagram_business_account ? [connected.instagram_business_account] : [];
    res.json({ instagramAccounts: ig });
  } catch (err) { next(err); }
});

// Upload an image to the ad account's library so we get back an `image_hash`
// to reference when creating creatives — no public URL hosting required.
router.post("/ad-images/upload", upload.single("file"), async (req, res, next) => {
  try {
    const { adAccountId } = req.body || {};
    if (!adAccountId)  return res.status(400).json({ error: "adAccountId required" });
    if (!req.file)     return res.status(400).json({ error: "No file uploaded" });
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "File must be an image (JPG / PNG / WEBP)" });
    }
    const actId = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;

    const fd = new FormData();
    fd.append(req.file.originalname, req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    const response = await axios.post(
      `${FB_GRAPH_BASE}/${actId}/adimages`,
      fd,
      {
        headers: { ...fd.getHeaders(), Authorization: `Bearer ${req.metaToken}` },
        params: { access_token: req.metaToken },
        validateStatus: () => true, maxBodyLength: Infinity,
      }
    );
    if (response.status < 200 || response.status >= 300) {
      const fbErr = response.data?.error || {};
      return res.status(response.status).json({
        error: fbErr.error_user_msg || fbErr.message || "Image upload failed",
      });
    }
    // Meta returns: { images: { "<filename>": { hash, url } } }
    const first = Object.values(response.data?.images || {})[0];
    if (!first?.hash) return res.status(500).json({ error: "Meta did not return a hash" });
    res.json({ hash: first.hash, url: first.url, filename: req.file.originalname });
  } catch (err) { next(err); }
});

// List lead forms for a specific page (uses the page's own access token)
router.get("/pages/:pageId/lead-forms", async (req, res, next) => {
  try {
    const pages = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/me/accounts`,
      params: { fields: "id,access_token" },
      accessToken: req.metaToken,
    });
    const page = (pages?.data || []).find((p) => p.id === req.params.pageId);
    if (!page) return res.status(404).json({ error: "Page not found for this user" });

    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${page.id}/leadgen_forms`,
      params: { fields: "id,name,status,leads_count,created_time,locale", limit: 100 },
      accessToken: page.access_token || req.metaToken,
    });
    res.json({ forms: data?.data || [], pageId: page.id });
  } catch (err) { next(err); }
});

// List all lead forms across every page the user manages
router.get("/lead-forms/all", async (req, res, next) => {
  try {
    const pages = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/me/accounts`,
      params: { fields: "id,name,category,access_token", limit: 100 },
      accessToken: req.metaToken,
    });
    const pageList = pages?.data || [];

    const results = await Promise.all(
      pageList.map(async (p) => {
        try {
          const forms = await fbRequest({
            method: "get",
            url: `${FB_GRAPH_BASE}/${p.id}/leadgen_forms`,
            params: { fields: "id,name,status,leads_count,created_time", limit: 100 },
            accessToken: p.access_token || req.metaToken,
          });
          return { page: { id: p.id, name: p.name }, forms: forms?.data || [] };
        } catch (e) {
          return { page: { id: p.id, name: p.name }, forms: [], error: e.message };
        }
      })
    );

    res.json({ pages: results });
  } catch (err) { next(err); }
});

// Get a single lead form. Field availability varies by API version + the page's
// permissions, so we use a defensive strategy: try the rich field set first,
// retry with a safe minimal set if Meta rejects an unknown field, and finally
// fall back to a no-fields request.
const LEADFORM_FIELDS_RICH = [
  "id","name","status","locale","leads_count","created_time","expired_leads_count",
  "follow_up_action_url","legal_content","thank_you_page",
  "questions","question_page_custom_headline","context_card","cover_photo",
];
const LEADFORM_FIELDS_SAFE = [
  "id","name","status","locale","leads_count","created_time",
  "follow_up_action_url","thank_you_page","questions","question_page_custom_headline","context_card",
];
const LEADFORM_FIELDS_MIN = [
  "id","name","status","locale","leads_count","created_time","questions",
];

async function fetchLeadForm(formId, token) {
  for (const fields of [LEADFORM_FIELDS_RICH, LEADFORM_FIELDS_SAFE, LEADFORM_FIELDS_MIN]) {
    try {
      return await fbRequest({
        method: "get", url: `${FB_GRAPH_BASE}/${formId}`,
        params: { fields: fields.join(",") }, accessToken: token,
      });
    } catch (err) {
      const msg = err.fb?.message || err.message || "";
      // Meta's "nonexisting field" → drop to next set. Anything else → bubble up.
      if (!/nonexisting field|unknown field/i.test(msg)) throw err;
    }
  }
  // Last-ditch: no fields at all (returns id+name).
  return fbRequest({
    method: "get", url: `${FB_GRAPH_BASE}/${formId}`, accessToken: token,
  });
}

router.get("/lead-forms/:formId", async (req, res, next) => {
  try {
    const { formId } = req.params;
    const { pageId } = req.query;
    let tokenToUse = req.metaToken;
    if (pageId) {
      const pages = await fbRequest({
        method: "get", url: `${FB_GRAPH_BASE}/me/accounts`,
        params: { fields: "id,access_token" }, accessToken: req.metaToken,
      });
      const page = (pages?.data || []).find((p) => p.id === pageId);
      if (page?.access_token) tokenToUse = page.access_token;
    }
    const form = await fetchLeadForm(formId, tokenToUse);
    res.json({ form });
  } catch (err) { next(err); }
});

// Create a new lead form on a page. Meta requires: name, privacy_policy { url },
// questions, and follow_up_action_url. We accept the full Meta schema and pass it through.
router.post("/lead-forms", async (req, res, next) => {
  try {
    const { pageId, ...rest } = req.body || {};
    if (!pageId) return res.status(400).json({ error: "pageId required" });
    if (!rest.name) return res.status(400).json({ error: "name required" });
    if (!rest.questions || !Array.isArray(rest.questions) || !rest.questions.length) {
      return res.status(400).json({ error: "At least one question is required" });
    }
    if (!rest.privacy_policy?.url) {
      return res.status(400).json({ error: "privacy_policy.url required (link to your privacy policy)" });
    }

    // Resolve page access token.
    const pages = await fbRequest({
      method: "get", url: `${FB_GRAPH_BASE}/me/accounts`,
      params: { fields: "id,access_token" }, accessToken: req.metaToken,
    });
    const page = (pages?.data || []).find((p) => p.id === pageId);
    if (!page) return res.status(404).json({ error: "You don't manage that page." });

    // Meta wants `questions` and `privacy_policy` as JSON strings in the form-encoded body.
    const payload = {
      ...rest,
      questions:       JSON.stringify(rest.questions),
      privacy_policy:  JSON.stringify(rest.privacy_policy),
      ...(rest.thank_you_page ? { thank_you_page: JSON.stringify(rest.thank_you_page) } : {}),
      ...(rest.context_card   ? { context_card:   JSON.stringify(rest.context_card)   } : {}),
    };

    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${pageId}/leadgen_forms`,
      data: payload,
      accessToken: page.access_token || req.metaToken,
    });
    res.status(201).json({ form: data });
  } catch (err) { next(err); }
});

// Update a lead form. Meta only lets you change status / name in most cases.
router.post("/lead-forms/:formId", async (req, res, next) => {
  try {
    const { pageId, status, name } = req.body || {};
    let tokenToUse = req.metaToken;
    if (pageId) {
      const pages = await fbRequest({
        method: "get", url: `${FB_GRAPH_BASE}/me/accounts`,
        params: { fields: "id,access_token" }, accessToken: req.metaToken,
      });
      const page = (pages?.data || []).find((p) => p.id === pageId);
      if (page?.access_token) tokenToUse = page.access_token;
    }
    const patch = {};
    if (status) patch.status = status;     // ACTIVE | ARCHIVED | DELETED
    if (name)   patch.name   = name;
    if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });

    const data = await fbRequest({
      method: "post", url: `${FB_GRAPH_BASE}/${req.params.formId}`,
      data: patch, accessToken: tokenToUse,
    });
    res.json({ ok: !!data?.success, applied: patch });
  } catch (err) { next(err); }
});

// Delete (archive) a lead form. Meta typically requires archive — true deletion
// is only allowed on draft forms with zero leads.
router.delete("/lead-forms/:formId", async (req, res, next) => {
  try {
    const { pageId } = req.query;
    let tokenToUse = req.metaToken;
    if (pageId) {
      const pages = await fbRequest({
        method: "get", url: `${FB_GRAPH_BASE}/me/accounts`,
        params: { fields: "id,access_token" }, accessToken: req.metaToken,
      });
      const page = (pages?.data || []).find((p) => p.id === pageId);
      if (page?.access_token) tokenToUse = page.access_token;
    }

    // Try DELETE first (works for unused drafts), fall back to ARCHIVE.
    try {
      const data = await fbRequest({
        method: "delete", url: `${FB_GRAPH_BASE}/${req.params.formId}`,
        accessToken: tokenToUse,
      });
      return res.json({ ok: true, deleted: true, data });
    } catch (delErr) {
      // Forms with leads can only be archived.
      const archived = await fbRequest({
        method: "post", url: `${FB_GRAPH_BASE}/${req.params.formId}`,
        data: { status: "ARCHIVED" }, accessToken: tokenToUse,
      });
      return res.json({ ok: true, archived: true, data: archived });
    }
  } catch (err) { next(err); }
});

// Submit a TEST lead to a form. Meta's POST /{form_id}/test_leads creates a
// lead the same way a real submission would — BUT that lead only flows back
// into our CRM via the webhook, which Meta can't reach on localhost. So we
// also write a local Lead immediately, mirroring the webhook handler, so the
// user sees the lead in /leads/all even during local development.
router.post("/lead-forms/:formId/test-lead", async (req, res, next) => {
  try {
    const Lead = require("./models/Lead");
    const { formId } = req.params;
    const { pageId, fieldData = [], customDisclaimerResponses = [] } = req.body || {};
    if (!Array.isArray(fieldData) || !fieldData.length) {
      return res.status(400).json({ error: "fieldData required — array of { name, values: [string] }" });
    }

    let tokenToUse = req.metaToken;
    if (pageId) {
      const pages = await fbRequest({
        method: "get", url: `${FB_GRAPH_BASE}/me/accounts`,
        params: { fields: "id,access_token" }, accessToken: req.metaToken,
      });
      const page = (pages?.data || []).find((p) => p.id === pageId);
      if (page?.access_token) tokenToUse = page.access_token;
    }

    const data = await fbRequest({
      method: "post", url: `${FB_GRAPH_BASE}/${formId}/test_leads`,
      data: {
        field_data: JSON.stringify(fieldData),
        ...(customDisclaimerResponses.length
          ? { custom_disclaimer_responses: JSON.stringify(customDisclaimerResponses) }
          : {}),
      },
      accessToken: tokenToUse,
    });

    // --- Write a local Lead mirroring the webhook handler so the user sees
    // it in /leads/all immediately (no webhook round-trip needed). ---
    const get = (...keys) => {
      for (const k of keys) {
        const f = fieldData.find((x) => String(x.name).toLowerCase() === k);
        if (f && f.values?.[0]) return f.values[0];
      }
      return "";
    };
    const fullName  = get("full_name", "name");
    const firstName = get("first_name");
    const lastName  = get("last_name");
    const name      = fullName || [firstName, lastName].filter(Boolean).join(" ").trim() || "Test lead";
    const email     = get("email", "work_email");
    const phone     = get("phone_number", "phone", "work_phone_number");
    const company   = get("company_name");

    const extraNotes = fieldData
      .filter((f) => !["email","work_email","phone_number","phone","work_phone_number","full_name","first_name","last_name","company_name","name"].includes(String(f.name).toLowerCase()))
      .map((f) => `${f.name}: ${(f.values || []).join(", ")}`)
      .join("\n");

    const localLead = await Lead.create({
      owner:  req.user._id,
      name, email, phone,
      source: "Meta Lead Form (test)",
      status: "new",
      tags:   ["meta-lead", "test"],
      notes:  extraNotes,
      value:  0,
      metaLead: {
        leadgenId:    data?.id || "",
        formId,
        company,
        rawFieldData: fieldData,
        isOrganic:    false,
        createdTime:  new Date(),
      },
    }).catch((e) => { console.warn("[meta test-lead] local Lead insert failed:", e.message); return null; });
    if (localLead) await require("./services/leadAssignment").autoAssignLead(localLead);

    // Fire the user's new_lead automations — same as a real webhook would.
    if (localLead) {
      try {
        const flowRunner = require("./services/flowRunner");
        flowRunner.runTrigger("trigger.new_lead", { user: req.user, lead: localLead }).catch(() => {});
      } catch { /* flowRunner optional */ }
    }

    res.status(201).json({
      ok: true,
      testLead: data,
      localLeadId: localLead?._id || null,
    });
  } catch (err) { next(err); }
});

// Fetch leads for a specific lead form
router.get("/lead-forms/:formId/leads", async (req, res, next) => {
  try {
    const { formId } = req.params;
    const { pageId, limit = 100, after } = req.query;

    // To read leads we prefer the page access token; look it up if pageId given.
    let tokenToUse = req.metaToken;
    if (pageId) {
      const pages = await fbRequest({
        method: "get",
        url: `${FB_GRAPH_BASE}/me/accounts`,
        params: { fields: "id,access_token" },
        accessToken: req.metaToken,
      });
      const page = (pages?.data || []).find((p) => p.id === pageId);
      if (page?.access_token) tokenToUse = page.access_token;
    }

    const params = {
      fields: "id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name,form_id",
      limit,
    };
    if (after) params.after = after;

    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${formId}/leads`,
      params,
      accessToken: tokenToUse,
    });
    res.json({ leads: data });
  } catch (err) { next(err); }
});

module.exports = { router, metaErrorHandler };
