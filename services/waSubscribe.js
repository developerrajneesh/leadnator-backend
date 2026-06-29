/**
 * WABA app subscription — POST /{waba-id}/subscribed_apps so webhooks reach this app.
 */
const axios = require("axios");

const FB_API_VERSION = process.env.META_API_VERSION || "v23.0";
const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_API_VERSION}`;

async function fb({ method, url, params, data, token }) {
  const res = await axios({
    method, url, data,
    params: { ...(params || {}), access_token: token },
    validateStatus: () => true,
  });
  if (res.status >= 200 && res.status < 300) return res.data;
  const fbErr = res.data?.error || { message: res.statusText, code: res.status };
  const friendly = fbErr.error_user_msg || fbErr.message || "WhatsApp API error";
  const e = new Error(friendly);
  e.status = res.status;
  e.fb = fbErr;
  throw e;
}

function appId() {
  return String(process.env.WHATSAPP_FB_APP_ID || process.env.FB_APP_ID || "").trim();
}

function isAlreadySubscribedError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("already subscribed") || msg.includes("already subscrib");
}

function isAppSubscribed(list, targetAppId) {
  if (!targetAppId) return false;
  return (list || []).some((entry) => {
    const id = entry?.whatsapp_business_api_data?.id ?? entry?.id;
    return id != null && String(id) === String(targetAppId);
  });
}

async function subscribeWabaToApp(wabaId, accessToken, { overrideCallbackUri, verifyToken } = {}) {
  const data = {};
  // Claim THIS WABA's webhooks for our endpoint even if the account was created /
  // previously connected on another platform (BSP). Meta routes this WABA's events
  // to our override URL regardless of the app-level webhook config.
  if (overrideCallbackUri && verifyToken) {
    data.override_callback_uri = overrideCallbackUri;
    data.verify_token = verifyToken;
  }
  return fb({
    method: "post",
    url: `${FB_GRAPH_BASE}/${wabaId}/subscribed_apps`,
    data,
    token: accessToken,
  });
}

/**
 * Subscribe this Meta app to a WABA. Best-effort; safe to call repeatedly.
 * Pass overrideCallbackUri + verifyToken to take over the WABA's webhook routing.
 */
async function ensureWabaSubscribed(conn, { force = false, overrideCallbackUri, verifyToken } = {}) {
  const wabaId = String(conn?.businessAccountId || "").trim();
  const accessToken = conn?.accessToken;
  if (!wabaId || !accessToken) {
    return { attempted: false, subscribed: false, reason: "missing waba or token" };
  }

  const targetAppId = appId();

  if (!force) {
    try {
      const subs = await fb({
        method: "get",
        url: `${FB_GRAPH_BASE}/${wabaId}/subscribed_apps`,
        token: accessToken,
      });
      if (isAppSubscribed(subs?.data, targetAppId)) {
        return { attempted: false, subscribed: true, alreadySubscribed: true, wabaId };
      }
    } catch {
      /* Subscription check failed — fall through and try to subscribe anyway. */
    }
  }

  try {
    const result = await subscribeWabaToApp(wabaId, accessToken, { overrideCallbackUri, verifyToken });
    return { attempted: true, subscribed: true, overrode: !!(overrideCallbackUri && verifyToken), wabaId, result };
  } catch (err) {
    if (isAlreadySubscribedError(err)) {
      return { attempted: true, subscribed: true, alreadySubscribed: true, wabaId };
    }
    return { attempted: true, subscribed: false, wabaId, error: err.message, fb: err.fb };
  }
}

/**
 * Subscribe every stored WhatsApp connection (existing users).
 */
async function subscribeAllWabaConnections({ delayMs = 250 } = {}) {
  const WhatsAppConnection = require("../models/WhatsAppConnection");
  const connections = await WhatsAppConnection.find({
    businessAccountId: { $exists: true, $nin: [null, ""] },
  }).select("+accessToken businessAccountId phoneNumberId user");

  const summary = {
    total: connections.length,
    subscribed: 0,
    alreadySubscribed: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };

  for (const conn of connections) {
    if (!conn.accessToken) {
      summary.skipped += 1;
      summary.results.push({
        wabaId: conn.businessAccountId,
        phoneNumberId: conn.phoneNumberId,
        skipped: true,
        reason: "no access token",
      });
      continue;
    }

    const r = await ensureWabaSubscribed(conn, { force: true });
    summary.results.push({
      wabaId: conn.businessAccountId,
      phoneNumberId: conn.phoneNumberId,
      userId: conn.user?.toString?.(),
      ...r,
    });

    if (r.subscribed) {
      if (r.alreadySubscribed) summary.alreadySubscribed += 1;
      else summary.subscribed += 1;
    } else if (r.attempted) summary.failed += 1;
    else summary.skipped += 1;

    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return summary;
}

module.exports = {
  ensureWabaSubscribed,
  subscribeAllWabaConnections,
};
