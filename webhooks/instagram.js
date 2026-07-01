// Instagram webhook — DMs, comments, mentions (Meta Graph API).
// Mount: /webhooks/instagram
//
// Verifies the subscription (GET) and, on events (POST), runs any matching
// active automation flows for the connected account.

const express = require("express");
const axios = require("axios");
const router = express.Router();

const InstagramConnection = require("../models/InstagramConnection");
const InstagramFlow = require("../models/InstagramFlow");
const InstagramComment = require("../models/InstagramComment");
const InstagramMessage = require("../models/InstagramMessage");

const FB_API_VERSION = process.env.META_API_VERSION || "v23.0";
const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_API_VERSION}`;
const IG_GRAPH_BASE = `https://graph.instagram.com/${FB_API_VERSION}`;

// Instagram-Login (oauth) accounts use graph.instagram.com; Facebook-Page-linked
// accounts use graph.facebook.com.
function graphBaseFor(conn) {
  return (conn.authMethod === "oauth" || !conn.pageId) ? IG_GRAPH_BASE : FB_GRAPH_BASE;
}
function accountPathFor(conn) {
  return (conn.authMethod === "oauth" || !conn.pageId) ? "me" : conn.igAccountId;
}

async function fb({ method, url, data, token }) {
  const res = await axios({
    method, url, data,
    params: { access_token: token },
    validateStatus: () => true,
  });
  if (res.status >= 200 && res.status < 300) return res.data;
  const err = res.data?.error || { message: res.statusText };
  throw new Error(err.error_user_msg || err.message || "Instagram API error");
}

function fillVars(text, vars) {
  return String(text || "")
    .replace(/\{\{\s*firstName\s*\}\}/gi, vars.firstName || vars.username || "there")
    .replace(/\{\{\s*username\s*\}\}/gi, vars.username || "there");
}

function keywordsMatch(text, keywordsStr, matchType) {
  const kws = String(keywordsStr || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!kws.length) return true; // no filter → matches everything
  const t = String(text || "").toLowerCase().trim();
  if (matchType === "all") return kws.every((k) => t.includes(k));
  if (matchType === "exact") return kws.includes(t);
  return kws.some((k) => t.includes(k)); // "any"
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Return enabled action nodes of a given type, in saved order. */
function actionsOfType(flow, type) {
  return (flow.nodes || []).filter((n) => n.type === type);
}

/**
 * Dry-run a comment flow against a sample comment — used by the "Test" button.
 * Returns whether it matches and the exact messages it would send. No API calls.
 */
function simulateCommentFlow(flow, { text = "", mediaId = "", username = "tester" } = {}) {
  const cfg = flow.triggerConfig || {};
  const reasons = [];

  if (flow.trigger !== "comment.new") {
    return { matched: false, reasons: ["This flow's trigger is not 'New comment on post'."], actions: [] };
  }
  if (flow.status !== "active") {
    reasons.push("Flow is not active — it won't run until you activate it.");
  }
  if (cfg.postScope === "specific") {
    const ids = Array.isArray(cfg.mediaIds) ? cfg.mediaIds : [];
    if (ids.length && mediaId && !ids.includes(mediaId)) {
      return { matched: false, reasons: ["Comment's post is not in the selected posts."], actions: [] };
    }
    if (ids.length && !mediaId) {
      reasons.push("No post id given — scope check skipped for this test.");
    }
  }
  if (!keywordsMatch(text, cfg.keywords, cfg.matchType)) {
    return { matched: false, reasons: [`Comment text doesn't match keyword filter (${cfg.matchType}: ${cfg.keywords}).`], actions: [] };
  }

  const vars = { username, firstName: username };
  const actions = [];
  for (const node of actionsOfType(flow, "reply_comment")) {
    if (node.config?.text?.trim()) actions.push({ type: "reply_comment", message: fillVars(node.config.text, vars) });
  }
  for (const node of actionsOfType(flow, "private_reply")) {
    if (node.config?.text?.trim()) actions.push({ type: "private_reply", message: fillVars(node.config.text, vars) });
  }
  for (const node of actionsOfType(flow, "add_tag")) {
    if (node.config?.tag?.trim()) actions.push({ type: "add_tag", message: node.config.tag });
  }
  for (const node of actionsOfType(flow, "wait")) {
    const s = Number(node.config?.seconds) || 0;
    if (s > 0) actions.push({ type: "wait", message: `${s}s delay` });
  }

  if (!actions.length) reasons.push("Flow matches, but no actions are enabled — nothing would be sent.");
  return { matched: true, reasons, actions };
}

// ---------- Comment automation ----------
async function handleCommentEvent(igAccountId, value) {
  const commentId = value?.id;
  const text = value?.text || "";
  console.log(`[webhook/instagram] 💬 comment event account=${igAccountId} comment=${commentId} from=@${value?.from?.username || "?"} text="${text}"`);
  const mediaId = value?.media?.id || value?.media_id || "";
  const fromId = value?.from?.id || "";
  const fromUsername = value?.from?.username || "";

  if (!commentId) return;

  // Never act on our own comments/replies — prevents reply loops.
  if (fromId && fromId === igAccountId) {
    console.log("[webhook/instagram] skip own comment", commentId);
    return;
  }

  const conn = await InstagramConnection.findOne({
    $or: [{ igAccountId }, { pageId: igAccountId }, { igUserId: igAccountId }],
  }).select("+pageAccessToken");
  if (!conn) {
    console.warn("[webhook/instagram] no connection for ig account", igAccountId);
    return;
  }

  // Skip if we've already processed this comment.
  const already = await InstagramComment.findOne({ user: conn.user, commentId });
  if (already && already.replied) {
    console.log("[webhook/instagram] comment already handled", commentId);
    return;
  }

  const flows = await InstagramFlow.find({
    user: conn.user,
    trigger: "comment.new",
    status: "active",
  });
  console.log(`[webhook/instagram] comment ${commentId} on media ${mediaId} — ${flows.length} active flow(s)`);

  const token = conn.pageAccessToken;
  const vars = { username: fromUsername, firstName: fromUsername };
  let ranAny = false;

  for (const flow of flows) {
    const cfg = flow.triggerConfig || {};

    // Post scope filter.
    if (cfg.postScope === "specific") {
      const ids = Array.isArray(cfg.mediaIds) ? cfg.mediaIds : [];
      if (mediaId && ids.length && !ids.includes(mediaId)) {
        console.log(`[webhook/instagram] flow "${flow.name}" skipped — media not in scope`);
        continue;
      }
    }

    // Keyword filter.
    if (!keywordsMatch(text, cfg.keywords, cfg.matchType)) {
      console.log(`[webhook/instagram] flow "${flow.name}" skipped — keywords no match`);
      continue;
    }

    // Optional wait.
    const wait = actionsOfType(flow, "wait")[0];
    const waitSec = Number(wait?.config?.seconds) || 0;
    if (waitSec > 0) await sleep(Math.min(waitSec, 60) * 1000);

    // Action: public reply to the comment.
    for (const node of actionsOfType(flow, "reply_comment")) {
      const msg = fillVars(node.config?.text, vars);
      if (!msg.trim()) continue;
      try {
        await fb({ method: "post", url: `${graphBaseFor(conn)}/${commentId}/replies`, data: { message: msg }, token });
        console.log(`[webhook/instagram] flow "${flow.name}" replied to comment ${commentId}`);
      } catch (e) {
        console.warn(`[webhook/instagram] reply_comment failed:`, e.message);
      }
    }

    // Action: private DM reply to the commenter.
    for (const node of actionsOfType(flow, "private_reply")) {
      const msg = fillVars(node.config?.text, vars);
      if (!msg.trim()) continue;
      try {
        await fb({
          method: "post",
          url: `${graphBaseFor(conn)}/${accountPathFor(conn)}/messages`,
          data: { recipient: { comment_id: commentId }, message: { text: msg } },
          token,
        });
        console.log(`[webhook/instagram] flow "${flow.name}" sent private reply for comment ${commentId}`);
      } catch (e) {
        console.warn(`[webhook/instagram] private_reply failed:`, e.message);
      }
    }

    flow.runs = (flow.runs || 0) + 1;
    await flow.save();
    ranAny = true;
  }

  // Settings-level default auto-reply (Instagram → Settings → "Auto-reply to new
  // comments") — runs when no Automation-builder flow already handled it.
  if (!ranAny && conn.settings?.commentAutoReply && String(conn.settings?.commentReplyText || "").trim()) {
    const msg = fillVars(conn.settings.commentReplyText, vars);
    try {
      await fb({ method: "post", url: `${graphBaseFor(conn)}/${commentId}/replies`, data: { message: msg }, token });
      console.log(`[webhook/instagram] settings auto-reply to comment ${commentId}`);
      ranAny = true;
    } catch (e) {
      console.warn("[webhook/instagram] settings comment reply failed:", e.message);
    }
  }

  // Record the comment so it shows in the Comments page and isn't re-processed.
  await InstagramComment.updateOne(
    { user: conn.user, commentId },
    {
      $set: { mediaId, igUsername: fromUsername, text, igUserId: fromId },
      $setOnInsert: { replied: false, replyText: "" },
    },
    { upsert: true }
  );

  if (!ranAny) console.log("[webhook/instagram] no flow/setting matched comment", commentId);
}

// ---------- DM automation ----------
async function handleMessageEvent(igAccountId, messaging) {
  const evType = messaging?.message
    ? (messaging.message.is_echo ? "echo" : "message")
    : messaging?.message_edit ? "message_edit"
    : messaging?.reaction ? "reaction"
    : messaging?.postback ? "postback"
    : messaging?.read ? "read"
    : messaging?.message_reactions ? "message_reactions"
    : "other";
  console.log(`[webhook/instagram] 📩 messaging event=${evType} account=${igAccountId} from=${messaging?.sender?.id || "?"} to=${messaging?.recipient?.id || "?"}`);

  const conn = await InstagramConnection.findOne({
    $or: [{ igAccountId }, { pageId: igAccountId }, { igUserId: igAccountId }],
  }).select("+pageAccessToken");
  if (!conn) {
    console.warn(`[webhook/instagram] ⚠ no connection found for account ${igAccountId} — automation cannot run`);
    return;
  }

  // Resolve the actual message. Instagram (v23) frequently delivers a brand-new
  // DM as a `message_edit` event carrying only a `mid` (no text/sender) — in that
  // case fetch the message content by id and treat it as a normal message.
  let m = messaging?.message || null;
  let senderId = messaging?.sender?.id || null;
  let recipientId = messaging?.recipient?.id || null;
  const selfIds = [String(conn.igAccountId), String(conn.igUserId || "")].filter(Boolean);

  if (!m && messaging?.message_edit?.mid) {
    const mid = messaging.message_edit.mid;
    console.log(`[webhook/instagram] fetching edit message mid=${mid} via ${graphBaseFor(conn)}`);
    try {
      const fetched = await fb({
        method: "get",
        url: `${graphBaseFor(conn)}/${mid}`,
        params: { fields: "id,from,to,message,created_time" },
        token: conn.pageAccessToken,
      });
      console.log(`[webhook/instagram] edit fetch raw:`, JSON.stringify(fetched));
      if (fetched?.id) {
        const fromId = fetched.from?.id ? String(fetched.from.id) : "";
        m = { mid: fetched.id, text: fetched.message || "", is_echo: selfIds.includes(fromId), attachments: [] };
        senderId = fromId || senderId;
        recipientId = fetched.to?.data?.[0]?.id || recipientId;
        console.log(`[webhook/instagram] resolved edit→message mid=${fetched.id} from=${fromId} echo=${m.is_echo} text="${m.text}"`);
      }
    } catch (e) {
      console.warn(`[webhook/instagram] fetch message by mid failed: ${e.message}`);
    }
  }

  if (!m || !m.mid) return; // reaction / read / unresolved — nothing to do

  // ---- Persist the DM so it shows in the inbox (both incoming and our echoes) ----
  {
    const echo = !!m.is_echo;
    const peerId = echo ? recipientId : senderId;
    if (peerId && !selfIds.includes(String(peerId))) {
      const attachments = (m.attachments || []).map((a) => ({
        type: a.type || "file",
        url: a.payload?.url || "",
        previewUrl: a.payload?.url || "",
      }));
      try {
        await InstagramMessage.findOneAndUpdate(
          { user: conn.user, metaMessageId: m.mid },
          {
            $set: {
              user: conn.user,
              conversationId: String(peerId),
              igUserId: String(peerId),
              direction: echo ? "out" : "in",
              text: m.text || "",
              attachments,
              read: echo,
            },
          },
          { upsert: true, setDefaultsOnInsert: true }
        );
      } catch (e) {
        console.warn("[webhook/instagram] persist message failed:", e.message);
      }
    }
  }

  // ---- Auto-reply / flows run only for genuine inbound messages ----
  const text = m.text || "";
  const isEcho = !!m.is_echo;
  if (!senderId || isEcho || selfIds.includes(String(senderId))) return;

  // Settings-level default auto-reply (Instagram → Settings → "Auto-reply to new DMs").
  if (conn.settings?.dmAutoReply && String(conn.settings?.dmAutoReplyText || "").trim()) {
    try {
      await fb({
        method: "post",
        url: `${graphBaseFor(conn)}/${accountPathFor(conn)}/messages`,
        data: { recipient: { id: senderId }, message: { text: conn.settings.dmAutoReplyText } },
        token: conn.pageAccessToken,
      });
      console.log(`[webhook/instagram] settings auto-reply DM to ${senderId}`);
    } catch (e) {
      console.warn("[webhook/instagram] settings dm reply failed:", e.message);
    }
  }

  const flows = await InstagramFlow.find({
    user: conn.user,
    trigger: { $in: ["dm.received", "keyword.dm"] },
    status: "active",
  });
  console.log(`[webhook/instagram] inbound DM from ${senderId} → conn.user=${conn.user} text="${text}" → ${flows.length} active DM flow(s)`);
  if (!flows.length) return;

  const token = conn.pageAccessToken;
  for (const flow of flows) {
    const cfg = flow.triggerConfig || {};
    if (flow.trigger === "keyword.dm" && !keywordsMatch(text, cfg.keywords, cfg.matchType)) continue;

    for (const node of actionsOfType(flow, "send_dm")) {
      const msg = fillVars(node.config?.text, { username: "", firstName: "" });
      if (!msg.trim()) continue;
      try {
        await fb({
          method: "post",
          url: `${graphBaseFor(conn)}/${accountPathFor(conn)}/messages`,
          data: { recipient: { id: senderId }, message: { text: msg } },
          token,
        });
        console.log(`[webhook/instagram] flow "${flow.name}" sent DM to ${senderId}`);
      } catch (e) {
        console.warn("[webhook/instagram] send_dm failed:", e.message);
      }
    }
    flow.runs = (flow.runs || 0) + 1;
    await flow.save();
  }
}

// ---------- Routes ----------
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token) {
    return res.status(200).send(challenge);
  }
  res.status(403).send("Forbidden");
});

router.post("/", express.json(), async (req, res) => {
  // Always log the full incoming payload for debugging.
  console.log("[webhook/instagram] body:", JSON.stringify(req.body, null, 2));

  // Ack immediately — Meta retries if we don't 200 within a few seconds.
  res.sendStatus(200);

  try {
    const body = req.body || {};
    if (body.object !== "instagram" && body.object !== "page") return;

    for (const entry of body.entry || []) {
      const igAccountId = entry.id;
      const changeFields = (entry.changes || []).map((c) => c.field);
      console.log(`[webhook/instagram] entry account=${igAccountId} changes=[${changeFields.join(",")}] messaging=${(entry.messaging || []).length}`);

      for (const change of entry.changes || []) {
        if (change.field === "comments") {
          await handleCommentEvent(igAccountId, change.value);
        } else {
          console.log(`[webhook/instagram] (ignored change field: ${change.field})`);
        }
      }

      for (const messaging of entry.messaging || []) {
        await handleMessageEvent(igAccountId, messaging);
      }
    }
  } catch (e) {
    console.error("[webhook/instagram] processing error:", e.message);
  }
});

module.exports = router;
module.exports.simulateCommentFlow = simulateCommentFlow;
