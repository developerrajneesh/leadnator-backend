// WhatsApp Cloud API webhook.
//
//   GET  /webhooks/whatsapp  — handshake. Meta sends hub.mode/verify_token/challenge
//                              and expects us to echo the challenge if the token
//                              matches what the user saved in WhatsAppConnection.
//   POST /webhooks/whatsapp  — receives delivery statuses + inbound messages.
//                              We persist inbound messages and, if the user has
//                              an ACTIVE WhatsAppChatbot, auto-reply with the
//                              matching step's text + CTAs.
//
// Multi-tenant: Meta posts one webhook per phoneNumberId. We look up which user
// owns that phone number in WhatsAppConnection and scope writes/auto-replies to
// that user.
//
// Verbose console logging is ON by default — every payload is pretty-printed
// so you can see exactly what Meta sent while wiring this up. Set env
// WA_WEBHOOK_SILENT=1 to quiet it down in production.

const express = require("express");
const axios = require("axios");

const WhatsAppConnection = require("../models/WhatsAppConnection");
const WhatsAppMessage    = require("../models/WhatsAppMessage");
const WhatsAppContact    = require("../models/WhatsAppContact");
const WhatsAppChatbot    = require("../models/WhatsAppChatbot");
const LeadSettings       = require("../models/LeadSettings");
const Lead               = require("../models/Lead");
const { emitToUser }     = require("../services/socket");
const { ensureWabaSubscribed } = require("../services/waSubscribe");
const { generateText }   = require("../services/aiService");

const FB_API_VERSION = process.env.META_API_VERSION || "v23.0";
const FB_GRAPH_BASE  = `https://graph.facebook.com/${FB_API_VERSION}`;
const VERBOSE        = process.env.WA_WEBHOOK_SILENT !== "1";

const router = express.Router();

// JSON parser scoped to this router. The global express.json() runs AFTER
// `/webhooks` is mounted (see server.js), so without this req.body is empty
// and we silently drop every Meta event.
router.use(express.json({ limit: "2mb" }));

// Ring-buffer of recent payloads, exposed via GET /webhooks/whatsapp/debug so
// the UI / a curl can inspect the last thing Meta posted without tailing logs.
const RECENT = [];
const MAX_RECENT = 20;
function remember(entry) {
  RECENT.unshift({ ts: new Date().toISOString(), ...entry });
  if (RECENT.length > MAX_RECENT) RECENT.length = MAX_RECENT;
}

function log(...args) {
  if (!VERBOSE) return;
  console.log("[webhook/whatsapp]", ...args);
}

function dumpPayload(body) {
  if (!VERBOSE) return;
  try {
    console.log("[webhook/whatsapp] ────── payload ──────");
    console.log(JSON.stringify(body, null, 2));
    console.log("[webhook/whatsapp] ─────────────────────");
  } catch {
    console.log("[webhook/whatsapp] (unstringifiable body)");
  }
}

// ---------- GET: verify handshake ----------
router.get("/", async (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  log(`GET verify: mode=${mode} token=${token ? token.slice(0, 4) + "…" : "(none)"} challenge=${challenge ? "present" : "(none)"}`);

  if (mode !== "subscribe" || !token) {
    log("→ 400: missing mode/token");
    return res.sendStatus(400);
  }

  try {
    const conn = await WhatsAppConnection.findOne({ webhookVerifyToken: token }).select("+webhookVerifyToken");
    const globalToken = String(process.env.WEBHOOK_VERIFY_TOKEN || "").trim();
    if (conn) {
      log(`→ 200: verified for user ${conn.user} (phone ${conn.phoneNumberId})`);
      return res.status(200).send(challenge);
    }
    if (globalToken && token === globalToken) {
      log("→ 200: verified with WEBHOOK_VERIFY_TOKEN from .env");
      return res.status(200).send(challenge);
    }
    log("→ 403: no matching verify token in DB or WEBHOOK_VERIFY_TOKEN. Paste token from WhatsApp Settings → Webhook into Meta App.");
  } catch (err) {
    log("→ 500 verify lookup failed:", err.message);
  }
  return res.sendStatus(403);
});

// Debug endpoint: returns the last N webhook payloads so you can inspect them
// without tailing the server log. NOT protected — don't expose publicly in prod.
router.get("/debug", (_req, res) => {
  res.json({ count: RECENT.length, recent: RECENT });
});

async function resolveWhatsAppConnection({ phoneNumberId, wabaId }) {
  if (phoneNumberId) {
    const byPhone = await WhatsAppConnection.findOne({ phoneNumberId: String(phoneNumberId) })
      .select("+accessToken");
    if (byPhone) return byPhone;
  }
  const waba = String(wabaId || "").trim();
  if (waba) {
    return WhatsAppConnection.findOne({ businessAccountId: waba }).select("+accessToken");
  }
  return null;
}

/** account_update / PARTNER_APP_INSTALLED — not an inbound message. */
async function handleAccountUpdate(entry, change, value) {
  const field = change?.field || "unknown";
  const event = value?.event || "unknown";
  const wabaId = value?.waba_info?.waba_id || entry?.id;
  log(`account_update: field=${field} event=${event} waba=${wabaId || "(none)"}`);

  if (!wabaId) {
    remember({ kind: "account_update", event, wabaId: null });
    return;
  }

  const conn = await resolveWhatsAppConnection({ wabaId });
  if (!conn) {
    log(`⚠ account_update for WABA ${wabaId} — no WhatsAppConnection in DB`);
    remember({ kind: "account_update", event, wabaId, reason: "no connection" });
    return;
  }

  if (event === "PARTNER_APP_INSTALLED" || event === "PARTNER_ADDED") {
    const sub = await ensureWabaSubscribed(conn, { force: true });
    log(`✓ PARTNER_APP_INSTALLED → WABA subscribe: ${sub.subscribed ? "ok" : sub.error || sub.reason}`);
    remember({ kind: "account_update", event, wabaId, subscription: sub });
    return;
  }

  remember({ kind: "account_update", event, wabaId });
}

async function processMessagingWebhook(entry, change, value) {
  const field = change?.field || "unknown";
  const phoneNumberId = value?.metadata?.phone_number_id;
  const wabaId = entry?.id;

  log(`field=${field} phone_number_id=${phoneNumberId || "(none)"} waba=${wabaId || "(none)"}`);

  const conn = await resolveWhatsAppConnection({ phoneNumberId, wabaId });
  if (!conn) {
    log(`⚠ no WhatsAppConnection for phone=${phoneNumberId || "?"} waba=${wabaId || "?"}. Reconnect in WhatsApp Settings.`);
    remember({ kind: "ignored", reason: "no connection", phoneNumberId, wabaId, field });
    return;
  }
  log(`→ owner: user ${conn.user} phone=${conn.phoneNumberId} waba=${conn.businessAccountId}`);

  if (!phoneNumberId && !(value.messages?.length) && !(value.statuses?.length)) {
    log("⚠ messaging field but no metadata.phone_number_id and no messages/statuses");
    remember({ kind: "ignored", reason: "empty messaging payload", field });
    return;
  }

    // --- Delivery / read status updates ---
    for (const st of value.statuses || []) {
      if (!st.id || !st.status) continue;
      log(`status update: msg=${st.id} → ${st.status}`);
      await WhatsAppMessage.updateOne(
        { user: conn.user, phoneNumberId: conn.phoneNumberId, messageId: st.id },
        { $set: { status: st.status } }
      );
      emitToUser(conn.user, "wa.status", { messageId: st.id, status: st.status });
    }

    // --- Inbound messages ---
    for (const msg of value.messages || []) {
      const fromPhone = msg.from;
      if (!fromPhone) { log("⚠ message has no from"); continue; }

      const text =
        msg.text?.body ||
        msg.button?.text ||
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title ||
        (msg.image ? "[image]" : "") ||
        (msg.audio ? "[audio]" : "") ||
        (msg.video ? "[video]" : "") ||
        (msg.document ? "[document]" : "") ||
        (msg.sticker ? "[sticker]" : "") ||
        (msg.location ? "[location]" : "") ||
        (msg.contacts ? "[contact card]" : "") ||
        "(unknown)";

      const profileName = value.contacts?.[0]?.profile?.name || "";

      log(`inbound: ${profileName || "?"} (${fromPhone}) → "${text}" (type=${msg.type})`);

      // Record which button/list-row the user tapped so the inbox can show it.
      const inboundMeta = {};
      if (msg.interactive?.button_reply) {
        inboundMeta.tap = { kind: "button", id: msg.interactive.button_reply.id, title: msg.interactive.button_reply.title };
      } else if (msg.interactive?.list_reply) {
        inboundMeta.tap = { kind: "list_row", id: msg.interactive.list_reply.id, title: msg.interactive.list_reply.title, description: msg.interactive.list_reply.description || "" };
      } else if (msg.image || msg.video || msg.audio || msg.document || msg.sticker) {
        const mediaKind = msg.image ? "image" : msg.video ? "video" : msg.audio ? "audio" : msg.document ? "document" : "sticker";
        inboundMeta.media = { kind: mediaKind, id: msg[mediaKind]?.id || "", mime: msg[mediaKind]?.mime_type || "", filename: msg.document?.filename || "" };
      } else if (msg.location) {
        inboundMeta.location = { lat: msg.location.latitude, lng: msg.location.longitude, name: msg.location.name || "", address: msg.location.address || "" };
      }

      const saved = await WhatsAppMessage.create({
        user: conn.user,
        phoneNumberId: conn.phoneNumberId,
        contactPhone: fromPhone,
        direction: "inbound",
        type: msg.type || "text",
        text,
        messageId: msg.id || "",
        status: "received",
        ts: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date(),
        meta: inboundMeta,
      }).catch((e) => { log("✗ save inbound failed:", e.message); return null; });

      if (saved) {
        log(`✓ saved inbound _id=${saved._id}`);
        emitToUser(conn.user, "wa.inbound", {
          message: saved.toJSON(),
          contact: { phone: fromPhone, name: profileName || fromPhone },
        });
      }

      // Upsert contact so the conversation list has a friendly name.
      // An inbound message is definitive proof the number is on WhatsApp,
      // so stamp isOnWhatsapp=true here too.
      // The `upsert=true + rawResult` trick tells us whether this was a
      // brand-new contact (first time this number has ever messaged us) —
      // needed for the "first message only" lead-creation toggle.
      // Split into two writes so we never hit Mongo's "conflict at 'name'"
      // error (same path can't appear in $set and $setOnInsert). Insert-first
      // returns `upsertedId` so we know the contact is brand-new. The second
      // write (without $setOnInsert) can then safely overwrite `name` with
      // the latest profile name whenever Meta gives us one.
      let contactWasNew = false;
      try {
        const ins = await WhatsAppContact.updateOne(
          { user: conn.user, phoneNumberId: conn.phoneNumberId, phone: fromPhone },
          { $setOnInsert: { user: conn.user, phoneNumberId: conn.phoneNumberId, phone: fromPhone, name: profileName || fromPhone } },
          { upsert: true }
        );
        contactWasNew = !!(ins.upsertedCount || ins.upsertedId);

        const $set = {
          isOnWhatsapp: true,
          waId: fromPhone,
          waCheckedAt: new Date(),
        };
        // Don't stamp `name` on insert (the $setOnInsert above already did),
        // but DO update it for existing contacts when Meta sends a profile name.
        if (profileName && !contactWasNew) $set.name = profileName;

        await WhatsAppContact.updateOne(
          { user: conn.user, phoneNumberId: conn.phoneNumberId, phone: fromPhone },
          { $set }
        );
      } catch (e) { log("✗ upsert contact failed:", e.message); }

      remember({ kind: "inbound", from: fromPhone, name: profileName, text, type: msg.type });

      // Auto-create a Lead if the user opted in to WhatsApp lead capture.
      // De-dupe by phone so we never insert twice for the same number.
      try {
        const settings = await LeadSettings.forScope(conn.user, conn.organization || null);
        const wa = settings?.whatsapp;
        if (wa?.enabled && (!wa.firstMessageOnly || contactWasNew)) {
          const existing = await Lead.findOne({ owner: conn.user, phone: fromPhone });
          if (!existing) {
            const tags = Array.from(new Set(["whatsapp", ...(wa.defaultTags || [])]));
            await Lead.create({
              owner:  conn.user,
              name:   profileName || fromPhone,
              phone:  fromPhone,
              email:  "",
              source: "WhatsApp",
              status: wa.defaultStatus || "new",
              value:  wa.defaultValue || 0,
              tags,
              notes:  text ? `First WhatsApp message: "${String(text).slice(0, 300)}"` : "Came in via WhatsApp",
            });
            log(`✓ created WhatsApp lead for ${fromPhone} (user ${conn.user})`);
          }
        }
      } catch (e) { log("✗ whatsapp → lead creation failed:", e.message); }

      // Capture the clicked button's ID so multi-step flows can advance
      // exactly along the edge the user tapped, even if two steps have
      // buttons with the same label.
      const buttonId = msg.interactive?.button_reply?.id
        || msg.interactive?.list_reply?.id
        || "";

      // Auto-reply via the user's active chatbot (if any).
      await tryChatbotReply({ conn, fromPhone, text, buttonId, messageId: msg.id || "" }).catch((e) =>
        log("✗ chatbot reply failed:", e.message)
      );
    }

    if (!(value.messages?.length) && !(value.statuses?.length)) {
      log(`⚠ field=${field} had no messages[] or statuses[] — subscribe to "messages" in Meta App → Webhooks → WhatsApp Business Account`);
      remember({ kind: "empty_messaging", field, wabaId });
    }
}

// ---------- POST: inbound events ----------
router.post("/", async (req, res) => {
  // Ack FAST — Meta retries aggressively if we take >10s or respond non-200.
  res.sendStatus(200);

  log(`POST event received at ${new Date().toISOString()} object=${req.body?.object || "?"}`);
  dumpPayload(req.body);

  try {
    const entries = req.body?.entry;
    if (!Array.isArray(entries) || !entries.length) {
      log("⚠ no entry[] — ignoring");
      remember({ kind: "ignored", reason: "no entry", body: req.body });
      return;
    }

    for (const entry of entries) {
      const changes = entry.changes || [];
      if (!changes.length) {
        log(`⚠ entry ${entry.id} has no changes[]`);
        continue;
      }

      for (const change of changes) {
        const value = change?.value;
        if (!value) continue;

        const field = change.field || "";

        if (field === "account_update") {
          await handleAccountUpdate(entry, change, value);
          continue;
        }

        if (field === "messages" || value.messaging_product === "whatsapp") {
          await processMessagingWebhook(entry, change, value);
          continue;
        }

        log(`⚠ unhandled webhook field="${field}" — subscribe "messages" in Meta Developer App`);
        remember({ kind: "unhandled_field", field, entryId: entry.id });
      }
    }
  } catch (err) {
    log("✗ handler error:", err.message, err.stack);
    remember({ kind: "error", error: err.message });
  }
});

// Given a user and an inbound message, find a matching chatbot step and send
// its reply text + CTA buttons. Honors multi-step flows by tracking the user's
// last step on WhatsAppContact and routing through the tapped button's
// nextStepId when applicable.
// Mark the customer's message as read (blue ticks) AND show a "typing…"
// indicator while the bot prepares its reply. WhatsApp Cloud API does both in
// a single call; the typing bubble lasts up to ~25s or until we send a message.
async function markReadAndTyping(conn, messageId) {
  if (!messageId) return;
  try {
    await axios.post(
      `${FB_GRAPH_BASE}/${conn.phoneNumberId}/messages`,
      { messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } },
      { params: { access_token: conn.accessToken }, validateStatus: () => true },
    );
  } catch (e) { log("mark-read/typing failed:", e.message); }
}

async function tryChatbotReply({ conn, fromPhone, text, buttonId = "", messageId = "" }) {
  // Prefer the active bot bound to this exact number; fall back to a legacy
  // bot with no number set.
  let bot = await WhatsAppChatbot.findOne({ user: conn.user, status: "active", phoneNumberId: conn.phoneNumberId }).sort({ updatedAt: -1 });
  if (!bot) {
    bot = await WhatsAppChatbot.findOne({
      user: conn.user, status: "active",
      $or: [{ phoneNumberId: "" }, { phoneNumberId: { $exists: false } }],
    }).sort({ updatedAt: -1 });
  }
  if (!bot) { log("no active chatbot for this number — skipping auto-reply"); return; }

  // Show "seen" + "typing…" before the bot replies.
  await markReadAndTyping(conn, messageId);

  // AI chatbot: answer from the knowledge base instead of running keyword steps.
  if (bot.type === "ai") {
    await handleAiChatbotReply({ conn, fromPhone, text, bot });
    return;
  }

  const lower = String(text || "").trim().toLowerCase();
  const steps = bot.steps || [];

  // Load conversation state — expires after 30 min so a stale step doesn't
  // hijack new triggers.
  const contact = await WhatsAppContact.findOne({ user: conn.user, phone: fromPhone });
  const thirtyMinAgo = Date.now() - 30 * 60_000;
  const stateFresh = contact?.lastChatbotAt && new Date(contact.lastChatbotAt).getTime() > thirtyMinAgo;
  const lastStepId = stateFresh ? (contact?.lastChatbotStepId || "") : "";

  let step = null;
  let matchReason = "";

  // 1) Follow the button tapped from the step we last sent. Prefer button id
  //    (exact), fall back to label match. Also handle list-message row taps.
  if (lastStepId) {
    const lastStep = steps.find((s) => s.id === lastStepId);
    if (lastStep) {
      // a) Reply / quick_reply button
      const btn = (lastStep.buttons || []).find((b) =>
        (buttonId && b.id === buttonId) || b.label.toLowerCase() === lower
      );
      if (btn?.kind === "quick_reply" && btn.nextStepId) {
        const target = steps.find((s) => s.id === btn.nextStepId);
        if (target) { step = target; matchReason = `button "${btn.label}" → step ${target.id}`; }
      }
      // b) List row tap
      if (!step && lastStep.bodyType === "list") {
        const rows = (lastStep.list?.sections || []).flatMap((sec) => sec.rows || []);
        const row = rows.find((r) =>
          (buttonId && r.id === buttonId) || r.title.toLowerCase() === lower
        );
        if (row?.nextStepId) {
          const target = steps.find((s) => s.id === row.nextStepId);
          if (target) { step = target; matchReason = `list row "${row.title}" → step ${target.id}`; }
        }
      }
    }
  }

  // 2) Trigger-keyword match across all steps.
  if (!step) {
    step = steps.find((s) => (s.triggers || []).some((t) => t && lower.includes(t.toLowerCase())));
    if (step) matchReason = `trigger keyword → step ${step.id}`;
  }

  // 3) Start step (catch-all).
  if (!step) {
    step = steps.find((s) => s.isStart);
    if (step) matchReason = `start step`;
  }

  log(`chatbot routing: lastStep=${lastStepId || "(none)"} → ${matchReason || "no match (will use fallback)"}`);

  if (!step && !bot.fallback) return;

  const payloads = step ? buildMessages(step) : [{ type: "text", text: { body: bot.fallback, preview_url: true } }];

  for (const payload of payloads) {
    const body = { messaging_product: "whatsapp", to: fromPhone, ...payload };
    log(`chatbot → sending ${payload.type} to ${fromPhone}`);
    const res = await axios.post(
      `${FB_GRAPH_BASE}/${conn.phoneNumberId}/messages`,
      body,
      { params: { access_token: conn.accessToken }, validateStatus: () => true }
    );
    if (res.status < 200 || res.status >= 300) {
      log("✗ chatbot send failed:", res.data?.error?.message || res.status);
      continue;
    }

    // Rich meta so the Inbox can render buttons, media, list rows, etc.
    const meta = step ? stepMeta(step, bot) : { botName: bot.name, fallback: true };

    const botMsg = await WhatsAppMessage.create({
      user: conn.user, phoneNumberId: conn.phoneNumberId, contactPhone: fromPhone, direction: "outbound",
      type: payload.type,
      text: step?.message || bot.fallback,
      messageId: res.data?.messages?.[0]?.id || "",
      status: "sent",
      meta,
    });
    emitToUser(conn.user, "wa.outbound", { message: botMsg.toJSON() });
  }

  // Remember which step we're on so tapping a quick-reply advances correctly.
  if (step) {
    WhatsAppContact.updateOne(
      { user: conn.user, phoneNumberId: conn.phoneNumberId, phone: fromPhone },
      { $set: { lastChatbotId: bot._id, lastChatbotStepId: step.id, lastChatbotAt: new Date() } }
    ).catch(() => {});
  }

  WhatsAppChatbot.updateOne(
    { _id: bot._id },
    { $inc: { messagesHandled: 1 }, $set: { lastHandledAt: new Date() } }
  ).catch(() => {});
}

// AI chatbot: generate an answer from the bot's knowledge base and reply.
// Appends configured CTAs (one URL button as a native cta_url; phone inlined).
async function handleAiChatbotReply({ conn, fromPhone, text, bot }) {
  const ai = bot.ai || {};
  let answer = "";
  try {
    // Pull recent conversation so the bot has memory and doesn't restart/greet
    // every message. (The current inbound message is already saved, so it's the
    // last "Customer:" line.)
    const recent = await WhatsAppMessage.find({ user: conn.user, contactPhone: fromPhone })
      .sort({ createdAt: -1 }).limit(12).lean();
    const transcript = recent
      .reverse()
      .map((m) => ({ who: m.direction === "inbound" ? "Customer" : "Assistant", t: (m.text || "").trim() }))
      .filter((m) => m.t)
      .map((m) => `${m.who}: ${m.t}`)
      .join("\n");

    const system = [
      "You are a helpful WhatsApp assistant for a business, in the middle of an ongoing chat with one customer.",
      "GREET ONLY ONCE: only welcome/greet the customer if there is NO prior conversation. In every later reply, do NOT greet, do NOT say 'Hi/Hello/Welcome', and do NOT re-introduce yourself or repeat the intro questions.",
      "Never ask again for details the customer has already provided in the conversation — acknowledge them and move forward.",
      "Answer using ONLY the knowledge base below. If the answer isn't there, reply with: " + (bot.fallback || "Sorry, I couldn't find that — let me connect you to our team."),
      `Tone: ${ai.tone || "friendly"}. Keep replies short and WhatsApp-friendly — plain text, no markdown headings.`,
      "",
      "KNOWLEDGE BASE:",
      ai.knowledgeBase || "(empty)",
    ].join("\n");

    const prompt = transcript
      ? `Conversation so far:\n${transcript}\n\nWrite the assistant's next reply to the customer's most recent message. Continue naturally; do not repeat earlier greetings or already-answered questions.`
      : `The customer's first message: ${String(text || "").slice(0, 1000)}`;

    const { content } = await generateText({ prompt, system, temperature: 0.4 });
    answer = (content || "").trim();
  } catch (e) {
    log("AI chatbot generate failed:", e.message);
    answer = bot.fallback || "Sorry, I couldn't process that right now.";
  }
  if (!answer) answer = bot.fallback || "Sorry, I couldn't find that.";

  answer = answer.slice(0, 4096);

  // WhatsApp free-form CTAs: EITHER one "Visit website" (cta_url) button OR up to
  // 3 quick-reply buttons. URL wins if present; tapping a quick-reply sends its
  // label back, which the AI then answers.
  const ctas = ai.ctas || [];
  const urlCta = ctas.find((c) => c.kind === "url" && c.value && c.label);
  const replyCtas = ctas.filter((c) => c.kind === "reply" && c.label).slice(0, 3);

  let payload;
  if (urlCta) {
    payload = {
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: { text: answer.slice(0, 1024) },
        action: { name: "cta_url", parameters: { display_text: urlCta.label.slice(0, 20), url: urlCta.value } },
      },
    };
  } else if (replyCtas.length) {
    payload = {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: answer.slice(0, 1024) },
        action: { buttons: replyCtas.map((c, i) => ({ type: "reply", reply: { id: `qr_${i}`, title: c.label.slice(0, 20) } })) },
      },
    };
  } else {
    payload = { type: "text", text: { body: answer, preview_url: true } };
  }

  const res = await axios.post(
    `${FB_GRAPH_BASE}/${conn.phoneNumberId}/messages`,
    { messaging_product: "whatsapp", to: fromPhone, ...payload },
    { params: { access_token: conn.accessToken }, validateStatus: () => true },
  );
  if (res.status < 200 || res.status >= 300) {
    log("✗ AI chatbot send failed:", res.data?.error?.message || res.status);
    return;
  }

  const botMsg = await WhatsAppMessage.create({
    user: conn.user, phoneNumberId: conn.phoneNumberId, contactPhone: fromPhone, direction: "outbound",
    type: payload.type, text: answer, messageId: res.data?.messages?.[0]?.id || "", status: "sent",
    meta: { botName: bot.name, ai: true },
  });
  emitToUser(conn.user, "wa.outbound", { message: botMsg.toJSON() });

  WhatsAppChatbot.updateOne(
    { _id: bot._id },
    { $inc: { messagesHandled: 1 }, $set: { lastHandledAt: new Date() } },
  ).catch(() => {});
}

// Turn a chatbot step into one OR MORE WhatsApp Cloud API message payloads.
// Returns an array; the caller sends them in order.
//
// WhatsApp Cloud API constraints for free-form (non-template) messages:
//   • interactive.button   → up to 3 reply buttons (quick_reply) — NO urls/phones.
//   • interactive.cta_url  → exactly ONE url button — NO other buttons.
//   • Phone-call buttons DO NOT EXIST outside approved templates.
//   • Only ONE interactive type per message.
//
// So to surface multiple CTA types as native buttons we must split into separate
// messages. Phone numbers get inlined in the body — WhatsApp auto-linkifies them
// so the user can tap-to-call anyway. Copy-code has no free-form equivalent; it
// goes in the body as "Code: *XYZ*" which WhatsApp formats in monospace.
// Distill a step + the bot it belongs to into a compact snapshot suitable
// for storing on WhatsAppMessage.meta — so the inbox can render the exact
// buttons/media/list the bot shipped, even if the bot is edited later.
function stepMeta(step, bot) {
  const m = {
    bot: { id: bot._id.toString(), name: bot.name },
    stepId: step.id,
    bodyType: step.bodyType || "text",
    header: step.header || "",
    footer: step.footer || "",
  };
  if (step.buttons?.length) {
    m.buttons = step.buttons.map((b) => ({
      id: b.id, kind: b.kind, label: b.label,
      url: b.url || "", phone: b.phone || "", code: b.code || "",
      nextStepId: b.nextStepId || "",
    }));
  }
  if (step.bodyType && step.bodyType !== "text") {
    if (["image","video","document","audio"].includes(step.bodyType)) {
      m.media = {
        kind: step.bodyType,
        url: step.mediaUrl || "",
        id:  step.mediaId  || "",
        filename: step.mediaFilename || "",
        mime: step.mediaMime || "",
      };
    }
    if (step.bodyType === "location" && step.location) {
      m.location = {
        lat: step.location.lat, lng: step.location.lng,
        name: step.location.name || "", address: step.location.address || "",
      };
    }
    if (step.bodyType === "list" && step.list) {
      m.list = {
        buttonText: step.list.buttonText || "Options",
        sections: (step.list.sections || []).map((sec) => ({
          title: sec.title || "",
          rows: (sec.rows || []).map((r) => ({ id: r.id, title: r.title, description: r.description || "" })),
        })),
      };
    }
  }
  return m;
}

function buildMessages(step) {
  const buttons = step.buttons || [];
  const quick   = buttons.filter((b) => b.kind === "quick_reply").slice(0, 3);
  const urls    = buttons.filter((b) => b.kind === "url"       && b.url);
  const phones  = buttons.filter((b) => b.kind === "phone"     && b.phone);
  const codes   = buttons.filter((b) => b.kind === "copy_code" && b.code);
  const bodyType = step.bodyType || "text";

  // ------- LIST message: dedicated interactive type, no CTA buttons -------
  if (bodyType === "list" && (step.list?.sections || []).length > 0) {
    const sections = (step.list.sections || []).map((sec) => ({
      title: String(sec.title || "").slice(0, 24),
      rows: (sec.rows || []).slice(0, 10).map((r) => ({
        id: r.id,
        title: String(r.title || "").slice(0, 24),
        ...(r.description ? { description: String(r.description).slice(0, 72) } : {}),
      })),
    })).filter((s) => s.rows.length > 0);

    if (sections.length > 0) {
      return [{
        type: "interactive",
        interactive: {
          type: "list",
          ...(step.header ? { header: { type: "text", text: String(step.header).slice(0, 60) } } : {}),
          body: { text: (step.message || "Pick an option below").slice(0, 1024) },
          ...(step.footer ? { footer: { text: String(step.footer).slice(0, 60) } } : {}),
          action: {
            button: String(step.list.buttonText || "Options").slice(0, 20),
            sections,
          },
        },
      }];
    }
  }

  // ------- LOCATION -------
  if (bodyType === "location" && step.location?.lat != null && step.location?.lng != null) {
    return [{
      type: "location",
      location: {
        latitude:  Number(step.location.lat),
        longitude: Number(step.location.lng),
        name:      step.location.name || undefined,
        address:   step.location.address || undefined,
      },
    }];
  }

  // Helper: build the `{ id }` or `{ link }` payload. Meta accepts only ONE.
  const mediaRef = (kind) => {
    if (step.mediaId) return { id: step.mediaId };
    if (step.mediaUrl) return { link: step.mediaUrl };
    return null;
  };

  // ------- AUDIO (no caption / buttons supported by API) -------
  if (bodyType === "audio") {
    const ref = mediaRef("audio");
    if (ref) return [{ type: "audio", audio: ref }];
  }

  // ------- MEDIA header for interactive messages (image/video/document) -------
  // If we have an interactive message (cta_url / button) AND the step body is
  // media, we can attach the media as the interactive header.
  const hasMedia = step.mediaId || step.mediaUrl;
  const mediaKindForHeader = ["image", "video", "document"].includes(bodyType) && hasMedia ? bodyType : null;
  const mediaHeader = mediaKindForHeader ? {
    header: {
      type: mediaKindForHeader,
      [mediaKindForHeader]: {
        ...(step.mediaId ? { id: step.mediaId } : { link: step.mediaUrl }),
        ...(mediaKindForHeader === "document" && step.mediaFilename ? { filename: step.mediaFilename } : {}),
      },
    },
  } : null;

  const surround = (interactive) => ({
    ...interactive,
    // Media header takes precedence over text header when both are present.
    ...(mediaHeader || (step.header ? { header: { type: "text", text: String(step.header).slice(0, 60) } } : {})),
    ...(step.footer ? { footer: { text: String(step.footer).slice(0, 60) } } : {}),
  });

  const messages = [];

  // Main body text. Phones + copy-codes always inline (no native equivalent).
  let mainBody = step.message || "";
  for (const c of phones) mainBody += `\n\n📞 ${c.label}: ${c.phone}`;
  for (const c of codes)  mainBody += `\n\n🎟️ ${c.label}: *${c.code}*`;
  // Extra URLs beyond the first one — inlined as links (can't have multiple cta_url).
  for (const c of urls.slice(1)) mainBody += `\n\n🔗 ${c.label}: ${c.url}`;

  // ------- Standalone media (image/video/document) with NO interactive buttons -------
  // If the step is media + has no native interactive buttons, send a plain media
  // message with a caption. Interactive messages support the media as a header
  // (handled further down) when CTAs are present.
  if (["image", "video", "document"].includes(bodyType) && hasMedia && quick.length === 0 && urls.length === 0) {
    const payload = {
      type: bodyType,
      [bodyType]: {
        ...(step.mediaId ? { id: step.mediaId } : { link: step.mediaUrl }),
        ...(mainBody ? { caption: mainBody.slice(0, 1024) } : {}),
        ...(bodyType === "document" && step.mediaFilename ? { filename: step.mediaFilename } : {}),
      },
    };
    return [payload];
  }

  // Prefer cta_url as the PRIMARY message when a URL CTA exists — gives us a
  // real tappable button. Quick replies then follow in a second message.
  if (urls.length >= 1) {
    const firstUrl = urls[0];
    messages.push({
      type: "interactive",
      interactive: surround({
        type: "cta_url",
        body: { text: mainBody.slice(0, 1024) || "Tap below to continue" },
        action: {
          name: "cta_url",
          parameters: {
            display_text: String(firstUrl.label || "Open").slice(0, 20),
            url: firstUrl.url,
          },
        },
      }),
    });

    if (quick.length > 0) {
      // Follow-up with the reply-button interactive so quick replies are also native.
      messages.push({
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: "Or pick an option:" },
          action: {
            buttons: quick.map((b) => ({
              type: "reply",
              reply: { id: b.id, title: String(b.label).slice(0, 20) },
            })),
          },
        },
      });
    }
    return messages;
  }

  // No URL — quick replies become the primary native buttons.
  if (quick.length > 0) {
    messages.push({
      type: "interactive",
      interactive: surround({
        type: "button",
        body: { text: mainBody.slice(0, 1024) },
        action: {
          buttons: quick.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: String(b.label).slice(0, 20) },
          })),
        },
      }),
    });
    return messages;
  }

  // No buttons of any native kind — plain text with inline phones/codes.
  messages.push({
    type: "text",
    text: { body: mainBody.slice(0, 4096) || "(empty)", preview_url: true },
  });
  return messages;
}

module.exports = router;
