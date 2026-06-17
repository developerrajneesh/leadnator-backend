// Unified Conversations (GHL-style) — merges a contact's Email + WhatsApp
// messages into one thread, grouped by the matching Lead when possible.
const express = require("express");
const Lead = require("./models/Lead");
const EmailMessage = require("./models/EmailMessage");
const WhatsAppMessage = require("./models/WhatsAppMessage");

const router = express.Router();

const digits = (s) => String(s || "").replace(/\D/g, "");
const preview = (s) =>
  String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);

// GET /api/conversations — list grouped by contact (lead when matched).
router.get("/", async (req, res, next) => {
  try {
    const uid = req.user._id;
    const [emailConvos, waConvos, leads] = await Promise.all([
      EmailMessage.aggregate([
        { $match: { user: uid } },
        { $sort: { ts: -1 } },
        { $group: {
            _id: "$counterparty",
            last: { $first: "$$ROOT" },
            ts: { $first: "$ts" },
            unread: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "inbound"] }, { $eq: ["$read", false] }] }, 1, 0] } },
        } },
      ]),
      WhatsAppMessage.aggregate([
        { $match: { user: uid } },
        { $sort: { ts: -1 } },
        { $group: { _id: "$contactPhone", last: { $first: "$$ROOT" }, ts: { $first: "$ts" } } },
      ]),
      Lead.find({ owner: uid }).select("name email phone").lean(),
    ]);

    const byEmail = {}, byPhone = {};
    for (const l of leads) {
      if (l.email) byEmail[l.email.toLowerCase()] = l;
      if (l.phone) byPhone[digits(l.phone)] = l;
    }

    const map = {};
    const get = (key) => (map[key] || (map[key] = { id: key, name: "", email: "", phone: "", channels: [], ts: null, unread: 0, preview: "", lastChannel: "" }));
    const touch = (c, ts, ch, text) => {
      if (!c.channels.includes(ch)) c.channels.push(ch);
      if (!c.ts || new Date(ts) > new Date(c.ts)) { c.ts = ts; c.preview = preview(text); c.lastChannel = ch; }
    };

    for (const e of emailConvos) {
      const lead = byEmail[String(e._id || "").toLowerCase()];
      const c = get(lead ? `lead:${lead._id}` : `raw:${e._id}`);
      if (lead) { c.name = lead.name; c.email = lead.email; c.phone = lead.phone; } else c.email = e._id;
      c.unread += e.unread || 0;
      touch(c, e.ts, "email", e.last?.text || e.last?.subject);
    }
    for (const w of waConvos) {
      const lead = byPhone[digits(w._id)];
      const c = get(lead ? `lead:${lead._id}` : `raw:${w._id}`);
      if (lead) { c.name = lead.name; c.email = lead.email; c.phone = lead.phone; } else c.phone = w._id;
      touch(c, w.ts, "whatsapp", w.last?.text);
    }

    const conversations = Object.values(map).sort((a, b) => new Date(b.ts) - new Date(a.ts));
    res.json({ conversations });
  } catch (err) { next(err); }
});

// GET /api/conversations/:id — full merged thread (id = "lead:<id>" or "raw:<value>").
router.get("/:id", async (req, res, next) => {
  try {
    const uid = req.user._id;
    const id = decodeURIComponent(req.params.id);
    let lead = null, email = "", phone = "";
    if (id.startsWith("lead:")) {
      lead = await Lead.findOne({ _id: id.slice(5), owner: uid }).lean();
      email = lead?.email || ""; phone = lead?.phone || "";
    } else if (id.startsWith("raw:")) {
      const v = id.slice(4);
      if (v.includes("@")) email = v; else phone = v;
    }

    const msgs = [];
    if (email) {
      const em = await EmailMessage.find({ user: uid, counterparty: email.toLowerCase() }).sort({ ts: 1 }).lean();
      for (const m of em) msgs.push({ id: String(m._id), channel: "email", direction: m.direction, from: m.fromName || m.fromEmail, subject: m.subject, html: m.html, text: m.text, ts: m.ts });
      await EmailMessage.updateMany({ user: uid, counterparty: email.toLowerCase(), direction: "inbound", read: false }, { $set: { read: true } });
    }
    if (phone) {
      const wa = await WhatsAppMessage.find({ user: uid, contactPhone: digits(phone) }).sort({ ts: 1 }).lean();
      for (const m of wa) msgs.push({ id: String(m._id), channel: "whatsapp", direction: m.direction, text: m.text, ts: m.ts });
    }
    msgs.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    res.json({ id, contact: { name: lead?.name || "", email, phone, leadId: lead?._id || null }, messages: msgs });
  } catch (err) { next(err); }
});

module.exports = router;
