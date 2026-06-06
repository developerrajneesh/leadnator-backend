// Instagram Business module — DMs, comments, automations via Meta Graph API.

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const User = require("./models/User");
const Organization = require("./models/Organization");
const InstagramConnection = require("./models/InstagramConnection");
const { tenantId, orgFilter } = require("./middleware/tenant");
const InstagramFlow = require("./models/InstagramFlow");
const InstagramMessage = require("./models/InstagramMessage");
const InstagramComment = require("./models/InstagramComment");

const FB_API_VERSION = process.env.META_API_VERSION || "v23.0";
const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_API_VERSION}`;
const IG_GRAPH_BASE = `https://graph.instagram.com/${FB_API_VERSION}`;

const router = express.Router();

async function fb({ method, url, params, data, token }) {
  const res = await axios({
    method, url, data,
    params: { ...(params || {}), access_token: token },
    validateStatus: () => true,
  });
  if (res.status >= 200 && res.status < 300) return res.data;
  const fbErr = res.data?.error || { message: res.statusText };
  const e = new Error(fbErr.error_user_msg || fbErr.message || "Instagram API error");
  e.status = res.status;
  e.fb = fbErr;
  throw e;
}

async function userMetaToken(req) {
  if (!req?.user?._id) return "";
  if (req.tenantId) {
    const org = await Organization.findById(req.tenantId).select("+meta.accessToken");
    if (org?.meta?.accessToken) return org.meta.accessToken;
  }
  const u = await User.findById(req.user._id).select("+meta.accessToken");
  return u?.meta?.accessToken || "";
}

async function loadConnection(req) {
  const tid = tenantId(req);
  let conn = await InstagramConnection.findOne({ organization: tid })
    .select("+pageAccessToken +webhookVerifyToken");
  if (!conn) {
    conn = await InstagramConnection.findOne({
      user: req.user._id,
      $or: [{ organization: null }, { organization: { $exists: false } }],
    }).select("+pageAccessToken +webhookVerifyToken");
  }
  return conn;
}

async function requireIg(req, res, next) {
  const conn = await loadConnection(req);
  if (!conn) return res.status(401).json({ error: "Instagram account not connected" });
  req.ig = conn;
  next();
}

// ---------- Status & connect ----------
router.get("/status", async (req, res, next) => {
  try {
    const conn = await loadConnection(req);
    if (!conn) {
      const hasMeta = !!(await userMetaToken(req));
      return res.json({ connected: false, metaConnected: hasMeta });
    }
    res.json({ connected: true, metaConnected: true, connection: conn.toJSON() });
  } catch (err) { next(err); }
});

// Pages with linked Instagram Business accounts (requires Meta login first).
router.get("/pages", async (req, res, next) => {
  try {
    const token = await userMetaToken(req);
    if (!token) return res.status(401).json({ error: "Connect Facebook first — Instagram uses your Meta login." });

    const pages = await fb({
      method: "get",
      url: `${FB_GRAPH_BASE}/me/accounts`,
      params: { fields: "id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}" },
      token,
    });

    const list = (pages?.data || [])
      .filter((p) => p.instagram_business_account?.id)
      .map((p) => ({
        pageId: p.id,
        pageName: p.name,
        ig: {
          id: p.instagram_business_account.id,
          username: p.instagram_business_account.username,
          name: p.instagram_business_account.name,
          profilePictureUrl: p.instagram_business_account.profile_picture_url,
        },
      }));

    res.json({ pages: list });
  } catch (err) { next(err); }
});

router.post("/connect", async (req, res, next) => {
  try {
    const { pageId, igAccountId } = req.body || {};
    if (!pageId || !igAccountId) return res.status(400).json({ error: "pageId and igAccountId required" });

    const token = await userMetaToken(req);
    if (!token) return res.status(401).json({ error: "Connect Facebook first." });

    const pages = await fb({
      method: "get",
      url: `${FB_GRAPH_BASE}/me/accounts`,
      params: { fields: "id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}" },
      token,
    });

    const page = (pages?.data || []).find((p) => p.id === pageId);
    if (!page?.instagram_business_account) {
      return res.status(404).json({ error: "Page not found or has no Instagram Business account linked." });
    }
    if (page.instagram_business_account.id !== igAccountId) {
      return res.status(400).json({ error: "Instagram account does not match this page." });
    }

    const verifyToken = crypto.randomBytes(16).toString("hex");
    const conn = await InstagramConnection.findOneAndUpdate(
      orgFilter(req),
      {
        user: req.user._id,
        organization: tenantId(req),
        igAccountId: page.instagram_business_account.id,
        username: page.instagram_business_account.username || "",
        name: page.instagram_business_account.name || "",
        profilePictureUrl: page.instagram_business_account.profile_picture_url || "",
        pageId: page.id,
        pageName: page.name || "",
        pageAccessToken: page.access_token || token,
        connectedAt: new Date(),
        webhookVerifyToken: verifyToken,
        authMethod: "facebook_page",
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ connected: true, connection: conn.toJSON() });
  } catch (err) { next(err); }
});

router.post("/disconnect", async (req, res, next) => {
  try {
    await InstagramConnection.deleteOne(orgFilter(req));
    res.json({ disconnected: true });
  } catch (err) { next(err); }
});

// Instagram Business Login — exchange OAuth `code` → short-lived → long-lived (60d) → MongoDB
router.post("/oauth/callback", async (req, res, next) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: "Authorization code required" });

    const clientId = process.env.INSTAGRAM_CLIENT_ID || "1973429443277994";
    const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET || "4a0489054e165da08aa8503e977c7bd1";
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI || "https://leadnator.vercel.app/";

    if (!clientSecret) {
      return res.status(500).json({
        error: "Server missing INSTAGRAM_CLIENT_SECRET — add it to backend/.env to complete OAuth.",
      });
    }

    // Step 1: authorization code → short-lived user access token
    const tokenRes = await axios.post(
      "https://api.instagram.com/oauth/access_token",
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code: String(code).trim(),
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, validateStatus: () => true }
    );

    if (tokenRes.status !== 200) {
      const msg = tokenRes.data?.error_message || tokenRes.data?.error?.message || "Token exchange failed";
      console.error("[instagram/oauth] short-lived exchange failed:", tokenRes.data);
      return res.status(400).json({ error: msg, details: tokenRes.data });
    }

    const shortToken = tokenRes.data.access_token;
    const igUserId = tokenRes.data.user_id;

    if (!shortToken || !igUserId) {
      return res.status(400).json({ error: "Invalid token response from Instagram", details: tokenRes.data });
    }

    // Step 2: short-lived → long-lived token (~60 days)
    let accessToken = shortToken;
    let isLongLived = false;
    let tokenExpiresAt = null;

    const longRes = await axios.get("https://graph.instagram.com/access_token", {
      params: {
        grant_type: "ig_exchange_token",
        client_secret: clientSecret,
        access_token: shortToken,
      },
      validateStatus: () => true,
    });

    if (longRes.status === 200 && longRes.data?.access_token) {
      accessToken = longRes.data.access_token;
      isLongLived = true;
      if (longRes.data.expires_in) {
        tokenExpiresAt = new Date(Date.now() + Number(longRes.data.expires_in) * 1000);
      }
      console.log(`[instagram/oauth] long-lived token for user ${igUserId}, expires ${tokenExpiresAt}`);
    } else {
      console.warn("[instagram/oauth] long-lived exchange failed, storing short-lived:", longRes.data);
      // Short-lived tokens last ~1 hour
      tokenExpiresAt = new Date(Date.now() + 3600 * 1000);
    }

    // Step 3: profile (username, avatar)
    let username = "";
    let name = "";
    let profilePictureUrl = "";

    const profile = await axios.get("https://graph.instagram.com/me", {
      params: { fields: "id,username,name,profile_picture_url", access_token: accessToken },
      validateStatus: () => true,
    });

    if (profile.status === 200) {
      username = profile.data.username || "";
      name = profile.data.name || username;
      profilePictureUrl = profile.data.profile_picture_url || "";
    } else {
      console.warn("[instagram/oauth] profile fetch:", profile.data);
    }

    const verifyToken = crypto.randomBytes(16).toString("hex");
    const conn = await InstagramConnection.findOneAndUpdate(
      orgFilter(req),
      {
        user: req.user._id,
        organization: tenantId(req),
        igAccountId: String(profile.status === 200 ? (profile.data?.id || igUserId) : igUserId),
        username,
        name,
        profilePictureUrl,
        pageId: "",
        pageName: "Instagram Business Login",
        pageAccessToken: accessToken,
        tokenExpiresAt,
        isLongLived,
        authMethod: "oauth",
        connectedAt: new Date(),
        webhookVerifyToken: verifyToken,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      connected: true,
      connection: conn.toJSON(),
      tokenExpiresAt,
      isLongLived,
    });
  } catch (err) {
    console.error("[instagram/oauth]", err.message);
    next(err);
  }
});

// ---------- Settings ----------
router.get("/settings", requireIg, async (req, res, next) => {
  try {
    res.json({ settings: req.ig.settings || {}, connection: req.ig.toJSON() });
  } catch (err) { next(err); }
});

router.put("/settings", requireIg, async (req, res, next) => {
  try {
    const { settings } = req.body || {};
    const allowed = ["dmAutoReply", "dmAutoReplyText", "commentAutoReply", "commentReplyText", "storyMentionNotify"];
    const patch = {};
    for (const k of allowed) {
      if (settings?.[k] !== undefined) patch[`settings.${k}`] = settings[k];
    }
    const conn = await InstagramConnection.findOneAndUpdate(
      orgFilter(req),
      { $set: patch },
      { new: true }
    );
    res.json({ settings: conn.settings, connection: conn.toJSON() });
  } catch (err) { next(err); }
});

// ---------- Inbox (DMs) ----------
const IG_CONVO_FIELDS = "id,updated_time,participants{id,username,name},messages.limit(1){id,message,from{id,username},created_time}";
const IG_MESSAGE_FIELDS = "messages{id,created_time,from{id,username},message}";

async function inboxAccessTokens(ig, req) {
  const out = [];
  const pageToken = await resolveFacebookPageTokenForIg(ig, req);
  if (pageToken) out.push(pageToken);
  if (ig.pageAccessToken && !out.includes(ig.pageAccessToken)) out.push(ig.pageAccessToken);
  return out;
}

function mapMetaConversation(c, igAccountId) {
  const participants = c.participants?.data || [];
  const other = participants.find((p) => p.id && p.id !== igAccountId) || participants[0] || {};
  const last = c.messages?.data?.[0];
  const fromId = last?.from?.id || "";
  return {
    id: c.id,
    igUserId: other.id || "",
    igUsername: other.username || other.name || "",
    lastText: last?.message || "",
    lastAt: last?.created_time || c.updated_time || null,
    unread: 0,
    fromApi: true,
  };
}

function mapMetaMessage(m, igAccountId, conversationId, peer = {}) {
  const fromId = m.from?.id || "";
  const isOut = fromId === igAccountId;
  return {
    metaMessageId: m.id || "",
    conversationId,
    igUserId: isOut ? (peer.igUserId || "") : fromId,
    igUsername: isOut ? (peer.igUsername || "") : (m.from?.username || peer.igUsername || ""),
    direction: isOut ? "out" : "in",
    text: m.message || "",
    createdAt: m.created_time ? new Date(m.created_time) : new Date(),
    read: isOut,
  };
}

async function fetchMetaConversations(ig, req) {
  const tokens = await inboxAccessTokens(ig, req);
  const igId = ig.igAccountId;
  if (!igId) return { list: [], error: null };

  let lastError = null;
  for (const token of tokens) {
    try {
      const data = await fb({
        method: "get",
        url: `${FB_GRAPH_BASE}/${igId}/conversations`,
        params: { platform: "instagram", fields: IG_CONVO_FIELDS, limit: "50" },
        token,
      });
      return { list: (data?.data || []).map((c) => mapMetaConversation(c, igId)), error: null };
    } catch (e) {
      lastError = e.message;
    }
  }
  return { list: [], error: lastError };
}

async function syncMetaMessagesToDb(ig, req, conversationId, peer = {}) {
  const userId = req.user._id;
  const tokens = await inboxAccessTokens(ig, req);
  let lastError = null;

  for (const token of tokens) {
    try {
      const data = await fb({
        method: "get",
        url: `${FB_GRAPH_BASE}/${conversationId}`,
        params: { fields: IG_MESSAGE_FIELDS, limit: "100" },
        token,
      });
      const raw = (data?.messages?.data || []).slice().reverse();
      for (const m of raw) {
        const doc = mapMetaMessage(m, ig.igAccountId, conversationId, peer);
        if (!doc.metaMessageId) continue;
        await InstagramMessage.findOneAndUpdate(
          { user: userId, metaMessageId: doc.metaMessageId },
          { $set: { ...doc, user: userId } },
          { upsert: true }
        );
      }
      return { synced: raw.length, error: null };
    } catch (e) {
      lastError = e.message;
    }
  }
  return { synced: 0, error: lastError };
}

async function listConversationsFromDb(userId) {
  const rows = await InstagramMessage.aggregate([
    { $match: { user: userId } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$conversationId",
        lastText: { $first: "$text" },
        lastAt: { $first: "$createdAt" },
        igUsername: { $first: "$igUsername" },
        igUserId: { $first: "$igUserId" },
        unread: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "in"] }, { $eq: ["$read", false] }] }, 1, 0] } },
      },
    },
    { $sort: { lastAt: -1 } },
    { $limit: 80 },
  ]);

  return rows
    .filter((m) => m._id != null && m._id !== "")
    .map((m) => ({
      id: String(m._id),
      igUsername: m.igUsername || "",
      igUserId: m.igUserId || "",
      lastText: m.lastText || "",
      lastAt: m.lastAt,
      unread: m.unread || 0,
    }));
}

function mergeConversations(local, remote) {
  const byId = new Map();
  for (const c of remote) byId.set(c.id, { ...c });
  for (const c of local) {
    const existing = byId.get(c.id);
    if (!existing) {
      byId.set(c.id, c);
      continue;
    }
    const remoteTime = existing.lastAt ? new Date(existing.lastAt).getTime() : 0;
    const localTime = c.lastAt ? new Date(c.lastAt).getTime() : 0;
    byId.set(c.id, {
      ...existing,
      igUsername: existing.igUsername || c.igUsername,
      igUserId: existing.igUserId || c.igUserId,
      lastText: localTime >= remoteTime ? (c.lastText || existing.lastText) : existing.lastText,
      lastAt: localTime >= remoteTime ? c.lastAt : existing.lastAt,
      unread: Math.max(existing.unread || 0, c.unread || 0),
    });
  }
  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0)
  );
}

router.get("/conversations", requireIg, async (req, res, next) => {
  try {
    const { list: remote, error: syncError } = await fetchMetaConversations(req.ig, req);
    const local = await listConversationsFromDb(req.user._id);
    const conversations = mergeConversations(local, remote);

    res.json({
      conversations,
      username: req.ig.username,
      syncError: syncError && conversations.length === 0 ? syncError : null,
    });
  } catch (err) { next(err); }
});

router.get("/conversations/:id/messages", requireIg, async (req, res, next) => {
  try {
    const conversationId = req.params.id;
    const peer = {
      igUserId: String(req.query.igUserId || ""),
      igUsername: String(req.query.igUsername || ""),
    };

    const sync = await syncMetaMessagesToDb(req.ig, req, conversationId, peer);

    await InstagramMessage.updateMany(
      { user: req.user._id, conversationId, direction: "in", read: false },
      { $set: { read: true } }
    );

    const messages = await InstagramMessage.find({
      user: req.user._id,
      conversationId,
    }).sort({ createdAt: 1 }).limit(200);

    res.json({
      messages: messages.map((m) => ({
        id: m._id.toString(),
        direction: m.direction,
        text: m.text,
        createdAt: m.createdAt,
        read: m.read,
      })),
      syncError: messages.length === 0 ? sync.error : null,
    });
  } catch (err) { next(err); }
});

router.post("/conversations/:id/messages", requireIg, async (req, res, next) => {
  try {
    const { text, igUserId, igUsername } = req.body || {};
    if (!text?.trim()) return res.status(400).json({ error: "text required" });

    const conversationId = req.params.id;
    const recipientId = igUserId || conversationId;
    const tokens = await inboxAccessTokens(req.ig, req);
    let metaMessageId = "";
    let sendError = null;

    for (const token of tokens) {
      try {
        const sent = await fb({
          method: "post",
          url: `${FB_GRAPH_BASE}/${req.ig.igAccountId}/messages`,
          data: {
            recipient: { id: recipientId },
            message: { text: text.trim() },
          },
          token,
        });
        metaMessageId = sent?.message_id || sent?.id || "";
        sendError = null;
        break;
      } catch (e) {
        sendError = e.message;
      }
    }

    const existing = metaMessageId
      ? await InstagramMessage.findOne({ user: req.user._id, metaMessageId })
      : null;

    const msg = existing || await InstagramMessage.create({
      user: req.user._id,
      conversationId,
      igUserId: igUserId || "",
      igUsername: igUsername || "",
      direction: "out",
      text: text.trim(),
      metaMessageId,
      read: true,
    });

    if (!existing && sendError) {
      console.warn("[instagram] send DM:", sendError);
    }

    res.status(201).json({
      message: {
        id: msg._id.toString(),
        direction: "out",
        text: msg.text,
        createdAt: msg.createdAt,
      },
      sendError: metaMessageId ? null : sendError,
    });
  } catch (err) { next(err); }
});

// Demo seed for empty inbox (manual only — not auto-called)
router.post("/inbox/seed-demo", requireIg, async (req, res, next) => {
  try {
    const existing = await InstagramMessage.countDocuments({ user: req.user._id });
    if (existing > 0) return res.json({ seeded: false, message: "Inbox already has messages" });

    const demos = [
      { conversationId: "demo_1", igUsername: "priya_sharma", igUserId: "u1", direction: "in", text: "Hi! Is this product still available?" },
      { conversationId: "demo_1", igUsername: "priya_sharma", igUserId: "u1", direction: "out", text: "Yes! DM us your size and we'll confirm stock." },
      { conversationId: "demo_2", igUsername: "rahul_designs", igUserId: "u2", direction: "in", text: "Love your latest reel 🔥" },
      { conversationId: "demo_3", igUsername: "mumbai_foodie", igUserId: "u3", direction: "in", text: "What's the price for the Growth plan?" },
    ];
    await InstagramMessage.insertMany(demos.map((d) => ({ ...d, user: req.user._id })));
    res.json({ seeded: true });
  } catch (err) { next(err); }
});

// ---------- Content (posts / reels) ----------
const MEDIA_FIELDS = [
  "id",
  "caption",
  "media_type",
  "media_url",
  "thumbnail_url",
  "permalink",
  "timestamp",
  "like_count",
  "comments_count",
  "children{media_type,media_url,thumbnail_url}",
].join(",");

const MEDIA_DETAIL_FIELDS = [
  "id",
  "caption",
  "media_type",
  "media_url",
  "thumbnail_url",
  "permalink",
  "timestamp",
  "like_count",
  "comments_count",
  "children{id,media_type,media_url,thumbnail_url,permalink,timestamp}",
].join(",");

const COMMENT_FIELD_SETS = [
  "id,text,timestamp,username,like_count",
  "id,text,timestamp,like_count,from{id,username}",
  "id,text,timestamp,like_count,from",
];

function useIgGraphHost(ig) {
  return ig.authMethod === "oauth" || !ig.pageId;
}

function igMediaObjectUrl(ig, mediaId) {
  return useIgGraphHost(ig)
    ? `${IG_GRAPH_BASE}/${mediaId}`
    : `${FB_GRAPH_BASE}/${mediaId}`;
}

/** Page token for the FB Page linked to this IG account (works for /comments on graph.facebook.com). */
async function resolveFacebookPageTokenForIg(ig, req) {
  if (ig.authMethod === "facebook_page" && ig.pageAccessToken) return ig.pageAccessToken;

  const metaToken = await userMetaToken(req);
  if (!metaToken || !ig.igAccountId) return null;

  try {
    const pages = await fb({
      method: "get",
      url: `${FB_GRAPH_BASE}/me/accounts`,
      params: { fields: "id,access_token,instagram_business_account{id}" },
      token: metaToken,
    });
    const page = (pages?.data || []).find(
      (p) => p.instagram_business_account?.id === ig.igAccountId
    );
    return page?.access_token || null;
  } catch {
    return null;
  }
}

function pickDisplayUrls(m) {
  const isVideo = m.media_type === "VIDEO" || m.media_type === "REELS";
  const children = m.children?.data;

  if (m.media_type === "CAROUSEL_ALBUM" && Array.isArray(children) && children.length > 0) {
    const first = children[0];
    const childVideo = first.media_type === "VIDEO" || first.media_type === "REELS";
    const mediaUrl = childVideo
      ? (first.thumbnail_url || first.media_url || "")
      : (first.media_url || first.thumbnail_url || "");
    return {
      mediaUrl,
      thumbnailUrl: first.thumbnail_url || first.media_url || mediaUrl,
      isVideo: childVideo,
    };
  }

  if (isVideo) {
    const thumb = m.thumbnail_url || m.media_url || "";
    return { mediaUrl: thumb, thumbnailUrl: thumb, isVideo: true };
  }

  const mediaUrl = m.media_url || m.thumbnail_url || "";
  return {
    mediaUrl,
    thumbnailUrl: m.thumbnail_url || m.media_url || mediaUrl,
    isVideo: false,
  };
}

async function fetchIgMedia(ig, token, { limit = 25, after = "" } = {}) {
  const params = { fields: MEDIA_FIELDS, limit: String(Math.min(Math.max(limit, 1), 50)) };
  if (after) params.after = after;

  const accessToken = ig.pageAccessToken || token;

  if (useIgGraphHost(ig)) {
    return fb({
      method: "get",
      url: `${IG_GRAPH_BASE}/me/media`,
      params,
      token: accessToken,
    });
  }

  return fb({
    method: "get",
    url: `${FB_GRAPH_BASE}/${ig.igAccountId}/media`,
    params,
    token: accessToken,
  });
}

function mapMediaItem(m) {
  const { mediaUrl, thumbnailUrl, isVideo } = pickDisplayUrls(m);
  const children = (m.children?.data || []).map((child) => {
    const urls = pickDisplayUrls(child);
    return {
      id: child.id,
      mediaType: child.media_type || "IMAGE",
      ...urls,
      permalink: child.permalink || "",
    };
  });
  return {
    id: m.id,
    caption: m.caption || "",
    mediaType: m.media_type || "IMAGE",
    mediaUrl,
    thumbnailUrl,
    permalink: m.permalink || "",
    timestamp: m.timestamp || null,
    likes: m.like_count ?? null,
    comments: m.comments_count ?? null,
    isVideo,
    hasImage: Boolean(mediaUrl || thumbnailUrl),
    children,
  };
}

function parseInsightsPayload(data) {
  const metrics = {};
  for (const item of data?.data || []) {
    let value = null;
    if (Array.isArray(item.values) && item.values.length > 0) {
      value = item.values[item.values.length - 1]?.value;
    } else if (item.total_value?.value != null) {
      value = item.total_value.value;
    }
    metrics[item.name] = value;
  }
  return metrics;
}

function insightMetricsForType(mediaType) {
  const isReel = mediaType === "REELS" || mediaType === "VIDEO";
  if (isReel) {
    return ["reach", "likes", "comments", "shares", "saved", "plays", "total_interactions"];
  }
  return ["reach", "likes", "comments", "shares", "saved", "total_interactions"];
}

function mapIgComment(c) {
  const from = c.from;
  const fromUsername = typeof from === "object" && from
    ? (from.username || from.name || "")
    : "";
  return {
    id: c.id,
    text: c.text || "",
    username: c.username || fromUsername || "",
    timestamp: c.timestamp || null,
    likes: c.like_count ?? null,
  };
}

async function fetchMediaComments(ig, req, mediaId, accessToken, embedded = null) {
  const embeddedItems = embedded?.data || [];
  if (embeddedItems.length > 0) {
    return {
      items: embeddedItems.map(mapIgComment),
      paging: embedded?.paging || null,
      error: null,
      source: "embedded",
    };
  }

  const attempts = [];

  // Instagram Login token → graph.instagram.com only (IG media IDs are not valid on graph.facebook.com).
  if (ig.pageAccessToken) {
    for (const fields of COMMENT_FIELD_SETS) {
      attempts.push({
        url: `${IG_GRAPH_BASE}/${mediaId}/comments`,
        token: ig.pageAccessToken,
        fields,
        label: "instagram",
      });
    }
  }

  // Facebook Page linked to same IG account → graph.facebook.com (full comment text).
  const pageToken = await resolveFacebookPageTokenForIg(ig, req);
  if (pageToken) {
    for (const fields of COMMENT_FIELD_SETS) {
      attempts.push({
        url: `${FB_GRAPH_BASE}/${mediaId}/comments`,
        token: pageToken,
        fields,
        label: "facebook_page",
      });
    }
  }

  // Page-connected auth (no Instagram Login).
  if (!useIgGraphHost(ig) && accessToken && accessToken !== ig.pageAccessToken) {
    for (const fields of COMMENT_FIELD_SETS) {
      attempts.push({
        url: `${FB_GRAPH_BASE}/${mediaId}/comments`,
        token: accessToken,
        fields,
        label: "facebook",
      });
    }
  }

  const errors = [];
  for (const { url, token, fields } of attempts) {
    try {
      const commentsRes = await fb({
        method: "get",
        url,
        params: { fields, limit: "50" },
        token,
      });
      const items = (commentsRes?.data || []).map(mapIgComment);
      if (items.length > 0) {
        return { items, paging: commentsRes?.paging || null, error: null, source: "edge" };
      }
    } catch (e) {
      errors.push(e.message);
    }
  }

  const permissionHint = /does not exist|missing permissions|Unsupported get request/i.test(errors.join(" "))
    ? "Reconnect Instagram with instagram_business_manage_comments, or connect the same account via Facebook (Meta) in Settings."
    : null;

  return {
    items: [],
    paging: null,
    error: permissionHint || (errors.length ? errors[errors.length - 1] : null),
    source: null,
  };
}

// Single post — caption, carousel, comments, insights (reach, engagement, etc.)
router.get("/media/:mediaId", requireIg, async (req, res, next) => {
  try {
    const { mediaId } = req.params;
    const token = await userMetaToken(req);
    const accessToken = req.ig.pageAccessToken || token;
    const baseUrl = igMediaObjectUrl(req.ig, mediaId);

    let media = null;
    let embeddedComments = null;
    const detailFieldSets = [
      `${MEDIA_DETAIL_FIELDS},comments.limit(50){id,text,timestamp,username,like_count,from{id,username}}`,
      MEDIA_DETAIL_FIELDS,
    ];

    for (const fields of detailFieldSets) {
      try {
        media = await fb({
          method: "get",
          url: baseUrl,
          params: { fields },
          token: accessToken,
        });
        embeddedComments = media?.comments;
        if (embeddedComments?.data?.length) break;
      } catch (e) {
        if (!media) throw e;
      }
    }

    const post = mapMediaItem(media);
    const comments = await fetchMediaComments(req.ig, req, mediaId, accessToken, embeddedComments);
    comments.totalCount = post.comments ?? comments.items.length;

    let insights = { available: false, metrics: {}, error: null };
    try {
      const metrics = insightMetricsForType(post.mediaType);
      const insightsRes = await fb({
        method: "get",
        url: `${baseUrl}/insights`,
        params: { metric: metrics.join(",") },
        token: accessToken,
      });
      insights.available = true;
      insights.metrics = parseInsightsPayload(insightsRes);
    } catch (e) {
      insights.error = e.message;
    }

    res.json({
      post,
      username: req.ig.username,
      comments,
      insights,
    });
  } catch (err) {
    next(err);
  }
});

// Proxy image bytes — Instagram CDN blocks hotlinking from localhost; also refreshes expired URLs.
router.get("/media/:mediaId/picture", requireIg, async (req, res, next) => {
  try {
    const token = await userMetaToken(req);
    const accessToken = req.ig.pageAccessToken || token;

    const meta = await fb({
      method: "get",
      url: igMediaObjectUrl(req.ig, req.params.mediaId),
      params: { fields: MEDIA_DETAIL_FIELDS },
      token: accessToken,
    });

    const { thumbnailUrl, mediaUrl } = pickDisplayUrls(meta);
    const imageUrl = thumbnailUrl || mediaUrl;
    if (!imageUrl) return res.status(404).json({ error: "No image available for this post" });

    const imgRes = await axios.get(imageUrl, {
      responseType: "stream",
      validateStatus: () => true,
      timeout: 20000,
      headers: { "User-Agent": "Leadnator/1.0", Accept: "image/*,*/*" },
    });

    if (imgRes.status < 200 || imgRes.status >= 300) {
      return res.status(502).json({ error: "Could not load image from Instagram" });
    }

    res.setHeader("Cache-Control", "private, max-age=1800");
    const ct = imgRes.headers["content-type"];
    if (ct) res.setHeader("Content-Type", ct);
    imgRes.data.pipe(res);
  } catch (err) {
    next(err);
  }
});

router.get("/media", requireIg, async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 25;
    const after = String(req.query.after || "").trim();
    const token = await userMetaToken(req);

    const data = await fetchIgMedia(req.ig, token, { limit, after });
    const posts = (data?.data || []).map(mapMediaItem);

    res.json({
      posts,
      username: req.ig.username,
      paging: {
        after: data?.paging?.cursors?.after || null,
        next: data?.paging?.next || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Comments ----------
router.get("/comments", requireIg, async (req, res, next) => {
  try {
    let comments = await InstagramComment.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50);

    if (comments.length === 0) {
      const demos = [
        { commentId: "c1", igUsername: "style_hub", text: "Price please?", mediaId: "media_1", replied: false },
        { commentId: "c2", igUsername: "tech_india", text: "This looks amazing!", mediaId: "media_1", replied: true, replyText: "Thank you! 🙏" },
        { commentId: "c3", igUsername: "delhi_deals", text: "Link in bio?", mediaId: "media_2", replied: false },
      ];
      await InstagramComment.insertMany(demos.map((d) => ({ ...d, user: req.user._id })));
      comments = await InstagramComment.find({ user: req.user._id }).sort({ createdAt: -1 });
    }

    res.json({
      comments: comments.map((c) => ({
        id: c._id.toString(),
        commentId: c.commentId,
        igUsername: c.igUsername,
        text: c.text,
        mediaId: c.mediaId,
        replied: c.replied,
        replyText: c.replyText,
        createdAt: c.createdAt,
      })),
    });
  } catch (err) { next(err); }
});

router.post("/comments/:id/reply", requireIg, async (req, res, next) => {
  try {
    const { text } = req.body || {};
    if (!text?.trim()) return res.status(400).json({ error: "text required" });

    const comment = await InstagramComment.findOne({ _id: req.params.id, user: req.user._id });
    if (!comment) return res.status(404).json({ error: "Comment not found" });

    try {
      const token = req.ig.pageAccessToken;
      await fb({
        method: "post",
        url: `${FB_GRAPH_BASE}/${comment.commentId}/replies`,
        data: { message: text.trim() },
        token,
      });
    } catch (e) {
      console.warn("[instagram] comment reply:", e.message);
    }

    comment.replied = true;
    comment.replyText = text.trim();
    await comment.save();

    res.json({ comment: { id: comment._id.toString(), replied: true, replyText: comment.replyText } });
  } catch (err) { next(err); }
});

// ---------- Automation flows ----------
router.get("/flows", requireIg, async (req, res, next) => {
  try {
    const flows = await InstagramFlow.find({ user: req.user._id }).sort({ updatedAt: -1 });
    res.json({ flows: flows.map((f) => f.toJSON()) });
  } catch (err) { next(err); }
});

router.get("/flows/:id", requireIg, async (req, res, next) => {
  try {
    const flow = await InstagramFlow.findOne({ _id: req.params.id, user: req.user._id });
    if (!flow) return res.status(404).json({ error: "Flow not found" });
    res.json({ flow: flow.toJSON() });
  } catch (err) { next(err); }
});

router.post("/flows", requireIg, async (req, res, next) => {
  try {
    const { name, nodes = [], edges = [], status = "draft", trigger = "dm.received" } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const flow = await InstagramFlow.create({
      user: req.user._id, name, nodes, edges, status, trigger,
    });
    res.status(201).json({ flow: flow.toJSON() });
  } catch (err) { next(err); }
});

router.put("/flows/:id", requireIg, async (req, res, next) => {
  try {
    const { _id, id, user, ...patch } = req.body || {};
    const flow = await InstagramFlow.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      patch,
      { new: true, runValidators: true }
    );
    if (!flow) return res.status(404).json({ error: "Flow not found" });
    res.json({ flow: flow.toJSON() });
  } catch (err) { next(err); }
});

router.delete("/flows/:id", requireIg, async (req, res, next) => {
  try {
    const r = await InstagramFlow.deleteOne({ _id: req.params.id, user: req.user._id });
    if (!r.deletedCount) return res.status(404).json({ error: "Flow not found" });
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

// ---------- Analytics ----------
router.get("/analytics", requireIg, async (req, res, next) => {
  try {
    const [msgIn, msgOut, flows, comments, unread] = await Promise.all([
      InstagramMessage.countDocuments({ user: req.user._id, direction: "in" }),
      InstagramMessage.countDocuments({ user: req.user._id, direction: "out" }),
      InstagramFlow.countDocuments({ user: req.user._id, status: "active" }),
      InstagramComment.countDocuments({ user: req.user._id }),
      InstagramMessage.countDocuments({ user: req.user._id, direction: "in", read: false }),
    ]);

    res.json({
      dmsReceived: msgIn,
      dmsSent: msgOut,
      activeFlows: flows,
      commentsTotal: comments,
      unreadDms: unread,
      username: req.ig.username,
    });
  } catch (err) { next(err); }
});

// ---------- Webhook config ----------
router.get("/webhook", requireIg, async (req, res, next) => {
  try {
    const base = (process.env.API_PUBLIC_URL || process.env.WEBHOOK_BASE_URL || "http://localhost:8080").replace(/\/$/, "");
    res.json({
      url: `${base}/webhooks/instagram`,
      verifyToken: req.ig.webhookVerifyToken,
      fields: ["messages", "comments", "mentions", "story_insights"],
    });
  } catch (err) { next(err); }
});

module.exports = router;
