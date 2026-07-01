// Unified Conversations (GHL-style) — merges a contact's Email + WhatsApp
// messages into one thread, grouped by the matching Lead when possible.
const express = require("express");
const Lead = require("./models/Lead");
const EmailMessage = require("./models/EmailMessage");
const WhatsAppMessage = require("./models/WhatsAppMessage");
const WhatsAppConnection = require("./models/WhatsAppConnection");
const { tenantId, leadFilter } = require("./middleware/tenant");

const router = express.Router();

// The WhatsApp number connected to the CURRENT organization. Messages are tagged
// by phoneNumberId, so this is how we keep one workspace's chats out of another.
async function orgWaPhoneNumberId(req) {
  const conn = await WhatsAppConnection.findOne({ organization: tenantId(req) }).select("phoneNumberId");
  return conn?.phoneNumberId || null;
}

// Is the caller a team member restricted to only their assigned leads?
function isRestricted(req) {
  return !!(req.member && req.member.leadAccess === "assigned");
}

// Lead filter that also narrows to the member's assigned leads when restricted.
function convoLeadFilter(req) {
  const f = leadFilter(req);
  if (isRestricted(req)) f.assignedTo = req.member._id;
  return f;
}

const digits = (s) => String(s || "").replace(/\D/g, "");
const preview = (s) =>
  String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);

// GET /api/conversations — list grouped by contact (lead when matched).
router.get("/", async (req, res, next) => {
  try {
    const uid = req.user._id;
    const org = tenantId(req);
    const waPhoneId = await orgWaPhoneNumberId(req);
    const [emailConvos, waConvos, leads] = await Promise.all([
      EmailMessage.aggregate([
        { $match: { user: uid, organization: org } },
        { $sort: { ts: -1 } },
        { $group: {
            _id: "$counterparty",
            last: { $first: "$$ROOT" },
            ts: { $first: "$ts" },
            unread: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "inbound"] }, { $eq: ["$read", false] }] }, 1, 0] } },
        } },
      ]),
      // Only this org's connected WhatsApp number. No number → no WhatsApp chats.
      waPhoneId
        ? WhatsAppMessage.aggregate([
            { $match: { user: uid, phoneNumberId: waPhoneId } },
            { $sort: { ts: -1 } },
            { $group: { _id: "$contactPhone", last: { $first: "$$ROOT" }, ts: { $first: "$ts" } } },
          ])
        : Promise.resolve([]),
      Lead.find(convoLeadFilter(req)).select("name email phone").lean(),
    ]);
    // Restricted members only see conversations tied to a lead assigned to them
    // — never raw/unmatched threads for the whole workspace.
    const restricted = isRestricted(req);

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
      if (!lead && restricted) continue;   // skip unmatched threads for restricted members
      const c = get(lead ? `lead:${lead._id}` : `raw:${e._id}`);
      if (lead) { c.name = lead.name; c.email = lead.email; c.phone = lead.phone; } else c.email = e._id;
      c.unread += e.unread || 0;
      touch(c, e.ts, "email", e.last?.text || e.last?.subject);
    }
    for (const w of waConvos) {
      const lead = byPhone[digits(w._id)];
      if (!lead && restricted) continue;   // skip unmatched threads for restricted members
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
    const org = tenantId(req);
    const id = decodeURIComponent(req.params.id);
    const restricted = isRestricted(req);
    let lead = null, email = "", phone = "";
    if (id.startsWith("lead:")) {
      lead = await Lead.findOne({ ...convoLeadFilter(req), _id: id.slice(5) }).lean();
      // A restricted member asking for a lead that isn't theirs → empty thread.
      if (!lead && restricted) {
        return res.json({ id, contact: { name: "", email: "", phone: "", leadId: null }, messages: [] });
      }
      email = lead?.email || ""; phone = lead?.phone || "";
    } else if (id.startsWith("raw:")) {
      // Restricted members can only open conversations tied to their leads.
      if (restricted) {
        return res.status(403).json({ error: "You can only view conversations for leads assigned to you." });
      }
      const v = id.slice(4);
      if (v.includes("@")) email = v; else phone = v;
    }

    const msgs = [];
    if (email) {
      const em = await EmailMessage.find({ user: uid, organization: org, counterparty: email.toLowerCase() }).sort({ ts: 1 }).lean();
      for (const m of em) msgs.push({ id: String(m._id), channel: "email", direction: m.direction, from: m.fromName || m.fromEmail, subject: m.subject, html: m.html, text: m.text, ts: m.ts });
      await EmailMessage.updateMany({ user: uid, organization: org, counterparty: email.toLowerCase(), direction: "inbound", read: false }, { $set: { read: true } });
    }
    if (phone) {
      const waPhoneId = await orgWaPhoneNumberId(req);
      if (waPhoneId) {
        const wa = await WhatsAppMessage.find({ user: uid, phoneNumberId: waPhoneId, contactPhone: digits(phone) }).sort({ ts: 1 }).lean();
        for (const m of wa) msgs.push({ id: String(m._id), channel: "whatsapp", direction: m.direction, text: m.text, ts: m.ts });
      }
    }
    msgs.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    res.json({ id, contact: { name: lead?.name || "", email, phone, leadId: lead?._id || null }, messages: msgs });
  } catch (err) { next(err); }
});

module.exports = router;
