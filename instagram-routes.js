// Instagram Business module — DMs, comments, automations via Meta Graph API.

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const User = require("./models/User");
const InstagramConnection = require("./models/InstagramConnection");
const InstagramFlow = require("./models/InstagramFlow");
const InstagramMessage = require("./models/InstagramMessage");
const InstagramComment = require("./models/InstagramComment");

const FB_API_VERSION = process.env.META_API_VERSION || "v23.0";
const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_API_VERSION}`;

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

async function userMetaToken(userId) {
  const u = await User.findById(userId).select("+meta.accessToken");
  return u?.meta?.accessToken || "";
}

async function loadConnection(userId) {
  return InstagramConnection.findOne({ user: userId }).select("+pageAccessToken +webhookVerifyToken");
}

async function requireIg(req, res, next) {
  const conn = await loadConnection(req.user._id);
  if (!conn) return res.status(401).json({ error: "Instagram account not connected" });
  req.ig = conn;
  next();
}

// ---------- Status & connect ----------
router.get("/status", async (req, res, next) => {
  try {
    const conn = await loadConnection(req.user._id);
    if (!conn) {
      const hasMeta = !!(await userMetaToken(req.user._id));
      return res.json({ connected: false, metaConnected: hasMeta });
    }
    res.json({ connected: true, metaConnected: true, connection: conn.toJSON() });
  } catch (err) { next(err); }
});

// Pages with linked Instagram Business accounts (requires Meta login first).
router.get("/pages", async (req, res, next) => {
  try {
    const token = await userMetaToken(req.user._id);
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

    const token = await userMetaToken(req.user._id);
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
      { user: req.user._id },
      {
        user: req.user._id,
        igAccountId: page.instagram_business_account.id,
        username: page.instagram_business_account.username || "",
        name: page.instagram_business_account.name || "",
        profilePictureUrl: page.instagram_business_account.profile_picture_url || "",
        pageId: page.id,
        pageName: page.name || "",
        pageAccessToken: page.access_token || token,
        connectedAt: new Date(),
        webhookVerifyToken: verifyToken,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ connected: true, connection: conn.toJSON() });
  } catch (err) { next(err); }
});

router.post("/disconnect", async (req, res, next) => {
  try {
    await InstagramConnection.deleteOne({ user: req.user._id });
    res.json({ disconnected: true });
  } catch (err) { next(err); }
});

// Instagram Business Login — exchange OAuth `code` → short-lived → long-lived (60d) → MongoDB
router.post("/oauth/callback", async (req, res, next) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: "Authorization code required" });

    const clientId = process.env.INSTAGRAM_CLIENT_ID || "1973429443277994";
    const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET;
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
      { user: req.user._id },
      {
        user: req.user._id,
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
      { user: req.user._id },
      { $set: patch },
      { new: true }
    );
    res.json({ settings: conn.settings, connection: conn.toJSON() });
  } catch (err) { next(err); }
});

// ---------- Inbox (DMs) ----------
router.get("/conversations", requireIg, async (req, res, next) => {
  try {
    const msgs = await InstagramMessage.aggregate([
      { $match: { user: req.user._id } },
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
      { $limit: 50 },
    ]);

    const conversations = msgs.map((m) => ({
      id: m._id,
      igUsername: m.igUsername,
      igUserId: m.igUserId,
      lastText: m.lastText,
      lastAt: m.lastAt,
      unread: m.unread,
    }));

    // Try to sync from Graph API when token has instagram_manage_messages
    try {
      const token = req.ig.pageAccessToken || await userMetaToken(req.user._id);
      const data = await fb({
        method: "get",
        url: `${FB_GRAPH_BASE}/${req.ig.igAccountId}/conversations`,
        params: { platform: "instagram", fields: "id,updated_time", limit: 20 },
        token,
      });
      for (const c of data?.data || []) {
        if (!conversations.find((x) => x.id === c.id)) {
          conversations.push({ id: c.id, igUsername: "", igUserId: "", lastText: "", lastAt: c.updated_time, unread: 0, fromApi: true });
        }
      }
    } catch {
      // Permission missing — local DB conversations only
    }

    res.json({ conversations });
  } catch (err) { next(err); }
});

router.get("/conversations/:id/messages", requireIg, async (req, res, next) => {
  try {
    const messages = await InstagramMessage.find({
      user: req.user._id,
      conversationId: req.params.id,
    }).sort({ createdAt: 1 }).limit(100);

    res.json({
      messages: messages.map((m) => ({
        id: m._id.toString(),
        direction: m.direction,
        text: m.text,
        createdAt: m.createdAt,
        read: m.read,
      })),
    });
  } catch (err) { next(err); }
});

router.post("/conversations/:id/messages", requireIg, async (req, res, next) => {
  try {
    const { text, igUserId, igUsername } = req.body || {};
    if (!text?.trim()) return res.status(400).json({ error: "text required" });

    const token = req.ig.pageAccessToken;
    let metaMessageId = "";

    try {
      const sent = await fb({
        method: "post",
        url: `${FB_GRAPH_BASE}/${req.ig.igAccountId}/messages`,
        data: {
          recipient: { id: igUserId || req.params.id },
          message: { text: text.trim() },
        },
        token,
      });
      metaMessageId = sent?.message_id || sent?.id || "";
    } catch (e) {
      // Store locally even if API send fails (e.g. 24h window / permissions)
      console.warn("[instagram] send DM:", e.message);
    }

    const msg = await InstagramMessage.create({
      user: req.user._id,
      conversationId: req.params.id,
      igUserId: igUserId || "",
      igUsername: igUsername || "",
      direction: "out",
      text: text.trim(),
      metaMessageId,
      read: true,
    });

    res.status(201).json({ message: { id: msg._id.toString(), direction: "out", text: msg.text, createdAt: msg.createdAt } });
  } catch (err) { next(err); }
});

// Demo seed for empty inbox
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
